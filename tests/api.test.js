import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, publicData, settings } from '../server/store.js';
import { appServer } from '../server/index.js';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { availableSlots, createBooking, localParts } from '../server/scheduling.js';
const origin = 'http://localhost:3000';

async function fixture(t, smsOptions = { phone: '', provider: null }) {
  const db = openStore(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'haircut-test-'));
  const server = appServer({ db, origin, dataDir, smsOptions });
  const password = ' secure-test-password ';
  db.prepare('INSERT INTO admin VALUES (1, ?, ?)').run('admin@example.com', await hashPassword(password));
  t.after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  function request(path, { method = 'GET', body, headers = {} } = {}) {
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
  async function login() {
    const result = await request('/api/admin/login', { method: 'POST', body: { email: 'admin@example.com', password } });
    assert.equal(result.status, 200);
    return result.headers['set-cookie'].split(';')[0];
  }
  return { db, request, login, dataDir };
}
function futureSlot(db) {
  const now = Date.now();
  const today = localParts(now, settings(db).timezone).date;
  for (let i = 1; i < 15; i++) {
    const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + i);
    const day = date.toISOString().slice(0, 10);
    const slots = availableSlots(db, day, 'haircut', now);
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
  assert.deepEqual(Object.keys(result.body).sort(), ['gallery', 'hours', 'services', 'settings', 'videos']);
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('private admin endpoints and mutations require authentication', async (t) => {
  const { request } = await fixture(t);
  for (const path of ['/api/admin/data', '/api/admin/settings', '/api/admin/gallery', '/api/admin/videos']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: {} })).status, 401);
  assert.equal((await request('/api/admin/videos', { method: 'PUT', body: { videos: [] } })).status, 401);
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
test('phone and one-time code create a private session without exposing codes or allowing password bypass', async (t) => {
  const sent = [];
  const provider = { identity: 'test-verify', async send(phone) { sent.push(phone); return 'verification-id'; }, async check(sid, code) { return sid === 'verification-id' && code === '123456'; } };
  const { request, db } = await fixture(t, { phone: '+15551234567', provider });
  const session = await request('/api/admin/session');
  assert.equal(session.body.smsReady, true);
  assert.equal(session.body.passwordAvailable, false);
  assert(!JSON.stringify(session.body).includes('5551234567'));
  assert.equal((await request('/api/admin/login', { method: 'POST', body: { email: 'admin@example.com', password: ' secure-test-password ' } })).status, 400);
  const unknown = await request('/api/admin/request-code', { method: 'POST', body: { phone: '+15557654321' } });
  assert.equal(unknown.status, 202);
  assert.deepEqual(sent, []);
  const result = await request('/api/admin/request-code', { method: 'POST', body: { phone: '(555) 123-4567' } });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { ok: true, retryAfter: 30 });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.headers['set-cookie'], /HttpOnly; SameSite=Strict; Path=\/api\/admin; Max-Age=600/);
  assert.deepEqual(sent, ['+15551234567']);
  const challenge = result.headers['set-cookie'].split(';')[0];
  const body = { phone: '+15551234567', code: '123456' };
  assert.equal((await request('/api/admin/verify-code', { method: 'POST', body })).status, 401);
  assert.equal((await request('/api/admin/verify-code', { method: 'POST', headers: { cookie: challenge }, body: { ...body, code: '999999' } })).status, 401);
  const verified = await request('/api/admin/verify-code', { method: 'POST', headers: { cookie: challenge }, body });
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.body, { authenticated: true });
  const cookie = verified.headers['set-cookie'].find((value) => value.startsWith('session=')).split(';')[0];
  assert.equal((await request('/api/admin/data', { headers: { cookie } })).status, 200);
  assert.equal((await request('/api/admin/verify-code', { method: 'POST', headers: { cookie: challenge }, body })).status, 401);
  assert.equal((await request('/api/admin/logout', { method: 'POST', body: {}, headers: { cookie } })).status, 200);
  assert.equal((await request('/api/admin/data', { headers: { cookie } })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS count FROM admin_challenges').get().count, 0);
});

