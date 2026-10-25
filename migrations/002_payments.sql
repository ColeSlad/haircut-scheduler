ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'legacy_unpaid'
  CHECK(payment_status IN ('unpaid', 'paid', 'partially_refunded', 'refunded', 'legacy_unpaid'));
ALTER TABLE bookings ADD COLUMN checkout_session_id TEXT UNIQUE;
ALTER TABLE bookings ADD COLUMN payment_intent_id TEXT UNIQUE;
ALTER TABLE bookings ADD COLUMN checkout_url TEXT;
ALTER TABLE bookings ADD COLUMN hold_expires_at BIGINT;
ALTER TABLE bookings ADD COLUMN checkout_params TEXT;
ALTER TABLE bookings ADD COLUMN request_hash TEXT UNIQUE;
ALTER TABLE bookings ADD COLUMN request_fingerprint TEXT;
ALTER TABLE bookings ADD COLUMN amount_refunded INTEGER NOT NULL DEFAULT 0 CHECK(amount_refunded >= 0);
CREATE INDEX pending_payment_holds ON bookings(hold_expires_at) WHERE status = 'pending';
CREATE TABLE stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed_at BIGINT NOT NULL);
