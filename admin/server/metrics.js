/**
 * Prometheus 文本指标导出 + 告警聚合。
 *
 * ── 抄的是参考站的哪一块 ──────────────────────────────────────────────────
 * 参考站 68.64.176.15（dola2api 2.3.13）有 `GET /metrics`（Prometheus 文本格式，15 个自研指标）
 * 和 `GET /admin/alerts`（聚合告警态）。我们这两块都缺 ——
 * 但更关键的是：**数据源我们早就有了，只是从来没有出口**：
 *   · `chain-text-rules.js` 的 `chainTextSnapshot()` → 上游文本分类计数 + 协议漂移态
 *   · `generator.js` 的 `generationStatus()`     → 队列/并发/在建任务
 *   · 账号池、代理池、成片库的状态计数
 * 于是「上游协议漂移了」「号池空了」「任务卡住了」这些事，
 * 目前只有**盯着后台页面的人**才可能发现。这个模块把它们变成可被抓取的指标与可查询的告警。
 *
 * ── 指标命名 ──────────────────────────────────────────────────────────────
 * 统一前缀 `dola_admin_`（对标参考站的 `dola2api_`，同一类指标语义一致、只换服务名前缀）：
 *   dola2api_chain_text_rules_total{rule}      → dola_admin_chain_text_rules_total{rule}
 *   dola2api_protocol_alert                    → dola_admin_protocol_drift
 *   dola2api_queue_jobs / queue_oldest_wait_seconds
 *   dola2api_account_inflight{account}         → dola_admin_accounts_*   （我们按状态聚合，不带账号标签）
 *   dola2api_alerts_total{kind}                → dola_admin_alerts_active / dola_admin_alert{kind}
 *   dola2api_nowatermark_resolver_errors_total{reason} → dola_admin_watermark_resolutions_total{outcome}
 *
 * ── 安全：**绝不照抄参考站的做法** ────────────────────────────────────────
 * 参考站的 `/metrics` 与 `/health` 都是**免鉴权公开**的，其中 `/health` 697 KB、含 164 个账号明细。
 * 我们这里遵守两条硬约束：
 *   ① 指标里**不带账号 id / cookie / 代理串 / 出口 IP** 作为标签 —— 只做状态聚合计数。
 *      （参考站有 `account_inflight{account="acc193"}`，等于把号池清单送出去。）
 *   ② `/metrics` **必须鉴权**：管理员会话，或一个显式配置的抓取密钥（`metrics_key`）。
 *      没配密钥时**只有**管理员会话能看 —— 绝不"为了方便采集"而默认敞开。
 *
 * ── counter 还是 gauge（这里很容易写错，写错会污染监控）────────────────────
 * Prometheus 的 `counter` 语义是**单调不减**。凡是从数据库现算的，行会被删除/清理，
 * 数值会下降 —— 那些**必须**声明成 `gauge`，否则 PromQL 的 rate/increase 会算出负值或异常尖峰。
 *   · `chain_text_rules_total` 是**进程内累加**、只增不减 → `counter`
 *   · 水印解析结果分布、任务数、账号数都是**每次从库里现算** → `gauge`
 */
import { rotationSummary, ROTATION_RISKS } from './dola/proxy-epoch.js';
import { readinessSummary, READINESS_GRADES, isAlertable } from './dola/readiness.js';
import { switchView, SWITCH_KEYS } from './dola/feature-switch.js';
// 支持的秒数是**生成策略**的事，不在本文件里另抄一份（抄了就会漂移）
import { SUPPORTED_VIDEO_SECONDS } from './dola/generation-policy.js';
// 原生 15/30 与参考图池的**真值来源**。放在这里是有意的：就绪度需要这三个布尔，
// 而"由调用方注入"的写法实测失败了（见 collectMetrics 的 pools 注释）。
import {
  nativeFifteenSecondPoolStats, nativeThirtySecondPoolStats, referenceImagePoolStats,
} from './dola/generator.js';

