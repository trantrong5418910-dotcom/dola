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
import { db, getSetting, setSetting } from '../db.js';
import { requireAuth, requirePerm, signJwt } from '../auth.js';
import { audit } from '../audit.js';
import { createJob, getJob, listJobs, cancelJob, registerJobHandler } from '../jobs.js';
import {
  parseCookies, missingRequired, checkSession, probeCredits,
  fetchCreditsViaBrowser, playwrightAvailable, findCreditFields,
  // ⚠️ 刻意**保留** probeReferenceImageViaBrowser / probeNativeVideoViaBrowser：
  //   它们不只是「能力探测」在用，`/accounts/:id/generation-guard-probe` 解除失败保护
  //   也要靠它们做只读复核 —— 删掉它们，已记录的保护就永远解不开（见 generation-guards.js
  //   里「永久锁」的教训）。同理 dola_accounts 上的 native_*_state / reference_image_state
  //   也要保留：hasGenerationGuard() 在派号时直接 SELECT 这几列判「是否被更晚的探针证伪」。
  fetchProfile, fetchSubscription,
  probeNativeVideoViaBrowser,
  probeReferenceImageViaBrowser,
  looksLikeJsonBlob, DOLA_LOGIN_OPTIONS, DOLA_CODE,
} from '../dola/provider.js';
import { proxyOf, proxyUrlOf } from '../dola/proxy.js';
import { accountHealth, creditBalanceFromHits, quotaObservation, summarizeQuota } from '../dola/account-observations.js';
import { requireGenerationProxy, SUPPORTED_VIDEO_SECONDS } from '../dola/generation-policy.js';
import { sendHelloProbe } from '../dola/hello-probe.js';
import {
  cancelVideoTask, generationStatus, getVideoTask, resolvePendingSubmission, generationRouteView,
  deleteVideoTask, isTaskDeletable,
} from '../dola/generator.js';
import { listPendingSubmissions, listBlockedAccounts, countPendingSubmissions } from '../dola/submission-journal.js';
import { listReferenceImageEntries, REFERENCE_THUMB_SIZE } from '../dola/reference-image-store.js';
import { settleFailedVideoRefund } from '../dola/generation-billing.js';
import { generationAnalytics, classifyFailure } from '../dola/generation-analytics.js';
import { listGenerationGuards, clearGenerationGuard } from '../dola/generation-guards.js';
import { chainTextSnapshot } from '../dola/chain-text-rules.js';
import { accountRotationView } from '../dola/proxy-epoch.js';
import { ALERT_THRESHOLDS, buildAlerts, collectMetrics } from '../metrics.js';
import { submitGenerationTask, GatewayTaskError } from './gateway.js';

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
 * 每日额度重置信息（对标 dola-pool 顶栏「额度重置：Asia/Tokyo 每天 0:00（下次 …）」）。
 *
 * 上游按配置时区的当地时间每日 `dola_quota_reset_hour` 点重置免费额度。
 * 这里只做「下次重置时刻」的计算与展示；quotaObservation 的「今日是否新鲜」
 * 仍沿用 UTC 日界（改动会影响现有测试与统计口径，如需切换再单独做）。
 */
function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
}
/** 把「某时区墙钟时间」换算成 UTC Date（迭代逼近，处理 DST）。 */
function zonedWallToUtc(y, m, d, h, mi, s, tz) {
  const target = Date.UTC(y, m - 1, d, h, mi, s);
  let utc = target;
  for (let i = 0; i < 3; i++) {
    const z = zonedParts(new Date(utc), tz);
    utc += target - Date.UTC(z.y, z.m - 1, z.d, z.h, z.min, z.s);
  }
  return new Date(utc);
}
function quotaResetInfo(at = new Date()) {
  const tz = String(getSetting('dola_quota_reset_tz', 'Asia/Tokyo') || 'Asia/Tokyo').trim() || 'Asia/Tokyo';
  let hour = Number(getSetting('dola_quota_reset_hour', '0'));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = 0;
  let nextResetAt = null;
  try {
    const z = zonedParts(at, tz);
    let { y, m, d } = z;
    const passed = z.h > hour || (z.h === hour && (z.min > 0 || z.s > 0));
    if (passed) {
      const tmp = new Date(Date.UTC(y, m - 1, d) + 86400000);
      y = tmp.getUTCFullYear(); m = tmp.getUTCMonth() + 1; d = tmp.getUTCDate();
    }
    nextResetAt = zonedWallToUtc(y, m, d, hour, 0, 0, tz).toISOString();
  } catch { nextResetAt = null; }
  return { tz, hour, nextResetAt };
}

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

/**
 * Explicit chat probe: one ordinary “你好” message, never part of scheduled maintenance.
 *
 * ★ 2026-09-28：默认改走**纯协议**（`hello-probe.js` 的 `sendHelloProbe`）——
 *   不再开 Chromium、不占浏览器并发、不用等创作输入框（慢代理下要 20~30 秒）。
 *   需要回退时把设置项 `dola_hello_probe_mode` 改成 `browser`。
 *   判定口径两条通道一致：只有「上游明确说会话失效」才允许把账号置 invalid。
 */
registerJobHandler('dola_hello_probe', async (accountId) => {
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(accountId);
  if (!acc) return { ok: false, message: '账号不存在' };
  if (acc.status === 'disabled') return { ok: false, message: '账号已停用，跳过' };
  if (db.prepare("SELECT id FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(accountId)) {
    return { ok: false, message: '账号正在生成，跳过本次发送' };
  }

  const cookies = accountCookies(acc);
  const missing = missingRequired(cookies);
  let result;
  if (missing.length) {
    result = { state: 'unavailable', message: `缺少关键 Cookie：${missing.join(', ')}，未发送` };
  } else {
    const proxyUrl = proxyUrlOf(acc);
    try {
      requireGenerationProxy(proxyUrl);
      result = await sendHelloProbe(cookies, {
        accountId,
        proxyUrl,
        proxy: proxyOf(acc),
        // 默认纯协议；置为 'browser' 即回退到旧的开浏览器实现（见 hello-probe.js 文件头）。
        mode: getSetting('dola_hello_probe_mode', 'pure-http'),
      });
    } catch (error) {
      result = { state: 'unknown', message: `${error.message || '代理不可用'}，未发送` };
    }
  }

  const at = now();
  const loginState = result.state === 'available' ? 'available'
    : result.state === 'unavailable' ? 'unavailable' : 'unknown';
  const nextStatus = result.state === 'available' ? 'valid'
    : result.state === 'unavailable' ? 'invalid' : null;
  const definitive = result.state === 'available' || result.state === 'unavailable';
  const loginFields = definitive ? 'login_state=?, login_at=?, login_note=?,' : '';
  const written = db.prepare(`UPDATE dola_accounts SET status=COALESCE(?,status), ${loginFields}
      last_check_at=?, last_error=?, updated_at=?
    WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'`)
    .run(nextStatus, ...(definitive ? [loginState, at, String(result.message || '').slice(0, 500)] : []), at,
      result.state === 'available' ? '' : String(result.message || '').slice(0, 500), at,
      accountId, acc.cookie_hash, acc.proxy);
  if (!written.changes) return { ok: false, message: '账号信息已更新或已停用，丢弃本次探测结果' };
  return { ok: result.state === 'available', message: result.message || '探测结果未知' };
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
  try {
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
        minSubmitIntervalSec: numSetting('dola_gen_min_submit_interval_sec', 60),
        rateLimitCooldownMin: numSetting('dola_ratelimit_cooldown_min', 30),
        autorotateMaxAttempts: numSetting('dola_autorotate_max_attempts', 3),
        promptCooldownSec: numSetting('gateway_prompt_cooldown_seconds', 120),
      },
      generation: generationStatus(),
      maintenance: getDolaMaintenanceState(),
      codes: DOLA_CODE,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: `读取 provider 信息失败：${describeFetchError(e)}` });
  }
});

