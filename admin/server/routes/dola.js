/**
 * dola 账号池：批量导入 cookie、并发校验、查额度、额度转积分。
 *
 * 关键约束（务必知道，UI 上也写着）：
 *   1. dola 没有站内邮箱密码直登；Google 登录入池由独立 google-login 路由负责。
 *   2. 「额度转积分」是**内部记账**：按查到的额度折算成后台积分（可充到令牌）。
 *      它不会真的去 dola 消费掉额度 —— dola 的额度只有在那边实际生成内容时才会被扣。
 *      之所以这么设计：消费类接口未验证、且误调用会真花掉你的账号额度。
 */
import crypto from 'node:crypto';
import express from 'express';
import { db, getSetting } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { createJob, getJob, listJobs, cancelJob, registerJobHandler } from '../jobs.js';
import {
  parseCookies, missingRequired, checkSession, probeCredits,
  fetchCreditsViaBrowser, playwrightAvailable, findCreditFields,
  fetchProfile, fetchSubscription, probeNativeThirtySecondViaBrowser,
  probeNativeFifteenSecondViaBrowser,
  probeReferenceImageViaBrowser,
  looksLikeJsonBlob, DOLA_LOGIN_OPTIONS, DOLA_CODE,
} from '../dola/provider.js';
import { proxyOf, proxyUrlOf } from '../dola/proxy.js';
import { accountHealth, creditBalanceFromHits, quotaObservation, summarizeQuota } from '../dola/account-observations.js';
import { generationStatus } from '../dola/generator.js';
import { referenceImageEvidenceNote } from '../dola/reference-images.js';

const router = express.Router();
router.use(requireAuth);

const now = () => new Date().toISOString();
const cookieHash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);

