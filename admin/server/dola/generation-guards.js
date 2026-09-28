import { classifyFailure, FAILURE_REASONS } from './generation-analytics.js';
import { isVerifiedNativeCapability } from './generation-policy.js';
import { DURATION_SOURCE } from './generation-duration.js';

export const GENERATION_GUARD_SCHEMA = `CREATE TABLE IF NOT EXISTS dola_generation_guards (
  account_id INTEGER NOT NULL, scope TEXT NOT NULL, reason_code TEXT NOT NULL,
  source_task_id INTEGER NOT NULL, blocked_at TEXT NOT NULL, cleared_at TEXT,
  PRIMARY KEY(account_id,scope)
);`;

/**
 * 失败 → 作用域。作用域决定"封多久、封多宽"。
 *
 * `duration:<n>`  只封该账号的那个时长（能力问题是按时长算的）。
 * `reference-images` / `login` 是**账号级**：与请求时长无关，一旦命中就不该再被选中。
 *   —— `login` 对照参考站 §4：`unsigned`（未登录）是独立状态、不参与调度。
 *      页面连创作输入框都拿不到时，问题不在某个时长上，而在整个账号的登录态。
 */
export function failureScope(row) {
  const { code } = classifyFailure(row.error);
  if (code === 'reference') return 'reference-images';
  // ★ 2026-09-25 新增：登录未确认 → 账号级防护。
  //   原先这句话被 session 分支的正则（含「登录」）先吃掉，session 没有作用域，
  //   于是 failureScope 返回 null、recordGenerationGuard 直接返回 false、**一个防护都不建** ——
  //   这个号就永远留在待选池里，每轮再白烧最多 3 分钟。这是线上真实故障，不是理论问题。
  if (code === 'login') return 'login';
  // ⚠️ 这里**故意保留 10/20**：本集合只用于「历史 capability 防护」的作用域命名与解锁判定，
  // 不是新提交的准入白名单。历史库里存在 seconds=10/20 的防护记录，把它们排除在集合外
  // 会让 clearGenerationGuard 对它们返回 false —— 那就是本项目吃过的"永久锁"。
  // 新提交准入由 SUPPORTED_VIDEO_SECONDS 把关（2026-09-27 档位精简）。
  return code === 'capability' && [10, 15, 20, 30].includes(Number(row.seconds)) ? `duration:${Number(row.seconds)}` : null;
}

/**
 * 只有这两种作用域有对应的**账号级能力字段**（见 `capabilityColumn`）：
 * 探测结果会写回 `native_<n>s_state/_at`，因此"更晚的探针"才有东西可比。
 *
 * ⚠️ 10 秒 / 20 秒**故意不在此表内**：库和账号表里根本没有 `native_10s_*` /
 *    `native_20s_*` 字段（`capabilityColumn` 对它们返回 null），无从取得证据，
 *    所以它们的防护不会被探针自动证伪 —— 这也是改动前的行为。
 */
const GUARD_SUPERSEDE_COLUMN = Object.freeze({
  'duration:15': 'native_15s',
  'duration:30': 'native_30s',
});

/**
 * 更晚的只读探针是否已经证伪这条防护？
 *
 * ── 复用的是本文件**已经写明**的原则，不是新规矩 ────────────────────────
 * `recordGenerationGuard` 里有一句：
 *     // A newer verified probe wins over an old failed callback / historical import.
 * 但那条保护原先**只在写入时**生效。读取时（`hasGenerationGuard`）没有对应实现，
 * 于是下面这个**真实发生过的**序列会把账号永久压死：
 *
 *     #424  09:12:21  30 秒任务失败（模型控件未加载完）→ 建 `duration:30` 防护
 *     #424  10:32:29  只读探针确认「10 秒载体可用」→ native_30s_state='available'
 *     之后每次选号：防护仍在 → 30 秒永远 0 个可选账号
 *
 * 即使 `native_30s_note` 里明明白白写着"已确认…可用"，`hasGenerationGuard`
 * 也看不见 —— 这就是本项目反复吃过的「永久锁」（见 `submission-journal.js`
 * 的 uncertain、以及 test/generation-login-guard.mjs ③ 的注释）。
 *
 * ── 判据（刻意收窄）────────────────────────────────────────────────
 * 只有同时满足才认定"已被证伪"：
 *   · 该作用域有账号级能力字段（上表）；
 *   · 字段状态是 `available`（不是 unknown —— unknown 是"没确认"，不是证据）；
 *   · 时间戳**严格晚于**该次失败（同刻或更早都不算，避免同批写入自己把自己解开）。
 *
 * @param {{guard_scope:string, guard_blocked_at:string, [k:string]:any}} row
 *   一行 `guard_*` 前缀的防护字段 + 账号的 `native_15s_state/_at`、`native_30s_state/_at`。
 */
