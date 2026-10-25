import { HttpError } from './scheduling.js';
import { paymentProvider } from './payments.js';
import { trustedBlobUrl } from './storage.js';

export function runtimeConfig(env = process.env) {
  if (env.VERCEL_ENV === 'preview' && !(env.VERCEL_BRANCH_URL || env.VERCEL_URL)) throw new HttpError(503, 'The server is not configured.');
  const origin = env.VERCEL_ENV === 'preview' ? `https://${env.VERCEL_BRANCH_URL || env.VERCEL_URL}` : env.APP_ORIGIN;
  let url;
  try { url = new URL(origin); } catch { throw new HttpError(503, 'The server is not configured.'); }
  if (url.origin !== origin || url.protocol !== 'https:' || !env.DATABASE_URL || !env.CRON_SECRET || env.CRON_SECRET.length < 32 ||
    !env.BLOB_READ_WRITE_TOKEN || !trustedBlobUrl(`${env.BLOB_PUBLIC_ORIGIN}/photos/config.jpg`, env.BLOB_PUBLIC_ORIGIN)) throw new HttpError(503, 'The server is not configured.');
  paymentProvider(env);
  if (env.VERCEL_ENV === 'preview' && !env.VERCEL_AUTOMATION_BYPASS_SECRET) throw new HttpError(503, 'Preview callbacks are not configured.');
  return { origin };
}

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://images.unsplash.com https://*.public.blob.vercel-storage.com blob: data:; media-src 'self' https://*.public.blob.vercel-storage.com; connect-src 'self' https://blob.vercel-storage.com https://*.blob.vercel-storage.com; font-src 'self'; frame-src https://www.tiktok.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