const numSetting = (k, d) => {
  const v = Number(getSetting(k, String(d)));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const boolSetting = (k, d = false) => getSetting(k, d ? 'true' : 'false') === 'true';
const autoMaintenanceEnabled = () => process.env.DOLA_AUTO_MAINTENANCE === 'false'
  ? false
  : boolSetting('dola_auto_maintenance_enabled', true);

/**
 * Read-only proxy isolation summary. The exit IP itself never leaves this
 * process; only counts are returned to the admin UI.
 */
function proxyExitSummary() {
  const rows = db.prepare(`SELECT status, proxy, exit_ip FROM dola_accounts
                           WHERE status <> 'disabled'`).all();
  const withProxy = rows.filter((row) => String(row.proxy || '').trim());
  const exitCounts = new Map();
  let withExitIp = 0;
  for (const row of withProxy) {
    const exitIp = String(row.exit_ip || '').trim();
    if (!exitIp) continue;
    withExitIp++;
    if (row.status === 'valid') exitCounts.set(exitIp, (exitCounts.get(exitIp) || 0) + 1);
  }
  const sharedGroups = [...exitCounts.values()].filter((count) => count > 1);
  return {
    withProxy: withProxy.length,
    distinctProxies: new Set(withProxy.map((row) => String(row.proxy).trim())).size,
    withExitIp,
    missingExitIp: Math.max(0, withProxy.length - withExitIp),
    distinctExitIps: new Set([...exitCounts.keys()]).size,
    sharedExitIpGroups: sharedGroups.length,
    sharedExitIpRows: sharedGroups.reduce((sum, count) => sum + count, 0),
    uniqueValidExitIps: [...exitCounts.values()].filter((count) => count === 1).length,
  };
}

function toRow(r, { reveal = false } = {}) {
  const observation = quotaObservation(r);
  return {
    ...r,
    cookie: reveal ? r.cookie : (r.cookie ? `***（${r.cookie.length} 字符）` : ''),
    hasCookie: Boolean(r.cookie),
    counted: Boolean(r.counted_at),
    countable: r.status === 'valid' && !r.counted_at,
    quotaKnown: observation.state === 'confirmed',
    quotaState: observation.state,
    quotaAvailable: observation.remaining,
    quotaSource: r.quota_source || null,
  };
}

/** 把一个账号的 cookie 解析出来（统一入口，避免各处重复写） */
function accountCookies(account) {
  return parseCookies(account.cookie);
}

// ================================================================ 任务处理器

/** Discard an in-flight read if credentials or a newer/manual balance changed. */
function saveAccountCredits(acc, credits, source) {
  return db.prepare(`UPDATE dola_accounts SET credits=?, credits_source=?, credits_at=?, updated_at=?
    WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'
      AND credits IS ? AND credits_source IS ? AND credits_at IS ?`)
    .run(credits, source, now(), now(), acc.id, acc.cookie_hash, acc.proxy,
      acc.credits, acc.credits_source, acc.credits_at).changes > 0;
}

/**
 * 查一个账号的可查询额度。
 *
 * 这和免费号的「日内视频额度」是两回事：付费额度可能出现在这些接口里，
 * 免费日内额度目前仍只会出现在真实生成回执中，不能因为这里没找到字段就写成 0。
 */
async function readAccountCredits(accountId, { automatic = false } = {}) {
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id = ?').get(accountId);
  if (!acc) return { ok: false, message: '账号不存在' };
  if (acc.status === 'disabled') return { ok: false, message: '账号已停用，跳过' };

  const cookies = accountCookies(acc);
  const proxy = proxyUrlOf(acc);
  const timeout = numSetting('dola_http_timeout', 20) * 1000;

  let credits = null, source = null, note = '';

  const probes = await probeCredits(cookies, { timeout, proxy });
  for (const p of probes) {
    const hit = creditBalanceFromHits(p.numericHits, p.path);
    if (hit && p.status === 200 && p.kind === 'ok') { credits = Number(hit.value); source = `${hit.field} (${p.path})`; break; }
  }

  // Periodic checks remain HTTP-only; opening a second browser can disturb an active session.
  if (!automatic && credits === null && getSetting('dola_use_browser', 'false') === 'true') {
    const r = await fetchCreditsViaBrowser(cookies, { timeout: 45000, proxy: proxyOf(acc), proxyUrl: proxy });
    if (r.ok) {
      const hit = r.hits.find((h) => h.status === 200 && h.code === 0 && creditBalanceFromHits([h], h.from));
      if (hit) { credits = Number(hit.value); source = `${hit.field} (${hit.from}, 浏览器)`; note = '浏览器通道'; }
    } else {
      note = `浏览器通道失败：${r.error}`;
    }
  }

  if (credits === null) {
    const msg = note || '未读到明确的账户余额，保留原读数；免费日额度等待生成回执';
    // A probe with no balance is not a new balance observation or a session error.
    return { ok: false, message: msg };
  }

  if (!saveAccountCredits(acc, credits, source)) {
    return { ok: false, message: '账号已更新、停用或余额已人工修正，丢弃旧额度结果' };
  }
  return { ok: true, message: `额度 ${credits}（${source}）` };
}

/** 校验账号 cookie 是否还有效 */
registerJobHandler('dola_check', async (accountId, ctx = {}) => {
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id = ?').get(accountId);
  if (!acc) return { ok: false, message: '账号不存在' };
  if (acc.status === 'disabled') return { ok: true, message: '账号已停用，跳过' };

  const cookies = accountCookies(acc);
  const proxy = proxyUrlOf(acc);
  const automatic = Boolean(ctx.job?.payload?.autoMaintenance);
  const cleanupEnabled = () => !automatic || boolSetting('dola_auto_cleanup_invalid', true);
  if (automatic && db.prepare("SELECT id FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(accountId)) {
    return { ok: true, message: '账号正在生成，留待下轮巡检' };
  }
  const missing = missingRequired(cookies);
  if (missing.length) {
    const status = cleanupEnabled() ? 'invalid' : 'unknown';
    db.prepare('UPDATE dola_accounts SET status=?, last_check_at=?, last_error=?, updated_at=? WHERE id=?')
      .run(status, now(), `缺少关键 cookie：${missing.join(', ')}`, now(), accountId);
    return { ok: false, message: `${status === 'invalid' ? '已隔离：' : ''}缺少关键 cookie：${missing.join(', ')}` };
  }

  const timeout = numSetting('dola_http_timeout', 20) * 1000;
  const s = await checkSession(cookies, { timeout, proxy });

  // 账号身份 + 会员等级：实测 /alice/profile/self_brief 是最可靠的来源
  // （user/launch 的 sec_user_id 实测是空串，光靠它认不出账号）
  //
  // ⚠️ 这里 fetchProfile 不只是"顺便拿资料"，它还是**第二道有效性闸门**：
  //   `checkSession` 走的是 `/alice/user/config/pull`，那条接口对「半失效」
  //   状态（code 710012014）**完全无感**，会返回 ok。
  //   所以有效性 = config/pull 通 **且** self_brief 通，缺一不可。
  const prof = await fetchProfile(cookies, { timeout, proxy });
  const health = accountHealth(s, prof);
  const healthy = health.kind === 'valid';
  const sub = healthy ? await fetchSubscription(cookies, { timeout, proxy }) : { ok: false };
  const hint = prof.ok ? (prof.nickname || prof.userName || prof.id) : '';
  // 会员等级优先取 subscription（不依赖签名），退回 profile
  const membership = sub.subsStatus || prof.membershipLevel || acc.membership || '';

  // launch 响应里可能直接带额度，顺手抓一把
  const hits = findCreditFields(s.launchRaw);
  const creditsHit = healthy && s.launchStatus === 200 && s.launchCode === 0
    ? creditBalanceFromHits(hits, '/alice/user/launch') : null;

  const explicitDead = health.kind === 'invalid';
  const failReason = health.message;

  // 只有明确的会话失效证据才自动隔离。网络/代理/未知错误保持原状态，
  // 避免自动维护把整池好号误清掉。
  const nextStatus = healthy ? 'valid' : (explicitDead ? (cleanupEnabled() ? 'invalid' : 'unknown') : null);
  const written = db.prepare(`UPDATE dola_accounts SET status=COALESCE(?,status), sec_user_id=?, account_hint=?, membership=?, last_check_at=?, last_error=?,
              updated_at=?
              WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'`)
    .run(
      nextStatus,
      prof.entityId || s.secUid || acc.sec_user_id || '',
      hint || acc.account_hint || '',
      membership,
      now(),
      healthy ? '' : failReason,
      now(),
      accountId,
      acc.cookie_hash,
      acc.proxy,
    );
  if (!written.changes) return { ok: true, message: '账号已更新或停用，丢弃旧校验结果' };
  const creditsSaved = creditsHit && saveAccountCredits(acc, Number(creditsHit.value), `${creditsHit.field} (launch)`);

  let quotaNote = '';
  if (automatic && healthy && boolSetting('dola_auto_quota_probe', true)) {
    // 这是可查 credits 的自动探测；免费日内视频额度仍以生成回执为准。
    try {
      const quota = await readAccountCredits(accountId, { automatic: true });
      quotaNote = `；${quota.message}`;
    } catch (e) {
      quotaNote = `；自动额度探测暂不可用（${e.message}）`;
    }
  }

  const tier = membership ? `，会员 ${membership}` : '';
  return {
    ok: healthy,
    message: healthy
      ? `有效${tier}${hint ? `，账号 ${hint}` : ''}${creditsSaved ? `，额度 ${creditsHit.value}` : ''}${quotaNote}`
      : (nextStatus === 'invalid' ? `已隔离：${failReason}` : `暂未判定失效：${failReason}`),
  };
});

/** 查额度：先纯 HTTP 试，拿不到再按配置走浏览器通道 */
registerJobHandler('dola_credits', async (accountId) => readAccountCredits(accountId));

// ================================================================ 自动维护

let maintenanceTimer = null;
let maintenanceNextRunAt = null;
const maintenanceInterval = () => Math.max(15, Math.min(1440, numSetting('dola_auto_maintenance_interval_minutes', 180)));

function autoMaintenanceJobRow({ activeOnly = false } = {}) {
  const status = activeOnly ? "status IN ('queued','running')" : "1=1";
  return db.prepare(`SELECT id,type,status,total,done,ok_count,fail_count,created_at,updated_at
                     FROM jobs
                     WHERE type='dola_check' AND ${status}
                       AND payload LIKE '%"autoMaintenance":true%'
                     ORDER BY id DESC LIMIT 1`).get() || null;
}

/** 创建一次自动维护任务。不会删除 cookie，只会把明确失效账号隔离出选号池。 */
export function enqueueDolaMaintenance(reason = 'scheduled', { force = false, userId = null } = {}) {
  if (!force && !autoMaintenanceEnabled()) {
    return { created: false, skipped: 'disabled', job: null };
  }

  const active = autoMaintenanceJobRow({ activeOnly: true });
  if (active) return { created: false, skipped: 'already_running', job: getJob(active.id) };
  const busy = db.prepare("SELECT id FROM jobs WHERE type IN ('dola_check','dola_credits') AND status IN ('queued','running') LIMIT 1").get();
  if (busy) return { created: false, skipped: 'already_running', job: getJob(busy.id) };

  const ids = db.prepare("SELECT id FROM dola_accounts WHERE status <> 'disabled' ORDER BY id").all().map((r) => r.id);
  if (!ids.length) return { created: false, skipped: 'empty', job: null };

  const concurrency = Math.min(5, numSetting('dola_check_concurrency', 5));
  const job = createJob({
    type: 'dola_check',
    ids,
    concurrency,
    userId,
    payload: { autoMaintenance: true, reason, createdAt: now() },
  });
  return { created: true, skipped: null, job };
}

export function getDolaMaintenanceState() {
  const last = autoMaintenanceJobRow();
  const active = autoMaintenanceJobRow({ activeOnly: true });
  return {
    enabled: autoMaintenanceEnabled(),
    cleanupInvalid: boolSetting('dola_auto_cleanup_invalid', true),
    quotaProbe: boolSetting('dola_auto_quota_probe', true),
    intervalMinutes: maintenanceInterval(),
    nextRunAt: autoMaintenanceEnabled() && maintenanceNextRunAt ? new Date(maintenanceNextRunAt).toISOString() : null,
    activeJob: active,
    lastJob: last,
  };
}

/**
 * 进程内轻量定时器：设置开启后首次约 15 秒巡检，之后按设置间隔运行。
 * 每次只入队一个后台任务，真正的请求仍由 jobs.js 的并发池执行。
 */
export function startDolaMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  let earliest = Date.now() + 15_000;
  let retryAt = 0;

  const tick = () => {
    try {
      if (!autoMaintenanceEnabled()) {
        maintenanceNextRunAt = null;
        earliest = Date.now() + 15_000;
        return;
      }
      const last = autoMaintenanceJobRow();
      const due = last ? Date.parse(last.created_at) + maintenanceInterval() * 60_000 : earliest;
      maintenanceNextRunAt = Math.max(earliest, due, retryAt);
      if (Date.now() < maintenanceNextRunAt) return;
      const result = enqueueDolaMaintenance('scheduled');
      if (result.created) {
        console.log(`[dola] 自动维护已入队 #${result.job.id}（${result.job.total} 个账号）`);
        maintenanceNextRunAt = Date.parse(result.job.created_at) + maintenanceInterval() * 60_000;
      } else {
        retryAt = Date.now() + 60_000;
        maintenanceNextRunAt = retryAt;
      }
    } catch {
      retryAt = Date.now() + 60_000;
      console.error('[dola] 自动维护暂不可用，一分钟后重试');
    }
  };

  maintenanceTimer = setInterval(tick, 15_000);
  // 不让定时器阻止测试进程或优雅退出；HTTP 服务本身仍会保持进程运行。
  maintenanceTimer.unref?.();
  tick();
  return () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    maintenanceNextRunAt = null;
  };
}

// ================================================================ 账号管理

