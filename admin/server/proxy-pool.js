/**
 * 代理池（proxy pool）—— 把「出口代理」从账号上的一个字段，升格为**一等资源**。
 *
 * ## 为什么需要它（对照参考站 68.64.176.15 的核心）
 *
 * 参考站的 `/admin/*` 里有这么一族接口：
 *
 *     /admin/proxies                       代理列表
 *     /admin/proxy-pool                    代理池
 *     /admin/proxy-pool/sweep              ← 健康巡检
 *     /admin/proxy-pool/release-isolated   ← 释放隔离
 *     /admin/accounts/bind-proxies         ← 批量绑定
 *     /admin/accounts/rebalance-proxies    ← 池内重均衡
 *
 * 本仓库原来的模型是**账号优先**：`dola_accounts.proxy` 是一个 TEXT 字段，
 * 一条代理的「生死」没有地方记录 —— 它只能体现在某个账号请求失败上。
 * 于是出现过的真实故障：IPWeb 的 SID 会话到期后代理整体不可达，
 * 24 个账号里 23 个在巡检时返回 **HTTP=0**（`暂未完成校验`），
 * 而系统并不知道「是这 3 条代理死了」，只看到「这些号校验失败」。
 *
 * 本模块补的就是这一层：
 *
 *     代理是有身份的（url_hash 去重）、有健康状态的（unknown/alive/dead/quarantined）、
 *     会被巡检（sweep）、会被隔离（quarantine）、会被释放（release）、
 *     账号从池里领号（bind/rebalance）而不是各自散配。
 *
 * ## 落地方式：自包含模块（刻意的取舍）
 *
 * 建表逻辑**没有**放进 `db.js` 的统一 SCHEMA，而是自己 `CREATE TABLE IF NOT EXISTS`。
 * 这是为了把对既有文件的侵入压到最小：本模块只在 `server/index.js` 挂一行，
 * 不改 `db.js` / `routes/dola.js` 的任何一行内容 —— 那两处当时正被另一条开发线
 * 大量修改（27 → 41 个脏文件），改内容等于制造冲突。
 *
 * 代价：建表不在统一 schema 里，略不合规。**后续应把 PROXY_POOL_SCHEMA
 * 搬进 `db.js`**，本模块只保留读写逻辑。
 *
 * ## 与既有实现的关系（不重复、不覆盖）
 *
 * `routes/dola.js` 里已有的 `/accounts/proxy/*` 系列（assign / verify /
 * verify-persist / summary）**保留不动**，它们解决的是
 * 「用 IPWeb 自编代理给账号现造一条出口」，并且有很扎实的出口碰撞规避。
 * 本模块解决的是另一半：「池子里这些代理现在活着吗、谁占了哪条、
 * 坏了怎么隔离、好了怎么释放」。两者可以并存：
 *
 *     没有池 → 用 /accounts/proxy/assign 现造（现状）
 *     有池   → 把造好的代理 import 进池，之后靠 sweep/rebalance 维持
 */
import crypto from 'node:crypto';
import express from 'express';
import { db, getSetting } from './db.js';
import { requireAuth, requirePerm } from './auth.js';
import { audit } from './audit.js';
import { fetchVia } from './dola/proxy.js';
import { PENDING_SUBMISSION_STATES } from './dola/submission-journal.js';
import { recordObservedExit, rotationView, rotationSummary, EPOCH_SETTING_KEYS } from './dola/proxy-epoch.js';

// ---------------------------------------------------------------- 建表

/**
 * 代理池表。
 *
 * `url_hash` 是去重键：同一条代理被两个运维各贴一次，只应该有一条记录。
 * 用 sha256 前 32 位而不是原 URL 做唯一索引 —— 原 URL 含密码，
 * 不希望在索引/日志里到处出现。
 *
 * `state` 的取值刻意**互斥且穷尽**，避免参考站那种「统计口径重叠」的坑：
 *   unknown     还没探过（新导入）
 *   alive       最近一次探测通过
 *   dead        连续失败达到阈值（可能只是临时抖动，仍有救）
 *   quarantined 已被隔离（dead 达到隔离阈值，或人工隔离），到点自动释放
 */
const PROXY_POOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS dola_proxies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  label            TEXT NOT NULL DEFAULT '',
  url              TEXT NOT NULL,
  url_hash         TEXT NOT NULL,
  group_name       TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'manual',
  enabled          INTEGER NOT NULL DEFAULT 1,
  gateway          TEXT NOT NULL DEFAULT '',
  ipweb_account    TEXT NOT NULL DEFAULT '',
  country          TEXT NOT NULL DEFAULT '',
  sid              TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL DEFAULT 'unknown',
  last_probe_at    TEXT,
  last_ok_at       TEXT,
  fail_streak      INTEGER NOT NULL DEFAULT 0,
  ok_streak        INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT NOT NULL DEFAULT '',
  latency_ms       INTEGER,
  exit_ip          TEXT,
  exit_country     TEXT NOT NULL DEFAULT '',
  exit_org         TEXT NOT NULL DEFAULT '',
  -- 出口轮换 epoch（见 dola/proxy-epoch.js）：
  --   exit_ip_at      首次观测到**当前这个** exit_ip 的时刻（锚点，同一 IP 不变就不动它）
  --   rotation_count  已观测到出口变化过多少次（epoch = rotation_count + 1，单调递增）
  exit_ip_at       TEXT,
  rotation_count   INTEGER NOT NULL DEFAULT 0,
  quarantined_at   TEXT,
  quarantine_until TEXT,
  quarantine_note  TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dola_proxy_hash  ON dola_proxies(url_hash);
