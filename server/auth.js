import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { tokenHash, HttpError } from './scheduling.js';
const derive = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const key = await derive(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function requireAdmin(db, req) {
  const cookie = (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('session='));
  const token = cookie?.slice(8) || '';
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now());
  if (!session) throw new HttpError(401, 'Please sign in to continue.');
  return tokenHash(token);
}
export function createSession(db) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(tokenHash(token), Date.now() + 12 * 60 * 60_000);
  return token;
}
export function sessionCookie(token, secure = false) {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 43200 : 0}${secure ? '; Secure' : ''}`;
}