/** GET /api/dola/provider —— 环境状态，前端据此提示 */
router.get('/provider', requirePerm('dola:list'), async (req, res) => {
  res.json({
    ok: true,
    loginOptions: DOLA_LOGIN_OPTIONS,
    playwright: await playwrightAvailable(),
    settings: {
      creditsPerPoint: numSetting('dola_credits_per_point', 10),
      pointsPerAccount: numSetting('dola_points_per_account', 50),
      convertBasis: getSetting('dola_convert_basis', 'account'),
      checkConcurrency: numSetting('dola_check_concurrency', 5),
      useBrowser: getSetting('dola_use_browser', 'false') === 'true',
      browserConcurrency: numSetting('dola_browser_concurrency', 3),
      generationConcurrency: numSetting('dola_gen_concurrency', 1),
      generationQueueLimit: numSetting('dola_gen_queue_limit', 6000),
    },
    generation: generationStatus(),
    maintenance: getDolaMaintenanceState(),
    codes: DOLA_CODE,
  });
});

/** GET /api/dola/generation-tasks —— 管理端只读查看生成任务，不返回令牌/扣费引用/媒体直链 */
router.get('/generation-tasks', requirePerm('dola:list'), (req, res) => {
  const allowed = new Set(['queued', 'submitting', 'generating', 'resolving', 'ready', 'failed', 'cancelled']);
  const requestedStatus = String(req.query.status || '').trim();
  const status = allowed.has(requestedStatus) ? requestedStatus : '';
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status, limit] : [limit];
  const rows = db.prepare(`SELECT id, account_label, prompt, ratio, seconds, force_seconds,
      status, stage, error, duration_sec, bytes, is_unwatermarked,
      CASE WHEN local_path IS NOT NULL AND local_path <> '' THEN 1 ELSE 0 END AS archived,
      created_at, updated_at, finished_at
    FROM dola_videos ${where} ORDER BY id DESC LIMIT ?`).all(...args);
  res.json({
    ok: true,
    generation: generationStatus(),
    status: status || null,
    items: rows.map((row) => ({
      ...row,
      prompt: String(row.prompt || '').slice(0, 240),
      promptTruncated: String(row.prompt || '').length > 240,
      archived: Boolean(row.archived),
      isUnwatermarked: Boolean(row.is_unwatermarked),
    })),
  });
});

/** POST /api/dola/maintenance/run —— 立即执行一次完整维护（不受自动开关影响） */
router.post('/maintenance/run', requirePerm('dola:check'), (req, res) => {
  const result = enqueueDolaMaintenance('manual', { force: true, userId: req.user.id });
  if (result.created) {
    audit(req, 'dola.maintenance_run', 'job', result.job.id, `自动维护 × ${result.job.total}`);
    return res.status(201).json({ ok: true, ...result });
  }
  res.json({ ok: true, ...result });
});

/** POST /api/dola/accounts/import —— 批量粘贴导入 */
router.post('/accounts/import', requirePerm('dola:import'), (req, res) => {
  const { raw = '', items = null, labelPrefix = '', note = '' } = req.body || {};
  const list = [];

  if (Array.isArray(items) && items.length) {
    for (const it of items) list.push({ raw: String(it.raw || it.cookie || ''), label: it.label || '' });
  } else if (looksLikeJsonBlob(raw)) {
    // 整段就是一个 JSON（浏览器插件导出的就是这种，且常是多行格式化过的）。
    // ⚠️ 这里绝不能按行拆 —— 否则一份 JSON 会被拆成几十上百个「账号」，
    // 还会从 `"name": "ttwid",` 这种行里解析出垃圾 cookie。真踩过。
    const text = String(raw);
    if (Object.keys(parseCookies(text)).length) {
      list.push({ raw: text, label: '' });
    } else {
      return res.status(400).json({ ok: false, message: '检测到 JSON 格式，但里面没有可用的 cookie（检查是否复制完整）' });
    }
  } else {
    // 一行一个账号；忽略空行和 # 注释
    for (const line of String(raw).split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      list.push({ raw: l, label: '' });
    }
  }

  if (!list.length) return res.status(400).json({ ok: false, message: '没解析到任何账号' });

  const stmt = db.prepare(`INSERT INTO dola_accounts
    (label,account_hint,cookie,cookie_hash,cookie_names,status,note,imported_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  /**
   * 「同一个账号重新导入 = 刷新它的 cookie」。
   *
   * 为什么必须支持（踩过）：dola 的会话会被踢，踢掉之后**唯一解法就是重新登录导出新 cookie**。
   * 但重新导出的 cookie 内容变了（sessionid 是新的），按 cookie_hash 去重是认不出来的 ——
   * 结果就是账号池里同一个邮箱躺两行：一行 status=invalid 的死号、一行新的。
   * 数量一多根本分不清哪些是活号。
   *
   * 所以：只要带了 label 且命中已存在的账号，就**原地刷新**（换 cookie、重置状态、
   * 清掉上次的错误），而不是新增一行。
   */
  const findByLabel = db.prepare('SELECT id, status FROM dola_accounts WHERE label = ?');
  const refreshStmt = db.prepare(`UPDATE dola_accounts
    SET cookie=?, cookie_hash=?, cookie_names=?, status=?, last_error=?,
        native_15s_state='unknown', native_15s_at=NULL, native_15s_note='',
        native_30s_state='unknown', native_30s_at=NULL, native_30s_note='',
        reference_image_state='unknown', reference_image_at=NULL, reference_image_note='',
        note=COALESCE(NULLIF(?, ''), note), updated_at=?
    WHERE id=?`);

  let inserted = 0, skipped = 0, invalid = 0, refreshed = 0;
  const problems = [];
  const createdIds = [];
  const refreshedIds = [];

  for (const [i, it] of list.entries()) {
    const cookies = parseCookies(it.raw);
    const names = Object.keys(cookies);
    if (!names.length) { invalid++; problems.push(`第 ${i + 1} 行解析不出 cookie`); continue; }

    const hash = cookieHash(names.map((n) => `${n}=${cookies[n]}`).sort().join(';'));
    const actualLabel = String(it.label || '').trim();
    const existByLabel = actualLabel ? findByLabel.get(actualLabel) : null;

    // ① 同一账号 → 原地刷新
    if (existByLabel) {
      refreshStmt.run(JSON.stringify(cookies), hash, names.join(','), existByLabel.status === 'disabled' ? 'disabled' : 'unknown', '',
        note, now(), existByLabel.id);
      refreshedIds.push(existByLabel.id);
      refreshed++;
      continue;
    }

    // ② 完全相同的 cookie → 跳过
    if (db.prepare('SELECT id FROM dola_accounts WHERE cookie_hash = ?').get(hash)) {
      skipped++;
      continue;
    }
    const missing = missingRequired(cookies);
    const label = actualLabel || `${labelPrefix || '账号'}${String(inserted + skipped + invalid + 1).padStart(3, '0')}`;
    const info = stmt.run(label, '', JSON.stringify(cookies), hash, names.join(','),
      missing.length ? 'invalid' : 'unknown',
      note, req.user.id, now(), now());
    createdIds.push(info.lastInsertRowid);
    inserted++;
    if (missing.length) problems.push(`${label} 缺少 ${missing.join(',')}`);
  }

  audit(req, 'dola.import', 'dola_account', [...createdIds, ...refreshedIds].join(','),
    `新增 ${inserted} 个 / 刷新 ${refreshed} 个（跳过重复 ${skipped}，无效 ${invalid}）`);
  res.status(201).json({
    ok: true, inserted, refreshed, skipped, invalid,
    ids: createdIds, refreshedIds, problems: problems.slice(0, 50),
  });
});

/** GET /api/dola/accounts */
router.get('/accounts', requirePerm('dola:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(label LIKE ? OR note LIKE ? OR sec_user_id LIKE ? OR account_hint LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where.push('status = ?'); params.push(status); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM dola_accounts${w}`).get(...params).c;
  const items = db.prepare(`SELECT * FROM dola_accounts${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  const validExitCounts = new Map(db.prepare(`SELECT TRIM(exit_ip) AS exit_ip, COUNT(*) AS c
      FROM dola_accounts
      WHERE status='valid' AND TRIM(COALESCE(exit_ip,'')) <> ''
      GROUP BY TRIM(exit_ip)`).all().map((row) => [row.exit_ip, Number(row.c)]));
  const publicItems = items.map((row) => {
    const exitIp = String(row.exit_ip || '').trim();
    return {
      ...toRow(row),
      // Do not expose the IP as a new UI field; only expose the maintenance
      // state needed to select a repair target without guessing from labels.
      exitIpKnown: Boolean(exitIp),
      exitIpShared: row.status === 'valid' && Boolean(exitIp) && (validExitCounts.get(exitIp) || 0) > 1,
    };
  });

  const summary = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled,
      COALESCE(SUM(credits),0) AS credits,
      COALESCE(SUM(CASE WHEN credits IS NOT NULL THEN credits ELSE 0 END) - SUM(converted_credits),0) AS convertible,
      SUM(CASE WHEN status='valid' AND counted_at IS NULL THEN 1 ELSE 0 END) AS countable,
      SUM(CASE WHEN counted_at IS NOT NULL THEN 1 ELSE 0 END) AS counted,
      SUM(CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooling,
      -- 代理覆盖：没配代理的号在共用本机 IP，会被上游按 IP 限流（710022002）
      SUM(CASE WHEN proxy IS NOT NULL AND proxy <> '' THEN 1 ELSE 0 END) AS withProxy,
      SUM(CASE WHEN status='valid' AND (proxy IS NULL OR proxy = '') THEN 1 ELSE 0 END) AS validNoProxy
    FROM dola_accounts`).get(now());
  Object.assign(summary, summarizeQuota(db.prepare(`SELECT status,cooldown_until,quota_remaining,quota_at,quota_source FROM dola_accounts`).all()));
  Object.assign(summary, proxyExitSummary());

  res.json({ ok: true, items: publicItems, total, page: Number(page), pageSize: Number(pageSize), summary });
});