CREATE INDEX        IF NOT EXISTS idx_dola_proxy_state ON dola_proxies(state, id);
CREATE INDEX        IF NOT EXISTS idx_dola_proxy_url   ON dola_proxies(url);
`;

let schemaReady = false;

/**
 * 懒建表。第一次有请求进来时执行一次。
 *
 * 为什么不在模块顶层执行：`db.js` 的 `db` 是 `let` + `initDb()` 里赋值，
 * 模块被 import 时它还是 null。ESM 的 live binding 保证**函数体内**读到的是
 * 当前值，所以放在函数里就安全。
 */
export function ensureProxyPoolSchema() {
  if (schemaReady) return;
  db.exec(PROXY_POOL_SCHEMA);
  // ⚠️ 上面是 `CREATE TABLE IF NOT EXISTS`，**对已存在的表不加列**。
  // 本表是懒建的，`db.js` 的 migrate() 跑的时候它可能还不存在（于是跳过），
  // 所以这里必须自己再补一次列，否则老库升级后 rotation_count 永远是 undefined。
  for (const [column, def] of [['exit_ip_at', 'TEXT'], ['rotation_count', 'INTEGER NOT NULL DEFAULT 0']]) {
    try {
      const cols = db.prepare('PRAGMA table_info(dola_proxies)').all().map((c) => c.name);
      if (cols.includes(column)) continue;
      db.exec(`ALTER TABLE dola_proxies ADD COLUMN ${column} ${def}`);
      console.log(`[proxy-pool] 迁移：dola_proxies 新增列 ${column}`);
    } catch (e) {
      console.error(`[proxy-pool] 迁移失败 dola_proxies.${column}:`, e.message);
    }
  }
  schemaReady = true;
}

// ---------------------------------------------------------------- 小工具

const now = () => new Date().toISOString();
const hashUrl = (url) => crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32);

/**
 * 把 fetch 的嵌套错误摊平成一句能定位的话。
 *
 * ⚠️ 这里是 `routes/dola.js` 里同名函数的**副本**。没有 import，是因为
 * 那边没有 export，而 export 它就要改 `routes/dola.js`（脏文件，见文件头说明）。
 * 后续把建表搬进 db.js 时，顺手把这个函数挪到公共 util 里去重。
 */
function describeFetchError(e) {
  const parts = [e?.message || String(e)];
  let c = e?.cause;
  let depth = 0;
  while (c && depth < 3) {
    parts.push(c.code ? `${c.code}: ${c.message}` : c.message || String(c));
    c = c.cause;
    depth++;
  }
  return parts.filter(Boolean).join(' ← ');
}

/** 并发受控的 map：同时最多跑 limit 个，保持结果顺序 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.min(Math.max(1, Number(limit) || 1), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const pos = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** 探测配置：全部走 settings 的读，不写库，避免给脏文件再加读写面 */
const sweepConcurrency = () => pos(getSetting('proxy_pool_sweep_concurrency', '8'), 8);
const probeTimeoutMs = () => pos(getSetting('proxy_pool_probe_timeout_ms', '20000'), 20000);
const quarantineAfter = () => pos(getSetting('proxy_pool_quarantine_after', '2'), 2);
const quarantineMinutes = () => pos(getSetting('proxy_pool_quarantine_minutes', '30'), 30);

/**
 * 出口检测目标。**不要硬编码** —— 默认 ipinfo.io/json，但它是公共免费接口，
 * 批量巡检（几十条 × 并发 8）很容易撞到它的限流（实测连测十几次就开始返 429，
 * 而 429 会被判成「这条代理坏了」，是**假阳性**）。
 * 池子大起来应该指向自建的出口检测服务（自建一个返回 `{"ip":"..."}` 的端点就够）。
 * 想换：系统设置里加 `proxy_pool_probe_url`。
 */
const probeUrl = () => String(getSetting('proxy_pool_probe_url', '') || '').trim() || 'https://ipinfo.io/json';

/**
 * 探测单条代理：真连一次出口检测服务，回报出口 IP 与耗时。
 *
 * 识别 ipinfo 形态的响应；换成别的服务时只要返回里有 `ip` 字段就能用
 * （国家/组织拿不到就留空，不影响状态判定）。
 */
async function probeProxy(url, timeoutMs = probeTimeoutMs()) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`代理探测超时 ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  try {
    const r = await fetchVia(probeUrl(), { signal: ctrl.signal, headers: { accept: 'application/json' } }, url);
    const j = await r.json().catch(() => ({}));
    // ⚠️ 429/5xx 是**检测服务自己**的问题，不是代理坏了。这种情况单独标注出来，
    //    别让它把好代理标成 dead —— 真踩过（自己连测太密导致的假阳性）。
    if (r.status === 429 || r.status >= 500) {
      return {
        ok: false,
        inconclusive: true,
        latencyMs: Date.now() - startedAt,
        error: `出口检测服务暂时不可用 HTTP ${r.status}（这是检测端限流，不能据此判定代理坏）`,
      };
    }
    if (!r.ok || !j.ip) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: `出口检测失败 HTTP ${r.status}` };
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      ip: String(j.ip),
      country: j.country || '',
      org: j.org || '',
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: describeFetchError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 隔离一条代理（含自动隔离路径） */
function quarantine(id, note) {
  const until = new Date(Date.now() + quarantineMinutes() * 60_000).toISOString();
  db.prepare(`UPDATE dola_proxies SET state='quarantined', quarantined_at=?, quarantine_until=?,
              quarantine_note=?, updated_at=? WHERE id=?`)
    .run(now(), until, String(note || '').slice(0, 200), now(), id);
  return until;
}

/**
 * 调用方在写 `exit_ip=?` **之前**必须先调这个。
 *
 * ⚠️ 顺序是硬性的：`recordObservedExit` 要拿库里的旧值跟本次观测比对才能判断
 *    "出口换没换"。写在 `UPDATE ... exit_ip=?` 后面的话，它读到的已经是新值，
 *    于是 `changed` 永远为 false、`rotation_count` 永远停在 0 ——
 *    **功能看着装好了，数据一辈子不动**，且没有任何报错。
 *
 * 失败不往上抛：轮换记账失败**绝不能**让一次成功的代理巡检变成 500。
 */
function noteObservedExit(url, exitIp, ts) {
  try {
    return recordObservedExit(db, { url, exitIp, at: ts });
  } catch (e) {
    console.warn('[proxy-pool] 记录出口轮换 epoch 失败：', e.message);
    return { changed: false, epoch: null };
  }
}

/**
 * 一条代理的轮换视图（给列表/巡检响应与指标用）。
 *
 * ⚠️ `remainingSeconds` / `risk` 的语义见 `dola/proxy-epoch.js`：
 *    算出来的是**上界**，且 `stale` 只表示"该重新探测了"，**不是**"已经轮换"。
 */
function proxyRotationOf(row, { now: nowMs = Date.now() } = {}) {
  const get = (k, d) => getSetting(k, String(d));
  const assumedMinutes = Number(get(EPOCH_SETTING_KEYS.assumedMinutes, 0)) || 0;
  const riskSeconds = Number(get(EPOCH_SETTING_KEYS.riskSeconds, 120));
  return rotationView({
    proxyUrl: row?.url,
    exitIp: row?.exit_ip,
    exitIpAt: row?.exit_ip_at || null,
    rotations: row?.rotation_count || 0,
    assumedMinutes,
    riskSeconds: Number.isFinite(riskSeconds) ? riskSeconds : 120,
    now: nowMs,
  });
}

/**
 * 把轮换视图写成一句人话。
 *
 * 刻意把「上界」写进文案：这是本功能最容易被人误用的地方 ——
 * 把"我们估的到期时间"当成"IPWeb 的精确到期时间"，然后拿它去做调度决策。
 */
function describeRotation(v) {
  if (!v || v.windowSeconds <= 0) return '未知（URL 里读不出粘性窗口，可在设置里给兜底窗口）';
  if (!v.hasExitIp) return '未知（还没成功核验过这个出口）';
  if (v.remainingSeconds === null) return '未知（没有观测锚点）';
  if (v.stale) return `估计已过期（已观测 ${v.epoch} 代），建议重新巡检核验`;
  const min = Math.max(0, Math.round(v.remainingSeconds / 60));
  const suffix = v.risk === 'high' ? '，即将轮换' : '';
  return `约剩 ${min} 分钟（上界估计，第 ${v.epoch} 代）${suffix}`;
}

/**
 * 把出口 IP 回写到**用着这条代理的账号**上。
 *
 * 这是「池 → 号」的联动，也是 `sharedExitIpRows` 能算准的前提：
 * 账号表本来只在人工点「核验出口」时才写 exit_ip，池化之后由巡检统一维护。
 *
 * 只按 `proxy = ?` 精确匹配，不会误伤。
 *
 * ⚠️ **跳过正在飞的账号**。原因：如果一条代理在某个账号生成期间换了出口 IP
 * （IPWeb 的 SID 到期、机房轮换），那个账号的 `exit_ip` 会被静默刷成新值 ——
 * 于是「生成期间出口变过」这个信号被**永久抹掉**，事后完全查不出来。
 * 所以对在飞账号不动它的 exit_ip，改为单独回一个 `changedInFlight` 清单让运维看见。
 *
 * ⚠️⚠️ **出口 IP 变了本身就是一等告警，不管在不在飞。**
 * 这是 2026-09-25 线上实测发现的核心问题：账号用的是 5 分钟粘性会话
 * （`sessTime-5`），5 分钟后同一个会话 id 会换到**另一个 IP**。实测 4 个号
 * 记录的出口 IP 全部与当前实测不一致，其中一个直接 502。
 * 也就是说「一号一 IP」的前提**根本不成立** —— IP 是变的、变的时机不可控。
 * 所以 `rotated` 这个清单要顶到巡检响应的顶层，让人一眼看到
 * 「哪些号的出口身份已经变了」，而不是被悄悄刷新掉。
 *
 * @returns {{synced:number, skippedInFlight:number, changedInFlight:Array, rotated:Array}}
 */
