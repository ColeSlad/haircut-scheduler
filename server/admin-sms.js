import { randomBytes } from 'node:crypto';
import { HttpError, tokenHash } from './scheduling.js';
import { createTwilioVerify, normalizeAdminPhone } from './sms.js';

const lifetime = 10 * 60_000;
const cooldown = 30_000;
const invalidCode = () => new HttpError(401, 'That code is incorrect or expired. Request a new code if needed.');

export function createAdminSms(db, options = {}) {
  const { provider = createTwilioVerify(), now = Date.now } = options;
  const source = options.phones ?? options.phone ?? (process.env.ADMIN_PHONES?.trim() || process.env.ADMIN_PHONE || '');
  let adminPhones = [];
  try {
    const values = Array.isArray(source) ? source : typeof source === 'string' ? source.split(',').filter((value) => value.trim()) : [];
    adminPhones = values.map(normalizeAdminPhone);
    if (adminPhones.length > 2 || new Set(adminPhones).size !== adminPhones.length) adminPhones = [];
  } catch { adminPhones = []; }
  const configured = Boolean(adminPhones.length && provider);
  const identities = new Map(configured ? adminPhones.map((phone) => [phone, tokenHash(`sms:${phone}:${provider.identity}`)]) : []);
  // Preserve the first admin's existing send limits when upgrading the single-number schema.
  if (adminPhones.length) db.prepare("UPDATE admin_code_requests SET phone_key = ? WHERE phone_key = ''").run(tokenHash(`sms-send:${adminPhones[0]}`));
  function requireConfigured() {
    if (!configured) throw new HttpError(503, 'SMS sign-in is not configured yet.');
  }
  return {
    configured, authKeys: [...identities.values()],
    async requestCode(value) {
      requireConfigured();
      const requestedPhone = normalizeAdminPhone(value);
      const token = randomBytes(32).toString('base64url');
      // Unknown numbers receive the same response, but never receive a text or admin access.
      const authKey = identities.get(requestedPhone);
      if (!authKey) return { token, retryAfter: cooldown / 1000 };
      const phoneKey = tokenHash(`sms-send:${requestedPhone}`);
      const time = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM admin_code_requests WHERE requested_at <= ?').run(time - 60 * 60_000);
        const requests = db.prepare('SELECT count(*) AS count, max(requested_at) AS latest FROM admin_code_requests WHERE phone_key = ?').get(phoneKey);
        if (requests.count >= 5 || (requests.latest !== null && time - requests.latest < cooldown)) throw new HttpError(429, 'Please wait before requesting another code.');
        // Reserve the send before awaiting the provider, including requests that time out.
        db.prepare('INSERT INTO admin_code_requests (requested_at, phone_key) VALUES (?, ?)').run(time, phoneKey);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const verificationSid = await provider.send(requestedPhone);
      db.prepare('DELETE FROM admin_challenges WHERE phone = ? OR expires_at <= ?').run(requestedPhone, now());
      db.prepare('INSERT INTO admin_challenges VALUES (?, ?, ?, ?, ?, 0, 0)').run(tokenHash(token), requestedPhone, verificationSid, authKey, now() + lifetime);
      return { token, retryAfter: cooldown / 1000 };
    },
    async verifyCode(value, code, token) {
      requireConfigured();
      const requestedPhone = normalizeAdminPhone(value);
      const authKey = identities.get(requestedPhone);
      if (!authKey || typeof code !== 'string' || !/^\d{4,10}$/.test(code) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidCode();
      const hash = tokenHash(token);
      const challenge = db.prepare('SELECT * FROM admin_challenges WHERE token_hash = ? AND auth_key = ? AND expires_at > ? AND attempts < 5 AND checking = 0').get(hash, authKey, now());
      if (!challenge || challenge.phone !== requestedPhone) throw invalidCode();
      const claimed = db.prepare('UPDATE admin_challenges SET checking = 1, attempts = attempts + 1 WHERE token_hash = ? AND checking = 0').run(hash);
      if (!claimed.changes) throw invalidCode();
      let approved;
      try { approved = await provider.check(challenge.verification_sid, code); }
      catch (error) {
        db.prepare('UPDATE admin_challenges SET checking = 0 WHERE token_hash = ?').run(hash);
        throw error;
      }
      if (!approved) {
        db.prepare('UPDATE admin_challenges SET checking = 0 WHERE token_hash = ?').run(hash);
        throw invalidCode();
      }
      // Consume before issuing a session; parallel checks and replay cannot sign in twice.
      const consumed = db.prepare('DELETE FROM admin_challenges WHERE token_hash = ? AND auth_key = ? AND expires_at > ?').run(hash, authKey, now());
      if (!consumed.changes) throw invalidCode();
      return authKey;
    },
  };
}

export function challengeCookie(token, secure = false) {
  return `admin_challenge=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${token ? lifetime / 1000 : 0}${secure ? '; Secure' : ''}`;
}
