import { openPostgres, migrate } from '../server/postgres.js';
const db = openPostgres(process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL);
try { await migrate(db); console.log('Database migrations applied.'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await db.close(); }
