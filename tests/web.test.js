import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { fakeProvider } from './fake-stripe.js';
import { createWebHandler } from '../server/web.js';
import { runtimeConfig } from '../server/config.js';
import { localParts } from '../server/scheduling.js';

test('deployment configuration requires durable resources and keeps preview Stripe keys in test mode', () => {
  assert.throws(() => runtimeConfig({}), { status: 503 });
  const env = { APP_ORIGIN: 'https://www.l2cuts.com', DATABASE_URL: 'postgres://fixture', BLOB_PUBLIC_ORIGIN: 'https://fixture.public.blob.vercel-storage.com', BLOB_READ_WRITE_TOKEN: 'fixture', CRON_SECRET: 'x'.repeat(32), APP_SECRET: 'y'.repeat(32), STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
  assert.equal(runtimeConfig(env).origin, env.APP_ORIGIN);
  assert.equal(runtimeConfig({ ...env, VERCEL_ENV: 'preview', VERCEL_URL: 'preview.vercel.app' }).origin, 'https://preview.vercel.app');
  assert.throws(() => runtimeConfig({ ...env, APP_ORIGIN: 'http://www.l2cuts.com' }), { status: 503 });
});

test('Vercel web adapter preserves signed raw bodies and keeps private tokens out of request URLs', async (t) => {
  const db = await testDatabase(t);
  const provider = fakeProvider();
  const origin = 'https://www.l2cuts.com';
  const handler = createWebHandler(db, { origin, provider });
  const today = localParts(Date.now(), 'America/New_York').date;
  const day = new Date(`${today}T12:00:00Z`);
  do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() !== 2);
  const input = { requestId: randomUUID(), date: day.toISOString().slice(0, 10), time: '09:00', firstName: 'Test', lastName: 'Customer', phone: '555-123-4567' };
  const response = await handler(new Request(`${origin}/api/bookings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.token, undefined);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  const token = cookie.split('=')[1];
  const session = provider.payBooking(body.id);
  const event = provider.event('checkout.session.completed', { id: session.id });
  const webhook = await handler(new Request(`${origin}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': event.signature }, body: event.raw }));
  assert.equal(webhook.status, 200);
  const returned = await handler(new Request(`${origin}/api/checkout/return/${body.id}`, { headers: { Cookie: cookie } }));
  assert.equal(returned.status, 303);
  assert.equal(returned.headers.get('location'), `/booking#${token}`);
  const missingCookie = await handler(new Request(`${origin}/api/checkout/return/${body.id}`));
  assert.equal(missingCookie.headers.get('location'), '/booking');
  const privateView = await handler(new Request(`${origin}/api/booking`, { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal((await privateView.json()).status, 'confirmed');
  assert.equal(privateView.headers.get('cache-control'), 'no-store');
  assert.equal((await handler(new Request(`${origin}/api/booking/${token}`))).status, 404);
});
