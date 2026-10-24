import { HttpError } from './scheduling.js';

export function tiktokVideoUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Enter a full TikTok video link from @l2cuts.'); }
  const match = /^\/@l2cuts\/video\/(\d{15,25})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname) || url.port || url.username || url.password || !match) {
    throw new HttpError(400, 'Use a TikTok video link from https://www.tiktok.com/@l2cuts.');
  }
  return `https://www.tiktok.com/@l2cuts/video/${match[1]}`;
}
