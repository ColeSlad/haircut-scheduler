import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { adminCreationSql } from '../server/admin-sql.js';
import { createOrResetAdmin, createSession, passwordAuthKeys, verifyPassword } from '../server/auth.js';
import { testDatabase } from './helpers.js';

test('generated SQL adds a usable second admin without changing the owner or their sessions', async t => {
  const db = await testDatabase(t);
  await createOrResetAdmin(db, 'owner@example.com', 'existing-owner-password');
  const original = await db.prepare('SELECT * FROM admin').get();
  await createSession(db, (await passwordAuthKeys(db))[0]);
  const sessions = await db.prepare('SELECT * FROM sessions').all();
  const password = 'new-admin-password';
  const sql = await adminCreationSql(' Second@Example.com ', password);
  assert(!sql.includes(password));
  const result = await db.exec(sql);
  assert.deepEqual(result.rows, [{ id: 2, email: 'second@example.com' }]);
  assert(await verifyPassword(password, (await db.prepare('SELECT password_hash FROM admin WHERE id = 2').get()).password_hash));
  assert.deepEqual(await db.prepare('SELECT * FROM admin WHERE id = 1').get(), original);
  assert.deepEqual(await db.prepare('SELECT * FROM sessions').all(), sessions);
  assert.deepEqual((await db.exec(sql)).rows, []);
  assert.deepEqual((await db.exec(await adminCreationSql('third@example.com', 'another-password'))).rows, []);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM admin').get()).n, 2);
});

test('generated SQL never resets an existing email, and quotes input safely in the editor', async t => {
  const db = await testDatabase(t);
  await createOrResetAdmin(db, 'owner@example.com', 'existing-owner-password');
  const original = await db.prepare('SELECT * FROM admin').get();
  assert.deepEqual((await db.exec(await adminCreationSql('OWNER@example.com', 'replacement-password'))).rows, []);
  assert.deepEqual(await db.prepare('SELECT * FROM admin').get(), original);
  const email = "O'Connor\\+$$;--@Example.com";
  const sql = await adminCreationSql(email, 'another-password');
  await db.exec('SET standard_conforming_strings = off');
  const result = await db.exec(sql);
  assert.deepEqual(result.rows, [{ id: 2, email: email.toLowerCase() }]);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM admin').get()).n, 2);
});

test('SQL generation validates admin credentials before producing a statement', async () => {
  for (const email of [null, '', 'invalid', `${'x'.repeat(250)}@example.com`]) await assert.rejects(adminCreationSql(email, 'valid-long-password'), /valid email/);
  for (const password of [null, '', 'too-short', 'x'.repeat(257)]) await assert.rejects(adminCreationSql('second@example.com', password), /12 and 256/);
});

test('print-sql CLI needs no database connection and keeps the entered password out of its output', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/create-admin.js', import.meta.url)), '--print-sql'], { env: { ...process.env, DATABASE_URL: 'deliberately-not-a-database-url' } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '', stage = 0;
  const password = 'private-cli-test-password';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    output += chunk;
    if (stage === 0 && output.includes('Admin email:')) { stage = 1; child.stdin.write('second@example.com\n'); }
    else if (stage === 1 && output.includes('Password (at least 12 characters):')) { stage = 2; child.stdin.write(`${password}\n`); }
    else if (stage === 2 && output.includes('Confirm password:')) { stage = 3; child.stdin.write(`${password}\n`); }
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  assert.equal(stage, 3);
  assert(!output.includes(password));
  assert.match(output, /has not connected to a database/);
  const db = await testDatabase(t);
  assert.deepEqual((await db.exec(output.slice(output.indexOf('WITH available_slot')))).rows, [{ id: 1, email: 'second@example.com' }]);
});
