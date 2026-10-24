import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, publicData, defaults } from '../server/store.js';
import { createBooking, availableSlots } from '../server/scheduling.js';
import { DatabaseSync } from 'node:sqlite';

test('existing service menus migrate once without changing bookings or haircut pricing', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = openStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = Date.parse('2026-10-26T12:00:00Z');
  const booking = createBooking(db, { date: '2026-10-27', time: '09:00', firstName: 'Sam', lastName: 'Example', phone: '555-123-4567' }, now);
  db.prepare("UPDATE bookings SET service_id = 'signature-cut', service_name = 'The signature cut' WHERE id = ?").run(booking.id);
  const original = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  db.exec("DELETE FROM services; PRAGMA user_version = 0;");
  const insert = db.prepare('INSERT INTO services VALUES (?, ?, ?, ?, ?, 1, ?)');
  insert.run('signature-cut', 'The signature cut', 'Existing haircut', 60, 5200, 0);
  insert.run('cut-and-beard', 'Cut + beard', 'Existing alternative', 90, 7000, 1);
  db.close();

  db = openStore(file);
  const [haircut] = publicData(db).services;
  assert.equal(publicData(db).services.length, 1);
  assert.equal(haircut.id, 'haircut');
  assert.equal(haircut.name, 'Haircut');
  assert.equal(haircut.duration, 60);
  assert.equal(haircut.price, 5200);
  assert.equal(db.prepare("SELECT count(*) AS n FROM services WHERE id <> 'haircut' AND active = 1").get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id), original);
  assert(!availableSlots(db, original.date, 'haircut', now).some((slot) => slot.time === '09:00'));
  assert(availableSlots(db, original.date, 'haircut', now).some((slot) => slot.time === '09:45'));
  db.prepare("UPDATE services SET price = 6100 WHERE id = 'haircut'").run();
  db.close();

  db = openStore(file);
  assert.equal(publicData(db).services[0].price, 6100);
  assert.deepEqual(db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id), original);
});

test('TikTok videos are seeded once and admin removal survives reopening', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-video-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = openStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(publicData(db).videos.length, 3);
  db.exec('DELETE FROM videos');
  db.close();
  db = openStore(file);
  assert.deepEqual(publicData(db).videos, []);
});

test('old session tables migrate without changing an existing admin account', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-auth-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id = 1), email TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE admin_code_requests (id INTEGER PRIMARY KEY, requested_at INTEGER NOT NULL);`);
  old.prepare('INSERT INTO admin VALUES (1, ?, ?)').run('existing@example.com', 'existing-password-hash');
  old.prepare('INSERT INTO sessions VALUES (?, ?)').run('old-session-hash', Date.now() + 60000);
  old.prepare('INSERT INTO admin_code_requests (requested_at) VALUES (?)').run(Date.now());
  old.close();
  const db = openStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(db.prepare('SELECT password_hash FROM admin WHERE id = 1').get().password_hash, 'existing-password-hash');
  assert.equal(db.prepare('SELECT auth_key FROM sessions').get().auth_key, '');
  assert(db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'auth_key'));
  db.prepare('INSERT INTO admin VALUES (2, ?, ?)').run('second@example.com', 'second-password-hash');
  assert.equal(db.prepare('SELECT count(*) AS count FROM admin').get().count, 2);
  assert.throws(() => db.prepare('INSERT INTO admin VALUES (3, ?, ?)').run('third@example.com', 'third-password-hash'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM admin_code_requests').get().count, 1);
});


test('starter copy cleanup preserves custom business text and photo captions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-copy-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = openStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const legacyDescription = 'A little time for yourself. A cut that feels like you. Book your next appointment, settle into the chair, and leave feeling good.';
  const config = { ...defaults, tagline: 'Good hair. Good company.', description: legacyDescription, location: '123 Main Street', bookingNotice: 'Cash only.' };
  db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config));
  db.prepare('UPDATE gallery SET title = ? WHERE id = ?').run('Clean lines, easy days', 'sample-1');
  db.prepare('UPDATE gallery SET title = ? WHERE id = ?').run('My custom caption', 'sample-2');
  db.prepare('UPDATE gallery SET title = ?, sample = 0 WHERE id = ?').run('The finishing touch', 'sample-3');
  db.exec('PRAGMA user_version = 3');
  db.close();

  db = openStore(file);
  const data = publicData(db);
  assert.equal(data.settings.tagline, defaults.tagline);
  assert.equal(data.settings.description, defaults.description);
  assert.equal(data.settings.location, '123 Main Street');
  assert.equal(data.settings.bookingNotice, 'Cash only.');
  assert.deepEqual(data.gallery.map((photo) => photo.title), ['Short haircut', 'My custom caption', 'The finishing touch']);
  config.description = 'Appointments at 123 Main Street.';
  db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config));
  db.prepare('UPDATE gallery SET title = ? WHERE id = ?').run('Clean lines, easy days', 'sample-1');
  db.close();

  db = openStore(file);
  assert.equal(publicData(db).settings.description, config.description);
  assert.equal(publicData(db).settings.tagline, config.tagline);
  assert.equal(publicData(db).gallery[0].title, 'Clean lines, easy days');
});
