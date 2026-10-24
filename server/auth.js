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
export const passwordAuthKey = (admin) => tokenHash(`password:${admin.email}:${admin.password_hash}`);
export const passwordAuthKeys = (db) => db.prepare('SELECT email, password_hash FROM admin').all().map(passwordAuthKey);

export async function createOrResetAdmin(db, email, password) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new HttpError(400, 'Enter a valid email address.');
  email = email.trim().toLowerCase();
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new HttpError(400, 'Use a password between 12 and 256 characters.');
  const hash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM admin WHERE email = ?').get(email);
    const ids = db.prepare('SELECT id FROM admin').all().map((row) => row.id);
    const id = existing?.id || [1, 2].find((value) => !ids.includes(value));
    if (!id) throw new HttpError(400, 'Both admin accounts are configured. Enter an existing admin email to reset its password.');
    db.prepare('INSERT INTO admin VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash').run(id, email, hash);
    if (existing) db.prepare('DELETE FROM sessions WHERE auth_key = ?').run(passwordAuthKey(existing));
    db.exec('COMMIT');
    return { id, email };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function readCookie(req, name) {
  return (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
export function requireAdmin(db, req, authKeys = '') {
  const token = readCookie(req, 'session');
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now());
  const allowedKeys = Array.isArray(authKeys) ? authKeys : [authKeys];
  if (!session || !allowedKeys.includes(session.auth_key)) throw new HttpError(401, 'Please sign in to continue.');
  return tokenHash(token);
}
export function createSession(db, authKey = '') {
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, expires_at, auth_key) VALUES (?, ?, ?)').run(tokenHash(token), Date.now() + 12 * 60 * 60_000, authKey);
  return token;
}
export function sessionCookie(token, secure = false) {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 43200 : 0}${secure ? '; Secure' : ''}`;
}