/** GET /api/dola/accounts/:id/reveal —— 看完整 cookie（写审计） */
router.get('/accounts/:id/reveal', requirePerm('dola:list'), (req, res) => {
  const r = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ ok: false, message: '账号不存在' });
  audit(req, 'dola.reveal', 'dola_account', r.id, r.label);
  res.json({ ok: true, id: r.id, label: r.label, cookie: r.cookie });
});

/** POST /api/dola/accounts/:id/probe —— 对单个账号跑一次额度接口探测（排查用） */
router.post('/accounts/:id/probe', requirePerm('dola:check'), async (req, res) => {
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(Number(req.params.id));
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });
  const cookies = accountCookies(acc);
  const proxy = proxyUrlOf(acc);
  const timeout = numSetting('dola_http_timeout', 20) * 1000;
  const session = await checkSession(cookies, { timeout, proxy });
  const probes = await probeCredits(cookies, { timeout, proxy });
  audit(req, 'dola.probe', 'dola_account', acc.id, `valid=${session.valid}`);
  res.json({
    ok: true,
    session: { valid: session.valid, pullKind: session.pullKind, pullCode: session.pullCode, secUid: session.secUid, missing: session.missing },
    probes: probes.map((p) => ({ path: p.path, status: p.status, code: p.code, kind: p.kind, ms: p.ms, flagged: p.flagged, numericHits: p.numericHits, sample: p.sample })),
  });
});

/** Read-only page capability checks; never part of automatic session maintenance. */
const NATIVE_PROBE_CONFIG = Object.freeze({
  15: {
    seconds: 15,
    jobType: 'dola_native_15s',
    probe: probeNativeFifteenSecondViaBrowser,
    auditName: 'dola.native_15s_probe',
    successNote: '已确认页面提供 Seedance 2.0 原生 15 秒选项',
  },
  30: {
    seconds: 30,
    jobType: 'dola_native_30s',
    probe: probeNativeThirtySecondViaBrowser,
    auditName: 'dola.native_30s_probe',
    successNote: '已确认页面提供 Seedance 2.5 原生 30 秒选项',
  },
});

const REFERENCE_IMAGE_PROBE_CONFIG = Object.freeze({
  jobType: 'dola_reference_images',
  probe: probeReferenceImageViaBrowser,
  auditName: 'dola.reference_image_probe',
  successNote: '已确认页面提供明确的图片上传控件；尚未执行真实上传',
});

function nativeProbeConfig(seconds) {
  return NATIVE_PROBE_CONFIG[Number(seconds)] || null;
}

/**
 * 执行一次原生能力只读探测并做竞态安全写回。
 *
 * 这个核心同时供单账号 HTTP 路由和批量后台任务使用，避免两条路径的
 * Cookie / 代理 / 能力字段规则漂移。批量探测默认串行，减少浏览器和上游
 * 风控压力；任何异常都只记 unknown，不把账号误清理成 invalid。
 */
