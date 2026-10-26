import twilio from 'twilio';
import { randomUUID } from 'node:crypto';
import { settings } from './store.js';
import { HttpError } from './scheduling.js';
import { callbackUrl } from './urls.js';

export function notificationPhone(value, optional = false) {
  if (typeof value !== 'string' || value.length > 40) throw new HttpError(400, 'Enter a phone number with its country code.');
  const phone = value.trim().replace(/[\s().-]/g, '');
  if (optional && !phone) return '';
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new HttpError(400, 'Enter a phone number with its country code, such as +15551234567.');
  return phone;
}

export function twilioSender(env = process.env, clientFactory = twilio) {
  function configuration() {
    if (!/^AC[a-f\d]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') || !/^[a-f\d]{32}$/i.test(env.TWILIO_AUTH_TOKEN || '')) throw new HttpError(503, 'Text notifications need SMS provider setup.');
    const service = env.TWILIO_MESSAGING_SERVICE_SID;
    if (service && !/^MG[a-f\d]{32}$/i.test(service)) throw new HttpError(503, 'Text notifications need SMS provider setup.');
    if (!service && !/^\+[1-9]\d{6,14}$/.test(env.TWILIO_FROM_NUMBER || '')) throw new HttpError(503, 'Text notifications need an SMS sender.');
    return { account: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, service, from: env.TWILIO_FROM_NUMBER };
  }
  return {
    configured() { try { configuration(); return true; } catch { return false; } },
    async send({ phone, body, statusCallback }) {
      const config = configuration();
      const client = clientFactory(config.account, config.token, { autoRetry: false, timeout: 4000 });
      return client.messages.create({ to: phone, body, statusCallback, validityPeriod: 900, ...(config.service ? { messagingServiceSid: config.service } : { from: config.from }) });
    },
    validate(signature, url, params) {
      const config = configuration();
      return params.AccountSid === config.account && twilio.validateRequest(config.token, signature || '', url, params);
    },
  };
}

const clean = (value) => String(value).replace(/\s+/g, ' ').trim();
const deliveryState = (value) => ({ delivered: 'delivered', failed: 'failed', undelivered: 'failed', canceled: 'failed', accepted: 'accepted', queued: 'accepted', sending: 'accepted', sent: 'accepted' })[value];
const diagnosticCode = value => /^[1-9]\d{0,7}$/.test(String(value)) ? String(value) : null;
function sendFailureCode(error) {
  const code = diagnosticCode(error.code);
  const status = Number(error.status);
  return code || (Number.isInteger(status) && status >= 400 && status < 600 ? `HTTP_${status}` : null);
}
export function notificationBody(booking, config, kind, origin) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(booking.starts_at);
  const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(booking.price / 100);
  const payment = booking.payment_method === 'in_person' ? booking.payment_status === 'paid' ? 'Paid in person' : kind === 'cancelled' ? 'Not paid (in person)' : 'Due in person' : ({ paid: 'Paid online', refunded: 'Refunded', partially_refunded: 'Partially refunded', unpaid: 'Unpaid', legacy_unpaid: 'Payment not recorded' })[booking.payment_status];
  return `${clean(config.name)}: ${kind === 'confirmed' ? 'New booking' : 'Booking cancelled'}\nClient: ${clean(booking.name)}\nPhone: ${clean(booking.phone)}\n${clean(booking.service_name)}: ${when} (${booking.duration} min)\nPrice: ${price} - ${payment}\nAdmin: ${origin}/admin`;
}

