/**
 * 参考图库 —— 挂载在 `/api/reference-images`。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 它解决什么问题
 * ─────────────────────────────────────────────────────────────────────────
 * 参考图原本只有一条来源：**在主工作台的 <input type=file> 里现场选文件**。
 * 后果有三个：
 *   ① 分镜页完全没有参考图能力 —— 明明刚出了一张很合适的分镜图，用不上；
 *   ② 每次都要重新选文件，运营手上真正会复用的那几张（角色定妆、产品图、
 *      风格参考）没有任何地方存；
 *   ③ 分镜图出在**上游 CDN 的临时直链**上，直接拿它当参考图引用，
 *      隔天就 403 —— 上游把签名参数作废了。
 *
 * 所以这里做一个**统一来源**：图收进我们自己的磁盘（内容寻址 + sha256 去重），
 * 主工作台和分镜页都从它取。分镜图想当参考图，先「收进图库」，字节就归我们了。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三条不能违背的规矩（沿用本项目既有约定）
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **字节不进 SQLite。** 单张参考图可以到 8 MB，塞进库会把 admin.db 撑爆、
 *    备份变慢、每次 SELECT * 都要读一遍大字段。元数据在库，文件在
 *    `data/reference-library/`（见 dola/reference-library.js）。
 * 2. **<img src> 不带 Authorization 头。** 所以图片走**短期凭证**通道
 *    （`POST /ticket` + `GET /stream/:ticket/:id`），而不是把后台 JWT 塞进 query。
 *    与成片库 `/api/media/stream/:ticket` 同一套做法，理由见 media-routes.js 的注释。
 * 3. **下载远端图不走代理。** dola 的图在公开 CDN 上，与账号 IP 无关；
 *    走住宅代理纯烧钱（和成片归档同一条理由，见 generator.js 的 archiveVideo）。
 */

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit, paged } from '../audit.js';
import {
  storeReferenceImage, readReferenceImage, deleteReferenceImageFile,
  fetchRemoteImage, publicReferenceImage, ensureLibraryThumb,
} from '../dola/reference-library.js';

const router = express.Router();

/**
 * ⚠️ 这里**不能**直接写 `router.use(requireAuth)`。
 *
 * 凭证通道（`/stream/:ticket/:id`）必须放过 —— 浏览器给 <img src> 发的请求
 * **根本带不上 Authorization 头**，一律要求登录会让每一张缩略图都 401，
 * 而现象是「图库页面全是碎图」，看起来像文件坏了。
 * 凭证本身就是鉴权（随机 144 bit + 10 分钟 + 只有登录过的管理员能领到），
 * 与成片库的 `/api/media/stream/:ticket` 同一口径。
 */
router.use((req, res, next) => {
  if (/^\/stream\/[^/]+\/\d+$/.test(req.path)) return next();
  return requireAuth(req, res, next);
});

const now = () => new Date().toISOString();

/** 单张上传的 base64 长度上限。与素材库同口径（8 MB 原始字节）。 */
const MAX_BASE64_CHARS = 11 * 1024 * 1024;

function bad(message, status = 400, code = 'REFERENCE_LIBRARY_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function jsonError(res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  // 500 只回一句通用话术：内部错误信息（栈/路径）不该出现在接口响应里。
  const message = status === 500 ? '参考图处理失败，请查看后台日志后重试' : error.message;
  return res.status(status).json({ ok: false, message, ...(error.code ? { code: error.code } : {}) });
}

function asId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function findRow(id) {
  return id ? (db.prepare('SELECT * FROM dola_reference_images WHERE id=?').get(id) || null) : null;
}

function cleanName(raw, fallback = '参考图') {
  return String(raw ?? '').trim().slice(0, 120) || fallback;
}
function cleanTags(raw) {
  return String(raw ?? '').trim().slice(0, 300);
}

// ───────────────────────────────────────────────────────────────────────────
// 短期读取凭证（见文件头规矩 2）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 凭证是**会话级**的（一张凭证能读库里任意一张图），而不是每张图一张。
 * 为什么：图库页面一屏就有几十个缩略图，逐张换凭证 = 几十次往返，
 * 翻页时还得重来一遍。凭证本身随机 144 bit、绑定发起人、10 分钟过期，
 * 泄露面与「一张一凭证」没有实质差别。
 */
const TICKET_TTL_MS = 10 * 60_000;
const TICKET_MAX = 200;
const tickets = new Map();

