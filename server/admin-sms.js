import { randomBytes } from 'node:crypto';
import { HttpError, tokenHash } from './scheduling.js';
import { createTwilioVerify, normalizeAdminPhone } from './sms.js';

const lifetime = 10 * 60_000;
const cooldown = 30_000;
const invalidCode = () => new HttpError(401, 'That code is incorrect or expired. Request a new code if needed.');

export function createAdminSms(db, { phone = process.env.ADMIN_PHONE || '', provider = createTwilioVerify(), now = Date.now } = {}) {
  let adminPhone = '';
  try { if (phone) adminPhone = normalizeAdminPhone(phone); } catch { /* An invalid private configuration cannot enable SMS login. */ }
  const configured = Boolean(adminPhone && provider);
  const authKey = configured ? tokenHash(`sms:${adminPhone}:${provider.identity}`) : '';
  function requireConfigured() {
    if (!configured) throw new HttpError(503, 'SMS sign-in is not configured yet.');
  }
  return {
    configured, authKey,
    async requestCode(value) {
      requireConfigured();
      const requestedPhone = normalizeAdminPhone(value);
      const token = randomBytes(32).toString('base64url');
      // Unknown numbers receive the same response, but never receive a text or admin access.
      if (requestedPhone !== adminPhone) return { token, retryAfter: cooldown / 1000 };
      const time = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM admin_code_requests WHERE requested_at <= ?').run(time - 60 * 60_000);
        const requests = db.prepare('SELECT count(*) AS count, max(requested_at) AS latest FROM admin_code_requests').get();
        if (requests.count >= 5 || (requests.latest !== null && time - requests.latest < cooldown)) throw new HttpError(429, 'Please wait before requesting another code.');
        // Reserve the send before awaiting the provider, including requests that time out.
        db.prepare('INSERT INTO admin_code_requests (requested_at) VALUES (?)').run(time);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const verificationSid = await provider.send(adminPhone);
      db.prepare('DELETE FROM admin_challenges WHERE phone = ? OR expires_at <= ?').run(adminPhone, now());
      db.prepare('INSERT INTO admin_challenges VALUES (?, ?, ?, ?, ?, 0, 0)').run(tokenHash(token), adminPhone, verificationSid, authKey, now() + lifetime);
      return { token, retryAfter: cooldown / 1000 };
    },
    async verifyCode(value, code, token) {
      requireConfigured();
      const requestedPhone = normalizeAdminPhone(value);
      if (requestedPhone !== adminPhone || typeof code !== 'string' || !/^\d{4,10}$/.test(code) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidCode();
      const hash = tokenHash(token);
      const challenge = db.prepare('SELECT * FROM admin_challenges WHERE token_hash = ? AND auth_key = ? AND expires_at > ? AND attempts < 5 AND checking = 0').get(hash, authKey, now());
      if (!challenge || challenge.phone !== adminPhone) throw invalidCode();
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
