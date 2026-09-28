/**
 * 参考图库：把参考图**收进我们自己的磁盘**，作为主工作台与脚本分镜页的统一来源。
 *
 * 与 `reference-image-store.js` 的分工（两者都在 data/ 下，但语义完全不同，别混）：
 *   · `reference-uploads/<taskId>/` 是**一次性暂存**：任务提交时把参考图摊到磁盘上
 *     给 Playwright 的 setInputFiles 用，任务终态后就被 sweep 掉。
 *   · `reference-library/` 是**长期资产**：用户主动收进来的图，跨任务复用，
 *     只有显式删除才消失。
 *
 * 存储分层：元数据在 SQLite（dola_reference_images），字节在磁盘。
 * 文件名用 **sha256 内容寻址**（<sha256>.<ext>）：
 *   · 天然去重 —— 同一张图上传两次，字节落在同一个文件上，不会有两份；
 *   · 不需要先插入行拿到 id 再改名，写盘与入库的先后顺序不再是问题；
 *   · 路径只由十六进制字符组成，不存在路径穿越面。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectImage } from './reference-images.js';
// 缩略图复用任务暂存那套 ImageMagick 参数（见 renderThumbJpeg 的注释）——
// 两个模块没有互相 import，不存在循环依赖。
import { renderThumbJpeg } from './reference-image-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCE_LIBRARY_ROOT = path.resolve(HERE, '..', 'data', 'reference-library');

/** 从远端抓参考图的上限。与 reference-images.js 的 IMAGE_MAX_TOTAL_BYTES 同量级。 */
export const REMOTE_FETCH_TIMEOUT_MS = 30_000;
export const REMOTE_FETCH_MAX_BYTES = 12 * 1024 * 1024;

export const REFERENCE_SOURCES = new Set(['upload', 'url', 'shot', 'material']);

