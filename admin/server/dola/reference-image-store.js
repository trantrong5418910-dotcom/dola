/**
 * Ephemeral on-disk staging for reference images.
 *
 * Layout: admin/server/data/reference-uploads/<taskId>/<index>-<safeName>
 * Only metadata flags live in SQLite — never base64 blobs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
    // ★ 先剥掉源文件名里已有的「两位序号 + 横杠」前缀，再拼本次的序号。
    //   为什么必须剥：复用原任务参考图（失败任务「重新提交」）时，源文件名本身就是
    //   下面这行生成的 `00-xxx.png`，不剥就会落成 `00-00-xxx.png`；而「重新提交」可以
    //   反复嵌套，前缀会一层层叠上去（00-00-00-…），文件名越来越难认。
    //   只匹配 `^\d{2}-`（落盘格式就是 padStart(2,'0')），不误伤 `2026-xx.png` 这类真名。
    const base = safeSegment(
      image.filename.replace(/\.[^.]+$/, '').replace(/^\d{2}-/, ''),
      `image-${index}`,
    );
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
 * 列出某任务的参考图**元数据**（文件名 + 体积），供「重新提交」回填与任务详情渲染。
 *
 * 只回基名、不回绝对路径 —— 调用方是 HTTP 端点，服务器路径不该出现在响应体里。
 * @returns {Promise<Array<{name:string,size:number,path:string}>>}
 */
export async function listReferenceImageEntries(taskId) {
  const files = await listReferenceImages(taskId);
  const entries = [];
  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      entries.push({ name: path.basename(filePath), size: stat.size, path: filePath });
    } catch {
      /* 文件在枚举后被删掉 —— 跳过，不报错 */
    }
  }
  return entries;
}

/**
 * 把 URL 里的 `:name` 解析成一个**确认属于该任务目录**的真实文件路径。
 *
 * 防的是路径穿越（`../../.env`）。三道关：① `path.basename` 必须等于原值（含 `/`、`..`
 * 的一律不等，直接拒）；② 拼出来的路径必须落在任务目录内；③ 必须是
 * `listReferenceImages()` 枚举出来的真实条目 —— 光靠字符串检查挡不住符号链接之类，
 * 以目录实际内容为准最省心。
 *
 * @returns {Promise<string|null>} 可读的绝对路径，或 null（不存在/非法）
 */
export async function resolveReferenceImage(taskId, name) {
  const raw = String(name ?? '');
  if (!raw || raw.startsWith('.')) return null;
  const base = path.basename(raw.replace(/\\/g, '/'));
  if (base !== raw) return null;
  let dir;
  try {
    dir = referenceImageDir(taskId);
  } catch {
    return null;
  }
  const full = path.join(dir, base);
  if (!full.startsWith(dir + path.sep)) return null;
  const files = await listReferenceImages(taskId);
  return files.includes(full) ? full : null;
}

/** 缩略图存放的子目录（**在任务目录内部**，且以点开头）。
 *
 * 为什么不另开一个顶层目录：这样 `cleanupReferenceImages()` / 保留期回收
 * `fs.rm(dir, {recursive:true})` 会连缩略图一起带走，不必再维护第二套清理逻辑、
 * 也就不会出现「原图删了缩略图还在」的孤儿。
 * 为什么以点开头：`listReferenceImages()` 过滤掉点开头的条目，
 * 所以 `.thumbs` 不会被当成一张「参考图」列出来。 */
const REFERENCE_THUMB_SUBDIR = '.thumbs';

/** 缩略图最长边（像素）。详情面板的展示位是 92px，2x 屏要 ~184，取 256 留余量。 */
export const REFERENCE_THUMB_SIZE = 256;

/**
 * 取一张参考图的缩略图路径，没有就现生成一个（落盘缓存）。
 *
 * 为什么必须做：参考图动辄 4MB 一张（实测 4.47MB / 4.7 秒），而详情面板只要 92px 的
 * 展示位。直接送原图的话，打开一次面板就要拉 ~20MB —— 面板会空着转半分钟。
 * 实测同一张图：原图 4.47MB → 缩略图 16.6KB，生成耗时 0.23 秒（生成一次后走缓存）。
 *
 * **失败一律返回 null，由调用方回退到原图** —— 详情面板宁可慢，也不能整块空着。
 * 这也是为什么这里不用跑一个队列/任务：最坏情况只是回到改动前的行为。
 *
 * @returns {Promise<string|null>} 可读的缩略图绝对路径，或 null（生成不了就用原图）
 */
