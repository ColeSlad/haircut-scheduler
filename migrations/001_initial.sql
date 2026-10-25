CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
CREATE TABLE services (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  duration INTEGER NOT NULL CHECK(duration > 0), price INTEGER NOT NULL CHECK(price >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)), position INTEGER NOT NULL
);
CREATE TABLE hours (day INTEGER PRIMARY KEY CHECK(day BETWEEN 0 AND 6), enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), start TEXT NOT NULL, "end" TEXT NOT NULL);
CREATE TABLE days_off (date TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
CREATE TABLE bookings (
  id TEXT PRIMARY KEY, service_id TEXT NOT NULL, service_name TEXT NOT NULL, duration INTEGER NOT NULL,
  price INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending', 'confirmed', 'cancelled', 'expired', 'completed', 'no-show')),
  token_hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL,
  CHECK(ends_at > starts_at),
  EXCLUDE USING gist (int8range(starts_at, ends_at, '[)') WITH &&) WHERE (status IN ('pending', 'confirmed'))
);
CREATE INDEX booking_times ON bookings(starts_at, ends_at, status);
CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 2), email TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE UNIQUE INDEX admin_email ON admin(lower(email));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL, auth_key TEXT NOT NULL);
CREATE TABLE gallery (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, image TEXT NOT NULL, alt TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL);
CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, position INTEGER NOT NULL);
CREATE TABLE home_videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, video TEXT NOT NULL UNIQUE, poster TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE review_content (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