async function probeNativeCapability(accountId, seconds) {
  const config = nativeProbeConfig(seconds);
  if (!config) return { status: 400, ok: false, seconds, state: 'unknown', message: `不支持原生 ${seconds} 秒探测` };

  const id = Number(accountId);
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return { status: 404, ok: false, seconds, state: 'unknown', message: '账号不存在' };
  if (acc.status === 'disabled') return { status: 409, ok: false, seconds, state: 'unknown', message: '账号已停用，未探测', label: acc.label };

  const active = db.prepare("SELECT id FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(id);
  if (active) {
    return { status: 409, ok: false, seconds, state: 'unknown', message: '账号正在生成，跳过本次能力探测', label: acc.label };
  }

  const cookies = accountCookies(acc);
  const missing = missingRequired(cookies);
  let result;
  if (missing.length) {
    result = { ok: false, state: 'unknown', error: '缺少关键 cookie，未进行能力判定' };
  } else {
    try {
      result = await config.probe(cookies, {
        timeout: Math.min(90_000, numSetting('dola_http_timeout', 20) * 1000 + 60_000),
        proxy: proxyOf(acc),
        proxyUrl: proxyUrlOf(acc),
      });
    } catch {
      result = { ok: false, state: 'unknown', error: '页面、登录状态或网络未能完成只读能力探测' };
    }
  }

  const state = ['available', 'unavailable', 'unknown'].includes(result?.state) ? result.state : 'unknown';
  const note = String(result?.ok ? config.successNote : (result?.error || '本次未完成能力判定')).slice(0, 300);
  const capabilityColumn = `native_${config.seconds}s`;
  const updated = db.prepare(`UPDATE dola_accounts
    SET ${capabilityColumn}_state=?, ${capabilityColumn}_at=?, ${capabilityColumn}_note=?, updated_at=?
    WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'`)
    .run(state, now(), note, now(), id, acc.cookie_hash, acc.proxy).changes > 0;
  return { status: 200, ok: Boolean(result?.ok), seconds: config.seconds, state, message: note, updated, label: acc.label };
}

/**
 * 执行一次参考图能力只读探测并做竞态安全写回。
 *
 * 只认真实页面里明确声明 image 类型的 file input；仅有加号按钮、拖拽
 * 区域或未知菜单时保持 unknown，避免把猜测当成已支持。
 */
async function probeReferenceImageCapability(accountId) {
  const id = Number(accountId);
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return { status: 404, ok: false, state: 'unknown', message: '账号不存在' };
  if (acc.status === 'disabled') {
    return { status: 409, ok: false, state: 'unknown', message: '账号已停用，未探测', label: acc.label };
  }

  const active = db.prepare("SELECT id FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(id);
  if (active) {
    return { status: 409, ok: false, state: 'unknown', message: '账号正在生成，跳过本次能力探测', label: acc.label };
  }

  const cookies = accountCookies(acc);
  const missing = missingRequired(cookies);
  let result;
  if (missing.length) {
    result = { ok: false, state: 'unknown', error: '缺少关键 cookie，未进行能力判定' };
  } else {
    try {
      result = await REFERENCE_IMAGE_PROBE_CONFIG.probe(cookies, {
        timeout: Math.min(90_000, numSetting('dola_http_timeout', 20) * 1000 + 60_000),
        proxy: proxyOf(acc),
        proxyUrl: proxyUrlOf(acc),
      });
    } catch {
      result = { ok: false, state: 'unknown', error: '页面、登录状态或网络未能完成只读能力探测' };
    }
  }

  const state = ['available', 'unavailable', 'unknown'].includes(result?.state) ? result.state : 'unknown';
  const evidence = result?.ok ? referenceImageEvidenceNote(result.imageInputs) : '';
  const note = String(result?.ok ? `${REFERENCE_IMAGE_PROBE_CONFIG.successNote}${evidence}` : (result?.error || '本次未完成能力判定')).slice(0, 300);
  const updated = db.prepare(`UPDATE dola_accounts
    SET reference_image_state=?, reference_image_at=?, reference_image_note=?, updated_at=?
    WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'`)
    .run(state, now(), note, now(), id, acc.cookie_hash, acc.proxy).changes > 0;
  return { status: 200, ok: Boolean(result?.ok), state, message: note, updated, label: acc.label };
}

for (const config of Object.values(NATIVE_PROBE_CONFIG)) {
  registerJobHandler(config.jobType, async (accountId) => {
    const result = await probeNativeCapability(accountId, config.seconds);
    return { ok: result.status === 200 && result.ok, message: result.message };
  });
}

registerJobHandler(REFERENCE_IMAGE_PROBE_CONFIG.jobType, async (accountId) => {
  const result = await probeReferenceImageCapability(accountId);
  return { ok: result.status === 200 && result.ok, message: result.message };
});

async function runNativeCapabilityProbe(req, res, { seconds }) {
  const config = nativeProbeConfig(seconds);
  const result = await probeNativeCapability(req.params.id, seconds);
  if (result.status !== 200) return res.status(result.status).json({ ok: false, seconds, state: result.state, message: result.message });
  audit(req, config.auditName, 'dola_account', Number(req.params.id), `state=${result.state}; updated=${result.updated}`);
  res.json({ ok: result.ok, seconds: result.seconds, state: result.state, message: result.message, updated: result.updated });
}

/**
 * POST /api/dola/accounts/:id/native-30s-probe
 */
router.post('/accounts/:id/native-30s-probe', requirePerm('dola:check'), async (req, res) => runNativeCapabilityProbe(req, res, {
  seconds: 30,
}));

/**
 * POST /api/dola/accounts/:id/native-15s-probe
 */
router.post('/accounts/:id/native-15s-probe', requirePerm('dola:check'), async (req, res) => runNativeCapabilityProbe(req, res, {
  seconds: 15,
}));

/** POST /api/dola/accounts/:id/reference-images-probe */
router.post('/accounts/:id/reference-images-probe', requirePerm('dola:check'), async (req, res) => {
  const result = await probeReferenceImageCapability(req.params.id);
  if (result.status !== 200) {
    return res.status(result.status).json({ ok: false, state: result.state, message: result.message });
  }
  audit(req, REFERENCE_IMAGE_PROBE_CONFIG.auditName, 'dola_account', Number(req.params.id), `state=${result.state}; updated=${result.updated}`);
  return res.json({ ok: result.ok, state: result.state, message: result.message, updated: result.updated });
});

/**
 * POST /api/dola/accounts/:id/proxy  { proxy }
 *
 * 给账号配独立出口代理。为什么需要：
 * 上游按**出口 IP** 限流（710022002「当前服务访问频繁」），
 * 同一个 IP 操作多个账号必然撞墙 —— 方悦浏览器内置 sing-box 就是这个原因。
 * 传空字符串 = 清掉代理（走本机出口）。
 *
 * 格式：`http://user:pass@host:port` / `socks5://host:port`
 */
router.post('/accounts/:id/proxy', requirePerm('dola:update'), (req, res) => {
  const id = Number(req.params.id);
  const raw = String(req.body?.proxy ?? '').trim();
  const acc = db.prepare('SELECT id,label FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });

  if (raw) {
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ ok: false, message: '代理格式不对，应形如 http://user:pass@host:port' }); }
    if (!/^https?:$|^socks[45]?:$/.test(u.protocol)) {
      return res.status(400).json({ ok: false, message: `不支持的代理协议：${u.protocol}（支持 http/https/socks4/socks5）` });
    }
    if (!u.hostname || !u.port) return res.status(400).json({ ok: false, message: '代理必须带 host 和 port' });
  }

  db.prepare(`UPDATE dola_accounts SET proxy=?, exit_ip=NULL,
    native_15s_state='unknown', native_15s_at=NULL, native_15s_note='',
    native_30s_state='unknown', native_30s_at=NULL, native_30s_note='',
    reference_image_state='unknown', reference_image_at=NULL, reference_image_note='', updated_at=? WHERE id=?`)
    .run(raw, now(), id);
  audit(req, 'dola.set_proxy', 'dola_account', id, raw ? `设置代理 ${raw.replace(/\/\/[^@]*@/, '//***@')}` : '清除代理');
  res.json({ ok: true, id, label: acc.label, proxy: raw });
});

/** GET /api/dola/accounts/proxy/summary —— 号池代理覆盖率（一眼看出还有多少号在共用本机 IP） */
router.get('/accounts/proxy/summary', requirePerm('dola:list'), (req, res) => {
  const total = db.prepare("SELECT COUNT(*) AS c FROM dola_accounts WHERE status <> 'disabled'").get().c ?? 0;
  const stats = proxyExitSummary();
  const without = total - stats.withProxy;
  res.json({
    ok: true,
    total,
    ...stats,
    withoutProxy: without,
    hint: without > 0
      ? `${without} 个账号仍未配置代理；另有 ${stats.missingExitIp} 个代理账号尚未核验出口、${stats.sharedExitIpRows} 个有效账号处于共享出口`
      : (stats.missingExitIp || stats.sharedExitIpRows)
        ? `代理已配置，但仍有 ${stats.missingExitIp} 个账号缺少出口核验、${stats.sharedExitIpRows} 个有效账号处于共享出口`
        : '代理覆盖与出口隔离均已核验',
  });
});

/**
 * POST /api/dola/accounts/proxy/verify  { proxy }
 *
 * 实测一条代理能不能用，并回报**出口 IP 和地区**。
 * 配代理前一定要先验：配一条坏代理比不配更糟（请求全失败，还看不出原因）。
 */
router.post('/accounts/proxy/verify', requirePerm('dola:list'), async (req, res) => {
  const proxy = String(req.body?.proxy || '').trim();
  if (!proxy) return res.status(400).json({ ok: false, message: '缺少 proxy' });
  try {
    const { fetchVia } = await import('../dola/proxy.js');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('代理探测超时 20s')), 20000);
    try {
      const r = await fetchVia('https://ipinfo.io/json', { signal: ctrl.signal }, proxy);
      const j = await r.json().catch(() => ({}));
      res.json({ ok: r.ok, status: r.status, ip: j.ip ?? null, country: j.country ?? null, region: j.region ?? null, city: j.city ?? null, org: j.org ?? null });
    } finally { clearTimeout(timer); }
  } catch (e) {
    // ⚠️ 一定要把 cause 带出来。fetch 会把底层错误包成笼统的 "fetch failed"，
    //    不看 cause 就只能靠猜（实测被这个坑掉过一次：真正原因是
    //    `invalid onRequestStart method`，两份 undici 版本不匹配）。
    res.json({ ok: false, message: describeFetchError(e) });
  }
});

/** 把 fetch 的嵌套错误摊平成一句能定位的话 */
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

