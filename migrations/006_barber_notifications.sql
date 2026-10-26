CREATE TABLE barber_notification_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  phone TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
);
INSERT INTO barber_notification_settings (id) VALUES (1);
CREATE TABLE sms_notifications (
  id TEXT PRIMARY KEY,
  booking_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('confirmed', 'cancelled', 'test')),
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'cancelled')),
  attempt_id TEXT NOT NULL UNIQUE,
  provider_sid TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at BIGINT NOT NULL,
  attempted_at BIGINT,
  updated_at BIGINT NOT NULL,
  UNIQUE(booking_id, kind)
);
CREATE INDEX sms_queued ON sms_notifications(created_at) WHERE state = 'queued';