router.get('/generation-analytics', requirePerm('dola:list'), (req, res) => {
  try {
    res.json({
      ...generationAnalytics(db, { hours: req.query.hours, timezone: req.query.timezone }),
      guards: listGenerationGuards(db),
      // 上游文本分类计数 + 协议漂移告警（见 dola/chain-text-rules.js）。
      // 放在这个接口是因为这里本来就是「生成统计与复核」的入口，运维不用再找第二个地方。
      chainText: chainTextSnapshot(),
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ ok: false, message: error.message });
    throw error;
  }
});

// 聚合告警（对照参考站 /admin/alerts）：把散落各处的告警信号收成一处。
//
// 为什么需要：协议漂移在 chainText 里、号池容量在 /route 里、代理健康在 proxy-pool 的响应里、
// 任务卡住只有日志里有 —— 排障时要开四个地方对着看，等于没有告警面。
// 这里只做**聚合与判定**，不新增任何数据采集（口径全部来自 metrics.js 的同一份快照，
// 所以 /metrics 与这个接口永远一致）。
router.get('/alerts', requirePerm('dola:list'), (req, res) => {
  try {
    const snapshot = collectMetrics({ db, chainTextSnapshot, generationStatus });
    const alerts = buildAlerts(snapshot);
    res.json({
      ok: true,
      collectedAt: snapshot.collectedAt,
      // 活跃告警放最前，运维一眼看到"现在有没有事"
      active: alerts.filter((a) => a.active),
      alerts,
      thresholds: ALERT_THRESHOLDS,
      metricsEndpoint: '/metrics',
    });
  } catch (error) {
    // ⚠️ 采集失败时**必须**报错，绝不能"没有告警 = 一切正常"地回一个 active:[]。
    //    那会把"我自己坏了"伪装成"系统很健康"，是告警面上最危险的失败模式
    //    （和 /metrics 采集失败返回 500 而不是 200+半份指标同一个道理）。
    console.error('[alerts] 采集失败：', error);
    res.status(500).json({ ok: false, message: `告警采集失败：${error.message}` });
  }
});

// 路由决策（对照参考站 /admin/route）：为什么选这个号、为什么没选那个号。
// 纯读接口，不加任何调度复杂度 —— 但把排障从「翻日志猜」变成「查一次」。
//
// ⚠️ 「出口还能用多久」的补全放在**这里**、而不是 generationRouteView 里面：
//    那个函数被 `test/generator-isolated.mjs` 用"剥掉 import 的源码切片"跑，
//    往它里面加 import 就必须同步改沙箱，否则报错信息会指向调度逻辑
//    （"限流账号应进入冷却"之类），完全看不出是少了沙箱绑定。
function withAccountRotation(view) {
  if (!view || !Array.isArray(view.ranked)) return view;
  let proxyByAccount = new Map();
  try {
    proxyByAccount = new Map(db.prepare('SELECT id, proxy FROM dola_accounts').all()
      .map((a) => [Number(a.id), String(a.proxy || '')]));
  } catch {
    return view;  // 读不到就当没有：这个补充字段不该让整个排障接口挂掉
  }
  return {
    ...view,
    ranked: view.ranked.map((row) => ({
      ...row,
      // ⚠️ `estimate:true` 是诚实的：算出来的到期时间只是**上界**，
      //    `stale` 只表示"该重新探测了"，**不是**"已经轮换"（见 dola/proxy-epoch.js）。
      rotation: accountRotationView({ proxy: proxyByAccount.get(Number(row.id)) }, { database: db }),
    })),
  };
}

router.get('/route', requirePerm('dola:list'), (req, res) => {
  try {
    const seconds = req.query.seconds == null ? null : Number(req.query.seconds);
    if (seconds != null && !SUPPORTED_VIDEO_SECONDS.includes(seconds)) {
      return res.status(400).json({ ok: false, code: 'DURATION_RETIRED', message: 'seconds 仅支持 15 或 30（10 秒与 20 秒档位已下线）' });
    }
    res.json(withAccountRotation(generationRouteView({
      seconds,
      requireReferenceImages: req.query.reference === '1' || req.query.reference === 'true',
      limit: req.query.limit,
    })));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ ok: false, message: error.message });
    throw error;
  }
});

// No retry/unlock override. Only a live, read-only control probe can lift this guard.
const guardProbes = new Set();
router.post('/accounts/:id/generation-guard-probe', requirePerm('dola:check'), async (req, res) => {
  const id = Number(req.params.id), scope = String(req.body.scope || '');
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  const guard = db.prepare('SELECT * FROM dola_generation_guards WHERE account_id=? AND scope=? AND cleared_at IS NULL').get(id, scope);
  if (!acc || !guard) return res.status(404).json({ ok: false, message: '账号或待复核保护项不存在' });
  const active = db.prepare("SELECT 1 FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving') LIMIT 1").get(id);
  if (active || guardProbes.has(id) || acc.status !== 'valid' || !acc.proxy || (acc.cooldown_until && acc.cooldown_until > now())) {
    return res.status(409).json({ ok: false, message: '账号忙碌、无代理、非有效状态或仍在冷却，请先处理后复核' });
  }
  guardProbes.add(id);
  try {
    const options = { timeout: 60000, proxy: proxyOf(acc), proxyUrl: proxyUrlOf(acc) };
    const result = scope === 'reference-images'
      ? await probeReferenceImageViaBrowser(accountCookies(acc), options)
      // ★ 登录防护没有 durations 段，scope.split(':')[1] 会是 NaN —— 必须单独分支。
      //   解除凭据 = 真的拿到创作面板。仍用页面最普遍支持的最短档位（10 秒）去证，
      //   但 10 秒档位已下线，所以必须显式开 allowLegacy —— 这里只借它证明
      //   「页面可用」，不是要提交 10 秒任务。没有这个开关，历史登录防护会永久解不开。
      : scope === 'login'
        ? await probeNativeVideoViaBrowser(accountCookies(acc), { ...options, seconds: 10, allowLegacy: true })
        : await probeNativeVideoViaBrowser(accountCookies(acc), { ...options, seconds: Number(scope.split(':')[1]) });
    const cleared = clearGenerationGuard(db, guard, acc, result, undefined, {
      // 与生成路径**同源**（详见 generation-guards.js 的 clearGenerationGuard 注释）：
      // 30 秒的页面 UI 里没有 30 秒档位，只能靠「短档位载体 + 请求改写」，
      // 所以解锁判据必须读同一对开关。写死"精确目标证据"会让 30 秒变成永久锁。
      // 两个开关都在本文件上方有单一定义（upstreamConcatEnabled / allow30sRewrite），
      // 与 generator.js 用的是同一处（能力探测功能已于 2026-09-28 下线）。
      allowUpstreamConcat: upstreamConcatEnabled(),
      allowCarrierRewrite: allow30sRewrite(),
    });
    audit(req, 'dola.generation_guard_probe', 'dola_account', id, `scope=${scope}; cleared=${cleared}`);
    return res.json({ ok: true, cleared, state: !cleared && result.state === 'available' ? 'unknown' : result.state,
      message: cleared
        ? (scope === 'login'
          ? '只读复核通过：已确认页面处于登录态且创作输入框可用，已解除登录保护；未提交视频，不保证额度或实际成片成功'
          : '只读复核通过，已解除该能力保护；未提交视频，不保证额度或实际成片成功')
        : scope === 'login'
          ? '未确认登录态（创作输入框仍未出现）或账号状态已变化，保留登录保护；未提交视频'
          : result.rewriteCarrier === true ? '只确认了较短时长的页面控件，不能证明目标时长能力；保留失败保护，未提交视频'
            : '未完成能力确认或账号状态已变化，保留保护；未提交视频' });
  } catch {
    return res.status(502).json({ ok: false, message: '只读复核未完成，保护保持生效；未提交视频' });
  } finally { guardProbes.delete(id); }
});