function issueTicket(userId) {
  const cutoff = Date.now() - TICKET_TTL_MS;
  for (const [k, v] of tickets) if (v.expMs < cutoff) tickets.delete(k);
  while (tickets.size >= TICKET_MAX) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
  const ticket = crypto.randomBytes(18).toString('base64url');
  tickets.set(ticket, { userId: userId ?? null, expMs: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function resolveTicket(raw) {
  const key = String(raw || '');
  const rec = tickets.get(key);
  if (!rec) return null;
  if (rec.expMs < Date.now()) { tickets.delete(key); return null; }
  return rec;
}

// ───────────────────────────────────────────────────────────────────────────
// 列表 / 详情
// ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/reference-images —— 图库列表。
 * query: keyword（搜名称/标签）/ source / page / pageSize
 *
 * **不返回字节、不返回本地路径**，只给 fileUrl（走凭证通道）。
 */
router.get('/', requirePerm('refimage:list'), (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const source = String(req.query.source || '').trim();
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 24));

  const where = [];
  const params = [];
  if (keyword) {
    where.push('(name LIKE ? OR tags LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (['upload', 'url', 'shot', 'material'].includes(source)) {
    where.push('source = ?');
    params.push(source);
  }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { items, total } = paged(
    `SELECT * FROM dola_reference_images ${sql} ORDER BY id DESC`,
    `SELECT COUNT(*) AS c FROM dola_reference_images ${sql}`,
    params,
    { page, pageSize },
  );

  // 磁盘占用：数字对不上就说明有孤儿文件或有文件被外部删了（与成片库 stats 同口径）。
  const diskBytes = Number(db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM dola_reference_images').get()?.n) || 0;
  res.json({ ok: true, items: items.map(publicReferenceImage), total, page, pageSize, diskBytes });
});

/** GET /api/reference-images/:id —— 单条。 */
router.get('/:id', requirePerm('refimage:list'), (req, res) => {
  const row = findRow(asId(req.params.id));
  if (!row) return res.status(404).json({ ok: false, message: '参考图不存在' });
  res.json({ ok: true, item: publicReferenceImage(row) });
});

// ───────────────────────────────────────────────────────────────────────────
// 入库：上传 / 粘贴直链 / 从分镜图收进来
// ───────────────────────────────────────────────────────────────────────────

/**
 * POST /api/reference-images —— 后台上传一张图。
 * body: { name?, tags?, mime?, filename?, dataBase64 }
 *
 * 与素材库不同，这里**校验真的解码一次**（inspectImage 在 storeReferenceImage 里跑），
 * 所以前端传的 mime 只是提示，以字节里的魔数为准。
 */
router.post('/', requirePerm('refimage:create'), async (req, res) => {
  try {
    const dataBase64 = String(req.body?.dataBase64 || req.body?.data || '');
    if (!dataBase64) throw bad('请提供图片数据（dataBase64）');
    if (dataBase64.length > MAX_BASE64_CHARS) throw bad('单张参考图不能超过 8 MB');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(dataBase64)) throw bad('图片数据不是合法的 base64');
    const buf = Buffer.from(dataBase64, 'base64');
    if (!buf.length) throw bad('图片数据解码后为空');

    const { row, duplicated } = await storeReferenceImage({
      buf,
      name: cleanName(req.body?.name || req.body?.filename),
      source: 'upload',
      tags: cleanTags(req.body?.tags),
      createdBy: req.user?.id ?? null,
      db,
    });
    audit(req, 'refimage.upload', 'dola_reference_image', row.id,
      { name: row.name, bytes: row.bytes, duplicated });
    return res.status(duplicated ? 200 : 201).json({
      ok: true, duplicated, item: publicReferenceImage(row),
      message: duplicated ? '这张图已经在图库里了，直接复用（未新增记录）' : '已收进参考图库',
    });
  } catch (error) { return jsonError(res, error); }
});

/**
 * POST /api/reference-images/from-url —— 把一条直链抓进图库。
 * body: { url, name?, tags? }
 *
 * ★ 这是「分镜图当参考图」的关键一步：分镜图的直链是上游 CDN 的**临时签名链接**，
 *   直接引用会过期。抓进图库 = 字节落到我们磁盘上，从此不依赖上游。
 */
router.post('/from-url', requirePerm('refimage:create'), async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) throw bad('请提供图片直链（url）');
    const buf = await fetchRemoteImage(url);
    const { row, duplicated } = await storeReferenceImage({
      buf,
      name: cleanName(req.body?.name || `直链图 ${new Date().toISOString().slice(0, 10)}`),
      source: 'url',
      originUrl: url,
      tags: cleanTags(req.body?.tags),
      createdBy: req.user?.id ?? null,
      db,
    });
    audit(req, 'refimage.from_url', 'dola_reference_image', row.id, { url: url.slice(0, 200), duplicated });
    return res.status(duplicated ? 200 : 201).json({
      ok: true, duplicated, item: publicReferenceImage(row),
      message: duplicated ? '这条直链的图已经在图库里了，直接复用' : '已从直链收进参考图库',
    });
  } catch (error) { return jsonError(res, error); }
});