/**
 * POST /api/dola/accounts/proxy/assign
 *
 * 批量给账号分配独立出口代理。用 IPWeb 的「自编代理账号」能力（见 dola/proxy.js）：
 * **不需要调它的 API**，改 SID 就得到一条新代理，而同一 SID 固定同一出口 IP。
 * SID 由账号 id 确定性派生，所以重启/重配之后 IP 不变。
 *
 * body: { account:'B_xxx', password, country='KR', state='', city='', minutes=30,
 *         gateway?, ids?:[], all?:bool, force?:bool, verify?:bool }
 *
 * When force=false, explicitly supplied accounts that already have a proxy are
 * skipped. This makes a retried batch safe after a request timeout: completed
 * accounts are not silently re-rolled onto a different SID/IP.
 *
 * `verify` 默认开：逐条真连一次 ipinfo.io，**只把验证通过的写进库**。
 */
router.post('/accounts/proxy/assign', requirePerm('dola:update'), async (req, res) => {
  const { buildIpwebProxy, sidForAccount, IPWEB_GATEWAYS, maskProxy, fetchVia, parseReusableIpwebProxy } = await import('../dola/proxy.js');

  const reuseExisting = req.body?.reuseExisting === true;
  const ipAccount = String(req.body?.account || '').trim();
  const password = String(req.body?.password || '');
  const country = String(req.body?.country || 'KR').toUpperCase();
  const state = String(req.body?.state || '');
  const city = String(req.body?.city || '');
  const minutes = Number(req.body?.minutes || 30);
  const gateway = String(req.body?.gateway || IPWEB_GATEWAYS.apac);
  const force = req.body?.force === true;
  const doVerify = req.body?.verify !== false;
  const verifyGapMs = Math.max(0, Math.min(10000, Number(req.body?.gapMs ?? 3000)));

  if (!reuseExisting && (!ipAccount || !password)) {
    return res.status(400).json({ ok: false, message: '缺少 account（用户编号 B_xxx）或 password' });
  }

  // 选账号：显式 ids 优先，否则 all / 全部未配代理的
  let ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map(Number).filter(Boolean))]
    : [];
  if (reuseExisting && !ids.length) {
    return res.status(400).json({ ok: false, message: '复用现有 IPWeb 配置时必须明确选择账号' });
  }
  if (!ids.length) {
    const where = force ? "status <> 'disabled'" : "status <> 'disabled' AND (proxy IS NULL OR proxy = '')";
    ids = db.prepare(`SELECT id FROM dola_accounts WHERE ${where} ORDER BY id`).all().map((r) => r.id);
  }
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有需要处理的账号' });

  const accountRows = new Map(ids.map((id) => [
    id,
    db.prepare('SELECT id,status,proxy,exit_ip FROM dola_accounts WHERE id=?').get(id),
  ]));
  const skipExistingIds = new Set(
    !force && !reuseExisting
      ? ids.filter((id) => {
        const row = accountRows.get(id);
        return row && row.status !== 'disabled' && row.proxy;
      })
      : [],
  );
  const processIds = new Set(ids.filter((id) => !skipExistingIds.has(id)));

  const results = [];
  let assigned = 0, failed = 0, skipped = 0, rerolled = 0, collisions = 0;

  /**
   * 已经用掉的出口 IP。**必须排除本次要重新分配的这几个账号自己的旧值**，
   * 否则重跑时会拿旧 IP 跟自己撞，白白 reroll。
   */
  const exitRows = db.prepare("SELECT id, exit_ip FROM dola_accounts WHERE status <> 'disabled' AND exit_ip IS NOT NULL AND exit_ip <> ''").all();
  // Existing proxies that are skipped remain part of the occupied-IP set;
  // only accounts that will actually be reassigned may release their old IP.
  const usedIps = new Set(exitRows.filter((r) => !processIds.has(r.id)).map((r) => r.exit_ip));
  const selectedExitCounts = new Map();
  for (const row of exitRows) {
    if (!processIds.has(row.id)) continue;
    selectedExitCounts.set(row.exit_ip, (selectedExitCounts.get(row.exit_ip) || 0) + 1);
  }
  // 选中的账号如果彼此共享旧出口，也必须先把这个 IP 视为已占用，
  // 否则第一个账号可能继续写回旧共享 IP，修复后仍会留下隐性撞车。
  for (const [ip, count] of selectedExitCounts) {
    if (count > 1) usedIps.add(ip);
  }

  const MAX_ATTEMPT = 6;      // 最多换 6 个 SID 找不撞的 IP
  let first = true;

  for (const id of ids) {
    const current = accountRows.get(id);
    if (!current) {
      results.push({ id, ok: false, message: '账号不存在' });
      failed++;
      continue;
    }
    if (current.status === 'disabled') {
      results.push({ id, ok: false, message: '账号已停用，未分配代理' });
      failed++;
      continue;
    }
    if (skipExistingIds.has(id)) {
      results.push({ id, ok: true, skipped: true, message: '已有代理，跳过（未使用 --force）' });
      skipped++;
      continue;
    }

    // ⚠️ 每条之间必须留间隔。实测：连着发会**全部**返回
    //    `UND_ERR_SOCKS5_AUTH_FAILED`（连刚成功的 SID 也一起失败），
    //    隔 3 秒逐个测则 100% 成功 —— IPWeb 的 SOCKS 认证对短时高频握手有限流。
    //    这个坑很坑人：看起来像"密码错了"，实际是"问得太快"。
    if (!first && doVerify) await new Promise((r) => setTimeout(r, verifyGapMs));
    first = false;

    let ok = false;
    let lastErr = '';
    let reusableConfig = null;
    if (reuseExisting) {
      try {
        reusableConfig = parseReusableIpwebProxy(current?.proxy);
      } catch (e) {
        results.push({ id, ok: false, message: e.message });
        failed++;
        continue;
      }
    }
    for (let attempt = 0; attempt < MAX_ATTEMPT && !ok; attempt++) {
      const sid = sidForAccount(id, attempt);
      let proxy;
      try {
        proxy = buildIpwebProxy(reuseExisting
          ? { ...reusableConfig, sid }
          : { account: ipAccount, password, country, state, city, minutes, sid, gateway });
      } catch (e) {
        results.push({ id, ok: false, message: e.message });
        failed++;
        break;
      }

      if (!doVerify) {
        db.prepare(`UPDATE dola_accounts SET proxy=?, exit_ip=NULL,
          native_15s_state='unknown', native_15s_at=NULL, native_15s_note='',
          native_30s_state='unknown', native_30s_at=NULL, native_30s_note='',
          reference_image_state='unknown', reference_image_at=NULL, reference_image_note='', updated_at=? WHERE id=?`)
          .run(proxy, now(), id);
        results.push({ id, ok: true, sid });
        assigned++;
        ok = true;
        break;
      }

      // 网络抖动（超时之类）不算"这个 SID 不行"，同一个 SID 重试一次
      let info = null;
      for (let retry = 0; retry < 2 && !info; retry++) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(new Error('超时 15s')), 15000);
          try {
            const r = await fetchVia('https://ipinfo.io/json', { signal: ctrl.signal }, proxy);
            const j = await r.json();
            if (j?.ip) info = j;
          } finally { clearTimeout(timer); }
          if (!info) lastErr = '拿不到出口 IP';
        } catch (e) {
          lastErr = describeFetchError(e);
          if (retry === 0) await new Promise((r) => setTimeout(r, 1500));
        }
      }

      if (!info) {
        results.push({ id, ok: false, sid, using: maskProxy(proxy), message: `代理不通：${lastErr}` });
        failed++;
        break;
      }

      // ★ 撞 IP 判定：两个账号共用出口 IP 就等于没隔离
      if (usedIps.has(info.ip)) {
        collisions++;
        if (attempt + 1 < MAX_ATTEMPT) {
          rerolled++;
          console.warn(`[proxy] 账号 #${id} 撞到已用出口 IP ${info.ip}，换 SID 重试（第 ${attempt + 2} 次）`);
          await new Promise((r) => setTimeout(r, verifyGapMs));
          continue;
        }
        // Fail closed. Writing a duplicated exit as if it were usable would
        // immediately reintroduce the upstream per-IP rate-limit condition.
        results.push({ id, ok: false, sid, duplicated: true, message: '换 SID 后仍与现有有效账号共用出口 IP，未写入' });
        failed++;
        break;
      }

      db.prepare(`UPDATE dola_accounts SET proxy=?, exit_ip=?,
        native_15s_state='unknown', native_15s_at=NULL, native_15s_note='',
        native_30s_state='unknown', native_30s_at=NULL, native_30s_note='',
        reference_image_state='unknown', reference_image_at=NULL, reference_image_note='', updated_at=? WHERE id=?`)
        .run(proxy, info.ip, now(), id);
      usedIps.add(info.ip);
      results.push({ id, ok: true, sid, exitIp: info.ip, exitCountry: info.country, exitCity: info.city });
      assigned++;
      ok = true;
    }
  }

  const dupCount = results.filter((r) => r.duplicated).length;
  if (dupCount) console.warn(`[proxy] 有 ${dupCount} 个账号在换满 ${MAX_ATTEMPT} 个 SID 后仍与他人共用出口 IP`);
  if (collisions) console.log(`[proxy] 共处理 ${collisions} 次出口 IP 撞车，其中 ${rerolled} 次通过换 SID 解决`);

  audit(req, 'dola.assign_proxy', 'dola_account', ids.join(','),
    `${reuseExisting ? '复用现有 IPWeb 配置' : '分配代理'} ${assigned} 个（跳过 ${skipped}，失败 ${failed}，撞车 ${collisions} 次/换 SID ${rerolled} 次）${reuseExisting ? '' : `，国家 ${country}，网关 ${gateway}`}`);
  res.json({
    ok: true, assigned, skipped, failed, total: ids.length, verified: doVerify, collisions, rerolled,
    duplicated: results.filter((r) => r.duplicated).length,
    results: results.slice(0, 100),
  });
});