/**
 * POST /api/dola/generation-tasks/batch —— 管理端批量创建生成任务。
 *
 * 走和用户端网关完全同一条链路（submitGenerationTask）：
 * 提示词排重 → 参考图校验 → 账号预检 → 队列限制 → 建任务 → 扣积分 → 失败退款。
 * 逐条顺序提交，单条失败不中断；返回逐条结果。
 *
 * body: { token?: 用户令牌原文, tokenId?: 用户令牌 id（二选一，tokenId 优先）,
 *         items: [{ prompt, mode?, seconds?, ratio? }], points? }
 * points 省略时按后台 gateway_points_per_task 设置扣。
 */
router.post('/generation-tasks/batch', requirePerm('dola:create'), async (req, res) => {
  const rawToken = String(req.body?.token || '').trim();
  const tokenId = req.body?.tokenId != null ? Number(req.body.tokenId) : null;
  let tokenValue = rawToken;
  let tokenMeta = null;
  if (Number.isInteger(tokenId) && tokenId > 0) {
    const row = db.prepare('SELECT id, name, prefix, value, status, points FROM tokens WHERE id = ?').get(tokenId);
    if (!row) return res.status(400).json({ ok: false, message: '所选用户令牌不存在' });
    tokenMeta = { id: row.id, name: row.name, prefix: row.prefix };
    tokenValue = String(row.value || '');
  }
  if (!tokenValue) return res.status(400).json({ ok: false, message: '请提供用户令牌（选择现有令牌或粘贴令牌原文）' });

  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, message: '请至少提供一条提示词' });
  }
  if (items.length > 20) {
    return res.status(400).json({ ok: false, message: '一次最多提交 20 条' });
  }
  const points = req.body?.points != null ? Number(req.body.points) : null;
  if (points != null && (!Number.isInteger(points) || points <= 0)) {
    return res.status(400).json({ ok: false, message: 'points 必须是正整数' });
  }

  // ★ 批量场景下的「共享参考图」：管理端批量弹窗里一次选图、随每条提示词一起提交。
  //   与 v1 单条接口的 `images` 字段同形（[{ dataBase64, name }, …]）。
  //   仅作输入校验（格式/大小/数量），落盘与对象存储上传由 submitGenerationTask → validateReferenceImages 内部走。
  //   不传或空数组 ⇒ 不带图（has_reference_images=0），与单条接口语义一致。
  const rawImages = req.body?.images;
  const sharedImages = Array.isArray(rawImages) ? rawImages : [];

  const results = [];
  for (const item of items) {
    const prompt = String(item?.prompt || '').trim();
    if (!prompt) {
      results.push({ prompt: '', ok: false, error: '提示词为空', code: 'EMPTY_PROMPT' });
      continue;
    }
    try {
      const r = await submitGenerationTask({
        tokenValue,
        prompt,
        mode: item?.mode,
        seconds: item?.seconds,
        ratio: item?.ratio,
        // 复用同一个共享图片数组给每条任务 —— 走与 v1 单条接口同一条 validateReferenceImages 链路
        images: sharedImages,
        accountId: item?.accountId ?? null,
        strictAccount: item?.strictAccount === true,
        points,
      });
      results.push({ prompt, ok: true, taskId: r.taskId, status: r.status, balance: r.balance });
    } catch (e) {
      const diagnostic = e instanceof GatewayTaskError ? e.fields?.diagnostic : null;
      results.push({
        prompt, ok: false,
        error: e.message || '提交失败',
        code: e instanceof GatewayTaskError ? (e.code || null) : 'SUBMIT_ERROR',
        ...(diagnostic ? { diagnostic } : {}),
      });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  audit(req, 'dola.generation.batch', 'dola_video', '', {
    tokenId: tokenMeta?.id ?? null, tokenPrefix: tokenMeta?.prefix ?? null,
    total: items.length, ok: okCount, failed: items.length - okCount,
  });
  res.json({ ok: true, results, okCount, failCount: items.length - okCount });
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
      has_reference_images, reference_image_count,
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
      // 有记录 ≠ 图还在：图是**暂存**的（失败任务留 24 小时，成功/取消即时清）。
      // 所以这两个字段只用来决定「要不要给个入口」，真实可用性由详情接口回报。
      referenceImageCount: Number(row.reference_image_count || 0),
      hasReferenceImages: Boolean(row.has_reference_images),
    })),
  });
});

/** 参考图票据有效期（小时）。10 分钟够渲染一次详情，和 /v1 那边保持一致。 */
const ADMIN_REFERENCE_TICKET_HOURS = 10 / 60;

/**
 * GET /api/dola/generation-tasks/:id/reference-images —— 管理端读取某条任务的参考图。
 *
 * 为什么要在管理端**再开一个**：`/v1/videos/:id/reference-images` 走的是 `requireApiToken`
 * （用户令牌），而后台 SPA 带的是管理员 JWT —— 两个 secret 不同、互不认。后台要用就得
 * 有管理员鉴权的同名能力，否则「生成任务」页签里根本看不到图。
 *
 * 返回的 `url` 用的是 `/v1` 那个取图端点 + 票据：票据即鉴权（绑定 taskId + 文件名），
 * 所以 `<img src>` 直接能用，不必给图片请求也带上 JWT。取图端点的路径穿越防护、
 * 归属校验都在那边，这里只负责列出条目并签票。
 */
