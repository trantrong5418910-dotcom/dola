/**
 * 内容管理 —— 这是「示例业务模块」。
 * 想接自己的业务：在 server/db.js 加表，复制本文件改字段，前端复制 views/Content.vue 改列即可。
 */
import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

const LIST_SQL = `SELECT c.id, c.title, c.category, c.status, c.body, c.author_id,
                         c.created_at, c.updated_at, u.username AS author
                  FROM contents c LEFT JOIN users u ON u.id = c.author_id`;

/** GET /api/contents */
router.get('/', requirePerm('content:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', category = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) { where.push('(c.title LIKE ? OR c.body LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (category) { where.push('c.category = ?'); params.push(category); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM contents c${w}`).get(...params).c;
  const items = db.prepare(`${LIST_SQL}${w} ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  res.json({ ok: true, items, total, page: Number(page), pageSize: Number(pageSize) });
});

/** GET /api/contents/categories —— 已用的分类（筛选下拉用） */
router.get('/categories', requirePerm('content:list'), (req, res) => {
  const rows = db.prepare('SELECT DISTINCT category FROM contents ORDER BY category').all();
  res.json({ ok: true, items: rows.map((r) => r.category) });
});

/** GET /api/contents/:id */
router.get('/:id', requirePerm('content:list'), (req, res) => {
  const row = db.prepare(`${LIST_SQL} WHERE c.id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, message: '内容不存在' });
  res.json({ ok: true, item: row });
});

/** POST /api/contents */
router.post('/', requirePerm('content:create'), (req, res) => {
  const { title, category = 'default', status = 'draft', body = '' } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ ok: false, message: '标题必填' });
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO contents (title,category,status,body,author_id,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?)`)
    .run(String(title).trim(), category, status, body, req.user.id, now, now);
  audit(req, 'content.create', 'content', info.lastInsertRowid, title);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

/** PUT /api/contents/:id */
router.put('/:id', requirePerm('content:update'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM contents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '内容不存在' });
  const { title, category, status, body } = req.body || {};
  db.prepare('UPDATE contents SET title=?, category=?, status=?, body=?, updated_at=? WHERE id=?')
    .run(
      title !== undefined ? String(title).trim() : row.title,
      category !== undefined ? category : row.category,
      status !== undefined ? status : row.status,
      body !== undefined ? body : row.body,
      new Date().toISOString(),
      id,
    );
  audit(req, 'content.update', 'content', id, row.title);
  res.json({ ok: true });
});

/** DELETE /api/contents/:id */
router.delete('/:id', requirePerm('content:delete'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT title FROM contents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '内容不存在' });
  db.prepare('DELETE FROM contents WHERE id = ?').run(id);
  audit(req, 'content.delete', 'content', id, row.title);
  res.json({ ok: true });
});

/** DELETE /api/contents —— 批量删除，body: {ids:[...]} */
router.delete('/', requirePerm('content:delete'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何记录' });
  const stmt = db.prepare('DELETE FROM contents WHERE id = ?');
  for (const id of ids) stmt.run(id);
  audit(req, 'content.bulk_delete', 'content', ids.join(','), `${ids.length} 条`);
  res.json({ ok: true, deleted: ids.length });
});

export default router;
