/**
 * 账号失败分调度（fail score）—— 对照参考站 68.64.176.15 的核心机制。
 *
 * ── 抄的是参考站的哪一块 ──────────────────────────────────────────────────
 * 参考站的 `/admin/route` 排序表头是：号 | 排序 | 剩余额度 | 失败分 | 占用 | 原因。
 * 每个账号带 fail_score（上限 fail_cap=50）、consecutive_failures、success_rate、samples。
 * 选号排序的输入是：剩余额度多者优先、失败分低者优先、占用空闲优先。
 *
 * 我们原来的 candidates() 只按 last_used_at 轮转 —— 一个号最近连续失败 5 次，
 * 只要"最久没用"还是会被第一个选中。这就是要补的内核：**让"这个号最近老失败"进入排序**。
 *
 * ── 权重从哪来（不是自己编的）────────────────────────────────────────────
 * 失败类型直接复用 generation-analytics.js 的 classifyFailure 13 类。
 * 权重的语义是：**这个失败有多大可能是"账号本身的问题"**：
 *   会话失效 / 能力不符 / 参考图控件 / 代理出口 —— 账号的问题 → 重罚
 *   限流 / 网络抖动 / 计费校验 / 服务重启 / 参数拦截 —— 不是账号的错 → 轻罚或不罚
 * 这点和参考站对齐：限流（rate_limit）在参考站里走 cooldown 而不是往死里罚。
 *
 * ── 本模块的约束 ──────────────────────────────────────────────────────────
 * 只接受调用方传入的 db 句柄做窄更新；不碰浏览器、不发网络、不读文件。
 * 所有函数幂等或单调，重复记账不会产生负分。
 */
import { classifyFailure } from './generation-analytics.js';

/** 失败分上限（对齐参考站 fail_cap）。 */
export const FAIL_SCORE_CAP = 50;

/** 每小时自然衰减的失败分。衰减让"几天前失败过的号"能慢慢回到候选前列。 */
export const FAIL_SCORE_DECAY_PER_HOUR = 10;

/**
 * 14 类失败的扣分权重。键与 classifyFailure 的 code 一一对应，**不许漏键**。
 * 漏了会被 test/account-score.mjs 的"权重表与 14 类一一对应"拦住。
 */
export const FAILURE_WEIGHTS = Object.freeze({
  login: 9,        // 登录未确认 / 创作页没出现输入框 —— 连创作面板都拿不到，最像账号本身的问题
  session: 8,      // 登录/身份/账号状态异常 —— 账号的问题
  proxy: 7,        // 代理/出口未通过 —— 账号的出口配置问题
  capability: 6,   // 时长/模型/入口未确认 —— 账号能力问题
  reference: 6,    // 参考图控件未确认 —— 账号能力问题
  duration: 5,     // 成片时长验收失败 —— 半账号半链路
  other: 5,        // 待人工核实 —— 中性偏保守
  archive: 4,      // 归档/媒体校验失败 —— 偏链路
  receipt: 4,      // 未获得任务回执 —— 偏链路
  rate_limit: 3,   // 上游限流 —— 不是账号的错（它走 cooldown），轻罚
  network: 3,      // 网络/超时 —— 抖动，轻罚
  billing: 2,      // 计费校验失败 —— 我们的问题，不是账号的
  request: 2,      // 请求参数校验拦截 —— 链路问题
  interrupted: 1,  // 服务重启中断 —— 完全不是账号的错
});

const nowIso = () => new Date().toISOString();

/**
 * 任务失败 → 给账号记一笔。从任务行 caller 传入 accountId 与错误原文。
 * @returns {{code:string, weight:number, failScore:number}} 记账结果（供日志/测试断言）
 */
export function recordTaskFailure(db, accountId, message, { at = nowIso() } = {}) {
  const id = Number(accountId);
  // ⚠️ id <= 0 必须拒：Number(null) === 0 是合法整数，而 queued 任务失败时 account_id 恰好是 null。
  //    不拒的话会拿 id=0 去 UPDATE（无害但语义错），还会返回一个看着像记了账的结果。
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const info = classifyFailure(message);
  const weight = FAILURE_WEIGHTS[info.code] ?? FAILURE_WEIGHTS.other;
  db.prepare(`UPDATE dola_accounts SET
      fail_score = MIN(?, COALESCE(fail_score, 0) + ?),
      consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
      last_failure_at = ?, fail_count = COALESCE(fail_count, 0) + 1, updated_at = ?
    WHERE id = ?`).run(FAIL_SCORE_CAP, weight, at, at, id);
  const failScore = db.prepare('SELECT fail_score FROM dola_accounts WHERE id = ?').get(id)?.fail_score ?? null;
  return { code: info.code, weight, failScore };
}

/** 任务成功 → 失败分清零、连续失败归零、成功计数 +1。 */
export function recordTaskSuccess(db, accountId, { at = nowIso() } = {}) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  db.prepare(`UPDATE dola_accounts SET
      fail_score = 0, consecutive_failures = 0,
      success_count = COALESCE(success_count, 0) + 1, updated_at = ?
    WHERE id = ?`).run(at, id);
}

