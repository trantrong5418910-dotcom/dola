/**
 * Ephemeral on-disk staging for reference images.
 *
 * Layout: admin/server/data/reference-uploads/<taskId>/<index>-<safeName>
 * Only metadata flags live in SQLite — never base64 blobs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCE_UPLOAD_ROOT = path.resolve(HERE, '..', 'data', 'reference-uploads');

const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g;

function safeSegment(value, fallback = 'file') {
  const cleaned = String(value || '').replace(SAFE_NAME_RE, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || fallback;
}

function assertSafeTaskId(taskId) {
  const id = String(taskId ?? '');
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error('invalid reference-image task id'), { code: 'REFERENCE_STORE_PATH' });
  }
  return id;
}

export function referenceImageDir(taskId) {
  const id = assertSafeTaskId(taskId);
  const dir = path.resolve(REFERENCE_UPLOAD_ROOT, id);
  if (!dir.startsWith(REFERENCE_UPLOAD_ROOT + path.sep) && dir !== REFERENCE_UPLOAD_ROOT) {
    throw Object.assign(new Error('reference-image path escape blocked'), { code: 'REFERENCE_STORE_PATH' });
  }
  return dir;
}

export async function saveReferenceImages(taskId, inspectedImages) {
  const dir = referenceImageDir(taskId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const [index, image] of inspectedImages.entries()) {
    const ext = image.mime === 'image/jpeg' ? '.jpg' : '.png';
    const base = safeSegment(image.filename.replace(/\.[^.]+$/, ''), `image-${index}`);
    const filename = `${String(index).padStart(2, '0')}-${base}${ext}`;
    const dest = path.join(dir, filename);
    if (!dest.startsWith(dir + path.sep)) {
      throw Object.assign(new Error('reference-image filename escape blocked'), { code: 'REFERENCE_STORE_PATH' });
    }
    await fs.writeFile(dest, image.buf, { mode: 0o600 });
    paths.push(dest);
  }
  return paths;
}

export async function listReferenceImages(taskId) {
  const dir = referenceImageDir(taskId);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => path.join(dir, name))
    .filter((filePath) => filePath.startsWith(dir + path.sep));
}

export async function cleanupReferenceImages(taskId) {
  const dir = referenceImageDir(taskId);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Remove staged uploads whose task is terminal, or whose task row is gone.
 * Safe to call from recoverStaleVideoTasks / periodic sweep.
 */
export async function sweepOrphanReferenceImages(db, { olderThanMs = 6 * 60 * 60 * 1000 } = {}) {
  let entries;
  try {
    entries = await fs.readdir(REFERENCE_UPLOAD_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0 };
    throw error;
  }
  const terminal = new Set(['ready', 'failed', 'cancelled']);
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const taskId = Number(entry.name);
    const row = db.prepare('SELECT status, updated_at, finished_at FROM dola_videos WHERE id = ?').get(taskId);
    const dir = path.join(REFERENCE_UPLOAD_ROOT, entry.name);
    let stale = !row;
    if (row && terminal.has(row.status)) stale = true;
    if (!stale && row) {
      const stamp = Date.parse(row.finished_at || row.updated_at || '') || 0;
      if (stamp && stamp < cutoff && ['queued', 'submitting', 'generating', 'resolving'].includes(row.status) === false) {
        stale = true;
      }
    }
    // Also sweep dirs that are very old even if the task is somehow stuck without files needed.
    if (!stale) {
      try {
        const stat = await fs.stat(dir);
        if (stat.mtimeMs < cutoff && (!row || terminal.has(row.status))) stale = true;
      } catch { /* ignore */ }
    }
    if (stale) {
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return { removed };
}