/**
 * 解析"原生能力就绪"那三个布尔。
 *
 * ⚠️★ 这个函数的存在本身就是一次踩坑的产物。原来是 `collectMetrics(..., pools = {})` 由调用方注入，
 * 注释还写着"metrics.js 不该知道 dola 号池的探针细节"。听起来干净，实际上
 * **两个调用点（routes/metrics.js、routes/dola.js）一个都没注入** ⇒ `pools` 恒 `{}` ⇒
 * `readingSummary` 里 15/30 档位恒判"不可用" ⇒ `grade` **永远 degraded**。
 * 后果不止是显示难看：生产实测 `readiness_degraded` 告警**永久 active**，
 * 而且是那台机器上**唯一**一条激活的告警 —— 真正的故障会被这条噪音淹没。
 *
 * 所以改成**默认自己算**：传了就尊重（单测注入），没传就地取真值。
 * "可选注入点"一旦没人注入就等于一个静默的错误默认值，这种设计不该留。
 *
 * @param {object|null} pools 显式传入的就绪布尔；为 null/undefined 时自己取
 * @param {Function[]|null} readers 三个读取器，仅测试用；生产用真函数
 */
export function resolvePools(pools, readers = null) {
  if (pools) return pools;
  const [n15, n30, refs] = readers
    || [nativeFifteenSecondPoolStats, nativeThirtySecondPoolStats, referenceImagePoolStats];
  try {
    return {
      expertSecondsReady: n15()?.ready,
      fixedSecondsReady: n30()?.ready,
      referenceImagesReady: refs()?.ready,
    };
  } catch {
    // 号池表还没建等异常：保持空对象（= 15/30 判不可用），
    // 但**不因为可观测性把主流程搞挂**。这一档是"取不到真值"，不是"真值就是不可用"，
    // 二者会体现在 reasons 里（调用方仍能看到原生档位不可用这条）。
    return {};
  }
}

/** Prometheus 文本格式的标签值转义：反斜杠、双引号、换行。 */
export function escapeLabelValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** 指标名只允许 [a-zA-Z0-9_:]，非法字符换成下划线，避免脏枚举值拼出非法指标名。 */
export function sanitizeMetricName(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_:]/g, '_');
}

// ── 告警阈值（集中在此，便于一处调）────────────────────────────────────────
export const ALERT_THRESHOLDS = Object.freeze({
  /** 排队最老任务等待超过这么久 → 告警（秒）。调度积压的早期信号。 */
  queueOldestWaitSeconds: 15 * 60,
  /** 单条任务停在 submitting/generating/resolving 超过这么久 → 卡住（分钟）。 */
  stuckTaskMinutes: 45,
  /** 代理死号+隔离数占比超过这个比例 → 告警。 */
  proxyDeadRatio: 0.3,
  /** 无水印解析失败占比超过这个比例 → 告警（且样本数需达标）。 */
  watermarkFailureRatio: 0.5,
  watermarkMinSamples: 10,
});

const VIDEO_STATUSES = ['queued', 'submitting', 'generating', 'resolving', 'ready', 'failed', 'cancelled'];
const ACCOUNT_STATUSES = ['valid', 'invalid', 'unknown', 'disabled'];
const LOGIN_STATES = ['unknown', 'available', 'unavailable'];
const PROXY_STATES = ['unknown', 'alive', 'dead', 'quarantined'];
const WATERMARK_OUTCOMES = ['ok', 'no_fallback_api', 'resolve_failed', 'exception'];

/** 把 `unwatermark_note` 归类成稳定枚举 —— 对标参考站的 `nowatermark_resolver_errors_total{reason}`。
 *  文案在 generator.js 里生成（`)` 里有四种），这里只做前缀匹配；匹配不上归 `unknown`，
 *  而 `unknown` 一旦增长就是"文案改了、该更新分类"的信号（和 chain-text 的 `none` 同一个思路）。 */
export function classifyWatermarkNote(note, isUnwatermarked) {
  if (isUnwatermarked) return 'ok';
  const text = String(note || '');
  if (!text) return null;
  if (text.startsWith('无水印解析成功')) return 'ok';
  if (text.includes('没有 fallback_api 字段')) return 'no_fallback_api';
  if (text.includes('解析失败')) return 'resolve_failed';
  if (text.startsWith('无水印解析异常')) return 'exception';
  return 'unknown';
}

function parseTime(value) {
  const ms = Date.parse(String(value ?? '').replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(String(value ?? '')) ? '' : 'Z'));
  return Number.isFinite(ms) ? ms : null;
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

/**
 * 采集一次快照。返回**结构化数据**（不是字符串），
 * 这样告警、测试、指标渲染三处共用同一份口径，不会各算各的。
 *
 * 所有依赖都可注入，便于单测在没有数据库的情况下断言渲染结果。
 */