export function createNotifications(db, { origin, sender = twilioSender() } = {}) {
  const config = () => db.prepare('SELECT phone, enabled FROM barber_notification_settings WHERE id = 1').get();
  async function enqueue(tx, booking, kind, now = Date.now()) {
    const recipient = await tx.prepare('SELECT phone, enabled FROM barber_notification_settings WHERE id = 1').get();
    if (!recipient.enabled || !recipient.phone) return;
    if (kind === 'cancelled') await tx.prepare("UPDATE sms_notifications SET state = 'cancelled', updated_at = ? WHERE booking_id = ? AND kind = 'confirmed' AND state = 'queued'").run(now, booking.id);
    const id = randomUUID();
    const body = notificationBody(booking, await settings(tx), kind, origin);
    await tx.prepare(`INSERT INTO sms_notifications (id, booking_id, kind, phone, body, attempt_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (booking_id, kind) DO NOTHING`).run(id, booking.id, kind, recipient.phone, body, id, now, now);
  }
  async function adminData() {
    return { ...(await config()), providerConfigured: sender.configured(), recent: await db.prepare(`SELECT id, kind, phone, state, attempts, error_code, created_at, updated_at FROM sms_notifications ORDER BY created_at DESC LIMIT 10`).all() };
  }
  async function save(input) {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'Choose whether to enable booking texts.');
    const phone = notificationPhone(input.phone, !input.enabled);
    if (input.enabled && !sender.configured()) throw new HttpError(400, 'Connect the SMS provider before enabling texts.');
    await db.transaction(async (tx) => {
      const previous = await tx.prepare('SELECT phone FROM barber_notification_settings WHERE id = 1').get();
      if (!input.enabled || previous.phone !== phone) await tx.prepare("UPDATE sms_notifications SET state = 'cancelled', updated_at = ? WHERE state = 'queued'").run(Date.now());
      await tx.prepare('UPDATE barber_notification_settings SET phone = ?, enabled = ? WHERE id = 1').run(phone, input.enabled ? 1 : 0);
    });
  }
  async function queueTest() {
    const recipient = await config();
    notificationPhone(recipient.phone);
    if (!sender.configured()) throw new HttpError(400, 'Connect the SMS provider before sending a test.');
    const id = randomUUID();
    const now = Date.now();
    await db.prepare(`INSERT INTO sms_notifications (id, kind, phone, body, attempt_id, created_at, updated_at) VALUES (?, 'test', ?, ?, ?, ?, ?)`).run(id, recipient.phone, `L2 Cuts: booking texts are connected.\nAdmin: ${origin}/admin`, id, now, now);
    return id;
  }
  async function retry(id) {
    const changed = await db.prepare(`UPDATE sms_notifications SET state = 'queued', attempt_id = ?, provider_sid = NULL, error_code = NULL, updated_at = ?
      WHERE id = ? AND state = 'failed' AND phone = (SELECT phone FROM barber_notification_settings WHERE id = 1)`).run(randomUUID(), Date.now(), id);
    if (!changed.changes) throw new HttpError(400, 'Only a failed text to the current notification number can be retried.');
  }
  async function flush(limit = 1, id) {
    // Never retry an ambiguous provider timeout or a process interruption: the
    // original message might already have been sent. Signed callbacks can resolve it.
    const now = Date.now();
    await db.prepare("UPDATE sms_notifications SET state = 'unknown', updated_at = ? WHERE state = 'sending' AND attempted_at < ?").run(now, now - 5 * 60_000);
    if (!sender.configured()) return;
    const jobs = await db.prepare(`WITH pending AS (
      SELECT n.id FROM sms_notifications n JOIN barber_notification_settings s ON s.id = 1
      WHERE n.state = 'queued' AND n.phone = s.phone AND (s.enabled = 1 OR n.kind = 'test') ${id ? 'AND n.id = ?' : ''}
      ORDER BY n.created_at LIMIT ? FOR UPDATE OF n SKIP LOCKED
    ) UPDATE sms_notifications n SET state = 'sending', attempts = attempts + 1, attempted_at = ?, updated_at = ?
      FROM pending WHERE n.id = pending.id RETURNING n.*`).all(...[...(id ? [id] : []), limit, now, now]);
    for (const job of jobs) {
      try {
        const result = await sender.send({ phone: job.phone, body: job.body, statusCallback: callbackUrl(origin, `/api/sms/status?attempt=${job.attempt_id}`) });
        if (!/^SM[a-f\d]{32}$/i.test(result.sid || '')) throw new Error('Invalid SMS provider response');
        const state = deliveryState(result.status) || 'accepted';
        const code = state === 'failed' ? diagnosticCode(result.errorCode) : null;
        await db.prepare(`UPDATE sms_notifications SET provider_sid = COALESCE(provider_sid, ?), error_code = CASE WHEN state = 'sending' THEN ? ELSE error_code END,
          state = CASE WHEN state = 'sending' THEN ? ELSE state END, updated_at = ? WHERE id = ? AND attempt_id = ?`).run(result.sid, code, state, Date.now(), job.id, job.attempt_id);
      } catch (error) {
        const definiteFailure = Number(error.status) >= 400 && Number(error.status) < 500;
        const code = sendFailureCode(error);
        await db.prepare(`UPDATE sms_notifications SET state = ?, error_code = ?, updated_at = ? WHERE id = ? AND attempt_id = ? AND state = 'sending'`).run(definiteFailure ? 'failed' : 'unknown', code, Date.now(), job.id, job.attempt_id);
        console.error('barber_notification_send_failed', job.id, code || 'unknown');
      }
    }
  }
  async function deliver({ id, limit = 1 } = {}) {
    try { await flush(limit, id); } catch { console.error('barber_notification_dispatch_failed'); }
  }
  async function callback(url, params, signature) {
    if (!sender.validate(signature, url, params)) throw new HttpError(403, 'Invalid SMS callback signature.');
    const attempt = new URL(url).searchParams.get('attempt');
    if (!/^[a-f\d-]{36}$/i.test(attempt || '') || !/^SM[a-f\d]{32}$/i.test(params.MessageSid || '')) throw new HttpError(400, 'Invalid SMS callback.');
    const state = deliveryState(params.MessageStatus);
    if (!state) return;
    const code = diagnosticCode(params.ErrorCode);
    await db.prepare(`UPDATE sms_notifications SET provider_sid = COALESCE(provider_sid, ?), state = ?,
      error_code = CASE WHEN ? = 'failed' THEN COALESCE(?, NULLIF(error_code, '0')) ELSE NULL END, updated_at = ?
      WHERE attempt_id = ? AND phone = ? AND (provider_sid IS NULL OR provider_sid = ?) AND state != 'cancelled'
      AND (state != 'delivered' OR ? = 'delivered') AND (state != 'failed' OR ? IN ('failed', 'delivered'))`).run(params.MessageSid, state, state, code, Date.now(), attempt, params.To, params.MessageSid, state, state);
  }
  return { enqueue, adminData, save, queueTest, retry, flush, deliver, callback };
}
