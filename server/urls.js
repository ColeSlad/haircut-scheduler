export function callbackUrl(origin, path, env = process.env) {
  const url = new URL(path, origin);
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_AUTOMATION_BYPASS_SECRET) url.searchParams.set('x-vercel-protection-bypass', env.VERCEL_AUTOMATION_BYPASS_SECRET);
  return url.href;
}
