import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import twilio from 'twilio';
import { testDatabase } from './helpers.js';
import { createBooking } from '../server/scheduling.js';
import { publicData } from '../server/store.js';
import { createNotifications, notificationPhone, twilioSender } from '../server/notifications.js';

const origin = 'https://www.l2cuts.com';
const phone = '+15551234567';
const env = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: '2'.repeat(32), TWILIO_FROM_NUMBER: '+15557654321' };
async function fixture(t) {
  const db = await testDatabase(t);
  const sent = [];
  const validator = twilioSender(env);
  const sender = { configured: () => true, validate: validator.validate, async send(input) { sent.push(input); return { sid: `SM${randomBytes(16).toString('hex')}`, status: 'queued' }; } };
  const notifications = createNotifications(db, { origin, sender });
  await notifications.save({ phone, enabled: true });
  const booking = await createBooking(db, { date: '2026-10-27', time: '09:00', firstName: 'Test', lastName: 'Client', phone: '555-111-2222' }, Date.parse('2026-10-26T12:00:00Z'));
  await db.prepare("UPDATE bookings SET status = 'confirmed', payment_method = 'in_person', payment_status = 'unpaid' WHERE id = ?").run(booking.id);
  const row = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  return { db, notifications, sender, sent, row };
}
function signedCallback(job, status, extra = {}) {
  const url = `${origin}/api/sms/status?attempt=${job.attempt_id}`;
  const params = { AccountSid: env.TWILIO_ACCOUNT_SID, MessageSid: job.provider_sid || `SM${'a'.repeat(32)}`, To: phone, MessageStatus: status, ...extra };
  return [url, params, twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params)];
}

test('notification phone validation requires a country code and provider configuration never exposes secrets', async (t) => {
  assert.equal(notificationPhone('+1 (555) 123-4567'), phone);
  for (const value of ['5551234567', '+0123456789', 'x'.repeat(45), null]) assert.throws(() => notificationPhone(value), { status: 400 });
  const db = await testDatabase(t);
  const notifications = createNotifications(db, { origin, sender: twilioSender({}) });
  await assert.rejects(notifications.save({ phone, enabled: true }), { status: 400 });
  await notifications.save({ phone, enabled: false });
  const data = await notifications.adminData();
  assert.equal(data.providerConfigured, false);
  assert.equal(data.phone, phone);
  assert(!JSON.stringify(await publicData(db)).includes(phone));
});

test('official Twilio SDK gets bounded requests, a sender, and a signed delivery callback', async () => {
  let request;
  const sender = twilioSender(env, (account, token, options) => {
    assert.equal(account, env.TWILIO_ACCOUNT_SID); assert.equal(token, env.TWILIO_AUTH_TOKEN);
    assert.deepEqual(options, { autoRetry: false, timeout: 4000 });
    return { messages: { create: async (input) => { request = input; return { sid: `SM${'a'.repeat(32)}` }; } } };
  });
  assert.equal(sender.configured(), true);
  await sender.send({ phone, body: 'Isolated fixture', statusCallback: `${origin}/api/sms/status?attempt=fixture` });
  assert.equal(request.to, phone); assert.equal(request.from, env.TWILIO_FROM_NUMBER); assert.equal(request.validityPeriod, 900);
  const params = { AccountSid: env.TWILIO_ACCOUNT_SID, To: phone, MessageStatus: 'delivered', NewProviderField: 'included' };
  const signature = twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, request.statusCallback, params);
  assert.equal(sender.validate(signature, request.statusCallback, params), true);
  assert.equal(sender.validate(signature, request.statusCallback, { ...params, To: '+15550000000' }), false);
});

test('repeated booking events and concurrent dispatch send one SMS with appointment details and no private link', async (t) => {
  const { db, notifications, sent, row } = await fixture(t);
  await notifications.enqueue(db, row, 'confirmed'); await notifications.enqueue(db, row, 'confirmed');
  await Promise.all([notifications.flush(), notifications.flush()]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, phone);
  for (const detail of ['Test Client', '555-111-2222', 'Haircut', 'Oct 27, 2026', '9:00 AM EDT', '45 min', '$40.00', 'Due in person', `${origin}/admin`]) assert(sent[0].body.includes(detail), detail);
  assert(!sent[0].body.includes('/booking#')); assert(!sent[0].body.includes(row.token_hash));
  assert.equal((await db.prepare('SELECT state FROM sms_notifications').get()).state, 'accepted');
});