/**
 * POST /api/reference-images/from-shot —— 把某个分镜的图收进图库。
 * body: { scriptId, seq, url?, name? }
 *
 * `url` 省略时用分镜**当前**的 image_path；传了就用那张（可以是出图历史里的别的候选）。
 * 服务端校验该 url 必须属于这个分镜（当前图或在某一批历史里），
 * 否则可以把任意 URL 塞进来、并挂上一个假出处 —— 那让「来源」字段变成谎言。
 */
router.post('/from-shot', requirePerm('refimage:create'), async (req, res) => {
  try {
    const scriptId = asId(req.body?.scriptId);
    const seq = asId(req.body?.seq);
    if (!scriptId || !seq) throw bad('请提供 scriptId 与 seq');
    const shot = db.prepare('SELECT * FROM dola_script_shots WHERE script_id=? AND seq=?').get(scriptId, seq);
    if (!shot) throw bad('分镜不存在', 404, 'SHOT_NOT_FOUND');

    const wanted = String(req.body?.url || '').trim();
    let url = wanted;
    if (url) {
      let allowed = [String(shot.image_path || '')].filter(Boolean);
      const batches = db.prepare('SELECT images FROM dola_script_shot_images WHERE shot_id=?').all(shot.id);
      for (const batch of batches) {
        try {
          const list = JSON.parse(batch.images || '[]');
          if (Array.isArray(list)) allowed = allowed.concat(list.map((i) => String(i?.url || '')));
        } catch { /* 单批坏数据不影响其它批 */ }
      }
      if (!allowed.includes(url)) {
        throw bad('这张图不属于该分镜（既不是当前图，也不在任何一批出图历史里）', 400, 'IMAGE_NOT_IN_SHOT');
      }
    } else {
      url = String(shot.image_path || '');
    }
    if (!url) throw bad('这个分镜还没有出过图，先把分镜图收进图库吧', 409, 'SHOT_HAS_NO_IMAGE');

    const buf = await fetchRemoteImage(url);
    const { row, duplicated } = await storeReferenceImage({
      buf,
      name: cleanName(req.body?.name || `分镜 ${seq} 的图`),
      source: 'shot',
      originUrl: url,
      scriptShotId: shot.id,
      createdBy: req.user?.id ?? null,
      db,
    });
    audit(req, 'refimage.from_shot', 'dola_reference_image', row.id, { scriptId, seq, duplicated });
    return res.status(duplicated ? 200 : 201).json({
      ok: true, duplicated, item: publicReferenceImage(row),
      message: duplicated ? '这张分镜图已经在图库里了，直接复用' : '已把分镜图收进参考图库',
    });
  } catch (error) { return jsonError(res, error); }
});

// ───────────────────────────────────────────────────────────────────────────
// 改名 / 打标签 / 删除
// ───────────────────────────────────────────────────────────────────────────

/** PATCH /api/reference-images/:id —— 改显示名与标签。 */
router.patch('/:id', requirePerm('refimage:update'), (req, res) => {
  try {
    const id = asId(req.params.id);
    const row = findRow(id);
    if (!row) throw bad('参考图不存在', 404, 'REFERENCE_LIBRARY_NOT_FOUND');
    const name = Object.hasOwn(req.body || {}, 'name') ? cleanName(req.body.name) : row.name;
    const tags = Object.hasOwn(req.body || {}, 'tags') ? cleanTags(req.body.tags) : row.tags;
    db.prepare('UPDATE dola_reference_images SET name=?, tags=?, updated_at=? WHERE id=?')
      .run(name, tags, now(), id);
    audit(req, 'refimage.update', 'dola_reference_image', id, { name, tags });
    return res.json({ ok: true, item: publicReferenceImage(findRow(id)) });
  } catch (error) { return jsonError(res, error); }
});

/**
 * DELETE /api/reference-images/:id —— 删记录 + 删文件。
 *
 * ⚠️ **不检查是否被分镜引用**（这是有意的）：引用存的是「指向」，
 * 指向的图没了，提交视频任务时会明确报「参考图不存在」并拒绝提交
 * （见 routes/scripts.js 的 resolveShotReferenceImages）—— 是**显式失败**，
 * 不是静默换一张。删除时提示引用数，让操作员自己决定。
 */
router.delete('/:id', requirePerm('refimage:delete'), async (req, res) => {
  try {
    const id = asId(req.params.id);
    const row = findRow(id);
    if (!row) throw bad('参考图不存在', 404, 'REFERENCE_LIBRARY_NOT_FOUND');
    const usedBy = countShotReferences(id);
    db.prepare('DELETE FROM dola_reference_images WHERE id=?').run(id);
    const removed = await deleteReferenceImageFile(row, db).catch((e) => ({ removed: false, reason: e.message }));
    audit(req, 'refimage.delete', 'dola_reference_image', id,
      { name: row.name, usedBy, fileRemoved: Boolean(removed?.removed) });
    return res.json({
      ok: true,
      fileRemoved: Boolean(removed?.removed),
      usedBy,
      message: usedBy
        ? `已删除。有 ${usedBy} 个分镜把它当参考图，下次给那些分镜提交视频时会报「参考图不存在」，需要重新选。`
        : '已删除',
    });
  } catch (error) { return jsonError(res, error); }
});