export function guardSupersededByProbe(row) {
  const prefix = GUARD_SUPERSEDE_COLUMN[String(row?.guard_scope || '')];
  if (!prefix) return false;
  const state = row[`${prefix}_state`];
  const at = String(row[`${prefix}_at`] ?? '');
  const blockedAt = String(row?.guard_blocked_at ?? '');
  return state === 'available' && at !== '' && blockedAt !== '' && at > blockedAt;
}

/**
 * 这个账号在 `seconds` 这个时长上是否仍被防护拦着？
 *
 * 与 `listGenerationGuards`（后台展示）用**同一个** `guardSupersededByProbe`：
 * 两处各判一遍的话，页面会显示"已拦截"而调度认为"可派号"，是最难查的一类不一致。
 */
export function hasGenerationGuard(db, accountId, seconds, refs = false) {
  const rows = db.prepare(`SELECT g.scope AS guard_scope, g.blocked_at AS guard_blocked_at,
      a.native_15s_state, a.native_15s_at, a.native_30s_state, a.native_30s_at
    FROM dola_generation_guards g JOIN dola_accounts a ON a.id = g.account_id
    WHERE g.account_id=? AND g.cleared_at IS NULL
      AND (g.scope=? OR g.scope='login' OR (?=1 AND g.scope='reference-images'))`)
    .all(accountId, `duration:${Number(seconds)}`, refs ? 1 : 0);
  // 可能同时命中多条（例如 duration:30 + login）；任一条仍然有效就算被拦。
  return rows.some(row => !guardSupersededByProbe(row));
}

function capabilityColumn(scope) {
  // login 复用同样的三段式账号字段（login_state / login_at / login_note），
  // 于是"记录"和"解除"都能走和时长能力**完全一样**的代码路径，不需要第二套机制
  //（这正是它可解除、不会变成第二个永久锁的原因）。
  if (scope === 'login') return 'login';
  return scope === 'reference-images' ? 'reference_image'
    : ['duration:15', 'duration:30'].includes(scope) ? `native_${scope.split(':')[1]}s` : null;
}

/**
 * 写回账号字段时用的状态值。
 *
 * ⚠️ 两者语义**不同**，不能都写 unknown：
 *   - 时长/参考图能力探测失败，只说明"没确认"→ 写 `unknown`（绝不断言"不可用"）。
 *   - 登录未确认是**有明确证据的否定结论**（创作输入框始终没出现）→ 写成 `unavailable` 才诚实，
 *     选号也能据此直接排除它（对照参考站 §4 的 `unsigned` 态）。
 */
const GUARD_ACCOUNT_STATE = Object.freeze({ login: 'unavailable' });

const GUARD_ACCOUNT_NOTE = Object.freeze({
  login: '未确认登录态（创作输入框未出现），已暂停选号并等待只读复核',
});

