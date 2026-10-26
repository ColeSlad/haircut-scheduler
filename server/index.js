import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createApi } from './api.js';
import { sendVideo } from './media.js';
import { securityHeaders } from './config.js';

const buildDir = fileURLToPath(new URL('../dist', import.meta.url));
const publicDir = existsSync(buildDir) ? buildDir : fileURLToPath(new URL('../public', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
export function appServer({ db = openStore(), origin = 'http://localhost:3000', dataDir = resolve(process.env.DATA_DIR || 'data'), provider, secret, notificationSender, storage } = {}) {
  const api = createApi(db, { origin, secure: origin.startsWith('https://'), dataDir, provider, secret, notificationSender, storage });
  return createServer(async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    try {
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
      let path;
      if (['/', '/schedule', '/gallery', '/reviews', '/admin', '/booking'].includes(url.pathname)) path = resolve(publicDir, 'index.html');
      else if (/^\/uploads\/[a-f0-9-]+\.(jpg|png|webp|mp4)$/.test(url.pathname)) path = resolve(dataDir, url.pathname.slice(1));
      else if (/^\/(assets\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(css|js|svg|ico))$/.test(url.pathname)) path = resolve(publicDir, url.pathname.slice(1));
      const file = path && statSync(path, { throwIfNoEntry: false });
      if (!file?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Page not found.');
      }
      if (extname(path) === '.mp4') return sendVideo(req, res, path, file.size);
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css'].includes(extname(path)) ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(path));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || 500;
      if (status === 500) console.error('request_failed', error.code || error.name);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong. Please try again.' : error.message }));
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Set APP_ORIGIN to your public HTTPS URL in production.');
  const server = appServer({ origin });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`goodform. is ready at ${origin}`));
}
