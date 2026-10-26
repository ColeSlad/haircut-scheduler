# L2 Cuts

A single-barber booking site with guest checkout and up to two email/password admins. The simple homepage, reviews, supplied logo, and videos are preserved.

Clients choose a time, enter first name, last name, and phone, and choose **Pay now** or **Pay in person at the cut**. In-person bookings confirm immediately, with payment due at the appointment. Pay now uses Stripe-hosted Checkout and confirms only after the server verifies payment; Stripe collects an email for the payment receipt. Until Stripe is configured, Pay now is disabled and in-person booking remains available. Clients save their private appointment link to view, download a calendar event, or cancel. Client booking emails/texts, external calendar sync, and self-service rescheduling are not included.

Admin manages appointments, the haircut price/duration, weekly hours, days off, business details, reviews, photos, and TikTok links. Payment method and status appear beside appointments. Admin can mark an in-person payment received without changing the appointment status. Cancelling releases the time; online-payment refunds are handled separately in the Stripe Dashboard.

Anyone can post a name, 1–5 star rating, and review on **/reviews**, without an account. Reviews publish immediately. **Admin → Reviews** lets you edit reviews, hide/unhide them, and toggle up to three for the homepage. New submissions are not selected for the homepage automatically. The displayed score is calculated from all published reviews, excluding labeled placeholders. Public submissions are limited to five per hour per IP, validated on the server, and protected against duplicate retries. Review lists paginate in groups of 20; admin saves preserve submissions made while the editor is open and reject stale edits.

**Admin → Notifications** controls private barber SMS alerts. When Twilio is connected and alerts are enabled, confirmed bookings and cancellations text the barber the client name/phone, haircut, local date/time, duration, price, and payment status. The recipient is separate from the public contact phone. The panel includes a test text and delivery history. SMS is disabled by default and needs provider setup described in [DEPLOYMENT.md](DEPLOYMENT.md#6-barber-text-notifications); no provider keys go in the browser or Git.

An Accepted SMS is still awaiting delivery confirmation. **Refresh status** checks up to three pending messages directly with Twilio and recovers delivery/failure results if a signed callback was missed, without sending another text. Error 30034 means the US local sender needs approved A2P 10DLC registration and linkage to the registered Messaging Service. Buying a number and upgrading the account alone do not complete sender registration.

## Local setup

Use **Node.js 24**, npm, and PostgreSQL 14 or newer. Production uses Neon Postgres and public Vercel Blob. SQLite is retained only for importing the previous installation.

```sh
npm ci
cp .env.example .env
createdb haircut
createdb haircut_test
```

Set `DATABASE_URL` and `TEST_DATABASE_URL` to those separate local databases. Generate independent `APP_SECRET` and `CRON_SECRET` values with `openssl rand -hex 32`. In-person booking works without Stripe. Add Stripe **test** keys to enable Pay now and a test Blob store to enable uploads.

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

If your production database URL is hidden as a Vercel Secret, run `npm run admin:create -- --print-sql` instead. It prompts for the new admin's email and a hidden, confirmed password, then prints SQL using the app's salted scrypt hash. It does not open a database connection or need production credentials. Paste only the generated SQL into the authenticated production database **Query** editor, switch off **Read-only**, and click **Run**; restore Read-only afterward. A returned ID/email confirms creation. Zero rows means that email already exists or both slots are occupied. This mode only fills an unused slot: it never resets or replaces an account. Keep the generated SQL private because it contains a password hash. See [the production setup steps](DEPLOYMENT.md#adding-a-second-admin-without-copying-database-credentials).

## Booking and payment rules

Haircut is the only service. New installations default to 45 minutes and $40; migration preserves your current price and duration. Admin can set a price from $0.50 to $1,000. Prices are USD. Clients can pay the full price in person or through Stripe with cards and eligible wallets. No tips, subscriptions, or automatic tax calculation are configured.

In-person bookings confirm in the server's availability transaction, remain marked unpaid until an admin records collection, and never create a Stripe session or expiring payment hold. Both payment choices use the same overlap protection, contact validation, rate limits, and private management links. Retries with the same request ID cannot create duplicate appointments or switch an existing online checkout to in-person payment.

The studio time zone drives availability, including daylight-saving changes. Starts are offered every 15 minutes, must fit within working hours, and respect days off, minimum notice, and the booking horizon. Service edits affect new reservations; existing ones retain their booked price and duration. Hours changes do not silently cancel appointments. Upcoming paid appointments or pending checkouts prevent a time-zone change.

Online checkout reserves a slot for 31 minutes. All appointments require at least 32 minutes of notice so the same available times work for either payment choice, even if an imported configuration used less notice. Pending and confirmed bookings cannot overlap, enforced by both a database transaction and a Postgres exclusion constraint. A pending online hold is released only when Stripe verifies expiry/cancellation, never just because a local timer elapsed. Stripe webhooks normally release expired sessions. Availability reads and new booking attempts recheck overdue holds for the requested date, with short provider timeouts and a shared one-minute retry lease. Failed checks keep the hold reserved. A bounded daily cleanup job provides additional recovery, so no frequent Vercel cron is required. Webhook processing and checkout retries are idempotent.

Clients can cancel before the appointment starts. Cancellation does **not** automatically refund a payment. Admin issues full or partial refunds in Stripe; signed webhooks synchronize the refunded amount without changing appointment status. Stripe payment receipts require the receipt setting described in the deployment guide. No appointment confirmation email is promised.

The private link uses `/booking#token`. Requests send its credential in an authorization header, keeping it out of access-log paths. Anyone with that link can manage the appointment; keep it private. Stripe receives only an opaque booking ID in metadata and return URLs. Returning from Checkout requires the browser's short-lived secure cookie, so use the same browser to complete checkout and save the resulting link.

## Vercel Hobby compatibility

The deployment uses one Node.js function in one region, a 60-second function limit, and one daily cleanup job (`0 8 * * *`, approximately 08:00 UTC). Booking availability does not depend on the daily job: signed Stripe webhooks and on-demand server checks handle expired payment holds. Automated tests guard the Hobby deployment limits.

This is technical compatibility, not a commercial-use exemption. [Vercel reserves Hobby for personal, non-commercial projects](https://vercel.com/docs/plans/hobby). Use Stripe test mode for a Hobby demo; a live paid barber business must use hosting permitted by the provider's terms. Neon Free and Vercel Blob's included Hobby allowance can support a small demo within their quotas; the app does not require a paid Neon plan.

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

Browser verification covers desktop/mobile booking, back navigation, payment states, cancellation, admin layout, gallery rendering, video playback, uploads, anonymous review submission, review pagination, homepage selections, visibility, and empty states. Real Stripe test payments and Blob callbacks must also be verified on the configured Vercel test deployment before launch.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Vercel setup, migration, test/live keys, receipts, monitoring, and backup/restore procedures.

Typography uses locally served [DM Sans](https://fonts.google.com/specimen/DM+Sans), with its [SIL Open Font License](public/assets/dm-sans-OFL.txt). TikTok embeds link to [@l2cuts](https://www.tiktok.com/@l2cuts); new posts are added manually. Any placeholder reviews should remain labeled until replaced.
