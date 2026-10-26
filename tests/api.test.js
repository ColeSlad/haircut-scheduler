import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fakeProvider } from './fake-stripe.js';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStore, publicData, settings } from '../server/store.js';
import { testDatabase } from './helpers.js';
import { appServer } from '../server/index.js';
import { hashPassword, verifyPassword, createOrResetAdmin, createSession } from '../server/auth.js';
import { availableSlots, createBooking, localParts } from '../server/scheduling.js';
const origin = 'http://localhost:3000';

async function fixture(t) {
  const db = await testDatabase(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'haircut-test-'));
  const provider = fakeProvider();
  const server = appServer({ db, origin, dataDir, provider });
  const password = ' secure-test-password ';
  (await db.prepare('INSERT INTO admin VALUES (1, ?, ?)').run('admin@example.com', await hashPassword(password)));
  t.after(() => { rmSync(dataDir, { recursive: true, force: true }); });
  function request(path, { method = 'GET', body, headers = {} } = {}) {
    if (path === '/api/bookings' && body && typeof body === 'object') body = { requestId: randomUUID(), ...body };
    return new Promise((resolve, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
      Object.assign(req, { method, url: path, headers: { origin, 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
      const responseHeaders = {};
      const res = {
        statusCode: 200, headersSent: false,
        setHeader(key, value) { responseHeaders[key.toLowerCase()] = value; },
        writeHead(status, values) { this.statusCode = status; for (const [key, value] of Object.entries(values || {})) this.setHeader(key, value); this.headersSent = true; },
        end(value) { const text = value?.toString() || ''; let result; try { result = JSON.parse(text); } catch { result = text; } resolve({ status: this.statusCode, headers: responseHeaders, body: result }); },
      };
      try { server.emit('request', req, res); } catch (error) { reject(error); }
    });
  }
  async function login(email = 'admin@example.com', userPassword = password) {
    const result = await request('/api/admin/login', { method: 'POST', body: { email, password: userPassword } });
    assert.equal(result.status, 200);
    return result.headers['set-cookie'].split(';')[0];
  }
  return { db, request, login, dataDir, provider };
}
async function futureSlot(db) {
  const now = Date.now();
  const today = localParts(now, (await settings(db)).timezone).date;
  for (let i = 1; i < 15; i++) {
    const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + i);
    const day = date.toISOString().slice(0, 10);
    const slots = (await availableSlots(db, day, 'haircut', now));
    if (slots.length) return { date: day, time: slots[0].time, firstName: 'Sam', lastName: 'Example', phone: '555-123-4567' };
  }
  throw new Error('No future test slot');
}

test('password hashing is salted and preserves meaningful whitespace', async () => {
  const password = ' leading and trailing ';
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.notEqual(await hashPassword(password), hash);
});
test('public data excludes appointments, login credentials, and tokens', async (t) => {
  const { request } = await fixture(t);
  const result = await request('/api/public');
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['bookingEnabled', 'gallery', 'homeVideos', 'hours', 'onlinePaymentEnabled', 'reviews', 'services', 'settings', 'videos']);
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('private admin endpoints and mutations require authentication', async (t) => {
  const { request } = await fixture(t);
  for (const path of ['/api/admin/data', '/api/admin/settings', '/api/admin/gallery', '/api/admin/videos', '/api/admin/reviews']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: {} })).status, 401);
  assert.equal((await request('/api/admin/videos', { method: 'PUT', body: { videos: [] } })).status, 401);
  assert.equal((await request('/api/admin/reviews', { method: 'PUT', body: { rating: 5, items: [] } })).status, 401);
});
test('login creates an HttpOnly session and logout revokes it', async (t) => {
  const { request } = await fixture(t);
  const login = await request('/api/admin/login', { method: 'POST', body: { email: 'admin@example.com', password: ' secure-test-password ' } });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await request('/api/admin/data', { headers: { cookie } })).status, 200);
  assert.equal((await request('/api/admin/logout', { method: 'POST', body: {}, headers: { cookie } })).status, 200);
  assert.equal((await request('/api/admin/data', { headers: { cookie } })).status, 401);
});
test('two email admins can manage the app with independent sessions and password resets', async (t) => {
  const { db, request, login } = await fixture(t);
  let firstCookie = await login();
  await createOrResetAdmin(db, 'second@example.com', 'second-test-password');
  const secondCookie = await login('SECOND@example.com', 'second-test-password');
  for (const cookie of [firstCookie, secondCookie]) {
    assert.equal((await request('/api/admin/data', { headers: { cookie } })).status, 200);
    assert.equal((await request('/api/admin/settings', { method: 'PUT', headers: { cookie }, body: (await settings(db)) })).status, 200);
  }
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { email: 'unknown@example.com', password: ' secure-test-password ' } })).status, 401);
  assert.equal((await request('/api/admin/logout', { method: 'POST', headers: { cookie: firstCookie }, body: {} })).status, 200);
  assert.equal((await request('/api/admin/data', { headers: { cookie: firstCookie } })).status, 401);
  assert.equal((await request('/api/admin/data', { headers: { cookie: secondCookie } })).status, 200);
  firstCookie = await login();
  await createOrResetAdmin(db, 'Second@Example.com', 'updated-test-password');
  assert.equal((await request('/api/admin/data', { headers: { cookie: secondCookie } })).status, 401);
  assert.equal((await request('/api/admin/data', { headers: { cookie: firstCookie } })).status, 200);
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { email: 'second@example.com', password: 'second-test-password' } })).status, 401);
  await login('second@example.com', 'updated-test-password');
  await assert.rejects(createOrResetAdmin(db, 'third@example.com', 'third-test-password'), { status: 400 });
  assert.equal((await db.prepare('SELECT count(*) AS count FROM admin').get()).count, 2);
});
test('admin setup validates email and password without changing existing accounts', async (t) => {
  const { db } = await fixture(t);
  const previous = (await db.prepare('SELECT * FROM admin').get());
  for (const [email, password] of [['bad-email', 'valid-test-password'], ['other@example.com', 'short'], ['other@example.com', 'x'.repeat(257)]]) {
    await assert.rejects(createOrResetAdmin(db, email, password), { status: 400 });
  }
  assert.deepEqual((await db.prepare('SELECT * FROM admin').get()), previous);
});
test('SMS sign-in is removed and old phone sessions cannot access admin data', async (t) => {
  const { db, request } = await fixture(t);
  for (const path of ['/api/admin/request-code', '/api/admin/verify-code']) {
    assert.equal((await request(path, { method: 'POST', body: { phone: '+15551234567', code: '123456' } })).status, 404);
  }
  const token = (await createSession(db, 'old-sms-identity'));
  assert.equal((await request('/api/admin/data', { headers: { cookie: `session=${token}` } })).status, 401);
  assert.equal((await request('/api/admin/session')).body.configured, true);
});
test('cross-origin and malformed JSON requests are rejected', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/bookings', { method: 'POST', body: {}, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await request('/api/bookings', { method: 'POST', body: {}, headers: { origin: undefined } })).status, 403);
  assert.equal((await request('/api/bookings', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/bookings', { method: 'POST', body: '{broken' })).status, 400);
});
test('a visitor books without an account, cannot double book, and can cancel via the private token', async (t) => {
  const { db, request, provider } = await fixture(t);
  const input = (await futureSlot(db));
  const booked = await request('/api/bookings', { method: 'POST', body: input });
  assert.equal(booked.status, 201);
  assert.equal((await request('/api/bookings', { method: 'POST', body: input })).status, 409);
  assert.equal(booked.body.token, undefined);
  const token = booked.headers['set-cookie'].split(';')[0].split('=')[1];
  const path = '/api/booking';
  const headers = { authorization: `Bearer ${token}` };
  provider.payBooking(booked.body.id);
  const view = await request(path, { headers });
  assert.equal(view.body.name, `${input.firstName} ${input.lastName}`);
  assert.equal(view.body.email, undefined);
  assert.equal(view.body.token_hash, undefined);
  assert.equal((await request('/api/booking/bad-token')).status, 404);
  assert.equal((await request(path, { method: 'POST', body: { action: 'cancel' }, headers })).body.status, 'cancelled');
  assert.equal((await request('/api/bookings', { method: 'POST', body: input })).status, 201);
});
test('simultaneous booking requests create only one appointment', async (t) => {
  const { db, request } = await fixture(t);
  const input = (await futureSlot(db));
  const results = await Promise.all(Array.from({ length: 8 }, () => request('/api/bookings', { method: 'POST', body: input })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
});
test('public availability releases a provider-expired hold even when its webhook was missed', async (t) => {
  const { db, request, provider } = await fixture(t);
  const input = await futureSlot(db);
  const checkout = await request('/api/bookings', { method: 'POST', body: input });
  assert.equal(checkout.status, 201);
  [...provider.sessions.values()][0].status = 'expired';
  await db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE id = ?').run(Date.now() - 1, checkout.body.id);
  const result = await request(`/api/availability?date=${input.date}`);
  assert.equal(result.status, 200);
  assert(result.body.slots.some((slot) => slot.time === input.time));
  assert.equal((await db.prepare('SELECT status FROM bookings WHERE id = ?').get(checkout.body.id)).status, 'expired');
});
test('booking requires first name, last name, and phone without collecting email or notes', async (t) => {
  const { db, request } = await fixture(t);
  const input = (await futureSlot(db));
  for (const field of ['firstName', 'lastName', 'phone']) {
    const body = { ...input };
    delete body[field];
    assert.equal((await request('/api/bookings', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/bookings', { method: 'POST', body: { ...input, phone: '-------' } })).status, 400);
  const result = await request('/api/bookings', { method: 'POST', body: { ...input, firstName: ' Sam ', lastName: ' Example ', email: 'unused@example.com', notes: 'Not collected' } });
  assert.equal(result.status, 201);
  const saved = (await db.prepare('SELECT name, phone, email, notes FROM bookings').get());
  assert.deepEqual({ ...saved }, { name: 'Sam Example', phone: input.phone, email: '', notes: '' });
});
test('only the haircut is public and bookable, and admin cannot add other options', async (t) => {
  const { db, request, login } = await fixture(t);
  (await db.prepare('INSERT INTO services VALUES (?, ?, ?, ?, ?, 1, ?)').run('legacy-beard', 'Beard', 'Legacy service', 30, 2000, 1));
  const publicResult = await request('/api/public');
  assert.deepEqual(publicResult.body.services.map((service) => service.name), ['Haircut']);
  const input = (await futureSlot(db));
  assert((await request(`/api/availability?date=${input.date}`)).body.slots.length > 0);
  assert.equal((await request(`/api/availability?date=${input.date}&service=legacy-beard`)).status, 400);
  assert.equal((await request('/api/bookings', { method: 'POST', body: { ...input, serviceId: 'legacy-beard' } })).status, 400);
  const headers = { cookie: await login() };
  const adminResult = await request('/api/admin/data', { headers });
  assert.equal(adminResult.body.services.length, 1);
  const haircut = adminResult.body.services[0];
  for (const services of [[haircut, { ...haircut, id: 'extra' }], [{ ...haircut, id: 'extra' }], [{ ...haircut, active: false }], [{ ...haircut, duration: 0 }], [{ ...haircut, price: -1 }]]) {
    assert.equal((await request('/api/admin/services', { method: 'PUT', body: { services }, headers })).status, 400);
  }
  const booked = await request('/api/bookings', { method: 'POST', body: input });
  assert.equal(booked.status, 201);
  assert.equal((await request('/api/admin/services', { method: 'PUT', body: { services: [{ ...haircut, name: 'Other name', duration: 60, price: 5000 }] }, headers })).status, 200);
  const updated = (await request('/api/public')).body.services[0];
  assert.equal(updated.name, 'Haircut');
  assert.equal(updated.duration, 60);
  assert.equal(updated.price, 5000);
  const saved = (await db.prepare('SELECT service_name, duration, price FROM bookings WHERE id = ?').get(booked.body.id));
  assert.deepEqual({ ...saved }, { service_name: 'Haircut', duration: 45, price: 4000 });
});
test('admin can update the business, services, and availability with validation', async (t) => {
  const { db, request, login } = await fixture(t);
  const headers = { cookie: await login() };
  const config = { ...(await settings(db)), name: 'Cole’s studio' };
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: config, headers })).status, 200);
  assert.equal((await settings(db)).name, 'Cole’s studio');
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: { ...config, timezone: 'not/a-zone' }, headers })).status, 400);
  const data = (await publicData(db));
  assert.equal((await request('/api/admin/services', { method: 'PUT', body: { services: data.services.map((s) => ({ ...s, price: 4500 })) }, headers })).status, 200);
  assert.equal((await db.prepare('SELECT price FROM services LIMIT 1').get()).price, 4500);
  assert.equal((await request('/api/admin/services', { method: 'PUT', body: { services: [] }, headers })).status, 400);
  const hours = data.hours.map((h) => ({ ...h, start: '10:00' }));
  assert.equal((await request('/api/admin/hours', { method: 'PUT', body: { hours, daysOff: [{ date: '2027-01-01', note: 'Holiday' }] }, headers })).status, 200);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM days_off').get()).n, 1);
  assert.equal((await request('/api/admin/hours', { method: 'PUT', body: { hours: hours.slice(1), daysOff: [] }, headers })).status, 400);
});
test('studio time zone cannot change underneath existing upcoming appointments', async (t) => {
  const { db, request, login } = await fixture(t);
  (await createBooking(db, (await futureSlot(db))));
  const result = await request('/api/admin/settings', { method: 'PUT', headers: { cookie: await login() }, body: { ...(await settings(db)), timezone: 'America/Los_Angeles' } });
  assert.equal(result.status, 400);
});
test('photo uploads require admin access and gallery URLs must be validated', async (t) => {
  const { request, login } = await fixture(t);
  const headers = { cookie: await login() };
  assert.equal((await request('/api/admin/upload', { method: 'POST', body: {} })).status, 401);
  assert.equal((await request('/api/admin/upload/complete', { method: 'POST', body: {} })).status, 401);
  assert.equal((await request('/api/admin/upload/complete', { method: 'POST', headers, body: { image: 'https://other.example/picture.jpg' } })).status, 400);
  const photo = { title: 'A fresh cut', category: 'Short cuts', image: '/assets/cut-1.jpg', alt: 'A short haircut', sample: false };
  assert.equal((await request('/api/admin/gallery', { method: 'PUT', headers, body: { gallery: [photo] } })).status, 200);
  assert.equal((await request('/api/admin/gallery', { method: 'PUT', headers, body: { gallery: [{ ...photo, image: 'javascript:alert(1)' }] } })).status, 400);
});
test('admin can cancel appointments without exposing management tokens', async (t) => {
  const { db, request, login } = await fixture(t);
  const booked = (await createBooking(db, (await futureSlot(db))));
  await db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(booked.id);
  const headers = { cookie: await login() };
  const data = await request('/api/admin/data', { headers });
  assert.equal(data.body.bookings[0].token_hash, undefined);
  assert.equal((await request(`/api/admin/bookings/${booked.id}`, { method: 'PATCH', headers, body: { status: 'completed' } })).status, 400);
  assert.equal((await request(`/api/admin/bookings/${booked.id}`, { method: 'PATCH', headers, body: { status: 'cancelled' } })).status, 200);
});
test('admin can curate TikTok videos with validated links and public ordering', async (t) => {
  const { request, login } = await fixture(t);
  const headers = { cookie: await login() };
  const video = { title: 'Fresh haircut', url: 'https://tiktok.com/@l2cuts/video/7700290410312142093?is_from_webapp=1' };
  const second = { title: 'Another haircut', url: 'https://www.tiktok.com/@l2cuts/video/7698458409233878285' };
  assert.equal((await request('/api/admin/videos', { method: 'PUT', headers, body: { videos: [second, video] } })).status, 200);
  const saved = (await request('/api/public')).body.videos;
  assert.deepEqual(saved.map((item) => item.title), ['Another haircut', 'Fresh haircut']);
  assert.equal(saved[1].url, 'https://www.tiktok.com/@l2cuts/video/7700290410312142093');
  const invalidUrls = ['javascript:alert(1)', 'https://example.com/@l2cuts/video/7700290410312142093', 'https://www.tiktok.com.evil.example/@l2cuts/video/7700290410312142093', 'https://www.tiktok.com/@other/video/7700290410312142093', 'https://www.tiktok.com/@l2cuts', 'https://www.tiktok.com:444/@l2cuts/video/7700290410312142093'];
  for (const url of invalidUrls) assert.equal((await request('/api/admin/videos', { method: 'PUT', headers, body: { videos: [{ ...video, url }] } })).status, 400);
  for (const videos of [[video, video], [{ ...video, title: '' }], [null], Array(31).fill(video)]) {
    assert.equal((await request('/api/admin/videos', { method: 'PUT', headers, body: { videos } })).status, 400);
  }
  assert.deepEqual((await request('/api/public')).body.videos, saved);
  assert.equal((await request('/api/admin/videos', { method: 'PUT', headers, body: { videos: [] } })).status, 200);
  assert.deepEqual((await request('/api/public')).body.videos, []);
});
test('admin can edit the overall review score and individual reviews without partial invalid saves', async (t) => {
  const { request, login } = await fixture(t);
  const initial = (await request('/api/public')).body.reviews;
  assert.equal(initial.rating, 4.99);
  assert.equal(initial.items.length, 0);
  assert(initial.items.every((review) => review.stars === 5 && review.sample === true));
  const headers = { cookie: await login() };
  const review = { name: 'Sam Example', text: 'A review edited by the admin.', stars: 5, sample: false };
  const body = { rating: 4.95, items: [review] };
  assert.equal((await request('/api/admin/reviews', { method: 'PUT', headers, body })).status, 200);
  const saved = (await request('/api/public')).body.reviews;
  assert.equal(saved.rating, 4.95);
  assert.deepEqual({ ...saved.items[0], id: undefined }, { ...review, id: undefined });
  assert.equal(typeof saved.items[0].id, 'string');
  for (const invalid of [
    { ...body, rating: -1 }, { ...body, rating: 5.01 }, { ...body, rating: 4.999 }, { ...body, rating: '4.99' },
    { ...body, items: null }, { ...body, items: Array(11).fill(review) }, { ...body, items: [null] },
    { ...body, items: [{ ...review, name: '' }] }, { ...body, items: [{ ...review, text: 'x'.repeat(601) }] },
    { ...body, items: [{ ...review, stars: 0 }] }, { ...body, items: [{ ...review, stars: 5.5 }] },
    { ...body, items: [{ ...review, sample: 'false' }] }, { ...body, items: [saved.items[0], saved.items[0]] },
  ]) assert.equal((await request('/api/admin/reviews', { method: 'PUT', headers, body: invalid })).status, 400);
  assert.deepEqual((await request('/api/public')).body.reviews, saved);
  assert.equal((await request('/api/admin/reviews', { method: 'PUT', headers: { ...headers, origin: 'https://other.example' }, body })).status, 403);
  assert.equal((await request('/api/admin/reviews', { method: 'PUT', headers, body: { rating: 5, items: [] } })).status, 200);
  assert.deepEqual((await request('/api/public')).body.reviews, { rating: 5, items: [] });
});
test('static routing does not expose server files, databases, or environment files', async (t) => {
  const { request } = await fixture(t);
  for (const path of ['/.env', '/data/scheduler.sqlite', '/server/index.js', '/assets/../server/store.js']) assert.equal((await request(path)).status, 404);
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(home.headers['content-security-policy'], /frame-src https:\/\/www\.tiktok\.com;/);
  assert.match(home.headers['content-security-policy'], /script-src 'self';/);
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
});
test('repeated login failures are rate-limited', async (t) => {
  const { request } = await fixture(t);
  let result;
  for (let i = 0; i < 11; i++) result = await request('/api/admin/login', { method: 'POST', body: { email: 'admin@example.com', password: 'wrong-password' } });
  assert.equal(result.status, 429);
});