/** POST /api/dola/accounts/:id/action  { action: disable|enable|check|credits } */
router.post('/accounts/:id/action', requirePerm('dola:update'), async (req, res) => {
  const id = Number(req.params.id);
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });
  const action = String(req.body?.action || '');

  if (action === 'disable' || action === 'enable') {
    const status = action === 'enable' ? 'unknown' : 'disabled';
    db.prepare('UPDATE dola_accounts SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
    audit(req, `dola.${action}`, 'dola_account', id, acc.label);
    return res.json({ ok: true, status });
  }

  if (action === 'check' || action === 'credits') {
    const job = createJob({
      type: action === 'check' ? 'dola_check' : 'dola_credits',
      ids: [id], concurrency: 1, userId: req.user.id,
    });
    return res.json({ ok: true, job });
  }

  /**
   * 手动录入额度。
   * 存在的理由：自动查额度依赖尚未实测出来的字段；在你确认字段之前，
   * 先能手工把额度填进来，整条「额度 → 积分」链路就能先用起来。
   * 也用于纠正查错的数值。会写审计。
   */
  if (action === 'set_credits') {
    const credits = Number(req.body?.credits);
    if (!Number.isFinite(credits) || credits < 0) {
      return res.status(400).json({ ok: false, message: '额度必须是不小于 0 的数字' });
    }
    db.prepare(`UPDATE dola_accounts SET credits=?, credits_source=?, credits_at=?, last_error='', updated_at=? WHERE id=?`)
      .run(credits, '手动录入', now(), now(), id);
    audit(req, 'dola.set_credits', 'dola_account', id,
      `${acc.label} 额度 ${acc.credits ?? '-'} → ${credits}（手动录入）`);
    return res.json({ ok: true, credits });
  }

  /** 撤销「已计价」标记，用于纠错（不删换算流水，流水是历史事实） */
  if (action === 'reset_counted') {
    if (!acc.counted_at) return res.status(400).json({ ok: false, message: '该账号还没计过价' });
    db.prepare('UPDATE dola_accounts SET counted_at=NULL, updated_at=? WHERE id=?').run(now(), id);
    audit(req, 'dola.reset_counted', 'dola_account', id, `${acc.label} 撤销计价标记（原 ${acc.counted_at}）`);
    return res.json({ ok: true });
  }

  return res.status(400).json({ ok: false, message: `不支持的动作：${action}` });
});

/** DELETE /api/dola/accounts/:id */
router.delete('/accounts/:id', requirePerm('dola:delete'), (req, res) => {
  const id = Number(req.params.id);
  const acc = db.prepare('SELECT label FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });
  const used = db.prepare('SELECT COUNT(*) AS c FROM credit_conversions WHERE account_id=?').get(id).c;
  const force = req.query.force === '1' || req.body?.force === true;
  if (used > 0 && !force) {
    return res.status(400).json({ ok: false, message: `该账号有 ${used} 条换算记录，建议改为「停用」（确要删加 force=1，会留审计）` });
  }
  db.prepare('DELETE FROM dola_accounts WHERE id=?').run(id);
  audit(req, used ? 'dola.force_delete' : 'dola.delete', 'dola_account', id, acc.label);
  res.json({ ok: true, forced: Boolean(used && force) });
});

/** DELETE /api/dola/accounts —— 批量删除 {ids:[]} */
router.delete('/accounts', requirePerm('dola:delete'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何账号' });
  const force = req.body?.force === true;
  const stmt = force
    ? db.prepare('DELETE FROM dola_accounts WHERE id=?')
    : db.prepare(`DELETE FROM dola_accounts WHERE id=? AND id NOT IN (SELECT account_id FROM credit_conversions WHERE account_id IS NOT NULL)`);
  let deleted = 0;
  for (const id of ids) deleted += stmt.run(id).changes;
  audit(req, 'dola.bulk_delete', 'dola_account', ids.join(','), `删除 ${deleted} 个（跳过 ${ids.length - deleted}）`);
  res.json({ ok: true, deleted, skipped: ids.length - deleted });
});

// ================================================================ 任务

/** POST /api/dola/jobs  { type, ids? | all:true, concurrency? } */
router.post('/jobs', requirePerm('dola:check'), (req, res) => {
  const type = String(req.body?.type || '');
  const nativeSeconds = type === 'dola_native_15s' ? 15 : (type === 'dola_native_30s' ? 30 : null);
  const referenceImages = type === 'dola_reference_images';
  if (!['dola_check', 'dola_credits', 'dola_native_15s', 'dola_native_30s', 'dola_reference_images'].includes(type)) {
    return res.status(400).json({ ok: false, message: `不支持的任务类型：${type}` });
  }
  let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (req.body?.all) {
    const statusFilter = nativeSeconds
      ? `status = 'valid' AND proxy IS NOT NULL AND proxy <> '' AND native_${nativeSeconds}s_state <> 'available'`
      : referenceImages
        ? "status = 'valid' AND proxy IS NOT NULL AND proxy <> '' AND reference_image_state <> 'available'"
      : (type === 'dola_credits' ? "status IN ('valid','unknown')" : "status <> 'disabled'");
    ids = db.prepare(`SELECT id FROM dola_accounts WHERE ${statusFilter} ORDER BY id`).all().map((r) => r.id);
  }
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有要处理的对象' });

  // 浏览器通道很吃内存，并发单独限
  const defaultConc = nativeSeconds || referenceImages
    ? 1
    : (type === 'dola_credits' && getSetting('dola_use_browser', 'false') === 'true'
      ? numSetting('dola_browser_concurrency', 3)
      : numSetting('dola_check_concurrency', 5));

  const job = createJob({
    type,
    ids,
    concurrency: nativeSeconds || referenceImages
      ? Math.min(2, Math.max(1, Number(req.body?.concurrency) || defaultConc))
      : (Number(req.body?.concurrency) || defaultConc),
    userId: req.user.id,
  });
  audit(req, 'dola.job_create', 'job', job.id, `${type} × ${ids.length}`);
  res.status(201).json({ ok: true, job });
});

router.get('/jobs', requirePerm('dola:list'), (req, res) => {
  res.json({ ok: true, items: listJobs({ limit: Number(req.query.limit) || 20, type: String(req.query.type || '') }) });
});

router.get('/jobs/:id', requirePerm('dola:list'), (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ ok: false, message: '任务不存在' });
  // payload 里带全量 ids，几百个账号时太大，这里只回报数量
  const { ids, ...restPayload } = job.payload || {};
  res.json({ ok: true, job: { ...job, payload: { ...restPayload, idCount: (ids || []).length } } });
});

