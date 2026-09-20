import express from 'express';
import { db } from '../db.js';
import { hashPassword, requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

const LIST_SQL = `SELECT u.id, u.username, u.nickname, u.email, u.status, u.role_id,
                         u.created_at, u.updated_at, u.last_login_at,
                         r.code AS role_code, r.name AS role_name
                  FROM users u LEFT JOIN roles r ON r.id = u.role_id`;

/** GET /api/users —— 分页 + 关键字搜索 + 状态筛选 */
router.get('/', requirePerm('user:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where.push('u.status = ?'); params.push(status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM users u${w}`).get(...params).c;
  const items = db.prepare(`${LIST_SQL}${w} ORDER BY u.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  res.json({ ok: true, items, total, page: Number(page), pageSize: Number(pageSize) });
});

/** POST /api/users */
router.post('/', requirePerm('user:create'), (req, res) => {
  const { username, password, nickname = '', email = '', role_id, status = 'active' } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, message: '用户名和密码必填' });
  if (String(password).length < 6) return res.status(400).json({ ok: false, message: '密码至少 6 位' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim())) {
    return res.status(409).json({ ok: false, message: '用户名已存在' });
  }
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO users (username,password_hash,nickname,email,role_id,status,created_at,updated_at)
                           VALUES (?,?,?,?,?,?,?,?)`)
    .run(String(username).trim(), hashPassword(password), nickname, email, role_id || null, status, now, now);
  audit(req, 'user.create', 'user', info.lastInsertRowid, `新建用户 ${username}`);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

/** PUT /api/users/:id */
router.put('/:id', requirePerm('user:update'), (req, res) => {
  const id = Number(req.params.id);
  const { nickname = '', email = '', role_id, status } = req.body || {};
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ ok: false, message: '用户不存在' });

  db.prepare('UPDATE users SET nickname=?, email=?, role_id=?, status=?, updated_at=? WHERE id=?')
    .run(nickname, email, role_id || null, status || 'active', new Date().toISOString(), id);

  // 改的是自己 -> 权限可能变了，前端会重新拉 /me
  audit(req, 'user.update', 'user', id, `更新用户 #${id}`);
  res.json({ ok: true });
});

/** POST /api/users/:id/reset-password */
router.post('/:id/reset-password', requirePerm('user:update'), (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ ok: false, message: '新密码至少 6 位' });
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ ok: false, message: '用户不存在' });
  db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?')
    .run(hashPassword(password), new Date().toISOString(), id);
  audit(req, 'user.reset_password', 'user', id, '');
  res.json({ ok: true });
});

/** DELETE /api/users/:id */
router.delete('/:id', requirePerm('user:delete'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ ok: false, message: '不能删除自己' });
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ ok: false, message: '用户不存在' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(req, 'user.delete', 'user', id, `删除用户 ${u.username}`);
  res.json({ ok: true });
});

export default router;
