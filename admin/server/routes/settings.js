import express from 'express';
import { db, getSetting } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { parseDurationCarrierMap } from '../dola/generation-duration.js';

const router = express.Router();

/**
 * 30 秒改写通道两个设置的入口校验（纯函数，便于单测）。
 *
 * ⚠️ 为什么要在入口拦：`parseDurationCarrierMap()` 的契约是**解析失败静默回落内置默认**
 *    （生成链路不该因为一个手写 JSON 而挂掉）。静默回落恰恰是最难查的一类故障 ——
 *    运营以为配了 30→10，实际一直是默认的 30→15，表现是"30 秒还是选不到号"。
 *    所以校验用**同一个解析器**做真相来源：凡是解析器会丢掉的项，这里直接拒绝。
 *
 * 返回 null 表示通过；否则返回给前端的中文错误文案。
 */
export function validateDurationCarrierSettings(patch) {
  if ('dola_allow_30s_rewrite' in patch
      && !['true', 'false'].includes(String(patch.dola_allow_30s_rewrite))) {
    return '30 秒改写开关必须为 true 或 false';
  }
  if ('dola_duration_carrier_map' in patch) {
    const raw = String(patch.dola_duration_carrier_map ?? '').trim();
    if (raw) {
      let written = null;
      try { written = JSON.parse(raw); } catch { written = null; }
      const kept = parseDurationCarrierMap(raw);
      const submitted = written && typeof written === 'object' && !Array.isArray(written)
        ? Object.keys(written).length : -1;
      if (submitted < 0 || submitted !== Object.keys(kept).length) {
        // 档位精简：目标档位只剩 15/30（10/20 已下线），但**载体**仍可以是页面上
        // 真实存在的 10/20 —— 载体不是目标档位，不受下线约束。
        return '载体映射须为 JSON 对象，目标取 15/30、载体取 10/15/20/30 且必须短于目标（例：{"30":10}）';
      }
    }
  }
  return null;
}

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
// `metrics_key` 与 `gateway_key` 同类：都是**服务级共享密钥**，
// 拿到就能绕过用户令牌直接抓运行态。只给 `setting:view` 的人不该看到真值。
const SECRET_SETTING_KEYS = new Set(['gateway_key', 'metrics_key', 'llm_api_key']);
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

  /**
   * ★ 校验只针对「本次真的改了」的项。
   *
   * 为什么必须做这个区分：设置页是**全量提交**（patch[it.key] = it.value，56 项一起回传）。
   * 只要库里躺着一条**按今天规则已不合法的历史值**，全量校验就会把它算进去，
   * 于是不管用户想改哪一项，保存都 400 —— 而报错指向的是一个他根本没碰过的字段。
   *
   * 实测就是这个场面：档位精简后目标只剩 15/30，库里的
   * `dola_duration_carrier_map = {"20":10,"30":10}` 变成了非法值，
   * 结果「脚本生成通道」怎么改都存不进去，报错却是「载体映射须为 JSON 对象…」。
   *
   * 所以：校验看 `dirty`（本次改动的项），写库仍写 `patch`（等价于写 dirty + 原值）。
   * 用户**主动**把某项改成非法值照样被拒，只是不再被历史脏值连坐。
   */
  const currentValues = new Map(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  const dirty = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!currentValues.has(k) || String(currentValues.get(k)) !== String(v)) dirty[k] = v;
  }

  for (const key of ['dola_auto_maintenance_enabled', 'dola_auto_cleanup_invalid', 'dola_auto_quota_probe', 'llm_enabled']) {
    if (key in dirty && !['true', 'false'].includes(String(dirty[key]))) {
      return res.status(400).json({ ok: false, message: '开关必须为 true 或 false' });
    }
  }
  if ('dola_submit_mode' in dirty && !['browser', 'scheme-a', 'pure-http'].includes(String(dirty.dola_submit_mode).trim().toLowerCase())) {
    return res.status(400).json({ ok: false, message: '视频提交通道仅支持 browser、scheme-a 或 pure-http' });
  }
  /**
   * 「你好」探测通道。与 dola_submit_mode 同理：非法值会被 `resolveHelloProbeMode`
   * 静默回落到默认通道，于是「我明明切回浏览器了」和实际行为对不上 —— 入口就拒绝。
   */
  if ('dola_hello_probe_mode' in dirty) {
    const probeMode = String(dirty.dola_hello_probe_mode || '').trim().toLowerCase();
    if (!['pure-http', 'browser'].includes(probeMode)) {
      return res.status(400).json({ ok: false, message: '「你好」探测通道仅支持 pure-http 或 browser' });
    }
    patch.dola_hello_probe_mode = probeMode;
  }
  /**
   * 脚本工作台的生成通道。静默回落最难查：写错一个值就退回 openai，
   * 而 openai 没配 base_url/key，用户看到的是「LLM 未配置」——
   * 与「我明明切到 dola 了」完全对不上。所以在入口就拒绝。
   */
  if ('llm_provider' in dirty) {
    const provider = String(dirty.llm_provider || '').trim().toLowerCase();
    if (!['openai', 'dola'].includes(provider)) {
      return res.status(400).json({ ok: false, message: '脚本生成通道仅支持 openai 或 dola' });
    }
    patch.llm_provider = provider;
  }
  /**
   * 30 秒改写通道的两个设置。校验规则见 validateDurationCarrierSettings() 的文件头注释：
   * 静默回落最难查，所以凡是解析器会丢掉的项都在入口拒绝。
   */
  {
    const invalid = validateDurationCarrierSettings(dirty);
    if (invalid) return res.status(400).json({ ok: false, message: invalid });
  }
  if ('dola_auto_maintenance_interval_minutes' in dirty) {
    const minutes = Number(dirty.dola_auto_maintenance_interval_minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) {
      return res.status(400).json({ ok: false, message: '自动巡检间隔须为 15～1440 分钟的整数' });
    }
  }
  if ('dola_quota_reset_hour' in dirty) {
    const hour = Number(dirty.dola_quota_reset_hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return res.status(400).json({ ok: false, message: '额度重置时刻须为 0～23 的整数' });
    }
  }
  if ('dola_quota_reset_tz' in dirty) {
    const tz = String(dirty.dola_quota_reset_tz || '').trim();
    if (!/^[A-Za-z_]+(\/[A-Za-z_0-9+-]+)+$/.test(tz)) {
      return res.status(400).json({ ok: false, message: '重置时区格式不正确，应为 IANA 时区如 Asia/Tokyo' });
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
    catch { return res.status(400).json({ ok: false, message: `不支持的时区：${tz}` }); }
    patch.dola_quota_reset_tz = tz;
  }
  if ('llm_base_url' in dirty && String(dirty.llm_base_url).trim()) {
    try {
      const url = new URL(String(patch.llm_base_url).trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      patch.llm_base_url = url.toString().replace(/\/+$/, '');
    } catch {
      return res.status(400).json({ ok: false, message: 'LLM 地址须为 HTTP(S) 基础地址，不含账号密码、查询参数或片段（如 https://服务地址/v1）' });
    }
  }
  const integerRanges = {
    llm_timeout_ms: [1000, 300000, 'LLM 超时须为 1000～300000 毫秒的整数'],
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
    if (!(key in dirty)) continue;
    const value = Number(dirty[key]);
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
