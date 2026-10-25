import { Pool, types } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// All stored millisecond timestamps and counters fit in JavaScript's safe integer range.
types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds the safe range.');
  return number;
});

function placeholders(sql) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (part) => part === '?' ? `$${++index}` : part);
}

export function connection(client, pool = null) {
  const db = {
    dialect: 'postgres',
    query: (sql, values = []) => client.query(placeholders(sql), values),
    exec: (sql) => client.query(sql),
    prepare(sql) {
      return {
        get: async (...values) => (await db.query(sql, values)).rows[0],
        all: async (...values) => (await db.query(sql, values)).rows,
        run: async (...values) => ({ changes: (await db.query(sql, values)).rowCount }),
      };
    },
    async transaction(work) {
      if (!pool) return work(db); // Already inside the outer transaction.
      const session = await pool.connect();
      try {
        await session.query('BEGIN');
        // Serialize calendar/configuration writes, including across Vercel instances.
        await session.query('SELECT pg_advisory_xact_lock(728194621)');
        const result = await work(connection(session));
        await session.query('COMMIT');
        return result;
      } catch (error) {
        await session.query('ROLLBACK');
        throw error;
      } finally { session.release(); }
    },
    close: () => pool?.end(),
  };
  return db;
}

export function openPostgres(url = process.env.DATABASE_URL, options = {}) {
  if (!url) throw new Error('DATABASE_URL is required. Run database migrations before starting the app.');
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, ...options });
  pool.on('error', () => console.error('database_pool_error'));
  if (process.env.VERCEL) attachDatabasePool(pool);
  return connection(pool, pool);
}

export async function migrate(db) {
  const directory = new URL('../migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  await db.transaction(async (tx) => {
    await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await tx.prepare('SELECT checksum FROM schema_migrations WHERE name = ?').get(name);
      if (previous && previous.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      if (previous) continue;
      await tx.exec(sql);
      await tx.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, checksum);
    }
  });
}
