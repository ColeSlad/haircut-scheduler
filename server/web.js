import { Readable } from 'node:stream';
import { createApi } from './api.js';
import { securityHeaders } from './config.js';

// Adapt the existing streaming API to Vercel's standard Request/Response runtime.
export function createWebHandler(db, { origin, ...options }) {
  const api = createApi(db, { origin, secure: true, ...options });
  return async (request) => {
    const url = new URL(request.url);
    const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
    Object.assign(req, { method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers), socket: {} });
    let status = 200;
    let responseBody;
    const headers = new Headers({ ...securityHeaders, 'Cache-Control': 'no-store' });
    const res = {
      writeHead(code, values) { status = code; for (const [key, value] of Object.entries(values || {})) headers.set(key, value); },
      end(body) { responseBody = body; },
    };
    try { await api(req, res, url); }
    catch (error) {
      status = error.status || 500;
      if (status >= 500) console.error('api_request_failed', error.code || error.name);
      headers.set('Content-Type', 'application/json; charset=utf-8');
      responseBody = JSON.stringify({ error: status >= 500 ? 'The service is temporarily unavailable. Please try again.' : error.message });
    }
    return new Response(request.method === 'HEAD' ? null : responseBody, { status, headers });
  };
}