router.get('/generation-tasks/:id/reference-images', requirePerm('dola:list'), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: '任务号不合法', code: 'INVALID_TASK_ID' });
  }
  // ⚠️ 单独 SELECT 这两列：getVideoTask() 走 PUBLIC_FIELDS 投影，不含它们（踩过：
  //    直接用投影出来的 row.has_reference_images 恒为 undefined，于是 cleared 永远 false，
  //    前端把「图已被清理」误判成「本来就没带图」）。
  const row = db.prepare(`SELECT id, has_reference_images, reference_image_count, status
    FROM dola_videos WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ ok: false, message: '任务不存在', code: 'TASK_NOT_FOUND' });
  let entries = [];
  try {
    entries = await listReferenceImageEntries(row.id);
  } catch (e) {
    return res.status(500).json({ ok: false, message: `读取参考图失败：${e.message}`, code: 'REFERENCE_IMAGE_READ_FAILED' });
  }
  const ticket = (name) => `/v1/videos/${row.id}/reference-images/${encodeURIComponent(name)}`
    + `?ticket=${signJwt({ rt: row.id, rn: name }, ADMIN_REFERENCE_TICKET_HOURS)}`;
  res.json({
    ok: true,
    task_id: row.id,
    task_status: row.status,
    count: entries.length,
    cleared: entries.length === 0 && Boolean(row.has_reference_images),
    recorded_count: Number(row.reference_image_count || 0),
    expires_in_minutes: Math.round(ADMIN_REFERENCE_TICKET_HOURS * 60),
    items: entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      url: ticket(entry.name),
      // 缩略图（`?w=`）：列表里只铺 92px 的展示位，用原图会把一次弹窗变成 ~20MB 的下载。
      thumb_url: `${ticket(entry.name)}&w=${REFERENCE_THUMB_SIZE}`,
    })),
  });
});

/**
 * GET /api/dola/submissions —— 「未结算提交」核对台
 *
 * 这是本次审计补上的**出口**。背景：`dola_submission_journal` 里处于
 * dispatching / uncertain / acknowledged 的记录，会永久锁住账号
 * （`accountHasUnsettledSubmission`）和提示词（`findUnsettledPrompt`），
 * 而 `closeSubmission` 只接受 rejected/completed 两个终态 ——
 * 等于 **`uncertain` 一旦写入就出不来**，管理端原本也没有任何路由能碰这张表。
 *
 * 触发它又特别容易：holdUncertainSubmission 在 generator.js 有 10 处调用，
 * 连"服务重启"都会命中。
 *
 * 返回**只含元数据 + 哈希**：journal 本来就不存 cookie / 代理凭据 / 提示词
 * （见 submission-journal.js 顶部 schema 注释），所以这里天然不泄漏敏感材料。
 * 查看给 `dola:list`，动它才要 `dola:resolve`。
 */
router.get('/submissions', requirePerm('dola:list'), (req, res) => {
  const pending = listPendingSubmissions(db, { limit: req.query.limit });
  res.json({
    ok: true,
    total: countPendingSubmissions(db),
    blockedAccounts: listBlockedAccounts(db),
    items: pending.map((row) => ({
      taskId: row.task_id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      accountStatus: row.account_status,
      state: row.state,
      evidence: row.evidence,
      conversationId: row.conversation_id,
      sentAt: row.sent_at,
      deadlineAt: row.deadline_at,
      updatedAt: row.updated_at,
      taskStatus: row.task_status,
      taskStage: row.task_stage,
      taskError: row.task_error,
      taskCreatedAt: row.task_created_at,
      tokenId: row.owner_token_id,
      tokenName: row.token_name,
      tokenPrefix: row.token_prefix,
    })),
  });
});

/**
 * POST /api/dola/submissions/:id/resolve —— 处理一条卡住的提交
 *
 * body: { resolution: 'failed' | 'release', note?: string }
 *
 *   - 'failed'  → 确认上游没产出：任务落 failed，**把积分退给用户**（走既有幂等退款）
 *   - 'release' → 放行账号：journal 推到 'released'，账号重新可用，**钱不动**
 *
 * 两者都是显式运维决策，全部写审计日志。这是 `uncertain` 状态唯一的出口，
 * 所以权限用专门的 `dola:resolve`，不跟 `dola:list` 混。
 */
router.post('/submissions/:id/resolve', requirePerm('dola:resolve'), (req, res) => {
  const id = Number(req.params.id);
  const resolution = String(req.body?.resolution || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 200);
  try {
    const result = resolvePendingSubmission(id, { resolution, note });
    audit(req, 'dola.submission_resolve', 'dola_video', String(id),
      `${resolution}; refunded=${result.refunded || 0}${note ? `; note=${note}` : ''}`);
    res.json({ ok: true, ...result, note });
  } catch (e) {
    const status = Number(e?.status) >= 400 && Number(e?.status) < 600 ? Number(e.status) : 400;
    res.status(status).json({ ok: false, message: e?.message || '处理失败' });
  }
});

/**
 * GET /api/dola/operations/summary
 *
 * 8788 的运营面板数据源。它取同一套 dola_accounts / dola_videos / settings，
 * 不再复制 8790 的账号、代理或任务数据。返回值只包含管理视图需要的摘要，
 * 不包含 cookie、完整代理地址或网关密钥。
 */
router.get('/operations/summary', requirePerm('dola:list'), (req, res) => {
  const at = now();
  const day = `${at.slice(0, 10)}T00:00:00.000Z`;
  const accounts = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN status='valid' AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooling,
      SUM(CASE WHEN status='valid' AND (cooldown_until IS NULL OR cooldown_until <= ?) THEN 1 ELSE 0 END) AS idle
    FROM dola_accounts`).get(at, at) || {};
  const today = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status IN ('queued','submitting','generating','resolving') THEN 1 ELSE 0 END) AS active
    FROM dola_videos WHERE created_at >= ?`).get(day) || {};
  const rateLimitHitsToday = Number(db.prepare(
    'SELECT COUNT(*) AS c FROM dola_rate_limit_events WHERE created_at >= ?',
  ).get(day)?.c || 0);
  const status = generationStatus();
  const proxy = proxyExitSummary();
  const coolingAccounts = db.prepare(`SELECT id, label, account_hint, cooldown_until, last_error, last_used_at
    FROM dola_accounts
    WHERE status='valid' AND cooldown_until IS NOT NULL AND cooldown_until > ?
    ORDER BY cooldown_until ASC, id ASC LIMIT 100`).all(at);
  const recentRateLimitEvents = db.prepare(`SELECT e.id, e.code, e.account_id, e.video_id,
      e.cooldown_until, e.detail, e.created_at, a.label AS account_label
    FROM dola_rate_limit_events e
    LEFT JOIN dola_accounts a ON a.id=e.account_id
    ORDER BY e.id DESC LIMIT 30`).all();
  res.json({
    ok: true,
    generatedAt: at,
    accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, Number(v || 0)])),
    today: {
      total: Number(today.total || 0), succeeded: Number(today.succeeded || 0),
      failed: Number(today.failed || 0), cancelled: Number(today.cancelled || 0),
      active: Number(today.active || 0), rateLimitHits: rateLimitHitsToday,
    },
    queue: status,
    proxy,
    settings: {
      minSubmitIntervalSec: numSetting('dola_gen_min_submit_interval_sec', 60),
      rateLimitCooldownMin: numSetting('dola_ratelimit_cooldown_min', 30),
      promptCooldownSec: numSetting('gateway_prompt_cooldown_seconds', 120),
      generationConcurrency: numSetting('dola_gen_concurrency', 1),
      generationQueueLimit: numSetting('dola_gen_queue_limit', 6000),
    },
    coolingAccounts,
    recentRateLimitEvents,
  });
});

/** PUT /api/dola/operations/limits —— 运营面板的限流/队列设置 */
router.put('/operations/limits', requirePerm('dola:update'), (req, res) => {
  const body = req.body || {};
  const ranges = {
    minSubmitIntervalSec: ['dola_gen_min_submit_interval_sec', 0, 600, '同出口提交间隔须为 0～600 秒'],
    rateLimitCooldownMin: ['dola_ratelimit_cooldown_min', 1, 1440, '限流冷却须为 1～1440 分钟'],
    promptCooldownSec: ['gateway_prompt_cooldown_seconds', 0, 3600, '提示词冷却须为 0～3600 秒'],
    generationConcurrency: ['dola_gen_concurrency', 1, 20, '视频并发须为 1～20 的整数'],
    generationQueueLimit: ['dola_gen_queue_limit', 1, 6000, '队列容量须为 1～6000 的整数'],
    autorotateMaxAttempts: ['dola_autorotate_max_attempts', 1, 24, '限流自动换号次数须为 1～24 的整数（1=不换号）'],
  };
  const changed = [];
  for (const [input, [key, min, max, message]] of Object.entries(ranges)) {
    if (!(input in body)) continue;
    const value = Number(body[input]);
    if (!Number.isInteger(value) || value < min || value > max) {
      return res.status(400).json({ ok: false, message });
    }
    setSetting(key, String(value));
    changed.push(key);
  }
  if (!changed.length) return res.status(400).json({ ok: false, message: '没有可保存的运营设置' });
  audit(req, 'dola.operations_limits_update', 'setting', changed.join(','), '更新队列/限流设置');
  res.json({ ok: true, changed });
});

/** POST /api/dola/generation-tasks/:id/cancel —— 管理员取消并按规则处理退款 */
router.post('/generation-tasks/:id/cancel', requirePerm('dola:check'), (req, res) => {
  const row = getVideoTask(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: '生成任务不存在' });
  const active = new Set(['queued', 'submitting', 'generating', 'resolving']);
  if (!active.has(row.status)) return res.status(409).json({ ok: false, message: `当前状态 ${row.status} 不可取消` });
  const before = row.status;
  const updated = cancelVideoTask(row.id);
  const billing = before === 'queued'
    ? settleFailedVideoRefund(db, row, { cancelledBeforeSubmit: true })
    : { refunded: false, points: 0, message: '任务已提交到上游，未退款' };
  audit(req, 'dola.generation_cancel', 'dola_video', String(row.id), `before=${before}; refunded=${billing.points || 0}`);
  res.json({ ok: true, item: updated, refundedPoints: billing.points || 0, billing });
});

/**
 * DELETE /api/dola/generation-tasks/:id —— 删除单条生成任务（成片库，2026-09-27）
 *
 * 只允许删终态（failed / cancelled / ready）。运行中/排队中一律 409，
 * 因为生成器还持有这条任务的引用，删掉会让它写回一个不存在的行。
 */
router.delete('/generation-tasks/:id', requirePerm('dola:task:delete'), async (req, res) => {
  const row = getVideoTask(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: '生成任务不存在' });
  if (!isTaskDeletable(row.status)) {
    return res.status(409).json({
      ok: false, message: `当前状态 ${row.status} 不允许删除（运行中/排队中的任务不能删）`,
    });
  }
  const result = await deleteVideoTask(row.id);
  if (!result?.ok) return res.status(409).json({ ok: false, message: result?.reason || '删除失败' });
  audit(req, 'dola.generation_delete', 'dola_video', String(row.id),
    `status=${row.status}; journal=${result.journalCleared}; file=${result.fileRemoved ? 1 : 0}`);
  res.json({ ok: true, id: row.id, journalCleared: result.journalCleared, fileRemoved: result.fileRemoved });
});

/**
 * POST /api/dola/generation-tasks/batch-delete —— 批量删除，body { ids: [...] }
 *
 * ★ 全有或全无：先在内存里把每一条的状态都查一遍，只要有任何一条是
 *   运行中/排队中，就**整个请求拒绝、一条都不删**。
 *   绝不"能删的先删、删不掉的跳过" —— 那样用户会以为失败的那批也清了。
 */
router.post('/generation-tasks/batch-delete', requirePerm('dola:task:delete'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何任务' });

  const rows = [];
  const blocked = [];
  const missing = [];
  for (const id of ids) {
    const row = getVideoTask(id);
    if (!row) { missing.push(id); continue; }
    rows.push(row);
    if (!isTaskDeletable(row.status)) blocked.push({ id, status: row.status });
  }
  if (blocked.length) {
    return res.status(409).json({
      ok: false,
      message: `有 ${blocked.length} 条任务处于运行中/排队中，不能删除；本次未删除任何任务`,
      blocked,
    });
  }

  const deletedIds = [];
  let journalCleared = 0;
  let fileRemoved = 0;
  for (const row of rows) {
    const r = await deleteVideoTask(row.id);
    if (r?.ok) {
      deletedIds.push(row.id);
      journalCleared += r.journalCleared || 0;
      fileRemoved += r.fileRemoved ? 1 : 0;
    }
  }
  audit(req, 'dola.generation_bulk_delete', 'dola_video', deletedIds.join(','),
    `批量删除 ${deletedIds.length}/${ids.length} 条；journal ${journalCleared}；文件 ${fileRemoved}`);
  res.json({
    ok: true, deleted: deletedIds.length, requested: ids.length,
    skipped: missing.length, missing, journalCleared, fileRemoved, ids: deletedIds,
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
  const { raw = '', items = null, labelPrefix = '', note = '', source = '' } = req.body || {};
  const accountSource = String(source || '').trim().slice(0, 64);
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
    (label,account_hint,cookie,cookie_hash,cookie_names,status,note,source,imported_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

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
        note=COALESCE(NULLIF(?, ''), note),
        source=COALESCE(NULLIF(?, ''), source), updated_at=?
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
        note, accountSource, now(), existByLabel.id);
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
      note, accountSource, req.user.id, now(), now());
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

/**
 * 号池补号提示：根据账号数和已确认剩余额度判断是否需要补号。
 * 任一判据命中即提示：
 *  - 有效账号数 < dola_replenish_min_accounts（默认 5）
 *  - 已确认剩余额度 < dola_replenish_min_quota（默认 30；设 0 关闭额度判据）
 * 另有软提示：有可用账号但没有任何账号确认过今日额度 → 建议先批量查额度。
 */
function replenishAdvice(summary) {
  const minAccounts = Math.max(1, Math.round(numSetting('dola_replenish_min_accounts', 5)));
  const rawQuota = Number(getSetting('dola_replenish_min_quota', '30'));
  const minQuota = Number.isFinite(rawQuota) && rawQuota >= 0 ? Math.round(rawQuota) : 30;
  const validCount = Number(summary.valid || 0);
  const quotaKnown = Number(summary.quotaKnown || 0);
  const quotaRemaining = summary.quotaRemaining;
  const reasons = [];
  if (validCount < minAccounts) {
    reasons.push(`有效账号只有 ${validCount} 个，低于阈值 ${minAccounts} 个`);
  }
  if (quotaKnown > 0 && Number.isFinite(quotaRemaining) && quotaRemaining < minQuota) {
    reasons.push(`已确认剩余额度只有 ${quotaRemaining}，低于阈值 ${minQuota}`);
  }
  const quotaCheckHint = reasons.length === 0 && validCount > 0 && quotaKnown === 0;
  return {
    needReplenish: reasons.length > 0,
    reasons,
    quotaCheckHint,
    validCount,
    quotaRemaining: Number.isFinite(quotaRemaining) ? quotaRemaining : null,
    quotaKnown,
    minAccounts,
    minQuota,
  };
}

/** GET /api/dola/accounts */
router.get('/accounts', requirePerm('dola:list'), (req, res) => {
  const { page = 1, pageSize = 20, keyword = '', status = '', group = '', source = '' } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(label LIKE ? OR note LIKE ? OR sec_user_id LIKE ? OR account_hint LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where.push('status = ?'); params.push(status); }
  if (group) { where.push('group_name = ?'); params.push(group); }
  if (source) { where.push('source = ?'); params.push(source); }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM dola_accounts${w}`).get(...params).c;
  const items = db.prepare(`SELECT * FROM dola_accounts${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  const validExitCounts = new Map(db.prepare(`SELECT TRIM(exit_ip) AS exit_ip, COUNT(*) AS c
      FROM dola_accounts
      WHERE status='valid' AND TRIM(COALESCE(exit_ip,'')) <> ''
      GROUP BY TRIM(exit_ip)`).all().map((row) => [row.exit_ip, Number(row.c)]));
  const loginProfiles = new Map(db.prepare('SELECT id,email,account_id FROM dola_login_profiles WHERE account_id IS NOT NULL')
    .all().map(row => [row.account_id, { accountCode: `A${String(row.id).padStart(2, '0')}`, loginEmail: row.email }]));
  const publicItems = items.map((row) => {
    const exitIp = String(row.exit_ip || '').trim();
    return {
      ...toRow(row),
      ...(loginProfiles.get(row.id) || {}),
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
  const quotaRows = db.prepare(`SELECT status,cooldown_until,quota_remaining,quota_total,quota_at,quota_source FROM dola_accounts`).all();
  Object.assign(summary, summarizeQuota(quotaRows));
  // 满额 / 半额：只统计「有效、未冷却、额度已确认」的账号。
  // 满额 = 剩余额度 >= 每日总额；半额 = 有剩余但没满。
  const at = now();
  let fullQuota = 0, halfQuota = 0;
  for (const r of quotaRows) {
    if (r.status !== 'valid') continue;
    if (r.cooldown_until && r.cooldown_until > at) continue;
    const obs = quotaObservation(r, at);
    if (obs.state !== 'confirmed') continue;
    const total = Number(r.quota_total) || 0;
    if (total > 0 && obs.remaining >= total) fullQuota++;
    else if (obs.remaining > 0) halfQuota++;
  }
  Object.assign(summary, {
    fullQuota,
    halfQuota,
    // 剩余额度可出条数：按 15 秒档 2 点/条估算（与用户选择的 2 额度档一致）。
    quotaVideos: {
      pointsPerVideo: 2,
      producible: summary.quotaRemaining != null ? Math.floor(summary.quotaRemaining / 2) : null,
    },
    groups: db.prepare(`SELECT DISTINCT group_name AS g FROM dola_accounts WHERE group_name <> '' ORDER BY g`).all().map((r) => r.g),
    sources: db.prepare(`SELECT DISTINCT source AS s FROM dola_accounts WHERE source <> '' ORDER BY s`).all().map((r) => r.s),
    quotaReset: quotaResetInfo(),
  });
  Object.assign(summary, proxyExitSummary());
  Object.assign(summary, { replenish: replenishAdvice(summary) });

  res.json({ ok: true, items: publicItems, total, page: Number(page), pageSize: Number(pageSize), summary });
});

/**
 * GET /api/dola/accounts/:id/reveal —— 看完整 cookie（写审计）
 *
 * 权限必须是 `dola:reveal`，**不是** `dola:list`。
 * 踩过的坑：这里原本只要 `dola:list`（语义「查看 dola 账号」），却返回完整 cookie。
 * cookie 等于账号的完全控制权 —— 能直接去上游提交生成、把额度烧光。
 * 同文件里连改时长都要 `dola:update`，导出凭据却只要「查看」，粒度是反的。
 */
router.get('/accounts/:id/reveal', requirePerm('dola:reveal'), (req, res) => {
  const r = db.prepare('SELECT id,label,cookie FROM dola_accounts WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ ok: false, message: '账号不存在' });
  audit(req, 'dola.reveal', 'dola_account', r.id, r.label);
  res.json({ ok: true, id: r.id, label: r.label, cookie: r.cookie });
});

/** POST /api/dola/accounts/:id/probe —— 对单个账号跑一次额度接口探测（排查用） */
router.post('/accounts/:id/probe', requirePerm('dola:check'), async (req, res) => {
  try {
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
  } catch (e) {
    // Express 4 不捕获 async 抛错，不包 try/catch 请求会永久悬挂
    return res.status(502).json({ ok: false, message: `探测失败：${describeFetchError(e)}` });
  }
});

/**
 * 30 秒的探测允许走「上游合成」档位（页面自己把某档标成 `30s (15s ×2)`）。
 * 这条路径只在设置 dola_upstream_concat=true 时才认，见 upstreamConcatEnabled()。
 */
const upstreamConcatEnabled = () => boolSetting('dola_upstream_concat', false);

/**
 * 30 秒「短档位载体 + 请求改写」通道（默认关 = 现行为）。
 *
 * 探针必须和生成路径读同一套口径：`dola_allow_30s_rewrite` 决定判据是否接受
 * 「页面真实存在的更短载体」，`dola_duration_carrier_map` 决定具体用哪个档位。
 * 两者与 generator.js 里的同名开关一一对应 —— 只改一边就会出现
 * 「探针把号记成 available、生成时却选不到档位」这种最难查的不一致。
 */
const allow30sRewrite = () => boolSetting('dola_allow_30s_rewrite', false);
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
 *
 * 权限用 `dola:update` 而不是 `dola:list`：这是个**带出站请求**的动作
 * （会经指定代理去访问 ipinfo.io），语义上属于「配置/操作」而非「查看」，
 * 不该给只读角色。
 */
router.post('/accounts/proxy/verify', requirePerm('dola:update'), async (req, res) => {
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

/**
 * POST /api/dola/accounts/:id/proxy/verify-persist —— 核验账号当前代理并写回出口 IP
 *
 * 与 /accounts/proxy/verify 的区别：verify 只测不存（配代理前预检用），
 * 这个是给「已配置代理但 exit_ip 为空」的账号补核验：测到出口 IP 就写进 exit_ip，
 * 列表的「待核验」状态才会更新。不改代理本身，不重配 SID。
 */
router.post('/accounts/:id/proxy/verify-persist', requirePerm('dola:update'), async (req, res) => {
  const id = Number(req.params.id);
  const acc = db.prepare('SELECT id, label, proxy FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });
  const proxy = String(acc.proxy || '').trim();
  if (!proxy) return res.status(400).json({ ok: false, message: '该账号未配置代理' });
  try {
    const { fetchVia } = await import('../dola/proxy.js');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('代理探测超时 20s')), 20000);
    try {
      const r = await fetchVia('https://ipinfo.io/json', { signal: ctrl.signal }, proxy);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ip) return res.json({ ok: false, status: r.status, ip: j.ip ?? null, message: '出口检测失败' });
      db.prepare('UPDATE dola_accounts SET exit_ip=?, updated_at=? WHERE id=?')
        .run(String(j.ip), now(), id);
      audit(req, 'dola.verify_proxy', 'dola_account', id, `${acc.label} 核验出口 ${j.ip}（${j.country || ''}${j.city || ''}）`);
      res.json({ ok: true, ip: j.ip, country: j.country ?? null, region: j.region ?? null, city: j.city ?? null });
    } finally { clearTimeout(timer); }
  } catch (e) {
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
  // 长耗时路由：import 和后续网络/DB 操作都可能抛错，Express 4 不捕获 async 抛错，不包 try/catch 请求会永久悬挂
  try {
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
  } catch (e) {
    return res.status(502).json({ ok: false, message: `代理分配失败：${describeFetchError(e)}` });
  }
});

/** POST /api/dola/accounts/:id/action  { action: disable|enable|check|credits } */
/** 单账号动作的权限表：只读类动作 dola:check 即可，修改类动作要 dola:update。
 * reset_counted 是换算流程的纠错动作，dola:convert 也可操作。未知动作默认要 dola:update（与原来一致）。 */
const ACCOUNT_ACTION_PERMS = {
  check: ['dola:check', 'dola:update'],
  credits: ['dola:check', 'dola:update'],
  hello_probe: ['dola:create'],
  reset_counted: ['dola:convert', 'dola:update'],
  disable: ['dola:update'],
  enable: ['dola:update'],
  set_credits: ['dola:update'],
  set_group: ['dola:update'],
  recover: ['dola:update'],
  reset_quota: ['dola:update'],
};
const hasAnyPerm = (req, codes) => {
  const perms = req.user?.permissions || [];
  return perms.includes('*') || codes.some((c) => perms.includes(c));
};
router.post('/accounts/:id/action', requireAuth, async (req, res) => {
  const action = String(req.body?.action || '');
  const allowed = ACCOUNT_ACTION_PERMS[action] || ['dola:update'];
  if (!hasAnyPerm(req, allowed)) {
    return res.status(403).json({ ok: false, message: `没有权限：${allowed.join(' / ')}` });
  }
  const id = Number(req.params.id);
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });

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

  if (action === 'hello_probe') {
    const active = db.prepare("SELECT id FROM jobs WHERE type='dola_hello_probe' AND status IN ('queued','running') LIMIT 1").get();
    if (active) return res.status(409).json({ ok: false, message: `你好探测任务 #${active.id} 正在运行` });
    const job = createJob({ type: 'dola_hello_probe', ids: [id], concurrency: 1, userId: req.user.id });
    audit(req, 'dola.hello_probe', 'job', job.id, `单账号普通聊天探测：${acc.label}`);
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

  /** 设置账号分组（运营自定，最长 32 字；空字符串 = 移出分组） */
  if (action === 'set_group') {
    const group = String(req.body?.group ?? '').trim().slice(0, 32);
    db.prepare('UPDATE dola_accounts SET group_name=?, updated_at=? WHERE id=?').run(group, now(), id);
    audit(req, 'dola.set_group', 'dola_account', id, `${acc.label} 分组「${acc.group_name || '未分组'}」→「${group || '未分组'}」`);
    return res.json({ ok: true, group });
  }

  /**
   * 手动解除限流冷却（对标 dola-pool「批量恢复」）。
   * 只清 cooldown_until + last_error，不动 status —— 账号本身没坏过，
   * 冷却只是「暂时别用它」。会写审计。
   */
  if (action === 'recover') {
    if (!acc.cooldown_until) return res.status(400).json({ ok: false, message: '该账号不在冷却中' });
    db.prepare('UPDATE dola_accounts SET cooldown_until=NULL, last_error=?, updated_at=? WHERE id=?')
      .run('', now(), id);
    audit(req, 'dola.recover', 'dola_account', id, `${acc.label} 手动解除冷却（原冷却至 ${acc.cooldown_until}）`);
    return res.json({ ok: true });
  }

  /**
   * 重置每日额度（对标 dola-pool「重置额度」）。
   * 把 quota_remaining 拨回 quota_total，来源记 manual_reset。
   * 注意：这只是本地记录的拨回，不代表上游真的重置了 —— 跨天后以生成回执为准。
   */
  if (action === 'reset_quota') {
    const total = Number(acc.quota_total) || 0;
    db.prepare(`UPDATE dola_accounts SET quota_remaining=?, quota_at=?, quota_source='manual_reset', updated_at=? WHERE id=?`)
      .run(total, now(), now(), id);
    audit(req, 'dola.reset_quota', 'dola_account', id, `${acc.label} 重置额度 ${acc.quota_remaining ?? '-'} → ${total}（手动重置）`);
    return res.json({ ok: true, quota_remaining: total });
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

/**
 * POST /api/dola/accounts/batch-group —— 批量设置分组 {ids:[], group:''}
 * 空字符串 = 移出分组。
 */
router.post('/accounts/batch-group', requirePerm('dola:update'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何账号' });
  const group = String(req.body?.group ?? '').trim().slice(0, 32);
  const stmt = db.prepare('UPDATE dola_accounts SET group_name=?, updated_at=? WHERE id=?');
  let updated = 0;
  for (const id of ids) updated += stmt.run(group, now(), id).changes;
  audit(req, 'dola.bulk_set_group', 'dola_account', ids.join(','), `批量分组 →「${group || '未分组'}」（${updated} 个）`);
  res.json({ ok: true, updated, group });
});

/**
 * POST /api/dola/accounts/batch-recover —— 批量解除限流冷却 {ids:[]}
 * 对标 dola-pool「批量恢复」。只清 cooldown_until + last_error，不动 status。
 */
router.post('/accounts/batch-recover', requirePerm('dola:update'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何账号' });
  const stmt = db.prepare(`UPDATE dola_accounts SET cooldown_until=NULL, last_error='', updated_at=?
    WHERE id=? AND cooldown_until IS NOT NULL`);
  let updated = 0;
  for (const id of ids) updated += stmt.run(now(), id).changes;
  audit(req, 'dola.bulk_recover', 'dola_account', ids.join(','), `批量解除冷却 ${updated} 个`);
  res.json({ ok: true, updated, skipped: ids.length - updated });
});

/**
 * POST /api/dola/accounts/batch-reset-quota —— 批量重置每日额度 {ids:[]}
 * 对标 dola-pool「重置额度」。quota_remaining 拨回 quota_total，来源记 manual_reset。
 */
router.post('/accounts/batch-reset-quota', requirePerm('dola:update'), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有选中任何账号' });
  const stmt = db.prepare(`UPDATE dola_accounts SET quota_remaining=quota_total, quota_at=?, quota_source='manual_reset', updated_at=? WHERE id=?`);
  let updated = 0;
  for (const id of ids) updated += stmt.run(now(), now(), id).changes;
  audit(req, 'dola.bulk_reset_quota', 'dola_account', ids.join(','), `批量重置额度 ${updated} 个`);
  res.json({ ok: true, updated });
});

/**
 * POST /api/dola/accounts/:id/test-generate —— 单账号测试生成（对标 dola-pool「测试生成」）
 * body: { tokenId?, token?, prompt?, seconds?, images? }
 *
 * ⚠️ 会消耗真实额度和用户令牌积分。走网关链路（A 方案），任务强制绑定该账号
 * （strictAccount=true），不触发自动换号 —— 测的就是这个号本身。
 *
 * images（2026-09-29 新增）：参考图 base64 数组 [{ dataBase64, name }]，可选。
 * 直接透传给网关链路 —— 张数/体积/格式校验都在 validateReferenceImages 里做
 * （最多 9 张、合计 20MB），这里**不重复造一套规则**，避免两处口径不一致。
 * 测「这个号」时常常就是要测「这个号出不出得来带参考图的片子」，缺了这字段
 * 用户只能去工作台建一条不锁号的任务碰运气。
 */
router.post('/accounts/:id/test-generate', requirePerm('dola:create'), async (req, res) => {
  const id = Number(req.params.id);
  const acc = db.prepare('SELECT id, label, status FROM dola_accounts WHERE id=?').get(id);
  if (!acc) return res.status(404).json({ ok: false, message: '账号不存在' });

  const tokenId = req.body?.tokenId != null ? Number(req.body.tokenId) : null;
  let tokenValue = String(req.body?.token || '').trim();
  if (Number.isInteger(tokenId) && tokenId > 0) {
    const row = db.prepare('SELECT value FROM tokens WHERE id=?').get(tokenId);
    if (!row) return res.status(400).json({ ok: false, message: '所选用户令牌不存在' });
    tokenValue = String(row.value || '');
  }
  if (!tokenValue) return res.status(400).json({ ok: false, message: '请提供用户令牌（测试生成走网关链路扣积分）' });

  // 档位精简：非法/缺失一律落 30（主档位）。10/20 已下线，不再有 10 秒兜底。
  const seconds = SUPPORTED_VIDEO_SECONDS.includes(Number(req.body?.seconds)) ? Number(req.body.seconds) : 30;
  const prompt = String(req.body?.prompt || '').trim().slice(0, 500) || `测试生成（账号 ${acc.label || id}，${seconds} 秒）`;
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  try {
    const r = await submitGenerationTask({
      tokenValue, prompt, seconds, images,
      accountId: id, strictAccount: true,
    });
    audit(req, 'dola.test_generate', 'dola_account', id,
      `${acc.label} 测试生成 ${seconds}s，任务 ${r.taskId}${images.length ? `，参考图 ${images.length} 张` : ''}`);
    res.json({ ok: true, taskId: r.taskId, status: r.status });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, message: e.message || '提交失败', code: e.code || null });
  }
});

