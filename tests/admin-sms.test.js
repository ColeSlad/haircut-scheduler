import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.js';
import { createAdminSms } from '../server/admin-sms.js';
import { createTwilioVerify, normalizeAdminPhone } from '../server/sms.js';
import { HttpError } from '../server/scheduling.js';

const phone = '+15551234567';
function fixture(t, overrides = {}) {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let time = Date.now();
  const calls = { send: [], check: [] };
  const provider = { identity: 'test-provider', async send(number) { calls.send.push(number); return `VE${'0'.repeat(32)}`; }, async check(sid, code) { calls.check.push([sid, code]); return code === '123456'; } };
  const options = { phone, provider, now: () => time, ...overrides };
  return { db, provider, calls, options, sms: createAdminSms(db, options), advance(ms) { time += ms; } };
}

test('admin phone normalization supports US formatting and explicit international country codes', () => {
  assert.equal(normalizeAdminPhone('(555) 123-4567'), phone);
  assert.equal(normalizeAdminPhone('+1 (555) 123-4567'), phone);
  assert.equal(normalizeAdminPhone('+44 20 7946 0958'), '+442079460958');
  for (const value of ['', 'phone', '12+3456789', '000', null, '+01234567890']) assert.throws(() => normalizeAdminPhone(value), { status: 400 });
});

test('Twilio Verify sends and checks through its official server API without exposing provider errors', async () => {
  const calls = [];
  const provider = createTwilioVerify({ accountSid: `AC${'0'.repeat(32)}`, authToken: 'test-only-token', serviceSid: `VA${'1'.repeat(32)}`, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => url.endsWith('/Verifications') ? { status: 'pending', sid: `VE${'2'.repeat(32)}` } : { status: 'approved' } };
  } });
  const sid = await provider.send(phone);
  assert.equal(await provider.check(sid, '123456'), true);
  assert.equal(calls[0].url, `https://verify.twilio.com/v2/Services/VA${'1'.repeat(32)}/Verifications`);
  assert.equal(new URLSearchParams(calls[0].options.body).get('To'), phone);
  assert.equal(new URLSearchParams(calls[0].options.body).get('Channel'), 'sms');
  assert.equal(new URLSearchParams(calls[1].options.body).get('VerificationSid'), sid);
  assert.equal(new URLSearchParams(calls[1].options.body).get('Code'), '123456');
  assert.equal(calls[0].options.redirect, 'error');
  const unavailable = createTwilioVerify({ accountSid: `AC${'0'.repeat(32)}`, authToken: 'test-only-token', serviceSid: `VA${'1'.repeat(32)}`, fetchImpl: async () => { throw new Error('secret-provider-details'); } });
  await assert.rejects(unavailable.send(phone), { status: 503, message: 'SMS sign-in is temporarily unavailable. Please try again later.' });
  assert.equal(createTwilioVerify({ accountSid: '', authToken: '', serviceSid: '' }), null);
});

test('only the configured admin receives codes and each challenge is consumed once', async (t) => {
  const { sms, calls, db } = fixture(t);
  const unknown = await sms.requestCode('+15557654321');
  assert.equal(calls.send.length, 0);
  await assert.rejects(sms.verifyCode('+15557654321', '123456', unknown.token), { status: 401 });
  const challenge = await sms.requestCode(phone);
  assert.deepEqual(calls.send, [phone]);
  const stored = db.prepare('SELECT * FROM admin_challenges').get();
  assert.notEqual(stored.token_hash, challenge.token);
  assert.equal(stored.code, undefined);
  assert.equal(await sms.verifyCode(phone, '123456', challenge.token), sms.authKey);
  await assert.rejects(sms.verifyCode(phone, '123456', challenge.token), { status: 401 });
});

test('codes expire, require the requesting browser token, and stop after five wrong attempts', async (t) => {
  const { sms, calls, advance } = fixture(t);
  const challenge = await sms.requestCode(phone);
  await assert.rejects(sms.verifyCode(phone, '123456', 'wrong-browser'), { status: 401 });
  for (let i = 0; i < 5; i++) await assert.rejects(sms.verifyCode(phone, '999999', challenge.token), { status: 401 });
  await assert.rejects(sms.verifyCode(phone, '123456', challenge.token), { status: 401 });
  assert.equal(calls.check.length, 5);
  advance(30_000);
  const fresh = await sms.requestCode(phone);
  advance(10 * 60_000);
  await assert.rejects(sms.verifyCode(phone, '123456', fresh.token), { status: 401 });
});

test('resend cooldowns and the hourly SMS cap survive a new auth instance', async (t) => {
  const { db, sms, options, calls, advance } = fixture(t);
  let old = await sms.requestCode(phone);
  await assert.rejects(createAdminSms(db, options).requestCode(phone), { status: 429 });
  for (let i = 1; i < 5; i++) {
    advance(30_000);
    const next = await createAdminSms(db, options).requestCode(phone);
    await assert.rejects(sms.verifyCode(phone, '123456', old.token), { status: 401 });
    old = next;
  }
  advance(30_000);
  await assert.rejects(sms.requestCode(phone), { status: 429 });
  assert.equal(calls.send.length, 5);
  advance(60 * 60_000);
  await sms.requestCode(phone);
  assert.equal(calls.send.length, 6);
});

test('parallel verification and provider failures cannot bypass one-time use', async (t) => {
  let approve;
  const provider = { identity: 'test', send: async () => 'test-verification', check: () => new Promise((resolve) => { approve = resolve; }) };
  const { sms } = fixture(t, { provider });
  const challenge = await sms.requestCode(phone);
  const checking = sms.verifyCode(phone, '123456', challenge.token);
  await assert.rejects(sms.verifyCode(phone, '123456', challenge.token), { status: 401 });
  approve(true);
  assert.equal(await checking, sms.authKey);
  await assert.rejects(sms.verifyCode(phone, '123456', challenge.token), { status: 401 });
});

test('unconfigured providers and delivery failures never create a usable challenge', async (t) => {
  const { db } = fixture(t);
  const sms = createAdminSms(db, { phone, provider: null });
  assert.equal(sms.configured, false);
  await assert.rejects(sms.requestCode(phone), { status: 503 });
  const failing = createAdminSms(db, { phone, provider: { identity: 'test', send: async () => { throw new HttpError(503, 'Delivery failed'); } } });
  await assert.rejects(failing.requestCode(phone), { status: 503 });
  assert.equal(db.prepare('SELECT count(*) AS count FROM admin_challenges').get().count, 0);
});