export function collectMetrics({
  db,
  chainTextSnapshot,
  generationStatus,
  now = () => Date.now(),
  // 各档位原生能力的就绪布尔（`{ expertSecondsReady, fixedSecondsReady, referenceImagesReady }`）。
  // ⚠️★ **不传就自己去取真值**（见 resolvePools）。这里曾经写成 `pools = {}` 并注释
  //    "由调用方注入"，结果**两个调用点一个都没注入** ⇒ `pools` 恒为 `{}` ⇒
  //    15/30 档位恒判"不可用" ⇒ `readiness.grade` **永远 degraded**（哪怕原生探针
  //    后来确认了能力也变不成 ok），连带 `readiness_degraded` 告警**永久 active**。
  //    教训：**可选的注入点如果没人注入，就等于一个静默的错误默认值**。
  //    传了就用传的（单测注入），没传就地算 —— 让"忘记注入"不再可能。
  pools = null,
  // 三个原生池统计的读取器（仅供单测替换；生产用真函数）
  poolReaders = null,
  // 设置读取注入点（默认用 db.js 的 getSetting）。单测里没有初始化 db.js 时可以注入。
  readSetting,
} = {}) {
  const nowMs = now();

  // ── 队列 / 并发 ───────────────────────────────────────────────────────
  const gen = typeof generationStatus === 'function' ? generationStatus() : {};

  // ── 任务（按状态）─────────────────────────────────────────────────────
  const videoRows = db.prepare('SELECT status, COUNT(*) AS c FROM dola_videos GROUP BY status').all();
  const videosByStatus = {};
  for (const s of VIDEO_STATUSES) videosByStatus[s] = 0;
  for (const row of videoRows) videosByStatus[String(row.status)] = row.c;

  // 最老排队任务的等待秒数：**在 JS 里解析**而不是交给 SQL 比较字符串 ——
  // 库里 created_at 存在两种格式（应用写 ISO，历史/夹具可能是 datetime('now') 的
  // 'YYYY-MM-DD HH:MM:SS'），直接字符串比较会算错。
  let oldestQueuedWaitSeconds = 0;
  for (const row of db.prepare("SELECT created_at FROM dola_videos WHERE status='queued'").all()) {
    const t = parseTime(row.created_at);
    if (t === null) continue;
    oldestQueuedWaitSeconds = Math.max(oldestQueuedWaitSeconds, Math.max(0, (nowMs - t) / 1000));
  }

  // 卡住的任务：停在"在飞"状态但很久没动
  const activeRows = db.prepare(
    "SELECT id, status, updated_at FROM dola_videos WHERE status IN ('submitting','generating','resolving')",
  ).all();
  const stuckTasks = [];
  for (const row of activeRows) {
    const t = parseTime(row.updated_at);
    if (t === null) continue;
    const minutes = (nowMs - t) / 60000;
    if (minutes >= ALERT_THRESHOLDS.stuckTaskMinutes) stuckTasks.push({ id: row.id, status: row.status, minutes: Math.round(minutes) });
  }

  // ── 账号池 ────────────────────────────────────────────────────────────
  const accountRows = db.prepare('SELECT status, login_state, cooldown_until FROM dola_accounts').all();
  const accountsByStatus = {};
  for (const s of ACCOUNT_STATUSES) accountsByStatus[s] = 0;
  const accountsByLoginState = {};
  for (const s of LOGIN_STATES) accountsByLoginState[s] = 0;
  let accountsCooling = 0;
  for (const row of accountRows) {
    const status = String(row.status);
    accountsByStatus[status] = (accountsByStatus[status] || 0) + 1;
    const state = String(row.login_state || 'unknown');
    accountsByLoginState[state] = (accountsByLoginState[state] || 0) + 1;
    const until = parseTime(row.cooldown_until);
    if (until !== null && until > nowMs) accountsCooling += 1;
  }

  // ── 就绪度合成分级 ────────────────────────────────────────────────────
  // 把"到底能不能用"收成一个可告警的结论（见 dola/readiness.js）。
  // ⚠️ 指标里**不要**输出 reasons：标签基数会炸，而且那是内部资源情报。
  //    理由在 /api/dola/alerts 与 /api/gateway/health 里看。
  let readiness = { grade: 'down', reasons: ['采集失败'], acute: ['采集失败'], seconds: { supported: [], ready: [] } };
  try {
    // 网关开关按**对外**这一侧判（`/v1` 与 `/api/gateway/*` 同属对外入口）。
    // ⚠️ `readSetting` 必须往下传：不传的话它会用 db.js 的 `getSetting`，
    //    在"db 还没初始化"的场景下抛异常 → 被本块的 catch 吞掉 → readiness 被静默压成 down。
    //    这与 `pools` 是同一个毛病（注入点没接到底），同一份文件里犯过两次。
    const gatewayView = switchView({
      key: SWITCH_KEYS.gateway, scope: 'v1', fallback: 'true', readSetting,
    });
    readiness = readinessSummary({
      gatewayEnabled: gatewayView.effective_enabled,
      // 复用已经算好的计数，避免再查一次库、也避免两份口径漂移
      counts: { valid: accountsByStatus.valid || 0, cooling: accountsCooling },
      generation: gen,
      pools: resolvePools(pools, poolReaders),
      database: db,
      readSetting,
      at: new Date(nowMs),
    });
  } catch { /* 可观测性不能把主流程搞挂 */ }

  // ── 代理池（dola_proxies 由 proxy-pool.js 懒建表，缺失时全 0 而不是抛异常）────
  const proxiesByState = {};
  for (const s of PROXY_STATES) proxiesByState[s] = 0;
  let proxiesEnabled = 0;
  let proxiesTotal = 0;
  try {
    for (const row of db.prepare('SELECT state, enabled FROM dola_proxies').all()) {
      proxiesTotal += 1;
      const state = String(row.state || 'unknown');
      proxiesByState[state] = (proxiesByState[state] || 0) + 1;
      if (Number(row.enabled) === 1) proxiesEnabled += 1;
    }
  } catch { /* 表还没建：保持全 0，不因为可观测性把主流程搞挂 */ }

  // ── 代理出口轮换（epoch）──────────────────────────────────────────────
  // ⚠️ 算的是**上界**：IPWeb 的粘性窗口锚在它自己的时钟上（见 dola/proxy-epoch.js）。
  //    所以 `stale` 的准确含义是"我们的估计已过期、该重新核验了"，**不是**"已经轮换"。
  //    指标名与帮助文本都必须带上这个限定，否则告警规则会被写错。
  let proxiesRotation = { probed: 0, rotated: 0, low: 0, high: 0, stale: 0, unknown: 0, no_anchor: 0 };
  try {
    proxiesRotation = rotationSummary({ database: db });
  } catch { /* 同上：可观测性不能把主流程搞挂 */ }

  // ── 无水印解析结果分布 ────────────────────────────────────────────────
  const watermarkRows = db.prepare(
    "SELECT is_unwatermarked, unwatermark_note, local_path FROM dola_videos WHERE status IN ('ready','failed')",
  ).all();
  const watermarkOutcomes = {};
  for (const o of WATERMARK_OUTCOMES) watermarkOutcomes[o] = 0;
  let watermarkUnknown = 0;
  let videosUnwatermarked = 0;
  let videosArchived = 0;
  for (const row of watermarkRows) {
    if (Number(row.is_unwatermarked) === 1) videosUnwatermarked += 1;
    if (String(row.local_path || '')) videosArchived += 1;
    const outcome = classifyWatermarkNote(row.unwatermark_note, Number(row.is_unwatermarked) === 1);
    if (outcome === null) continue;                       // 终态但没有解析记录（如取消）—— 不进分母
    if (Object.hasOwn(watermarkOutcomes, outcome)) watermarkOutcomes[outcome] += 1;
    else watermarkUnknown += 1;
  }
  const watermarkSampled = Object.values(watermarkOutcomes).reduce((a, b) => a + b, 0);
  const watermarkFailed = watermarkOutcomes.no_fallback_api + watermarkOutcomes.resolve_failed + watermarkOutcomes.exception;

  // ── 上游协议分类（进程内计数）────────────────────────────────────────
  const chainText = typeof chainTextSnapshot === 'function' ? chainTextSnapshot() : null;

  // ── 业务面 ────────────────────────────────────────────────────────────
  const tokenStats = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active, COALESCE(SUM(points),0) AS points FROM tokens").get();

  return {
    collectedAt: new Date(nowMs).toISOString(),
    uptimeSeconds: Math.floor(Number(process.uptime?.() ?? 0)),
    generation: {
      active: Number(gen.activeTasks || 0),
      queued: Number(gen.queued || 0),
      concurrency: Number(gen.concurrency || 0),
      available: Number(gen.available || 0),
      queueLimit: Number(gen.queueLimit || 0),
      queueAvailable: Number(gen.queueAvailable || 0),
      reservedAccounts: Number(gen.reservedAccounts || 0),
    },
    videosByStatus,
    oldestQueuedWaitSeconds,
    stuckTasks,
    accountsByStatus,
    accountsByLoginState,
    accountsCooling,
    proxiesTotal,
    proxiesEnabled,
    proxiesByState,
    proxiesRotation,
    readiness,
    watermarkOutcomes,
    watermarkUnknown,
    watermarkSampled,
    watermarkFailed,
    videosUnwatermarked,
    videosArchived,
    chainText,
    tokens: {
      total: Number(tokenStats?.total || 0),
      active: Number(tokenStats?.active || 0),
      points: Number(tokenStats?.points || 0),
    },
  };
}

