import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { put, head, BlobNotFoundError } from '@vercel/blob';
import { openPostgres, migrate } from '../server/postgres.js';
import { imageType, trustedBlobUrl } from '../server/storage.js';

const tables = ['settings', 'services', 'hours', 'days_off', 'bookings', 'admin', 'gallery', 'videos', 'home_videos', 'review_content'];

// Media uploaded through Vercel's authenticated dashboard can be imported without
// ever revealing a Blob read-write token to the local machine.
export async function loadMediaMap(file) {
  const mapping = JSON.parse(await readFile(file, 'utf8'));
  if (!mapping || !mapping.assets || typeof mapping.assets !== 'object' || !trustedBlobUrl(`${mapping.origin}/photos/check.jpg`, mapping.origin)) throw new Error('Invalid media map.');
  return {
    blobOrigin: mapping.origin,
    async upload(path, kind) {
      const url = mapping.assets[path];
      const folder = { video: 'videos', photo: 'photos', poster: 'posters' }[kind];
      if (!trustedBlobUrl(url, mapping.origin) || !new URL(url).pathname.startsWith(`/${folder}/`)) throw new Error('Media map is missing a valid uploaded asset.');
      return url;
    },
  };
}

export function readLegacy(file) {
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec('BEGIN');
    if (source.prepare('PRAGMA user_version').get().user_version < 4) throw new Error('Upgrade the legacy database to schema version 4 before importing.');
    return Object.fromEntries(tables.map((table) => [table, source.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row }))]));
  } finally { source.close(); }
}

export async function uploadMedia(path, kind, dataDir, { inspect = head, write = put, origin = process.env.BLOB_PUBLIC_ORIGIN } = {}) {
  if (!/^\/uploads\/[a-f0-9-]+\.(mp4|jpg|png|webp)$/.test(path)) throw new Error('Unexpected legacy media path.');
  const bytes = await readFile(resolve(dataDir, path.slice(1)));
  const contentType = kind === 'video' ? 'video/mp4' : imageType(bytes);
  if (kind === 'video' && bytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('Legacy video is not an MP4.');
  const folder = { video: 'videos', photo: 'photos', poster: 'posters' }[kind];
  const pathname = `${folder}/${createHash('sha256').update(bytes).digest('hex')}${extname(path)}`;
  const url = `${origin}/${pathname}`;
  try {
    const existing = await inspect(url);
    if (existing.size !== bytes.length || existing.contentType !== contentType) throw new Error('Existing media does not match the import.');
    return url;
  } catch (error) { if (!(error instanceof BlobNotFoundError)) throw error; }
  return (await write(pathname, bytes, { access: 'public', contentType, addRandomSuffix: false, allowOverwrite: false })).url;
}

export async function importLegacy(db, source, { dataDir, upload = uploadMedia, blobOrigin = process.env.BLOB_PUBLIC_ORIGIN } = {}) {
  if (await db.prepare("SELECT name FROM data_imports WHERE name = 'legacy-sqlite-v1'").get()) return { alreadyImported: true };
  for (const table of tables) if ((await db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n) throw new Error('Import requires an empty target database. Do not seed it first.');
  const rows = structuredClone(source);
  const media = new Map();
  async function copy(value, kind) {
    if (!value.startsWith('/uploads/')) return value;
    const key = `${kind}:${value}`;
    if (!media.has(key)) {
      const url = await upload(value, kind, dataDir);
      if (!trustedBlobUrl(url, blobOrigin)) throw new Error('Uploaded media is outside the configured Blob store.');
      media.set(key, { url, kind });
    }
    return media.get(key).url;
  }
  for (const row of rows.gallery) row.image = await copy(row.image, 'photo');
  for (const row of rows.home_videos) { row.video = await copy(row.video, 'video'); row.poster = await copy(row.poster, 'poster'); }
  await db.transaction(async (tx) => {
    if (await tx.prepare("SELECT name FROM data_imports WHERE name = 'legacy-sqlite-v1'").get()) return;
    for (const table of tables) {
      if ((await tx.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n) throw new Error('Target data changed while importing. No data was overwritten.');
      // Column names come exclusively from the known legacy schema, never request input.
      const allowed = new Set((await tx.prepare('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?').all(table)).map((row) => row.column_name));
      for (const row of rows[table]) {
        const columns = Object.keys(row).filter((key) => allowed.has(key));
        const sql = `INSERT INTO ${table} (${columns.map((name) => `"${name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
        const values = columns.map((name) => table === 'admin' && name === 'email' ? row[name].toLowerCase() : row[name]);
        await tx.prepare(sql).run(...values);
      }
      const count = (await tx.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n;
      if (count !== rows[table].length) throw new Error(`Import count mismatch: ${table}`);
    }
    for (const { url, kind } of media.values()) await tx.prepare('INSERT INTO media_assets VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(url, kind, Date.now());
    // Sessions are intentionally excluded: existing admins sign in again with their unchanged passwords.
    await tx.prepare("INSERT INTO data_imports VALUES ('legacy-sqlite-v1', ?)").run(Date.now());
  });
  return { counts: Object.fromEntries(tables.map((table) => [table, rows[table].length])), media: media.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const dataDir = resolve(process.env.DATA_DIR || 'data');
    const source = readLegacy(resolve(dataDir, 'scheduler.sqlite'));
    if (process.argv.includes('--dry-run')) {
      console.log('Source row counts:', Object.fromEntries(tables.map((table) => [table, source[table].length])));
    } else {
      const mapArgument = process.argv.find((argument) => argument.startsWith('--media-map='));
      const mediaOptions = mapArgument ? await loadMediaMap(resolve(mapArgument.slice('--media-map='.length))) : {};
      if (!mapArgument && (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.BLOB_PUBLIC_ORIGIN)) throw new Error('Configure the target Blob store or provide --media-map=FILE before importing.');
      db = openPostgres(process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL);
      await migrate(db);
      console.log('Import result:', await importLegacy(db, source, { dataDir, ...mediaOptions }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await db?.close(); }
}
