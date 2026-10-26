import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Vercel configuration stays within Hobby cron and function limits', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.crons.length, 1);
  const [minute, hour, day, month, weekday] = config.crons[0].schedule.split(' ');
  assert(/^(?:[0-9]|[1-5][0-9])$/.test(minute));
  assert(/^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour));
  assert.deepEqual([day, month, weekday], ['*', '*', '*']);
  assert.equal(config.crons[0].path, '/api/cron/payments');
  assert.equal(Object.keys(config.functions).length, 1);
  assert(config.functions['api/index.js'].maxDuration <= 60);
  assert.equal(config.regions.length, 1);
});
