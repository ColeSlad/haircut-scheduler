import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, imageType, trustedBlobUrl } from '../server/storage.js';
import { testDatabase } from './helpers.js';

const origin = 'https://isolated.public.blob.vercel-storage.com';
const url = `${origin}/photos/fixture.png`;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test('only the configured Blob store and validated image formats are accepted', () => {
  assert.equal(trustedBlobUrl(url, origin), true);
  for (const bad of [url.replace('isolated.', 'other.'), `${url}?redirect=bad`, `${url}/../../bad`, 'https://localhost/photos/file.png', '/uploads/file.png']) assert.equal(trustedBlobUrl(bad, origin), false);
  assert.equal(imageType(png), 'image/png');
  assert.throws(() => imageType(Buffer.from('<svg></svg>')), { status: 400 });
});

test('direct uploads must pass size and magic-byte checks before they can be saved', async (t) => {
  const db = await testDatabase(t);
  let size = 5_000_000;
  let bytes = png;
  const removed = [];
  const storage = createStorage(db, { origin, inspect: async () => ({ size, contentType: 'image/png' }), remove: async (value) => removed.push(value), fetchBytes: async () => new Response(bytes, { status: 206 }) });
  assert.equal(await storage.allowedPhoto(url), false);
  assert.deepEqual(await storage.validatePhoto(url), { image: url });
  assert.equal(await storage.allowedPhoto(url), true);
  size++;
  await assert.rejects(storage.validatePhoto(url), { status: 400 });
  size = 100; bytes = Buffer.from('<svg onload="alert(1)"/>');
  await assert.rejects(storage.validatePhoto(url), { status: 400 });
  assert.equal(removed.length, 2);
  assert.equal(await storage.allowedPhoto(`${origin}/photos/other.png`), false);
});
