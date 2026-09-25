/**
 * 网关定价与每日额度 —— 「按模型计费」+「每令牌每日上限」。
 *
 * 之前只有一个全局的 `gateway_points_per_task`，所有模型、所有时长同价。两个后果：
 *   ① 30 秒任务与 10 秒任务成本明显不同却同价，**定价没有抓手**；
 *   ② 一个令牌可以在一天内把整个号池的额度烧光，**没有日上限**。
 *
 * ── 定价键的形状（刻意做成"人能读、能手改"的 JSON）────────────────────────
 *
 *   gateway_model_costs = {
 *     "default": 1,
 *     "seedance_v2.0": 2,          // 15 秒走这个模型
 *     "seedance_v2.5": 1,
 *     "seedance_v2.5|30": 3        // 模型|秒数，最精确的一档
 *   }
 *
 * 命中顺序（从最精确到最粗）：`模型|秒数` → `模型` → `default` → 设置 `gateway_points_per_task`。
 * 每一步都用 `source` 回报**到底是哪一档命中的**，否则"价格不对"根本无法排查。
 *
 * ── 为什么整份 JSON 坏了就整体不生效，而不是"能读几条算几条" ──────────────
 * 半份生效的价目表是最坏的：运营以为 30 秒收 3 分，实际因为一个多余逗号
 * 整份 JSON 解析失败、全部回落到 1 分 —— 用户白用，而**没有任何地方报错**。
 * 所以：解析失败 ⇒ 整份忽略 + 走 default + 明确回报 `parse_error`。
 *
 * ── 每日额度的口径（这里错了会导致"钱扣了但额度没算"）──────────────────────
 *   · 用**净消耗**：`Σconsume − Σrefund`（同一天内）。
 *     生成失败会退款，失败的任务**不该**占用户当天的额度。
 *   · 净值为负时夹到 0（可能今天退了昨天扣的），不把额度"退成负数"白送。
 *   · 日界用**服务器本地午夜**，不是 UTC 午夜 —— 否则对中国运维来说
 *     "每天 08:00 重置"，现象是"额度莫名在早上多出来"，非常难解释。
 */
import { db as appDb, getSetting } from '../db.js';
import { SUPPORTED_VIDEO_SECONDS } from './generation-policy.js';

export const QUOTA_SETTING_KEYS = Object.freeze({
  defaultPoints: 'gateway_points_per_task',
  modelCosts: 'gateway_model_costs',
  dailyLimit: 'gateway_daily_points_limit',
});

/** 定价键里的兜底档位名。 */
export const COST_DEFAULT_KEY = 'default';

/**
 * 任务用哪个模型。
 *
 * ⚠️ 这条规则**必须与 `generation-policy.js` 的 `normalizeVideoDuration().targetModel` 一致**，
 *    否则会出现"按 v2.5 收费、实际跑 v2.0"这种对不上账的情况。
 *    那边对 10 秒返回 `null`（表示沿用页面默认），而 10 秒的页面默认是 v2.5
 *    （见 `generation-model.js` 的 `selectSeedance(page, 'seedance_v2.5')`），
 *    所以这里把 10 秒也归到 v2.5。测试里会拿真函数交叉核对 15/20/30 三档。
 */
export function modelForTask({ seconds } = {}) {
  const s = Number(seconds);
  if (s === 15) return 'seedance_v2.0';
  return 'seedance_v2.5';
}

/** 比模型更精确的一档：`模型|秒数`。 */
export const costKeyForTask = ({ seconds } = {}) => {
  const s = Number(seconds);
  return Number.isFinite(s) ? `${modelForTask({ seconds: s })}|${s}` : '';
};

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/**
 * 解析价目表 JSON。
 *
 * @returns {{ok: boolean, costs: object, reason: string}}
 *   `ok:false` 时**整份作废**（调用方必须回落，而不是部分采用）。
 */
export function parseModelCosts(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, costs: {}, reason: 'empty' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, costs: {}, reason: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, costs: {}, reason: 'not_an_object' };
  }
  const costs = {};
  for (const [key, value] of Object.entries(parsed)) {
    const n = Number(value);
    if (key === COST_DEFAULT_KEY && Number.isFinite(n) && n >= 0) {
      // default 允许 0（= 免费档），但其余档位不接受 0，以免"某个模型静默免费"
      costs[key] = Math.floor(n);
      continue;
    }
    if (!isPositiveInt(n)) return { ok: false, costs: {}, reason: `bad_value:${key}` };
    costs[key] = n;
  }
  return { ok: true, costs, reason: 'ok' };
}