// Only called after the task transitions to failed. Cancelled/late callbacks cannot poison accounts.
export function recordGenerationGuard(db, row, accountSnapshot) {
  const scope = failureScope(row);
  if (!scope || row.status !== 'failed' || !row.account_id) return false;
  const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(row.account_id);
  if (!current) return false;
  if (accountSnapshot && ['cookie_hash', 'proxy', 'sec_user_id'].some(key => current[key] !== accountSnapshot[key])) return false;
  const at = row.finished_at || row.updated_at || row.created_at;
  const column = capabilityColumn(scope);
  // A newer verified probe wins over an old failed callback / historical import.
  if (column && current[`${column}_state`] === 'available' && current[`${column}_at`] > at) return false;
  const existing = db.prepare('SELECT * FROM dola_generation_guards WHERE account_id=? AND scope=?').get(row.account_id, scope);
  if (existing && (existing.blocked_at >= at || existing.cleared_at >= at)) return false;
  db.prepare(`INSERT INTO dola_generation_guards(account_id,scope,reason_code,source_task_id,blocked_at,cleared_at)
    VALUES(?,?,?,?,?,NULL) ON CONFLICT(account_id,scope) DO UPDATE SET
    reason_code=excluded.reason_code,source_task_id=excluded.source_task_id,blocked_at=excluded.blocked_at,cleared_at=NULL`)
    .run(row.account_id, scope, classifyFailure(row.error).code, row.id, at);
  if (column) db.prepare(`UPDATE dola_accounts SET ${column}_state=?,${column}_at=?,${column}_note=?,updated_at=? WHERE id=?`)
    .run(GUARD_ACCOUNT_STATE[scope] || 'unknown', at,
      GUARD_ACCOUNT_NOTE[scope] || `生成任务 #${row.id} 未确认能力，已暂停并等待只读复核`,
      new Date().toISOString(), row.account_id);
  return true;
}

