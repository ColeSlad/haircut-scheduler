import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationDiagnostic } from '../public/notification-errors.js';

test('notification diagnostics distinguish HTTP rejections, usable codes, and missing provider detail', () => {
  for (const error_code of ['0', null, '', '<script>secret</script>']) {
    const detail = notificationDiagnostic({ state: 'failed', error_code });
    assert.equal(detail.label, 'Twilio returned no diagnostic code');
    assert.equal(detail.url, ''); assert.equal(detail.help, true);
  }
  assert.deepEqual(notificationDiagnostic({ state: 'failed', error_code: 'HTTP_400' }), { label: 'Twilio request failed (HTTP 400)', url: '', help: true });
  assert.deepEqual(notificationDiagnostic({ state: 'failed', error_code: '21608' }), { label: 'Provider error 21608', url: 'https://www.twilio.com/docs/api/errors/21608', help: false });
  assert.match(notificationDiagnostic({ state: 'failed', error_code: '30034' }).hint, /approved US A2P 10DLC/);
  assert.equal(notificationDiagnostic({ state: 'unknown', error_code: null }).label, '');
  assert.equal(notificationDiagnostic({ state: 'delivered', error_code: '21608' }).label, '');
});
