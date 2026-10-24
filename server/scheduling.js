import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { settings } from './store.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export const validTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(+value) && value.toISOString().slice(0, 10) === date;
}
export function localParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
// Resolve studio wall time to UTC; reject nonexistent local times at daylight-saving transitions.
export function toTimestamp(date, time, timezone) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const local = localParts(guess, timezone);
    const delta = wall - Date.parse(`${local.date}T${local.time}:00Z`);
    if (delta === 0) return guess;
    guess += delta;
  }
  return null;
}
export function availableSlots(db, date, serviceId, now = Date.now()) {
  if (!validDate(date)) throw new HttpError(400, 'Choose a valid date.');
  if (typeof serviceId !== 'string' || serviceId.length > 80) throw new HttpError(400, 'Choose an available service.');
  const config = settings(db);
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) throw new HttpError(400, 'Choose an available service.');
  const today = localParts(now, config.timezone).date;
  const last = new Date(`${today}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() + config.bookingDays);
  if (date < today || date > last.toISOString().slice(0, 10)) return [];
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const hours = db.prepare('SELECT * FROM hours WHERE day = ?').get(day);
  if (!hours.enabled || db.prepare('SELECT date FROM days_off WHERE date = ?').get(date)) return [];
  const dateUtc = Date.parse(`${date}T12:00:00Z`);
  const bookings = db.prepare("SELECT starts_at, ends_at FROM bookings WHERE status = 'confirmed' AND ends_at > ? AND starts_at < ?").all(dateUtc - 38 * 60 * 60_000, dateUtc + 38 * 60 * 60_000);
  const result = [];
  for (let start = minutes(hours.start); start + service.duration <= minutes(hours.end); start += 15) {
    const time = clock(start);
    const startsAt = toTimestamp(date, time, config.timezone);
    if (startsAt === null || startsAt < now + config.leadMinutes * 60_000) continue;
    const endsAt = startsAt + service.duration * 60_000;
    if (bookings.some((booking) => startsAt < booking.ends_at && endsAt > booking.starts_at)) continue;
    result.push({ time, startsAt, endsAt });
  }
  return result;
}
export function textField(value, label, max, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new HttpError(400, `Enter a valid ${label}${max ? ` (up to ${max} characters)` : ''}.`);
  return value.trim();
}
export function createBooking(db, input, now = Date.now()) {
  const name = textField(input.name, 'name', 100);
  const email = textField(input.email, 'email address', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const phone = textField(input.phone || '', 'phone number', 40, false);
  if (phone && !/^[+\d\s().-]{7,40}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number.');
  const notes = textField(input.notes || '', 'notes', 1000, false);
  if (!validTime(input.time)) throw new HttpError(400, 'Choose a valid time.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const slot = availableSlots(db, input.date, input.serviceId, now).find((item) => item.time === input.time);
    if (!slot) throw new HttpError(409, 'That time is no longer available. Please choose another time.');
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(input.serviceId);
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO bookings (id, service_id, service_name, duration, price, date, time, starts_at, ends_at, name, email, phone, notes, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, service.id, service.name, service.duration, service.price, input.date, input.time, slot.startsAt, slot.endsAt, name, email, phone, notes, tokenHash(token), now);
    db.exec('COMMIT');
    return { id, token, serviceName: service.name, duration: service.duration, price: service.price, date: input.date, time: input.time, startsAt: slot.startsAt, endsAt: slot.endsAt, name, status: 'confirmed', timezone: settings(db).timezone };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
