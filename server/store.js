import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const defaults = {
  name: 'goodform.',
  tagline: 'Good hair. Good company.',
  description: 'A little time for yourself. A cut that feels like you. Book your next appointment, settle into the chair, and leave feeling good.',
  location: 'Your neighborhood studio',
  address: '',
  timezone: 'America/New_York',
  email: '',
  phone: '',
  instagram: '',
  bookingNotice: 'Please arrive on time. Need to change your plans? Use the private link in your confirmation.',
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
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id = 1), email TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gallery (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, image TEXT NOT NULL,
      alt TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL
    );
  `);
  if (!db.prepare('SELECT id FROM settings').get()) {
    db.prepare('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify(defaults));
    const insert = db.prepare('INSERT INTO services VALUES (?, ?, ?, ?, ?, 1, ?)');
    insert.run('signature-cut', 'The signature cut', 'A consultation, a thoughtful cut, and a style to finish. All you, just a little sharper.', 45, 4000, 0);
    insert.run('cut-and-beard', 'Cut + beard', 'The full refresh. A tailored haircut with a beard shape-up and clean edges.', 60, 5500, 1);
    insert.run('beard-tidy', 'The beard tidy', 'A little maintenance goes a long way. Shape, trim, and a clean finish.', 30, 2000, 2);
    const hours = db.prepare('INSERT INTO hours VALUES (?, ?, ?, ?)');
    for (let day = 0; day < 7; day++) hours.run(day, day > 1 ? 1 : 0, '09:00', day === 6 ? '16:00' : '18:00');
    const gallery = db.prepare('INSERT INTO gallery VALUES (?, ?, ?, ?, ?, 1, ?)');
    gallery.run('sample-1', 'Clean lines, easy days', 'Short cuts', '/assets/cut-1.jpg', 'Sample haircut inspiration: a short textured haircut', 0);
    gallery.run('sample-2', 'A little texture', 'Texture', '/assets/cut-2.jpg', 'Sample haircut inspiration: textured hair and a natural finish', 1);
    gallery.run('sample-3', 'The finishing touch', 'Beards', '/assets/cut-3.jpg', 'Sample inspiration: a carefully shaped beard', 2);
  }
  return db;
}

export function settings(db) {
  return JSON.parse(db.prepare('SELECT value FROM settings WHERE id = 1').get().value);
}

export function publicData(db) {
  return {
    settings: settings(db),
    services: db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY position').all(),
    hours: db.prepare('SELECT * FROM hours ORDER BY day').all(),
    gallery: db.prepare('SELECT * FROM gallery ORDER BY position').all(),
  };
}
