import { randomUUID } from 'node:crypto';
import { HttpError, textField, tokenHash } from './scheduling.js';

const pageSize = 20;
function view(row, admin = false) {
  return { id: row.id, name: row.name, text: row.text, stars: row.stars, sample: row.sample, createdAt: row.created_at,
    ...(admin ? { showOnHome: row.show_on_home, hidden: row.hidden, version: row.version } : {}) };
}
function fields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Enter valid review details.');
  if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) throw new HttpError(400, 'Choose a rating from 1 to 5.');
  return { name: textField(input.name, 'name', 80), text: textField(input.text, 'review', 600), stars: input.stars };
}
async function stats(db) {
  const row = await db.prepare(`SELECT count(*) AS count, count(*) FILTER (WHERE NOT sample) AS rated_count,
    avg(stars) FILTER (WHERE NOT sample) AS rating, count(*) FILTER (WHERE show_on_home) AS home_count
    FROM reviews WHERE NOT hidden`).get();
  return { count: row.count, ratedCount: row.rated_count, rating: row.rating === null ? null : Math.round(Number(row.rating) * 100) / 100, homeCount: row.home_count };
}
export async function reviewSummary(db) {
  const [summary, rows] = await Promise.all([stats(db), db.prepare('SELECT * FROM reviews WHERE show_on_home AND NOT hidden ORDER BY position, seq DESC LIMIT 3').all()]);
  return { ...summary, items: rows.map(row => view(row)) };
}
export async function listReviews(db, { before, admin = false } = {}) {
  if (before !== undefined && before !== null && (!/^[1-9]\d*$/.test(String(before)) || !Number.isSafeInteger(Number(before)))) throw new HttpError(400, 'Choose a valid reviews page.');
  const rows = await db.prepare(`SELECT * FROM reviews WHERE ${admin ? 'TRUE' : 'NOT hidden'} ${before ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`).all(...[...(before ? [Number(before)] : []), pageSize + 1]);
  const hasMore = rows.length > pageSize;
  const selected = rows.slice(0, pageSize);
  return { ...(await stats(db)), items: selected.map(row => view(row, admin)), nextCursor: hasMore ? selected.at(-1).seq : null };
}
export async function submitReview(db, input, now = Date.now()) {
  const review = fields(input);
  if (input.website) throw new HttpError(400, 'Unable to submit this review.');
  if (typeof input.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(input.requestId)) throw new HttpError(400, 'Refresh the page and try again.');
  const hash = tokenHash(input.requestId);
  const fingerprint = tokenHash(JSON.stringify(review));
  return db.transaction(async tx => {
    const previous = await tx.prepare('SELECT id, request_fingerprint, hidden FROM reviews WHERE request_hash = ?').get(hash);
    if (previous) {
      if (previous.request_fingerprint !== fingerprint) throw new HttpError(409, 'Your review details changed. Please submit again with a new request.');
      return { id: previous.id, published: !previous.hidden };
    }
    const id = randomUUID();
    await tx.prepare('INSERT INTO reviews (id, name, text, stars, created_at, request_hash, request_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, review.name, review.text, review.stars, now, hash, fingerprint);
    return { id, published: true };
  });
}
export async function saveReviews(db, items) {
  if (!Array.isArray(items) || items.length > 100) throw new HttpError(400, 'Save up to 100 review changes at a time.');
  const ids = new Set();
  const changes = items.map(item => {
    const review = fields(item);
    for (const key of ['sample', 'showOnHome', 'hidden']) if (typeof item[key] !== 'boolean') throw new HttpError(400, 'Choose the review display settings.');
    if (item.hidden && item.showOnHome) throw new HttpError(400, 'Unhide a review before showing it on the homepage.');
    const existing = item.id !== undefined;
    const id = existing ? item.id : randomUUID();
    if (typeof id !== 'string' || !id || id.length > 80 || ids.has(id)) throw new HttpError(400, 'Choose valid review IDs.');
    if (existing && (!Number.isSafeInteger(item.version) || item.version < 1)) throw new HttpError(400, 'Refresh the reviews before editing.');
    ids.add(id);
    return { ...review, id, existing, version: item.version, sample: item.sample, showOnHome: item.showOnHome, hidden: item.hidden };
  });
  await db.transaction(async tx => {
    for (const review of changes) {
      const values = [review.name, review.text, review.stars, review.sample, review.showOnHome, review.hidden];
      if (review.existing) {
        const result = await tx.prepare('UPDATE reviews SET name = ?, text = ?, stars = ?, sample = ?, show_on_home = ?, hidden = ?, version = version + 1 WHERE id = ? AND version = ?').run(...values, review.id, review.version);
        if (!result.changes) throw new HttpError(409, 'A review changed since this page loaded. Refresh the reviews and try again.');
      } else await tx.prepare('INSERT INTO reviews (id, name, text, stars, sample, show_on_home, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(review.id, ...values, Date.now());
    }
    if ((await tx.prepare('SELECT count(*) AS n FROM reviews WHERE show_on_home AND NOT hidden').get()).n > 3) throw new HttpError(400, 'Choose up to three homepage reviews. Turn off another review first.');
  });
}

// Run only during an explicit import into an empty target, after the legacy JSON
// has been inserted. The SQL migration handles existing Postgres installations.
export async function importLegacyReviews(db) {
  await db.exec(`INSERT INTO reviews (id, name, text, stars, sample, show_on_home, position)
    SELECT COALESCE(NULLIF(item->>'id', ''), 'legacy-review-' || ordinal), item->>'name', item->>'text',
      (item->>'stars')::integer, COALESCE((item->>'sample')::boolean, FALSE), ordinal <= 3, ordinal::integer
    FROM review_content, jsonb_array_elements(value::jsonb->'items') WITH ORDINALITY AS source(item, ordinal)
    WHERE review_content.id = 1 ORDER BY ordinal DESC`);
}
