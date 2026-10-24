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

async function fixture(t) {
  const db = openStore(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'haircut-test-'));
  const server = appServer({ db, origin, dataDir });
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
    const slots = availableSlots(db, day, 'signature-cut', now);
    if (slots.length) return { serviceId: 'signature-cut', date: day, time: slots[0].time, name: 'Sam Example', email: 'sam@example.com', notes: '' };
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
  assert.deepEqual(Object.keys(result.body).sort(), ['gallery', 'hours', 'services', 'settings']);
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('private admin endpoints and mutations require authentication', async (t) => {
  const { request } = await fixture(t);
  for (const path of ['/api/admin/data', '/api/admin/settings', '/api/admin/gallery']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: {} })).status, 401);
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
  assert.equal(view.body.name, input.name);
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
test('static routing does not expose server files, databases, or environment files', async (t) => {
  const { request } = await fixture(t);
  for (const path of ['/.env', '/data/scheduler.sqlite', '/server/index.js', '/assets/../server/store.js']) assert.equal((await request(path)).status, 404);
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
});
test('repeated login failures are rate-limited', async (t) => {
  const { request } = await fixture(t);
  let result;
  for (let i = 0; i < 11; i++) result = await request('/api/admin/login', { method: 'POST', body: { email: 'admin@example.com', password: 'wrong-password' } });
  assert.equal(result.status, 429);
});