function fail(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function extFor(mime) {
  return mime === 'image/jpeg' ? '.jpg' : '.png';
}

export function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 库文件的绝对路径。只由 sha256 + 扩展名拼成，不接受外部输入。 */
export function libraryFilePath(row) {
  const hash = String(row?.sha256 || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw fail('参考图库记录缺少有效的 sha256，无法定位文件', 500, 'REFERENCE_LIBRARY_PATH');
  }
  const file = path.join(REFERENCE_LIBRARY_ROOT, `${hash}${extFor(row.mime)}`);
  if (!file.startsWith(REFERENCE_LIBRARY_ROOT + path.sep)) {
    throw fail('参考图库路径越界', 500, 'REFERENCE_LIBRARY_PATH');
  }
  return file;
}

/**
 * 把一张图收进库。**幂等**：同样的字节已经在库里时直接返回已有那条。
 *
 * @param {object} p
 * @param {Buffer} p.buf       图片字节（未校验，本函数内部走 inspectImage 校验）
 * @param {string} [p.name]    显示名
 * @param {string} [p.source]  upload | url | shot | material
 * @param {string} [p.originUrl] 来源直链（source=url/shot 时有意义）
 * @param {number} [p.scriptShotId] 来源分镜（source=shot 时）
 * @param {number} [p.createdBy]
 * @param {string} [p.tags]
 * @param {object} p.db        SQLite 句柄
 * @returns {{ row: object, duplicated: boolean }}
 */
export async function storeReferenceImage({
  buf, name = '', source = 'upload', originUrl = '', scriptShotId = null,
  createdBy = null, tags = '', db,
}) {
  if (!db) throw fail('参考图库缺少数据库句柄', 500, 'REFERENCE_LIBRARY_DB');
  const kind = REFERENCE_SOURCES.has(String(source)) ? String(source) : 'upload';
  // 校验放在写盘之前：非 JPG/PNG、超大、尺寸读不出来都在这里被挡掉。
  const inspected = inspectImage(buf, name || 'reference');
  const hash = sha256Of(inspected.buf);

  const existing = db.prepare('SELECT * FROM dola_reference_images WHERE sha256 = ?').get(hash);
  if (existing) {
    // 已在库里：**不覆盖**已有元数据（用户可能已经改过名/打过标签），
    // 只把「最后一次从哪来的」补上去，避免同一张图有两条记录。
    const at = new Date().toISOString();
    db.prepare('UPDATE dola_reference_images SET origin_url=?, script_shot_id=COALESCE(?, script_shot_id), updated_at=? WHERE id=?')
      .run(String(originUrl || existing.origin_url || '').slice(0, 2048),
        scriptShotId ?? null, at, existing.id);
    return { row: db.prepare('SELECT * FROM dola_reference_images WHERE id=?').get(existing.id), duplicated: true };
  }

  await fs.mkdir(REFERENCE_LIBRARY_ROOT, { recursive: true, mode: 0o700 });
  const dest = path.join(REFERENCE_LIBRARY_ROOT, `${hash}${extFor(inspected.mime)}`);
  // 内容寻址：同名文件就是同内容，重复写不会破坏什么，但能省则省。
  try {
    await fs.access(dest);
  } catch {
    await fs.writeFile(dest, inspected.buf, { mode: 0o600 });
  }

  const at = new Date().toISOString();
  let insertedId;
  try {
    insertedId = Number(db.prepare(`INSERT INTO dola_reference_images
      (name, source, origin_url, local_path, mime, bytes, width, height, sha256, tags, script_shot_id, use_count, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(
      String(name || inspected.filename || '参考图').trim().slice(0, 120) || '参考图',
      kind,
      String(originUrl || '').slice(0, 2048),
      dest,
      inspected.mime,
      inspected.buf.length,
      inspected.width,
      inspected.height,
      hash,
      String(tags || '').slice(0, 300),
      scriptShotId ?? null,
      createdBy ?? null,
      at, at,
    ).lastInsertRowid);
  } catch (error) {
    // 并发兜底：一次出图会**并行**收录 4 张，万一上游返回了两张字节完全相同的图，
    // 两个 insert 会同时走到这里，其中一个撞上 sha256 唯一索引。
    // 那不是错误 —— 内容一样就该只留一条，回读已有的那条即可。
    if (!/UNIQUE/i.test(String(error?.message || ''))) throw error;
    const raced = db.prepare('SELECT * FROM dola_reference_images WHERE sha256 = ?').get(hash);
    if (!raced) throw error;
    return { row: raced, duplicated: true };
  }
  return { row: db.prepare('SELECT * FROM dola_reference_images WHERE id=?').get(insertedId), duplicated: false };
}

/** 读回库文件的字节。文件被外部删掉时报错，不静默返回空。 */
export async function readReferenceImage(row) {
  const file = libraryFilePath(row);
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw fail('参考图文件已不在磁盘上（可能被手工清理过），请删除这条记录后重新上传', 410, 'REFERENCE_LIBRARY_FILE_MISSING');
    }
    throw error;
  }
  return { buf, mime: row.mime || 'image/png', filename: `${row.name || 'reference'}${extFor(row.mime)}` };
}

/**
 * 库缩略图存在库根的 `.thumbs/`，文件名是 `<sha256>.jpg` —— 与库文件同样是
 * **内容寻址**，所以同一张图永远对应同一个缩略图，可以放心长缓存（Response 里
 * 那行 `immutable` 就是靠这个成立的）。
 *
 * 为什么以点开头：与 reference-image-store.js 同一条理由 —— 任何列目录的地方
 * 都会跳过点开头的条目，`.thumbs` 不会被当成一张「参考图」。
 *
 * 为什么要做这件事（2026-09-29 实测）：图库页与「从参考图库选」的卡片展示位只有
 * 几十像素，却一直在送**原图**。14 张图 = 57MB 同时下载，表现有两种，都很难看：
 *   · 图库页十四个卡片里十三个是空框（原图还在路上）；
 *   · 选择器里点「加入参考图」要等 ~11 秒才出结果，中途按钮只有「加入中…」，
 *     用户会以为这个入口坏了 / 是空的。
 * 缩略图之后单张 16KB 量级，两个现象一起消失。
 */
const REFERENCE_LIBRARY_THUMB_SUBDIR = '.thumbs';

/** 缩略图最长边（像素）。图库卡片展示位小，选择器卡片 58px，256 在 2x 屏也够。 */
export const REFERENCE_LIBRARY_THUMB_SIZE = 256;

/**
 * 取库图的缩略图路径，没有就现生成一个（落盘缓存）。
 *
 * **失败一律返回 null，由调用方回退原图** —— 缩略图生成不了（没装 ImageMagick、
 * 图损坏）只是慢一点，绝不能变成「图全是碎的」。
 *
 * @returns {Promise<string|null>} 可读的缩略图绝对路径，或 null
 */
export async function ensureLibraryThumb(row) {
  const hash = String(row?.sha256 || '');
  // 与 libraryFilePath 同一道关：路径只由 64 位十六进制拼成，不接受外部输入。
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const dir = path.join(REFERENCE_LIBRARY_ROOT, REFERENCE_LIBRARY_THUMB_SUBDIR);
  const dest = path.join(dir, `${hash}.jpg`);
  if (!dest.startsWith(dir + path.sep)) return null;

  let srcPath;
  try {
    srcPath = libraryFilePath(row);
  } catch {
    return null;
  }

  // 命中缓存：缩略图比原图新（且非空）就直接用。原图按 sha256 寻址、内容永不改变，
  // 理论上永不失效；仍比 mtime 是为了兼容「有人手工替换过同名文件」。
  try {
    const [srcStat, dstStat] = await Promise.all([fs.stat(srcPath), fs.stat(dest)]);
    if (dstStat.size > 0 && dstStat.mtimeMs >= srcStat.mtimeMs) return dest;
  } catch { /* 缓存不存在 —— 往下走生成 */ }

  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return (await renderThumbJpeg(srcPath, dest, REFERENCE_LIBRARY_THUMB_SIZE)) ? dest : null;
}

/**
 * 删库记录时连带删文件。**只有当没有别的记录指向同一份文件时才删** ——
 * 内容寻址下两份记录理论上不可能同 sha256（唯一索引挡着），但删除顺序上
 * 仍然先查一遍，避免以后放开去重策略时误删别人还在用的文件。
 */
export async function deleteReferenceImageFile(row, db) {
  const file = libraryFilePath(row);
  const others = db.prepare('SELECT COUNT(*) AS n FROM dola_reference_images WHERE sha256=? AND id<>?')
    .get(String(row.sha256 || ''), row.id);
  if (Number(others?.n) > 0) return { removed: false, reason: 'shared' };
  // 缩略图跟着原图一起删：它是以 sha256 命名的，原图没了就是孤儿（库里不扫目录，
  // 留着不会报错，但白占磁盘）。
  await fs.rm(path.join(REFERENCE_LIBRARY_ROOT, REFERENCE_LIBRARY_THUMB_SUBDIR, `${String(row.sha256)}.jpg`),
    { force: true }).catch(() => {});
  try {
    await fs.unlink(file);
    return { removed: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: false, reason: 'missing' };
    throw error;
  }
}

/**
 * 从远端直链抓一张图。**不走代理**：dola 的图片在公开 CDN 上，
 * 与成片归档（generator.js 的 archiveVideo）同一口径，避免把大流量记到代理上。
 *
 * 边读边截断：Content-Length 不可信（可能没有，也可能撒谎），
 * 所以真正的上限判定在累计字节数上。
 */
export async function fetchRemoteImage(url, { timeoutMs = REMOTE_FETCH_TIMEOUT_MS } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw fail('参考图直链不是合法的 URL', 400, 'REFERENCE_LIBRARY_URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw fail('参考图直链只支持 http(s)', 400, 'REFERENCE_LIBRARY_URL');
  }

  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.round(Number(timeoutMs)) : REMOTE_FETCH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('下载参考图超时')), budget);
  try {
    const res = await fetch(parsed.toString(), { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw fail(`下载参考图失败：上游返回 HTTP ${res.status}`, 502, 'REFERENCE_LIBRARY_FETCH');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > REMOTE_FETCH_MAX_BYTES) {
        throw fail(`参考图超过 ${(REMOTE_FETCH_MAX_BYTES / 1048576).toFixed(0)} MB 上限，已中止下载`, 400, 'REFERENCE_LIBRARY_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw fail('下载到的参考图是空文件', 502, 'REFERENCE_LIBRARY_FETCH');
    return buf;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw fail(`下载参考图超时（${Math.round(budget / 1000)} 秒）`, 504, 'REFERENCE_LIBRARY_FETCH');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 库记录 → 接口返回结构。localPath 不外泄，只给可鉴权访问的 file 路由。 */
export function publicReferenceImage(row) {
  return {
    id: row.id,
    name: row.name || '',
    source: row.source || 'upload',
    originUrl: row.origin_url || '',
    mime: row.mime || '',
    bytes: Number(row.bytes) || 0,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    sha256: row.sha256 || '',
    tags: row.tags || '',
    scriptShotId: row.script_shot_id ?? null,
    useCount: Number(row.use_count) || 0,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 前端直接用它当 img.src（带 Bearer 的 fetch 不方便放进 img），
    // 所以下面这条路由必须接受 ?token= 查询参数鉴权。
    fileUrl: `/api/reference-images/${row.id}/file`,
  };
}
