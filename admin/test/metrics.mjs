/**
 * /metrics 与告警聚合的回归。
 *
 * 为什么值得有单测（而不是"打开浏览器看一眼"）：
 *   ① Prometheus 文本格式**格式错了不会报错** —— 抓取端只会静默丢序列或报 parse error，
 *      本地手测很容易看不出。所以这里逐行用正则校验格式。
 *   ② counter / gauge 声明错了会**污染监控数据**（rate() 算出负数），而肉眼完全看不出来。
 *   ③ 告警最容易犯的错是**误报**（阈值太松）和**漏报**（枚举没补全）。
 *      每种告警都要有"该响"和"不该响"两组断言，只测该响的那组等于没测。
 *
 * ── 为什么顶部只静态 import `metrics.js` ────────────────────────────────────
 * `server/metrics.js` 的**数据依赖全部由参数注入**（db / 计数源都不自己查），所以可以安全静态引入。
 * ⚠️ 但它**不是零依赖**：为了就地取"原生 15/30 就绪"的真值，它 import 了 `dola/generator.js`
 *    （见 `resolvePools` 的注释 —— 原来"由调用方注入"的写法因为没人注入而恒判不可用）。
 *    所以**不要**把 metrics.js 放进那些"剥掉 import + 用 box 提供依赖"的沙箱测试里，
 *    它现在有真实模块依赖了。
 * 但 `server/db.js` 的 `DB_PATH` 是在**模块加载时**从 `process.env.ADMIN_DB` 定下来的，
 * 且 `export let db` 要 `initDb()` 之后才有值 ——
 * 所以凡是要碰真库的用例，都必须：先设 `ADMIN_DB` → 再 `await import(...)`（见文件末尾的隔离用例）。
 * 在顶部静态 import db.js 会让 ADMIN_DB 永远来不及生效（这就是本项目既有的约定，
 * 见 test/generation-concurrency.mjs 与 test/media-library.mjs 的注释）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ALERT_THRESHOLDS, buildAlerts, classifyWatermarkNote, collectMetrics,
  escapeLabelValue, renderPrometheus, resolvePools, sanitizeMetricName,
} from '../server/metrics.js';

/** 规则枚举**故意硬编码**：从源码读出来做断言是同义反复，改坏了也测不出来。
 *  末尾的隔离用例再拿它和真实的 CHAIN_TEXT_RULES 对一次，两边都改坏才会漏。 */
const RULE_NAMES = ['prompt_echo', 'quota', 'quota_exhausted', 'voided', 'accepted', 'upstream_error', 'none'];
const VIDEO_STATUSES = ['queued', 'submitting', 'generating', 'resolving', 'ready', 'failed', 'cancelled'];
const PROXY_STATES = ['unknown', 'alive', 'dead', 'quarantined'];

// ── 一根真实的 Prometheus 文本行 ──────────────────────────────────────────
const METRIC_LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?(\d+(\.\d+)?([eE][+-]?\d+)?|NaN|[+-]Inf)$/;

/** 造一份可控快照，避免测试依赖真实库里的数据分布。 */
function snapshot(overrides = {}) {
  return {
    collectedAt: '2026-01-01T00:00:00.000Z',
    uptimeSeconds: 42,
    generation: { active: 0, queued: 0, concurrency: 5, available: 5, queueLimit: 20, queueAvailable: 20, reservedAccounts: 0 },
    videosByStatus: Object.fromEntries(VIDEO_STATUSES.map((s) => [s, 0])),
    oldestQueuedWaitSeconds: 0,
    stuckTasks: [],
    accountsByStatus: { valid: 3, invalid: 0, unknown: 0, disabled: 0 },
    accountsByLoginState: { unknown: 3, available: 0, unavailable: 0 },
    accountsCooling: 0,
    proxiesTotal: 10,
    proxiesEnabled: 10,
    proxiesByState: { unknown: 0, alive: 10, dead: 0, quarantined: 0 },
    watermarkOutcomes: { ok: 10, no_fallback_api: 0, resolve_failed: 0, exception: 0 },
    watermarkUnknown: 0,
    watermarkSampled: 10,
    watermarkFailed: 0,
    videosUnwatermarked: 10,
    videosArchived: 10,
    chainText: {
      rules: Object.fromEntries(RULE_NAMES.map((r) => [r, 0])),
      consecutiveProtocolFailures: 0, threshold: 3, protocolDrift: false, unclassifiable: 0,
    },
    tokens: { total: 2, active: 2, points: 100 },
    // 就绪度合成分级。⚠️ 这个字段**必须**在"健康快照"里显式给出 grade='ok'：
    // buildAlerts 对**缺失**的 readiness 按 'down' 处理（宁可误报也不要把
    // "我没采到"伪装成"我很健康"），所以夹具不给就会多出一条激活告警。
    readiness: {
      grade: 'ok', reasons: [], acute: [],
      seconds: { supported: [15, 30], ready: [15, 30] },
      accounts: { valid: 3, cooling: 0, available: 3 },
      queue: { activeTasks: 0, queueLimit: 20, queueAvailable: 20 },
      at: '2026-01-01T00:00:00.000Z',
    },
    proxiesRotation: { probed: 10, rotated: 0, low: 10, high: 0, stale: 0, unknown: 0, no_anchor: 0 },
    ...overrides,
  };
}