/**
 * 聚合告警。每条都是 `{kind, level, active, message, value, threshold}`。
 *
 * 设计约束：**只报"已确认"的事，不猜**。比如账号池空了只在
 * 「valid 账号一个候选都没有」这种硬事实上告警，而不是靠推测。
 */
export function buildAlerts(snapshot) {
  const alerts = [];
  const s = snapshot;

  // ① 上游协议漂移（对标参考站 protocol_drift）
  const chain = s.chainText;
  alerts.push({
    kind: 'protocol_drift',
    level: 'critical',
    active: Boolean(chain?.protocolDrift),
    message: chain?.protocolDrift
      ? `上游消息链连续 ${chain.consecutiveProtocolFailures} 轮认不出来，疑似协议/文案漂移`
      : '上游协议分类正常',
    value: Number(chain?.consecutiveProtocolFailures || 0),
    threshold: Number(chain?.threshold || 0),
  });

  // ② 队列积压
  alerts.push({
    kind: 'generation_backlog',
    level: 'warning',
    active: Number(s.oldestQueuedWaitSeconds) >= ALERT_THRESHOLDS.queueOldestWaitSeconds,
    message: `最老排队任务已等待 ${Math.round(Number(s.oldestQueuedWaitSeconds) || 0)} 秒`,
    value: Math.round(Number(s.oldestQueuedWaitSeconds) || 0),
    threshold: ALERT_THRESHOLDS.queueOldestWaitSeconds,
  });

  // ③ 任务卡住
  alerts.push({
    kind: 'stuck_tasks',
    level: 'critical',
    active: s.stuckTasks.length > 0,
    message: s.stuckTasks.length
      ? `${s.stuckTasks.length} 条任务停在生成中超过 ${ALERT_THRESHOLDS.stuckTaskMinutes} 分钟（#${s.stuckTasks.slice(0, 5).map((t) => t.id).join(' #')}）`
      : '没有长期卡住的任务',
    value: s.stuckTasks.length,
    threshold: 0,
  });

  // ④ 号池可用性：一个候选都没有（valid 且未明确判死）
  const usableAccounts = s.accountsByStatus.valid;
  alerts.push({
    kind: 'account_pool_empty',
    level: 'critical',
    active: usableAccounts === 0,
    message: usableAccounts === 0
      ? '账号池里没有 status=valid 的账号，任何生成请求都会被预检拦下'
      : `status=valid 的账号 ${usableAccounts} 个`,
    value: usableAccounts,
    threshold: 1,
  });

  // ⑤ 代理池健康
  const dead = (s.proxiesByState.dead || 0) + (s.proxiesByState.quarantined || 0);
  const deadRatio = ratio(dead, s.proxiesTotal);
  alerts.push({
    kind: 'proxy_pool_degraded',
    level: 'warning',
    active: s.proxiesTotal > 0 && deadRatio >= ALERT_THRESHOLDS.proxyDeadRatio,
    message: s.proxiesTotal === 0
      ? '代理池是空的（没有导入任何代理）'
      : `代理池死号/隔离 ${dead}/${s.proxiesTotal}（${(deadRatio * 100).toFixed(1)}%）`,
    value: Number(deadRatio.toFixed(4)),
    threshold: ALERT_THRESHOLDS.proxyDeadRatio,
  });

  // ⑥ 无水印解析失败率
  const wmRatio = ratio(s.watermarkFailed, s.watermarkSampled);
  alerts.push({
    kind: 'watermark_resolver_degraded',
    level: 'warning',
    active: s.watermarkSampled >= ALERT_THRESHOLDS.watermarkMinSamples && wmRatio >= ALERT_THRESHOLDS.watermarkFailureRatio,
    message: s.watermarkSampled === 0
      ? '还没有可统计的成片'
      : `无水印解析失败 ${s.watermarkFailed}/${s.watermarkSampled}（${(wmRatio * 100).toFixed(1)}%）`
        + (s.watermarkUnknown ? `，另有 ${s.watermarkUnknown} 条原因未归类（文案可能改了）` : ''),
    value: Number(wmRatio.toFixed(4)),
    threshold: ALERT_THRESHOLDS.watermarkFailureRatio,
  });

  // ⑦ 就绪度合成分级（见 dola/readiness.js）。
  // 放在最后：它是**结论**，前面几条是**证据**。运维应当先看这一条判断"要不要动手"，
  // 再看上面的细分定位"动哪里"。
  // ⚠️ `level` 随分级变（down=critical / degraded=warning）：把 down 也报成 warning
  //    会让"完全不可用"和"有点缺口"在告警面板上长得一模一样。
  // ⚠️★ `active` **不能**写成 `grade !== 'ok'`（曾经的写法，代价是永久误报）。
  //    `degraded` 在生产里是**常态**（账号的原生 15/30 能力在探针确认前一直是 unknown），
  //    一律告警等于这条告警永久 active。判据必须是 `isAlertable()` —— 只对 **acute**
  //    缺口（账号冷却 / 号池偏低 / 队列满 / down）告警。详见 dola/readiness.js 文件头 ③。
  const readinessGrade = s.readiness?.grade || 'down';
  const readinessAlertable = isAlertable(s.readiness);
  const readinessReasons = s.readiness?.reasons || [];
  const readinessAcute = Array.isArray(s.readiness?.acute) ? s.readiness.acute : [];
  alerts.push({
    kind: 'readiness_degraded',
    level: readinessGrade === 'down' ? 'critical' : 'warning',
    active: readinessAlertable,
    message: readinessGrade === 'ok'
      ? '就绪度 ok（没有已知缺口）'
      : readinessAlertable
        // 告警时优先列 acute（只说可处理的），fallback 到全部理由（老快照没 acute 字段时）
        ? `就绪度 ${readinessGrade}：${(readinessAcute.length ? readinessAcute : readinessReasons).join('；') || '原因未采集'}`
        : `就绪度 ${readinessGrade}，但只有常态缺口，不告警（${readinessReasons.join('；') || '原因未采集'}）`
          + ' —— 这类能力基线看 dola_admin_seconds_ready 就行',
    value: READINESS_GRADES.indexOf(readinessGrade),
    threshold: READINESS_GRADES.indexOf('ok'),
  });

  return alerts;
}