test('notification settings disable delivery and changing the recipient cancels queued texts', async (t) => {
  const { db, notifications, sent, row } = await fixture(t);
  await notifications.enqueue(db, row, 'confirmed');
  await notifications.save({ phone: '+15559998888', enabled: true });
  await notifications.flush(); assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT state FROM sms_notifications').get()).state, 'cancelled');
  await notifications.save({ phone, enabled: false });
  await notifications.enqueue(db, row, 'cancelled');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM sms_notifications').get()).n, 1);
});

test('a cancellation supersedes a confirmation that has not been dispatched yet', async (t) => {
  const { db, notifications, sent, row } = await fixture(t);
  await notifications.enqueue(db, row, 'confirmed');
  await notifications.enqueue(db, row, 'cancelled');
  await notifications.flush(3);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Booking cancelled/);
  assert.equal((await db.prepare("SELECT state FROM sms_notifications WHERE kind = 'confirmed'").get()).state, 'cancelled');
});

test('definite send failures can be retried while ambiguous timeouts are never automatically resent', async (t) => {
  const { db, notifications, sender, row, sent } = await fixture(t);
  await notifications.enqueue(db, row, 'confirmed');
  const normalSend = sender.send;
  sender.send = async () => { const error = new Error('Provider rejected the message'); error.status = 400; error.code = 21211; throw error; };
  await notifications.deliver();
  let job = await db.prepare('SELECT * FROM sms_notifications').get();
  assert.equal(job.state, 'failed'); assert.equal(job.error_code, '21211');
  const oldAttempt = job.attempt_id;
  await notifications.retry(job.id); sender.send = normalSend; await notifications.flush();
  job = await db.prepare('SELECT * FROM sms_notifications').get();
  assert.notEqual(job.attempt_id, oldAttempt); assert.equal(job.attempts, 2); assert.equal(sent.length, 1);
  await notifications.enqueue(db, row, 'cancelled');
  let attempts = 0;
  sender.send = async () => { attempts++; throw new Error('Timed out'); };
  await notifications.deliver(); await notifications.deliver();
  const unknown = await db.prepare("SELECT * FROM sms_notifications WHERE kind = 'cancelled'").get();
  assert.equal(unknown.state, 'unknown'); assert.equal(attempts, 1);
  await assert.rejects(notifications.retry(unknown.id), { status: 400 });
});

test('delivery callbacks use the SDK signature, match the attempt and recipient, and do not regress delivery', async (t) => {
  const { db, notifications, row } = await fixture(t);
  await notifications.enqueue(db, row, 'confirmed'); await notifications.flush();
  const job = await db.prepare('SELECT * FROM sms_notifications').get();
  const [url, params, signature] = signedCallback(job, 'delivered', { RawDlrDoneDate: '2610270900', AdditionalField: 'supported' });
  await assert.rejects(notifications.callback(url, params, 'forged'), { status: 403 });
  assert.equal((await db.prepare('SELECT state FROM sms_notifications').get()).state, 'accepted');
  await notifications.callback(url, params, signature);
  await notifications.callback(...signedCallback(job, 'sent'));
  assert.equal((await db.prepare('SELECT state FROM sms_notifications').get()).state, 'delivered');
});

test('an interrupted send becomes unknown and can be resolved by its signed callback without another send', async (t) => {
  const { db, notifications, row, sent } = await fixture(t);
  await notifications.enqueue(db, row, 'confirmed');
  await db.prepare("UPDATE sms_notifications SET state = 'sending', attempted_at = ?").run(Date.now() - 6 * 60_000);
  await notifications.flush(); assert.equal(sent.length, 0);
  const job = await db.prepare('SELECT * FROM sms_notifications').get(); assert.equal(job.state, 'unknown');
  await notifications.callback(...signedCallback(job, 'delivered'));
  assert.equal((await db.prepare('SELECT state FROM sms_notifications').get()).state, 'delivered');
});

test('a test SMS can verify setup before automatic booking texts are enabled', async (t) => {
  const { db, notifications, sent } = await fixture(t);
  await notifications.save({ phone, enabled: false });
  await notifications.queueTest(); await notifications.flush();
  assert.equal(sent.length, 1); assert(sent[0].body.includes('booking texts are connected'));
  assert.equal((await db.prepare('SELECT enabled FROM barber_notification_settings').get()).enabled, 0);
});
