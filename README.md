# L2 Cuts

A single-barber booking site with guest checkout and up to two email/password admins. The simple homepage, reviews, supplied logo, and videos are preserved.

Clients choose a time and enter first name, last name, and phone. They pay the full haircut price through Stripe-hosted Checkout, which collects an email for the payment receipt. An appointment is confirmed only after the server verifies payment. Clients save their private appointment link to view, download a calendar event, or cancel. Booking emails, SMS, external calendar sync, and self-service rescheduling are not included.

Admin manages appointments, the haircut price/duration, weekly hours, days off, business details, reviews, photos, and TikTok links. Payment and refund status appear beside appointments. Cancelling releases the time; refunds are handled separately in the Stripe Dashboard.

## Local setup

Use **Node.js 24**, npm, and PostgreSQL 14 or newer. Production uses Neon Postgres and public Vercel Blob. SQLite is retained only for importing the previous installation.

```sh
npm ci
cp .env.example .env
createdb haircut
createdb haircut_test
```

Set `DATABASE_URL` and `TEST_DATABASE_URL` to those separate local databases. Generate independent `APP_SECRET` and `CRON_SECRET` values with `openssl rand -hex 32`. Add Stripe **test** keys and a test Blob store to enable checkout and uploads; other local pages work without them.

For a new, empty installation:

```sh
npm run db:migrate
npm run db:seed
npm run admin:create
npm run dev
```

Open **http://localhost:3000**. Vite serves the frontend and proxies APIs to port 3001. `PORT` changes the frontend port; its API uses the next port. Stop an existing server before using its port. For a built local app, run `npm run build` and `npm start`.

**Existing installations:** follow [DEPLOYMENT.md](DEPLOYMENT.md) to import your SQLite data and media instead of running `db:seed`. Starting or deploying the app never automatically migrates or seeds data.

`npm run admin:create` securely prompts for an email and a hidden password of 12–256 characters. A new email adds an admin, up to two; an existing email resets only that account and revokes its sessions. Both admins have the same access. There is no default password, public registration, or client account requirement.

## Booking and payment rules

Haircut is the only service. New installations default to 45 minutes and $40; migration preserves your current price and duration. Admin can set a price from $0.50 to $1,000. Prices are USD, charged once in full, with cards and eligible wallets through Stripe. No tips, subscriptions, or automatic tax calculation are configured.

The studio time zone drives availability, including daylight-saving changes. Starts are offered every 15 minutes, must fit within working hours, and respect days off, minimum notice, and the booking horizon. Service edits affect new reservations; existing ones retain their booked price and duration. Hours changes do not silently cancel appointments. Upcoming paid appointments or pending checkouts prevent a time-zone change.

Checkout reserves a slot for 31 minutes. Online appointments require at least 32 minutes of notice so checkout expires before the appointment starts, even if an imported configuration used less notice. Pending and confirmed bookings cannot overlap, enforced by both a database transaction and a Postgres exclusion constraint. A slot is released only when Stripe verifies expiry/cancellation, never just because a local timer elapsed. Failed checks keep the hold and are retried by the scheduled reconciliation job. Webhook processing and checkout retries are idempotent.

Clients can cancel before the appointment starts. Cancellation does **not** automatically refund a payment. Admin issues full or partial refunds in Stripe; signed webhooks synchronize the refunded amount without changing appointment status. Stripe payment receipts require the receipt setting described in the deployment guide. No appointment confirmation email is promised.

The private link uses `/booking#token`. Requests send its credential in an authorization header, keeping it out of access-log paths. Anyone with that link can manage the appointment; keep it private. Stripe receives only an opaque booking ID in metadata and return URLs. Returning from Checkout requires the browser's short-lived secure cookie, so use the same browser to complete checkout and save the resulting link.

## Storage and security

Postgres stores appointments, settings, hashed admin credentials and sessions, rate limits, payment references, and media metadata. Vercel Blob stores public videos, posters, and validated photos. Admin uploads go directly to Blob to avoid function request-size limits. The server validates store ownership, file size, and JPEG/PNG/WebP signatures before a photo can be published.

Passwords use salted scrypt. Admin sessions last 12 hours and use HttpOnly, SameSite cookies, with Secure enabled on HTTPS. Server-side origin checks, validation, durable rate limits, and security headers protect mutations. Live Stripe keys are rejected outside Vercel production. Preview deployments must use separate test resources.

Never commit `.env`, database exports, runtime SQLite files, uploads, credentials, or private booking links. `data/`, `.env*` (except the example), `.backups/`, `.vercel/`, and build output are ignored; deployment also excludes local data and secrets.

## Validation

```sh
npm run check
npm test
npm run build
```

Tests require `TEST_DATABASE_URL` pointing to an isolated Postgres database whose role can create schemas. They create and remove unique test schemas and use a fake Stripe transport with real webhook-signature verification. They never call Stripe or use `DATABASE_URL`. GitHub Actions runs checks, tests, the production build, and a dependency audit against disposable Postgres.

Browser verification covers desktop/mobile booking, back navigation, payment states, cancellation, admin layout, gallery rendering, video playback, and uploads. Real Stripe test payments and Blob callbacks must also be verified on the configured Vercel test deployment before launch.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Vercel setup, migration, test/live keys, receipts, monitoring, and backup/restore procedures.

Typography uses locally served [DM Sans](https://fonts.google.com/specimen/DM+Sans), with its [SIL Open Font License](public/assets/dm-sans-OFL.txt). TikTok embeds link to [@l2cuts](https://www.tiktok.com/@l2cuts); new posts are added manually. Reviews are admin-edited, and any placeholders should remain labeled until replaced.
