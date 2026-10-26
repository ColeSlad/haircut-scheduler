import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openStore } from '../server/store.js';
import { createOrResetAdmin } from '../server/auth.js';
import { adminCreationSql } from '../server/admin-sql.js';

const printSql = process.argv.includes('--print-sql');
let db;
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
output.isTTY = process.stdout.isTTY;
output.columns = process.stdout.columns;
const terminal = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
try {
  console.log(printSql ? 'Generate SQL to add an admin in your authenticated database editor. Existing accounts stay unchanged.' : 'Create or reset an admin account (up to two). Resetting a password signs out only that admin.');
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
  if (printSql) {
    const sql = await adminCreationSql(email, password);
    console.log('\nPaste the SQL below into the production database Query editor and click Run.');
    console.log('Keep this SQL private: it contains a password hash. This command has not connected to a database.');
    console.log('A returned row confirms creation. Zero rows means the email already exists or both admin slots are full.\n');
    console.log(sql);
  } else {
    db = openStore();
    await createOrResetAdmin(db, email, password);
    console.log('Admin account saved. Sign in at /admin.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { terminal.close(); await db?.close(); }
