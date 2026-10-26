# Deploy L2 Cuts

## Launch checkpoint — October 26, 2026

The [l2cuts Vercel project](https://vercel.com/cole-sladowskys-projects/l2cuts) is linked to `main` and deployed on Hobby. The site loads at [www.l2cuts.com](https://www.l2cuts.com), and the apex redirects there with HTTPS. Production has its Neon database, server secrets, app origin, and public media origin configured. Clients can book with payment due in person. Pay now remains disabled until Stripe is configured.

Verified locally: 93 backend tests on Node.js 24, the production build, a clean production dependency audit, an isolated Postgres dump/restore, and Chrome checks for booking/back navigation, mobile calendar controls, payment choices with and without Stripe configuration, in-person confirmation/cancellation, admin payment recording, private notification settings with simulated delivery, mobile notification controls, admin layout, video playback, and an empty gallery. Review checks include guest posting, literal-text escaping, pagination, the three-homepage-review limit, selection changes, hiding, empty states, and posting at 320 px without horizontal overflow. Browser mutations used isolated test schemas. GitHub CI also validates against Postgres 17. Stripe and Twilio transports are simulated in automated tests; real Stripe test payments, a real barber test text, and Blob provider callbacks still require the configured cloud resources.

Neon `l2cuts` uses the Free plan in `iad1` and is connected to Production only. The legacy import and all seven schema migrations completed. Migration `005_payment_choice.sql` adds the payment method without changing existing appointments. Migration `007_public_reviews.sql` preserves all three original reviews and their homepage order in a dedicated table; a read-only comparison confirmed their IDs, text, names, stars, and placeholder labels are unchanged. Both migrations and checksums were registered through the authenticated SQL editor without exporting database credentials. Imported counts: one settings row, four service records (one public haircut), seven hours rows, one admin, three TikTok links, five homepage videos, and one legacy reviews record; no appointments were present. The existing admin email and password hash were verified unchanged. The public `l2cuts-blob` store contains the five videos and five posters. It retains its existing Production and Preview connection; preview database and app-secret setup is not complete.

The original SQLite database and media remain untouched. A consistent private SQLite/media backup is under ignored `.backups/`, and the uploaded-media mapping is under ignored `data/`. Temporary local database/server-secret files were removed after setup. Live checks passed for `/api/health`, public content, unauthenticated session inspection, rejection of unauthenticated admin-data and cron requests, and the apex redirect. Chrome verified all five clips playing through, TikTok embeds, and mobile homepage/gallery/admin-login layout without horizontal overflow. The admin sign-in form loads; an actual password sign-in has not been exercised on this deployment.

The barber notification recipient is saved privately, with alerts switched off. The Twilio environment configuration check passes, but the connected account is on the current template-only trial; custom barber texts need an upgraded account and approved sender. No successful live SMS delivery has been verified. Still outstanding: Twilio sender setup and a real test text, Stripe API and webhook configuration, real test-mode checkout/refund verification, the app's signed Blob upload callback, and separate preview resources. Pay now is visibly disabled until payment configuration is complete. In-person bookings confirm immediately and appear in admin with payment due; admins can mark them paid after collection. No production appointments were created during verification. Do not treat this checkpoint as Stripe payment-launch approval.

## 1. Accounts and resources

Use the existing GitHub repository and create a Vercel project named `l2cuts`. Set its Node version to **24.x**, framework to **Other**, build command to `npm run build`, and output directory to `dist`; `vercel.json` supplies these build/routing settings. The production branch is `main`.

The code uses only Hobby-compatible deployment features. [Vercel's Hobby policy](https://vercel.com/docs/plans/hobby) still limits it to personal, non-commercial use; a live paid barber business needs hosting whose terms permit commercial use. For a Hobby demo, keep Stripe in test mode. The owner handles any account or billing terms; this setup does not upgrade the account. Create and activate the Stripe account, including business details, support contact, identity verification, and bank/payout setup, before enabling live payments. Never put credentials in Git or chat.

Create a Vercel-managed **Neon Postgres** integration in `iad1`/US East and a **public Vercel Blob** store. For a small demo, Neon Free is compatible; check its compute, storage and network quotas. [Neon Free retains up to six hours of restore history](https://neon.com/docs/introduction/plans); longer retention is an optional database-plan decision, independent of Vercel. [Vercel Blob is available on Hobby within its included allowance](https://vercel.com/docs/vercel-blob/usage-and-pricing). Blob contains public media only—never store database backups in the public media store.

Use separate Neon databases/branches, Blob stores, Stripe test keys, and app secrets for preview and production. Keep Vercel preview protection enabled. Enable Protection Bypass for Automation and expose its generated `VERCEL_AUTOMATION_BYPASS_SECRET` to the preview environment. Register Stripe's preview webhook with the `x-vercel-protection-bypass` query parameter, as described below; the app adds it to Blob's signed callback URL automatically. This secret stays in provider configuration and never grants app-admin access. Do not disable app authentication to test callbacks.

## 2. Environment variables

Set these in Vercel **Project → Settings → Environment Variables**, with distinct values per environment:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | `https://l2cuts.vercel.app` for the Hobby demo; `https://www.l2cuts.com` after custom-domain activation |
| `DATABASE_URL` | Neon's pooled Postgres connection URL with TLS |
| `DATABASE_URL_DIRECT` | Neon's direct connection URL, for local migration/backup tools |
| `APP_SECRET` | Independently generated random secret, at least 32 characters |
| `CRON_SECRET` | A different random secret, at least 32 characters; Vercel sends it to the cron route |
| `BLOB_READ_WRITE_TOKEN` | Token for that environment's public Blob store |
| `BLOB_PUBLIC_ORIGIN` | Exact store origin, e.g. `https://STORE.public.blob.vercel-storage.com`, no trailing slash |
| `STRIPE_SECRET_KEY` | `sk_test_…` for preview; `sk_live_…` only for production |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for that environment's webhook endpoint |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Preview only: Vercel-generated Protection Bypass for Automation secret |

Generate each random secret independently with `openssl rand -hex 32`. Keep `APP_SECRET` stable while checkouts are in progress. Core pages require `DATABASE_URL`, `APP_SECRET`, and an HTTPS origin. With Vercel system environment variables enabled, the generated production hostname can supply the origin until `APP_ORIGIN` is set. Preview uses Vercel's generated branch/deployment hostname for its browser origin and return URLs.

Stripe, Blob, and cron configuration is checked when those features are used. In-person bookings do not depend on Stripe and confirm without an online charge. Until Stripe is configured, Pay now is disabled and the server rejects requests for online payment without creating a reservation. The server never silently changes an online payment request to in-person payment. `npm run preflight` intentionally checks the complete configuration for launching Stripe payments, uploads, and cleanup; it requires Stripe even though in-person booking works without it.

Use an ignored environment file locally for migrations/imports, containing the **target** database and Blob credentials. The CLI accepts `.env`; alternatively run individual scripts using `node --env-file=YOUR_IGNORED_FILE scripts/migrate.js`. Never point the automated test URL at a live database.

## 3. Migrate existing data

Stop editing the legacy app for the cutover. Keep a consistent private backup of `data/`, including SQLite and its uploads. The importer opens SQLite read-only; it never resets admin passwords or modifies the source. Check the source counts:

```sh
npm ci
npm run db:import -- --dry-run
```

For this installation the inspected source contains one admin, no appointments, three TikTok links, five homepage videos, and edited settings/reviews. Recheck counts at cutover rather than assuming no appointments were added.

With the target database and Blob credentials loaded locally:

```sh
npm run db:migrate
npm run db:import
```

**Do not run `db:seed` before importing.** The target must be empty. Media is uploaded directly to Blob using content-addressed filenames, and database URLs are rewritten in one transaction. Counts must match before commit. Repeating a completed import is a no-op and preserves later admin edits. Password hashes and existing booking IDs/private-link hashes are retained; sessions are excluded, so admins sign in again. Historical bookings remain marked as payment not recorded and are never charged retroactively.

Alternatively, upload the legacy media through the authenticated Vercel Blob dashboard, then import using an ignored local mapping file instead of bringing the Blob read-write token onto the local machine. Put videos in `videos/`, posters in `posters/`, and photos in `photos/`. The JSON file must contain the store's exact `origin` and an `assets` object mapping each original `/uploads/FILENAME` path to its uploaded public URL. Run `npm run db:import -- --media-map=data/deployment-media.json` with the target database configured. Every local media reference needs a mapping; URLs outside the specified store or the expected folder are rejected. Keep this deployment-specific file under ignored `data/`.

Keep the original backup until the new site, videos, settings, reviews, and login have been verified. For a brand-new site without legacy data, use `db:seed` and `admin:create` instead. To add the second admin after import, run `admin:create` with the new email; do not reset the existing account just for testing.

### Adding a second admin without copying database credentials

Vercel Secret/Sensitive environment values cannot be read back after saving. Use the authenticated database Query editor and generate an insert locally:

```sh
cd /Users/colesladowsky/Desktop/Projects/haircut
npm run admin:create -- --print-sql
```

Enter the new email and a password of 12–256 characters, then confirm it. Password entry is hidden. The command never connects to a database; it prints SQL containing the app's salted scrypt password hash, without the plaintext password.

In Vercel, open **l2cuts → Storage → the Neon l2cuts database → Query**. Copy the generated statement from `WITH available_slot` through `RETURNING id, email;`, turn off **Read-only**, and run it against the production database. The returned row must show the new email. Restore Read-only, then sign in at `/admin` with the new credentials. No redeploy is needed for an account change.

The insert never overwrites or resets an existing admin. It returns zero rows if that email already exists or both admin slots are full; this is not a successful account creation. Keep the SQL/hash out of Git and chat. The generator and creation safeguards are covered by isolated Postgres tests, including preserving the existing admin and sessions, duplicate retries, capacity, and escaped input.

## 4. Stripe and test deployment

Create a webhook destination at `https://YOUR_TEST_HOST/api/stripe/webhook?x-vercel-protection-bypass=YOUR_PREVIEW_BYPASS_SECRET` in Stripe's test environment. Subscribe to:

- `checkout.session.completed`
- `checkout.session.expired`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`

Save its signing secret in the matching Vercel environment and redeploy. Webhooks verify raw-body signatures and fetch the current Stripe objects before changing booking status. In **Stripe → Customer emails**, enable successful-payment receipts. Configure your business name and support contact. Checkout collects the receipt email; the site itself still asks only for first name, last name, and phone.

Run `npm run preflight` with the deployment's environment loaded. For preview, include its `VERCEL_ENV=preview` and `VERCEL_URL` or `VERCEL_BRANCH_URL`. Then verify on the deployed site:

- Stripe test-card success, decline, and authentication-required flows; no live charge.
- Only first name, last name, and phone appear before Checkout; the price matches admin.
- Duplicate submissions/retries and competing requests cannot create duplicate or overlapping bookings.
- A pay-in-person booking confirms without contacting Stripe, shows the amount due, and can be cancelled with its private link. Admin can mark it paid after collection.
- Online checkout never confirms without verified payment. A paid return and delayed/repeated webhooks confirm once.
- Abandoned sessions release after provider-verified expiry. `/api/cron/payments` rejects requests without the configured bearer secret.
- Private links work, cancellation releases the slot, and no automatic refund occurs. Full/partial test refunds update admin without cancelling a remaining appointment.
- Both admin accounts work independently; password reset revokes only the target account's sessions.
- On an isolated test deployment, post a guest review, page through reviews, select up to three homepage reviews, and hide/unhide one. Confirm public submissions remain intact during admin saves, and stale edits are rejected. Production verification should use read-only page/API checks rather than publishing test reviews.
- All five videos play and seek, the video gallery renders, and a 5 MB photo uploads directly and can be saved. Disallowed formats fail server validation.
- Mobile booking, calendar/time controls, navigation, admin, and confirmation fit without horizontal scrolling.

Do not use real appointments for these checks. Inspect Vercel function errors and Stripe webhook delivery history, including callback accessibility through preview protection.

## 5. Live activation (hosting terms apply)

Repeat migrations/import against the production resources. Configure a separate **live-mode** webhook at `https://www.l2cuts.com/api/stripe/webhook` with the same events and its own signing secret. Complete Stripe activation, enable payment receipts, and run preflight with production environment values (`VERCEL_ENV=production`).

The domain already uses Vercel DNS. Add **www.l2cuts.com** and **l2cuts.com** to this project using the values Vercel provides. Preserve unrelated DNS records. `vercel.json` redirects the apex to `www`; verify HTTPS and redirects after the domain is attached. The generated `vercel.app` hostname is not the production booking origin.

Confirm the daily cleanup job is enabled and `/api/health` returns `{"ok":true}`. The schedule is `0 8 * * *` (08:00 UTC daily); Hobby can invoke it within that hour, so it is not used as an exact booking-expiry timer. Check home/gallery content and the existing admin login after the final deployment. Record the release commit and migration state. Require a successful test-mode end-to-end checkout before opening live bookings.

## 6. Barber text notifications

The Notifications panel is available in admin, but automatic texts start disabled with no recipient. Adding a business contact phone does not enable alerts. SMS provider credentials are server-only Vercel environment variables, while the recipient and enable switch are private admin settings.

1. Create or use a Twilio account and configure an SMS-capable sender. The [current Twilio SMS trial](https://www.twilio.com/docs/usage/trials/try-out-sms) only allows predefined message templates and verified recipients; it cannot send this app's custom test or booking-detail messages. Upgrade the account before testing these messages. Complete the sender verification/registration required by Twilio for the selected number and destination. Account activation, billing, and phone-number purchases belong to the owner; this app does not create or pay for them. [Twilio's Messages documentation](https://www.twilio.com/docs/messaging/api/message-resource) explains sender choices.
2. In Vercel Production, add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM_NUMBER` in international format or `TWILIO_MESSAGING_SERVICE_SID`. Keep the other sender variable empty if unused. Redeploy. Never send keys in chat or save them in Git.
3. In **Admin → Notifications**, save the barber's phone with its country code. Use **Send test text** and check the delivery result. Then enable **Text booking confirmations and cancellations** and save. SMS charges and sender eligibility are managed by Twilio.

In-person bookings queue an alert when their server transaction confirms. Online bookings queue one after Stripe verifies payment. Cancellations by the client or admin queue a cancellation alert. Pending checkouts, no-shows, completion updates, and manual payment recording do not send additional texts. Alerts include the client name/phone, haircut, local date/time and zone, duration, price/payment status, and the admin URL. Client private management links are excluded.

The app writes alerts in the same database transaction as the booking transition and deduplicates repeated events. It attempts delivery before finishing the booking request, with a four-second provider timeout and no automatic provider retries. SMS failures do not undo bookings. The existing daily Hobby cleanup attempts up to three queued alerts if an initial dispatch was interrupted. It does not add a frequent cron job. Disabling alerts or changing the recipient cancels queued messages; it cannot recall a message already accepted by the provider.

Twilio sends delivery reports to `/api/sms/status?attempt=…`. The app supplies this callback URL automatically and verifies it with the [official SDK's signature validator](https://www.twilio.com/docs/usage/webhooks/webhooks-security). All form parameters participate in validation. Preview uses the existing automation-bypass configuration. **Accepted by SMS provider** is distinct from **Delivered**. A definite failure can be retried from admin. An ambiguous timeout or interrupted send becomes **Delivery unconfirmed** and is not automatically resent, avoiding duplicate texts; inspect provider logs before taking further action.

Diagnostics keep positive Twilio error codes and link them to the official error documentation. If Twilio returns code zero or no usable code, request failures retain an HTTP status where available and the panel shows setup guidance. Existing zero-code failures show “Twilio returned no diagnostic code.” Raw provider exception text is not stored or displayed because it can contain private request details. Failed create responses retain their `errorCode`; later callbacks without a usable code preserve a known failure diagnostic. A delivered callback clears the failure code.

Apply `006_barber_notifications.sql` before deploying this release. No production SMS was sent during development; delivery was simulated in isolated tests. A real recipient, provider credentials, a successful test text, and owner opt-in are required before claiming live notifications work.

## 7. Monitoring, backups, and recovery

Enable Vercel error notifications and monitor Stripe's failed webhook deliveries. Application logs contain event names and opaque IDs, not customer contact details, credentials, raw payment payloads, or private management tokens. Monitor `payment_hold_reconciliation_failed`; the system keeps a reservation blocked when Stripe cannot be checked. Availability requests recheck up to three overdue holds for that date; booking submissions do the same before claiming a slot. Shared one-minute leases avoid repeated provider calls across instances. The daily job checks up to eight holds per invocation, with four-second provider timeouts and no automatic provider retries. Apply migrations through `006_barber_notifications.sql` with `db:migrate` before using this release. A rare session-creation failure unresolved for 23 hours requires matching the booking ID to the Stripe Dashboard before correcting its session reference; never force-release an ambiguous hold while payment could still complete.

Use Neon's restore history/PITR within the selected plan's retention. Free has a six-hour window, so keep additional private exports when longer recovery coverage is needed. Seven-day managed retention is an optional paid database feature, not an app or Vercel requirement. Before risky migrations, take an additional private Postgres backup using `pg_dump` with the direct database connection and a client version matching the server. Keep dumps outside Git and outside the public Blob store. Media has immutable filenames; keep the Blob store alongside the database and do not delete referenced files during a rollback.

Restore verification: restore a backup into a **new isolated database/Neon branch**, connect a protected test deployment with Stripe test keys, and compare settings, service price/duration, row counts, admin sign-in, and media playback. Do not test a restore over production. Record the successful restore date and source snapshot before launch and repeat periodically.

For rollback, stop accepting new checkout requests, reconcile outstanding Stripe sessions, and roll back to a compatible deployment without rolling back paid-booking records. Database migrations are versioned and checksummed; never edit an applied migration. Do not restore an old snapshot over newer payments or blindly replay the SQLite import. If restoring after a failure, reconcile Stripe payments/refunds created after the snapshot before reopening bookings.
