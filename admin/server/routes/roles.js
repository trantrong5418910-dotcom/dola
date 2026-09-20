import express from 'express';
import { db } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { PERMISSIONS, groupedPermissions, ALL_PERMISSIONS } from '../rbac.js';

const router = express.Router();
router.use(requireAuth);

/** GET /api/roles/permissions —— 权限点清单（前端画权限树用） */
router.get('/permissions', (req, res) => {
  res.json({ ok: true, groups: groupedPermissions(), all: ALL_PERMISSIONS });
});

/**
 * GET /api/roles/options —— 只要 id/name 的下拉选项。
 * 故意只要求登录、不要求 role:list：编辑用户时得选角色，
 * 但「编辑用户」和「查看角色」是两回事，不该互相卡住。
 */
router.get('/options', (req, res) => {
  const items = db.prepare('SELECT id, code, name FROM roles ORDER BY id').all();
  res.json({ ok: true, items });
});

/** GET /api/roles */
router.get('/', requirePerm('role:list'), (req, res) => {
  const items = db.prepare('SELECT id, code, name, description, permissions, builtin, created_at FROM roles ORDER BY id').all();
  res.json({
    ok: true,
    items: items.map((r) => {
      let perms = [];
      try {
        const p = JSON.parse(r.permissions || '[]');
        perms = p === '*' ? ALL_PERMISSIONS.slice() : (Array.isArray(p) ? p : []);
      } catch { /* ignore */ }
      return { ...r, permissions: perms, isAll: perms.length === ALL_PERMISSIONS.length };
    }),
  });
});

/** PUT /api/roles/:id/permissions —— 配置权限 */
router.put('/:id/permissions', requirePerm('role:update'), (req, res) => {
  const id = Number(req.params.id);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ ok: false, message: '角色不存在' });
  if (role.builtin) return res.status(400).json({ ok: false, message: '内置角色不可修改权限' });

  let perms = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  // 只保留已知权限点，防止前端塞脏数据
  perms = perms.filter((p) => ALL_PERMISSIONS.includes(p));

  db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), id);
  audit(req, 'role.update_permissions', 'role', id, perms.join(','));
  res.json({ ok: true, permissions: perms });
});

/** POST /api/roles */
router.post('/', requirePerm('role:update'), (req, res) => {
  const { code, name, description = '', permissions = [] } = req.body || {};
  if (!code || !name) return res.status(400).json({ ok: false, message: '编码和名称必填' });
  if (db.prepare('SELECT id FROM roles WHERE code = ?').get(code)) {
    return res.status(409).json({ ok: false, message: '角色编码已存在' });
  }
  const safe = permissions.filter((p) => ALL_PERMISSIONS.includes(p));
  const info = db.prepare('INSERT INTO roles (code,name,description,permissions,builtin,created_at) VALUES (?,?,?,?,0,?)')
    .run(code, name, description, JSON.stringify(safe), new Date().toISOString());
  audit(req, 'role.create', 'role', info.lastInsertRowid, `${code}`);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

/** DELETE /api/roles/:id */
router.delete('/:id', requirePerm('role:update'), (req, res) => {
  const id = Number(req.params.id);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ ok: false, message: '角色不存在' });
  if (role.builtin) return res.status(400).json({ ok: false, message: '内置角色不可删除' });
  const using = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(id).c;
  if (using > 0) return res.status(400).json({ ok: false, message: `还有 ${using} 个用户在使用该角色` });
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  audit(req, 'role.delete', 'role', id, role.code);
  res.json({ ok: true });
});

export { PERMISSIONS };
export default router;