/**
 * 自包含的假库：**不碰真库**，并按需在某个表上抛错（用来验证容错）。
 * 注意判断顺序 —— 越具体的 SQL 必须越先匹配，否则会被通用分支吃掉。
 */
function fakeDb({
  videoRows = [], accountRows = [], proxyRows = [], watermarkRows = [],
  queuedRows = [], activeRows = [], tokenRow = { total: 0, active: 0, points: 0 }, failOn = null,
} = {}) {
  return {
    prepare(sql) {
      if (failOn && sql.includes(failOn)) throw new Error(`no such table: ${failOn}`);
      if (sql.includes("status='queued'")) return { all: () => queuedRows };
      if (sql.includes("IN ('submitting','generating','resolving')")) return { all: () => activeRows };
      if (sql.includes('GROUP BY status')) return { all: () => videoRows };
      if (sql.includes("'ready','failed'")) return { all: () => watermarkRows };
      if (sql.includes('dola_accounts')) return { all: () => accountRows };
      if (sql.includes('dola_proxies')) return { all: () => proxyRows };
      if (sql.includes('tokens')) return { get: () => tokenRow };
      throw new Error(`未预期的 SQL：${sql}`);
    },
  };
}

const NO_DEPS = { chainTextSnapshot: null, generationStatus: null };

// ─────────────────────────────────────────────────────────── ① 文本格式

test('renderPrometheus 输出的每一行都是合法的 Prometheus 文本', () => {
  const text = renderPrometheus(snapshot());
  assert.ok(text.endsWith('\n'), '必须以换行结尾（否则最后一条序列可能被截断）');
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length > 40, `指标行数偏少：${lines.length}`);
  for (const line of lines) {
    if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
    assert.ok(METRIC_LINE.test(line), `非法指标行：${line}`);
  }
});

test('每个指标族只声明一次 HELP/TYPE，且 HELP 紧跟 TYPE 之前', () => {
  const lines = renderPrometheus(snapshot()).split('\n');
  const types = new Map();
  const help = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('# TYPE ')) {
      const name = lines[i].split(' ')[2];
      assert.ok(!types.has(name), `指标族 ${name} 声明了多次 TYPE`);
      types.set(name, lines[i].split(' ')[3]);
      assert.ok(lines[i - 1]?.startsWith(`# HELP ${name} `), `${name} 的 HELP 没紧跟在 TYPE 前面`);
    }
    if (lines[i].startsWith('# HELP ')) {
      const name = lines[i].split(' ')[2];
      assert.ok(!help.has(name), `指标族 ${name} 声明了多次 HELP`);
      help.add(name);
    }
  }
  assert.ok(types.size > 12, `指标族只有 ${types.size} 个`);
});

