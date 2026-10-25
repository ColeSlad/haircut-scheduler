import { head, del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { HttpError } from './scheduling.js';

export function imageType(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new HttpError(400, 'Choose a JPEG, PNG, or WebP image.');
}

export function trustedBlobUrl(value, origin = process.env.BLOB_PUBLIC_ORIGIN) {
  try {
    const url = new URL(value);
    const configured = new URL(origin);
    return configured.protocol === 'https:' && /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(configured.hostname) &&
      url.origin === configured.origin && !url.search && !url.hash && !url.username && !url.password && /^\/(photos|videos|posters)\/[a-zA-Z0-9_.-]+$/.test(url.pathname);
  } catch { return false; }
}

export function createStorage(db, { origin = process.env.BLOB_PUBLIC_ORIGIN, inspect = head, remove = del, fetchBytes = fetch, uploadHandler = handleUpload } = {}) {
  async function validatePhoto(url) {
    if (!trustedBlobUrl(url, origin) || !new URL(url).pathname.startsWith('/photos/')) throw new HttpError(400, 'Upload a photo before saving it.');
    const info = await inspect(url);
    if (info.size <= 0 || info.size > 5_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(info.contentType)) {
      await remove(url); throw new HttpError(400, 'Use a JPEG, PNG, or WebP image under 5 MB.');
    }
    const response = await fetchBytes(url, { headers: { Range: 'bytes=0-11' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) throw new HttpError(503, 'The uploaded photo could not be checked. Try again.');
    const reader = response.body.getReader();
    let bytes = Buffer.alloc(0);
    try {
      while (bytes.length < 12) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes = Buffer.concat([bytes, Buffer.from(chunk.value).subarray(0, 12 - bytes.length)]);
      }
    } finally { await reader.cancel(); }
    try { if (imageType(bytes) !== info.contentType) throw new HttpError(400, 'The image contents do not match its file type.'); }
    catch (error) { await remove(url); throw error; }
    await db.prepare("INSERT INTO media_assets VALUES (?, 'photo', ?) ON CONFLICT DO NOTHING").run(url, Date.now());
    return { image: url };
  }

  async function handle(req, body, authorize) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new HttpError(503, 'Photo storage is not configured yet.');
    return uploadHandler({
      request: req, body,
      onBeforeGenerateToken: async (pathname) => {
        const authKey = await authorize();
        if (!/^photos\/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$/.test(pathname)) throw new HttpError(400, 'Choose a valid photo filename.');
        return { allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'], maximumSizeInBytes: 5_000_000, validUntil: Date.now() + 10 * 60_000, addRandomSuffix: false, allowOverwrite: false, tokenPayload: authKey };
      },
      // The SDK verifies the provider signature before invoking this callback.
      // The client also finalizes with an authenticated call, so local uploads work without a public callback.
      onUploadCompleted: async ({ blob }) => { await validatePhoto(blob.url); },
    });
  }

  async function allowedPhoto(url) {
    if (/^\/assets\/[A-Za-z0-9_.-]+\.(jpg|png|webp)$/.test(url)) return true;
    return trustedBlobUrl(url, origin) && Boolean(await db.prepare("SELECT url FROM media_assets WHERE url = ? AND kind = 'photo'").get(url));
  }
  return { handle, validatePhoto, allowedPhoto };
}