/** 真正向上游派发成功 → 记下时间（最短提交间隔的输入）。只在 onDispatch 调。 */
export function markAccountSubmitted(db, accountId, { at = nowIso() } = {}) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  db.prepare('UPDATE dola_accounts SET last_submit_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
}

/**
 * 有效失败分 = 原始分按时间衰减（每小时 -DECAY，下限 0）。
 * 衰减不落库 —— 在排序/展示时现算，避免后台再跑一个衰减任务。
 */
export function effectiveFailScore(account, nowMs = Date.now()) {
  const raw = Number(account?.fail_score) || 0;
  if (!raw) return 0;
  const at = Date.parse(account?.last_failure_at || '');
  if (!Number.isFinite(at)) return raw;   // 没有失败时间戳就没法衰减，保守取原值
  const hours = Math.max(0, (nowMs - at) / 3600000);
  return Math.max(0, raw - hours * FAIL_SCORE_DECAY_PER_HOUR);
}

/** 排序用的额度口径：确认过的剩余额度优先，未知的退回 quota_total（默认 4）。 */
export function quotaOf(account) {
  // ⚠️ 必须先用 != null 判「未读数」，再做 Number —— Number(null) === 0 是 finite，
  //    直接 Number 会把「额度未知」误判成「额度为零」，把这个号排到候选队尾。
  const r = account?.quota_remaining;
  if (r != null && Number.isFinite(Number(r))) return Number(r);
  const t = account?.quota_total;
  if (t != null && Number.isFinite(Number(t))) return Number(t);
  return 4;
}

/**
 * 提交间隔节流状态。设置项 dola_gen_min_submit_interval_sec 早就存在
 * 但生成路径从没读过（假设置）—— 这里是它第一个真正的使用点。
 * 因为 exit_ip 独占校验保证「一个出口只绑一个有效账号」，按账号节流与按出口节流等价。
 */
export function submitThrottle(account, minIntervalSec, nowMs = Date.now()) {
  const interval = Number(minIntervalSec) || 0;
  if (interval <= 0) return { throttled: false, waitSeconds: 0 };
  const at = Date.parse(account?.last_submit_at || '');
  if (!Number.isFinite(at)) return { throttled: false, waitSeconds: 0 };
  const elapsed = (nowMs - at) / 1000;
  const wait = Math.ceil(interval - elapsed);
  return wait > 0 ? { throttled: true, waitSeconds: wait } : { throttled: false, waitSeconds: 0 };
}

/**
 * 选号排序：有效失败分低者优先 → 剩余额度多者优先 → 最久未用者优先 → id 小者优先。
 * 最后一层保留原来的 last_used_at 轮转语义（同 IP 别可着一个号薅）。
 * 返回新数组，不改原数组。
 */
export function rankCandidates(accounts, { nowMs = Date.now() } = {}) {
  return [...accounts].sort((a, b) => {
    const sa = effectiveFailScore(a, nowMs), sb = effectiveFailScore(b, nowMs);
    if (sa !== sb) return sa - sb;
    const qa = quotaOf(a), qb = quotaOf(b);
    if (qa !== qb) return qb - qa;
    const la = String(a.last_used_at || ''), lb = String(b.last_used_at || '');
    if (la !== lb) return la < lb ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });
}

/**
 * 路由决策视图的一行（字段白名单：绝不带 cookie / proxy / exit_ip / cookie_hash）。
 * 对齐参考站表头「号 | 排序 | 剩余额度 | 失败分 | 占用 | 原因」。
 */
export function routeRow(account, rank, { nowMs = Date.now(), minIntervalSec = 0, inflight = false } = {}) {
  const failScore = effectiveFailScore(account, nowMs);
  const throttle = submitThrottle(account, minIntervalSec, nowMs);
  const quota = quotaOf(account);
  const bits = [];
  if (failScore > 0) bits.push(`失败分 ${failScore.toFixed(1)}（连续失败 ${Number(account.consecutive_failures) || 0} 次）`);
  else bits.push('无未衰减失败');
  bits.push(`剩余额度 ${quota}`);
  if (throttle.throttled) bits.push(`提交间隔未到（还需 ${throttle.waitSeconds}s）`);
  if (inflight) bits.push('有任务在飞');
  return {
    id: Number(account.id),
    label: String(account.label || ''),
    rank,
    failScore,
    rawFailScore: Number(account.fail_score) || 0,
    consecutiveFailures: Number(account.consecutive_failures) || 0,
    successCount: Number(account.success_count) || 0,
    failCount: Number(account.fail_count) || 0,
    quotaRemaining: quota,
    lastUsedAt: account.last_used_at || null,
    lastSubmitAt: account.last_submit_at || null,
    lastFailureAt: account.last_failure_at || null,
    throttled: throttle.throttled,
    waitSeconds: throttle.waitSeconds,
    inflight: Boolean(inflight),
    reason: bits.join('；'),
  };
}
