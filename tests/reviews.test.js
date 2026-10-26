import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { migrate } from '../server/postgres.js';
import { listReviews, reviewSummary, saveReviews, submitReview } from '../server/reviews.js';

const input = () => ({ name: 'Test Client', text: 'A great haircut.', stars: 5, requestId: randomUUID() });
const adminReview = (changes = {}) => ({ name: 'Test Client', text: 'An edited review.', stars: 5, sample: false, showOnHome: false, hidden: false, ...changes });

test('existing review content migrates once and preserves the first three homepage selections', async (t) => {
  const db = await testDatabase(t, false);
  await db.exec('DROP TABLE reviews');
  await db.prepare("DELETE FROM schema_migrations WHERE name = '007_public_reviews.sql'").run();
  const items = Array.from({ length: 4 }, (_, index) => ({ id: `existing-${index}`, name: `Name ${index}`, text: `Original text ${index}`, stars: 5 - index, sample: false }));
  await db.prepare('INSERT INTO review_content VALUES (1, ?)').run(JSON.stringify({ rating: 4.99, items }));
  await migrate(db); await migrate(db);
  const summary = await reviewSummary(db);
  assert.deepEqual(summary.items.map(item => item.id), items.slice(0, 3).map(item => item.id));
  assert.deepEqual(summary.items.map(item => item.text), items.slice(0, 3).map(item => item.text));
  assert(summary.items.every(item => item.createdAt === null));
  assert.equal(summary.rating, 3.5); assert.equal(summary.count, 4);
});

test('public reviews publish without accounts, ignore admin flags, and retry idempotently', async (t) => {
  const db = await testDatabase(t);
  const review = { ...input(), sample: true, hidden: true, showOnHome: true };
  const results = await Promise.all([submitReview(db, review), submitReview(db, review)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].published, true);
  const row = await db.prepare('SELECT * FROM reviews').get();
  assert.equal(row.hidden, false); assert.equal(row.show_on_home, false); assert.equal(row.sample, false);
  assert.notEqual(row.request_hash, review.requestId);
  assert.equal((await reviewSummary(db)).items.length, 0);
  assert.equal((await listReviews(db)).items.length, 1);
  await assert.rejects(submitReview(db, { ...review, text: 'Changed details.' }), { status: 409 });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM reviews').get()).n, 1);
});

test('homepage selection is capped at three and can be swapped atomically', async (t) => {
  const db = await testDatabase(t);
  await saveReviews(db, Array.from({ length: 4 }, (_, i) => adminReview({ name: `Name ${i}`, stars: i + 1, showOnHome: i < 3 })));
  const rows = (await listReviews(db, { admin: true })).items;
  const extra = rows.find(row => !row.showOnHome);
  await assert.rejects(saveReviews(db, [{ ...extra, showOnHome: true }]), { status: 400 });
  const first = rows.find(row => row.showOnHome);
  await saveReviews(db, [{ ...first, showOnHome: false }, { ...extra, showOnHome: true }]);
  const summary = await reviewSummary(db);
  assert.equal(summary.items.length, 3); assert(summary.items.some(row => row.id === extra.id));
  assert.equal(summary.rating, 2.5); // Rating uses all published reviews, not homepage choices.
  assert.equal(summary.homeCount, 3);
});

test('admin edits preserve new public submissions and reject stale changes without partial writes', async (t) => {
  const db = await testDatabase(t);
  await saveReviews(db, [adminReview({ name: 'First' }), adminReview({ name: 'Second' })]);
  const original = (await listReviews(db, { admin: true })).items;
  const posted = await submitReview(db, input());
  await saveReviews(db, [{ ...original[0], text: 'Saved edit.' }]);
  await assert.rejects(saveReviews(db, [{ ...original[1], name: 'Must roll back' }, { ...original[0], name: 'Stale edit' }]), { status: 409 });
  const current = (await listReviews(db, { admin: true })).items;
  assert(current.some(row => row.id === posted.id));
  assert.equal(current.find(row => row.id === original[1].id).name, original[1].name);
  assert.equal(current.find(row => row.id === original[0].id).text, 'Saved edit.');
});

test('hidden reviews are reversible, placeholders do not affect ratings, and retries do not republish hidden posts', async (t) => {
  const db = await testDatabase(t);
  const posted = input(); const result = await submitReview(db, posted);
  await saveReviews(db, [adminReview({ sample: true, showOnHome: true, stars: 1 })]);
  assert.equal((await reviewSummary(db)).rating, 5);
  const row = (await listReviews(db, { admin: true })).items.find(item => item.id === result.id);
  await saveReviews(db, [{ ...row, hidden: true }]);
  assert.equal((await reviewSummary(db)).rating, null);
  assert.equal((await listReviews(db)).items.length, 1);
  assert.equal((await submitReview(db, posted)).published, false);
  const hidden = (await listReviews(db, { admin: true })).items.find(item => item.id === result.id);
  await saveReviews(db, [{ ...hidden, hidden: false }]);
  assert.equal((await reviewSummary(db)).rating, 5);
});

test('review pagination is bounded and stable when new reviews arrive between pages', async (t) => {
  const db = await testDatabase(t);
  for (let i = 0; i < 25; i++) await submitReview(db, { ...input(), name: `Name ${i}` });
  const first = await listReviews(db);
  assert.equal(first.items.length, 20); assert(first.nextCursor);
  await submitReview(db, input());
  const next = await listReviews(db, { before: first.nextCursor });
  assert.equal(next.items.length, 5); assert.equal(next.nextCursor, null);
  assert(!next.items.some(row => first.items.some(previous => previous.id === row.id)));
  assert(first.items.every(row => !Object.hasOwn(row, 'request_hash') && !Object.hasOwn(row, 'version')));
  for (const before of ['bad', 0, -1, 1.5, '9007199254740992']) await assert.rejects(listReviews(db, { before }), { status: 400 });
});

test('review fields and homepage settings are validated on the server', async (t) => {
  const db = await testDatabase(t);
  for (const changes of [{ name: '' }, { name: 'x'.repeat(81) }, { text: '' }, { text: 'x'.repeat(601) }, { stars: 0 }, { stars: 6 }, { stars: '5' }, { stars: 4.5 }, { requestId: null }, { website: 'spam.example' }]) await assert.rejects(submitReview(db, { ...input(), ...changes }), { status: 400 });
  await assert.rejects(saveReviews(db, [adminReview({ hidden: true, showOnHome: true })]), { status: 400 });
  await assert.rejects(saveReviews(db, [adminReview({ sample: 'false' })]), { status: 400 });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM reviews').get()).n, 0);
});
