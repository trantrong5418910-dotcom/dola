import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';

const router = express.Router();
router.use(requireAuth);

/** GET /api/logs —— 分页 + 按人/动作筛选 */
router.get('/', requirePerm('log:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', action = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) { where.push('(username LIKE ? OR detail LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (action) { where.push('action = ?'); params.push(action); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs${w}`).get(...params).c;
  const items = db.prepare(`SELECT id,user_id,username,action,target_type,target_id,detail,ip,created_at
                            FROM audit_logs${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  res.json({ ok: true, items, total, page: Number(page), pageSize: Number(pageSize) });
});

/** GET /api/logs/actions —— 已有动作列表（筛选下拉用） */
router.get('/actions', requirePerm('log:list'), (req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all();
  res.json({ ok: true, items: rows.map((r) => r.action) });
});

export default router;
