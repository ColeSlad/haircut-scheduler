import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, publicData, defaults } from '../server/legacy-store.js';
import { createBooking, availableSlots } from '../server/scheduling.js';
import { DatabaseSync } from 'node:sqlite';

test('existing service menus migrate once without changing bookings or haircut pricing', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = legacyStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = Date.parse('2026-10-26T12:00:00Z');
  const booking = (await createBooking(db, { date: '2026-10-27', time: '09:00', firstName: 'Sam', lastName: 'Example', phone: '555-123-4567' }, now));
  (await db.prepare("UPDATE bookings SET service_id = 'signature-cut', service_name = 'The signature cut' WHERE id = ?").run(booking.id));
  const original = (await db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id));
  db.exec("DELETE FROM services; PRAGMA user_version = 0;");
  const insert = db.prepare('INSERT INTO services VALUES (?, ?, ?, ?, ?, 1, ?)');
  insert.run('signature-cut', 'The signature cut', 'Existing haircut', 60, 5200, 0);
  insert.run('cut-and-beard', 'Cut + beard', 'Existing alternative', 90, 7000, 1);
  db.close();

  db = legacyStore(file);
  const [haircut] = (await publicData(db)).services;
  assert.equal((await publicData(db)).services.length, 1);
  assert.equal(haircut.id, 'haircut');
  assert.equal(haircut.name, 'Haircut');
  assert.equal(haircut.duration, 60);
  assert.equal(haircut.price, 5200);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM services WHERE id <> 'haircut' AND active = 1").get()).n, 0);
  assert.deepEqual((await db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id)), original);
  assert(!(await availableSlots(db, original.date, 'haircut', now)).some((slot) => slot.time === '09:00'));
  assert((await availableSlots(db, original.date, 'haircut', now)).some((slot) => slot.time === '09:45'));
  (await db.prepare("UPDATE services SET price = 6100 WHERE id = 'haircut'").run());
  db.close();

  db = legacyStore(file);
  assert.equal((await publicData(db)).services[0].price, 6100);
  assert.deepEqual((await db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id)), original);
});

test('TikTok videos are seeded once and admin removal survives reopening', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-video-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = legacyStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await publicData(db)).videos.length, 3);
  db.exec('DELETE FROM videos');
  db.close();
  db = legacyStore(file);
  assert.deepEqual((await publicData(db)).videos, []);
});

test('placeholder reviews are seeded once and admin edits or removal survive reopening', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-review-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = legacyStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const saved = { rating: 4.8, items: [{ id: 'custom-review', name: 'Sam Example', text: 'Custom review.', stars: 5, sample: false }] };
  (await db.prepare('UPDATE review_content SET value = ? WHERE id = 1').run(JSON.stringify(saved)));
  db.close();
  db = legacyStore(file);
  assert.deepEqual((await publicData(db)).reviews, saved);
  (await db.prepare('UPDATE review_content SET value = ? WHERE id = 1').run(JSON.stringify({ rating: 5, items: [] })));
  db.close();
  db = legacyStore(file);
  assert.deepEqual((await publicData(db)).reviews, { rating: 5, items: [] });
});

test('old session tables migrate without changing an existing admin account', async (t) => {
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
  const db = legacyStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await db.prepare('SELECT password_hash FROM admin WHERE id = 1').get()).password_hash, 'existing-password-hash');
  assert.equal((await db.prepare('SELECT auth_key FROM sessions').get()).auth_key, '');
  assert((await db.prepare('PRAGMA table_info(sessions)').all()).some((column) => column.name === 'auth_key'));
  (await db.prepare('INSERT INTO admin VALUES (2, ?, ?)').run('second@example.com', 'second-password-hash'));
  assert.equal((await db.prepare('SELECT count(*) AS count FROM admin').get()).count, 2);
  await assert.rejects(async () => (await db.prepare('INSERT INTO admin VALUES (3, ?, ?)').run('third@example.com', 'third-password-hash')));
  assert.equal((await db.prepare('SELECT count(*) AS count FROM admin_code_requests').get()).count, 1);
});


test('starter copy cleanup preserves custom business text and photo captions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'haircut-copy-migration-'));
  const file = join(directory, 'scheduler.sqlite');
  let db = legacyStore(file);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const legacyDescription = 'A little time for yourself. A cut that feels like you. Book your next appointment, settle into the chair, and leave feeling good.';
  const config = { ...defaults, tagline: 'Good hair. Good company.', description: legacyDescription, location: '123 Main Street', bookingNotice: 'Cash only.' };
  (await db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config)));
  (await db.prepare('UPDATE gallery SET title = ? WHERE id = ?').run('Clean lines, easy days', 'sample-1'));
  (await db.prepare('UPDATE gallery SET title = ? WHERE id = ?').run('My custom caption', 'sample-2'));
  (await db.prepare('UPDATE gallery SET title = ?, sample = 0 WHERE id = ?').run('The finishing touch', 'sample-3'));
  db.exec('PRAGMA user_version = 3');
  db.close();

  db = legacyStore(file);
  const data = (await publicData(db));
  assert.equal(data.settings.tagline, defaults.tagline);
  assert.equal(data.settings.description, defaults.description);
  assert.equal(data.settings.location, '123 Main Street');
  assert.equal(data.settings.bookingNotice, 'Cash only.');
  assert.deepEqual(data.gallery.map((photo) => photo.title), ['Short haircut', 'My custom caption', 'The finishing touch']);
  config.description = 'Appointments at 123 Main Street.';
  (await db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(config)));
  (await db.prepare('UPDATE gallery SET title = ? WHERE id = ?').run('Clean lines, easy days', 'sample-1'));
  db.close();

  db = legacyStore(file);
  assert.equal((await publicData(db)).settings.description, config.description);
  assert.equal((await publicData(db)).settings.tagline, config.tagline);
  assert.equal((await publicData(db)).gallery[0].title, 'Clean lines, easy days');
});

function legacyStore(file) {
 const db = openStore(file);
 db.transaction = async (work) => { db.exec('BEGIN IMMEDIATE'); try { const result = await work(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
 return db;
}
