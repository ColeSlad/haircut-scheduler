import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { fakeProvider } from './fake-stripe.js';
import { createWebHandler } from '../server/web.js';
import { runtimeConfig } from '../server/config.js';
import { localParts } from '../server/scheduling.js';
import twilio from 'twilio';
import { twilioSender, createNotifications } from '../server/notifications.js';

test('public deployment startup requires core configuration, independently of optional integrations', () => {
  assert.throws(() => runtimeConfig({}), { status: 503 });
  const env = { APP_ORIGIN: 'https://www.l2cuts.com', DATABASE_URL: 'postgres://fixture', BLOB_PUBLIC_ORIGIN: 'https://fixture.public.blob.vercel-storage.com', BLOB_READ_WRITE_TOKEN: 'fixture', CRON_SECRET: 'x'.repeat(32), APP_SECRET: 'y'.repeat(32), STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
  assert.equal(runtimeConfig(env).origin, env.APP_ORIGIN);
  assert.equal(runtimeConfig({ ...env, VERCEL_ENV: 'preview', VERCEL_URL: 'preview.vercel.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'fixture-bypass' }).origin, 'https://preview.vercel.app');
  assert.throws(() => runtimeConfig({ ...env, APP_ORIGIN: 'http://www.l2cuts.com' }), { status: 503 });
  const core = { APP_SECRET: 'y'.repeat(32), DATABASE_URL: 'postgres://fixture', VERCEL_PROJECT_PRODUCTION_URL: 'l2cuts.vercel.app' };
  assert.equal(runtimeConfig(core).origin, 'https://l2cuts.vercel.app');
  assert.equal(runtimeConfig({ ...core, APP_ORIGIN: 'https://www.l2cuts.com' }).origin, 'https://www.l2cuts.com');
  assert.equal(runtimeConfig({ ...core, VERCEL_ENV: 'preview', VERCEL_URL: 'preview.vercel.app' }).origin, 'https://preview.vercel.app');
  assert.throws(() => runtimeConfig({ ...core, DATABASE_URL: '' }), (error) => error.configurationKeys.includes('DATABASE_URL'));
});

test('booking stays available without Stripe, while online payments fail without creating a reservation', async (t) => {
  const db = await testDatabase(t);
  const origin = 'https://l2cuts.vercel.app';
  const handler = createWebHandler(db, { origin, provider: () => { const error = new Error('Payments unavailable'); error.status = 503; throw error; } });
  const response = await handler(new Request(`${origin}/api/public`));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.bookingEnabled, true);
  assert.equal(data.onlinePaymentEnabled, false);
  assert.equal(data.services[0].name, 'Haircut');
  assert.equal((await handler(new Request(`${origin}/api/admin/session`))).status, 200);
  const checkout = await handler(new Request(`${origin}/api/bookings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }));
  assert.equal(checkout.status, 503);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').get()).n, 0);
});

test('an in-person appointment can be privately viewed and cancelled without payment configuration', async (t) => {
  const db = await testDatabase(t);
  const origin = 'https://www.l2cuts.com';
  const handler = createWebHandler(db, { origin, secret: 'isolated-web-booking-secret-at-least-32-characters', provider: () => { throw new Error('Stripe must not be called'); } });
  const day = new Date();
  do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() !== 2);
  const input = { paymentMethod: 'in_person', requestId: randomUUID(), date: day.toISOString().slice(0, 10), time: '09:00', firstName: 'Test', lastName: 'Customer', phone: '555-123-4567' };
  const response = await handler(new Request(`${origin}/api/bookings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.bookingUrl, /^\/booking#[A-Za-z0-9_-]{43}$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  const headers = { Authorization: `Bearer ${result.bookingUrl.split('#')[1]}` };
  const view = await handler(new Request(`${origin}/api/booking`, { headers }));
  const booking = await view.json();
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.paymentMethod, 'in_person');
  assert.equal(booking.paymentStatus, 'unpaid');
  assert.equal(booking.checkoutUrl, null);
  assert.equal((await handler(new Request(`${origin}/api/booking`))).status, 404);
  const cancelled = await handler(new Request(`${origin}/api/booking`, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }) }));
  assert.equal((await cancelled.json()).status, 'cancelled');
});

test('Vercel web adapter preserves signed raw bodies and keeps private tokens out of request URLs', async (t) => {
  const db = await testDatabase(t);
  const provider = fakeProvider();
  const origin = 'https://www.l2cuts.com';
  const handler = createWebHandler(db, { origin, provider });
  const today = localParts(Date.now(), 'America/New_York').date;
  const day = new Date(`${today}T12:00:00Z`);
  do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() !== 2);
  const input = { requestId: randomUUID(), date: day.toISOString().slice(0, 10), time: '09:00', firstName: 'Test', lastName: 'Customer', phone: '555-123-4567' };
  const response = await handler(new Request(`${origin}/api/bookings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.token, undefined);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  const token = cookie.split('=')[1];
  const session = provider.payBooking(body.id);
  const event = provider.event('checkout.session.completed', { id: session.id });
  const webhook = await handler(new Request(`${origin}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': event.signature }, body: event.raw }));
  assert.equal(webhook.status, 200);
  const returned = await handler(new Request(`${origin}/api/checkout/return/${body.id}`, { headers: { Cookie: cookie } }));
  assert.equal(returned.status, 303);
  assert.equal(returned.headers.get('location'), `/booking#${token}`);
  const missingCookie = await handler(new Request(`${origin}/api/checkout/return/${body.id}`));
  assert.equal(missingCookie.headers.get('location'), '/booking');
  const privateView = await handler(new Request(`${origin}/api/booking`, { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal((await privateView.json()).status, 'confirmed');
  assert.equal(privateView.headers.get('cache-control'), 'no-store');
  assert.equal((await handler(new Request(`${origin}/api/booking/${token}`))).status, 404);
});

test('daily payment cleanup requires the cron secret', async (t) => {
  const db = await testDatabase(t);
  const origin = 'https://www.l2cuts.com';
  const handler = createWebHandler(db, { origin, provider: fakeProvider() });
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'isolated-cron-fixture-secret-at-least-32-characters';
  try {
    assert.equal((await handler(new Request(`${origin}/api/cron/payments`))).status, 401);
    const response = await handler(new Request(`${origin}/api/cron/payments`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checked: 0, failed: 0 });
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('SMS delivery callbacks accept provider form data only with a valid SDK signature', async (t) => {
  const db = await testDatabase(t);
  const origin = 'https://www.l2cuts.com';
  const phone = '+15559990000';
  const env = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: '2'.repeat(32), TWILIO_FROM_NUMBER: '+15558880000' };
  const notificationSender = twilioSender(env, () => ({ messages: { create: async () => ({ sid: `SM${'a'.repeat(32)}`, status: 'queued' }) } }));
  await db.prepare('UPDATE barber_notification_settings SET phone = ?, enabled = 1').run(phone);
  const handler = createWebHandler(db, { origin, notificationSender, secret: 'isolated-sms-callback-secret-at-least-32' });
  const day = new Date(); do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() !== 2);
  const input = { requestId: randomUUID(), paymentMethod: 'in_person', firstName: 'Test', lastName: 'Client', phone: '555-123-4567', date: day.toISOString().slice(0, 10), time: '09:00' };
  const booked = await handler(new Request(`${origin}/api/bookings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal(booked.status, 201);
  const job = await db.prepare('SELECT * FROM sms_notifications').get();
  const url = `${origin}/api/sms/status?attempt=${job.attempt_id}`;
  const params = { AccountSid: env.TWILIO_ACCOUNT_SID, To: phone, MessageSid: job.provider_sid, MessageStatus: 'delivered', AdditionalField: 'preserved' };
  const signature = twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params);
  const send = (signature) => handler(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: new URLSearchParams(params).toString() }));
  assert.equal((await send('forged')).status, 403);
  assert.equal((await send(signature)).status, 200);
  assert.equal((await db.prepare('SELECT state FROM sms_notifications').get()).state, 'delivered');
});

test('daily SMS recovery still runs when the payment provider is unavailable', async (t) => {
  const db = await testDatabase(t);
  const origin = 'https://www.l2cuts.com';
  const provider = fakeProvider();
  let sent = 0;
  const notificationSender = { configured: () => true, validate: () => false, async send() { sent++; return { sid: `SM${'b'.repeat(32)}`, status: 'queued' }; } };
  const handler = createWebHandler(db, { origin, provider, notificationSender });
  const day = new Date(); do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() !== 2);
  const input = { requestId: randomUUID(), firstName: 'Test', lastName: 'Client', phone: '555-123-4567', date: day.toISOString().slice(0, 10), time: '09:00' };
  assert.equal((await handler(new Request(`${origin}/api/bookings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }))).status, 201);
  await db.prepare('UPDATE bookings SET hold_expires_at = ?').run(Date.now() - 1000);
  provider.stripe.checkout.sessions.retrieve = async () => { throw new Error('Isolated provider outage'); };
  const notifications = createNotifications(db, { origin, sender: notificationSender });
  await notifications.save({ phone: '+15559990000', enabled: false });
  await notifications.queueTest();
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'isolated-sms-recovery-secret';
  try {
    const response = await handler(new Request(`${origin}/api/cron/payments`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    assert.equal(response.status, 503);
    assert.equal(sent, 1);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
