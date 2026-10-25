import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './helpers.js';
import { migrate } from '../server/postgres.js';

test('Postgres migrations are repeatable and transactions roll back', async (t) => {
  const db = await testDatabase(t, false);
  await migrate(db);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).n, 1);
  await assert.rejects(db.transaction(async (tx) => {
    await tx.prepare('INSERT INTO settings VALUES (1, ?)').run('private test');
    throw new Error('rollback');
  }), /rollback/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM settings').get()).n, 0);
});
