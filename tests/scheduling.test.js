import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedStore, settings } from '../server/store.js';
import { testDatabase } from './helpers.js';
import { availableSlots, createBooking, toTimestamp, localParts, validDate, tokenHash } from '../server/scheduling.js';

const now = Date.parse('2026-10-26T12:00:00Z');
const input = { serviceId: 'haircut', date: '2026-10-27', time: '09:00', firstName: 'Sam', lastName: 'Example', phone: '555-123-4567' };
async function fixture(t) { const db = await testDatabase(t);  return db; }

test('a single barber offers slots within working hours and service duration', async (t) => {
  const db = await fixture(t);
  const slots = (await availableSlots(db, input.date, 'haircut', now));
  assert.equal(slots[0].time, '09:00');
  assert.equal(slots.at(-1).time, '17:15');
  (await db.prepare("UPDATE services SET duration = 60 WHERE id = 'haircut'").run());
  assert.equal((await availableSlots(db, input.date, 'haircut', now)).at(-1).time, '17:00');
});
test('closed days, days off, past dates and dates outside the booking horizon offer no slots', async (t) => {
  const db = await fixture(t);
  assert.deepEqual((await availableSlots(db, '2026-10-26', 'haircut', now)), []);
  assert.deepEqual((await availableSlots(db, '2026-10-25', 'haircut', now)), []);
  assert.deepEqual((await availableSlots(db, '2027-01-05', 'haircut', now)), []);
  (await db.prepare('INSERT INTO days_off VALUES (?, ?)').run(input.date, 'Holiday'));
  assert.deepEqual((await availableSlots(db, input.date, 'haircut', now)), []);
});
test('minimum notice is measured against studio time', async (t) => {
  const db = await fixture(t);
  const slots = (await availableSlots(db, input.date, 'haircut', Date.parse('2026-10-27T13:10:00Z')));
  assert.equal(slots[0].time, '10:15');
});
test('bookings persist service snapshots and hash their private tokens', async (t) => {
  const db = await fixture(t);
  const booking = (await createBooking(db, input, now));
  const saved = (await db.prepare('SELECT * FROM bookings').get());
  assert.equal(saved.token_hash, tokenHash(booking.token));
  assert.notEqual(saved.token_hash, booking.token);
  assert.equal(saved.service_name, 'Haircut');
  assert.equal(saved.price, 4000);
  assert.equal(saved.ends_at - saved.starts_at, 45 * 60000);
});
test('overlapping haircuts are blocked and adjacent slots remain available', async (t) => {
  const db = await fixture(t);
  (await createBooking(db, input, now));
  const slots = (await availableSlots(db, input.date, 'haircut', now)).map((slot) => slot.time);
  assert(!slots.includes('09:00'));
  assert(!slots.includes('09:15'));
  assert(!slots.includes('09:30'));
  assert(slots.includes('09:45'));
  await assert.rejects(async () => (await createBooking(db, { ...input, time: '09:15' }, now)), { status: 409 });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').get()).n, 1);
});
test('cancelling an appointment releases the slot', async (t) => {
  const db = await fixture(t);
  const booking = (await createBooking(db, input, now));
  (await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id));
  assert((await availableSlots(db, input.date, 'haircut', now)).some((slot) => slot.time === input.time));
});
test('failed reservations roll back and leave the next valid booking usable', async (t) => {
  const db = await fixture(t);
  await assert.rejects(async () => (await createBooking(db, { ...input, time: '23:00' }, now)), { status: 409 });
  assert.equal((await createBooking(db, input, now)).status, 'pending');
});
test('studio wall time is correct through DST and independent of server time zone', () => {
  assert.equal(toTimestamp('2026-10-27', '09:00', 'America/New_York'), Date.parse('2026-10-27T13:00:00Z'));
  assert.equal(toTimestamp('2026-11-03', '09:00', 'America/New_York'), Date.parse('2026-11-03T14:00:00Z'));
  assert.equal(toTimestamp('2026-03-08', '02:30', 'America/New_York'), null);
  assert.deepEqual(localParts(Date.parse('2026-10-27T02:00:00Z'), 'America/New_York'), { date: '2026-10-26', time: '22:00' });
});
test('invalid calendar dates and contact fields are rejected', async (t) => {
  const db = await fixture(t);
  assert.equal(validDate('2026-02-30'), false);
  await assert.rejects(async () => (await availableSlots(db, 'bad-date', 'haircut', now)), { status: 400 });
  for (const patch of [{ firstName: '' }, { lastName: '' }, { firstName: undefined }, { lastName: 'x'.repeat(51) }, { phone: undefined }, { phone: '' }, { phone: 'phone' }, { phone: '-------' }, { phone: '123456' }, { phone: '1'.repeat(16) }, { time: '25:00' }]) await assert.rejects(async () => (await createBooking(db, { ...input, ...patch }, now)), { status: 400 });
});
test('inactive services cannot be booked', async (t) => {
  const db = await fixture(t);
  (await db.prepare('UPDATE services SET active = 0 WHERE id = ?').run('haircut'));
  await assert.rejects(async () => (await createBooking(db, input, now)), { status: 400 });
});
test('settings edits do not mutate the price of an existing appointment', async (t) => {
  const db = await fixture(t);
  (await createBooking(db, input, now));
  (await db.prepare('UPDATE services SET price = 9000 WHERE id = ?').run('haircut'));
  assert.equal((await db.prepare('SELECT price FROM bookings').get()).price, 4000);
  assert.equal((await settings(db)).timezone, 'America/New_York');
});
