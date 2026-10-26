import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { fakeProvider } from './fake-stripe.js';
import { createPayments, paymentProvider } from '../server/payments.js';
import { availableSlots } from '../server/scheduling.js';

async function fixture(t) {
  const db = await testDatabase(t);
  const provider = fakeProvider();
  const payments = createPayments(db, { origin: 'https://www.l2cuts.com', provider });
  const now = Date.now();
  const day = new Date(now);
  do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() !== 2);
  const input = { requestId: randomUUID(), date: day.toISOString().slice(0, 10), time: '09:00', firstName: 'Test', lastName: 'Customer', phone: '555-123-4567' };
  return { db, provider, payments, input, now };
}

test('unconfigured or misplaced live payment keys fail closed', () => {
  assert.throws(() => paymentProvider({}), { status: 503 });
  assert.throws(() => paymentProvider({ STRIPE_SECRET_KEY: 'sk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', APP_SECRET: 'x'.repeat(32), VERCEL_ENV: 'preview' }), /only/);
});

test('checkout snapshots the server price, blocks overlaps, and retries idempotently', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const first = await payments.start({ ...input, price: 1 }, now);
  const retry = await payments.start(input, now);
  assert.equal(retry.id, first.id);
  assert.equal(provider.sessions.size, 1);
  const session = [...provider.sessions.values()][0];
  assert.equal(session.amount_total, 4000);
  assert.equal(session.expires_at, Math.floor(now / 1000) + 31 * 60);
  assert(!JSON.stringify(session).includes(first.token));
  assert.equal((await db.prepare('SELECT status FROM bookings').get()).status, 'pending');
  await assert.rejects(payments.start({ ...input, requestId: randomUUID(), time: '09:15' }, now), { status: 409 });
});

test('paid returns and repeated signed webhooks confirm once; forged signatures cannot confirm', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const checkout = await payments.start(input, now);
  const session = provider.payBooking(checkout.id);
  const event = provider.event('checkout.session.completed', { id: session.id });
  await assert.rejects(payments.webhook(event.raw, 'bad-signature'), { status: 400 });
  assert.equal((await db.prepare('SELECT status FROM bookings').get()).status, 'pending');
  const result = await payments.reconcile(checkout.id);
  assert.equal(result.status, 'confirmed');
  await Promise.all([payments.webhook(event.raw, event.signature), payments.webhook(event.raw, event.signature)]);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM stripe_events').get()).n, 1);
  assert.equal((await db.prepare('SELECT payment_status FROM bookings').get()).payment_status, 'paid');
});

test('a success URL or mismatched amount cannot create confirmation', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const checkout = await payments.start(input, now);
  assert.equal((await payments.reconcile(checkout.id)).status, 'pending');
  const session = provider.payBooking(checkout.id);
  session.amount_total = 1;
  await assert.rejects(payments.reconcile(checkout.id), /match/);
  assert.equal((await db.prepare('SELECT status FROM bookings').get()).status, 'pending');
});

test('expired clocks alone never release slots; provider-confirmed expiry and unpaid cancellation do', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const checkout = await payments.start(input, now);
  await payments.sweep(now + 32 * 60_000);
  assert(!(await availableSlots(db, input.date, 'haircut', now)).some((slot) => slot.time === input.time));
  [...provider.sessions.values()][0].status = 'expired';
  await payments.sweep(now + 33 * 60_000);
  assert((await availableSlots(db, input.date, 'haircut', now)).some((slot) => slot.time === input.time));
  const next = await payments.start({ ...input, requestId: randomUUID() }, now);
  assert.equal((await payments.cancel(next.id)).status, 'expired');
  assert.equal((await db.prepare('SELECT status FROM bookings WHERE id = ?').get(checkout.id)).status, 'expired');
});

test('cancellation does not refund and manual refunds synchronize without cancelling the appointment', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const checkout = await payments.start(input, now);
  provider.payBooking(checkout.id);
  await payments.reconcile(checkout.id);
  const charge = { id: 'ch_fixture', payment_intent: `pi_${checkout.id}`, amount: 4000, amount_refunded: 2000, currency: 'usd', livemode: false };
  provider.charges.set(charge.id, charge);
  let event = provider.event('charge.refunded', { id: charge.id });
  await payments.webhook(event.raw, event.signature);
  let row = await db.prepare('SELECT * FROM bookings').get();
  assert.equal(row.status, 'confirmed'); assert.equal(row.payment_status, 'partially_refunded');
  charge.amount_refunded = 4000;
  event = provider.event('charge.refunded', { id: charge.id });
  await payments.webhook(event.raw, event.signature);
  assert.equal((await payments.cancel(checkout.id)).payment_status, 'refunded');
  row = await db.prepare('SELECT * FROM bookings').get();
  assert.equal(row.status, 'cancelled'); assert.equal(row.amount_refunded, 4000);
});

