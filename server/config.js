import { HttpError } from './scheduling.js';

export function runtimeConfig(env = process.env) {
  const host = env.VERCEL_ENV === 'preview' ? env.VERCEL_BRANCH_URL || env.VERCEL_URL : env.VERCEL_PROJECT_PRODUCTION_URL;
  const origin = env.VERCEL_ENV === 'preview' ? host && `https://${host}` : env.APP_ORIGIN || (host && `https://${host}`);
  const missing = ['DATABASE_URL', 'APP_SECRET'].filter((key) => !env[key]);
  if (!origin) missing.push('APP_ORIGIN');
  if (missing.length) throw configurationError(missing);
  let url;
  try { url = new URL(origin); } catch { throw configurationError(['APP_ORIGIN']); }
  if (url.origin !== origin || url.protocol !== 'https:') throw configurationError(['APP_ORIGIN']);
  if (env.APP_SECRET.length < 32) throw configurationError(['APP_SECRET']);
  // Payment, cron and upload configuration is checked by the relevant action.
  // Missing optional services must not take the public pages or admin offline.
  return { origin };
}

function configurationError(keys) {
  const error = new HttpError(503, 'The server is not configured.');
  error.configurationKeys = keys;
  return error;
}

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://images.unsplash.com https://*.public.blob.vercel-storage.com blob: data:; media-src 'self' https://*.public.blob.vercel-storage.com; connect-src 'self' https://blob.vercel-storage.com https://*.blob.vercel-storage.com; font-src 'self'; frame-src https://www.tiktok.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
