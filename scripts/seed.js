import { openStore, seedStore } from '../server/store.js';
const db = openStore();
try { await seedStore(db); console.log('Empty database initialized. Existing content was preserved.'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await db.close(); }
