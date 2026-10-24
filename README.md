# Haircut scheduler

A complete starting point for a single barber: a studio landing page, online appointment scheduling, a photo and TikTok video gallery, and a private admin workspace with SMS sign-in. Clients book without an account.

The starter brand is **goodform.**, with an editable haircut price and duration, hours, and location. Gallery samples are clearly labeled as inspiration. Replace the defaults in the admin area before taking real bookings.

## Run locally

Requires **Node.js 24 or newer**. There are no external dependencies to install.

```sh
cp .env.example .env
npm run dev
```

Open **http://localhost:3000**. If file watching is unavailable on your system, use `npm start` instead. Use `localhost`, rather than `127.0.0.1`, to match the default `APP_ORIGIN`.

Admin SMS sign-in requires a [Twilio account and Verify service](https://www.twilio.com/docs/verify/quickstarts/node-express). In the private `.env` file, set:

```dotenv
ADMIN_PHONES=+15551234567,+15557654321
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_VERIFY_SERVICE_SID=your_verify_service_sid
```

Use one or two admin phone numbers with country codes, separated by a comma. Both admins have full access to the same single-barber calendar and management settings. Configure the Verify service for SMS and restart the app after changing these values. Trial Twilio accounts require verifying both recipient numbers before sending codes. SMS/Verify charges are handled by Twilio; this app does not create a Twilio account or purchase a number. Never put these credentials or the real admin number in source control.

Only the numbers in `ADMIN_PHONES` can receive admin sign-in codes. A third number cannot be registered. The older single-number `ADMIN_PHONE` setting remains supported when `ADMIN_PHONES` is not set. There is no public admin registration. Codes are checked by Twilio on the server, expire, and can only establish one session per challenge. The browser receives an HttpOnly challenge cookie rather than the code. Resends have a 30-second cooldown and a persistent limit of five sends per hour for each admin number; verification allows at most five attempts per challenge. Twilio also enforces its own code and attempt limits.

Existing email/password admin accounts remain usable through **Use existing email login** until all SMS settings are configured. Once SMS is configured, password sign-in is disabled, even if the SMS provider is temporarily unavailable. Adding the second admin preserves the first admin's sessions. Removing a number revokes that admin's sessions; the other admin stays signed in. Each admin has separate verification challenges and resend limits, and signing out affects only the current session. Changing the authentication method invalidates prior sessions. The legacy `npm run admin:create` command only creates/resets the temporary email/password login; it is not needed for SMS login.

## What’s included

- **Landing page** (`/`): a short introduction, booking link, haircut price, location, and hours.
- **Booking** (`/schedule`): choose an available date/time, then enter your first name, last name, and phone number. No email address or notes are collected. Prices are in USD, with payment at the appointment.
- **Confirmation** (`/booking#private-token`): appointment details, a private cancellation link, and an `.ics` calendar download. The token stays in the URL fragment rather than server access logs.
- **Gallery** (`/gallery`): playable TikTok videos from [@l2cuts](https://www.tiktok.com/@l2cuts), photo categories, sample-image labeling, and responsive layouts.
- **Admin** (`/admin`): appointment search and status updates, weekly hours, full days off, haircut price/duration edits, photo uploads, TikTok video links/titles, and studio details.

Appointments, admin accounts, sessions, and settings persist in SQLite. Gallery uploads persist on disk. Booking validation and conflict checks run in an immediate database transaction so two clients cannot reserve overlapping time for the same barber.

## Defaults and booking rules

Haircut is the only booking option, initially 45 minutes and $40. The admin can change its price and duration. Existing installations keep the previous haircut price and duration; other service options are retired without changing past or upcoming appointments. Default hours are Tuesday–Friday 9 AM–6 PM and Saturday 9 AM–4 PM, in `America/New_York`.

Starts are offered in 15-minute increments. A service must fit completely within the day’s hours. By default, clients must book at least one hour ahead and can book up to 60 days ahead. The studio time zone drives availability, independently of the server or visitor’s time zone, including daylight-saving changes.

Service edits affect new bookings. Existing bookings retain their original name, price, duration, and time. Changing hours or adding days off does not silently cancel appointments. Upcoming confirmed appointments must be cancelled before changing the studio time zone.

Clients can cancel before their appointment starts, using their private link. The admin can cancel appointments or mark finished appointments completed/no-show. A client who wants another time can cancel and rebook.

## Data and deployment

`data/` is created automatically and ignored by Git. It contains `scheduler.sqlite` (and its SQLite WAL/SHM files while running) and `uploads/`. Treat this directory as private application data. `DATA_DIR` can point to another persistent location.

Run this app as a Node.js process with a **persistent local disk**, behind an HTTPS reverse proxy. This implementation does not target static hosting or ephemeral serverless filesystems. Set:

```dotenv
HOST=0.0.0.0
PORT=3000
NODE_ENV=production
APP_ORIGIN=https://your-domain.example
DATA_DIR=/your/persistent/data
```

`APP_ORIGIN` must match the exact browser origin, with no trailing slash. It is checked for mutations and enables Secure cookies when HTTPS is used. The production server refuses an HTTP public origin. Proxy only your chosen public hostname to the application.

Back up the database and uploaded images together. For a simple consistent backup, stop the app and copy the entire data directory. Never commit runtime data or `.env`.

Legacy passwords use salted scrypt hashes. Admin sessions use random tokens stored as hashes, with HttpOnly/SameSite cookies and a 12-hour expiry. Sessions are bound to the current admin identity and sign-in method. SMS codes are never returned by the API or printed to server logs. The server enforces request limits, same-origin writes, input validation, and security headers. Uploaded images are limited to JPEG/PNG/WebP and 5 MB. SVG and executable uploads are rejected.

## Scope

Client confirmation emails/texts, payment processing, external calendar synchronization, and self-service rescheduling are not configured. Admin sign-in texts are separate and require the Twilio setup above. The confirmation screen explicitly tells clients to save their private management link; no confirmation email is promised. Calendar download works without a calendar integration. Appointment status changes do not send messages.

The TikTok gallery starts with three public videos from @l2cuts. Add or remove full video URLs in the admin’s TikTok videos tab. Videos use TikTok’s embedded player and require TikTok to be available; each card also links to the original video. New TikTok posts are added manually rather than automatically synced.

The sample photo gallery uses remote Unsplash images. A plain placeholder appears if images cannot load. Upload the barber’s own images in the admin area to replace the gallery samples.

## Project layout

```text
public/          Browser-native ES modules, styles, and local assets
server/          HTTP server, API, authentication, SQLite, scheduling
scripts/         Interactive admin setup and syntax checks
tests/           Scheduling and in-process HTTP/API regression tests
```

## Validate

```sh
npm run check
npm test
```

The automated suite covers availability and service durations, overlap prevention (including competing requests), cancellation, studio time zones/DST, authentication and session revocation, CSRF protection, admin edits, image upload restrictions, and private-data access. It runs against isolated temporary or in-memory databases without opening a network port.

Browser verification should cover desktop and mobile layouts, the full booking/confirmation flow, gallery filtering, admin phone/code login and logout (using an isolated test provider), a days-off change, a photo upload, and cancellation. Automated API tests do not replace those browser checks.
