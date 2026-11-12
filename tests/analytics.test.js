import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPageview } from '../public/analytics.js';

test('analytics reports only public page URLs and removes query strings, fragments, and extra fields', () => {
  for (const path of ['/', '/schedule', '/gallery', '/reviews', '/privacy', '/terms']) {
    const event = { type: 'pageview', url: `https://www.l2cuts.com${path}?phone=fixture&token=private#private`, name: 'Fixture contact' };
    assert.deepEqual(analyticsPageview(event), { type: 'pageview', url: `https://www.l2cuts.com${path}` });
    assert(event.url.includes('phone=')); // Do not mutate the SDK's input.
  }
});

test('analytics drops private, unknown, malformed, and custom events', () => {
  for (const path of ['/admin', '/admin/', '/booking', '/booking/private', '/api/bookings', '/api/checkout/return/fixture', '/unknown']) {
    assert.equal(analyticsPageview({ type: 'pageview', url: `https://www.l2cuts.com${path}?phone=fixture#private` }), null);
  }
  for (const url of ['bad URL', '', 'javascript:alert(1)', 'file:///schedule']) assert.equal(analyticsPageview({ type: 'pageview', url }), null);
  for (const event of [null, undefined, {}, { type: 'event', url: 'https://www.l2cuts.com/', name: 'Client details' }]) assert.equal(analyticsPageview(event), null);
});
