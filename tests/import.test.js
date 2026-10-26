import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/legacy-store.js';
import { testDatabase } from './helpers.js';
import { readLegacy, importLegacy, uploadMedia } from '../scripts/import-sqlite.js';
import { publicData } from '../server/store.js';
import { BlobNotFoundError } from '@vercel/blob';

test('media import uploads missing blobs and reuses matching immutable files on retry', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'l2cuts-media-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'uploads'));
  const bytes = Buffer.from([255, 216, 255, 0, 0, 0]);
  writeFileSync(join(directory, 'uploads', 'abc-123.jpg'), bytes);
  const origin = 'https://fixture.public.blob.vercel-storage.com';
  let writes = 0;
  const write = async (pathname, contents, options) => {
    writes++;
    assert.deepEqual(contents, bytes);
    assert.equal(options.allowOverwrite, false);
    return { url: `${origin}/${pathname}` };
  };
  const first = await uploadMedia('/uploads/abc-123.jpg', 'photo', directory, { origin, write, inspect: async () => { throw new BlobNotFoundError(); } });
  assert.match(first, /\/photos\/[a-f0-9]{64}\.jpg$/);
  const second = await uploadMedia('/uploads/abc-123.jpg', 'photo', directory, { origin, write, inspect: async () => ({ size: bytes.length, contentType: 'image/jpeg' }) });
  assert.equal(first, second); assert.equal(writes, 1);
  await assert.rejects(uploadMedia('/uploads/abc-123.jpg', 'photo', directory, { origin, write, inspect: async () => { throw new Error('Storage unavailable'); } }), /unavailable/);
  assert.equal(writes, 1);
});

test('SQLite import preserves edits, password hashes and media, and never overwrites a completed import', async (t) => {
  const db = await testDatabase(t, false);
  const directory = mkdtempSync(join(tmpdir(), 'l2cuts-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.sqlite');
  const legacy = openStore(file);
  legacy.prepare("UPDATE services SET price = 3000 WHERE id = 'haircut'").run();
  legacy.prepare('INSERT INTO admin VALUES (1, ?, ?)').run('owner@example.com', 'preserved-scrypt-hash');
  legacy.prepare('INSERT INTO home_videos VALUES (?, ?, ?, ?, ?)').run('first', 'My video', '/uploads/abc-123.mp4', '/uploads/abc-456.jpg', 0);
  const originalReviews = legacy.prepare('SELECT value FROM review_content').get().value;
  legacy.close();
  const source = readLegacy(file);
  const origin = 'https://isolated.public.blob.vercel-storage.com';
  const result = await importLegacy(db, source, { blobOrigin: origin, upload: async (path, kind) => `${origin}/${kind === 'video' ? 'videos' : 'posters'}/${path.split('/').at(-1)}` });
  assert.equal(result.media, 2);
  assert.equal((await publicData(db)).services[0].price, 3000);
  assert.equal((await db.prepare('SELECT password_hash FROM admin').get()).password_hash, 'preserved-scrypt-hash');
  assert.equal((await db.prepare('SELECT value FROM review_content').get()).value, originalReviews);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM sessions').get()).n, 0);
  assert((await publicData(db)).homeVideos[0].video.startsWith(origin));
  await db.exec("UPDATE services SET price = 3500 WHERE id = 'haircut'");
  assert.equal((await importLegacy(db, source)).alreadyImported, true);
  assert.equal((await publicData(db)).services[0].price, 3500);
});