/**
 * POST /api/dola/stress-test —— 压力测试（对标 dola-pool「压力测试」）
 * body: { tokenId?, token?, count, seconds?, prompt? }
 *
 * ⚠️ 会消耗真实额度和用户令牌积分：count 条任务按顺序提交进队列，
 * 由生成编排器按并发设置消费。不绑定账号，走正常选号+限流换号链路，
 * 测的是整个号池的吞吐。count 上限 20（与批量创建一致）。
 */
router.post('/stress-test', requirePerm('dola:create'), async (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    return res.status(400).json({ ok: false, message: '压测数量须为 1～20 的整数' });
  }
  const tokenId = req.body?.tokenId != null ? Number(req.body.tokenId) : null;
  let tokenValue = String(req.body?.token || '').trim();
  if (Number.isInteger(tokenId) && tokenId > 0) {
    const row = db.prepare('SELECT value FROM tokens WHERE id=?').get(tokenId);
    if (!row) return res.status(400).json({ ok: false, message: '所选用户令牌不存在' });
    tokenValue = String(row.value || '');
  }
  if (!tokenValue) return res.status(400).json({ ok: false, message: '请提供用户令牌（压力测试走网关链路扣积分）' });

  // 档位精简：非法/缺失一律落 30（主档位）。10/20 已下线，不再有 10 秒兜底。
  const seconds = SUPPORTED_VIDEO_SECONDS.includes(Number(req.body?.seconds)) ? Number(req.body.seconds) : 30;
  const promptBase = String(req.body?.prompt || '').trim().slice(0, 200) || '压力测试';
  const results = [];
  for (let i = 0; i < count; i++) {
    const prompt = `${promptBase} #${i + 1}/${count}`;
    try {
      const r = await submitGenerationTask({ tokenValue, prompt, seconds, images: [] });
      results.push({ ok: true, taskId: r.taskId, status: r.status });
    } catch (e) {
      results.push({ ok: false, error: e.message || '提交失败' });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  audit(req, 'dola.stress_test', 'dola_video', '', `压力测试提交 ${count} 条（${seconds}s），成功 ${okCount}`);
  res.json({ ok: true, results, okCount, failCount: count - okCount });
});

// ================================================================ 任务

/** POST /api/dola/jobs  { type, ids? | all:true, concurrency? } */
router.post('/jobs', (req, res, next) => {
  const needed = req.body?.type === 'dola_hello_probe' ? ['dola:create'] : ['dola:check'];
  if (!hasAnyPerm(req, needed)) return res.status(403).json({ ok: false, message: `没有权限：${needed.join(' / ')}` });
  next();
}, (req, res) => {
  const type = String(req.body?.type || '');
  const helloProbe = type === 'dola_hello_probe';
  if (!['dola_check', 'dola_credits', 'dola_hello_probe'].includes(type)) {
    return res.status(400).json({ ok: false, message: `不支持的任务类型：${type}` });
  }
  if (helloProbe) {
    const active = db.prepare("SELECT id FROM jobs WHERE type='dola_hello_probe' AND status IN ('queued','running') LIMIT 1").get();
    if (active) return res.status(409).json({ ok: false, message: `你好探测任务 #${active.id} 正在运行` });
  }
  let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (req.body?.all) {
    const statusFilter = type === 'dola_credits' ? "status IN ('valid','unknown')" : "status <> 'disabled'";
    ids = db.prepare(`SELECT id FROM dola_accounts WHERE ${statusFilter} ORDER BY id`).all().map((r) => r.id);
  }
  if (!ids.length) return res.status(400).json({ ok: false, message: '没有要处理的对象' });

  // 浏览器通道很吃内存，并发单独限
  const defaultConc = (type === 'dola_credits' && getSetting('dola_use_browser', 'false') === 'true'
    ? numSetting('dola_browser_concurrency', 3)
    : numSetting('dola_check_concurrency', 5));

  const job = createJob({
    type,
    ids,
    // ⚠️ hello_probe 虽已是纯协议通道，并发仍刻意锁 1：同一个出口并发打 /chat/completion
    //    更容易吃 710022002，放开前必须做「并发 × 710022002 命中率」实测。
    concurrency: helloProbe ? 1 : (Number(req.body?.concurrency) || defaultConc),
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
