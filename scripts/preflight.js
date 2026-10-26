import { runtimeConfig } from '../server/config.js';
import { openStore, publicData } from '../server/store.js';
import { paymentProvider } from '../server/payments.js';
import { callbackUrl } from '../server/urls.js';
let db;
try {
  const required = ['DATABASE_URL', 'APP_ORIGIN', 'APP_SECRET', 'CRON_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BLOB_READ_WRITE_TOKEN', 'BLOB_PUBLIC_ORIGIN'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  const { origin } = runtimeConfig();
  db = openStore();
  const data = await publicData(db);
  const admins = await db.prepare('SELECT count(*) AS n FROM admin').get();
  if (!admins.n) throw new Error('Create or import at least one admin before launch.');
  if (data.services.length !== 1 || data.services[0].price < 50) throw new Error('Configure the haircut service and a payable price.');
  if (data.homeVideos.some((video) => !video.video.startsWith(process.env.BLOB_PUBLIC_ORIGIN + '/') || !video.poster.startsWith(process.env.BLOB_PUBLIC_ORIGIN + '/'))) throw new Error('Migrate local videos and posters to Blob before launch.');
  const { stripe, live } = paymentProvider();
  const account = await stripe.accounts.retrieve();
  if (live && (!account.charges_enabled || !account.payouts_enabled)) throw new Error('Complete Stripe account activation and payouts before accepting live payments.');
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const expected = ['checkout.session.completed', 'checkout.session.expired', 'charge.refunded'];
  if (!endpoints.data.some((endpoint) => endpoint.url === callbackUrl(origin, '/api/stripe/webhook') && endpoint.status === 'enabled' && expected.every((event) => endpoint.enabled_events.includes(event) || endpoint.enabled_events.includes('*')))) throw new Error('Configure the enabled Stripe webhook endpoint and required events.');
  console.log(`Preflight passed (${live ? 'live' : 'test'} payments): ${admins.n} admin(s), ${data.homeVideos.length} videos. Verify receipts, provider callbacks, backups, and domain routing before launch.`);
} catch (error) { console.error(error.type?.startsWith('Stripe') ? 'Stripe preflight failed. Check the account, API key and webhook configuration in Stripe.' : error.message); process.exitCode = 1; }
finally { await db?.close(); }