function syncAccountsExitIp(url, exitIp, { skipIds = null } = {}) {
  const s = String(exitIp || '').trim();
  if (!s) return { synced: 0, skippedInFlight: 0, changedInFlight: [], rotated: [] };

  const rows = db.prepare(`SELECT id, label, exit_ip FROM dola_accounts
                           WHERE proxy=? AND (exit_ip IS NULL OR exit_ip <> ?)`).all(url, s);
  let synced = 0;
  let skippedInFlight = 0;
  const changedInFlight = [];
  const rotated = [];

  for (const row of rows) {
    const old = String(row.exit_ip || '').trim();
    if (old) rotated.push({ id: row.id, label: row.label, from: old, to: s });
    if (skipIds && skipIds.has(Number(row.id))) {
      skippedInFlight++;
      if (old) changedInFlight.push({ id: row.id, label: row.label, from: old, to: s });
      continue;
    }
    db.prepare('UPDATE dola_accounts SET exit_ip=?, updated_at=? WHERE id=?').run(s, now(), row.id);
    synced++;
  }
  return { synced, skippedInFlight, changedInFlight, rotated };
}

/** 一条代理当前被多少「非停用」账号用着 */
function accountUsage() {
  const rows = db.prepare(`SELECT proxy, COUNT(*) AS c FROM dola_accounts
                           WHERE status <> 'disabled' AND proxy IS NOT NULL AND proxy <> ''
                           GROUP BY proxy`).all();
  return new Map(rows.map((r) => [String(r.proxy), Number(r.c)]));
}

// ---------------------------------------------------------------- 在途任务防护

/**
 * 「视频处于这些状态」= 生成任务还在飞。
 *
 * ⚠️ 这个列表是**副本**。权威定义有两处，都在别人正在改的文件里、且都没 export：
 *      server/dola/generator.js:630   ACTIVE_GENERATION_STATUSES
 *      server/dola/submission-journal.js:18   const active = new Set([...])
 *    两处内容一致（'queued','submitting','generating','resolving'），所以这里照抄。
 *    去重方法与 `describeFetchError` 同批：等把建表搬进 `db.js` 时一起挪到公共 util。
 *    **改那边的时候记得来这里同步**。
 */
const ACTIVE_VIDEO_STATUSES = "'queued','submitting','generating','resolving'";

/**
 * 找出「现在有活在飞」的账号 —— 换代理时必须避开它们。
 *
 * ## 为什么这是硬约束（不是优化）
 *
 * 生成流程是「**浏览器带上账号的代理**去提交」+「**服务端轮询**去查结果」。
 * 中途把账号的代理换掉，同一个账号会在极短时间内从**两个完全不同的 IP** 出现：
 *
 *     换之前提交  →  韩国住宅 IP（旧代理）
 *     换之后轮询  →  另一个 IP（新代理）
 *
 * 对风控来说这比「一直用一个机房 IP」更可疑。而且上游是**创建成功即扣费** ——
 * 被判风控就是白扣额度，用户那边只看到失败。所以换出口要等活干完再换。
 *
 * ## 两类「在飞」
 *
 *   ① `dola_videos` 处于 active 状态（排队 / 提交中 / 生成中 / 解析中）
 *   ② 提交日志里有**未决提交**（dispatching / uncertain / acknowledged）——
 *      这类最危险：结果还未知，换 IP 会让后续的恢复查询对不上原出口（见
 *      `canRecoverSubmission` 里对 `proxy_hash` 的校验）。用 `PENDING_SUBMISSION_STATES`
 *      而不是自己硬编码，避免那边加状态时这里漏跟。
 *
 * @returns {Set<number>} 账号 id 集合
 */
function inFlightAccountIds() {
  const ids = new Set();

  for (const r of db.prepare(`SELECT DISTINCT account_id FROM dola_videos
                              WHERE status IN (${ACTIVE_VIDEO_STATUSES}) AND account_id IS NOT NULL`).all()) {
    ids.add(Number(r.account_id));
  }

  if (PENDING_SUBMISSION_STATES.length) {
    const ph = PENDING_SUBMISSION_STATES.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT DISTINCT account_id FROM dola_submission_journal
                                WHERE state IN (${ph}) AND account_id IS NOT NULL`).all(...PENDING_SUBMISSION_STATES)) {
      ids.add(Number(r.account_id));
    }
  }

  return ids;
}

/** 给前端用的可读原因 */
const inFlightReason = (ids) => `这 ${ids.length} 个账号正在生成或提交未决，换出口会让同一账号从两个 IP 出现（风控 + 可能白扣费），本次跳过`;

// ---------------------------------------------------------------- 路由

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/proxy-pool —— 池列表 + 汇总
 *
 * query: ?state=alive|dead|unknown|quarantined  ?group=  ?q=  ?page=  ?pageSize=
 *
 * 出口 IP 只在**逐条**返回时给出（运维要能核对），汇总里只出计数
 * —— 沿用 `routes/dola.js` 里既有的口径：汇总不泄露出口 IP。
 */
router.get('/', requirePerm('dola:list'), (req, res) => {
  ensureProxyPoolSchema();
  const state = String(req.query.state || '').trim();
  const group = String(req.query.group || '').trim();
  const q = String(req.query.q || '').trim();
  const page = pos(req.query.page, 1);
  const pageSize = Math.min(pos(req.query.pageSize, 100), 500);

  const where = [];
  const params = [];
  if (state) { where.push('state = ?'); params.push(state); }
  if (group) { where.push('group_name = ?'); params.push(group); }
  if (q) { where.push('(label LIKE ? OR url LIKE ? OR exit_ip LIKE ? OR ipweb_account LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM dola_proxies ${whereSql}`).get(...params).c ?? 0;
  const rows = db.prepare(`SELECT * FROM dola_proxies ${whereSql} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);

  const usage = accountUsage();
  const nowMs = Date.now();
  const items = rows.map((r) => {
    // 出口还剩多久轮换。⚠️ `estimate:true` 是真的：我们算的是**上界**
    // （见 dola/proxy-epoch.js），`stale` 只表示"该重新核验了"，**不是**"已经轮换"。
    const rotation = proxyRotationOf(r, { now: nowMs });
    return {
      ...r,
      enabled: Boolean(r.enabled),
      // 密码不回传：列表里只给一条能认出来的脱敏串
      masked: String(r.url).replace(/\/\/([^:]+):[^@]+@/, '//$1:***@'),
      accountCount: usage.get(String(r.url)) || 0,
      quarantined: r.state === 'quarantined' && r.quarantine_until && new Date(r.quarantine_until) > new Date(),
      rotation,
      // 人可读的一句话，把"上界"这个诚实边界写进去，
      // 免得运维把它当精确到期时间去做调度决策。
      rotationText: describeRotation(rotation),
    };
  });

  res.json({ ok: true, total, page, pageSize, items, summary: poolSummary() });
});

/**
 * GET /api/proxy-pool/summary —— 六个互斥口径 + 池覆盖
 *
 * 口径刻意互斥（一条代理只落一个桶），参考站那块最容易出的错就是重复计数。
 */
function poolSummary() {
  const p = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
      SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN enabled = 1 AND state = 'alive' THEN 1 ELSE 0 END) AS alive,
      SUM(CASE WHEN enabled = 1 AND state = 'dead' THEN 1 ELSE 0 END) AS dead,
      SUM(CASE WHEN enabled = 1 AND state = 'unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN enabled = 1 AND state = 'quarantined' THEN 1 ELSE 0 END) AS quarantined
    FROM dola_proxies`).get() || {};

  const usage = accountUsage();
  const poolUrls = new Set(db.prepare('SELECT url FROM dola_proxies WHERE enabled = 1').all().map((r) => String(r.url)));
  const totalAccounts = db.prepare("SELECT COUNT(*) AS c FROM dola_accounts WHERE status <> 'disabled'").get().c ?? 0;
  let accountsInPool = 0;
  for (const [url, c] of usage) if (poolUrls.has(url)) accountsInPool += c;

  // 出口 IP 重复：用池里已知的 exit_ip 算，不含本机出口
  const ipRows = db.prepare(`SELECT exit_ip, COUNT(*) AS c FROM dola_proxies
                             WHERE enabled = 1 AND state = 'alive' AND exit_ip IS NOT NULL AND exit_ip <> ''
                             GROUP BY exit_ip`).all();
  const sharedIpGroups = ipRows.filter((r) => Number(r.c) > 1);

  // 出口轮换风险分布。**复用 proxy-epoch 的唯一实现**（见 rotationSummary 的注释）：
  // 这里再写一份的话，/metrics 与这个概览迟早会给出不同的数字。
  // `unknown`（读不出窗口）与 `no_anchor`（有窗口但从没核验成功）刻意分开计。
  const rotation = rotationSummary({ database: db });

  return {
    total: Number(p.total || 0),
    enabled: Number(p.enabled || 0),
    disabled: Number(p.disabled || 0),
    alive: Number(p.alive || 0),
    dead: Number(p.dead || 0),
    unknown: Number(p.unknown || 0),
    quarantined: Number(p.quarantined || 0),
    distinctExitIps: ipRows.length,
    sharedExitIpGroups: sharedIpGroups.length,
    accountsInPool,
    accountsTotal: totalAccounts,
    accountsWithoutPoolProxy: Math.max(0, totalAccounts - accountsInPool),
    // 出口轮换（见 dola/proxy-epoch.js）。`rotated` = 已有过至少一次换 IP 观测的代理数。
    rotation,
  };
}

