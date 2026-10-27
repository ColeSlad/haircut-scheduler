import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appServer } from '../server/index.js';

test('public policy pages serve their complete content without JavaScript or database access', async () => {
  const db = { prepare() { throw new Error('Policy pages must not query the database'); } };
  const server = appServer({ db });
  function request(url, method = 'GET') {
    return new Promise(resolve => {
      const headers = {};
      const res = { setHeader(key, value) { headers[key.toLowerCase()] = value; },
        writeHead(status, values) { this.status = status; for (const [key, value] of Object.entries(values || {})) headers[key.toLowerCase()] = value; },
        end(body) { resolve({ status: this.status, headers, body: String(body || '') }); },
      };
      server.emit('request', { url, method }, res);
    });
  }
  const privacy = await request('/privacy');
  const terms = await request('/terms');
  for (const page of [privacy, terms]) {
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.match(page.body, /L2 Cuts/);
    assert.match(page.body, /mailto:coleslad31@gmail\.com/);
    assert(!page.body.includes('<script'));
    assert(!page.body.includes('+19089923507'));
  }
  assert.match(privacy.body, /<h1>Privacy Policy<\/h1>/);
  assert(privacy.body.includes('We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes.'));
  assert.match(terms.body, /<h1>Terms &amp; Conditions<\/h1>/);
  assert.match(terms.body, />SMS Terms<\/h2>/);
  assert.match(terms.body, /message and data rates may apply/i);
  assert.match(terms.body, /reply STOP/i);
  const head = await request('/privacy', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal((await request('/privacy', 'POST')).status, 405);
  assert.equal((await request('/unknown-policy')).status, 404);
});

test('Vercel policy URLs resolve to standalone HTML pages for campaign reviewers', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const route of ['/privacy', '/terms']) assert.equal(config.rewrites.find(item => item.source === route)?.destination, `${route}.html`);
});