test('★ 从数据库现算的指标必须声明成 gauge，不能是 counter', () => {
  // counter 是单调不减的语义；DB 行会被删/清，数值会下降。
  // 标错会让 PromQL 的 rate()/increase() 算出负值 —— 这种错在本地一眼看不出来。
  const lines = renderPrometheus(snapshot()).split('\n');
  const typeOf = (name) => {
    const hit = lines.find((l) => l.startsWith(`# TYPE ${name} `));
    return hit ? hit.split(' ')[3] : null;
  };
  for (const name of ['dola_admin_videos', 'dola_admin_accounts', 'dola_admin_proxies',
    'dola_admin_watermark_resolutions', 'dola_admin_videos_unwatermarked', 'dola_admin_tokens']) {
    assert.equal(typeOf(name), 'gauge', `${name} 应声明为 gauge`);
  }
  // 进程内只增不减的才配叫 counter
  assert.equal(typeOf('dola_admin_chain_text_rules_total'), 'counter');
});

test('枚举值即使为 0 也要输出那一行（否则 Grafana 曲线会断一截，看不出"掉到 0 了"）', () => {
  const text = renderPrometheus(snapshot());
  for (const rule of RULE_NAMES) {
    assert.ok(text.includes(`dola_admin_chain_text_rules_total{rule="${rule}"}`), `缺 rule=${rule}`);
  }
  for (const status of VIDEO_STATUSES) {
    assert.ok(text.includes(`dola_admin_videos{status="${status}"}`), `缺 video status=${status}`);
  }
  for (const state of PROXY_STATES) {
    assert.ok(text.includes(`dola_admin_proxies{state="${state}"}`), `缺 proxy state=${state}`);
  }
});

test('标签值转义：双引号、反斜杠、换行都不能把格式撑破', () => {
  assert.equal(escapeLabelValue('a"b'), 'a\\"b');
  assert.equal(escapeLabelValue('a\\b'), 'a\\\\b');
  assert.equal(escapeLabelValue('a\nb'), 'a\\nb');
  assert.equal(escapeLabelValue(null), '');
  assert.equal(sanitizeMetricName('foo-bar baz'), 'foo_bar_baz');
  // 转义之后仍然必须是合法行
  const bad = snapshot({ stuckTasks: [{ id: 1, status: 'ge"n', minutes: 1 }] });
  const text = renderPrometheus(bad);
  for (const line of text.trimEnd().split('\n')) {
    if (line.startsWith('#')) continue;
    assert.ok(METRIC_LINE.test(line), `非法指标行：${line}`);
  }
});

// ─────────────────────────────────────────────────────────── ② 水印来源归类

test('★ classifyWatermarkNote 必须认得住 generator.js 里真实写出的四种文案', () => {
  // 这些字符串直接抄自 generator.js 的 note 赋值处。
  // 一旦文案改了这里会红 —— 这正是想要的（对标 chain-text 的 rule=none 信号）。
  assert.equal(classifyWatermarkNote('无水印解析成功（fallback_api）', 1), 'ok');
  assert.equal(classifyWatermarkNote('消息链里没有 fallback_api 字段（可能该版本不提供无水印源）', 0), 'no_fallback_api');
  assert.equal(classifyWatermarkNote('找到 2 个 fallback_api 但解析失败：missing_bdms / bad_sign', 0), 'resolve_failed');
  assert.equal(classifyWatermarkNote('无水印解析异常：socket hang up', 0), 'exception');
  // 没有解析记录的终态任务（如被取消）不进统计分母
  assert.equal(classifyWatermarkNote('', 0), null);
  // 文案被改过 → unknown（该更新分类了）
  assert.equal(classifyWatermarkNote('上游换了新说法', 0), 'unknown');
});

// ─────────────────────────────────────────────────────────── ③ 告警：该响

test('协议漂移：连续失败达到阈值就该报 critical', () => {
  const s = snapshot();
  s.chainText = { ...s.chainText, protocolDrift: true, consecutiveProtocolFailures: 3, threshold: 3 };
  const alert = buildAlerts(s).find((a) => a.kind === 'protocol_drift');
  assert.equal(alert.active, true);
  assert.equal(alert.level, 'critical');
  assert.match(alert.message, /连续 3 轮/);
});

test('号池空：status=valid 为 0 时必须报警（任何生成都会被预检拦下）', () => {
  const alert = buildAlerts(snapshot({ accountsByStatus: { valid: 0, invalid: 5, unknown: 0, disabled: 0 } }))
    .find((a) => a.kind === 'account_pool_empty');
  assert.equal(alert.active, true);
  assert.equal(alert.level, 'critical');
});