test('SMS setup failures, cross-origin requests, and send abuse do not create sessions', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/admin/request-code', { method: 'POST', body: { phone: '+15551234567' } })).status, 503);
  assert.equal((await request('/api/admin/session')).body.passwordAvailable, true);
  assert.equal((await request('/api/admin/request-code', { method: 'POST', body: { phone: '+15551234567' }, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await request('/api/admin/verify-code', { method: 'POST', body: { phone: '+15551234567', code: '123456' }, headers: { origin: 'https://other.example' } })).status, 403);
  for (let i = 0; i < 10; i++) await request('/api/admin/request-code', { method: 'POST', body: { phone: '+15557654321' } });
  assert.equal((await request('/api/admin/request-code', { method: 'POST', body: { phone: '+15557654321' } })).status, 429);
});
test('two phone admins have full management access and independent logout', async (t) => {
  const phones = ['+15551234567', '+15557654321'];
  const codes = ['123456', '654321'];
  const sent = [];
  const provider = { identity: 'two-admin-test', async send(phone) { sent.push(phone); return phone; }, async check(sid, code) { return code === codes[phones.indexOf(sid)]; } };
  const { request, db } = await fixture(t, { phones, provider });
  const challenges = [];
  for (const phone of phones) {
    const result = await request('/api/admin/request-code', { method: 'POST', body: { phone } });
    assert.equal(result.status, 202);
    challenges.push(result.headers['set-cookie'].split(';')[0]);
  }
  const third = await request('/api/admin/request-code', { method: 'POST', body: { phone: '+15550000000' } });
  assert.equal(third.status, 202);
  assert.deepEqual(sent, phones);
  assert.equal((await request('/api/admin/verify-code', { method: 'POST', headers: { cookie: challenges[0] }, body: { phone: phones[1], code: codes[1] } })).status, 401);
  const cookies = [];
  for (let i = 0; i < phones.length; i++) {
    const verified = await request('/api/admin/verify-code', { method: 'POST', headers: { cookie: challenges[i] }, body: { phone: phones[i], code: codes[i] } });
    assert.equal(verified.status, 200);
    const cookie = verified.headers['set-cookie'].find((value) => value.startsWith('session=')).split(';')[0];
    cookies.push(cookie);
    assert.equal((await request('/api/admin/settings', { method: 'PUT', headers: { cookie }, body: { ...settings(db), name: `Admin ${i + 1} studio` } })).status, 200);
  }
  assert.equal(db.prepare('SELECT count(DISTINCT auth_key) AS count FROM sessions').get().count, 2);
  for (const cookie of cookies) assert.equal((await request('/api/admin/data', { headers: { cookie } })).status, 200);
  assert.equal((await request('/api/admin/logout', { method: 'POST', headers: { cookie: cookies[0] }, body: {} })).status, 200);
  assert.equal((await request('/api/admin/data', { headers: { cookie: cookies[0] } })).status, 401);
  assert.equal((await request('/api/admin/data', { headers: { cookie: cookies[1] } })).status, 200);
  const publicResult = JSON.stringify((await request('/api/public')).body);
  for (const phone of phones) assert(!publicResult.includes(phone));
});
test('cross-origin and malformed JSON requests are rejected', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/bookings', { method: 'POST', body: {}, headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await request('/api/bookings', { method: 'POST', body: {}, headers: { origin: undefined } })).status, 403);
  assert.equal((await request('/api/bookings', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/bookings', { method: 'POST', body: '{broken' })).status, 400);
});
test('a visitor books without an account, cannot double book, and can cancel via the private token', async (t) => {
  const { db, request } = await fixture(t);
  const input = futureSlot(db);
  const booked = await request('/api/bookings', { method: 'POST', body: input });
  assert.equal(booked.status, 201);
  assert.equal((await request('/api/bookings', { method: 'POST', body: input })).status, 409);
  const path = `/api/booking/${booked.body.token}`;
  const view = await request(path);
  assert.equal(view.body.name, `${input.firstName} ${input.lastName}`);
  assert.equal(view.body.email, undefined);
  assert.equal(view.body.token_hash, undefined);
  assert.equal((await request('/api/booking/bad-token')).status, 404);
  assert.equal((await request(path, { method: 'POST', body: { action: 'cancel' } })).body.status, 'cancelled');
  assert.equal((await request('/api/bookings', { method: 'POST', body: input })).status, 201);
});
test('simultaneous booking requests create only one appointment', async (t) => {
  const { db, request } = await fixture(t);
  const input = futureSlot(db);
  const results = await Promise.all(Array.from({ length: 8 }, () => request('/api/bookings', { method: 'POST', body: input })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
});
test('booking requires first name, last name, and phone without collecting email or notes', async (t) => {
  const { db, request } = await fixture(t);
  const input = futureSlot(db);
  for (const field of ['firstName', 'lastName', 'phone']) {
    const body = { ...input };
    delete body[field];
    assert.equal((await request('/api/bookings', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/api/bookings', { method: 'POST', body: { ...input, phone: '-------' } })).status, 400);
  const result = await request('/api/bookings', { method: 'POST', body: { ...input, firstName: ' Sam ', lastName: ' Example ', email: 'unused@example.com', notes: 'Not collected' } });
  assert.equal(result.status, 201);
  const saved = db.prepare('SELECT name, phone, email, notes FROM bookings').get();
  assert.deepEqual({ ...saved }, { name: 'Sam Example', phone: input.phone, email: '', notes: '' });
});
test('only the haircut is public and bookable, and admin cannot add other options', async (t) => {
  const { db, request, login } = await fixture(t);
  db.prepare('INSERT INTO services VALUES (?, ?, ?, ?, ?, 1, ?)').run('legacy-beard', 'Beard', 'Legacy service', 30, 2000, 1);
  const publicResult = await request('/api/public');
  assert.deepEqual(publicResult.body.services.map((service) => service.name), ['Haircut']);
  const input = futureSlot(db);
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
  const saved = db.prepare('SELECT service_name, duration, price FROM bookings WHERE id = ?').get(booked.body.id);
  assert.deepEqual({ ...saved }, { service_name: 'Haircut', duration: 45, price: 4000 });
});
test('admin can update the business, services, and availability with validation', async (t) => {
  const { db, request, login } = await fixture(t);
  const headers = { cookie: await login() };
  const config = { ...settings(db), name: 'Cole’s studio' };
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: config, headers })).status, 200);
  assert.equal(settings(db).name, 'Cole’s studio');
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: { ...config, timezone: 'not/a-zone' }, headers })).status, 400);
  const data = publicData(db);
  assert.equal((await request('/api/admin/services', { method: 'PUT', body: { services: data.services.map((s) => ({ ...s, price: 4500 })) }, headers })).status, 200);
  assert.equal(db.prepare('SELECT price FROM services LIMIT 1').get().price, 4500);
  assert.equal((await request('/api/admin/services', { method: 'PUT', body: { services: [] }, headers })).status, 400);
  const hours = data.hours.map((h) => ({ ...h, start: '10:00' }));
  assert.equal((await request('/api/admin/hours', { method: 'PUT', body: { hours, daysOff: [{ date: '2027-01-01', note: 'Holiday' }] }, headers })).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM days_off').get().n, 1);
  assert.equal((await request('/api/admin/hours', { method: 'PUT', body: { hours: hours.slice(1), daysOff: [] }, headers })).status, 400);
});
test('studio time zone cannot change underneath existing upcoming appointments', async (t) => {
  const { db, request, login } = await fixture(t);
  createBooking(db, futureSlot(db));
  const result = await request('/api/admin/settings', { method: 'PUT', headers: { cookie: await login() }, body: { ...settings(db), timezone: 'America/Los_Angeles' } });
  assert.equal(result.status, 400);
});
test('admin can upload real images; executable and oversized uploads are rejected', async (t) => {
  const { request, login, dataDir } = await fixture(t);
  const headers = { cookie: await login() };
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const uploaded = await request('/api/admin/upload', { method: 'POST', headers, body: { data: image } });
  assert.equal(uploaded.status, 201);
  assert.equal(readdirSync(join(dataDir, 'uploads')).length, 1);
  assert.equal((await request(uploaded.body.image)).status, 200);
  assert.equal((await request('/api/admin/upload', { method: 'POST', headers, body: { data: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64') } })).status, 400);
  const photo = { title: 'A fresh cut', category: 'Short cuts', image: uploaded.body.image, alt: 'A short haircut', sample: false };
  assert.equal((await request('/api/admin/gallery', { method: 'PUT', headers, body: { gallery: [photo] } })).status, 200);
  assert.equal((await request('/api/admin/gallery', { method: 'PUT', headers, body: { gallery: [{ ...photo, image: 'javascript:alert(1)' }] } })).status, 400);
});
test('admin can cancel appointments without exposing management tokens', async (t) => {
  const { db, request, login } = await fixture(t);
  const booked = createBooking(db, futureSlot(db));
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
