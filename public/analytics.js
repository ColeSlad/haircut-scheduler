import { inject } from '@vercel/analytics';

const publicPages = new Set(['/', '/schedule', '/gallery', '/reviews', '/privacy', '/terms']);

export function analyticsPageview(event) {
  if (event?.type !== 'pageview') return null;
  try {
    const url = new URL(event.url);
    if (!['https:', 'http:'].includes(url.protocol) || !publicPages.has(url.pathname)) return null;
    // Keep contact details, payment returns, and private link fragments out of URLs.
    return { type: 'pageview', url: `${url.origin}${url.pathname}` };
  } catch { return null; }
}

if (import.meta.env?.VERCEL_ENV === 'production') {
  inject({ mode: 'production', beforeSend: analyticsPageview });
}