/** 有多少个分镜引用了这张图。reference_images 是 JSON 文本，只能扫一遍 —— 图库量级下没问题。 */
function countShotReferences(id) {
  const rows = db.prepare("SELECT reference_images FROM dola_script_shots WHERE TRIM(COALESCE(reference_images,'')) NOT IN ('', '[]')").all();
  let n = 0;
  for (const r of rows) {
    try {
      const list = JSON.parse(r.reference_images || '[]');
      if (Array.isArray(list) && list.some((x) => x?.kind === 'library' && Number(x.id) === Number(id))) n += 1;
    } catch { /* 坏数据跳过 */ }
  }
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// 凭证 + 流式读取
// ───────────────────────────────────────────────────────────────────────────

/**
 * POST /api/reference-images/ticket —— 换一张 10 分钟有效的读取凭证。
 * 返回 `streamBase`，前端拼成 `${streamBase}/${id}` 直接塞进 <img src>。
 */
router.post('/ticket', requirePerm('refimage:list'), (req, res) => {
  const ticket = issueTicket(req.user?.id ?? null);
  res.json({
    ok: true,
    ticket,
    expirySec: Math.floor(TICKET_TTL_MS / 1000),
    streamBase: `/api/reference-images/stream/${ticket}`,
  });
});

/**
 * GET /api/reference-images/stream/:ticket/:id —— 凭证通道。
 *
 * **不带 requirePerm**：<img> 发来的请求没有 Authorization 头，加了就永远 403。
 * 安全性由「凭证随机 144 bit + 10 分钟 + 只有登录过的管理员能领到凭证」保证。
 *
 * 注意这里用 `router.get` 而不是在 `/:id` 之前注册 —— 路径段数不同
 * （stream/:ticket/:id 是 3 段，/:id 是 1 段），express 不会串。
 */
router.get('/stream/:ticket/:id', async (req, res) => {
  try {
    if (!resolveTicket(req.params.ticket)) {
      return res.status(403).json({ ok: false, message: '参考图读取凭证已过期，请刷新页面重试。' });
    }
    const row = findRow(asId(req.params.id));
    if (!row) return res.status(404).json({ ok: false, message: '参考图不存在' });
    /**
     * `?w=` → 走缩略图；不带 → 原图。
     *
     * 为什么必须有：卡片展示位只有几十像素，而库图原图 1.8–5.2MB。图库页 14 张 =
     * 57MB、选择器一开就并发拉同样一批 —— 图还没到，用户看到的是一片空框，
     * 点「加入参考图」也要等十几秒，像是这个入口坏了（2026-09-29 实测）。
     * 缩略图单张 16KB 量级，同一个页面从 57MB 降到几百 KB。
     *
     * 生成失败（没装 ImageMagick / 图损坏）**静默回退原图**：宁可慢，不能碎图。
     */
    let buf;
    let mime;
    if (Number(req.query.w) > 0) {
      const thumb = await ensureLibraryThumb(row).catch(() => null);
      if (thumb) {
        try {
          buf = await fs.readFile(thumb);
          mime = 'image/jpeg';
        } catch { /* 读不到缩略图 → 回退原图 */ }
      }
    }
    if (!buf) ({ buf, mime } = await readReferenceImage(row));
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(buf.length));
    // 内容寻址（sha256 文件名）→ 同一张图的字节永不改变，可以放心长缓存。
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    return res.end(buf);
  } catch (error) {
    if (!res.headersSent) return jsonError(res, error);
    try { res.end(); } catch { /* 已经断了，忽略 */ }
    return undefined;
  }
});

/**
 * GET /api/reference-images/:id/file —— 带 Authorization 头直调（脚本 / curl 用）。
 * 浏览器里的 <img> 走上面的凭证通道。
 */
router.get('/:id/file', requirePerm('refimage:list'), async (req, res) => {
  try {
    const row = findRow(asId(req.params.id));
    if (!row) return res.status(404).json({ ok: false, message: '参考图不存在' });
    const { buf, mime, filename } = await readReferenceImage(row);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    if (String(req.query.download || '') === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    }
    return res.end(buf);
  } catch (error) {
    if (!res.headersSent) return jsonError(res, error);
    try { res.end(); } catch { /* 已经断了，忽略 */ }
    return undefined;
  }
});

export default router;
