import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const defaults = {
  name: 'goodform.',
  tagline: 'Haircut appointments',
  description: 'Book a haircut online.',
  location: 'Location not set',
  address: '',
  timezone: 'America/New_York',
  email: '',
  phone: '',
  instagram: '',
  bookingNotice: 'Please arrive on time. To cancel, use your private appointment link.',
  leadMinutes: 60,
  bookingDays: 60,
};

export function openStore(file = resolve(process.env.DATA_DIR || 'data', 'scheduler.sqlite')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      duration INTEGER NOT NULL, price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hours (day INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS days_off (date TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, service_id TEXT NOT NULL, service_name TEXT NOT NULL, duration INTEGER NOT NULL,
      price INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, notes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed', token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS booking_times ON bookings(starts_at, ends_at, status);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 2), email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, auth_key TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS gallery (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, image TEXT NOT NULL,
      alt TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS home_videos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, video TEXT NOT NULL UNIQUE,
      poster TEXT NOT NULL, position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_content (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO review_content VALUES (1, ?)').run(JSON.stringify({
    rating: 4.99,
    items: [
      { id: 'sample-review-1', name: 'Sample customer 1', text: 'Great haircut. Would book again.', stars: 5, sample: true },
      { id: 'sample-review-2', name: 'Sample customer 2', text: 'Easy booking and a clean cut.', stars: 5, sample: true },
      { id: 'sample-review-3', name: 'Sample customer 3', text: 'Really happy with the haircut.', stars: 5, sample: true },
    ],
  }));
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'auth_key')) {
    db.exec("ALTER TABLE sessions ADD COLUMN auth_key TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('SELECT id FROM settings').get()) {
    db.prepare('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify(defaults));
    const insert = db.prepare('INSERT INTO services VALUES (?, ?, ?, ?, ?, 1, ?)');
    insert.run('haircut', 'Haircut', 'A haircut.', 45, 4000, 0);
    const hours = db.prepare('INSERT INTO hours VALUES (?, ?, ?, ?)');
    for (let day = 0; day < 7; day++) hours.run(day, day > 1 ? 1 : 0, '09:00', day === 6 ? '16:00' : '18:00');
    const gallery = db.prepare('INSERT INTO gallery VALUES (?, ?, ?, ?, ?, 1, ?)');
    gallery.run('sample-1', 'Short haircut', 'Short cuts', '/assets/cut-1.jpg', 'Sample haircut inspiration: a short textured haircut', 0);
    gallery.run('sample-2', 'Textured haircut', 'Texture', '/assets/cut-2.jpg', 'Sample haircut inspiration: textured hair and a natural finish', 1);
    gallery.run('sample-3', 'Beard trim', 'Beards', '/assets/cut-3.jpg', 'Sample inspiration: a carefully shaped beard', 2);
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Keep the existing haircut price/duration and historical service snapshots.
      const previous = db.prepare("SELECT * FROM services ORDER BY CASE id WHEN 'haircut' THEN 0 WHEN 'signature-cut' THEN 1 ELSE 2 END, active DESC, position LIMIT 1").get();
      db.prepare("INSERT OR IGNORE INTO services VALUES ('haircut', 'Haircut', 'A haircut.', ?, ?, 1, 0)").run(previous?.duration || 45, previous?.price ?? 4000);
      db.exec("UPDATE services SET active = 0 WHERE id <> 'haircut'; PRAGMA user_version = 1;");
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO videos VALUES (?, ?, ?, ?)');
      ['7698458409233878285', '7698090850827390221', '7696960651863936269'].forEach((id, position) => {
        insert.run(`tiktok-${id}`, `TikTok video ${position + 1}`, `https://www.tiktok.com/@l2cuts/video/${id}`, position);
      });
      db.exec('PRAGMA user_version = 2; COMMIT;');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE admin RENAME TO admin_previous;
        CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 2), email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL);
        INSERT INTO admin SELECT id, email, password_hash FROM admin_previous;
        DROP TABLE admin_previous;
        PRAGMA user_version = 3;
        COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Replace only untouched starter copy; preserve all admin edits.
      const config = settings(db);
      const previous = {
        tagline: 'Good hair. Good company.',
        description: 'A little time for yourself. A cut that feels like you. Book your next appointment, settle into the chair, and leave feeling good.',
        location: 'Your neighborhood studio',
        bookingNotice: 'Please arrive on time. Need to change your plans? Use the private link in your confirmation.',
      };
      for (const [key, value] of Object.entries(previous)) if (config[key] === value) config[key] = defaults[key];
      db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config));
      const rename = db.prepare('UPDATE gallery SET title = ? WHERE id = ? AND title = ? AND sample = 1 AND image = ?');
      [
        ['Short haircut', 'sample-1', 'Clean lines, easy days', '/assets/cut-1.jpg'],
        ['Textured haircut', 'sample-2', 'A little texture', '/assets/cut-2.jpg'],
        ['Beard trim', 'sample-3', 'The finishing touch', '/assets/cut-3.jpg'],
      ].forEach((row) => rename.run(...row));
      db.exec('PRAGMA user_version = 4; COMMIT;');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  return db;
}

export function settings(db) {
  return JSON.parse(db.prepare('SELECT value FROM settings WHERE id = 1').get().value);
}

export function publicData(db) {
  return {
    settings: settings(db),
    services: db.prepare("SELECT * FROM services WHERE id = 'haircut' AND active = 1").all(),
    hours: db.prepare('SELECT * FROM hours ORDER BY day').all(),
    gallery: db.prepare('SELECT * FROM gallery ORDER BY position').all(),
    videos: db.prepare('SELECT * FROM videos ORDER BY position').all(),
    homeVideos: db.prepare('SELECT * FROM home_videos ORDER BY position').all(),
    reviews: JSON.parse(db.prepare('SELECT value FROM review_content WHERE id = 1').get().value),
  };
}