export async function ensureReferenceThumb(taskId, name, srcPath) {
  let dir;
  try {
    dir = path.join(referenceImageDir(taskId), REFERENCE_THUMB_SUBDIR);
  } catch {
    return null;
  }
  const raw = String(name ?? '');
  if (!raw || raw.startsWith('.')) return null;
  // 缩略图文件名沿用 safeSegment + 固定 .jpg 后缀：name 本身已经过
  // resolveReferenceImage 的三道关，这里再收一次口，避免拼出目录外的路径。
  const base = safeSegment(raw.replace(/\.[^.]+$/, ''), 'image');
  const dest = path.join(dir, `${base}.jpg`);
  if (!dest.startsWith(dir + path.sep)) return null;

  // 命中缓存：缩略图比源文件新（且非空）就直接用。源文件被换掉时 mtime 会后移，自然失效。
  try {
    const [srcStat, dstStat] = await Promise.all([fs.stat(srcPath), fs.stat(dest)]);
    if (dstStat.size > 0 && dstStat.mtimeMs >= srcStat.mtimeMs) return dest;
  } catch { /* 缓存不存在 —— 往下走生成 */ }

  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return (await renderThumbJpeg(srcPath, dest)) ? dest : null;
}

/**
 * 把 srcPath 缩成 size 像素的 JPEG 写到 destPath。成功 true，失败 false（调用方回退原图）。
 *
 * 抽出来是因为**两处**要用同一套 ImageMagick 参数，坑只该踩一遍：
 *   · 本文件 —— 任务暂存参考图，缩略图落在任务目录的 `.thumbs/`
 *   · reference-library.js —— 参考图库，缩略图按 sha256 落在库根的 `.thumbs/`
 * 两边都遇到「为一小块展示位送 4MB 原图」的同一个问题（图库选择器 14 张 = 57MB，
 * 点一下要等 10 秒，看起来就像坏了）。
 */
export async function renderThumbJpeg(srcPath, destPath, size = REFERENCE_THUMB_SIZE) {
  // 先写临时文件再 rename：并发请求同一张图时，谁都不会读到写了一半的文件。
  const tmp = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  // `-thumbnail 256x256>` 的 `>` 是「只缩不放」，避免小图被拉大成糊图加大体积；
  // `jpg:` 前缀强制按 JPEG 输出 —— 否则 ImageMagick 会按 .tmp 后缀猜格式而报错。
  // `-strip` 去掉 EXIF/ICC，体积更小，也顺带不给他人留拍摄信息。
  const args = ['-auto-orient', '-thumbnail', `${size}x${size}>`,
    '-strip', '-quality', '82', `jpg:${tmp}`];
  // IM7 的正名是 magick，IM6 只有 convert；两种环境都可能遇到，挨个试。
  for (const bin of ['magick', 'convert']) {
    try {
      await run(bin, [srcPath, ...args], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      await fs.rename(tmp, destPath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;   // 这个二进制不存在 → 试下一个
      break;                                     // 别的错（超时/图片损坏）→ 直接放弃
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
  return false;
}

/**
 * 终态任务的参考图保留期。超期才回收 —— 见下面的语义说明。
 *
 * 为什么是 24 小时：这是「失败任务重新提交」复用原图的可用窗口。太短（比如 1 小时）
 * 用户睡一觉起来失败任务的图就没了；太长则失败任务的图会长期占盘（单任务上限 20MiB）。
 */
export const REFERENCE_RETENTION_MS = 24 * 60 * 60 * 1000;

const ACTIVE_STATUSES = new Set(['queued', 'submitting', 'generating', 'resolving']);

/**
 * 回收暂存的参考图目录。**注意判据已经改过，别再按老印象理解。**
 *
 * ★ 2026-09-29 语义变更（这是重点）：
 *   原判据是「任务一旦落终态（ready/failed/cancelled）就删」。它和「失败任务重新提交」
 *   这个需求直接冲突 —— 失败任务的图当场消失，复用必然落空。现在改成**保留期模型**：
 *     · 在途任务（queued/submitting/generating/resolving）的图**永不**回收
 *       （提交链路还在读它，删了会变成「参考图文件缺失，无法提交」）；
 *     · 终态任务的图保留 REFERENCE_RETENTION_MS，超期才删。失败任务因此有一段
 *       可被「重新提交」复用的窗口；
 *     · 任务行已经不存在的孤儿目录，也按同一时间门槛处理 —— 不给「DB 抖动时
 *      查不到行、于是把好图删了」留机会。
 *
 *   判据统一落在**目录 mtime** 上：`saveReferenceImages()` 写入的就是这次 mtime，
 *   不需要额外维护时间戳，也不会因为 WAL 里任务行的时间格式变化而失效。
 *
 * @returns {Promise<{removed:number, kept:number}>}
 */
export async function sweepOrphanReferenceImages(db, { retentionMs = REFERENCE_RETENTION_MS } = {}) {
  let entries;
  try {
    entries = await fs.readdir(REFERENCE_UPLOAD_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0, kept: 0 };
    throw error;
  }
  const cutoff = Date.now() - retentionMs;
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const taskId = Number(entry.name);
    const dir = path.join(REFERENCE_UPLOAD_ROOT, entry.name);
    const row = db.prepare('SELECT status FROM dola_videos WHERE id = ?').get(taskId);
    // 在途任务：图还活着（或即将被提交链路读取），任何情况下都不回收。
    if (row && ACTIVE_STATUSES.has(row.status)) { kept += 1; continue; }
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      continue;   // 目录刚被别的路径删掉/读不到，跳过
    }
    if (mtimeMs >= cutoff) { kept += 1; continue; }
    await fs.rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, kept };
}
