import fs from 'node:fs';
import { stat } from 'node:fs/promises';

export function parseVideoRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(n => n !== null && !Number.isSafeInteger(n))) return false;
  if (first === null) {
    if (last <= 0) return false;
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const end = last === null ? size - 1 : Math.min(last, size - 1);
  return first >= size || first > end ? false : { start: first, end };
}

/** Same authenticated response supports preview seeking and attachment downloads. */
export async function streamVideoFile(req, res, { file, filename, isUnwatermarked = false }) {
  let info;
  try { info = await stat(file); } catch { return res.status(410).json({ ok: false, message: '归档文件已丢失' }); }
  if (!info.isFile()) return res.status(410).json({ ok: false, message: '归档文件不可用' });
  const range = parseVideoRange(req.headers.range, info.size);
  if (range === false) return res.status(416).set('Content-Range', `bytes */${info.size}`).end();
  const headers = {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    ...(isUnwatermarked ? { 'X-Video-Unwatermarked': '1' } : {}),
    ...(req.query.download === '1' ? { 'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"` } : {}),
  };
  if (range) Object.assign(headers, { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`, 'Content-Length': range.end - range.start + 1 });
  else headers['Content-Length'] = info.size;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, range || {});
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
