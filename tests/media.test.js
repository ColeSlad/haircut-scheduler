import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServer } from '../server/index.js';

function fixture(t) {
  const db = {};
  const dataDir = mkdtempSync(join(tmpdir(), 'haircut-media-'));
  const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  mkdirSync(join(dataDir, 'uploads'));
  writeFileSync(join(dataDir, 'uploads', 'abc-123.mp4'), bytes);
  writeFileSync(join(dataDir, 'uploads', 'abc-456.mp4'), Buffer.alloc(0));
  const server = appServer({ db, origin: 'http://localhost:3000', dataDir });
  t.after(() => { rmSync(dataDir, { recursive: true, force: true }); });
  function request(path = '/uploads/abc-123.mp4', { method = 'GET', range } = {}) {
    return new Promise((resolve, reject) => {
      const req = Readable.from([]);
      Object.assign(req, { method, url: path, headers: range ? { range } : {} });
      const chunks = [];
      const headers = {};
      const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
      res.setHeader = (key, value) => { headers[key.toLowerCase()] = value; };
      res.writeHead = (status, values) => { res.statusCode = status; res.headersSent = true; for (const [key, value] of Object.entries(values || {})) res.setHeader(key, value); };
      res.on('finish', () => resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
      server.emit('request', req, res);
    });
  }
  return { request, bytes };
}

test('local videos support full playback and HEAD without reading the body', async (t) => {
  const { request, bytes } = fixture(t);
  const full = await request();
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['content-length'], bytes.length);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.deepEqual(full.body, bytes);
  assert.match(full.headers['content-security-policy'], /media-src 'self' https:\/\/\*\.public\.blob\.vercel-storage\.com;/);
  const head = await request(undefined, { method: 'HEAD', range: 'bytes=2-5' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], bytes.length);
  assert.equal(head.body.length, 0);
});

test('video byte ranges support seeking, open ends, suffixes, and EOF clamping', async (t) => {
  const { request, bytes } = fixture(t);
  for (const [range, start, end] of [['bytes=0-0', 0, 0], ['bytes=2-5', 2, 5], ['bytes=30-', 30, 35], ['bytes=-4', 32, 35], ['bytes=30-100', 30, 35], ['bytes=-100', 0, 35]]) {
    const result = await request(undefined, { range });
    assert.equal(result.status, 206, range);
    assert.equal(result.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(result.headers['content-length'], end - start + 1);
    assert.deepEqual(result.body, bytes.subarray(start, end + 1));
  }
});

test('invalid ranges and non-public file paths never expose runtime files', async (t) => {
  const { request, bytes } = fixture(t);
  for (const range of ['bytes=36-', 'bytes=10-3', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=Infinity-', 'bytes=99999999999999999999-', 'items=0-3']) {
    const result = await request(undefined, { range });
    assert.equal(result.status, 416, range);
    assert.equal(result.headers['content-range'], `bytes */${bytes.length}`);
    assert.equal(result.body.length, 0);
  }
  assert.equal((await request('/uploads/abc-456.mp4')).body.length, 0);
  assert.equal((await request('/uploads/abc-456.mp4', { range: 'bytes=0-0' })).status, 416);
  for (const path of ['/data/scheduler.sqlite', '/uploads/../scheduler.sqlite', '/uploads/abc-123.mov', '/uploads/missing.mp4', '/server/media.js']) assert.equal((await request(path)).status, 404);
});
