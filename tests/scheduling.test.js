import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, settings } from '../server/store.js';
import { availableSlots, createBooking, toTimestamp, localParts, validDate, tokenHash } from '../server/scheduling.js';

const now = Date.parse('2026-10-26T12:00:00Z');
const input = { serviceId: 'haircut', date: '2026-10-27', time: '09:00', firstName: 'Sam', lastName: 'Example', phone: '555-123-4567' };
function fixture(t) { const db = openStore(':memory:'); t.after(() => db.close()); return db; }

test('a single barber offers slots within working hours and service duration', (t) => {
  const db = fixture(t);
  const slots = availableSlots(db, input.date, 'haircut', now);
  assert.equal(slots[0].time, '09:00');
  assert.equal(slots.at(-1).time, '17:15');
  db.prepare("UPDATE services SET duration = 60 WHERE id = 'haircut'").run();
  assert.equal(availableSlots(db, input.date, 'haircut', now).at(-1).time, '17:00');
});
test('closed days, days off, past dates and dates outside the booking horizon offer no slots', (t) => {
  const db = fixture(t);
  assert.deepEqual(availableSlots(db, '2026-10-26', 'haircut', now), []);
  assert.deepEqual(availableSlots(db, '2026-10-25', 'haircut', now), []);
  assert.deepEqual(availableSlots(db, '2027-01-05', 'haircut', now), []);
  db.prepare('INSERT INTO days_off VALUES (?, ?)').run(input.date, 'Holiday');
  assert.deepEqual(availableSlots(db, input.date, 'haircut', now), []);
});
test('minimum notice is measured against studio time', (t) => {
  const db = fixture(t);
  const slots = availableSlots(db, input.date, 'haircut', Date.parse('2026-10-27T13:10:00Z'));
  assert.equal(slots[0].time, '10:15');
});
test('bookings persist service snapshots and hash their private tokens', (t) => {
  const db = fixture(t);
  const booking = createBooking(db, input, now);
  const saved = db.prepare('SELECT * FROM bookings').get();
  assert.equal(saved.token_hash, tokenHash(booking.token));
  assert.notEqual(saved.token_hash, booking.token);
  assert.equal(saved.service_name, 'Haircut');
  assert.equal(saved.price, 4000);
  assert.equal(saved.ends_at - saved.starts_at, 45 * 60000);
});
test('overlapping haircuts are blocked and adjacent slots remain available', (t) => {
  const db = fixture(t);
  createBooking(db, input, now);
  const slots = availableSlots(db, input.date, 'haircut', now).map((slot) => slot.time);
  assert(!slots.includes('09:00'));
  assert(!slots.includes('09:15'));
  assert(!slots.includes('09:30'));
  assert(slots.includes('09:45'));
  assert.throws(() => createBooking(db, { ...input, time: '09:15' }, now), { status: 409 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM bookings').get().n, 1);
});
test('cancelling an appointment releases the slot', (t) => {
  const db = fixture(t);
  const booking = createBooking(db, input, now);
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
  assert(availableSlots(db, input.date, 'haircut', now).some((slot) => slot.time === input.time));
});
test('failed reservations roll back and leave the next valid booking usable', (t) => {
  const db = fixture(t);
  assert.throws(() => createBooking(db, { ...input, time: '23:00' }, now), { status: 409 });
  assert.equal(createBooking(db, input, now).status, 'confirmed');
});
test('studio wall time is correct through DST and independent of server time zone', () => {
  assert.equal(toTimestamp('2026-10-27', '09:00', 'America/New_York'), Date.parse('2026-10-27T13:00:00Z'));
  assert.equal(toTimestamp('2026-11-03', '09:00', 'America/New_York'), Date.parse('2026-11-03T14:00:00Z'));
  assert.equal(toTimestamp('2026-03-08', '02:30', 'America/New_York'), null);
  assert.deepEqual(localParts(Date.parse('2026-10-27T02:00:00Z'), 'America/New_York'), { date: '2026-10-26', time: '22:00' });
});
test('invalid calendar dates and contact fields are rejected', (t) => {
  const db = fixture(t);
  assert.equal(validDate('2026-02-30'), false);
  assert.throws(() => availableSlots(db, 'bad-date', 'haircut', now), { status: 400 });
  for (const patch of [{ firstName: '' }, { lastName: '' }, { firstName: undefined }, { lastName: 'x'.repeat(51) }, { phone: undefined }, { phone: '' }, { phone: 'phone' }, { phone: '-------' }, { phone: '123456' }, { phone: '1'.repeat(16) }, { time: '25:00' }]) assert.throws(() => createBooking(db, { ...input, ...patch }, now), { status: 400 });
});
test('inactive services cannot be booked', (t) => {
  const db = fixture(t);
  db.prepare('UPDATE services SET active = 0 WHERE id = ?').run('haircut');
  assert.throws(() => createBooking(db, input, now), { status: 400 });
});
test('settings edits do not mutate the price of an existing appointment', (t) => {
  const db = fixture(t);
  createBooking(db, input, now);
  db.prepare('UPDATE services SET price = 9000 WHERE id = ?').run('haircut');
  assert.equal(db.prepare('SELECT price FROM bookings').get().price, 4000);
  assert.equal(settings(db).timezone, 'America/New_York');
});
