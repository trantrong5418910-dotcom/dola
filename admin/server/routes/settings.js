import express from 'express';
import { db, getSetting } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();

/**
 * GET /api/settings/public —— 未登录也能读。
 * 必须放在 requireAuth 之前，否则登录页拿不到站点名。
 */
router.get('/public', (req, res) => {
  res.json({ ok: true, siteName: getSetting('site_name', '管理后台'), footer: getSetting('footer_text', '') });
});

router.use(requireAuth);

/** GET /api/settings */
router.get('/', requirePerm('setting:view'), (req, res) => {
  const items = db.prepare('SELECT key, value, label, group_name FROM settings ORDER BY group_name, key').all();
  res.json({ ok: true, items });
});

/** PUT /api/settings  body: { key: value, ... } */
router.put('/', requirePerm('setting:update'), (req, res) => {
  const patch = req.body || {};
  for (const key of ['dola_auto_maintenance_enabled', 'dola_auto_cleanup_invalid', 'dola_auto_quota_probe']) {
    if (key in patch && !['true', 'false'].includes(String(patch[key]))) {
      return res.status(400).json({ ok: false, message: '自动维护开关必须为 true 或 false' });
    }
  }
  if ('dola_auto_maintenance_interval_minutes' in patch) {
    const minutes = Number(patch.dola_auto_maintenance_interval_minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
      return res.status(400).json({ ok: false, message: '自动巡检间隔须为 15～1440 分钟的整数' });
    }
  }
  const integerRanges = {
    dola_gen_concurrency: [1, 20, '视频生成并发数须为 1～20 的整数'],
    dola_gen_queue_limit: [1, 6000, '视频生成队列容量须为 1～6000 的整数'],
    dola_check_concurrency: [1, 50, '批量校验并发数须为 1～50 的整数'],
    dola_browser_concurrency: [1, 10, '浏览器通道并发数须为 1～10 的整数'],
  };
  for (const [key, [min, max, message]] of Object.entries(integerRanges)) {
    if (!(key in patch)) continue;
    const value = Number(patch[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      return res.status(400).json({ ok: false, message });
    }
  }
  const stmt = db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?');
  const now = new Date().toISOString();
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    const exist = db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
    if (!exist) continue;
    stmt.run(String(v), now, k);
    changed.push(k);
  }
  if (changed.length) audit(req, 'setting.update', 'setting', changed.join(','), '');
  res.json({ ok: true, changed });
});

export default router;