test('代理池劣化：死号+隔离占比达到阈值报警', () => {
  const alert = buildAlerts(snapshot({
    proxiesTotal: 10,
    proxiesByState: { unknown: 0, alive: 6, dead: 3, quarantined: 1 },   // 40% ≥ 30%
  })).find((a) => a.kind === 'proxy_pool_degraded');
  assert.equal(alert.active, true);
  assert.equal(alert.value, 0.4);
});

test('任务卡住：停在生成中超过阈值报警，并带上任务号', () => {
  const alert = buildAlerts(snapshot({ stuckTasks: [{ id: 148, status: 'generating', minutes: 90 }] }))
    .find((a) => a.kind === 'stuck_tasks');
  assert.equal(alert.active, true);
  assert.match(alert.message, /#148/);
});

test('队列积压：最老等待达到阈值报警', () => {
  const alert = buildAlerts(snapshot({ oldestQueuedWaitSeconds: ALERT_THRESHOLDS.queueOldestWaitSeconds + 1 }))
    .find((a) => a.kind === 'generation_backlog');
  assert.equal(alert.active, true);
});

test('无水印解析失败率达标报警，但样本不足时不报', () => {
  const bad = buildAlerts(snapshot({
    watermarkOutcomes: { ok: 2, no_fallback_api: 8, resolve_failed: 0, exception: 0 },
    watermarkSampled: 10, watermarkFailed: 8,
  })).find((a) => a.kind === 'watermark_resolver_degraded');
  assert.equal(bad.active, true);

  const tooFew = buildAlerts(snapshot({
    watermarkOutcomes: { ok: 0, no_fallback_api: 1, resolve_failed: 0, exception: 0 },
    watermarkSampled: 1, watermarkFailed: 1,
  })).find((a) => a.kind === 'watermark_resolver_degraded');
  assert.equal(tooFew.active, false, '样本只有 1 条时不该报 —— 那是一次抖动，不是趋势');
});

// ─────────────────────────────────────────────────────────── ④ 告警：不该响

test('★ 一切正常时一条告警都不该激活（误报比漏报更能毁掉告警的可信度）', () => {
  const alerts = buildAlerts(snapshot());
  assert.deepEqual(alerts.filter((a) => a.active), [], '健康快照下不应有任何激活告警');
  assert.equal(alerts.length, 7, '告警种类数变了就该同步改这个断言');
  for (const a of alerts) {
    assert.ok(a.kind && a.level && typeof a.active === 'boolean');
    assert.ok(Number.isFinite(a.value) && Number.isFinite(a.threshold), `${a.kind} 的 value/threshold 必须是数字`);
  }
});

test('代理池为空（0 条）时不该报"劣化" —— 那是"没配"，不是"坏了"', () => {
  const alert = buildAlerts(snapshot({
    proxiesTotal: 0,
    proxiesByState: { unknown: 0, alive: 0, dead: 0, quarantined: 0 },
  })).find((a) => a.kind === 'proxy_pool_degraded');
  assert.equal(alert.active, false);
  assert.match(alert.message, /空的/);
});

// ───────────────────────── 就绪度合成分级（⑦）─────────────────────────
test('★ 就绪度分级：ok 不报警、down 报 critical、degraded 要分"常态/异常"两路', () => {
  const pick = (grade, reasons = [], acute) => buildAlerts(snapshot({
    readiness: { grade, reasons, ...(acute === undefined ? {} : { acute }) },
  })).find((a) => a.kind === 'readiness_degraded');

  const ok = pick('ok');
  assert.equal(ok.active, false);
  assert.equal(ok.level, 'warning');

  // ★ 核心回归：只有"原生 15/30 未确认"这类**常态缺口**的 degraded **不许告警**。
  //   修复前这里是 active=true，而生产实测 grade 恒 degraded ⇒ 这条告警永久常亮。
  const chronic = pick('degraded', ['原生 30 秒档位当前不可用', '原生 15 秒档位当前不可用'], []);
  assert.equal(chronic.active, false, '★ 常态 degraded 必须安静，否则就是告警疲劳');
  assert.equal(chronic.level, 'warning', 'degraded 是 warning：能用，但有缺口');
  assert.match(chronic.message, /不告警/, 'message 要说清"为什么它不告警"，否则运维以为采集坏了');
  assert.match(chronic.message, /原生 15 秒/, '常态缺口仍要在 message 里可见（诚实，只是不占告警通道）');

  // 有异常缺口（账号冷却）时才告警，且 message 优先说异常的那条
  const acute = pick('degraded', ['原生 30 秒档位当前不可用', '2 个账号在限流冷却中'], ['2 个账号在限流冷却中']);
  assert.equal(acute.active, true);
  assert.equal(acute.level, 'warning');
  assert.match(acute.message, /2 个账号在限流冷却中/);
  assert.ok(!acute.message.includes('原生 30 秒'), '告警 message 只列可处理的异常缺口');

  const down = pick('down', ['号池里没有有效账号']);
  assert.equal(down.active, true);
  assert.equal(down.level, 'critical', 'down 必须比 degraded 更严重，否则告警面板看不出"完全不可用"');
  // 理由要进 message，否则运维只知道"不 ok"却不知道动哪里
  assert.match(down.message, /号池里没有有效账号/);
});

test('★ readiness 字段缺失时按 down 处理（"我没采到"不许伪装成"我很健康"）', () => {
  const s = snapshot();
  delete s.readiness;
  const alert = buildAlerts(s).find((a) => a.kind === 'readiness_degraded');
  assert.equal(alert.active, true, '缺数据要让告警响，而不是静默当健康');
  assert.equal(alert.level, 'critical');
  assert.match(alert.message, /原因未采集/);
});

test('★ 指标里输出三个就绪度桶（即使为 0 也要有 —— 否则"恢复"看起来像曲线断了）', () => {
  for (const grade of ['ok', 'degraded', 'down']) {
    const text = renderPrometheus(snapshot({ readiness: { grade, reasons: [] } }), { alerts: [] });
    for (const g of ['ok', 'degraded', 'down']) {
      const expected = g === grade ? 1 : 0;
      assert.ok(text.includes(`dola_admin_readiness{grade="${g}"} ${expected}`),
        `grade=${grade} 时缺少 dola_admin_readiness{grade="${g}"} ${expected}`);
    }
  }
});

test('★ 指标里输出各档位可提交性，且 15/30 的可用性来自 readiness.seconds.ready', () => {
  const text = renderPrometheus(snapshot({
    readiness: { grade: 'degraded', reasons: [], seconds: { supported: [15, 30], ready: [15] }, accounts: { valid: 5, cooling: 0, available: 5 }, queue: {} },
  }), { alerts: [] });
  assert.ok(text.includes('dola_admin_seconds_ready{seconds="15"} 1'));
  // 档位精简后不再有 10/20 两档的指标序列；30 秒未就绪 → 0
  assert.ok(!text.includes('dola_admin_seconds_ready{seconds="10"}'));
  assert.ok(!text.includes('dola_admin_seconds_ready{seconds="20"}'));
  assert.ok(text.includes('dola_admin_seconds_ready{seconds="30"} 0'));
  assert.ok(text.includes('dola_admin_accounts_available 5'));
});

test('★ 常态降级必须可交叉验证：acute_reasons=0 解释了"degraded 为什么安静"', () => {
  // 只有常态缺口的 degraded：grade 桶=degraded、acute_reasons=0、告警 inactive —— 三者自洽
  const chronicSnapshot = snapshot({
    readiness: { grade: 'degraded', reasons: ['原生 30 秒档位当前不可用'], acute: [], seconds: { supported: [15, 30], ready: [15] }, accounts: { valid: 7, cooling: 0, available: 7 }, queue: {} },
  });
  const text = renderPrometheus(chronicSnapshot, { alerts: buildAlerts(chronicSnapshot) });
  assert.ok(text.includes('dola_admin_readiness{grade="degraded"} 1'));
  assert.ok(text.includes('dola_admin_readiness_acute_reasons 0'));
  assert.equal(buildAlerts(chronicSnapshot).find((a) => a.kind === 'readiness_degraded').active, false);
  assert.match(text, /dola_admin_readiness_acute_reasons.*异常缺口/);

  // 有异常缺口：acute_reasons>0 ⇒ 告警必须同时为真（两者不一致就是 bug）
  const acuteSnapshot = snapshot({
    readiness: { grade: 'degraded', reasons: ['2 个账号在限流冷却中'], acute: ['2 个账号在限流冷却中'], seconds: { supported: [15, 30], ready: [15, 30] }, accounts: { valid: 9, cooling: 2, available: 7 }, queue: {} },
  });
  assert.ok(renderPrometheus(acuteSnapshot, { alerts: [] }).includes('dola_admin_readiness_acute_reasons 1'));
  assert.equal(buildAlerts(acuteSnapshot).find((a) => a.kind === 'readiness_degraded').active, true);

  // 老快照缺 acute 字段 ⇒ 指标按 0 输出但**不抛**（口径由告警侧的保守回落兜住）
  const legacySnapshot = snapshot({ readiness: { grade: 'degraded', reasons: [] } });
  assert.doesNotThrow(() => renderPrometheus(legacySnapshot, { alerts: [] }));
  assert.ok(renderPrometheus(legacySnapshot, { alerts: [] }).includes('dola_admin_readiness_acute_reasons 0'));
});

test('★ 指标里输出出口轮换风险的五个桶（全部输出，含 0）', () => {
  const text = renderPrometheus(snapshot({
    proxiesRotation: { probed: 7, rotated: 2, low: 3, high: 1, stale: 1, unknown: 1, no_anchor: 1 },
  }), { alerts: [] });
  assert.ok(text.includes('dola_admin_proxies_rotation_risk{risk="low"} 3'));
  assert.ok(text.includes('dola_admin_proxies_rotation_risk{risk="high"} 1'));
  assert.ok(text.includes('dola_admin_proxies_rotation_risk{risk="stale"} 1'));
  assert.ok(text.includes('dola_admin_proxies_rotation_risk{risk="unknown"} 1'));
  assert.ok(text.includes('dola_admin_proxies_rotation_risk{risk="no_anchor"} 1'));
  assert.ok(text.includes('dola_admin_proxies_rotation_observed 7'));
  assert.ok(text.includes('dola_admin_proxies_rotated 2'));
  // stale 的语义必须在 HELP 里写清楚，否则告警规则会被写成"已轮换"
  assert.match(text, /stale=估计已过期需重新核验，不代表已轮换/);
});

// ─────────────────────────────────────────────────────────── ⑤ 采集器本身

test('collectMetrics 从假库正确聚合，且不携带任何账号/代理标识', () => {
  const s = collectMetrics({
    db: fakeDb({
      videoRows: [{ status: 'ready', c: 7 }, { status: 'failed', c: 3 }],
      accountRows: [{ status: 'valid', login_state: 'unknown', cooldown_until: null }],
      proxyRows: [{ state: 'alive', enabled: 1 }],
      tokenRow: { total: 4, active: 3, points: 250 },
    }),
    ...NO_DEPS,
  });
  assert.equal(s.videosByStatus.ready, 7);
  assert.equal(s.videosByStatus.failed, 3);
  assert.equal(s.videosByStatus.queued, 0, '库里没有的状态也要补 0');
  assert.equal(s.proxiesTotal, 1);
  assert.equal(s.tokens.points, 250);
  // 指标里不该出现账号 id / cookie / 代理串 / 出口 IP
  const json = JSON.stringify(s);
  for (const forbidden of ['cookie', 'exit_ip', 'sec_user_id', 'password', 'proxy_display']) {
    assert.ok(!json.includes(forbidden), `快照里出现了不该有的字段：${forbidden}`);
  }
});

test('★ dola_proxies 表不存在时不能把 /metrics 搞挂（可观测性不该拖垮主流程）', () => {
  const s = collectMetrics({ db: fakeDb({ failOn: 'dola_proxies' }), ...NO_DEPS });
  assert.equal(s.proxiesTotal, 0);
  assert.equal(s.proxiesByState.alive, 0);
  // 而且仍然能渲染出完整文本
  assert.ok(renderPrometheus(s).includes('dola_admin_proxies_total 0'));
});

test('★ resolvePools：注入优先、缺省自算、取不到真值时回落而不抛', () => {
  const injected = { expertSecondsReady: true };
  assert.equal(resolvePools(injected, []), injected, '显式传入必须原样返回（否则单测无法控制）');

  const readers = [() => ({ ready: true }), () => ({ ready: false }), () => ({ ready: true })];
  const expected = { expertSecondsReady: true, fixedSecondsReady: false, referenceImagesReady: true };
  assert.deepEqual(resolvePools(null, readers), expected, 'null ⇒ 必须就地取真值');
  assert.deepEqual(resolvePools(undefined, readers), expected, 'undefined 也要自算（旧的 `pools = {}` 默认值语义必须删干净）');

  // 取不到真值（号池表没建等）⇒ 回落空对象，但**绝不抛**（可观测性不能搞挂主流程）
  const boom = [() => { throw new Error('no such table: dola_accounts'); }, () => ({}), () => ({})];
  assert.doesNotThrow(() => resolvePools(null, boom));
  assert.deepEqual(resolvePools(null, boom), {});
});

test('★ [回归钉] 不传 pools 时 collectMetrics 自己取原生能力真值 —— 曾经的"永远 degraded"', () => {
  const calls = [];
  const readers = [
    () => { calls.push(15); return { ready: true }; },
    () => { calls.push(30); return { ready: true }; },
    () => { calls.push('refs'); return { ready: true }; },
  ];
  const accounts = [{ status: 'valid', login_state: 'available', cooldown_until: null }];
  // `readSetting` 必须注入：readinessSummary 会读 `dola_replenish_min_accounts`，
  // 而单测里 db.js 的 `db` 还是 null（getSetting 会抛），异常会被 collectMetrics
  // 的兜底 catch 吞掉、把 readiness 压成 down —— 那样就测不出真正要测的东西了。
  // 这里把补号阈值判据关掉（0=不判定），好让"原生能力齐备 ⇒ ok"这条结论不被账号数干扰。
  const readSetting = (key, fallback) => (key === 'dola_replenish_min_accounts' ? '0' : fallback);

  // ① 不传 pools：必须真的去取，且**原生能力齐备时就绪度不许还是 degraded**
  const s = collectMetrics({
    db: fakeDb({ accountRows: accounts }), poolReaders: readers, readSetting, ...NO_DEPS,
  });
  assert.deepEqual(calls, [15, 30, 'refs'], '不传 pools 必须就地取真值（这就是修复的核心）');
  assert.deepEqual(s.readiness.seconds.ready, [15, 30],
    '★ 原生能力确认后 15/30 必须变成可提交 —— 修复前 pools 恒 {} ⇒ 一档都不可提交');
  assert.equal(s.readiness.grade, 'ok', '★ 原生能力齐备时不该还判 degraded（旧代码永远 degraded）');
  assert.equal(buildAlerts(s).find((a) => a.kind === 'readiness_degraded').active, false);

  // ② 显式传入：不许再取真值（单测可完全控制）
  const injected = collectMetrics({
    db: fakeDb({ accountRows: accounts }),
    pools: { expertSecondsReady: false, fixedSecondsReady: false },
    poolReaders: readers,
    readSetting,
    ...NO_DEPS,
  });
  assert.equal(calls.length, 3, '显式传入时不该再调读取器');
  // 档位精简后没有"无需能力确认"的档位：15/30 都要原生能力确认 ⇒ 全关时 ready 为空。
  assert.deepEqual(injected.readiness.seconds.ready, []);
  assert.equal(injected.readiness.grade, 'degraded');
  // 且只有常态缺口（原生档位未确认）时**不告警**
  assert.equal(buildAlerts(injected).find((a) => a.kind === 'readiness_degraded').active, false,
    '★ 常态 degraded 安静 —— 生产实测这是唯一激活的告警，不能让它永久常亮');
});

test('collectMetrics 能算出最老排队等待时间（库里两种时间格式都要认得）', () => {
  const iso = new Date(Date.now() - 120_000).toISOString();
  const noZone = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
  const s = collectMetrics({ db: fakeDb({ queuedRows: [{ created_at: iso }, { created_at: noZone }] }), ...NO_DEPS });
  assert.ok(s.oldestQueuedWaitSeconds >= 115 && s.oldestQueuedWaitSeconds <= 135,
    `最老等待应约 120 秒，实际 ${s.oldestQueuedWaitSeconds}`);
});

test('无法解析的时间戳不能让整次采集抛错（一条脏数据不该毁掉整个监控）', () => {
  const s = collectMetrics({
    db: fakeDb({
      queuedRows: [{ created_at: '什么时候的事' }, { created_at: null }],
      activeRows: [{ id: 9, status: 'generating', updated_at: 'not a time' }],
    }),
    ...NO_DEPS,
  });
  assert.equal(s.oldestQueuedWaitSeconds, 0);
  assert.deepEqual(s.stuckTasks, [], '时间解析不出来时不能把任务误判成卡住');
});

test('卡住判定用 updated_at 而不是 created_at，且刚好在阈值上不算卡', () => {
  const nowMs = Date.parse('2026-01-01T12:00:00.000Z');
  const minutesAgo = (m) => new Date(nowMs - m * 60_000).toISOString();
  const s = collectMetrics({
    db: fakeDb({
      activeRows: [
        { id: 1, status: 'generating', updated_at: minutesAgo(ALERT_THRESHOLDS.stuckTaskMinutes) },
        { id: 2, status: 'generating', updated_at: minutesAgo(ALERT_THRESHOLDS.stuckTaskMinutes - 1) },
        { id: 3, status: 'resolving', updated_at: minutesAgo(ALERT_THRESHOLDS.stuckTaskMinutes + 5) },
      ],
    }),
    ...NO_DEPS,
    now: () => nowMs,
  });
  assert.deepEqual(s.stuckTasks.map((t) => t.id), [1, 3]);
});

test('chainTextSnapshot 缺席时（生成模块未加载）指标仍可渲染', () => {
  const s = snapshot({ chainText: null });
  const text = renderPrometheus(s, { alerts: buildAlerts(s) });
  assert.ok(text.includes('dola_admin_protocol_drift 0'));
  assert.ok(text.includes('dola_admin_chain_text_rules_total{rule="none"} 0'));
});

// ─────────────────────────────────────── ⑥ 隔离的整库用例（临时 ADMIN_DB）

test('★ 对真实 schema 的整库采集：枚举与 chain-text 规则不许漂移', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dola-metrics-'));
  process.env.ADMIN_DB = join(dir, 'fixture.db');
  process.env.ADMIN_INIT_PASSWORD = 'fixture-only-password';
  process.env.ADMIN_JWT_SECRET = randomBytes(32).toString('hex');
  try {
    // 必须动态 import：DB_PATH 在模块加载时定值（见文件头说明）。
    const database = await import('../server/db.js');
    const database_ = await database.initDb();
    const { chainTextSnapshot } = await import('../server/dola/chain-text-rules.js');
    const { CHAIN_TEXT_RULES } = await import('../server/dola/chain-text-rules.js');
    const { generationStatus } = await import('../server/dola/generator.js');

    // 硬编码的枚举必须和源码一致 —— 两边都改坏才会漏
    assert.deepEqual([...CHAIN_TEXT_RULES], RULE_NAMES, 'chain-text 规则枚举变了，metrics 要对齐');

    const s = collectMetrics({ db: database_, chainTextSnapshot, generationStatus });
    assert.ok(Number.isInteger(s.uptimeSeconds));
    for (const status of VIDEO_STATUSES) assert.equal(typeof s.videosByStatus[status], 'number');
    assert.equal(s.proxiesTotal, 0, '空库里没有代理');
    // 注意：全新库会被 db.js 播种「2 个示例令牌 + 5 张示例卡密」，所以这里不断言 0，
    // 只断言类型与"总数 = active + 非 active"这种恒等关系。
    assert.equal(typeof s.tokens.total, 'number');
    assert.ok(s.tokens.active <= s.tokens.total, 'active 不该超过总数');

    const text = renderPrometheus(s, { alerts: buildAlerts(s) });
    for (const line of text.trimEnd().split('\n')) {
      if (line.startsWith('#')) continue;
      assert.ok(METRIC_LINE.test(line), `对真库渲染出非法行：${line}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