/**
 * 渲染成 Prometheus 文本格式（`text/plain; version=0.0.4`）。
 *
 * 两个容易写错的点：
 *   ① **枚举值要补齐再输出**：某个状态这一轮是 0 也必须输出那一行，
 *      否则 Grafana 的曲线会"断一截"，反而看不出"掉到 0 了"。
 *   ② 每个指标族只写一次 `# HELP` / `# TYPE`。
 */
export function renderPrometheus(snapshot, { alerts = null } = {}) {
  const out = [];
  const family = (name, help, type) => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
  };
  const line = (name, labels, value) => {
    const entries = Object.entries(labels || {});
    const suffix = entries.length
      ? `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
      : '';
    out.push(`${name}${suffix} ${Number.isFinite(value) ? value : 0}`);
  };

  const s = snapshot;

  family('dola_admin_build_info', '构建信息，值恒为 1，用于确认抓的是哪个服务', 'gauge');
  line('dola_admin_build_info', { service: 'admin-console' }, 1);

  family('dola_admin_uptime_seconds', '进程已运行秒数', 'gauge');
  line('dola_admin_uptime_seconds', null, s.uptimeSeconds);

  // ── 上游协议分类 + 漂移 ───────────────────────────────────────────────
  const chain = s.chainText;
  family('dola_admin_chain_text_rules_total',
    '上游消息链文本按规则分类的次数（rule=none 持续上涨 = 疑似协议漂移）', 'counter');
  for (const rule of ['prompt_echo', 'quota', 'quota_exhausted', 'voided', 'accepted', 'upstream_error', 'none']) {
    line('dola_admin_chain_text_rules_total', { rule }, Number(chain?.rules?.[rule] || 0));
  }
  family('dola_admin_protocol_drift', '是否处于协议漂移告警态（1=告警中）', 'gauge');
  line('dola_admin_protocol_drift', null, chain?.protocolDrift ? 1 : 0);
  family('dola_admin_protocol_consecutive_failures', '连续认不出上游文本的轮数', 'gauge');
  line('dola_admin_protocol_consecutive_failures', null, Number(chain?.consecutiveProtocolFailures || 0));
  family('dola_admin_protocol_drift_threshold', '触发协议漂移告警的连续失败阈值', 'gauge');
  line('dola_admin_protocol_drift_threshold', null, Number(chain?.threshold || 0));
  family('dola_admin_chain_text_unclassifiable_total',
    '无判定条件因而**不计入**漂移计数的轮数（既不加也不清零）', 'counter');
  line('dola_admin_chain_text_unclassifiable_total', null, Number(chain?.unclassifiable || 0));

  // ── 队列 / 并发 ───────────────────────────────────────────────────────
  family('dola_admin_generation_active', '在飞任务数', 'gauge');
  line('dola_admin_generation_active', null, s.generation.active);
  family('dola_admin_generation_queued', '等待中的调度请求数（内存等待者）', 'gauge');
  line('dola_admin_generation_queued', null, s.generation.queued);
  family('dola_admin_generation_concurrency', '配置的并发上限', 'gauge');
  line('dola_admin_generation_concurrency', null, s.generation.concurrency);
  family('dola_admin_generation_available', '当前可用的并发位', 'gauge');
  line('dola_admin_generation_available', null, s.generation.available);
  family('dola_admin_generation_queue_limit', '队列总上限（在跑+排队）', 'gauge');
  line('dola_admin_generation_queue_limit', null, s.generation.queueLimit);
  family('dola_admin_generation_queue_available', '队列剩余名额', 'gauge');
  line('dola_admin_generation_queue_available', null, s.generation.queueAvailable);
  family('dola_admin_generation_reserved_accounts', '正被其他提交占用/体检的账号数', 'gauge');
  line('dola_admin_generation_reserved_accounts', null, s.generation.reservedAccounts);

  family('dola_admin_queue_oldest_wait_seconds', '排队最久的那条任务已等待的秒数', 'gauge');
  line('dola_admin_queue_oldest_wait_seconds', null, Math.round(s.oldestQueuedWaitSeconds));

  // 任务数：库删行会让它下降 → 必须是 gauge（见文件头 counter/gauge 说明）
  family('dola_admin_videos', '生成任务数（按状态，DB 现算）', 'gauge');
  for (const status of VIDEO_STATUSES) {
    line('dola_admin_videos', { status }, Number(s.videosByStatus[status] || 0));
  }

  // ── 账号池 ────────────────────────────────────────────────────────────
  family('dola_admin_accounts', '账号数（按 status）', 'gauge');
  for (const status of ACCOUNT_STATUSES) {
    line('dola_admin_accounts', { status }, Number(s.accountsByStatus[status] || 0));
  }
  family('dola_admin_accounts_login_state', '账号数（按登录态核验结果）', 'gauge');
  for (const state of LOGIN_STATES) {
    line('dola_admin_accounts_login_state', { state }, Number(s.accountsByLoginState[state] || 0));
  }
  family('dola_admin_accounts_cooling', '处于冷却中（撞限流退避）的账号数', 'gauge');
  line('dola_admin_accounts_cooling', null, s.accountsCooling);

  // ── 代理池 ────────────────────────────────────────────────────────────
  family('dola_admin_proxies', '代理数（按探测状态）', 'gauge');
  for (const state of PROXY_STATES) {
    line('dola_admin_proxies', { state }, Number(s.proxiesByState[state] || 0));
  }
  family('dola_admin_proxies_total', '代理总数', 'gauge');
  line('dola_admin_proxies_total', null, s.proxiesTotal);
  family('dola_admin_proxies_enabled', '处于启用状态的代理数', 'gauge');
  line('dola_admin_proxies_enabled', null, s.proxiesEnabled);
  // 出口轮换风险分布。⚠️ 五个桶**全部输出**（即使是 0）：枚举桶在降到 0 时消失，
  // 会让 Grafana 上"风险从 3 降到 0"看起来像曲线断了、而不是归零。
  // ⚠️ 算的是上界；`stale` = 该重新核验，**不等于**已轮换。
  family('dola_admin_proxies_rotation_risk',
    '已核验出口的启用代理按轮换风险分桶（上界估计；stale=估计已过期需重新核验，不代表已轮换）', 'gauge');
  for (const risk of ROTATION_RISKS) {
    line('dola_admin_proxies_rotation_risk', { risk }, Number(s.proxiesRotation?.[risk] || 0));
  }
  family('dola_admin_proxies_rotation_observed', '有出口记录（可算轮换）的启用代理数', 'gauge');
  line('dola_admin_proxies_rotation_observed', null, Number(s.proxiesRotation?.probed || 0));
  family('dola_admin_proxies_rotated', '观测到过至少一次出口 IP 变化的启用代理数（epoch>1）', 'gauge');
  line('dola_admin_proxies_rotated', null, Number(s.proxiesRotation?.rotated || 0));

  // ── 无水印解析 ────────────────────────────────────────────────────────
  family('dola_admin_watermark_resolutions', '成片无水印解析结果分布（DB 现算）', 'gauge');
  for (const outcome of WATERMARK_OUTCOMES) {
    line('dola_admin_watermark_resolutions', { outcome }, Number(s.watermarkOutcomes[outcome] || 0));
  }
  if (s.watermarkUnknown) {
    line('dola_admin_watermark_resolutions', { outcome: 'unknown' }, Number(s.watermarkUnknown));
  }
  family('dola_admin_videos_unwatermarked', '拿到无水印版本的成片数', 'gauge');
  line('dola_admin_videos_unwatermarked', null, s.videosUnwatermarked);
  family('dola_admin_videos_archived', '已归档到本地磁盘的成片数', 'gauge');
  line('dola_admin_videos_archived', null, s.videosArchived);

  // ── 令牌业务面 ────────────────────────────────────────────────────────
  family('dola_admin_tokens', '令牌数', 'gauge');
  line('dola_admin_tokens', { status: 'total' }, s.tokens.total);
  line('dola_admin_tokens', { status: 'active' }, s.tokens.active);
  family('dola_admin_token_points', '全部令牌余额合计（积分）', 'gauge');
  line('dola_admin_token_points', null, s.tokens.points);

  // ── 就绪度（合成分级）─────────────────────────────────────────────────
  // 三个桶**全部输出**：`dola_admin_readiness{grade="degraded"} 0` 消失会让
  // "从 degraded 恢复成 ok"看起来像曲线断了。
  // ⚠️ 不输出 reasons：那是内部资源情报，且标签基数会炸。
  family('dola_admin_readiness',
    '就绪度合成分级（1=当前处于该级）。ok/degraded/down 三桶恒定输出；理由见 /api/dola/alerts', 'gauge');
  for (const grade of READINESS_GRADES) {
    line('dola_admin_readiness', { grade }, s.readiness?.grade === grade ? 1 : 0);
  }
  // ★ 这条是"常态降级不告警"的**交叉验证**：
  //   `readiness{grade="degraded"}=1` + `acute_reasons=0` ⇒ 安静是**因为只有常态缺口**；
  //   `acute_reasons>0` ⇒ 与告警 `readiness_degraded` 必须同时为真。两者不一致就是有 bug。
  family('dola_admin_readiness_acute_reasons',
    '就绪度里"异常缺口"的条数（>0 即 readiness_degraded 告警必须为真）。只有常态缺口时保持 0', 'gauge');
  line('dola_admin_readiness_acute_reasons', null,
    Array.isArray(s.readiness?.acute) ? s.readiness.acute.length : 0);
  family('dola_admin_seconds_ready', '各档位当前可提交的秒数（1=可用）。10/20 只需有可用账号，15/30 还需原生能力已确认', 'gauge');
  for (const seconds of s.readiness?.seconds?.supported || SUPPORTED_VIDEO_SECONDS) {
    line('dola_admin_seconds_ready', { seconds }, (s.readiness?.seconds?.ready || []).includes(seconds) ? 1 : 0);
  }
  family('dola_admin_accounts_available', '有效且不在冷却中的账号数（= 现在真的能派出去的数量）', 'gauge');
  line('dola_admin_accounts_available', null, Number(s.readiness?.accounts?.available || 0));

  // ── 告警 ──────────────────────────────────────────────────────────────
  const list = alerts || buildAlerts(s);
  family('dola_admin_alerts_active', '处于激活状态的告警条数', 'gauge');
  line('dola_admin_alerts_active', null, list.filter((a) => a.active).length);
  family('dola_admin_alert', '每条告警的激活状态（1=告警中，0=正常）。kind 与 /api/dola/alerts 一致', 'gauge');
  for (const alert of list) {
    line('dola_admin_alert', { kind: sanitizeMetricName(alert.kind), level: sanitizeMetricName(alert.level) }, alert.active ? 1 : 0);
  }

  return `${out.join('\n')}\n`;
}

/** 一步到位：采集 → 告警 → 渲染。路由直接调它。 */
export function buildMetricsPayload(deps) {
  const snapshot = collectMetrics(deps);
  const alerts = buildAlerts(snapshot);
  return { snapshot, alerts, text: renderPrometheus(snapshot, { alerts }) };
}
