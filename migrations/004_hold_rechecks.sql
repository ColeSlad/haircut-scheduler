ALTER TABLE bookings ADD COLUMN reconcile_after BIGINT NOT NULL DEFAULT 0;
CREATE INDEX pending_hold_rechecks ON bookings(reconcile_after, hold_expires_at) WHERE status = 'pending';
