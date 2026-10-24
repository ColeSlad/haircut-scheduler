# Project instructions

- Make Git commits very frequently, more often than typical. Commit small, logical checkpoints as work progresses; do not batch an entire feature into one commit.
- Keep this app focused on scheduling for one barber. Clients should not need accounts to book.
- Keep bookings and admin access enforced on the server. Never replace real availability or authentication with browser-only state.
- Do not commit `.env`, runtime databases, uploaded photos, private booking links, or credentials.
- Run `npm run check` for JavaScript changes and `npm test` for booking, API, or authentication changes.
