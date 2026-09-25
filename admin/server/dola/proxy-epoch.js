/**
 * 代理出口轮换（epoch）——「这个出口还能用多久」。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * 现状只记录「这个号有没有代理」，**不知道当前出口还剩多久轮换**。
 * 实测事实（见 `proxy-pool.js` 的 syncAccountsExitIp 注释）：账号用的是
 * **5 分钟粘性会话**，5 分钟后同一个 SID 会换到另一个 IP。实测 4 个号记录的出口
 * 全部与当时实测不一致，其中一个直接 502。
 * ⇒ 「一号一 IP」的前提根本不成立。而提交一个 30 秒任务最长要花十几分钟
 *   （体检 + 提交 + 轮询），**出口在任务中途换掉**会让上游看到 IP 跳变，
 *   可能直接判风控 —— 而我们现在只能事后从失败里猜。
 *
 * ── 一个必须说清楚的诚实边界：我们算的是**上界**，不是精确到期时间 ────────
 * IPWeb 的粘性窗口锚定在**它自己的时钟**上，我们观测不到那个边界。
 * 我们只知道「**首次观测到这个出口 IP 的时刻**」。真实窗口起点 ≤ 我们的观测点，
 * 所以：
 *
 *     expires_at(我们算的) ≥ 真实到期时刻      ⇒ remaining 是**上界**
 *
 * 因此本模块刻意**不假装精确**：
 *   · `estimate: true` 永远为真，提醒调用方这是上界；
 *   · `remaining` 已经 ≤ 0 时只说 `stale`（「该重新探测了」），
 *     **不说「已轮换」** —— 我们并不知道它到底轮没轮，硬说就是编。
 * 这个区别在实际用的时候很重要：把 stale 当"已轮换"会导致无谓地换号重试。
 *
 * ── epoch 是什么 ─────────────────────────────────────────────────────────
 * 每次**观测到出口 IP 变了**，就 `rotation_count + 1`。于是
 * `epoch = rotation_count + 1` 就是「这是这个出口的第几代」，是单调递增的。
 * 它的价值是跨时间可比：`#408 的 epoch 从 1 涨到 7` 说明这条出口一天换了 7 次，
 * 比任何瞬时指标都更能说明"这条线路不稳"。
 */
import { db as appDb, getSetting } from '../db.js';

/** 记不到 IPWeb 参数时（自建代理等）用的兜底窗口。0 = 不知道，不算。 */
export const UNKNOWN_WINDOW_SECONDS = 0;

/** 判定「即将轮换」的默认阈值（秒）。0 = 不判定。 */
export const DEFAULT_ROTATION_RISK_SECONDS = 120;

export const EPOCH_SETTING_KEYS = Object.freeze({
  riskSeconds: 'dola_proxy_rotation_risk_sec',
  assumedMinutes: 'dola_proxy_assumed_minutes',
});

/**
 * 从代理 URL 里解析粘性窗口。
 *
 * IPWeb 的用户名形如 `B_36307_KR__5_Ab000001`（账号_国家_州_城市_**分钟**_SID），
 * 也就是**窗口时长本来就在 URL 里**（`buildIpwebProxy` 的第 5 段）。
 * 本函数只做解析，不引入对 `proxy.js` 的依赖 —— 那边是纯函数，
 * 但保持本模块零依赖能让它在单测里不需要任何 mock。
 *
 * @returns {{ok:boolean, minutes:number, sid:string, windowSeconds:number, source:string, reason:string}}
 */
export function parseStickyWindow(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  const miss = (reason) => ({ ok: false, minutes: 0, sid: '', windowSeconds: 0, source: 'unknown', reason });
  if (!raw) return miss('empty');
  let username = '';
  try {
    username = decodeURIComponent(new URL(raw).username || '');
  } catch {
    return miss('unparseable_url');
  }
  if (!username) return miss('no_username');
  const parts = username.split('_');
  // 账号_国家_州_城市_分钟_SID ⇒ 至少 6 段，分钟在第 5 段（下标 4）
  if (parts.length < 6) return miss('not_ipweb_shape');
  const minutes = Number(parts[4]);
  if (!Number.isFinite(minutes) || minutes <= 0) return miss('bad_minutes');
  return {
    ok: true,
    minutes,
    sid: String(parts[5] || ''),
    windowSeconds: Math.round(minutes * 60),
    source: 'url',
    reason: 'ok',
  };
}