// Startup-only backfill; GET analytics never mutates accounts. Cleared rows are retained as evidence.
export function seedHistoricalGenerationGuards(db) {
  let count = 0;
  const rows = db.prepare(`SELECT id,account_id,seconds,status,error,created_at,updated_at,finished_at,has_reference_images
    FROM dola_videos WHERE status IN ('ready','failed') ORDER BY id DESC`).all();
  const seen = new Set();
  for (const row of rows) {
    if (row.status === 'ready') {
      seen.add(`${row.account_id}/duration:${Number(row.seconds)}`);
      if (row.has_reference_images) seen.add(`${row.account_id}/reference-images`);
      continue;
    }
    const scope = failureScope(row);
    if (!scope) continue;
    const key = `${row.account_id}/${scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (recordGenerationGuard(db, row)) count++;
  }
  return count;
}

// A successful read-only probe is the only UI unlock path; it never buys quota or submits a prompt.
/**
 * 只读复核通过 → 解除防护。
 *
 * ── `allowCarrierRewrite` 为什么必须传进来（2026-09-26 线上事实）──────────
 * 30 秒的**页面 UI 里没有 30 秒档位**：服务端 `video-duration` 的 `option_list`
 * 实测只下发 `5`/`10`（三个模型重看三次一致）。所以 30 秒永远拿不到
 * `uiSeconds===30 && native===true` 这种"精确目标证据"——它天生只能靠
 * 「短档位载体 + 请求改写」跑通。
 *
 * 而这里原先**硬编码**了那个精确条件，于是：
 *     `duration:30` 的解锁分支永远返回 false ⇒ 一条**永久锁**。
 * 账号 #424 正是这样被 09:12 的一次瞬时失败（模型控件未加载完）锁住的，
 * 尽管 10:32 的只读探针已经把 `native_30s_state` 写成了 `available`、
 * 备注写着"已确认页面 10 秒载体可用"。
 *
 * 生成路径在 2026-09-26 已经接受载体口径（`isVerifiedNativeCapability` +
 * `allowCarrierRewrite`，见 generator.js 与 routes/dola.js 的 probeNativeCapability），
 * **解锁路径漏改** —— 正是 routes/dola.js 注释里警告过的
 * 「探针把号记成 available、生成时却选不到档位」的反向版本：
 * 「生成已经认了，解锁却不认」。
 *
 * ⚠️ 保守起见只对 **30 秒**放开，且只在开关打开时：
 *    默认（`allowCarrierRewrite=false`）逐字保留历史口径，
 *    test/generation-analytics.mjs 的「10s rewrite carrier cannot clear a prior 30s
 *    capability failure」断言过这一点。
 *    10/15 秒本来就是原生档位、走精确口径，行为不变；
 *    20 秒与上游合成档位存在**同一类**漏改，但线上都还未触发（prod 无对应防护），
 *    留作后续单独处理，不在本次扩大改动面。
 */
export function clearGenerationGuard(db, guard, accountSnapshot, result, at = new Date().toISOString(), {
  allowUpstreamConcat = false, allowCarrierRewrite = false,
} = {}) {
  if (!result?.ok || result.state !== 'available') return false;
  const duration = /^duration:(10|15|20|30)$/.exec(guard.scope);
  if (duration) {
    const seconds = Number(duration[1]);
    if (seconds === 30 && allowCarrierRewrite === true) {
      // 与生成路径同源，读同一对开关、同一个判定函数。
      if (!isVerifiedNativeCapability(result, seconds, { allowUpstreamConcat, allowCarrierRewrite })) return false;
    } else if (result.seconds !== seconds || result.uiSeconds !== seconds || result.native !== true
      || result.rewriteCarrier !== false
      || (seconds === 30 && result.source !== DURATION_SOURCE.NATIVE_SINGLE)
      || result.model !== (seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5')) return false;
  } else if (guard.scope === 'login') {
    // ★ 「登录未确认」的解除凭据：只读探针**真的拿到了创作输入框**并认出了一个时长控件。
    //
    // 为什么不能只看 result.ok / state==='available'：那只是"页面探测跑完了"，
    // 必须同时证明「登录态 + 创作面板可用」这两件事。所以要求探针给出一个合法的时长识别结果
    // （原生 10/15 秒 native=true；20/30 秒是改写载体 rewriteCarrier=true，同样说明控件被认出来了）。
    //
    // ⚠️ 这一条分支是**必须存在**的：没有它 clearGenerationGuard 会对未知作用域直接返回 false，
    //    于是 login 防护永远解不开 —— 那就是本项目已经吃过一次的"永久锁"（见 submission-journal.js
    //    里 uncertain「一旦写入就没有任何代码路径能离开它」）。test/generation-login-guard.mjs 专门断言可解除。
    // 同上：解锁判定要保持能覆盖历史 10/20 记录，不能跟着档位精简一起收紧。
    const secs = Number(result.seconds), ui = Number(result.uiSeconds);
    if (![10, 15, 20, 30].includes(secs) || ![10, 15, 20, 30].includes(ui)) return false;
    if (result.native !== true && result.rewriteCarrier !== true) return false;
  } else if (guard.scope !== 'reference-images') return false;
  const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(guard.account_id);
  if (!current || current.status !== 'valid'
    || ['cookie_hash', 'proxy', 'sec_user_id'].some(key => current[key] !== accountSnapshot[key])) return false;
  if (db.prepare("SELECT 1 FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(guard.account_id)) return false;
  const changed = db.prepare(`UPDATE dola_generation_guards SET cleared_at=?
    WHERE account_id=? AND scope=? AND source_task_id=? AND blocked_at=? AND cleared_at IS NULL`)
    .run(at, guard.account_id, guard.scope, guard.source_task_id, guard.blocked_at).changes;
  const column = capabilityColumn(guard.scope);
  if (changed && column) db.prepare(`UPDATE dola_accounts SET ${column}_state='available',${column}_at=?,${column}_note=?,updated_at=? WHERE id=?`)
    .run(at, guard.scope === 'login'
      ? '只读复核通过：已确认页面处于登录态且创作输入框可用；未提交视频，不保证额度或成片成功'
      : '只读复核通过；仅确认页面控件，不保证生成成功或额度充足', at, guard.account_id);
  return Boolean(changed);
}

export function listGenerationGuards(db) {
  return db.prepare(`SELECT g.*,
      g.scope AS guard_scope, g.blocked_at AS guard_blocked_at,
      a.native_15s_state, a.native_15s_at, a.native_30s_state, a.native_30s_at
    FROM dola_generation_guards g JOIN dola_accounts a ON a.id=g.account_id
    WHERE g.cleared_at IS NULL ORDER BY g.blocked_at DESC`).all()
    // 已被更晚的只读探针证伪的防护不出现在列表里 —— 与 hasGenerationGuard 同一判据，
    // 否则页面会显示"已拦截"而调度认为"可派号"。
    .filter(row => !guardSupersededByProbe(row))
    .map(row => ({
    ...row,
    // 直接按库里存下来的 reason_code 取文案，而不是从别处再猜一句话 ——
    // 猜的那版会把 login 防护显示成"能力探测未完成"，运维看了不知道该修登录还是修控件。
    ...(FAILURE_REASONS[row.reason_code] || FAILURE_REASONS.other),
    label: row.scope === 'reference-images' ? '参考图'
      : row.scope === 'login' ? '登录态'
        : `${row.scope.split(':')[1]} 秒`,
  }));
}