test('a lost Stripe response can be retried without creating a second session', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const original = provider.stripe.checkout.sessions.create;
  let lost = false;
  provider.stripe.checkout.sessions.create = async (...args) => {
    const session = await original(...args);
    if (!lost) { lost = true; throw new Error('Connection interrupted after Stripe accepted the request'); }
    return session;
  };
  await assert.rejects(payments.start(input, now), { status: 503 });
  assert.equal((await db.prepare('SELECT status FROM bookings').get()).status, 'pending');
  await payments.start(input, now);
  assert.equal(provider.sessions.size, 1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').get()).n, 1);
});

test('payment racing an unpaid cancellation is recorded before the slot is released', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const checkout = await payments.start(input, now);
  provider.stripe.checkout.sessions.expire = async () => { provider.payBooking(checkout.id); throw new Error('Already paid'); };
  const cancelled = await payments.cancel(checkout.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.payment_status, 'paid');
  assert((await availableSlots(db, input.date, 'haircut', now)).some((slot) => slot.time === input.time));
});

test('refunds arriving before checkout completion reconcile first, and unrelated Stripe events are ignored', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const checkout = await payments.start(input, now);
  provider.payBooking(checkout.id);
  const charge = { id: 'ch_early', payment_intent: `pi_${checkout.id}`, amount: 4000, amount_refunded: 4000, currency: 'usd', livemode: false };
  provider.charges.set(charge.id, charge);
  const event = provider.event('charge.refunded', { id: charge.id });
  await payments.webhook(event.raw, event.signature);
  const booking = await db.prepare('SELECT * FROM bookings').get();
  assert.equal(booking.status, 'confirmed'); assert.equal(booking.payment_status, 'refunded');
  provider.charges.set('ch_unrelated', { id: 'ch_unrelated', payment_intent: 'pi_unrelated' });
  const unrelated = provider.event('charge.refunded', { id: 'ch_unrelated' });
  await payments.webhook(unrelated.raw, unrelated.signature);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM stripe_events').get()).n, 2);
});

test('availability recovers missed expiry webhooks for the requested date and keeps paid slots reserved', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const expired = await payments.start(input, now);
  const paid = await payments.start({ ...input, requestId: randomUUID(), time: '10:00' }, now);
  [...provider.sessions.values()].find((session) => session.client_reference_id === expired.id).status = 'expired';
  provider.payBooking(paid.id);
  const result = await payments.refreshAvailability(input.date, now + 32 * 60_000);
  assert.deepEqual(result, { checked: 2, failed: 0 });
  const slots = await availableSlots(db, input.date, 'haircut', now);
  assert(slots.some((slot) => slot.time === '09:00'));
  assert(!slots.some((slot) => slot.time === '10:00'));
  assert.equal((await db.prepare('SELECT status FROM bookings WHERE id = ?').get(paid.id)).status, 'confirmed');
});

test('booking a stale displayed slot rechecks overdue holds before creating a new reservation', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  const old = await payments.start(input, now);
  [...provider.sessions.values()][0].status = 'expired';
  const next = await payments.start({ ...input, requestId: randomUUID() }, now + 32 * 60_000);
  assert.notEqual(next.id, old.id);
  assert.equal((await db.prepare('SELECT status FROM bookings WHERE id = ?').get(old.id)).status, 'expired');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM bookings WHERE status = 'pending'").get()).n, 1);
});

test('concurrent availability reads share a short retry lease and provider outages keep holds reserved', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  await payments.start(input, now);
  let calls = 0;
  provider.stripe.checkout.sessions.retrieve = async (id, params, options) => {
    calls++;
    assert.equal(options.timeout, 4000);
    assert.equal(options.maxNetworkRetries, 0);
    throw new Error('Temporary provider outage');
  };
  const reads = await Promise.all(Array.from({ length: 8 }, () => payments.refreshAvailability(input.date, now + 32 * 60_000)));
  assert.equal(calls, 1);
  assert.equal(reads.reduce((sum, result) => sum + result.failed, 0), 1);
  assert(!(await availableSlots(db, input.date, 'haircut', now)).some((slot) => slot.time === input.time));
});

test('daily cleanup processes a bounded batch and leaves remaining reservations for later checks', async (t) => {
  const { db, payments, provider, input, now } = await fixture(t);
  for (let hour = 9; hour < 18; hour++) await payments.start({ ...input, requestId: randomUUID(), time: `${String(hour).padStart(2, '0')}:00` }, now);
  for (const session of provider.sessions.values()) session.status = 'expired';
  assert.equal((await payments.sweep(now + 32 * 60_000)).checked, 8);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM bookings WHERE status = 'pending'").get()).n, 1);
  assert.equal((await payments.sweep(now + 32 * 60_000)).checked, 1);
});
