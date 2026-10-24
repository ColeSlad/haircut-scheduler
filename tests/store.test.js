import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, publicData } from '../server/store.js';
import { createBooking, availableSlots } from '../server/scheduling.js';

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
