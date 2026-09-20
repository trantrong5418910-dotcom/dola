import express from 'express';
import { db } from '../db.js';
import { hashPassword, verifyPassword, signJwt, requireAuth, sessionHours } from '../auth.js';
import { audit, clientIp } from '../audit.js';
import { getSetting } from '../db.js';

const router = express.Router();

const PUBLIC_USER = `SELECT u.id, u.username, u.nickname, u.email, u.status, u.role_id,
                            u.created_at, u.last_login_at,
                            r.code AS role_code, r.name AS role_name, r.permissions
                     FROM users u LEFT JOIN roles r ON r.id = u.role_id`;

function toPublic(u) {
  if (!u) return null;
  let perms = [];
  try {
    const p = JSON.parse(u.permissions || '[]');
    perms = p === '*' ? ['*'] : (Array.isArray(p) ? p : []);
  } catch { /* ignore */ }
  const { permissions, ...rest } = u;
  return { ...rest, permissions: perms };
}

/** POST /api/auth/login */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, message: '请输入用户名和密码' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    // 登录接口此时还没有身份，用 actor 参数把「谁尝试登录」记进去
    audit(req, 'login_failed', 'user', username, `IP ${clientIp(req)}`, { id: null, username: String(username).trim() });
    return res.status(401).json({ ok: false, message: '用户名或密码错误' });
  }
  if (user.status !== 'active') return res.status(403).json({ ok: false, message: '账号已被停用' });

  const token = signJwt({ uid: user.id, role: user.role_id }, sessionHours());
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  audit(req, 'login', 'user', user.id, '', { id: user.id, username: user.username });

  res.json({ ok: true, token, user: toPublic(db.prepare(`${PUBLIC_USER} WHERE u.id = ?`).get(user.id)) });
});

/** POST /api/auth/logout */
router.post('/logout', requireAuth, (req, res) => {
  audit(req, 'logout', 'user', req.user.id, '');
  res.json({ ok: true });
});

/** GET /api/auth/me —— 前端刷新页面后恢复登录态 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: toPublic(db.prepare(`${PUBLIC_USER} WHERE u.id = ?`).get(req.user.id)) });
});

/** POST /api/auth/password —— 改自己的密码 */
router.post('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ ok: false, message: '请填写原密码和新密码' });
  if (String(newPassword).length < 6) return res.status(400).json({ ok: false, message: '新密码至少 6 位' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(oldPassword, user.password_hash)) return res.status(400).json({ ok: false, message: '原密码不正确' });

  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), new Date().toISOString(), user.id);
  audit(req, 'change_password', 'user', user.id, '');
  res.json({ ok: true, message: '密码已修改' });
});

/** 是否开放注册（设置项） */
router.get('/register-enabled', (req, res) => {
  res.json({ ok: true, enabled: getSetting('allow_register', 'false') === 'true' });
});

export default router;
