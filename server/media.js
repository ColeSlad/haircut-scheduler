import { createReadStream } from 'node:fs';

export function sendVideo(req, res, path, size) {
  const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=3600', 'Accept-Ranges': 'bytes' };
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (req.method === 'GET' && req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const first = range?.[1];
    const last = range?.[2];
    if (first) {
      start = Number(first);
      if (last) end = Math.min(Number(last), end);
    } else if (last) start = Math.max(0, size - Number(last));
    if (!range || (!first && !last) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size || (!first && Number(last) === 0)) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !size) return res.end();
  const stream = createReadStream(path, { start, end });
  stream.on('error', (error) => res.destroy(error));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
