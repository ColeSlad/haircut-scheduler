# Haircut scheduler

A complete starting point for a single barber: a studio landing page, online appointment scheduling, a photo and TikTok video gallery, and an email/password-protected admin workspace for up to two admins. Clients book without an account.

The header, browser icon, and loading screen use the supplied **L2 Cuts** logo in `public/assets/l2cuts-logo.png`. Business details, haircut price and duration, hours, and location are editable in admin. Replace the defaults before taking real bookings.

## Run locally

Requires **Node.js 24 or newer**. There are no external dependencies to install.

```sh
cp .env.example .env
npm run admin:create
npm run dev
```

Open **http://localhost:3000**. If file watching is unavailable on your system, use `npm start` instead. Use `localhost`, rather than `127.0.0.1`, to match the default `APP_ORIGIN`.

Admin sign-in uses an email address and password. Run `npm run admin:create` once for each admin (up to two). Password entry is hidden and passwords must be 12–256 characters. Both accounts have full access to the same single-barber calendar and management settings. Clients book without accounts.

A new email adds an admin; entering an existing email resets only that account’s password and signs out that admin’s sessions. The other admin keeps access. Existing email/password credentials are preserved when upgrading. There is no public admin registration or default password, and no SMS provider or external credentials are needed for admin sign-in.

## What’s included

- **Landing page** (`/`): a short introduction, haircut price/duration, booking button, gallery link, editable reviews beside the introduction, and local haircut videos with playback controls.
- **Booking** (`/schedule`): choose an available date/time, then enter your first name, last name, and phone number. No email address or notes are collected. Prices are in USD, with payment at the appointment.
- **Confirmation** (`/booking#private-token`): appointment details, a private cancellation link, and an `.ics` calendar download. The token stays in the URL fragment rather than server access logs.
- **Gallery** (`/gallery`): playable TikTok videos from [@l2cuts](https://www.tiktok.com/@l2cuts) and the same local haircut clips shown on the homepage, with responsive layouts.
- **Admin** (`/admin`): appointment search and status updates, weekly hours, full days off, haircut price/duration edits, reviews, photo uploads, TikTok video links/titles, and studio details.

Appointments, admin accounts, sessions, settings, reviews, and homepage video metadata persist in SQLite. Gallery uploads and homepage video files persist on disk. Booking validation and conflict checks run in an immediate database transaction so two clients cannot reserve overlapping time for the same barber.

Reviews start with a 4.99/5 display score and three labeled five-star placeholders. Edit names, text, stars, placeholder labels, and the overall score in **Admin → Reviews**. The overall score is set separately from individual ratings. Removing every review hides the section. Placeholder content is seeded once and does not overwrite later edits.

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

Passwords use salted scrypt hashes. Admin sessions use random tokens stored as hashes, with HttpOnly/SameSite cookies and a 12-hour expiry. Sessions are bound to the individual admin account and its current password. The server enforces request limits, same-origin writes, input validation, and security headers. Uploaded images are limited to JPEG/PNG/WebP and 5 MB. SVG and executable uploads are rejected.

## Scope

Client confirmation emails/texts, payment processing, external calendar synchronization, and self-service rescheduling are not configured. The confirmation screen explicitly tells clients to save their private management link; no confirmation email is promised. Calendar download works without a calendar integration. Appointment status changes do not send messages.

The TikTok gallery starts with three public videos from @l2cuts. Add or remove full video URLs in the admin’s TikTok videos tab. Videos use TikTok’s embedded player and require TikTok to be available; each card also links to the original video. New TikTok posts are added manually rather than automatically synced.

The homepage and gallery share local MP4 clips and JPEG posters in ignored `data/uploads/`, with titles and ordering in the `home_videos` database table. They load on demand and do not autoplay. Include these runtime files and the database when moving the app to another server; personal media is not committed to Git.

The app bundles [DM Sans](https://fonts.google.com/specimen/DM+Sans) for its typography. The font is served locally, with its [SIL Open Font License](public/assets/dm-sans-OFL.txt) included.

Saved photos and labeled samples remain available in admin. The public gallery displays videos in place of the former Photos section.

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

Browser verification should cover desktop and mobile layouts, the full booking/confirmation flow, homepage and gallery video playback, both admin email/password logins and independent logout, a days-off change, a photo upload, and cancellation. Automated API tests do not replace those browser checks.