/**
 * 算出这一次任务该扣多少积分，并说明依据。
 *
 * @returns {{points: number, source: string, key: string, costsReason: string}}
 *   source ∈ `exact`（模型|秒数）/ `model` / `default_key` / `setting`
 */
export function resolveTaskPoints({ seconds, readSetting = getSetting } = {}) {
  // ⚠️ 这里的兜底必须**自己校验**，不能只靠 `|| 1`：`Number('-5')` 是 -5（truthy），
  //    于是负的 `gateway_points_per_task` 会一路传成负价 —— 负价扣费等于**给用户加积分**。
  //    实测过：设置写成 -5 时旧写法确实返回 -5。所以：
  //      · 非有限/≤0（0、-5、''、'abc'） → 1
  //      · 正小数 → 向下取整（宁可少收，不可多收；也保证返回的永远是正整数）
  const rawFallback = Number(readSetting(QUOTA_SETTING_KEYS.defaultPoints, '1'));
  const fallback = Number.isFinite(rawFallback) && rawFallback > 0 ? Math.floor(rawFallback) : 1;
  const parsed = parseModelCosts(readSetting(QUOTA_SETTING_KEYS.modelCosts, ''));
  const costs = parsed.ok ? parsed.costs : {};

  const exactKey = costKeyForTask({ seconds });
  if (exactKey && isPositiveInt(costs[exactKey])) {
    return { points: costs[exactKey], source: 'exact', key: exactKey, costsReason: parsed.reason };
  }
  const modelKey = modelForTask({ seconds });
  if (isPositiveInt(costs[modelKey])) {
    return { points: costs[modelKey], source: 'model', key: modelKey, costsReason: parsed.reason };
  }
  if (Number.isFinite(costs[COST_DEFAULT_KEY]) && costs[COST_DEFAULT_KEY] > 0) {
    return { points: costs[COST_DEFAULT_KEY], source: 'default_key', key: COST_DEFAULT_KEY, costsReason: parsed.reason };
  }
  return { points: fallback, source: 'setting', key: QUOTA_SETTING_KEYS.defaultPoints, costsReason: parsed.reason };
}

// ---------------------------------------------------------------- 日界与用量

