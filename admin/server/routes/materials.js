/**
 * 素材库：后台统一维护的提示词素材（可带参考图）。
 *
 * 表：dola_materials(id, name, prompt, images JSON, created_by, created_at, updated_at)
 * images 与前台素材结构对齐：[{ mime, dataBase64 }]，存在 DB 里，方便运营在后台集中管理。
 */
import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit, paged } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

const now = () => new Date().toISOString();
const MAX_IMAGES = 9;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** 校验并归一化 images 数组；非法直接抛错（带 status） */
function normalizeImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images)) {
    throw Object.assign(new Error('images 必须是数组'), { status: 400 });
  }
  if (images.length > MAX_IMAGES) {
    throw Object.assign(new Error(`一张素材最多 ${MAX_IMAGES} 张参考图`), { status: 400 });
  }
  return images.map((img, i) => {
    const mime = String(img?.mime || 'image/png').toLowerCase();
    const dataBase64 = String(img?.dataBase64 || img?.data || '');
    if (!ALLOWED_MIME.has(mime)) {
      throw Object.assign(new Error(`第 ${i + 1} 张图格式不支持（仅 png/jpeg/webp）`), { status: 400 });
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(dataBase64) || dataBase64.length < 100) {
      throw Object.assign(new Error(`第 ${i + 1} 张图数据不是合法的 base64`), { status: 400 });
    }
    // 单张 8MB 上限（base64 长度约 10.6M）
    if (dataBase64.length > 11 * 1024 * 1024) {
      throw Object.assign(new Error(`第 ${i + 1} 张图超过 8MB`), { status: 400 });
    }
    return { mime, dataBase64 };
  });
}

function toPublic(row) {
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch { images = []; }
  return {
    id: row.id,
    name: row.name || '',
    prompt: row.prompt || '',
    images: Array.isArray(images) ? images : [],
    imageCount: Array.isArray(images) ? images.length : 0,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** GET /api/materials —— 列表（关键字搜名称/提示词） */
router.get('/', requirePerm('material:list'), (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  let sql = 'SELECT * FROM dola_materials';
  let countSql = 'SELECT COUNT(*) AS c FROM dola_materials';
  const params = [];
  if (keyword) {
    sql += ' WHERE name LIKE ? OR prompt LIKE ?';
    countSql += ' WHERE name LIKE ? OR prompt LIKE ?';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  sql += ' ORDER BY updated_at DESC, id DESC';
  const { items, total } = paged(sql, countSql, params, { page, pageSize });
  res.json({ ok: true, items: items.map(toPublic), total, page, pageSize });
});

/** GET /api/materials/:id —— 单条（含图片） */
router.get('/:id', requirePerm('material:list'), (req, res) => {
  const row = db.prepare('SELECT * FROM dola_materials WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, message: '素材不存在' });
  res.json({ ok: true, item: toPublic(row) });
});

function validateBody(body) {
  const name = String(body?.name || '').trim().slice(0, 80);
  const prompt = String(body?.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('请填写提示词'), { status: 400 });
  if (prompt.length > 12000) throw Object.assign(new Error('提示词最多 12000 字'), { status: 400 });
  const images = normalizeImages(body?.images);
  return { name, prompt, images };
}

/** POST /api/materials —— 新增 */
router.post('/', requirePerm('material:create'), (req, res) => {
  let v;
  try { v = validateBody(req.body); }
  catch (e) { return res.status(e.status || 400).json({ ok: false, message: e.message }); }
  const at = now();
  const r = db.prepare(`INSERT INTO dola_materials (name, prompt, images, created_by, created_at, updated_at)
                        VALUES (?,?,?,?,?,?)`)
    .run(v.name || '未命名素材', v.prompt, JSON.stringify(v.images), req.user?.id ?? null, at, at);
  audit(req, 'material.create', 'dola_material', r.lastInsertRowid, { name: v.name, imageCount: v.images.length });
  res.status(201).json({ ok: true, id: r.lastInsertRowid });
});

/** PUT /api/materials/:id —— 编辑 */
router.put('/:id', requirePerm('material:update'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM dola_materials WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '素材不存在' });
  let v;
  try { v = validateBody(req.body); }
  catch (e) { return res.status(e.status || 400).json({ ok: false, message: e.message }); }
  db.prepare('UPDATE dola_materials SET name=?, prompt=?, images=?, updated_at=? WHERE id=?')
    .run(v.name || '未命名素材', v.prompt, JSON.stringify(v.images), now(), id);
  audit(req, 'material.update', 'dola_material', id, { name: v.name, imageCount: v.images.length });
  res.json({ ok: true });
});

/** DELETE /api/materials/:id —— 删除 */
router.delete('/:id', requirePerm('material:delete'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, name FROM dola_materials WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '素材不存在' });
  db.prepare('DELETE FROM dola_materials WHERE id = ?').run(id);
  audit(req, 'material.delete', 'dola_material', id, { name: row.name });
  res.json({ ok: true });
});

/**
 * POST /api/materials/import —— 批量导入。
 * body: { items: [{ name?, prompt, images? }] }，单条失败跳过并计入 problems。
 */
router.post('/import', requirePerm('material:create'), (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, message: '请提供 items 数组' });
  }
  if (items.length > 200) {
    return res.status(400).json({ ok: false, message: '一次最多导入 200 条' });
  }
  const at = now();
  const stmt = db.prepare(`INSERT INTO dola_materials (name, prompt, images, created_by, created_at, updated_at)
                           VALUES (?,?,?,?,?,?)`);
  let inserted = 0;
  const problems = [];
  const insertMany = db.transaction((list) => {
    for (const v of list) stmt.run(v.name || '未命名素材', v.prompt, JSON.stringify(v.images), req.user?.id ?? null, at, at);
  });
  const valid = [];
  items.forEach((raw, i) => {
    try {
      const v = validateBody(raw);
      valid.push(v);
    } catch (e) {
      problems.push(`第 ${i + 1} 条：${e.message}`);
    }
  });
  try {
    insertMany(valid);
    inserted = valid.length;
  } catch (e) {
    return res.status(500).json({ ok: false, message: `导入失败：${e.message}` });
  }
  audit(req, 'material.import', 'dola_material', '', { total: items.length, inserted, failed: problems.length });
  res.json({ ok: true, inserted, failed: problems.length, problems: problems.slice(0, 20) });
});

export default router;