router.post('/jobs/:id/cancel', requirePerm('dola:check'), (req, res) => {
  const job = cancelJob(Number(req.params.id));
  if (!job) return res.status(404).json({ ok: false, message: '任务不存在' });
  audit(req, 'dola.job_cancel', 'job', job.id, job.type);
  res.json({ ok: true, job });
});

// ================================================================ 额度 → 积分

/**
 * POST /api/dola/convert
 *   { ids?:[], all?:bool, tokenId?:number, ratio?:number, dryRun?:bool }
 *
 * 语义说明（UI 上也会写）：这是**内部记账** —— 按查到的额度折算成后台积分，
 * 可选择充到某个令牌。不会真的去 dola 消费额度。
 */
router.post('/convert', requirePerm('dola:convert'), (req, res) => {
  const basis = String(req.body?.basis || getSetting('dola_convert_basis', 'account'));
  if (!['account', 'credits'].includes(basis)) {
    return res.status(400).json({ ok: false, message: `不支持的计价方式：${basis}` });
  }

  const tokenId = req.body?.tokenId ? Number(req.body.tokenId) : null;
  if (tokenId) {
    const t = db.prepare('SELECT id,prefix,status FROM tokens WHERE id=?').get(tokenId);
    if (!t) return res.status(404).json({ ok: false, message: '令牌不存在' });
    if (t.status !== 'active') return res.status(400).json({ ok: false, message: `令牌状态为 ${t.status}，不能充值` });
  }

  let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (req.body?.all) {
    ids = basis === 'account'
      // 按账号计价：有效且还没计过价的
      ? db.prepare("SELECT id FROM dola_accounts WHERE status='valid' AND counted_at IS NULL ORDER BY id").all().map((r) => r.id)
      // 按额度计价：有效且查到过额度、还有余额没换完的
      : db.prepare("SELECT id FROM dola_accounts WHERE status='valid' AND credits IS NOT NULL AND credits > converted_credits ORDER BY id").all().map((r) => r.id);
  }
  if (!ids.length) {
    return res.status(400).json({
      ok: false,
      message: basis === 'account'
        ? '没有可计价的账号（需要状态有效且还没计过价）'
        : '没有可换算的账号（需要状态有效且已查到额度）',
    });
  }

  const dryRun = Boolean(req.body?.dryRun);
  const details = [];
  let totalPoints = 0, converted = 0, creditsUsed = 0;
  let ratioDesc = '';

  // ---------- 方式一：按账号数计价（免费号场景） ----------
  if (basis === 'account') {
    const per = Number(req.body?.pointsPerAccount) || numSetting('dola_points_per_account', 50);
    if (per <= 0) return res.status(400).json({ ok: false, message: '单账号积分数必须大于 0' });
    ratioDesc = `1 个有效账号 = ${per} 积分`;

    for (const id of ids) {
      const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
      if (!acc) { details.push({ id, ok: false, message: '账号不存在' }); continue; }
      if (acc.status !== 'valid') { details.push({ id, ok: false, message: `状态 ${acc.status}，跳过` }); continue; }
      if (acc.counted_at) {
        details.push({ id, ok: false, message: `已于 ${acc.counted_at} 计过价，不重复计` });
        continue;
      }
      if (!dryRun) {
        db.prepare('UPDATE dola_accounts SET counted_at=?, updated_at=? WHERE id=?').run(now(), now(), id);
        db.prepare(`INSERT INTO credit_conversions
          (account_id,account_label,credits_used,points_gained,ratio_desc,token_id,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, acc.label, 0, per, ratioDesc, tokenId, req.user.id, now());
        if (tokenId) db.prepare('UPDATE tokens SET points = points + ?, updated_at=? WHERE id=?').run(per, now(), tokenId);
      }
      totalPoints += per;
      converted++;
      details.push({ id, ok: true, label: acc.label, points: per, message: `${acc.label}：1 个账号 → ${per} 积分` });
    }
  } else {
    // ---------- 方式二：按额度计价（需要账号有可查的额度） ----------
    const ratio = Number(req.body?.ratio) || numSetting('dola_credits_per_point', 10);
    if (ratio <= 0) return res.status(400).json({ ok: false, message: '换算比例必须大于 0' });
    ratioDesc = `${ratio} 额度 = 1 积分`;

    for (const id of ids) {
      const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
      if (!acc) { details.push({ id, ok: false, message: '账号不存在' }); continue; }
      if (acc.status !== 'valid') { details.push({ id, ok: false, message: `状态 ${acc.status}，跳过` }); continue; }
      if (acc.credits == null) { details.push({ id, ok: false, message: '还没查到额度，先跑一次「查额度」' }); continue; }

      const usable = Math.max(0, Number(acc.credits) - Number(acc.converted_credits || 0));
      const points = Math.floor(usable / ratio);
      if (points <= 0) {
        details.push({ id, ok: false, message: `可换额度 ${usable} 不足 1 积分（比例 ${ratioDesc}）` });
        continue;
      }
      const used = points * ratio;
      if (!dryRun) {
        db.prepare('UPDATE dola_accounts SET converted_credits = converted_credits + ?, updated_at=? WHERE id=?').run(used, now(), id);
        db.prepare(`INSERT INTO credit_conversions
          (account_id,account_label,credits_used,points_gained,ratio_desc,token_id,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, acc.label, used, points, ratioDesc, tokenId, req.user.id, now());
        if (tokenId) db.prepare('UPDATE tokens SET points = points + ?, updated_at=? WHERE id=?').run(points, now(), tokenId);
      }
      creditsUsed += used;
      totalPoints += points;
      converted++;
      details.push({ id, ok: true, label: acc.label, credits: used, points, message: `${acc.label}：${used} 额度 → ${points} 积分` });
    }
  }

  if (!dryRun && converted) {
    const what = basis === 'account' ? `${converted} 个账号` : `${creditsUsed} 额度`;
    audit(req, 'dola.convert', 'dola_account', ids.join(','),
      `[${basis}] ${converted} 个 → ${totalPoints} 积分（${what}）${tokenId ? `，充到令牌 #${tokenId}` : '，仅记账'}`);
  }

  res.json({
    ok: true,
    basis,
    dryRun,
    ratioDesc,
    pointsPerAccount: basis === 'account' ? (Number(req.body?.pointsPerAccount) || numSetting('dola_points_per_account', 50)) : null,
    ratio: basis === 'credits' ? (Number(req.body?.ratio) || numSetting('dola_credits_per_point', 10)) : null,
    accounts: converted,
    creditsUsed,
    pointsGained: totalPoints,
    tokenId,
    details,
  });
});

/** GET /api/dola/conversions —— 换算流水 */
router.get('/conversions', requirePerm('dola:list'), (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const total = db.prepare('SELECT COUNT(*) AS c FROM credit_conversions').get().c;
  const items = db.prepare(`SELECT c.*, t.prefix AS token_prefix, u.username AS operator
                            FROM credit_conversions c
                            LEFT JOIN tokens t ON t.id = c.token_id
                            LEFT JOIN users u ON u.id = c.created_by
                            ORDER BY c.id DESC LIMIT ? OFFSET ?`)
    .all(Number(pageSize), (Number(page) - 1) * Number(pageSize));
  const summary = db.prepare(`SELECT COUNT(*) AS times,
      COALESCE(SUM(credits_used),0) AS credits, COALESCE(SUM(points_gained),0) AS points
    FROM credit_conversions`).get();
  res.json({ ok: true, items, total, page: Number(page), pageSize: Number(pageSize), summary });
});

export default router;
