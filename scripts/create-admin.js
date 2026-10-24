import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openStore } from '../server/store.js';
import { hashPassword } from '../server/auth.js';

const db = openStore();
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
output.isTTY = process.stdout.isTTY;
output.columns = process.stdout.columns;
const terminal = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
try {
  console.log('Create or reset the private admin account. Existing sessions will be signed out.');
  const email = (await terminal.question('Admin email: ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  process.stdout.write('Password (at least 12 characters): ');
  muted = true;
  const password = await terminal.question('');
  muted = false;
  process.stdout.write('\nConfirm password: ');
  muted = true;
  const confirmation = await terminal.question('');
  muted = false;
  process.stdout.write('\n');
  if (password.length < 12 || password.length > 256) throw new Error('Use a password between 12 and 256 characters.');
  if (password !== confirmation) throw new Error('Passwords did not match.');
  const hash = await hashPassword(password);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO admin VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash').run(email, hash);
  db.exec('DELETE FROM sessions; COMMIT;');
  console.log('Admin account saved. Sign in at /admin.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { terminal.close(); db.close(); }
