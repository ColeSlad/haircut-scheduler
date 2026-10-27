import { randomUUID } from 'node:crypto';
import { publicData, settings, servicePriceMax } from './store.js';
import { HttpError, availableSlots, tokenHash, textField, validDate, validTime, minutes } from './scheduling.js';
import { createSession, requireAdmin, sessionCookie, verifyPassword, passwordAuthKey, passwordAuthKeys, readCookie } from './auth.js';
import { tiktokVideoUrl } from './videos.js';
import { rateLimit } from './limits.js';
import { createPayments } from './payments.js';
import { createStorage } from './storage.js';
import { createNotifications } from './notifications.js';
import { listReviews, saveReviews, submitReview } from './reviews.js';

const categories = ['Short cuts', 'Texture', 'Beards', 'Long cuts'];
export function createApi(db, { origin, secure, provider, secret, notificationSender, storage = createStorage(db, { callbackOrigin: origin }) }) {
  const notifications = createNotifications(db, { origin, sender: notificationSender });
  const payments = createPayments(db, { origin, provider, secret, notifications });
  const authKeys = async () => (await passwordAuthKeys(db));
  return async function api(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    const json = (value, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(value));
    };
    if (path === '/api/stripe/webhook' && method === 'POST') {
      await payments.webhook(await readRaw(req), req.headers['stripe-signature']);
      await notifications.deliver();
      return json({ received: true });
    }
    if (path === '/api/sms/status' && method === 'POST') {
      if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Send a form callback.');
      const values = new URLSearchParams((await readRaw(req)).toString());
      const params = Object.create(null);
      for (const [key, value] of values) {
        if (Object.hasOwn(params, key)) throw new HttpError(400, 'Duplicate callback parameter.');
        params[key] = value;
      }
      await notifications.callback(new URL(req.url, origin).href, params, req.headers['x-twilio-signature']);
      return json({ received: true });
    }
    if (path === '/api/admin/upload' && method === 'POST' && req.headers['x-vercel-signature']) {
      const body = await readJson(req);
      if (body.type !== 'blob.upload-completed') throw new HttpError(400, 'Invalid storage callback.');
      return json(await storage.handle(req, body, async () => requireAdmin(db, req, await authKeys())));
    }
    if (path === '/api/cron/payments' && method === 'GET') {
      if (!process.env.CRON_SECRET || tokenHash(req.headers.authorization || '') !== tokenHash(`Bearer ${process.env.CRON_SECRET}`)) throw new HttpError(401, 'Unauthorized.');
      let result;
      try { result = await payments.sweep(); }
      finally { await notifications.deliver({ limit: 3 }); }
      return json(result);
    }
    if (/^\/api\/checkout\/return\/[a-f0-9-]{36}$/.test(path) && method === 'GET') {
      const id = path.split('/').at(-1);
      const token = readCookie(req, `checkout_${id}`);
      const booking = await db.prepare('SELECT * FROM bookings WHERE id = ? AND token_hash = ?').get(id, tokenHash(token));
      if (!booking) { res.writeHead(303, { Location: '/booking', 'Cache-Control': 'no-store' }); return res.end(); }
      try { await payments.reconcile(id); } catch { /* Private page will show a pending state and retry verification. */ }
      await notifications.deliver();
      res.writeHead(303, { Location: `/booking#${token}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (!['GET', 'HEAD'].includes(method)) {
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'This request must come from this website.');
      if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Send a JSON request.');
    }
    if (path === '/api/health' && method === 'GET') {
      await db.prepare('SELECT id FROM settings WHERE id = 1').get().then((row) => { if (!row) throw new HttpError(503, 'Setup incomplete.'); });
      return json({ ok: true });
    }
    if (path === '/api/public' && method === 'GET') return json({ ...(await publicData(db)), bookingEnabled: true, onlinePaymentEnabled: payments.configured() });
    if (path === '/api/reviews' && method === 'GET') return json(await listReviews(db, { before: url.searchParams.get('before') }));
    if (path === '/api/reviews' && method === 'POST') {
      await rateLimit(db, req, 'review', 5, 60 * 60_000);
      return json(await submitReview(db, await readJson(req)), 201);
    }
    if (path === '/api/availability' && method === 'GET') {
      const date = url.searchParams.get('date');
      await payments.refreshAvailability(date);
      return json({ slots: (await availableSlots(db, date, url.searchParams.get('service') ?? undefined)), timezone: (await settings(db)).timezone });
    }
    if (path === '/api/bookings' && method === 'POST') {
      await rateLimit(db, req, 'booking', 20, 60 * 60_000);
      const input = await readJson(req);
      if (input.website) throw new HttpError(400, 'Unable to book this appointment.');
      const checkout = await payments.start(input);
      await notifications.deliver();
      if (checkout.bookingUrl) return json({ id: checkout.id, bookingUrl: checkout.bookingUrl }, 201);
      return json({ id: checkout.id, checkoutUrl: checkout.checkoutUrl }, 201, {
        'Set-Cookie': `checkout_${checkout.id}=${checkout.token}; HttpOnly; SameSite=Lax; Path=/api/checkout/return/${checkout.id}; Max-Age=86400${secure ? '; Secure' : ''}`,
      });
    }
    if (path === '/api/booking' && ['GET', 'POST'].includes(method)) {
      await rateLimit(db, req, 'manage', 120, 10 * 60_000);
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, 'Appointment not found.');
      let booking = (await db.prepare('SELECT * FROM bookings WHERE token_hash = ?').get(tokenHash(token)));
      if (!booking) throw new HttpError(404, 'Appointment not found. This private link may be incomplete.');
      if (method === 'POST') {
        const input = await readJson(req);
        if (input.action !== 'cancel') throw new HttpError(400, 'Choose a valid action.');
        booking = await payments.cancel(booking.id);
      } else if (booking.status === 'pending') {
        try { booking = await payments.reconcile(booking.id); } catch { /* Never report confirmation without provider verification. */ }
      }
      await notifications.deliver();
      return json({ id: booking.id, serviceName: booking.service_name, price: booking.price, duration: booking.duration, date: booking.date, time: booking.time, startsAt: booking.starts_at, endsAt: booking.ends_at, status: booking.status, paymentStatus: booking.payment_status, paymentMethod: booking.payment_method, amountRefunded: booking.amount_refunded, checkoutUrl: booking.status === 'pending' ? booking.checkout_url : null, name: booking.name, timezone: (await settings(db)).timezone });
    }
    if (path === '/api/admin/session' && method === 'GET') {
      let authenticated = false;
      try { (await requireAdmin(db, req, await authKeys())); authenticated = true; } catch { /* Visitor is signed out. */ }
      return json({ authenticated, configured: Boolean((await db.prepare('SELECT id FROM admin LIMIT 1').get())) });
    }
    if (['/api/admin/request-code', '/api/admin/verify-code'].includes(path)) throw new HttpError(404, 'This sign-in method is no longer available.');
    if (path === '/api/admin/login' && method === 'POST') {
      await rateLimit(db, req, 'login', 10, 15 * 60_000);
      const input = await readJson(req);
      const email = textField(input.email, 'email', 254).toLowerCase();
      if (typeof input.password !== 'string' || !input.password || input.password.length > 256) throw new HttpError(400, 'Enter a valid password.');
      const password = input.password;
      const admin = (await db.prepare('SELECT * FROM admin WHERE email = ?').get(email));
      const credential = admin || (await db.prepare('SELECT * FROM admin ORDER BY id LIMIT 1').get());
      const valid = credential ? await verifyPassword(password, credential.password_hash) : false;
      if (!admin || !valid) throw new HttpError(401, 'Email or password is incorrect.');
      return json({ authenticated: true }, 200, { 'Set-Cookie': sessionCookie((await createSession(db, passwordAuthKey(admin))), secure) });
    }
    if (path.startsWith('/api/admin/')) {
      const session = (await requireAdmin(db, req, await authKeys()));
      if (path === '/api/admin/logout' && method === 'POST') {
        (await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session));
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', secure) });
      }
      if (path === '/api/admin/notifications' && method === 'GET') return json(await notifications.adminData());
      if (path === '/api/admin/notifications' && method === 'PUT') {
        await notifications.save(await readJson(req));
        return json({ ok: true });
      }
      if (path === '/api/admin/notifications/test' && method === 'POST') {
        await rateLimit(db, req, 'notification-test', 5, 60 * 60_000);
        const id = await notifications.queueTest();
        await notifications.deliver({ id });
        return json({ ok: true });
      }
      if (path === '/api/admin/notifications/refresh' && method === 'POST') {
        await rateLimit(db, req, 'notification-refresh', 10, 60_000);
        return json(await notifications.refresh());
      }
      if (/^\/api\/admin\/notifications\/[a-f\d-]{36}\/retry$/.test(path) && method === 'POST') {
        await rateLimit(db, req, 'notification-retry', 10, 60 * 60_000);
        const id = path.split('/').at(-2);
        await notifications.retry(id);
        await notifications.deliver({ id });
        return json({ ok: true });
      }
      if (path === '/api/admin/data' && method === 'GET') {
        const data = await publicData(db);
        return json({ ...data, services: (await db.prepare("SELECT * FROM services WHERE id = 'haircut'").all()).map(service => ({ ...service, priceMax: servicePriceMax(service, data.settings) })), bookings: (await db.prepare(`SELECT id, service_id, service_name, duration, price, date, time, starts_at, ends_at, name, email, phone, notes, status, created_at, payment_status, payment_method, payment_intent_id, amount_refunded, CASE WHEN checkout_session_id LIKE 'cs_test_%' THEN 'test' ELSE 'live' END AS payment_mode FROM bookings ORDER BY starts_at DESC`).all()), daysOff: (await db.prepare('SELECT * FROM days_off ORDER BY date').all()), notifications: await notifications.adminData(), reviews: await listReviews(db, { admin: true }) });
      }
      if (path === '/api/admin/settings' && method === 'PUT') {
        const input = await readJson(req);
        await db.transaction(async (db) => {
        const config = { ...(await settings(db)) };
        for (const [key, max] of Object.entries({ name: 50, tagline: 100, description: 600, location: 150, address: 300, timezone: 80, email: 254, phone: 40, instagram: 200, bookingNotice: 500 })) {
          config[key] = textField(input[key], key, max, ['name', 'tagline', 'description', 'timezone', 'location'].includes(key));
        }
        try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format(); } catch { throw new HttpError(400, 'Enter a valid IANA time zone, such as America/New_York.'); }
        if (config.timezone !== (await settings(db)).timezone && (await db.prepare("SELECT id FROM bookings WHERE status IN ('pending', 'confirmed') AND starts_at > ? LIMIT 1").get(Date.now()))) throw new HttpError(400, 'Cancel upcoming appointments before changing the studio time zone.');
        if (config.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) throw new HttpError(400, 'Enter a valid contact email.');
        if (config.phone && !/^[+\d\s().-]{7,40}$/.test(config.phone)) throw new HttpError(400, 'Enter a valid studio phone number.');
        if (config.instagram && !/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?$/.test(config.instagram)) throw new HttpError(400, 'Use a full Instagram profile URL.');
        for (const [key, min, max] of [['leadMinutes', 32, 10080], ['bookingDays', 1, 180]]) {
          if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new HttpError(400, `Invalid ${key}.`);
          config[key] = input[key];
        }
        (await db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config)));
        });
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
        await db.transaction(async (db) => {
          for (const row of hours) (await db.prepare('UPDATE hours SET enabled = ?, start = ?, "end" = ? WHERE day = ?').run(row.enabled, row.start, row.end, row.day));
          await db.exec('DELETE FROM days_off');
          for (const row of daysOff) (await db.prepare('INSERT INTO days_off VALUES (?, ?)').run(row.date, row.note || ''));
        });
        return json({ ok: true });
      }
      if (path === '/api/admin/videos' && method === 'PUT') {
        const { videos } = await readJson(req);
        if (!Array.isArray(videos) || videos.length > 30) throw new HttpError(400, 'Keep up to 30 TikTok videos.');
        const ids = new Set();
        const urls = new Set();
        const rows = videos.map((video, position) => {
          if (!video || typeof video !== 'object') throw new HttpError(400, 'Enter valid TikTok video details.');
          const id = video.id || randomUUID();
          if (typeof id !== 'string' || id.length > 80 || ids.has(id)) throw new HttpError(400, 'Invalid video ID.');
          ids.add(id);
          const title = textField(video.title, 'video title', 100);
          const url = tiktokVideoUrl(video.url);
          if (urls.has(url)) throw new HttpError(400, 'This TikTok video was added twice.');
          urls.add(url);
          return [id, title, url, position];
        });
        await db.transaction(async (db) => {
          await db.exec('DELETE FROM videos');
          for (const row of rows) (await db.prepare('INSERT INTO videos VALUES (?, ?, ?, ?)').run(...row));
        });
        return json({ ok: true });
      }
      if (path === '/api/admin/services' && method === 'PUT') {
        const { services } = await readJson(req);
        if (!Array.isArray(services) || services.length !== 1) throw new HttpError(400, 'Keep exactly one haircut service.');
        const service = services[0];
        if (service?.id !== 'haircut' || ![true, 1].includes(service.active)) throw new HttpError(400, 'Keep the haircut service available.');
        if (!Number.isInteger(service.duration) || service.duration < 15 || service.duration > 180 || service.duration % 15) throw new HttpError(400, 'Haircut duration must be 15–180 minutes in 15-minute increments.');
        if (!Number.isInteger(service.price) || service.price < 50 || service.price > 100000) throw new HttpError(400, 'Price must be between $0.50 and $1,000.');
        const maximum = service.priceMax === undefined ? service.price : service.priceMax;
        if (!Number.isInteger(maximum) || maximum < service.price || maximum > 100000) throw new HttpError(400, 'Maximum price must be at least the minimum price and no more than $1,000.');
        await db.transaction(async (tx) => {
          await tx.prepare("UPDATE services SET duration = ?, price = ? WHERE id = 'haircut'").run(service.duration, service.price);
          const config = { ...await settings(tx), haircutMaxPrice: maximum };
          await tx.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config));
        });
        return json({ ok: true });
      }
      if (path === '/api/admin/reviews' && method === 'GET') return json(await listReviews(db, { admin: true, before: url.searchParams.get('before') }));
      if (path === '/api/admin/reviews' && method === 'PUT') throw new HttpError(409, 'Refresh the page to use the updated review editor.');
      if (path === '/api/admin/reviews' && method === 'PATCH') {
        await saveReviews(db, (await readJson(req)).items);
        return json({ ok: true });
      }
      if (/^\/api\/admin\/bookings\/[^/]+$/.test(path) && method === 'PATCH') {
        const { status, paymentStatus } = await readJson(req);
        if (paymentStatus !== undefined) {
          if (paymentStatus !== 'paid' || status !== undefined) throw new HttpError(400, 'Choose a valid payment update.');
          const updated = await db.prepare(`UPDATE bookings SET payment_status = 'paid'
            WHERE id = ? AND payment_method = 'in_person' AND payment_status IN ('unpaid', 'paid') AND status IN ('confirmed', 'completed')`).run(path.split('/').at(-1));
          if (!updated.changes) throw new HttpError(400, 'Only a confirmed or completed in-person appointment can be marked paid.');
          return json({ ok: true });
        }
        if (!['cancelled', 'completed', 'no-show'].includes(status)) throw new HttpError(400, 'Choose a valid appointment status.');
        const booking = (await db.prepare('SELECT * FROM bookings WHERE id = ?').get(path.split('/').at(-1)));
        if (!booking) throw new HttpError(404, 'Appointment not found.');
        if (!['confirmed', 'pending'].includes(booking.status)) throw new HttpError(400, 'This appointment has already been updated.');
        if (booking.status === 'pending' && status !== 'cancelled') throw new HttpError(400, 'Payment has not been confirmed.');
        if (status !== 'cancelled' && booking.ends_at > Date.now()) throw new HttpError(400, 'Complete the appointment after its scheduled end time.');
        if (status === 'cancelled') { await payments.cancel(booking.id); await notifications.deliver(); }
        else await db.prepare("UPDATE bookings SET status = ? WHERE id = ? AND status = 'confirmed'").run(status, booking.id);
        return json({ ok: true });
      }
      if (path === '/api/admin/gallery' && method === 'PUT') {
        const { gallery } = await readJson(req);
        if (!Array.isArray(gallery) || gallery.length > 100) throw new HttpError(400, 'Keep up to 100 gallery photos.');
        const ids = new Set();
        const rows = await Promise.all(gallery.map(async (item, position) => {
          if (!item || typeof item !== 'object') throw new HttpError(400, 'Enter valid photo details.');
          const id = item.id || randomUUID();
          if (typeof id !== 'string' || id.length > 80 || ids.has(id)) throw new HttpError(400, 'Invalid gallery ID.');
          ids.add(id);
          const title = textField(item.title, 'photo title', 100);
          const alt = textField(item.alt, 'image description', 250);
          if (!categories.includes(item.category)) throw new HttpError(400, 'Choose a photo category.');
          const image = textField(item.image, 'image', 500);
          if (!await storage.allowedPhoto(image)) throw new HttpError(400, 'Upload a photo before saving it.');
          return [id, title, item.category, image, alt, item.sample ? 1 : 0, position];
        }));
        await db.transaction(async (db) => {
          await db.exec('DELETE FROM gallery');
          for (const row of rows) (await db.prepare('INSERT INTO gallery VALUES (?, ?, ?, ?, ?, ?, ?)').run(...row));
        });
        return json({ ok: true });
      }
      if (path === '/api/admin/upload' && method === 'POST') {
        await rateLimit(db, req, 'upload', 30, 60 * 60_000);
        return json(await storage.handle(req, await readJson(req), async () => requireAdmin(db, req, await authKeys())));
      }
      if (path === '/api/admin/upload/complete' && method === 'POST') {
        const input = await readJson(req);
        return json(await storage.validatePhoto(textField(input.image, 'image', 500)), 201);
      }
    }
    throw new HttpError(404, 'This page or action could not be found.');
  };
}

export async function readRaw(req, max = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'This request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req, max = 100_000) {
  const raw = await readRaw(req, max);
  try {
    const value = JSON.parse(raw.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'The request could not be read. Please try again.'); }
}