/** 服务器**本地**日界的 `YYYY-MM-DD`。 */
export function localDayKey(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 某令牌某天的净消耗积分（consume − refund，夹到 ≥ 0）。
 *
 * ⚠️ 时间**不在 SQL 里比**：`created_at` 在生产库里有两种写法
 *   （应用写的 ISO `2026-09-25T08:00:00.000Z`，夹具写的 SQLite `2026-09-25 08:00:00`），
 *   拿 ISO 字符串去和 `' '` 分隔的字符串做字典序比较会得到**静默错误**的结果。
 *   所以先用 `substr(created_at,1,10)` 做**粗筛**，再在 JS 里用 `Date.parse` 精确判定。
 *
 * ⚠️ 粗筛窗口取 **3 天**（本地日的前后各一天）而不是 2 天：ISO 日期与本地日期最多差
 *   一天，方向上却可能是 +1（服务器在 UTC+14 时，本地日中午对应的 UTC 日期是**前一天**；
 *   在 UTC-12 时对应的又是**后一天**）。候选集放宽**不会引入错数** ——
 *   它只是让更多行进入下面那段精确判定，而精确判定才是权威的。
 */
export function dailyConsumedPoints(database = appDb, tokenId, at = new Date()) {
  const base = at instanceof Date ? at : new Date(at);
  const moment = Number.isFinite(base.getTime()) ? base : new Date();
  const day = localDayKey(moment);
  const id = Number(tokenId);
  if (!Number.isFinite(id) || id <= 0) return 0;

  const candidates = [-1, 0, 1].map((offset) => {
    const d = new Date(moment.getTime());
    d.setDate(d.getDate() + offset);
    return localDayKey(d);
  });

  const rows = database.prepare(`SELECT kind, delta, created_at FROM point_transactions
    WHERE token_id=? AND kind IN ('consume','refund') AND substr(created_at,1,10) IN (?,?,?)`)
    .all(id, candidates[0], candidates[1], candidates[2]);

  let consume = 0;
  let refund = 0;
  for (const row of rows) {
    const ts = Date.parse(String(row.created_at).replace(' ', 'T'));
    if (!Number.isFinite(ts)) continue;
    if (localDayKey(new Date(ts)) !== day) continue;   // 精确判定：必须在同一个本地日
    const delta = Number(row.delta) || 0;
    if (row.kind === 'consume') consume += delta;
    else refund += delta;
  }
  return Math.max(0, consume - refund);
}

/**
 * 解析某令牌的每日上限。
 *
 * 优先级：令牌自带 `daily_points_limit` → 全局设置 `gateway_daily_points_limit`。
 * `null` 表示"用全局"，`0` 表示"不限"，正数表示上限。
 * ⇒ 令牌上显式写 0 可以给某个令牌开无限额，不会被全局限制盖住。
 */
export function resolveDailyLimit({ token, readSetting = getSetting } = {}) {
  const own = token?.daily_points_limit;
  if (own !== null && own !== undefined && own !== '') {
    const n = Number(own);
    if (Number.isFinite(n) && n >= 0) return { limit: Math.floor(n), source: 'token' };
  }
  const global = Number(readSetting(QUOTA_SETTING_KEYS.dailyLimit, '0'));
  if (Number.isFinite(global) && global >= 0) return { limit: Math.floor(global), source: 'global' };
  return { limit: 0, source: 'none' };
}

/**
 * 这次提交之后的额度视图。
 *
 * @param {object} p
 * @param {number} p.points  本次要扣的积分（用于算 `ok`）
 * @returns {{limit:number, used:number, remaining:number, ok:boolean, reason:string, day:string, limitSource:string}}
 *   `limit=0` ⇒ `remaining` 报 `null`（无限额，不是"剩 0"）。
 */
export function quotaView({ database = appDb, token, points = 0, readSetting = getSetting, at = new Date() } = {}) {
  const { limit, source } = resolveDailyLimit({ token, readSetting });
  const used = dailyConsumedPoints(database, token?.id, at);
  const day = localDayKey(at);
  if (limit <= 0) {
    return { limit: 0, used, remaining: null, ok: true, reason: 'unlimited', day, limitSource: source };
  }
  const remaining = Math.max(0, limit - used);
  const need = Number(points) || 0;
  const ok = need <= remaining;
  return {
    limit, used, remaining, ok,
    reason: ok ? 'ok' : 'daily_limit_exceeded',
    day, limitSource: source,
  };
}

/** 给 `/v1/status` 用：不带"本次要扣多少"，只报当前状态。 */
export const usageSnapshot = ({ database = appDb, token, readSetting = getSetting, at = new Date() } = {}) =>
  quotaView({ database, token, points: 0, readSetting, at });

// ---------------------------------------------------------------- 入参解析

/**
 * 解析「每令牌每日上限」的**输入值**（写库那一侧）。
 *
 * 三态必须分得清，因为它们的行为完全不同：
 *   `null` / `undefined` / `''` → `null`（用全局设置）
 *   `0`                        → `0`（该令牌不限，**覆盖**全局）
 *   正整数                     → 上限
 *
 * ⚠️ 绝不能写成 `Number(raw) || null`：那样 `0` 会被吞成 `null`，
 *    「给某一个令牌单独开无限额」就永远做不到了 —— 而那正是这个字段存在的理由之一，
 *    否则令牌上根本没法关掉全局日上限（比如给内部测试号）。
 *    读的那一侧在 `resolveDailyLimit()`，两边必须共用这套三态语义。
 *
 * @returns {{ok:boolean, value:number|null, message:string}}
 *   `ok:false` 时 `value` 无意义，调用方应直接 400，不要回落成 null
 *   ——「我输错了」和「我要用全局」是两件事，静默回落会让配置改不生效还查不出原因。
 */
export function parseDailyPointsLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null, message: '' };
  // ⚠️ 对象/数组必须显式挡掉：`Number([])` 是 **0**，`Number([5])` 是 **5**。
  //    于是 body 里传个 `[]` 会被静默解释成「这个令牌不限」——
  //    方向是**把上限关掉**，正是最危险的一种静默失败。
  if (typeof raw === 'object') {
    return { ok: false, value: null, message: '每日积分上限必须是数字（留空=跟随全局，0=不限）' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, value: null, message: '每日积分上限必须是数字（留空=跟随全局，0=不限）' };
  }
  if (n < 0) return { ok: false, value: null, message: '每日积分上限不能为负' };
  return { ok: true, value: Math.floor(n), message: '' };
}

export { SUPPORTED_VIDEO_SECONDS };