router.get('/summary', requirePerm('dola:list'), (req, res) => {
  ensureProxyPoolSchema();
  res.json({ ok: true, ...poolSummary(), sweeping: Boolean(activeSweep) });
});

/**
 * POST /api/proxy-pool/import —— 批量导入
 *
 * body: { text, group?, source?, note? }
 *
 * 直接粘贴 IPWeb 后台导出的行就行（`gate2.ipweb.cc:7778:B_...:pw`），
 * 也接受拼好的 `socks5://user:pass@host:port`。解析交给 `dola/proxy.js`
 * 里那套已经踩过坑的 `parseIpwebExport`（它知道段序不唯一的坑），
 * 这里只负责容错、去重、落库。
 *
 * 幂等：同一条代理重复贴只算 duplicates，不会产生第二条记录。
 */
router.post('/import', requirePerm('dola:import'), async (req, res) => {
  ensureProxyPoolSchema();
  try {
    const { parseIpwebExport, IPWEB_SCHEME } = await import('./dola/proxy.js');
    const raw = String(req.body?.text || '');
    const group = String(req.body?.group || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!raw.trim()) return res.status(400).json({ ok: false, message: '没有可导入的内容' });

    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    const seen = new Set();
    const results = [];
    let added = 0, duplicates = 0, failed = 0;

    const insert = db.prepare(`INSERT OR IGNORE INTO dola_proxies
      (label, url, url_hash, group_name, source, gateway, ipweb_account, country, sid,
       state, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'unknown',?,?,?)`);

    for (const line of lines) {
      // url 提到 try 外面：catch 里回显脱敏串时要用它判断格式
      let url = '';
      try {
        let gateway = '', ipwebAccount = '', country = '', sid = '', source = 'manual';
        if (/^(https?|socks[45]?):\/\//i.test(line)) {
          // 已经是 URL
          let u;
          try { u = new URL(line); } catch { throw new Error('URL 无法解析'); }
          if (!/^(https?|socks[45]?):$/.test(u.protocol)) throw new Error(`不支持的协议 ${u.protocol}`);
          if (!u.hostname || !u.port) throw new Error('缺少 host 或 port');
          url = line;
          gateway = u.hostname;
          // IPWeb 形态的 URL 能解析出身份，第三方代理解析不出来也不报错
          try {
            const p = parseIpwebExport(line);
            ipwebAccount = p.account; country = p.country; sid = p.sid; source = 'ipweb';
          } catch { /* 第三方代理，正常 */ }
        } else {
          // IPWeb 后导出的冒号分隔行
          const p = parseIpwebExport(line);
          url = p.proxy;
          gateway = p.gateway; ipwebAccount = p.account; country = p.country; sid = p.sid;
          source = 'ipweb-export';
        }

        const h = hashUrl(url);
        if (seen.has(h)) { duplicates++; results.push({ line: maskLine(line, url), ok: true, duplicate: true }); continue; }
        seen.add(h);

        const before = db.prepare('SELECT COUNT(*) AS c FROM dola_proxies').get().c;
        insert.run(
          ipwebAccount || gateway, url, h, group, source, gateway, ipwebAccount, country, sid,
          note, now(), now(),
        );
        const after = db.prepare('SELECT COUNT(*) AS c FROM dola_proxies').get().c;
        if (after > before) { added++; results.push({ line: maskLine(line, url), ok: true, added: true }); }
        else { duplicates++; results.push({ line: maskLine(line, url), ok: true, duplicate: true }); }
      } catch (e) {
        failed++;
        results.push({ line: maskLine(line, url), ok: false, message: e.message });
      }
    }

    audit(req, 'proxy_pool.import', 'proxy_pool', '', `导入 ${lines.length} 行：新增 ${added}、重复 ${duplicates}、失败 ${failed}`);
    res.json({ ok: true, total: lines.length, added, duplicates, failed, results: results.slice(0, 200), summary: poolSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * 导入回显里把密码打码。
 *
 * ⚠️ 两种格式都要盖到，第一版只处理了 `//user:pass@host`，
 * 于是 IPWeb 导出的**冒号格式**（`host:port:B_xxx_...:password`）整条带着明文密码
 * 回显到了响应体里 —— 那种行本来就是为了方便粘贴，密码是真密码。
 * 冒号格式的约定是「最后一段是密码」，所以直接盖掉末段。
 */
function maskLine(line, url) {
  const raw = String(line);
  if (/^(https?|socks[45]?):\/\//i.test(raw)) {
    return String(url || raw).replace(/\/\/([^:@/\s]+):[^@\s]*@/, '//$1:***@');
  }
  return raw.replace(/:([^:]*)$/, ':***');
}

/**
 * POST /api/proxy-pool/sweep —— 健康巡检（参考站的 /admin/proxy-pool/sweep）
 *
 * body: { ids?:[], state?:'enabled'|'all', limit?, concurrency?, timeoutMs?, verify?:bool }
 *
 * 行为：
 *   - 逐条真连 ipinfo.io（走这条代理），拿到出口 IP
 *   - 成功 → state=alive、写 exit_ip、ok_streak++、清空隔离
 *   - 失败 → fail_streak++；连续失败 ≥ `proxy_pool_quarantine_after`（默认 2）
 *            则隔离 `proxy_pool_quarantine_minutes` 分钟（默认 30）→ state=quarantined
 *   - 成功后把 exit_ip **回写**到用着这条代理的账号上（池 → 号联动）
 *
 * ⚠️ 长耗时路由：每条最多等 `timeoutMs`，所以用 limit 控总时长。
 * 默认一次最多 50 条、并发 8 —— 前端对这个前缀的超时已放宽到 300s
 * （见 `web/src/api.js` 的 LONG_PATH_PREFIXES）。
 * 池子很大时应该改造成 jobs 异步任务（见文件末「后续」）。
 */
let activeSweep = null;

router.post('/sweep', requirePerm('dola:check'), async (req, res) => {
  ensureProxyPoolSchema();
  if (activeSweep) {
    return res.status(409).json({ ok: false, message: `已有巡检在进行中（${activeSweep.done}/${activeSweep.total}），请等它跑完` });
  }
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
    const scope = String(req.body?.state || 'enabled');
    const limit = Math.min(pos(req.body?.limit, 50), 200);
    const concurrency = Math.min(pos(req.body?.concurrency, sweepConcurrency()), 24);
    const timeoutMs = Math.min(pos(req.body?.timeoutMs, probeTimeoutMs()), 60_000);
    const syncAccounts = req.body?.syncAccounts !== false;
    // 在飞账号的出口一律不动（中途换 IP 会让同一账号从两个 IP 出现）
    const inFlight = inFlightAccountIds();

    let sql = 'SELECT * FROM dola_proxies';
    const params = [];
    if (ids.length) {
      sql += ` WHERE id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    } else if (scope !== 'all') {
      sql += ' WHERE enabled = 1';
    }
    sql += ' ORDER BY id LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    if (!rows.length) return res.json({ ok: true, total: 0, message: '没有需要巡检的代理', details: [], summary: poolSummary() });

    activeSweep = { startedAt: now(), total: rows.length, done: 0 };
    const details = await mapLimit(rows, concurrency, async (row) => {
      const r = await probeProxy(String(row.url), timeoutMs);
      activeSweep.done++;
      const ts = now();
      try {
        if (r.ok) {
          // ⚠️ 必须在下面那条 UPDATE 之前：它要读旧 exit_ip 才能判断"换没换"。
          const rotation = noteObservedExit(String(row.url), r.ip, ts);
          db.prepare(`UPDATE dola_proxies SET state='alive', last_probe_at=?, last_ok_at=?, ok_streak=ok_streak+1,
                      fail_streak=0, last_error='', latency_ms=?, exit_ip=?, exit_country=?, exit_org=?,
                      quarantined_at=NULL, quarantine_until=NULL, quarantine_note='', updated_at=?
                      WHERE id=?`)
            .run(ts, ts, r.latencyMs, r.ip, r.country, r.org, ts, row.id);
          const sync = syncAccounts
            ? syncAccountsExitIp(String(row.url), r.ip, { skipIds: inFlight })
            : { synced: 0, skippedInFlight: 0, changedInFlight: [], rotated: [] };
          return {
            id: row.id, label: row.label, ok: true, state: 'alive', latencyMs: r.latencyMs,
            exitIp: r.ip, exitCountry: r.country, exitOrg: r.org,
            accountsSynced: sync.synced,
            accountsSkippedInFlight: sync.skippedInFlight,
            exitChangedInFlight: sync.changedInFlight,
            exitIpRotated: sync.rotated,
            // 本次观测是否**真的换了出口**（比 exitIpRotated 更宽：不管在不在飞都算）
            exitChanged: rotation.changed === true,
            epoch: rotation.epoch,
            released: row.state === 'quarantined' || row.state === 'dead',
          };
        }
        // 检测端自己挂了（429/5xx）→ 不计失败、不改状态，只留痕。
        // 否则一次限流就会把整个池子标成 dead，然后误隔离一片好代理。
        if (r.inconclusive) {
          db.prepare('UPDATE dola_proxies SET last_probe_at=?, last_error=?, updated_at=? WHERE id=?')
            .run(ts, String(r.error || '').slice(0, 300), ts, row.id);
          return { id: row.id, label: row.label, ok: false, inconclusive: true, state: row.state, error: r.error };
        }
        const streak = Number(row.fail_streak || 0) + 1;
        db.prepare(`UPDATE dola_proxies SET last_probe_at=?, fail_streak=?, ok_streak=0, last_error=?, updated_at=? WHERE id=?`)
          .run(ts, streak, String(r.error || '').slice(0, 300), ts, row.id);
        let state = row.state;
        let until = null;
        if (streak >= quarantineAfter()) {
          until = quarantine(row.id, `连续 ${streak} 次探测失败：${String(r.error || '').slice(0, 120)}`);
          state = 'quarantined';
        } else {
          state = 'dead';
          db.prepare("UPDATE dola_proxies SET state='dead', updated_at=? WHERE id=?").run(ts, row.id);
        }
        return { id: row.id, label: row.label, ok: false, state, failStreak: streak, error: r.error, quarantineUntil: until };
      } catch (e) {
        return { id: row.id, label: row.label, ok: false, state: row.state, error: `写库失败：${e.message}` };
      }
    });

    const detail = details;
    const okCount = detail.filter((d) => d.ok).length;
    const inconclusive = detail.filter((d) => d.inconclusive).length;
    activeSweep = null;

    audit(req, 'proxy_pool.sweep', 'proxy_pool', '', `巡检 ${detail.length} 条：通过 ${okCount}、失败 ${detail.length - okCount - inconclusive}、检测端不可用 ${inconclusive}`);
    res.json({
      ok: true,
      total: detail.length,
      okCount,
      failCount: detail.length - okCount - inconclusive,
      inconclusive,
      quarantined: detail.filter((d) => d.state === 'quarantined').length,
      released: detail.filter((d) => d.released).length,
      accountsSynced: detail.reduce((s, d) => s + (d.accountsSynced || 0), 0),
      accountsSkippedInFlight: detail.reduce((s, d) => s + (d.accountsSkippedInFlight || 0), 0),
      // ⚠️ 「生成期间出口变了」是真实风险信号，单独顶到响应顶层，别埋在日志里
      exitChangedInFlight: detail.flatMap((d) => d.exitChangedInFlight || []),
      // ⚠️⚠️ 出口 IP 变了 = 这个账号的**出口身份变了**（粘性会话轮换）。
      //     本次线上实测的核心问题就是它：4 个号记录的出口 IP 全部已变、其中 1 个 502。
      //     必须顶到顶层，不能因为「已自动刷新成新值」就当没发生。
      exitIpRotated: detail.flatMap((d) => d.exitIpRotated || []),
      details: detail,
      summary: poolSummary(),
    });
  } catch (e) {
    activeSweep = null;
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/proxy-pool/release-isolated —— 释放隔离（参考站的 /release-isolated）
 *
 * body: { ids?:[], all?:bool, probe?:bool }
 *
 * 语义是「把隔离区里的代理放回池子」。默认只放状态、**不信任它已经好了** ——
 * 释放后 state 回到 unknown，需要下一次巡检确认（probe=true 则立即探一次）。
 * 这样做是为了避免「隔离到点自动变 alive，实际还是死的」这种假绿。
 */
router.post('/release-isolated', requirePerm('dola:update'), async (req, res) => {
  ensureProxyPoolSchema();
  try {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
    const all = req.body?.all === true;
    if (!ids.length && !all) return res.status(400).json({ ok: false, message: '请指定 ids，或显式传 all:true' });

    const rows = ids.length
      ? db.prepare(`SELECT * FROM dola_proxies WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : db.prepare("SELECT * FROM dola_proxies WHERE state = 'quarantined'").all();
    const targets = rows.filter((r) => r.state === 'quarantined');
    if (!targets.length) return res.json({ ok: true, released: 0, message: '没有处于隔离状态的代理' });

    for (const r of targets) {
      db.prepare(`UPDATE dola_proxies SET state='unknown', quarantined_at=NULL, quarantine_until=NULL,
                  quarantine_note='', fail_streak=0, updated_at=? WHERE id=?`).run(now(), r.id);
    }

    let probeResults = null;
    if (req.body?.probe === true) {
      const inFlight = inFlightAccountIds();
      probeResults = await mapLimit(targets, Math.min(sweepConcurrency(), targets.length), async (r) => {
        const p = await probeProxy(String(r.url));
        const ts = now();
        if (p.ok) {
          // 同上：先记账（要读旧 exit_ip），再写新值。
          const rotation = noteObservedExit(String(r.url), p.ip, ts);
          db.prepare(`UPDATE dola_proxies SET state='alive', last_probe_at=?, last_ok_at=?, ok_streak=ok_streak+1,
                      fail_streak=0, last_error='', latency_ms=?, exit_ip=?, exit_country=?, exit_org=?, updated_at=?
                      WHERE id=?`)
            .run(ts, ts, p.latencyMs, p.ip, p.country, p.org, ts, r.id);
          syncAccountsExitIp(String(r.url), p.ip, { skipIds: inFlight });
          return { id: r.id, ok: true, exitIp: p.ip, exitChanged: rotation.changed === true, epoch: rotation.epoch };
        }
        if (p.inconclusive) {
          db.prepare('UPDATE dola_proxies SET last_probe_at=?, last_error=?, updated_at=? WHERE id=?')
            .run(ts, String(p.error || '').slice(0, 300), ts, r.id);
          return { id: r.id, ok: false, inconclusive: true, error: p.error };
        }
        db.prepare("UPDATE dola_proxies SET state='dead', last_probe_at=?, fail_streak=fail_streak+1, last_error=?, updated_at=? WHERE id=?")
          .run(ts, String(p.error || '').slice(0, 300), ts, r.id);
        return { id: r.id, ok: false, error: p.error };
      });
    }

    audit(req, 'proxy_pool.release', 'proxy_pool', '', `释放隔离 ${targets.length} 条${probeResults ? '（已立即复检）' : ''}`);
    res.json({ ok: true, released: targets.length, ids: targets.map((r) => r.id), probeResults, summary: poolSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/proxy-pool/bind —— 把池里的指定代理绑给指定账号（显式绑定）
 *
 * body: { proxyId, ids?:[], all?:bool, onlyUnbound?:bool, verify?:bool }
 *
 * 幂等：`force` 默认 false，已有代理的账号会被跳过 —— 重试一次请求不会把
 * 已完成的账号悄悄换到另一个出口（沿用 `/accounts/proxy/assign` 的这条约定）。
 */
router.post('/bind', requirePerm('dola:update'), async (req, res) => {
  ensureProxyPoolSchema();
  try {
    const proxyId = Number(req.body?.proxyId);
    const row = db.prepare('SELECT * FROM dola_proxies WHERE id=?').get(proxyId);
    if (!row) return res.status(404).json({ ok: false, message: '代理不存在' });
    if (!row.enabled) return res.status(400).json({ ok: false, message: '该代理已停用，不能绑定' });
    if (row.state === 'dead' || (row.state === 'quarantined' && row.quarantine_until && new Date(row.quarantine_until) > new Date())) {
      return res.status(400).json({ ok: false, message: `该代理当前状态为 ${row.state}，请先巡检/释放隔离再绑定` });
    }

    let ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
    if (!ids.length) {
      const where = req.body?.onlyUnbound ? "status <> 'disabled' AND (proxy IS NULL OR proxy = '')" : "status <> 'disabled'";
      ids = db.prepare(`SELECT id FROM dola_accounts WHERE ${where} ORDER BY id`).all().map((r) => r.id);
    }
    if (!ids.length) return res.status(400).json({ ok: false, message: '没有匹配的账号' });

    const force = req.body?.force === true;
    // 换出口的硬约束：正在生成 / 提交未决的账号不能动（理由见 inFlightAccountIds）。
    // 真要强行换（比如某个号被 uncertain 提交长期锁住），显式传 allowInFlight:true。
    const allowInFlight = req.body?.allowInFlight === true;
    const inFlight = allowInFlight ? new Set() : inFlightAccountIds();
    let bound = 0, skipped = 0, failed = 0, skippedInFlight = 0;
    const results = [];
    for (const id of ids) {
      const acc = db.prepare('SELECT id, label, proxy, status FROM dola_accounts WHERE id=?').get(id);
      if (!acc) { results.push({ id, ok: false, message: '账号不存在' }); failed++; continue; }
      if (acc.status === 'disabled') { results.push({ id, ok: false, message: '账号已停用' }); failed++; continue; }
      // 换出口的硬约束（放在最前面，优先于各种 skip 判断）
      if (inFlight.has(Number(id))) {
        results.push({
          id, ok: true, skipped: true, skippedInFlight: true,
          message: '正在生成或提交未决：换出口会让同一账号从两个 IP 出现（风控 + 可能白扣费），本次跳过',
        });
        skipped++; skippedInFlight++; continue;
      }
      if (!force && String(acc.proxy || '').trim() === String(row.url)) {
        results.push({ id, ok: true, skipped: true, message: '已绑定同一条代理，跳过' }); skipped++; continue;
      }
      if (!force && String(acc.proxy || '').trim()) {
        results.push({ id, ok: true, skipped: true, message: '已有代理，跳过（未传 force）' }); skipped++; continue;
      }
      bindProxyToAccount(id, row, req);
      results.push({ id, ok: true, label: acc.label }); bound++;
    }

    // 绑定后立刻复检（可选）：确保「绑上去的就是通的」，避免坏代理静默上头
    let verified = null;
    if (req.body?.verify === true && bound > 0) {
      const p = await probeProxy(String(row.url));
      verified = p.ok
        ? { ok: true, exitIp: p.ip }
        : { ok: false, error: p.error };
      if (p.ok) {
        // 同上：先记账（要读旧 exit_ip）再写新值。这条路径也可能是"出口换了"的首次观测。
        noteObservedExit(String(row.url), p.ip, now());
        db.prepare('UPDATE dola_proxies SET exit_ip=?, exit_country=?, exit_org=?, state=\'alive\', last_ok_at=?, updated_at=? WHERE id=?')
          .run(p.ip, p.country, p.org, now(), now(), row.id);
        syncAccountsExitIp(String(row.url), p.ip);
      }
    }

    audit(req, 'proxy_pool.bind', 'proxy_pool', row.id, `绑定代理 #${row.id} → 账号 ${bound} 个（跳过 ${skipped}，其中在途中 ${skippedInFlight}、失败 ${failed}）`);
    res.json({ ok: true, proxyId: row.id, bound, skipped, skippedInFlight, failed, verified, results: results.slice(0, 200), summary: poolSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/** 把一条池内代理写到账号上；沿用 /accounts/:id/proxy 的字段重置策略 */
function bindProxyToAccount(accountId, proxyRow, req) {
  const exitIp = String(proxyRow.exit_ip || '').trim() || null;
  db.prepare(`UPDATE dola_accounts SET proxy=?, exit_ip=?,
              native_15s_state='unknown', native_15s_at=NULL, native_15s_note='',
              native_30s_state='unknown', native_30s_at=NULL, native_30s_note='',
              reference_image_state='unknown', reference_image_at=NULL, reference_image_note='',
              updated_at=? WHERE id=?`)
    .run(String(proxyRow.url), proxyRow.state === 'alive' ? exitIp : null, now(), accountId);
  audit(req, 'dola.set_proxy', 'dola_account', accountId, `池内代理 #${proxyRow.id}（${proxyRow.exit_ip || '未核验'}）`);
}

/**
 * POST /api/proxy-pool/rebalance —— 池内重均衡（参考站的 /accounts/rebalance-proxies）
 *
 * body: { limit?, verify?, dryRun? }
 *
 * 找出的「有问题」的账号：
 *   A. 没有代理（走本机出口 —— 最危险，等于所有号共用一个机房 IP）
 *   B. 代理不在池里（手配的散代理，无健康记录）
 *   C. 代理在池里但状态是 dead / 隔离中
 *   D. 出口 IP 与别的账号重复（共享出口）
 *
 * 然后从池里挑**健康、且出口 IP 未被占用**的代理逐个分配。
 * 幂等：只动上面这 4 类；已经有独占健康出口的账号一律不碰。
 * 池子不够时如实回报 `unassigned`，**不会**把两个账号塞到同一个出口上。
 */
router.post('/rebalance', requirePerm('dola:update'), async (req, res) => {
  ensureProxyPoolSchema();
  try {
    const dryRun = req.body?.dryRun === true;
    const limit = Math.min(pos(req.body?.limit, 100), 500);

    const accounts = db.prepare("SELECT id, label, status, proxy, exit_ip FROM dola_accounts WHERE status <> 'disabled' ORDER BY id").all();
    const pool = db.prepare("SELECT * FROM dola_proxies WHERE enabled = 1 ORDER BY state = 'alive' DESC, id").all();
    const poolByUrl = new Map(pool.map((p) => [String(p.url), p]));

    // 出口 IP 占用表：只看**本次不参与重分配**的账号，否则会拿自己的旧 IP 跟自己撞
    // （这条和 /accounts/proxy/assign 里那段注释是同一个坑）
    const exitCounts = new Map();
    for (const a of accounts) {
      const ip = String(a.exit_ip || '').trim();
      if (ip) exitCounts.set(ip, (exitCounts.get(ip) || 0) + 1);
    }

    // 在飞的账号一律不搬 —— 这是本模块最重要的一条安全约束。
    // 传 allowInFlight:true 可强行搬（给「号被 uncertain 提交长期锁住」这种死结用）。
    const allowInFlight = req.body?.allowInFlight === true;
    const inFlight = allowInFlight ? new Set() : inFlightAccountIds();

    const needFix = [];
    const blockedInFlight = [];
    for (const a of accounts) {
      const proxyUrl = String(a.proxy || '').trim();
      const ip = String(a.exit_ip || '').trim();
      let reason = null;
      if (!proxyUrl) reason = 'no-proxy';
      else {
        const p = poolByUrl.get(proxyUrl);
        if (!p) reason = 'proxy-not-in-pool';
        else if (p.state === 'dead' || (p.state === 'quarantined' && p.quarantine_until && new Date(p.quarantine_until) > new Date())) reason = `proxy-${p.state}`;
      }
      if (!reason && ip && (exitCounts.get(ip) || 0) > 1) reason = 'shared-exit-ip';
      if (reason) {
        if (inFlight.has(Number(a.id))) { blockedInFlight.push({ id: a.id, label: a.label, reason }); continue; }
        needFix.push({ ...a, reason });
      }
      if (needFix.length >= limit) break;
    }

    if (!needFix.length) {
      return res.json({
        ok: true, dryRun, needFix: 0, assigned: 0, unassigned: 0,
        skippedInFlight: blockedInFlight.length,
        inFlightAccounts: blockedInFlight.slice(0, 50),
        allowInFlight,
        message: blockedInFlight.length
          ? `没有可搬运的账号。另有 ${blockedInFlight.length} 个账号虽有问题但正在生成或提交未决，本次跳过 —— ${inFlightReason(blockedInFlight)}`
          : '所有账号都已独占健康出口，无需重均衡',
        summary: poolSummary(),
      });
    }

    // 参与重分配的账号要释放自己旧的出口 IP
    const processIds = new Set(needFix.map((a) => a.id));
    const occupiedIps = new Set();
    for (const a of accounts) {
      if (processIds.has(a.id)) continue;
      const ip = String(a.exit_ip || '').trim();
      if (ip) occupiedIps.add(ip);
    }
    //
    // ⚠️ 这里**不要**把「池里各条代理的 exit_ip」也塞进 occupiedIps。
    //    第一版这么写了，导致候选代理全被自己挡住 —— 明明池里有 alive 代理，
    //    plan 却是空的、unassigned 等于全部账号。真踩过一次。
    //
    //    池内两条代理撞同一个出口 IP（IPWeb 换 SID 时实测会撞）这种情况，
    //    靠下面「每选中一条就把它的 IP 记进 occupiedIps」来拦：
    //    第二条同 IP 的代理会在 filter 里被排除，不会两个号共用一个出口。

    // 挑代理：只要 alive 且出口已知、且 IP 没被占
    const candidates = pool.filter((p) => p.state === 'alive' && String(p.exit_ip || '').trim());
    const load = accountUsage();
    const usedProxyIds = new Set();
    const plan = [];
    let unassigned = 0;

    for (const a of needFix) {
      const pick = candidates
        .filter((p) => !usedProxyIds.has(p.id) && !occupiedIps.has(String(p.exit_ip).trim()))
        .sort((x, y) => (load.get(String(x.url)) || 0) - (load.get(String(y.url)) || 0) || x.id - y.id)[0];
      if (!pick) { unassigned++; continue; }
      usedProxyIds.add(pick.id);
      occupiedIps.add(String(pick.exit_ip).trim());
      plan.push({ accountId: a.id, label: a.label, reason: a.reason, proxyId: pick.id, exitIp: pick.exit_ip });
    }

    if (dryRun || !plan.length) {
      return res.json({
        ok: true, dryRun, needFix: needFix.length, assigned: 0, unassigned,
        skippedInFlight: blockedInFlight.length,
        inFlightAccounts: blockedInFlight.slice(0, 50),
        allowInFlight,
        reasonBreakdown: tally(needFix.map((a) => a.reason)),
        plan: plan.slice(0, 200), summary: poolSummary(),
      });
    }

    let verifyFailed = 0;
    if (req.body?.verify === true) {
      // 复检要用的代理，避免把「记录说 alive、实际早死了」的代理配出去
      const byId = new Map(pool.map((p) => [p.id, p]));
      const checked = await mapLimit(plan, Math.min(sweepConcurrency(), plan.length), async (it) => {
        const p = byId.get(it.proxyId);
        const r = await probeProxy(String(p.url));
        const ts = now();
        if (r.ok) {
          db.prepare(`UPDATE dola_proxies SET state='alive', last_probe_at=?, last_ok_at=?, ok_streak=ok_streak+1,
                      fail_streak=0, last_error='', latency_ms=?, exit_ip=?, exit_country=?, exit_org=?, updated_at=? WHERE id=?`)
            .run(ts, ts, r.latencyMs, r.ip, r.country, r.org, ts, p.id);
          return { ...it, alive: true, exitIp: r.ip };
        }
        // 检测端自己不可用：**不改状态**，但本次也不分配（保守）
        if (r.inconclusive) {
          db.prepare('UPDATE dola_proxies SET last_probe_at=?, last_error=?, updated_at=? WHERE id=?')
            .run(ts, String(r.error || '').slice(0, 300), ts, p.id);
          return { ...it, alive: false, inconclusive: true, error: r.error };
        }
        db.prepare("UPDATE dola_proxies SET state='dead', last_probe_at=?, fail_streak=fail_streak+1, last_error=?, updated_at=? WHERE id=?")
          .run(ts, String(r.error || '').slice(0, 300), ts, p.id);
        return { ...it, alive: false, error: r.error };
      });
      plan.length = 0;
      for (const c of checked) if (c.alive) plan.push(c); else verifyFailed++;
    }

    let assigned = 0;
    for (const it of plan) {
      const p = pool.find((x) => x.id === it.proxyId);
      if (!p) continue;
      bindProxyToAccount(it.accountId, { ...p, exit_ip: it.exitIp }, req);
      assigned++;
    }

    audit(req, 'proxy_pool.rebalance', 'proxy_pool', '',
      `重均衡：需处理 ${needFix.length}、已分配 ${assigned}、池不足 ${unassigned}${verifyFailed ? `、复检失败 ${verifyFailed}` : ''}`);
    res.json({
      ok: true, dryRun: false, needFix: needFix.length, assigned, unassigned, verifyFailed,
      skippedInFlight: blockedInFlight.length,
      inFlightAccounts: blockedInFlight.slice(0, 50),
      allowInFlight,
      reasonBreakdown: tally(needFix.map((a) => a.reason)),
      plan: plan.map((p) => ({ accountId: p.accountId, label: p.label, reason: p.reason, proxyId: p.proxyId, exitIp: p.exitIp })).slice(0, 200),
      summary: poolSummary(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

function tally(list) {
  const m = {};
  for (const k of list) m[k] = (m[k] || 0) + 1;
  return m;
}

/**
 * POST /api/proxy-pool —— 手工新增一条（少量补充用；批量走 /import）
 * body: { url, label?, group?, note? }
 */
router.post('/', requirePerm('dola:update'), (req, res) => {
  ensureProxyPoolSchema();
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, message: '缺少 url' });
  let u;
  try { u = new URL(url); } catch { return res.status(400).json({ ok: false, message: '代理格式不对，应形如 socks5://user:pass@host:port' }); }
  if (!/^(https?|socks[45]?):$/.test(u.protocol)) return res.status(400).json({ ok: false, message: `不支持的协议 ${u.protocol}` });
  if (!u.hostname || !u.port) return res.status(400).json({ ok: false, message: '代理必须带 host 和 port' });

  const h = hashUrl(url);
  const ex = db.prepare('SELECT id FROM dola_proxies WHERE url_hash=?').get(h);
  if (ex) return res.status(409).json({ ok: false, message: `这条代理已存在（#${ex.id}）`, id: ex.id });

  const r = db.prepare(`INSERT INTO dola_proxies (label, url, url_hash, group_name, source, gateway, note, created_at, updated_at)
    VALUES (?,?,?,?,'manual',?,?,?,?)`)
    .run(String(req.body?.label || '').trim() || u.hostname, url, h, String(req.body?.group || '').trim(), u.hostname, String(req.body?.note || '').trim(), now(), now());
  audit(req, 'proxy_pool.add', 'proxy_pool', r.lastInsertRowid, `新增代理 ${u.hostname}`);
  res.json({ ok: true, id: r.lastInsertRowid, summary: poolSummary() });
});

/** PATCH /api/proxy-pool/:id —— 改标签/分组/备注/启停 */
router.patch('/:id', requirePerm('dola:update'), (req, res) => {
  ensureProxyPoolSchema();
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM dola_proxies WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '代理不存在' });

  const patch = {};
  if (req.body?.label !== undefined) patch.label = String(req.body.label);
  if (req.body?.group_name !== undefined) patch.group_name = String(req.body.group_name);
  if (req.body?.note !== undefined) patch.note = String(req.body.note);
  if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled ? 1 : 0;
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, message: '没有可更新的字段' });

  const keys = Object.keys(patch);
  db.prepare(`UPDATE dola_proxies SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
    .run(...keys.map((k) => patch[k]), now(), id);
  audit(req, 'proxy_pool.update', 'proxy_pool', id, `更新 ${keys.join('/')}`);
  res.json({ ok: true, id, summary: poolSummary() });
});

/**
 * DELETE /api/proxy-pool/:id —— 删除
 *
 * 被账号用着的时候**默认拒绝**：直接删掉会让那些账号的 proxy 变成一个
 * 池里查不到的野值（状态 B），反而是制造问题。要删就得显式 force=true。
 */
router.delete('/:id', requirePerm('dola:update'), (req, res) => {
  ensureProxyPoolSchema();
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM dola_proxies WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, message: '代理不存在' });

  const bound = db.prepare('SELECT COUNT(*) AS c FROM dola_accounts WHERE proxy=?').get(String(row.url)).c ?? 0;
  if (bound > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      ok: false,
      message: `还有 ${bound} 个账号在用这条代理，不能直接删。先重新分配（rebalance）或显式传 force=true`,
      boundAccounts: bound,
    });
  }

  db.prepare('DELETE FROM dola_proxies WHERE id=?').run(id);
  audit(req, 'proxy_pool.delete', 'proxy_pool', id, `删除代理 ${row.url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')}（当时 ${bound} 个账号在用）`);
  res.json({ ok: true, id, boundAccounts: bound, summary: poolSummary() });
});

export default router;

/**
 * ## 后续（尚未做，写在这里免得忘）
 *
 * 1. **建表搬进 `db.js`**：PROXY_POOL_SCHEMA 应该并入统一 SCHEMA，
 *    本模块只留读写。现在放这儿纯粹是为了避开并发改动。
 * 2. **`describeFetchError` 去重**：和 `routes/dola.js` 里的副本合成一个 util。
 * 3. **大池子改异步任务**：超过 200 条时代理巡检应该走 `jobs.js`
 *    （registerJobHandler），而不是压在 HTTP 请求里。
 * 4. **轮换不能掐断在途会话**：`dola_proxies` 换出口时要检查该代理上是否有
 *    in-flight 的生成任务（`dola_videos` 里 status 属于进行中的），有就延后 ——
 *    这一条是参考站也做得很粗糙的地方，但「中途换 IP」会让上游直接判风控。
 */
