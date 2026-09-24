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

/**
 * 不能明文回给「只能看设置」的人。
 *
 * 踩过的坑：这里原本 `SELECT key,value,...` 整表返回，于是只要 `setting:view`
 * 就能读到 `gateway_key`（服务级共享密钥，拿到就能绕过用户令牌直接调用户面网关）。
 * 而 `setting:view` 的语义只是「看看设置」，不该看到密钥。
 *
 * 脱敏策略：**只有拿得到 `setting:update` 的人才给真值**。
 * 因为能改的人本来就能读能写，给真值才不会出问题；反过来，只给 view 的人掩码，
 * 而他也没有 PUT 权限，所以不存在"把掩码写回去覆盖真密钥"的风险
 * （前端 Settings.vue 的 save() 是全量提交 `patch[it.key] = it.value`，
 *   如果 view 用户能提交，掩码就会被写进库 —— 这正是必须一起考虑的点）。
 */
const SECRET_SETTING_KEYS = new Set(['gateway_key']);
const MASK = '••••••••（无权限查看，需要 设置-修改 权限）';

/** GET /api/settings */
router.get('/', requirePerm('setting:view'), (req, res) => {
  const canWrite = (req.user.permissions || []).includes('*')
    || (req.user.permissions || []).includes('setting:update');
  const items = db.prepare('SELECT key, value, label, group_name FROM settings ORDER BY group_name, key')
    .all()
    .map((it) => (canWrite || !SECRET_SETTING_KEYS.has(it.key) ? it : { ...it, value: MASK }));
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
  if ('dola_submit_mode' in patch && !['browser', 'scheme-a'].includes(String(patch.dola_submit_mode).trim().toLowerCase())) {
    return res.status(400).json({ ok: false, message: '视频提交通道仅支持 browser 或 scheme-a' });
  }
  if ('dola_auto_maintenance_interval_minutes' in patch) {
    const minutes = Number(patch.dola_auto_maintenance_interval_minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
      return res.status(400).json({ ok: false, message: '自动巡检间隔须为 15～1440 分钟的整数' });
    }
  }
  const integerRanges = {
    dola_gen_concurrency: [1, 20, '视频生成并发数须为 1～20 的整数'],
    dola_gen_min_submit_interval_sec: [0, 600, '同出口提交间隔须为 0～600 秒'],
    dola_gen_queue_limit: [1, 6000, '视频生成队列容量须为 1～6000 的整数'],
    dola_ratelimit_cooldown_min: [1, 1440, '限流冷却须为 1～1440 分钟'],
    dola_autorotate_max_attempts: [1, 24, '自动换号重试账号数须为 1～24 的整数'],
    dola_replenish_min_accounts: [1, 100, '补号提示账号数阈值须为 1～100 的整数'],
    dola_replenish_min_quota: [0, 10000, '补号提示额度阈值须为 0～10000 的整数（0=关闭额度判据）'],
    gateway_prompt_cooldown_seconds: [0, 3600, '同令牌相同提示词冷却须为 0～3600 秒'],
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
    // 掩码是「无权限查看」的占位符，绝不是可以写进库的值。
    // 挡这一下是为了防止：只读角色拿到掩码后又以别的方式提交，把真密钥覆盖成掩码。
    if (SECRET_SETTING_KEYS.has(k) && String(v) === MASK) continue;
    stmt.run(String(v), now, k);
    changed.push(k);
  }
  if (changed.length) audit(req, 'setting.update', 'setting', changed.join(','), '');
  res.json({ ok: true, changed });
});

export default router;
