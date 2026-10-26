export { openPostgres as openStore } from './postgres.js';
import { defaults } from './defaults.js';
import { reviewSummary } from './reviews.js';
export { defaults };

export async function settings(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE id = 1').get();
  if (!row) { const error = new Error('The database has not been initialized.'); error.status = 503; throw error; }
  return JSON.parse(row.value);
}

export async function publicData(db) {
  const [config, services, hours, gallery, videos, homeVideos, reviews] = await Promise.all([
    settings(db),
    db.prepare("SELECT * FROM services WHERE id = 'haircut' AND active = 1").all(),
    db.prepare('SELECT * FROM hours ORDER BY day').all(),
    db.prepare('SELECT * FROM gallery ORDER BY position').all(),
    db.prepare('SELECT * FROM videos ORDER BY position').all(),
    db.prepare('SELECT * FROM home_videos ORDER BY position').all(),
    reviewSummary(db),
  ]);
  return { settings: config, services, hours, gallery, videos, homeVideos, reviews };
}

// Explicit setup only. Starting a server or deploying never seeds/overwrites user content.
export async function seedStore(db) {
  await db.transaction(async (tx) => {
    if (await tx.prepare('SELECT id FROM settings').get()) return;
    await tx.prepare('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify({ ...defaults, name: 'L2 Cuts' }));
    await tx.exec("INSERT INTO services VALUES ('haircut', 'Haircut', 'A haircut.', 45, 4000, 1, 0)");
    for (let day = 0; day < 7; day++) await tx.prepare('INSERT INTO hours VALUES (?, ?, ?, ?)').run(day, day > 1 ? 1 : 0, '09:00', day === 6 ? '16:00' : '18:00');
    await tx.prepare('INSERT INTO review_content VALUES (1, ?)').run(JSON.stringify({ rating: 4.99, items: [] }));
  });
}
