import { createHmac } from 'node:crypto';
import { HttpError } from './scheduling.js';

export async function rateLimit(db, req, kind, max, duration) {
  const secret = process.env.APP_SECRET;
  if (!secret && process.env.VERCEL) throw new HttpError(503, 'The server is not configured.');
  // Only Vercel's edge may supply x-real-ip. Ignore forwarding headers locally.
  const ip = process.env.VERCEL ? req.headers['x-real-ip'] : req.socket?.remoteAddress;
  const key = createHmac('sha256', secret || 'local-development-only').update(`${kind}:${ip || 'unknown'}`).digest('hex');
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO rate_limits AS current (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN current.expires_at <= ? THEN 1 ELSE current.count + 1 END,
    expires_at = CASE WHEN current.expires_at <= ? THEN excluded.expires_at ELSE current.expires_at END RETURNING count`).get(key, now + duration, now, now);
  if (row.count > max) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
}
