import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicData, settings } from './store.js';
import { HttpError, availableSlots, createBooking, tokenHash, textField, validDate, validTime, minutes } from './scheduling.js';
import { createSession, requireAdmin, sessionCookie, verifyPassword } from './auth.js';

const categories = ['Short cuts', 'Texture', 'Beards', 'Long cuts'];
export function createApi(db, { origin, secure, dataDir }) {
  const limits = new Map();
  function rateLimit(req, kind, max, duration) {
    const key = `${kind}:${req.socket.remoteAddress}`;
    const now = Date.now();
    if (limits.size > 10000) for (const [entry, value] of limits) if (value.until < now) limits.delete(entry);
    let value = limits.get(key);
    if (!value || value.until < now) { value = { count: 0, until: now + duration }; limits.set(key, value); }
    if (++value.count > max) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
  }
  return async function api(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    const json = (value, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(value));
    };
    if (!['GET', 'HEAD'].includes(method)) {
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'This request must come from this website.');
      if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send a JSON request.');
    }
    if (path === '/api/public' && method === 'GET') return json(publicData(db));
    if (path === '/api/availability' && method === 'GET') {
      const date = url.searchParams.get('date');
      return json({ slots: availableSlots(db, date, url.searchParams.get('service') ?? undefined), timezone: settings(db).timezone });
    }
    if (path === '/api/bookings' && method === 'POST') {
      rateLimit(req, 'booking', 20, 60 * 60_000);
      const input = await readJson(req);
      if (input.website) throw new HttpError(400, 'Unable to book this appointment.');
      return json(createBooking(db, input), 201);
    }
    if (path.startsWith('/api/booking/') && ['GET', 'POST'].includes(method)) {
      rateLimit(req, 'manage', 120, 10 * 60_000);
      const token = path.slice('/api/booking/'.length);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, 'Appointment not found.');
      const booking = db.prepare('SELECT * FROM bookings WHERE token_hash = ?').get(tokenHash(token));
      if (!booking) throw new HttpError(404, 'Appointment not found. This private link may be incomplete.');
      if (method === 'POST') {
        const input = await readJson(req);
        if (input.action !== 'cancel') throw new HttpError(400, 'Choose a valid action.');
        if (booking.starts_at <= Date.now()) throw new HttpError(400, 'This appointment has already started. Please contact the studio.');
        db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
        booking.status = 'cancelled';
      }
      return json({ id: booking.id, serviceName: booking.service_name, price: booking.price, duration: booking.duration, date: booking.date, time: booking.time, startsAt: booking.starts_at, endsAt: booking.ends_at, status: booking.status, name: booking.name, timezone: settings(db).timezone });
    }
    if (path === '/api/admin/session' && method === 'GET') {
      let authenticated = false;
      try { requireAdmin(db, req); authenticated = true; } catch { /* Visitor is signed out. */ }
      return json({ authenticated, configured: Boolean(db.prepare('SELECT id FROM admin').get()) });
    }
    if (path === '/api/admin/login' && method === 'POST') {
      rateLimit(req, 'login', 10, 15 * 60_000);
      const input = await readJson(req);
      const email = textField(input.email, 'email', 254).toLowerCase();
      if (typeof input.password !== 'string' || !input.password || input.password.length > 256) throw new HttpError(400, 'Enter a valid password.');
      const password = input.password;
      const admin = db.prepare('SELECT * FROM admin WHERE id = 1').get();
      if (!admin || !(await verifyPassword(password, admin.password_hash)) || admin.email !== email) throw new HttpError(401, 'Email or password is incorrect.');
      return json({ authenticated: true }, 200, { 'Set-Cookie': sessionCookie(createSession(db), secure) });
    }
    if (path.startsWith('/api/admin/')) {
      const session = requireAdmin(db, req);
      if (path === '/api/admin/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session);
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', secure) });
      }
      if (path === '/api/admin/data' && method === 'GET') {
        return json({ ...publicData(db), services: db.prepare("SELECT * FROM services WHERE id = 'haircut'").all(), bookings: db.prepare('SELECT id, service_id, service_name, duration, price, date, time, starts_at, ends_at, name, email, phone, notes, status, created_at FROM bookings ORDER BY starts_at DESC').all(), daysOff: db.prepare('SELECT * FROM days_off ORDER BY date').all() });
      }
      if (path === '/api/admin/settings' && method === 'PUT') {
        const input = await readJson(req);
        const config = { ...settings(db) };
        for (const [key, max] of Object.entries({ name: 50, tagline: 100, description: 600, location: 150, address: 300, timezone: 80, email: 254, phone: 40, instagram: 200, bookingNotice: 500 })) {
          config[key] = textField(input[key], key, max, ['name', 'tagline', 'description', 'timezone', 'location'].includes(key));
        }
        try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format(); } catch { throw new HttpError(400, 'Enter a valid IANA time zone, such as America/New_York.'); }
        if (config.timezone !== settings(db).timezone && db.prepare("SELECT id FROM bookings WHERE status = 'confirmed' AND starts_at > ? LIMIT 1").get(Date.now())) throw new HttpError(400, 'Cancel upcoming appointments before changing the studio time zone.');
        if (config.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) throw new HttpError(400, 'Enter a valid contact email.');
        if (config.phone && !/^[+\d\s().-]{7,40}$/.test(config.phone)) throw new HttpError(400, 'Enter a valid studio phone number.');
        if (config.instagram && !/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?$/.test(config.instagram)) throw new HttpError(400, 'Use a full Instagram profile URL.');
        for (const [key, min, max] of [['leadMinutes', 0, 10080], ['bookingDays', 1, 180]]) {
          if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new HttpError(400, `Invalid ${key}.`);
          config[key] = input[key];
        }
        db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config));
        return json({ ok: true });
      }
      if (path === '/api/admin/hours' && method === 'PUT') {
        const { hours, daysOff } = await readJson(req);
        if (!Array.isArray(hours) || hours.length !== 7 || new Set(hours.map((day) => day?.day)).size !== 7) throw new HttpError(400, 'Provide all seven days.');
        for (const row of hours) {
          if (!row || typeof row !== 'object') throw new HttpError(400, 'Enter valid weekly hours.');
          if (!Number.isInteger(row.day) || row.day < 0 || row.day > 6 || ![0, 1].includes(row.enabled) || !validTime(row.start) || !validTime(row.end) || (row.enabled && minutes(row.start) >= minutes(row.end))) throw new HttpError(400, 'Each open day needs a closing time after its opening time.');
        }
        if (!Array.isArray(daysOff) || daysOff.length > 365) throw new HttpError(400, 'Too many days off.');
        for (const row of daysOff) { if (!row || !validDate(row.date)) throw new HttpError(400, 'Enter a valid day off.'); textField(row.note || '', 'day off note', 150, false); }
        if (new Set(daysOff.map((day) => day.date)).size !== daysOff.length) throw new HttpError(400, 'A day off was added twice.');
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of hours) db.prepare('UPDATE hours SET enabled = ?, start = ?, end = ? WHERE day = ?').run(row.enabled, row.start, row.end, row.day);
          db.exec('DELETE FROM days_off');
          for (const row of daysOff) db.prepare('INSERT INTO days_off VALUES (?, ?)').run(row.date, row.note || '');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json({ ok: true });
      }
      if (path === '/api/admin/services' && method === 'PUT') {
        const { services } = await readJson(req);
        if (!Array.isArray(services) || services.length !== 1) throw new HttpError(400, 'Keep exactly one haircut service.');
        const service = services[0];
        if (service?.id !== 'haircut' || ![true, 1].includes(service.active)) throw new HttpError(400, 'Keep the haircut service available.');
        if (!Number.isInteger(service.duration) || service.duration < 15 || service.duration > 180 || service.duration % 15) throw new HttpError(400, 'Haircut duration must be 15–180 minutes in 15-minute increments.');
        if (!Number.isInteger(service.price) || service.price < 0 || service.price > 100000) throw new HttpError(400, 'Price must be between $0 and $1,000.');
        db.prepare("UPDATE services SET duration = ?, price = ? WHERE id = 'haircut'").run(service.duration, service.price);
        return json({ ok: true });
      }
      if (/^\/api\/admin\/bookings\/[^/]+$/.test(path) && method === 'PATCH') {
        const { status } = await readJson(req);
        if (!['cancelled', 'completed', 'no-show'].includes(status)) throw new HttpError(400, 'Choose a valid appointment status.');
        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(path.split('/').at(-1));
        if (!booking) throw new HttpError(404, 'Appointment not found.');
        if (booking.status !== 'confirmed') throw new HttpError(400, 'This appointment has already been updated.');
        if (status !== 'cancelled' && booking.ends_at > Date.now()) throw new HttpError(400, 'Complete the appointment after its scheduled end time.');
        db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
        return json({ ok: true });
      }
      if (path === '/api/admin/gallery' && method === 'PUT') {
        const { gallery } = await readJson(req);
        if (!Array.isArray(gallery) || gallery.length > 100) throw new HttpError(400, 'Keep up to 100 gallery photos.');
        const ids = new Set();
        const rows = gallery.map((item, position) => {
          if (!item || typeof item !== 'object') throw new HttpError(400, 'Enter valid photo details.');
          const id = item.id || randomUUID();
          if (typeof id !== 'string' || id.length > 80 || ids.has(id)) throw new HttpError(400, 'Invalid gallery ID.');
          ids.add(id);
          const title = textField(item.title, 'photo title', 100);
          const alt = textField(item.alt, 'image description', 250);
          if (!categories.includes(item.category)) throw new HttpError(400, 'Choose a photo category.');
          const image = textField(item.image, 'image', 500);
          if (!/^\/(assets\/[A-Za-z0-9_.-]+|uploads\/[a-f0-9-]+\.(jpg|png|webp))$/.test(image)) throw new HttpError(400, 'Upload a photo before saving it.');
          return [id, title, item.category, image, alt, item.sample ? 1 : 0, position];
        });
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('DELETE FROM gallery');
          for (const row of rows) db.prepare('INSERT INTO gallery VALUES (?, ?, ?, ?, ?, ?, ?)').run(...row);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json({ ok: true });
      }
      if (path === '/api/admin/upload' && method === 'POST') {
        const { data } = await readJson(req, 8_000_000);
        if (typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, 'Choose a JPEG, PNG, or WebP image.');
        const bytes = Buffer.from(data, 'base64');
        if (!bytes.length || bytes.length > 5_000_000) throw new HttpError(400, 'Images must be under 5 MB.');
        let extension;
        if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) extension = 'jpg';
        else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
        else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') extension = 'webp';
        else throw new HttpError(400, 'Choose a JPEG, PNG, or WebP image.');
        mkdirSync(resolve(dataDir, 'uploads'), { recursive: true });
        const filename = `${randomUUID()}.${extension}`;
        writeFileSync(resolve(dataDir, 'uploads', filename), bytes, { flag: 'wx' });
        return json({ image: `/uploads/${filename}` }, 201);
      }
    }
    throw new HttpError(404, 'This page or action could not be found.');
  };
}

async function readJson(req, max = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'This request is too large.'); chunks.push(chunk); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'The request could not be read. Please try again.'); }
}
