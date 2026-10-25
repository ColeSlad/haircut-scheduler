import { randomUUID } from 'node:crypto';
import { openPostgres, migrate } from '../server/postgres.js';
import { seedStore } from '../server/store.js';

export async function testDatabase(t, seed = true) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to an isolated local Postgres database (see README).');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const owner = openPostgres(url);
  await owner.exec(`CREATE SCHEMA ${schema}`);
  const db = openPostgres(url, { options: `-c search_path=${schema}` });
  t.after(async () => { await db.close(); await owner.exec(`DROP SCHEMA ${schema} CASCADE`); await owner.close(); });
  await migrate(db);
  if (seed) await seedStore(db);
  return db;
}