/**
 * 轮换视图。
 *
 * @param {object} p
 * @param {string} p.proxyUrl
 * @param {string} [p.exitIp]      当前记录的出口 IP（空 = 还没核验过）
 * @param {string} [p.exitIpAt]    首次观测到这个出口 IP 的时刻（ISO）
 * @param {number} [p.rotations]   已观测到的轮换次数（epoch = rotations + 1）
 * @param {number} [p.assumedMinutes] URL 里没有分钟数时的兜底窗口（0=不算）
 * @param {number} [p.riskSeconds]  剩余低于这个值算「有风险」
 */
export function rotationView({
  proxyUrl, exitIp = '', exitIpAt = null, rotations = 0,
  assumedMinutes = 0, riskSeconds = DEFAULT_ROTATION_RISK_SECONDS, now = Date.now(),
} = {}) {
  const win = parseStickyWindow(proxyUrl);
  let windowSeconds = win.windowSeconds;
  let windowSource = win.source;
  if (!win.ok) {
    const fallback = Math.max(0, Math.round(Number(assumedMinutes) || 0)) * 60;
    if (fallback > 0) { windowSeconds = fallback; windowSource = 'assumed'; }
  }
  const epoch = Math.max(1, (Number(rotations) || 0) + 1);
  const base = {
    ok: win.ok || windowSource === 'assumed',
    epoch,
    windowSeconds,
    windowSource,
    // ★ 永远为真：我们算的到期时间只会 ≥ 真实值（见文件头）
    estimate: true,
    hasExitIp: Boolean(String(exitIp || '').trim()),
    reason: win.ok ? 'ok' : win.reason,
  };

  if (!base.ok) {
    return { ...base, anchorAt: null, expiresAt: null, remainingSeconds: null, stale: false, risk: 'unknown' };
  }
  const anchorMs = exitIpAt ? Date.parse(String(exitIpAt)) : NaN;
  if (!Number.isFinite(anchorMs)) {
    // 没有锚点（从没成功核验过出口）⇒ **不给数字**，硬编一个必然是错的
    return { ...base, anchorAt: null, expiresAt: null, remainingSeconds: null, stale: false, risk: 'unknown', reason: 'no_anchor' };
  }

  const expiresMs = anchorMs + windowSeconds * 1000;
  const remainingSeconds = Math.round((expiresMs - now) / 1000);
  const stale = remainingSeconds <= 0;
  const threshold = Math.max(0, Number(riskSeconds) || 0);
  const risk = stale ? 'stale' : (threshold > 0 && remainingSeconds <= threshold ? 'high' : 'low');

  return {
    ...base,
    anchorAt: new Date(anchorMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    remainingSeconds,
    // stale 的准确含义是「我们的估计已经过期，该重新核验了」，**不是**「已经轮换」
    stale,
    risk,
  };
}

/**
 * 取某个账号当前代理的轮换视图。
 *
 * 代理信息存在 `dola_proxies`（按 url 唯一）。查不到就返回 `unknown`，
 * **不猜** —— 一个凭空的 remaining 会让调度做错决定。
 *
 * @param {object} [opts.readSetting] 注入点。单测里没有初始化 `db.js` 的
 *   `getSetting` 会直接抛 `Cannot read properties of null`，所以必须可注入。
 */
export function accountRotationView(account, { database = appDb, readSetting = getSetting, now = Date.now() } = {}) {
  const url = String(account?.proxy || '').trim();
  if (!url) {
    return { ...rotationView({ proxyUrl: '', now }), reason: 'no_proxy' };
  }
  let row = null;
  try {
    row = database.prepare('SELECT exit_ip, exit_ip_at, rotation_count FROM dola_proxies WHERE url=?').get(url);
  } catch {
    // 表还没建（懒建表）⇒ 当没有池记录处理
    row = null;
  }
  const assumedMinutes = Number(readSetting(EPOCH_SETTING_KEYS.assumedMinutes, '0')) || 0;
  const riskSeconds = Number(readSetting(EPOCH_SETTING_KEYS.riskSeconds, String(DEFAULT_ROTATION_RISK_SECONDS)));
  return rotationView({
    proxyUrl: url,
    exitIp: row?.exit_ip || account?.exit_ip || '',
    exitIpAt: row?.exit_ip_at || null,
    rotations: row?.rotation_count || 0,
    assumedMinutes,
    riskSeconds: Number.isFinite(riskSeconds) ? riskSeconds : DEFAULT_ROTATION_RISK_SECONDS,
    now,
  });
}

/** 风险分桶的**固定**取值集合。指标里必须固定输出这几个桶（哪怕是 0）。 */
export const ROTATION_RISKS = Object.freeze(['low', 'high', 'stale', 'unknown', 'no_anchor']);

/**
 * 全部启用代理的轮换风险分布。**只有一处实现**，供 `/api/proxy-pool` 概览与
 * `/metrics` 共用 —— 两处各写一份的话，指标和页面迟早会给出不同的数字。
 *
 * ⚠️ 只统计**已核验过出口**的代理（有 `exit_ip` 才有锚点可谈）。
 *    把"还没探过"混进来会让 unknown 变成一个大桶，掩盖真正的问题。
 * ⚠️ `unknown`（读不出窗口）与 `no_anchor`（有窗口但从没核验成功过）**必须分开**：
 *    合成一个会掩盖"锚点根本没写进去"这类装配错误。
 *
 * @returns {{probed:number, rotated:number, low:number, high:number, stale:number,
 *            unknown:number, no_anchor:number}}
 *   `probed` = 有出口记录的代理数；`rotated` = 其中观测到过至少一次换 IP 的数量。
 */
export function rotationSummary({ database = appDb, readSetting = getSetting, now = Date.now() } = {}) {
  const out = { probed: 0, rotated: 0, low: 0, high: 0, stale: 0, unknown: 0, no_anchor: 0 };
  let rows = [];
  try {
    rows = database.prepare(`SELECT url, exit_ip, exit_ip_at, rotation_count FROM dola_proxies
                             WHERE enabled = 1 AND exit_ip IS NOT NULL AND exit_ip <> ''`).all();
  } catch {
    // 表还没建（懒建表）⇒ 全 0，不因为可观测性把主流程搞挂
    return out;
  }
  const assumedMinutes = Number(readSetting(EPOCH_SETTING_KEYS.assumedMinutes, '0')) || 0;
  const riskRaw = Number(readSetting(EPOCH_SETTING_KEYS.riskSeconds, String(DEFAULT_ROTATION_RISK_SECONDS)));
  const riskSeconds = Number.isFinite(riskRaw) ? riskRaw : DEFAULT_ROTATION_RISK_SECONDS;

  for (const r of rows) {
    out.probed++;
    if (Number(r.rotation_count || 0) > 0) out.rotated++;
    const v = rotationView({
      proxyUrl: r.url, exitIp: r.exit_ip, exitIpAt: r.exit_ip_at,
      rotations: r.rotation_count, assumedMinutes, riskSeconds, now,
    });
    if (!v.ok) { out.unknown++; continue; }
    if (v.anchorAt === null) { out.no_anchor++; continue; }
    if (out[v.risk] === undefined) out.unknown++;
    else out[v.risk]++;
  }
  return out;
}

/** 供巡检调用：把"本次观测到的出口"与库里的对比，维护锚点与 epoch。 */export function recordObservedExit(database, { url, exitIp, at = new Date().toISOString() }) {
  const s = String(exitIp || '').trim();
  if (!url || !s) return { changed: false, epoch: null };
  const row = database.prepare('SELECT id, exit_ip, exit_ip_at, rotation_count FROM dola_proxies WHERE url=?').get(url);
  if (!row) return { changed: false, epoch: null };
  const old = String(row.exit_ip || '').trim();
  if (old === s && row.exit_ip_at) {
    // 同一个出口：只刷新 keep-alive 时间戳会掩盖真实轮换，所以**不动锚点**
    database.prepare('UPDATE dola_proxies SET exit_ip=?, updated_at=? WHERE id=?').run(s, at, row.id);
    return { changed: false, epoch: (row.rotation_count || 0) + 1 };
  }
  const rotations = (row.rotation_count || 0) + (old ? 1 : 0);
  database.prepare('UPDATE dola_proxies SET exit_ip=?, exit_ip_at=?, rotation_count=?, updated_at=? WHERE id=?')
    .run(s, at, rotations, at, row.id);
  return { changed: Boolean(old) && old !== s, epoch: rotations + 1, from: old || null, to: s };
}
