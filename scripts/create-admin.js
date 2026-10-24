import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openStore } from '../server/store.js';
import { createOrResetAdmin } from '../server/auth.js';

const db = openStore();
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
output.isTTY = process.stdout.isTTY;
output.columns = process.stdout.columns;
const terminal = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
try {
  console.log('Create or reset an admin account (up to two). Resetting a password signs out only that admin.');
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
  await createOrResetAdmin(db, email, password);
  console.log('Admin account saved. Sign in at /admin.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { terminal.close(); db.close(); }
