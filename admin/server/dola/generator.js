/**
 * dola 视频生成编排器（服务端常驻版）。
 *
 * 把 verify-flow.mjs 里那套已验证的流程搬到服务里，并补上「无水印解析」：
 *
 *   queued → submitting（开浏览器提交，拿到 conversationId，**立刻关浏览器**）
 *          → generating（纯 HTTP 轮询 /im/chain/single 等成片）
 *          → resolving（发现 fallback_api，解析无水印直链）
 *          → ready / failed / cancelled
 *
 * 三个踩过的关键点，别再犯：
 *   ① **提交完必须立刻关浏览器**。用 page.reload() 循环等结果的做法会踢掉会话
 *      （每次开浏览器在风控眼里像"换设备登录"），而且 SPA 重载根本拿不到新消息。
 *   ② 轮询只走 `/im/chain/single`。它不需要 a_bogus，纯 HTTP 就够。
 *   ③ 无水印解析**单独一步、允许失败**：失败时保留带水印直链兜底，
 *      绝不因为解析不出来就把整条任务判死 —— 用户拿不到无水印，至少还能拿到成片。
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { db, getSetting } from '../db.js';
import { parseCookies, getPlaywright, fetchProfile, probeNativeVideoViaBrowser, DOLA_HEADERS } from './provider.js';
import { pullChain, extractUnwatermarked } from './unwatermark.js';
import { proxyOf } from './proxy.js';
import { startSocksBridge } from './socks-bridge.js';
import { parseVideoQuotaReceipt } from './account-observations.js';
import { settleFailedVideoRefund } from './generation-billing.js';
import { hasGenerationGuard, recordGenerationGuard } from './generation-guards.js';
import { installVideoRequestAdapter } from './generation-request.js';
import { prepareNativeVideoComposer, prepareReferenceImageComposer } from './native-capability.js';
import { observeVideoComposerBootstrap } from './composer-bootstrap.js';
import { fillAndSubmitVideoPrompt } from './generation-submit.js';
import { submitViaSchemeA, resolveSubmitMode } from './scheme-a.js';
import { createGenerationWireGate } from './generation-wire.js';
import { resolveFfprobePath, probeMp4ContainerDuration } from './media-probe.js';
import { identifyGenerationRequest, createGenerationAckObserver } from './generation-ack.js';
import { getSubmission, recordSubmissionDispatch, recordSubmissionConversation, holdUncertainSubmission,
  closeSubmission, settleRejectedSubmission, accountHasUnsettledSubmission, canRecoverSubmission,
  releaseSubmission, PENDING_SUBMISSION_STATES } from './submission-journal.js';
import { listReferenceImages, cleanupReferenceImages } from './reference-image-store.js';
import {
  normalizeVideoDuration, requireGenerationProxy, hasLiveSession,
  isActiveGenerationStatus, validateArchivedVideo, hasConfirmedZeroVideoQuota, isVerifiedNativeCapability,
} from './generation-policy.js';

const now = () => new Date().toISOString();
const execFileAsync = promisify(execFile);
const num = (k, d) => {
  const v = Number(getSetting(k, String(d)));
  return Number.isFinite(v) && v > 0 ? v : d;
};

/**
 * 归档目录：admin/server/data/videos
 *
 * ⚠️ 必须用 fileURLToPath，不能 `new URL(import.meta.url).pathname` ——
 * 后者不做百分号解码，路径里只要有中文/空格就变成 `%E6%96%B0%E7%BD%91%E7%AB%99`，
 * 归档直接写失败（本项目目录就叫「新网站」，实测踩到）。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.join(HERE, '..', 'data', 'videos');

/**
 * 浏览器持久化 profile 目录（每账号一个）。
 *
 * ## 为什么必须用持久化 profile（实测数据说话）
 *
 * 一次生成要拉 **516 个请求 / 约 12 MB**，其中：
 *   Script      10.17 MB（84%）  ← 应用的 JS 包
 *   Stylesheet   0.69 MB（6%）
 *   XHR          0.54 MB（4%）   ← 真正的业务流量
 *   Image        0.18 MB（1%）
 *
 * JS 包**拦不得**（拦了页面跑不起来），所以唯一省法就是**让它命中 HTTP 缓存**。
 * 持久化 profile 把缓存留在磁盘上，从第二次生成开始 JS/CSS 直接走本地 ——
 * 代理流量能从 ~12 MB 掉到 1 MB 量级，而住宅代理是按 GB 计费的。
 *
 * 顺带拦掉 image/font/media（实测只省 1%，但白省）。
 *
 * ⚠️ profile 会占磁盘：按只缓存 JS/CSS 估算，单账号约 30~80 MB。
 *    上千账号要定期清理（见 scripts/clean-profiles.mjs 与 README 的运维说明）。
 */
const PROFILE_ROOT = path.join(HERE, '..', 'data', 'browser-profiles');

/** 同一账号同一时刻只允许一个浏览器（profile 目录不能并发用） */
const ACCOUNT_LOCKS = new Set();

/**
 * 选号阶段的短暂 reservation。
 *
 * createVideoTask 会先做一次真实会话体检，这段异步等待会让多个并发
 * HTTP 请求同时看到同一个“最久未使用”账号。reservation 在体检前就占住
 * 账号，体检失败或建任务失败会释放；任务落库后立即释放，因为真正的
 * 长生命周期隔离由下面的账号执行队列负责。
 */
const ACCOUNT_SELECTION_RESERVATIONS = new Set();

/** 同一账号的生成全流程串行；不同账号可在全局并发上限内并行。 */
const ACCOUNT_RUN_TAILS = new Map();
let accountWaiters = 0;

// ---------------------------------------------------------------- 任务表读写

const PUBLIC_FIELDS = `
  id, account_id, account_label, conversation_id, prompt, ratio, seconds, force_seconds,
  status, stage, watermarked_url, unwatermarked_url, unwatermark_note, is_unwatermarked,
  local_path, local_bytes,
  duration_sec, bytes, error, owner_token_id, owner_prefix, charge_ref,
  created_at, updated_at, finished_at
`;

/** 对外的任务视图。**优先给无水印 URL** —— 这是我们花额外功夫解析出来的成果。 */
export function toPublic(row) {
  if (!row) return null;
  return {
    ...row,
    ready: row.status === 'ready',
    // 前端只用这一个字段就够了：有就用无水印，没有就退回带水印（并在 note 里说明）
    url: row.unwatermarked_url || row.watermarked_url || null,
    isUnwatermarked: Boolean(row.is_unwatermarked),
    watermarkStatus: row.is_unwatermarked ? 'unwatermarked' : (row.watermarked_url ? 'watermarked' : 'unknown'),
    watermarkedUrl: row.watermarked_url || null,
    unwatermarkedUrl: row.unwatermarked_url || null,
    /** 已归档到本地（TOS 直链会过期，归档过的才是长期可靠的） */
    archived: Boolean(row.local_path),
  };
}

/**
 * 把成片抓回本地归档。
 *
 * 为什么必须做：`.../video/tos/...` 是**带签名的临时链接**（URL 里有 dy_q 过期时间戳），
 * 几小时到几天后就 403。如果不归档，用户隔天点"下载"只会拿到一个死链，
 * 而我们已经在解析无水印上花了功夫 —— 白费。
 *
 * 有无水印直链时选择它，否则选择带水印直链；下载失败不自动切换来源。
 * 归档和真实时长校验都是成功条件；只有临时直链不能标记 ready。
 */
async function archiveVideo(id, { unwatermarkedUrl, watermarkedUrl }) {
  const src = unwatermarkedUrl || watermarkedUrl;
  if (!src) return null;

  const dir = path.resolve(VIDEO_DIR);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${id}${unwatermarkedUrl ? '-nowatermark' : ''}.mp4`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('归档超时')), 5 * 60_000);
  try {
    if (!taskActive(id)) return null;
    // Signed public media only: direct download without account cookies/auth headers
    // avoids charging large files to IPWeb. Account/auth/generation calls still use proxy.
    const res = await fetch(src, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`文件太小（${buf.length} 字节），可能不是视频`);
    if (!taskActive(id)) return null;
    await fs.writeFile(dest, buf);
    return { path: dest, bytes: buf.length };
  } catch {
    console.warn(`[gen] #${id} 归档失败，未通过交付验收`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取归档文件的真实时长。
 *
 * 请求里的 duration 只是意图，Dola 回执里的文案也可能与实际媒体不一致；
 * 必须能无错误地读取视频帧，不能仅凭容器 duration 接受损坏媒体。
 * 返回 { seconds, status }：ok=逐帧读取成功；tool_missing=ffprobe 不可用
 * （工具链问题，不是文件问题）；unreadable=文件不可读或已损坏。
 * 区分后两者，避免把已下好的好片误判为失败。
 */
async function probeVideoDuration(filePath) {
  let ffprobe;
  try {
    ffprobe = await resolveFfprobePath();
  } catch {
    return { seconds: null, status: 'tool_missing' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height,nb_read_frames:format=duration',
      '-of', 'json',
      filePath,
    ], { timeout: 30_000, maxBuffer: 16 * 1024 });
    if (String(stderr || '').trim()) return { seconds: null, status: 'unreadable' };
    const probe = JSON.parse(stdout);
    const readableVideo = Array.isArray(probe?.streams) && probe.streams.some(stream => {
      const frames = Number(stream?.nb_read_frames);
      return stream?.codec_type === 'video'
        && Number.isInteger(stream.width) && stream.width > 0
        && Number.isInteger(stream.height) && stream.height > 0
        && ['string', 'number'].includes(typeof stream.nb_read_frames)
        && Number.isSafeInteger(frames) && frames > 0;
    });
    if (!readableVideo || !['string', 'number'].includes(typeof probe?.format?.duration)) {
      return { seconds: null, status: 'unreadable' };
    }
    const seconds = Number(probe.format.duration);
    return Number.isFinite(seconds) && seconds > 0
      ? { seconds, status: 'ok' }
      : { seconds: null, status: 'unreadable' };
  } catch {
    return { seconds: null, status: 'unreadable' };
  }
}

/** 取归档文件路径（给网关的流式下载用）；文件不在磁盘上则返回 null */
export function localFileOf(row) {
  if (!row?.local_path) return null;
  return row.local_path;
}

export function getVideoTask(id) {
  return db.prepare(`SELECT ${PUBLIC_FIELDS} FROM dola_videos WHERE id = ?`).get(Number(id));
}

export function listVideoTasks({ ownerTokenId = null, limit = 20, status = null } = {}) {
  const where = [];
  const args = [];
  if (ownerTokenId != null) { where.push('owner_token_id = ?'); args.push(ownerTokenId); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT ${PUBLIC_FIELDS} FROM dola_videos
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 20, 200));
}

/** Never resubmit interrupted work. Only a correlated, identity-bound receipt
 * permits read-only polling recovery; ambiguous legacy work stays for review.
 */
export function recoverStaleVideoTasks() {
  const interrupted = db.prepare("SELECT * FROM dola_videos WHERE status IN ('queued','submitting','generating','resolving')").all();
  for (const row of interrupted) {
    const receipt = getSubmission(db, row.id);
    if (receipt?.state === 'rejected') {
      fail(row.id, '已记录上游拒绝；服务重启后完成失败结算，不重新提交');
    } else if (row.status === 'queued' && !receipt && !row.conversation_id) {
      fail(row.id, '服务重启导致未提交的排队任务中断');
    } else {
      const account = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(row.account_id);
      if (canRecoverSubmission(receipt, row, account)) scheduleSubmissionRecovery(row.id);
      else holdUncertainSubmission(db, row.id, '服务重启；上游结果或原会话身份待核对，不会重新提交或自动退款');
    }
  }
  return interrupted.length;
}

// ---------------------------------------------------------------- 选号

/**
 * 挑一个可用账号：优先用指定的，否则在 valid 里挑「最久没用过的」。
 *
 * 为什么按 last_used_at 排而不是随机：同一 IP 高频操作多账号会被风控（已经踩过：
 * 8 个号批量操作后失效 3 个）。轮转能让单号的使用频率尽量均匀，别可着一个号薅。
 */
function candidates(preferId = null, seconds = null, { requireReferenceImages = false, strictAccount = false, excludeIds = null } = {}) {
  const nowIso = now();
  const exclude = new Set((excludeIds || []).map((v) => Number(v)).filter(Number.isSafeInteger));
  // free/pro are billing labels, not evidence that a requested duration is supported.
  // 跳过冷却中的账号：上游限流（710022002）时它们会话还好好的，
  // 只是现在不能再用 —— 当成死号会白白浪费一个可用的号。
  const pool = db.prepare(`SELECT * FROM dola_accounts
                           WHERE status = 'valid'
                             AND TRIM(COALESCE(proxy, '')) <> ''
                             AND (cooldown_until IS NULL OR cooldown_until <= ?)
                             AND (? IS NULL OR id = ?)
                           ORDER BY COALESCE(last_used_at, '') ASC, id ASC LIMIT 200`)
    .all(nowIso, strictAccount ? Number(preferId) : null, strictAccount ? Number(preferId) : null);
  // 710022002 is keyed to the real exit IP, not the proxy URL/SID. A proxy
  // string alone is therefore insufficient evidence for a safe submission.
  // Keep this gate read-only: proxy assignment/rotation is an explicit
  // maintenance action, never an implicit side effect of generation.
  const rest = pool
    .filter((account) => !exclude.has(Number(account.id)))
    .filter((account) => !ACCOUNT_SELECTION_RESERVATIONS.has(account.id))
    .filter((account) => !accountHasUnsettledSubmission(db, account.id))
    .filter((account) => !hasConfirmedZeroVideoQuota(account, nowIso))
    .filter((account) => !hasGenerationGuard(db, account.id, seconds, requireReferenceImages))
    .filter((account) => !generationExitIpIssue(account))
    .filter((account) => Number(seconds) !== 15 || account.native_15s_state === 'available')
    .filter((account) => Number(seconds) !== 30 || account.native_30s_state === 'available')
    .filter((account) => !requireReferenceImages || account.reference_image_state === 'available');
  if (!preferId) return rest.slice(0, 8);
  // 指定的号排最前，**但不是唯一选项** —— 它体检不过时会自动落到后面的轮转队列，
  // 而不是直接报"没有可用账号"。
  const pref = rest.find((a) => a.id === Number(preferId));
  if (strictAccount) return pref ? [pref] : [];
  if (!pref) return rest.slice(0, 8);
  return [pref, ...rest.filter((a) => a.id !== pref.id)].slice(0, 8);
}

/**
 * Generation requires a verified, exclusive exit IP.
 *
 * `exit_ip` is written only after the proxy was actually checked through
 * ipinfo.io. An empty value means "proxy string exists, but isolation is not
 * proven". A repeated value means two currently-valid accounts can appear
 * from the same upstream IP, which is exactly the condition that triggered
 * the observed upstream rate limit.
 */
function generationExitIpIssue(account) {
  const exitIp = String(account?.exit_ip || '').trim();
  if (!exitIp) return '出口 IP 尚未核验，未提交';
  const peers = Number(db.prepare(`SELECT COUNT(*) AS c FROM dola_accounts
                                   WHERE status = 'valid' AND TRIM(COALESCE(exit_ip, '')) = ?`)
    .get(exitIp)?.c || 0);
  return peers > 1 ? '出口 IP 与其他有效账号重复，未提交' : '';
}

function generationPoolStats() {
  const nowIso = now();
  const rows = db.prepare(`SELECT exit_ip FROM dola_accounts
                           WHERE status = 'valid'
                             AND TRIM(COALESCE(proxy, '')) <> ''
                             AND (cooldown_until IS NULL OR cooldown_until <= ?)`)
    .all(nowIso);
  const counts = new Map();
  let missingExitIp = 0;
  for (const row of rows) {
    const exitIp = String(row.exit_ip || '').trim();
    if (!exitIp) { missingExitIp++; continue; }
    counts.set(exitIp, (counts.get(exitIp) || 0) + 1);
  }
  const sharedExitIpRows = [...counts.values()].filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  return {
    missingExitIp,
    sharedExitIpRows,
    sharedExitIpGroups: [...counts.values()].filter((count) => count > 1).length,
  };
}

/**
 * Read-only readiness summary for the user-facing gateway.
 *
 * The native capability flag alone is not enough to submit a real task: the
 * account must also have a configured proxy, a currently verified exclusive
 * exit IP, and no active cooldown.  Return counts only; never expose account
 * labels, cookies, proxy URLs, or IP addresses across the gateway boundary.
 */
function nativeVideoPoolStats(seconds) {
  const stateColumn = `native_${Number(seconds)}s_state`;
  const nowIso = now();
  const allValid = db.prepare(`SELECT id, ${stateColumn} AS capability_state, proxy, exit_ip, cooldown_until,
                                      quota_remaining, quota_source, quota_at
                               FROM dola_accounts
                               WHERE status = 'valid'`).all();
  const stateCounts = { available: 0, unknown: 0, unavailable: 0 };
  const validExitCounts = new Map();
  for (const row of allValid) {
    const state = String(row.capability_state || 'unknown');
    if (Object.hasOwn(stateCounts, state)) stateCounts[state]++;
    const exitIp = String(row.exit_ip || '').trim();
    if (exitIp) validExitCounts.set(exitIp, (validExitCounts.get(exitIp) || 0) + 1);
  }

  let eligible = 0;
  let availableWithProxy = 0;
  let availableMissingExitIp = 0;
  let availableCooling = 0;
  let availableSharedExitIp = 0;
  for (const row of allValid) {
    if (String(row.capability_state || 'unknown') !== 'available') continue;
    if (accountHasUnsettledSubmission(db, row.id)) continue;
    if (hasConfirmedZeroVideoQuota(row, nowIso)) continue;
    if (hasGenerationGuard(db, row.id, seconds)) continue;
    if (String(row.proxy || '').trim()) availableWithProxy++;
    else continue;
    if (row.cooldown_until && row.cooldown_until > nowIso) {
      availableCooling++;
      continue;
    }
    const exitIp = String(row.exit_ip || '').trim();
    if (!exitIp) {
      availableMissingExitIp++;
      continue;
    }
    if ((validExitCounts.get(exitIp) || 0) > 1) {
      availableSharedExitIp++;
      continue;
    }
    eligible++;
  }

  return {
    ready: eligible > 0,
    eligible,
    ...stateCounts,
    availableWithProxy,
    availableMissingExitIp,
    availableCooling,
    availableSharedExitIp,
  };
}

export function nativeFifteenSecondPoolStats() {
  return nativeVideoPoolStats(15);
}

export function nativeThirtySecondPoolStats() {
  return nativeVideoPoolStats(30);
}

/**
 * Read-only readiness for reference-image uploads.
 * Mirrors native duration pools, but gates on reference_image_state
 * (written only by the read-only DOM probe). Counts only — never labels,
 * cookies, proxies, or IPs.
 */
export function referenceImagePoolStats() {
  const nowIso = now();
  const allValid = db.prepare(`SELECT id, reference_image_state AS capability_state, proxy, exit_ip, cooldown_until,
                                      quota_remaining, quota_source, quota_at
                               FROM dola_accounts
                               WHERE status = 'valid'`).all();
  const stateCounts = { available: 0, unknown: 0, unavailable: 0 };
  const validExitCounts = new Map();
  for (const row of allValid) {
    const state = String(row.capability_state || 'unknown');
    if (Object.hasOwn(stateCounts, state)) stateCounts[state]++;
    const exitIp = String(row.exit_ip || '').trim();
    if (exitIp) validExitCounts.set(exitIp, (validExitCounts.get(exitIp) || 0) + 1);
  }

  let eligible = 0;
  let availableWithProxy = 0;
  let availableMissingExitIp = 0;
  let availableCooling = 0;
  let availableSharedExitIp = 0;
  for (const row of allValid) {
    if (String(row.capability_state || 'unknown') !== 'available') continue;
    if (accountHasUnsettledSubmission(db, row.id)) continue;
    if (hasConfirmedZeroVideoQuota(row, nowIso)) continue;
    if (String(row.proxy || '').trim()) availableWithProxy++;
    else continue;
    if (row.cooldown_until && row.cooldown_until > nowIso) {
      availableCooling++;
      continue;
    }
    const exitIp = String(row.exit_ip || '').trim();
    if (!exitIp) {
      availableMissingExitIp++;
      continue;
    }
    if ((validExitCounts.get(exitIp) || 0) > 1) {
      availableSharedExitIp++;
      continue;
    }
    if (!hasGenerationGuard(db, row.id, null, true)) eligible++;
  }

  return {
    ready: eligible > 0,
    eligible,
    ...stateCounts,
    availableWithProxy,
    availableMissingExitIp,
    availableCooling,
    availableSharedExitIp,
  };
}

/**
 * 「会话确实死了」的 dola 业务码。只有命中这些才敢把账号标 invalid。
 *
 *   710012014 → 未登录 / 半失效（self_brief 的返回）
 *   710012001 → Session expired，明确要求重新登录
 *
 * ⚠️ 为什么必须区分：踩过 —— 一次探测用的 HTTP 层出了故障（当时是代理地址被
 * 误传成 "[object Object]"），`fetchProfile` 返回 ok=false，于是**体检把所有
 * 健康账号一律标成了 invalid**。数据被我们自己污染，比探测失败本身严重得多。
 * 网络抖动、代理不通、超时这类**基础设施故障**绝不能写进账号状态。
 */
const SESSION_DEAD_CODES = new Set([710012014, 710012001]);

/**
 * 选号 + **现场会话体检**。
 *
 * ⚠️ 这一步是必须的，不是锦上添花：
 *   库里的 status='valid' 只代表「上次批量校验时是活的」，可能已经过去很久。
 *   实测踩过：
 *     - 轮转排第一的号其实早就半失效，直接拿它提交 → 开浏览器、等 15 秒、
 *       拿不到 conversationId → 任务失败，白浪费一次提交，用户只看到"生成失败"。
 *     - **用错探测接口同样会漏判**：`/alice/user/config/pull`（checkSession 走的那条）
 *       对「半失效」状态（code 710012014）是**无感**的，会返回 ok；
 *       只有 `/alice/profile/self_brief` 能查出来。
 *       所以这里必须用 fetchProfile，不能用 checkSession。
 *   逐个体检，确认死了的当场标 invalid 并跳过，最多试 3 个。
 *
 * @returns {Promise<{account:object|null, skipped:Array<{id:number,label:string,code:any}>}>}
 */
async function pickLiveAccount(preferId = null, { probe = 3, seconds = null, requireReferenceImages = false, strictAccount = false, excludeIds = null } = {}) {
  const list = candidates(preferId, seconds, { requireReferenceImages, strictAccount, excludeIds });
  const skipped = [];
  for (const acc of list.slice(0, Math.max(1, probe))) {
    // Reserve before the first await. JavaScript is single-threaded, so this
    // synchronous Set write closes the selection race between concurrent HTTP
    // submissions without serializing the network probes themselves.
    if (ACCOUNT_SELECTION_RESERVATIONS.has(acc.id)) continue;
    ACCOUNT_SELECTION_RESERVATIONS.add(acc.id);
    let keepReservation = false;
    let proxy;
    try {
      try { proxy = requireGenerationProxy(acc.proxy); }
      catch {
        skipped.push({ id: acc.id, label: acc.label, code: null, kind: '代理缺失或无效，未连接' });
        continue;
      }
      // 体检也走这个账号自己的代理：一来 IP 一致更安全，
      // 二来能顺带验证"这条代理通不通"，不通的当场就能发现。
      let r;
      try {
        r = await fetchProfile(parseCookies(acc.cookie), { timeout: 15000, proxy });
      } catch (e) {
        // 探测本身抛异常 = 基础设施问题，绝不写账号状态
        console.warn(`[gen] 账号 #${acc.id}（${acc.label}）探测异常，本次跳过但不标 invalid：${e.message}`);
        skipped.push({ id: acc.id, label: acc.label, code: null, kind: `探测异常：${e.message}` });
        continue;
      }

      if (hasLiveSession(r)) {
        if (acc.sec_user_id && String(r.entityId || r.id || '') !== String(acc.sec_user_id)) {
          skipped.push({ id: acc.id, label: acc.label, code: null, kind: '现场账号身份与号池记录不一致，未提交' });
          continue;
        }
        if (hasGenerationGuard(db, acc.id, seconds, requireReferenceImages)) {
          skipped.push({ id: acc.id, label: acc.label, code: 'GENERATION_GUARDED', kind: '能力已暂停，需只读复核' });
          continue;
        }
        keepReservation = true;
        return { account: acc, skipped };
      }

      if (SESSION_DEAD_CODES.has(Number(r.code))) {
        // 明确死了 → 才敢写状态
        skipped.push({ id: acc.id, label: acc.label, code: r.code, kind: `code=${r.code}` });
        db.prepare("UPDATE dola_accounts SET status='invalid', last_check_at=?, last_error=?, updated_at=? WHERE id=?")
          .run(now(), `生成前体检失败：self_brief code=${r.code}（会话已失效）`, now(), acc.id);
        console.warn(`[gen] 账号 #${acc.id}（${acc.label}）会话已失效（code=${r.code}），已标 invalid 并跳过`);
        continue;
      }

      // 其余情况（HTTP 非 200、未知 code、超时…）**不动账号状态**
      skipped.push({ id: acc.id, label: acc.label, code: r.code ?? null, kind: `HTTP ${r.status} code=${r.code ?? '-'}` });
      console.warn(`[gen] 账号 #${acc.id}（${acc.label}）体检没通过但原因不是会话失效（HTTP ${r.status} code=${r.code ?? '-'}），跳过且不改状态`);
    } finally {
      if (!keepReservation) ACCOUNT_SELECTION_RESERVATIONS.delete(acc.id);
    }
  }
  return { account: null, skipped };
}

/**
 * 任务换号：从池子里现场探测一个可用账号（排除 excludeIds），把任务行切过去。
 *
 * 锁定账号验收（strictAccount）的任务不换号，直接返回 { account: null }。
 * 换上来的号已经过 fetchProfile 活体探测；预留位在切号成功后释放，
 * 后续由 run() 的按账号 FIFO 锁接管串行。
 */
async function switchTaskAccount(id, { excludeIds = [], seconds = null, requireReferenceImages = false, strictAccount = false } = {}) {
  if (strictAccount) return { account: null, skipped: [] };
  const picked = await pickLiveAccount(null, { seconds, requireReferenceImages, probe: 5, excludeIds });
  const next = picked.account;
  if (!next) return { account: null, skipped: picked.skipped };
  db.prepare('UPDATE dola_videos SET account_id=?, account_label=?, updated_at=? WHERE id=?')
    .run(next.id, next.label || '', now(), id);
  db.prepare('UPDATE dola_accounts SET last_used_at=?, updated_at=? WHERE id=?').run(now(), now(), next.id);
  // 预留只保护"选中→探测"窗口；任务行已落库，后续由按账号 FIFO 锁串行。
  ACCOUNT_SELECTION_RESERVATIONS.delete(next.id);
  return { account: db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(next.id), skipped: picked.skipped };
}

// ---------------------------------------------------------------- 并发闸门

let running = 0;
const waiters = [];
let admissionReservations = 0;
let preflightRunning = 0;

/** Before creating/charging, check live model/duration controls. No prompt or fallback account. */
async function preflightGenerationAccount(acc, seconds, requireReferenceImages) {
  if (preflightRunning + running >= concurrency()) {
    throw Object.assign(new Error('只读生成预检繁忙，请稍后提交；尚未建任务或扣积分'), { status: 429, code: 'GENERATION_PREFLIGHT_BUSY' });
  }
  preflightRunning++;
  try {
    await resolveFfprobePath();
    const result = await probeNativeVideoViaBrowser(parseCookies(acc.cookie), {
      seconds, proxy: proxyOf(acc), proxyUrl: requireGenerationProxy(acc.proxy), timeout: 120000,
    });
    if (!isVerifiedNativeCapability(result, seconds)) {
      throw Object.assign(new Error(`生成前只读预检未通过：${result?.error || '未确认目标模型及时长'}；未建任务、未扣积分`), {
        status: 409, code: 'GENERATION_PREFLIGHT_FAILED', diagnostic: result?.diagnostic,
      });
    }
    // A maintenance update during the browser await invalidates the entire snapshot.
    const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(acc.id);
    if (!current || current.status !== 'valid'
        || accountHasUnsettledSubmission(db, acc.id)
        || hasConfirmedZeroVideoQuota(current)
        || ['cookie_hash', 'proxy', 'sec_user_id', 'exit_ip'].some(key => current[key] !== acc[key])
        || (current.cooldown_until && current.cooldown_until > now())
        || generationExitIpIssue(current)
        || hasGenerationGuard(db, acc.id, seconds, requireReferenceImages)
        || (seconds === 15 && current.native_15s_state !== 'available')
        || (seconds === 30 && current.native_30s_state !== 'available')
        || (requireReferenceImages && current.reference_image_state !== 'available')) {
      throw Object.assign(new Error('只读预检期间账号状态变化，请重新核验；未建任务、未扣积分'), { status: 409, code: 'GENERATION_PREFLIGHT_STALE' });
    }
  } catch (error) {
    if (String(error?.code || '').startsWith('GENERATION_PREFLIGHT_')) throw error;
    throw Object.assign(new Error('生成前只读预检异常；未建任务、未扣积分，请检查页面或代理'), { status: 409, code: 'GENERATION_PREFLIGHT_FAILED' });
  } finally {
    preflightRunning--;
  }
}

const ACTIVE_GENERATION_STATUSES = "'queued','submitting','generating','resolving'";

/**
 * 生成并发上限。
 *
 * 每次生成要开一个真实浏览器（几百 MB 内存），所以不能无脑放开。
 * 上限给到 20：参考同类商业面板的闸门是 600，但那是分布式多机跑的；
 * 单机开 20 个 Chromium 已经接近内存天花板了，再高要先把浏览器池化。
 */
function concurrency() {
  return Math.max(1, Math.min(20, num('dola_gen_concurrency', 1)));
}

/**
 * Admission capacity is separate from browser worker concurrency.
 * A large queue is cheap; starting thousands of Chromium sessions is not.
 */
function queueLimit() {
  return Math.max(1, Math.min(6000, num('dola_gen_queue_limit', 6000)));
}

function activeGenerationCount() {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM dola_videos WHERE status IN (${ACTIVE_GENERATION_STATUSES})`).get()?.c || 0);
}

function reserveGenerationAdmission() {
  if (activeGenerationCount() + admissionReservations >= queueLimit()) return false;
  admissionReservations++;
  return true;
}

function releaseGenerationAdmission() {
  admissionReservations = Math.max(0, admissionReservations - 1);
}

function acquire() {
  if (running < concurrency()) { running++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  running = Math.max(0, running - 1);
  const next = waiters.shift();
  if (next) { running++; next(); }
}

/**
 * Per-account FIFO lock. A queued task may reuse an account, but its full
 * generation flow must wait until the previous task on that account finishes.
 * This preserves the old single-account queue behavior while allowing tasks
 * assigned to different accounts to use the global concurrency in parallel.
 */
function acquireAccount(accountId) {
  const key = String(accountId ?? 'unknown');
  const previous = ACCOUNT_RUN_TAILS.get(key);
  let releaseNext;
  const next = new Promise((resolve) => { releaseNext = resolve; });
  ACCOUNT_RUN_TAILS.set(key, next);
  const queuedBehindAnother = Boolean(previous);
  if (queuedBehindAnother) accountWaiters++;

  return (previous || Promise.resolve()).then(() => {
    if (queuedBehindAnother) accountWaiters = Math.max(0, accountWaiters - 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseNext();
      if (ACCOUNT_RUN_TAILS.get(key) === next) ACCOUNT_RUN_TAILS.delete(key);
    };
  });
}

export function generationStatus() {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM dola_videos GROUP BY status').all();
  const activeTasks = activeGenerationCount();
  const limit = queueLimit();
  return {
    running,
    queued: waiters.length + accountWaiters,
    concurrency: concurrency(),
    available: Math.max(0, concurrency() - running),
    activeTasks,
    queueLimit: limit,
    queueAvailable: Math.max(0, limit - activeTasks - admissionReservations),
    admissionReserved: admissionReservations,
    reservedAccounts: ACCOUNT_SELECTION_RESERVATIONS.size,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
  };
}

// ---------------------------------------------------------------- 建任务

/**
 * 建一条生成任务并异步开跑。立即返回（前端轮询进度）。
 *
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} [p.ratio]
 * @param {number} [p.seconds]      单次生成目标时长（10/15/20/30）
 * @param {number} [p.forceSeconds] 必须与 seconds 一致；只用于传递原生目标
 */
export async function createVideoTask({
  prompt,
  ratio = '16:9',
  mode = 'standard',
  seconds,
  forceSeconds = null,
  accountId = null,
  strictAccount = false,
  ownerTokenId = null,
  ownerPrefix = '',
  chargeRef = '',
  createdBy = null,
  timeoutMinutes = null,
  hasReferenceImages = false,
  referenceImageCount = 0,
  deferStart = false,
} = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw Object.assign(new Error('prompt 不能为空'), { status: 400 });
  if (text.length > 12000) throw Object.assign(new Error('prompt 超过 12000 字'), { status: 400 });
  const generationMode = String(mode || 'standard').trim().toLowerCase();
  if (!['standard', 'expert'].includes(generationMode)) {
    throw Object.assign(new Error('mode 仅支持 standard 或 expert'), { status: 400, code: 'UNSUPPORTED_MODE' });
  }
  const duration = normalizeVideoDuration({ seconds, forceSeconds });
  if (strictAccount && (!Number.isSafeInteger(Number(accountId)) || Number(accountId) < 1)) {
    throw Object.assign(new Error('锁定账号验收必须提供有效 accountId'), { status: 400 });
  }
  if (duration.seconds === 15 && generationMode !== 'expert') {
    throw Object.assign(new Error('15 秒视频只能在专家模式提交，未提交'), { status: 400, code: 'EXPERT_MODE_REQUIRED' });
  }

  // 先占用队列名额，再做账号体检。这样多个同时提交不会在体检等待期间
  // 越过容量上限；只有任务成功落库后，名额才转为数据库里的 active task。
  if (!reserveGenerationAdmission()) {
    const status = generationStatus();
    throw Object.assign(
      new Error(`生成队列已满（当前 ${status.activeTasks}/${status.queueLimit} 个任务在运行或排队），请稍后重试`),
      { status: 429, code: 'GENERATION_QUEUE_FULL' },
    );
  }
  let admissionHeld = true;
  try {
    if (strictAccount && hasConfirmedZeroVideoQuota(db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(Number(accountId)))) {
      throw Object.assign(new Error('指定账号的最新回执显示视频额度为 0；未建任务、未扣积分，不会自动换号'), {
        status: 409, code: 'GENERATION_QUOTA_EXHAUSTED',
      });
    }
    if (strictAccount && accountHasUnsettledSubmission(db, Number(accountId))) {
      throw Object.assign(new Error('指定账号有上游结果尚未核对的任务；未建任务、未扣积分，不会自动换号'), {
        status: 409, code: 'GENERATION_SUBMISSION_UNRESOLVED',
      });
    }
    // 先体检再占坑 —— 拿到一个真的能用的号，别让任务跑一半死在死号上
    const { account: acc, skipped } = await pickLiveAccount(accountId, { seconds: duration.seconds, requireReferenceImages: Boolean(hasReferenceImages), strictAccount });
    if (!acc) {
      const detail = skipped.length
        ? `本次跳过 ${skipped.length} 个账号（${skipped.map((s) => `#${s.id} ${s.kind ?? s.code}`).join('、')}）`
        : '';
      const queueHint = ACCOUNT_SELECTION_RESERVATIONS.size
        ? `当前已有 ${ACCOUNT_SELECTION_RESERVATIONS.size} 个账号正在被其他提交体检/占用，请稍后重试。`
        : '';
      const pool = generationPoolStats();
      const isolation = pool.missingExitIp || pool.sharedExitIpRows
        ? `当前有效代理号中有 ${pool.missingExitIp} 个未完成出口 IP 核验、${pool.sharedExitIpRows} 个账号处于共享出口（${pool.sharedExitIpGroups} 组），请先重新核验或换 SID。`
        : '';
      const capabilityParts = [];
      if (duration.seconds === 30) {
        capabilityParts.push('30 秒还要求该账号已标为可用（方悦改写路径：页面选 15s（2 额度档）+ 请求改写 duration=30）');
      } else if (duration.seconds === 15) {
        capabilityParts.push('15 秒还要求通过页面原生能力探测确认 Seedance 2.0 与 15 秒选项');
      }
      if (hasReferenceImages) {
        capabilityParts.push('参考图还要求该账号已通过页面参考图上传控件探测');
      }
      const capability = capabilityParts.join('；');
      const reason = `请确认账号登录有效、身份匹配、已配置有效的 IPWeb 或显式代理，且出口 IP 已核验并只被一个有效账号使用；最新回执确认零额度的账号不参与分配，不按免费/订阅身份判定时长能力。已触发重复失败保护的账号须在后台「生成统计与复核」通过只读复核。${capability}${isolation}${queueHint}`;
      throw Object.assign(
        new Error(`账号池里没有可用账号（status=valid）。${reason}${detail}`),
        { status: 409 },
      );
    }

    let info;
    try {
      await preflightGenerationAccount(acc, duration.seconds, Boolean(hasReferenceImages));
      const refCount = hasReferenceImages ? Math.max(0, Number(referenceImageCount) || 0) : 0;
      info = db.prepare(`INSERT INTO dola_videos
        (account_id, account_label, prompt, ratio, seconds, force_seconds, status, stage,
         owner_token_id, owner_prefix, charge_ref, has_reference_images, reference_image_count,
         strict_account, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(acc.id, acc.label || '', text, String(ratio), duration.seconds,
          duration.forceSeconds, 'queued', '排队中',
          ownerTokenId, ownerPrefix, chargeRef, refCount > 0 ? 1 : 0, refCount,
          strictAccount ? 1 : 0, createdBy, now(), now());
      const id = Number(info.lastInsertRowid);
      // 从这里开始队列名额由 active task 统计接管；即使后续更新/调度报错，
      // 数据库里的 queued 任务也必须继续占用名额，避免容量被错误释放。
      admissionHeld = false;
      db.prepare('UPDATE dola_accounts SET last_used_at=?, updated_at=? WHERE id=?').run(now(), now(), acc.id);
      // The reservation only protects the async selection/probe window. Once the
      // task is recorded, the per-account FIFO in run() handles long-lived use.
      ACCOUNT_SELECTION_RESERVATIONS.delete(acc.id);

      // The gateway defers dispatch until async reference storage AND billing finish.
      // setImmediate alone is not a barrier: disk I/O can yield before charging.
      if (!deferStart) startVideoTask(id, { timeoutMinutes });
      const row = getVideoTask(id);
      return { ...row, _skipped: skipped };
    } catch (error) {
      ACCOUNT_SELECTION_RESERVATIONS.delete(acc.id);
      throw error;
    }
  } finally {
    if (admissionHeld) releaseGenerationAdmission();
  }
}

const SCHEDULED_VIDEO_TASKS = new Set();
export function startVideoTask(id, { timeoutMinutes = null } = {}) {
  id = Number(id);
  const row = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
  if (!row || row.status !== 'queued') return false;
  if (row.owner_token_id != null) {
    const consume = row.charge_ref ? db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref=?").get(row.charge_ref) : null;
    const refund = row.charge_ref ? db.prepare("SELECT 1 FROM point_transactions WHERE kind='refund' AND ref=?").get(row.charge_ref) : null;
    if (!consume || consume.token_id !== row.owner_token_id || !Number.isSafeInteger(consume.delta) || consume.delta <= 0 || refund) {
      throw Object.assign(new Error('任务准备未完成：需先确认有效计费再启动'), { status: 409 });
    }
  }
  if (SCHEDULED_VIDEO_TASKS.has(id)) return true;
  SCHEDULED_VIDEO_TASKS.add(id);
  const maxMin = Number(timeoutMinutes) || num('dola_gen_timeout_min', 20);
  setImmediate(() => run(id, { maxMin }).catch((e) => {
    console.error(`[gen] #${id} 处理异常，已按提交记录保守处理`);
    const receipt = getSubmission(db, id);
    if (receipt && !['rejected', 'completed'].includes(receipt.state)) holdUncertainSubmission(db, id);
    else fail(id, e.message || String(e));
  }).finally(() => SCHEDULED_VIDEO_TASKS.delete(id)));
  return true;
}

function setStage(id, status, stage) {
  return db.prepare(`UPDATE dola_videos SET status=?, stage=?, updated_at=? WHERE id=?
    AND status IN ('queued','submitting','generating','resolving')`).run(status, stage, now(), id).changes;
}

function taskActive(id) {
  return isActiveGenerationStatus(db.prepare('SELECT status FROM dola_videos WHERE id=?').get(id)?.status);
}

function fail(id, message, accountSnapshot = null) {
  const updated = db.prepare(`UPDATE dola_videos SET status='failed', error=?, stage='失败', updated_at=?, finished_at=? WHERE id=?
    AND status IN ('queued','submitting','generating','resolving')`)
    .run(String(message).slice(0, 500), now(), now(), id);
  if (updated.changes) {
    settleFailedVideoRefund(db, getVideoTask(id));
    if (accountSnapshot) recordGenerationGuard(db, db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id), accountSnapshot);
    void cleanupReferenceImages(id).catch(() => {});
  }
}

/** Keep only non-sensitive model/duration telemetry in task errors for audit. */
function requestCaptureNote(cap) {
  if (!Array.isArray(cap)) return '';
  const rows = cap.filter((entry) => entry && typeof entry.model === 'string')
    .slice(-5)
    .map((entry) => `${entry.model}:${String(entry.before)}→${String(entry.after)}${entry.via ? `/${entry.via}` : ''}`);
  return rows.length ? ` 请求捕获：${rows.join(', ')}` : '';
}

// ---------------------------------------------------------------- 浏览器提交

/**
 * 开一次浏览器把提示词提交出去，拿回 conversationId，然后**立刻关掉**。
 * 页面先选择真实可用的目标模型，再选择页面真实提供的原生时长选项。
 * 15 秒走 Seedance 2.0；20/30 秒走 Seedance 2.5；原生路径只观察真实请求，
 * 服务器结果与媒体时长仍须分别验收。
 *
 * ★★ 这里有一处**至关重要的拦截**，不写的话每失败一次就烧掉一个账号 ★★
 *
 * 实测因果链（抓包坐实）：
 *   提交 → /chat/completion 回 SSE `STREAM_ERROR {error_code:710022002, error_msg:"当前服务访问频繁"}`
 *        → **dola 前端自己请求 `/passport/web/logout/` 把自己登出**
 *        → 会话死亡，之后所有探测都变成 code 710012014
 *
 * 也就是说账号不是被封、也不是自己到期 —— **是限流触发了前端自毁会话**。
 * 所以这里把登出请求 abort 掉：限流就只是"这次没提交成功"，会话还在，稍后重试即可。
 */
async function submitViaBrowser(cookieText, {
  prompt, seconds = 10, forceSeconds = null, targetModel = null, proxyUrl, accountId, log,
  sessionVerified = false, isActive = () => true, referenceImagePaths = [],
  onDispatch, onConversation,
}) {
  proxyUrl = requireGenerationProxy(proxyUrl);
  if (!sessionVerified) throw new Error('未确认实时有效登录，拒绝提交');
  if (!isActive()) throw new Error('generation_cancelled');
  if (typeof onDispatch !== 'function' || typeof onConversation !== 'function') throw new Error('submission_journal_required');
  const requestedSeconds = Number(forceSeconds ?? seconds);
  const pw = await getPlaywright();
  if (!pw?.chromium) {
    throw new Error('playwright 未安装：npm i playwright && npx playwright install chromium');
  }
  const ck = parseCookies(cookieText);

  // 同一账号不能并发开两个（profile 目录会打架）。正常情况下队列会避开，
  // 但并发上限调大之后仍有可能撞上，这里兜住。
  const lockKey = String(accountId ?? 'anon');
  if (ACCOUNT_LOCKS.has(lockKey)) throw new Error(`账号 #${lockKey} 已有一个浏览器在跑，跳过本次`);
  ACCOUNT_LOCKS.add(lockKey);

  const profileDir = path.join(PROFILE_ROOT, lockKey);
  let ctx = null;
  const receiptReads = new Set();
  let receiptCollectorClosed = false;
  const submissionOutcome = { error: null };
  // ⚠️ 必须在 try **外面**声明：finally 里要关它。
  //    写在 try 里面会 `bridge is not defined`（作用域不到 finally）。
  let bridge = null;
  try {
    await fs.mkdir(profileDir, { recursive: true });

    /**
     * ★ 浏览器的代理配置。
     *
     * Chromium **不支持带用户名密码的 SOCKS5**（会直接报
     * `Browser does not support socks5 proxy authentication`），
     * 而 IPWeb 的网关实测只认 SOCKS5。
     * 所以这里给它架一个**本地无认证的 HTTP 桥**，认证在桥里完成：
     *
     *   浏览器 ──▶ 本地桥 ──SOCKS5+认证──▶ IPWeb ──▶ 目标站
     */
    let launchProxy;
    if (proxyUrl) {
      const scheme = (() => { try { return new URL(proxyUrl).protocol; } catch { return ''; } })();
      if (/^socks5?h?:$/.test(scheme)) {
        bridge = await startSocksBridge(proxyUrl);
        launchProxy = { server: bridge.url };   // 本地无认证，Chromium 认
        log(`已架本地 SOCKS5 桥 ${bridge.url} → 上游带认证`);
      } else {
        launchProxy = proxyOf(proxyUrl);
      }
    }
    if (!launchProxy?.server) throw new Error('generation_proxy_required');
    if (!isActive()) throw new Error('generation_cancelled');

    const launchOpts = {
      headless: true,
      // Match the read-only probe runtime; do not alternate with headless shell.
      executablePath: pw.chromium.executablePath(),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1560, height: 950 },
      locale: 'zh-CN',
      userAgent: DOLA_HEADERS['user-agent'],
      proxy: launchProxy,
      serviceWorkers: 'block',
    };

    // 用持久化 context：缓存写回磁盘，下次生成就不必重下那 10 MB 的 JS 包
    try {
      ctx = await pw.chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (e) {
      // 进程被强杀时 Chromium 会留下 SingletonLock，导致下次启动失败。
      // 清掉锁文件重试一次 —— 这个坑不兜住的话，一个账号崩一次就永久起不来了。
      if (/SingletonLock|ProcessSingleton|profile.*in use/i.test(e.message)) {
        console.warn(`[gen] 账号 #${lockKey} 的 profile 被锁，清锁重试`);
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          await fs.rm(path.join(profileDir, f), { force: true, recursive: true }).catch(() => {});
        }
        ctx = await pw.chromium.launchPersistentContext(profileDir, launchOpts);
      } else throw e;
    }

    // ★ 拦住"前端自毁会话"的登出请求（见上方说明）。这是保住账号的关键。
    await ctx.route('**/passport/**/logout**', (route) => {
      console.warn('[gen] 已拦截 dola 前端的自动登出请求（限流触发），会话得以保留');
      return route.abort();
    });

    // 掐掉用不着的资源类型（实测只省 1%，但白省）。**只拦静态资源**：
    // XHR/fetch/document/script 一律放行 —— 那才是业务链路（含 SSE 流）。
    // Reference-image previews are themselves resourceType=image; keep them
    // unblocked when this submission attaches files so attach evidence can land.
    const BLOCK_TYPES = new Set(referenceImagePaths?.length ? ['font', 'media'] : ['image', 'font', 'media']);
    let submissionBlocked = false;
    let submittedRequest = null;
    let ackObserver = null;
    let resolveAck;
    const ackReady = new Promise(resolve => { resolveAck = resolve; });
    const wireGate = createGenerationWireGate({ seconds: requestedSeconds, model: targetModel,
      isActive, sessionVerified: () => sessionVerified });
    await ctx.route('**/*', async (route) => {
      const request = route.request();
      const decision = wireGate.inspect(request);
      if (decision.action === 'abort') {
        // A blocked automatic duplicate must not discard the first request's
        // legitimate result. No first request forwarded means a true pre-send block.
        if (!wireGate.snapshot().forwarded) submissionBlocked = true;
        return route.abort();
      }
      if (decision.action === 'forward') {
        try { onDispatch(decision.body); }
        catch { submissionBlocked = true; return route.abort(); }
        submissionBlocked = false;
        submittedRequest = request;
        ackObserver = createGenerationAckObserver(identifyGenerationRequest(decision.body));
        return route.continue({ postData: decision.body });
      }
      try {
        if (BLOCK_TYPES.has(request.resourceType())) return route.abort();
      } catch { /* 拿不到类型就放行 */ }
      return route.continue();
    });

    // 抓限流/错误码：/chat/completion 是 SSE，结束后能整段读到
    const streamErrors = [];
    ctx.on('response', (res) => {
      if (res.request() !== submittedRequest || !ackObserver) return;
      const work = (async () => {
      try {
        const text = await res.text();
        if (receiptCollectorClosed) return;
        for (let offset = 0; offset < text.length; offset += 16384) {
          ackObserver.push(text.slice(offset, offset + 16384));
          if (ackObserver.snapshot().truncated) break;
        }
        const receipt = ackObserver.finish();
        for (const code of receipt.errorCodes) streamErrors.push({ code });
        if (ackObserver.hasConflict()) {
          submissionOutcome.error = 'correlation_conflict';
          resolveAck();
          return;
        }
        if (receipt.ackMatched) {
          try {
            if (!onConversation(receipt.conversationId, 'sse_ack') && isActive()) submissionOutcome.error = 'receipt_persistence_failed';
          } catch { submissionOutcome.error = 'correlation_or_persistence_conflict'; }
          resolveAck();
        }
      } catch { /* 流读不到就算了 */ }
      })();
      receiptReads.add(work);
      void work.finally(() => receiptReads.delete(work));
      return work;
    });

    await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

    if (forceSeconds || seconds) {
      // 10/20/30：方悦路径可改写 duration（20s 用 10s 承载，30s 用 15s 承载）；15 秒仍只观察不改写。
      await ctx.addInitScript(installVideoRequestAdapter, {
        seconds: Number(forceSeconds ?? seconds ?? 10),
        targetModel: targetModel || (Number(forceSeconds ?? seconds ?? 10) === 15 ? 'seedance_v2.0' : Number(forceSeconds ?? seconds ?? 10) >= 20 ? 'seedance_v2.5' : null),
        rewrite: [10, 20, 30].includes(Number(forceSeconds ?? seconds ?? 10)),
      });
    }

    const page = await ctx.newPage();
    observeVideoComposerBootstrap(page);
    /**
     * ★ 用**等元素**代替「睡固定秒数」。
     *
     * 原来写死 `waitForTimeout(11000)`：本机直连时够用，但走住宅代理时
     * **冷启动要拉 ~12 MB 的 JS 包**，11 秒根本加载不完 —— 页面还在转圈我们就去点按钮，
     * 结果是「没拿到 conversationId」，看起来像提交失败，其实是没等够。
     * 改成显式等待后，快慢网络都能自适应。
     */
    const INPUT_SEL = 'textarea, [contenteditable="true"]';
    const BOOT_MS = 60000;

    log('打开 dola /chat/');
    await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    // 等输入框出现 = 已登录创作页。代理冷启动常抖，失败则刷新再等一次。
    let hasComposer = await page.waitForSelector(INPUT_SEL, { timeout: BOOT_MS }).then(() => true).catch(() => false);
    if (!hasComposer) {
      log('创作页输入框未出现，刷新重试');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      hasComposer = await page.waitForSelector(INPUT_SEL, { timeout: BOOT_MS }).then(() => true).catch(() => false);
    }
    if (!hasComposer) {
      throw new Error('未确认已登录的创作页面（输入框未出现）');
    }

    /**
     * ★★ 还要等**主内容区真正初始化完**。
     *
     * 实测踩到的现象：输入框（外壳）很早就出现了，但技能面板/发送按钮还没就绪 ——
     * 这时候去点「视频生成」，点了也不生效（面板收起但没切过去），
     * 输入框能填字但**发送按钮是灰的**，回车毫无反应，最后表现成
     * "没拿到 conversationId"，看起来像提交失败，其实是**页面没加载完**。
     *
     * 本机直连时 11 秒足够；走住宅代理冷启动要拉 ~12MB（首次），会慢好几倍。
     * 所以这里等「网络空闲」——快慢网络都能自适应，别再按秒数猜。
     */
    // Network idle is only a short hint; the composer helper waits for actual
    // visible controls. Long-lived telemetry must not consume two minutes here.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(800);

    // SPA/proxy can remount after networkidle and drop the composer input.
    if (!await page.locator(INPUT_SEL).first().isVisible().catch(() => false)) {
      log('网络空闲后输入框消失，刷新重开创作页');
      await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      const back = await page.waitForSelector(INPUT_SEL, { timeout: BOOT_MS }).then(() => true).catch(() => false);
      if (!back) throw new Error('未确认已登录的创作页面（刷新后输入框仍未出现）');
      await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    if ([10, 15, 20, 30].includes(requestedSeconds)) {
      if (!isActive()) throw new Error('generation_cancelled');
      const requestedModel = targetModel || (requestedSeconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5');
      const modelLabel = requestedModel === 'seedance_v2.0' ? 'Seedance 2.0' : 'Seedance 2.5';
      if ([20, 30].includes(requestedSeconds)) {
        const carrier = requestedSeconds === 30 ? 15 : 10;
        log(`确认并选择 ${modelLabel}：页面选 ${carrier}s 承载 + 请求改写 duration→${requestedSeconds}（方悦路径）`);
      } else {
        log(`确认并选择 ${modelLabel} 与页面原生 ${requestedSeconds} 秒选项`);
      }
      await prepareNativeVideoComposer(page, { seconds: requestedSeconds, model: requestedModel, timeout: BOOT_MS, log });
    }

    if (referenceImagePaths?.length) {
      if (!isActive()) throw new Error('generation_cancelled');
      log(`挂载 ${referenceImagePaths.length} 张参考图`);
      let composer;
      try {
        composer = await prepareReferenceImageComposer(page, { timeout: BOOT_MS, log });
      } catch (error) {
        const err = new Error(error?.message || '参考图上传控件不可用');
        err.code = error?.code === 'NATIVE_CAPABILITY_UNKNOWN'
          ? 'REFERENCE_IMAGE_CONTROL_MISSING'
          : (error?.code || 'REFERENCE_IMAGE_CONTROL_MISSING');
        throw err;
      }
      if (!composer?.referenceImages || !composer.imageInputs?.length) {
        throw Object.assign(new Error('页面没有可用的参考图上传控件'), {
          code: 'REFERENCE_IMAGE_CONTROL_MISSING',
        });
      }
      const fileInput = page.locator('input[type="file"]').filter({
        has: page.locator(':scope'),
      });
      // Prefer an input whose accept clearly allows images; fall back to first file input.
      const handle = await page.evaluateHandle(() => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        return inputs.find((input) => /image\//i.test(input.accept || '')
          || /\.(?:png|jpe?g|webp)(?:,|$)/i.test(input.accept || ''))
          || inputs[0]
          || null;
      });
      const element = handle.asElement();
      if (!element) {
        throw Object.assign(new Error('未找到可写入的参考图文件控件'), {
          code: 'REFERENCE_IMAGE_CONTROL_MISSING',
        });
      }
      try {
        await element.setInputFiles(referenceImagePaths);
      } catch (error) {
        throw Object.assign(new Error(`参考图上传失败：${error.message || error}`), {
          code: 'REFERENCE_IMAGE_UPLOAD_FAILED',
        });
      }
      const attached = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        const imageInput = inputs.find((input) => /image\//i.test(input.accept || '')
          || /\.(?:png|jpe?g|webp)(?:,|$)/i.test(input.accept || ''))
          || inputs[0];
        const files = imageInput?.files?.length || 0;
        const preview = document.querySelectorAll('img[src^="blob:"], img[src^="data:image"]').length;
        return { files, preview };
      }).catch(() => ({ files: 0, preview: 0 }));
      if (!attached.files && !attached.preview) {
        throw Object.assign(new Error('参考图未能挂载到页面（未检测到 files 或预览）'), {
          code: 'REFERENCE_IMAGE_UPLOAD_FAILED',
        });
      }
      log(`参考图已挂载（files=${attached.files}, preview=${attached.preview}）`);
    }

    log('填提示词并提交');
    // 返回值是"点击后有没有真的派发"的诊断（没派发时会带截图与按钮 DOM 状态）。
    // 之前忽略它，导致出现过"放行 0 次/阻断 0 次"却完全看不出原因的失败。
    const dispatch = await fillAndSubmitVideoPrompt(page, prompt, { isActive });

    // A numeric URL locates a conversation; it is NOT proof of video acceptance.
    // Require an observed forwarded request, then verify the actual media later.
    await Promise.race([ackReady, page.waitForFunction(
      () => /\/chat\/\d{10,}/.test(location.href),
      null,
      { timeout: 60000 },
    ).catch(() => {})]);
    await page.waitForTimeout(3000);

    const m = page.url().match(/\/chat\/(\d{10,})/);
    const ack = ackObserver?.snapshot();
    const conversationId = ack?.ackMatched ? ack.conversationId : m && wireGate.snapshot().forwarded === 1 ? m[1] : null;
    if (conversationId && !ack?.ackMatched) onConversation(conversationId, 'conversation_url');
    const cap = await page.evaluate(() => window.__CAP || null).catch(() => null);
    const pageText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const loggedOut = /from_logout/.test(page.url());
    return { conversationId, cap, pageText, streamErrors, loggedOut, submissionBlocked, wire: wireGate.snapshot(), ack, submissionOutcome, dispatch };
  } finally {
    // ★ 无论成败都立刻关 —— 这是保住会话的关键。
    //   持久化 context 里 `ctx.close()` 就等于关掉整个浏览器；
    //   关掉时 Chromium 才会把 HTTP 缓存 flush 到磁盘，所以这一步不能省。
    await ctx?.close().catch(() => {});
    // Closing the browser settles pending response reads. Do not return a copied
    // "success" flag while a late ACK can still conflict with the saved URL.
    if (receiptReads.size) {
      let timer;
      await Promise.race([Promise.allSettled([...receiptReads]), new Promise(resolve => {
        timer = setTimeout(() => { submissionOutcome.error = 'receipt_unfinished'; resolve(); }, 3000);
      })]);
      clearTimeout(timer);
    }
    receiptCollectorClosed = true;
    await bridge?.close().catch(() => {});
    ACCOUNT_LOCKS.delete(lockKey);
  }
}

/** 上游限流错误码：命中就打退堂鼓，别把这账号当死的 */
export const RATE_LIMIT_CODES = new Set([710022002]);


// ---------------------------------------------------------------- 轮询

/** 从消息链原文里扒带水印直链 + 失败/额度线索 */
function analyzeChain(raw) {
  const text = String(raw || '').replace(/\\\//g, '/');
  const vids = [...new Set([...text.matchAll(/https?:\/\/[^"\\\s]{20,240}?(?:\.mp4|video\/tos)[^"\\\s]{0,160}/g)].map((m) => m[0]))];
  return {
    vids,
    failed: /视频生成失败|生成失败/.test(text),
    ...parseVideoQuotaReceipt(text),
  };
}

async function run(id, { maxMin }) {
  let globalAcquired = false;
  let releaseAccountLock = () => {};
  try {
    let row = db.prepare('SELECT * FROM dola_videos WHERE id = ?').get(id);
    if (!row || row.status !== 'queued') return;
    // Keep queued jobs assignable to the same account for backward-compatible
    // FIFO behavior, but never let two jobs use one account at the same time.
    // Waiting for this per-account lock happens before the global semaphore, so
    // a busy account does not consume a slot that another account could use.
    if (row.account_id != null) releaseAccountLock = await acquireAccount(row.account_id);
    row = db.prepare('SELECT * FROM dola_videos WHERE id = ?').get(id);
    if (!row || row.status !== 'queued') return;
    await acquire();
    globalAcquired = true;
    if (row.owner_token_id != null) {
      const consume = row.charge_ref
        ? db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref=?").get(row.charge_ref)
        : null;
      const refunded = row.charge_ref
        ? db.prepare("SELECT * FROM point_transactions WHERE kind='refund' AND ref=?").get(row.charge_ref)
        : null;
      if (!consume || consume.token_id !== row.owner_token_id
          || !Number.isSafeInteger(consume.delta) || consume.delta <= 0 || refunded) {
        return fail(id, '任务未确认有效扣费或已经退款，未读取账号或提交生成');
      }
    }
    const duration = normalizeVideoDuration({ seconds: row.seconds, forceSeconds: row.force_seconds });

    let acc = db.prepare('SELECT * FROM dola_accounts WHERE id = ?').get(row.account_id);
    if (!acc) return fail(id, '账号已被删除');
    if (acc.status !== 'valid' || (acc.cooldown_until && acc.cooldown_until > now())) {
      // 建任务后排队期间账号变了（比如被别的任务限流带进冷却）：原地换一个号继续，
      // 不算一次限流尝试；锁定账号验收的任务不换号。
      const switched = await switchTaskAccount(id, {
        excludeIds: [acc.id],
        seconds: duration.seconds,
        requireReferenceImages: Boolean(row.has_reference_images),
        strictAccount: Boolean(row.strict_account),
      });
      if (!switched.account) {
        return fail(id, `账号 #${acc.id} 已停用、失效或处于冷却，换号探测无可用账号，未提交`);
      }
      if (!taskActive(id)) return; // 换号探测期间任务被取消/删除，不再继续
      db.prepare('UPDATE dola_videos SET stage=?, updated_at=? WHERE id=? AND status=\'queued\'')
        .run(`原定账号 #${acc.id} 不可用，已自动换号为 #${switched.account.id}`, now(), id);
      acc = switched.account;
    }
    if (hasConfirmedZeroVideoQuota(acc)) return fail(id, '账号最新回执显示视频额度为 0，未提交');
    if (accountHasUnsettledSubmission(db, acc.id)) return fail(id, '账号有待核对的上游任务，未提交');
    if (hasGenerationGuard(db, acc.id, duration.seconds, Boolean(row.has_reference_images))) {
      return fail(id, '重复失败保护：该账号对应能力尚未通过只读复核，未提交');
    }
    const accProxy = requireGenerationProxy(acc.proxy);
    const ck = parseCookies(acc.cookie);
    let sessionVerified = false;
    if (duration.requireSessionRecheck) {
      // Recheck identity/session after queue wait, irrespective of free/pro billing tier.
      const profile = await fetchProfile(ck, { timeout: 15000, proxy: accProxy });
      if (!taskActive(id)) return;
      if (!hasLiveSession(profile)) return fail(id, '未现场确认有效登录及账号身份，未提交');
      if (acc.sec_user_id && String(profile.entityId || profile.id || '') !== String(acc.sec_user_id)) {
        return fail(id, '现场账号身份与号池记录不一致，未提交');
      }
      const latest = db.prepare('SELECT * FROM dola_accounts WHERE id = ?').get(acc.id);
      if (!latest || latest.status !== 'valid' || latest.cookie_hash !== acc.cookie_hash || latest.proxy !== acc.proxy
          || latest.sec_user_id !== acc.sec_user_id || (latest.cooldown_until && latest.cooldown_until > now())) {
        return fail(id, '排队期间账号或代理已变化，未提交');
      }
      if (hasConfirmedZeroVideoQuota(latest)) return fail(id, '账号最新回执显示视频额度为 0，未提交');
      if (accountHasUnsettledSubmission(db, acc.id)) return fail(id, '账号有待核对的上游任务，未提交');
      sessionVerified = true;
    }
    if (hasGenerationGuard(db, acc.id, duration.seconds, Boolean(row.has_reference_images))) {
      return fail(id, '重复失败保护：账号能力状态已变化，未提交');
    }

    // ---- ① 提交（browser / scheme-a 双通道，见 dola_submit_mode 设置） ----
    if (!setStage(id, 'submitting', '正在提交生成请求')) return;
    const log = (s) => db.prepare(`UPDATE dola_videos SET stage=?, updated_at=? WHERE id=?
      AND status IN ('queued','submitting','generating','resolving')`).run(s, now(), id);
    let sub;
    try {
      log('正在通过账号的显式代理提交');
      const referenceImagePaths = row.has_reference_images
        ? await listReferenceImages(id)
        : [];
      if (row.has_reference_images && !referenceImagePaths.length) {
        return fail(id, '参考图文件缺失，无法提交');
      }
      // 提交通道：默认 browser（浏览器模拟提交）；dola_submit_mode=scheme-a 时走
      // 「abort 取签名 + 页内重放提交」通道（实验性，可随时在设置里切回）。
      const submitMode = resolveSubmitMode(getSetting('dola_submit_mode', 'browser'));
      const submitFn = submitMode === 'scheme-a' ? submitViaSchemeA : submitViaBrowser;
      if (submitMode === 'scheme-a') log('提交通道：方案A（abort 取签名 + 页内重放提交）');
      sub = await submitFn(acc.cookie, {
        prompt: row.prompt,
        seconds: duration.seconds,
        forceSeconds: duration.forceSeconds ?? duration.seconds,
        targetModel: duration.targetModel,
        ratio: row.ratio || '16:9',
        proxyUrl: accProxy, accountId: acc.id, log,
        sessionVerified, isActive: () => taskActive(id),
        referenceImagePaths,
        onDispatch: () => recordSubmissionDispatch(db, { taskId: id, account: acc,
          deadlineAt: new Date(Date.now() + maxMin * 60_000).toISOString() }),
        onConversation: (conversationId, evidence) => recordSubmissionConversation(db, id, conversationId, evidence),
      });
    } catch (e) {
      if (getSubmission(db, id) || e.code === 'GENERATION_SUBMISSION_UNCERTAIN') {
        holdUncertainSubmission(db, id);
        return;
      }
      return fail(id, `提交阶段失败：${e.message}`, acc);
    }
    if (!taskActive(id)) return;
    if (sub.submissionOutcome?.error) return holdUncertainSubmission(db, id, '上游回执关联或保存未确认，保留待核对；不会轮询其他会话、重新提交或退款');
    const wireNote = sub.wire
      ? `（浏览器生成请求：放行 ${sub.wire.forwarded} 次，阻断 ${sub.wire.blocked} 次）` : '';
    // 点了却没派发时，把现场取证（截图路径 + 按钮状态）一并写进失败原因，
    // 否则下次还是只能看到"放行 0 次"这种没法定位的话。
    const dispatchNote = sub.dispatch && sub.dispatch.dispatched === false
      ? `（点击后未派发：截图 ${sub.dispatch.shot || '无'}；`
        + `命中元素 ${(sub.dispatch.sendButton || []).map((b) => b.topAtCenter).filter(Boolean).join(',') || '未知'}；`
        + `disabled=${(sub.dispatch.sendButton || []).map((b) => b.disabled).join(',') || '-'}；`
        + `url ${sub.dispatch.urlAfter || '-'}）`
      : '';
    if (sub.submissionBlocked) {
      if (getSubmission(db, id)) return holdUncertainSubmission(db, id, '请求拦截与已记录的发送状态不一致，需核对原任务；不会退款或重新提交');
      return fail(id, `未确认 ${duration.targetModel === 'seedance_v2.0' ? 'Seedance 2.0' : 'Seedance 2.5'} 的原生 ${duration.seconds} 秒请求或任务已取消，已拦截提交；不会降级或拼接视频`);
    }

    if (!sub.conversationId || (sub.streamErrors || []).some(e => RATE_LIMIT_CODES.has(e.code))) {
      // 先看是不是上游限流 —— 这种情况**账号是好的**，别判死，给它冷却就行。
      // 冷却之后按 dola_autorotate_max_attempts 自动换号重试，而不是直接判任务失败。
      const rl = (sub.streamErrors || []).find((e) => RATE_LIMIT_CODES.has(e.code));
      if (rl) {
        const maxAttempts = Math.max(1, num('dola_autorotate_max_attempts', 3));
        const triedIds = [...new Set(
          db.prepare('SELECT account_id FROM dola_rate_limit_events WHERE video_id=?').all(id)
            .map((r) => Number(r.account_id)).concat([Number(acc.id)]),
        )].filter(Number.isSafeInteger);
        let switched = { account: null, skipped: [] };
        if (!row.strict_account && triedIds.length < maxAttempts && taskActive(id)) {
          switched = await switchTaskAccount(id, {
            excludeIds: triedIds,
            seconds: duration.seconds,
            requireReferenceImages: Boolean(row.has_reference_images),
          });
          if (!switched.account) {
            console.warn(`[gen] #${id} 限流换号：探测后无可用账号（跳过 ${switched.skipped.length} 个）`);
          }
        }
        let requeued = false;
        settleRejectedSubmission(db, id, () => {
        const mins = num('dola_ratelimit_cooldown_min', 30);
        const until = new Date(Date.now() + mins * 60_000).toISOString();
        db.prepare('UPDATE dola_accounts SET cooldown_until=?, last_error=?, updated_at=? WHERE id=?')
          .run(until, `上游限流（code=${rl.code} 访问频繁），冷却至 ${until.slice(11, 16)}`, now(), acc.id);
        // Keep an auditable, non-secret event for the 8788 operations panel.
        // The account remains valid; only its cooldown window changes.
        db.prepare(`INSERT INTO dola_rate_limit_events
          (code, account_id, video_id, exit_ip, cooldown_until, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(String(rl.code || 710022002), acc.id, id, acc.exit_ip || null, until,
            '上游返回访问频繁，已按出口隔离策略冷却账号', now());
        if (switched.account) {
          // 换号：本轮提交记录已终结（rejected），删掉它让下一轮能重新记录派发；
          // 审计留在 dola_rate_limit_events 里，不丢。任务回到排队，重新调度。
          // 状态守卫：换号期间任务若被取消/删除，不复活它。
          db.prepare('DELETE FROM dola_submission_journal WHERE task_id=?').run(id);
          const updated = db.prepare(`UPDATE dola_videos SET conversation_id=NULL, status='queued',
            stage=?, error='', updated_at=? WHERE id=?
            AND status IN ('queued','submitting','generating','resolving')`)
            .run(`上游限流，已自动换号为 #${switched.account.id} 重试（第 ${triedIds.length + 1}/${maxAttempts} 次）`,
              now(), id);
          requeued = updated.changes > 0;
          return;
        }
        const observed = requestCaptureNote(sub.cap) + wireNote + dispatchNote;
        const triedDesc = triedIds.length > 1
          ? `已自动轮询 ${triedIds.length} 个账号（${triedIds.map((n) => `#${n}`).join('、')}），均被上游限流；`
          : '';
        const noRotateReason = row.strict_account
          ? '锁定账号验收任务，不自动换号。'
          : triedIds.length >= maxAttempts
            ? `已达自动换号上限（${maxAttempts} 个账号）。`
            : (switched.skipped.length
              ? `换号探测无可用账号（跳过 ${switched.skipped.length} 个）。`
              : '账号池暂无可用账号。');
        return fail(id, `上游限流：当前服务访问频繁（code ${rl.code}）。`
          + `本次使用的账号会话仍有效，已进入冷却 ${mins} 分钟。`
          + triedDesc + noRotateReason
          // 注意别在这里写 markdown 的 ** 加粗 —— 这条消息会原样显示在前台表格里，
          // 星号会字面露出来。
          + `请核验出口与请求频率。`
          + (sub.loggedOut ? '（本次前端自毁会话已被拦截，cookie 仍然有效）' : '')
          + observed);
        });
        if (requeued) {
          // 把本轮的调度标记清掉，startVideoTask 才能重新排队；
          // 外层 finally 还会再清一次（幂等）。
          SCHEDULED_VIDEO_TASKS.delete(id);
          startVideoTask(id, { timeoutMinutes: maxMin });
        }
        return;
      }
      // 页面没跳会话页 → 多半是会话真的失效/被风控，把页面文案带出来方便判断
      const hint = sub.pageText ? `（页面回执：${sub.pageText.slice(0, 200)}）` : '';
      const outHint = sub.loggedOut ? '；页面已被登出（from_logout=1）' : '';
      if (getSubmission(db, id)) return holdUncertainSubmission(db, id, '已记录发送意图，但未取得可靠会话回执；请核对原任务，不要重复提交');
      return fail(id, `没拿到 conversationId，提交结果待核对，请勿重复提交${outHint}${hint}${requestCaptureNote(sub.cap)}${wireNote}${dispatchNote}`);
    }

    db.prepare(`UPDATE dola_videos SET conversation_id=?, status=?, stage=?, updated_at=? WHERE id=?
      AND status='submitting'`)
      .run(sub.conversationId, 'generating', '生成中（约 1～5 分钟）', now(), id);

    if (row.force_seconds) {
      const applied = Array.isArray(sub.cap) ? sub.cap.map((c) => `${c.model}: ${c.before}→${c.after}`).join(', ') : '未捕获';
      db.prepare("UPDATE dola_videos SET error=?, updated_at=? WHERE id=? AND status='generating'")
        .run(`时长请求捕获：${applied}`, now(), id);
    }

    await pollSubmittedVideo(id, { acc, accProxy, ck, duration, conversationId: sub.conversationId, maxMin,
      deadline: Date.parse(getSubmission(db, id)?.deadline_at || '') || Date.now() + maxMin * 60_000 });
  } finally {
    if (globalAcquired) release();
    releaseAccountLock();
  }
}

/** Shared query/archive path. This function cannot submit a generation request. */
async function pollSubmittedVideo(id, { acc, accProxy, ck, duration, conversationId, maxMin, deadline }) {
    const log = message => db.prepare("UPDATE dola_videos SET stage=?,updated_at=? WHERE id=? AND status IN ('generating','resolving')")
      .run(message, now(), id);
    let round = 0;
    let found = null;
    while (Date.now() < deadline) {
      if (!taskActive(id)) return;

      round++;
      const chain = await pullChain(conversationId, ck, { proxy: accProxy });
      if (!taskActive(id)) return;
      if (Date.now() >= deadline) break;
      if (!chain.ok) {
        log('会话轮询未确认成功，等待复查；不会重复提交');
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      const a = analyzeChain(chain.text);
      const elapsed = ((round * 1) && Math.round((maxMin * 60_000 - (deadline - Date.now())) / 1000)) || 0;
      const cr = a.cost ?? null;
      db.prepare("UPDATE dola_videos SET stage=?, updated_at=? WHERE id=? AND status='generating'")
        .run(`生成中 ${elapsed}s｜已轮询 ${round} 次${cr ? `｜本条约耗 ${cr} 额度` : ''}`, now(), id);

      // 只保存成功响应中明确的剩余额度，不从消耗量推算，也不刷新旧读数。
      // 生成期间账号凭据/出口被替换或被停用时，不能把旧会话读数写回。
      if (chain.ok && a.remaining != null) {
        db.prepare(`UPDATE dola_accounts SET quota_remaining=?, quota_source=?,
                    quota_at=?, updated_at=? WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'`)
          .run(a.remaining, 'generation_receipt', now(), now(), acc.id, acc.cookie_hash, acc.proxy);
      }

      if (a.vids.length) { found = { url: a.vids[0], quota: a }; break; }
      if (a.failed) {
        return settleRejectedSubmission(db, id, () => fail(id, '上游明确报「生成失败」；上游额度是否退还以实际回执为准'));
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }

    if (!found) {
      if (getSubmission(db, id)) return holdUncertainSubmission(db, id, '查询原任务到达时限，最终结果待核对；不会重新生成或自动退款');
      return fail(id, `等待 ${maxMin} 分钟仍未出现成片直链`);
    }

    if (!taskActive(id)) return;
    closeSubmission(db, id, 'completed');
    db.prepare(`UPDATE dola_videos SET watermarked_url=?, status=?, stage=?, updated_at=? WHERE id=?
      AND status='generating'`)
      .run(found.url, 'resolving', '成片已出，正在解析无水印版本', now(), id);

    // ---- ③ 无水印解析（允许失败，失败保留带水印兜底）----
    let unw = { videos: [], images: [], attempts: [] };
    let note = '';
    try {
      const chain = await pullChain(conversationId, ck, { limit: 50, proxy: accProxy });
      if (!taskActive(id)) return;
      unw = await extractUnwatermarked(chain.json, chain.text, { cookies: ck, proxy: accProxy });
      if (!taskActive(id)) return;
      if (unw.videos.length) {
        note = `无水印解析成功（${unw.videos[0].tokenForm}）`;
      } else {
        const reasons = (unw.attempts || []).map((x) => x.reason).filter(Boolean);
        note = unw.fallbackApis?.length
          ? `找到 ${unw.fallbackApis.length} 个 fallback_api 但解析失败：${[...new Set(reasons)].join(' / ') || '未知原因'}`
          : '消息链里没有 fallback_api 字段（可能该版本不提供无水印源）';
      }
    } catch (e) {
      note = `无水印解析异常：${e.message}`;
    }
    if (!taskActive(id)) return;

    const unwUrl = unw.videos?.[0]?.url || null;
    db.prepare(`UPDATE dola_videos SET unwatermarked_url=?, unwatermark_note=?, is_unwatermarked=?,
      stage='正在归档并验收真实时长', updated_at=? WHERE id=? AND status='resolving'`)
      .run(unwUrl, note, unwUrl ? 1 : 0, now(), id);

    // ---- ④ Stay nonterminal until the actual archived media passes validation. ----
    // Archive bytes replace the former unbounded HEAD request.
    const arch = await archiveVideo(id, { unwatermarkedUrl: unwUrl, watermarkedUrl: found.url });
    if (!taskActive(id)) return;
    const probe = arch ? await probeVideoDuration(arch.path) : { seconds: null, status: 'unreadable' };
    let durationSec = probe.seconds;
    let acceptNote = '';
    if (durationSec == null && probe.status === 'tool_missing' && arch) {
      // ffprobe 不可用是工具链问题：退回纯 Node 的 MP4 容器解析（mvhd 时长），
      // 不把已归档的好片误判为失败。容器解析替代不了逐帧读取，明确标注。
      const fallbackSeconds = await probeMp4ContainerDuration(arch.path);
      if (fallbackSeconds != null) {
        durationSec = fallbackSeconds;
        acceptNote = '（ffprobe 不可用，已改用 MP4 容器解析验证时长）';
      }
    }
    if (!taskActive(id)) return;
    const rejection = validateArchivedVideo(arch, durationSec, duration.seconds);
    if (arch) {
      db.prepare(`UPDATE dola_videos SET local_path=?, local_bytes=?, duration_sec=?, bytes=?, updated_at=?
        WHERE id=? AND status='resolving'`).run(arch.path, arch.bytes, durationSec, arch.bytes, now(), id);
    }
    if (rejection) {
      const messages = {
        archive_failed: '成片归档失败，未通过交付验收；不能仅凭临时直链标记成功',
        duration_unverified: probe.status === 'tool_missing'
          ? 'ffprobe 不可用且 MP4 容器解析也失败，未通过验收；文件已归档在本地，可手动核验'
          : '无法探测实际媒体时长（文件不可读或已损坏），未通过验收',
        duration_mismatch: `实际媒体时长 ${durationSec} 秒，不符合请求的 ${duration.seconds} 秒；未通过验收`,
      };
      return fail(id, messages[rejection]);
    }
    db.prepare(`UPDATE dola_videos SET status='ready', error='', stage=?, updated_at=?, finished_at=?
      WHERE id=? AND status='resolving'`)
      .run(`完成（已归档 ${(arch.bytes / 1048576).toFixed(2)} MiB；真实时长 ${durationSec.toFixed(2)} 秒${acceptNote}）`, now(), now(), id);
    void cleanupReferenceImages(id).catch(() => {});
}

function scheduleSubmissionRecovery(id) {
  if (SCHEDULED_VIDEO_TASKS.has(id)) return;
  SCHEDULED_VIDEO_TASKS.add(id);
  setImmediate(() => resumeSubmittedVideo(id).catch(() => {
    holdUncertainSubmission(db, id, '原任务恢复查询异常，保留待核对；不会重新生成或自动退款');
  }).finally(() => SCHEDULED_VIDEO_TASKS.delete(id)));
}

async function resumeSubmittedVideo(id) {
  let unlock = () => {}, acquired = false;
  try {
    const original = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
    if (!original || !taskActive(id)) return;
    unlock = await acquireAccount(original.account_id);
    await acquire(); acquired = true;
    const row = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
    if (!row || !taskActive(id)) return;
    const receipt = getSubmission(db, id);
    const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(row.account_id);
    if (!canRecoverSubmission(receipt, row, acc)) return holdUncertainSubmission(db, id, '原任务身份、代理、回执或查询时限已变化，需核对；不会换号查询');
    if (row.owner_token_id != null) {
      const consume = row.charge_ref ? db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref=?").get(row.charge_ref) : null;
      const refund = row.charge_ref ? db.prepare("SELECT 1 FROM point_transactions WHERE kind='refund' AND ref=?").get(row.charge_ref) : null;
      if (!consume || consume.token_id !== row.owner_token_id || !Number.isSafeInteger(consume.delta) || consume.delta <= 0 || refund) {
        return holdUncertainSubmission(db, id, '原任务计费待核对；不补扣、不重新提交');
      }
    }
    setStage(id, 'generating', '服务重启：继续查询原上游任务（不重新提交）');
    await pollSubmittedVideo(id, { acc, accProxy: requireGenerationProxy(acc.proxy), ck: parseCookies(acc.cookie),
      duration: normalizeVideoDuration({ seconds: row.seconds, forceSeconds: row.force_seconds }),
      conversationId: receipt.conversation_id, deadline: Date.parse(receipt.deadline_at),
      maxMin: (Date.parse(receipt.deadline_at) - Date.parse(receipt.sent_at)) / 60000 });
  } finally {
    if (acquired) release();
    unlock();
  }
}

// ---------------------------------------------------------------- 取消

export function cancelVideoTask(id) {
  const taskId = Number(id);
  const row = db.prepare('SELECT * FROM dola_videos WHERE id = ?').get(taskId);
  if (!row) return null;
  if (['queued', 'submitting', 'generating', 'resolving'].includes(row.status)) {
    // 已经提交出去的生成没法撤销（上游在做），只能不认这个结果；
    // 但 token 已经花了 —— 所以退款判定交给调用方（见 gateway 的 refund 逻辑）。
    //
    // ⚠️ 但**账号**不能跟着一起丢（原来就是这么丢的）：
    // 只要 journal 里还留着「上游可能已收到提交」的记录，
    // accountHasUnsettledSubmission() 就会永久排除这个账号 ——
    // 用户取消一次，钱没了、号也没了、还没有任何提示，而且运维层面无解。
    //
    // 所以这里必须把「需要人工核对」**显式写进 journal**，
    // 让它出现在 /api/dola/submissions 列表里（可被 resolve 处理），
    // 而不是静默躺成一条谁都看不见的死记录。
    const receipt = getSubmission(db, taskId);
    const needsReview = Boolean(receipt && PENDING_SUBMISSION_STATES.includes(receipt.state));
    if (needsReview) {
      // 必须在改 status 之前调用：holdUncertainSubmission 要求任务仍是 active 状态
      holdUncertainSubmission(db, taskId,
        '任务被取消，但上游可能已收到提交；请在「提交核对」里人工处理以放行账号');
    }
    db.prepare('UPDATE dola_videos SET status=?, stage=?, updated_at=? WHERE id=?')
      .run('cancelled', needsReview ? '已取消（上游可能已收到提交，账号待人工核对）' : '已取消', now(), taskId);
    void cleanupReferenceImages(id).catch(() => {});
  }
  return getVideoTask(id);
}

// ---------------------------------------------------------------- 未结算提交的人工出口

/**
 * 处理一条「卡住」的提交。这是 `uncertain` 状态**唯一的出口**。
 *
 * 背景：`dispatching`/`uncertain`/`acknowledged` 会把账号和提示词一直锁住，
 * 而 `closeSubmission` 只接受 `rejected`/`completed` 两个终态 ——
 * 也就是说 uncertain 一旦写入，原本没有任何代码路径能离开它，
 * 管理端也没有任何路由能操作它，只能人肉改数据库。
 * 而 holdUncertainSubmission 在文件里有 10 处调用，连"服务重启"都会命中。
 *
 * 两种处理方式（都是显式运维决策）：
 *
 *   - `'failed'`  → 确认上游没产出：任务落 `failed`，**并把积分退给用户**（走既有幂等退款）
 *   - `'release'` → 放行账号：journal 推到 `released`，账号重新可用，**钱不动**
 *
 * 注意 `release` 不会静默把任务标成失败 —— 上游事实未知就不假装知道，
 * 只在 stage 上留一句"已人工核对"，其余交给操作人。
 *
 * @param {number|string} id            dola_videos.id（也就是 journal 的 task_id）
 * @param {{resolution:'failed'|'release', note?:string}} opts
 */
export function resolvePendingSubmission(id, { resolution, note = '' } = {}) {
  const taskId = Number(id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw Object.assign(new Error('任务 ID 不合法'), { status: 400 });
  }
  const receipt = getSubmission(db, taskId);
  if (!receipt) throw Object.assign(new Error('没有这条提交记录'), { status: 404 });
  if (!PENDING_SUBMISSION_STATES.includes(receipt.state)) {
    throw Object.assign(new Error(`当前状态 ${receipt.state} 不需要处理`), { status: 409 });
  }
  const row = getVideoTask(taskId);
  if (!row) throw Object.assign(new Error('任务不存在'), { status: 404 });

  if (resolution === 'release') {
    const from = releaseSubmission(db, taskId);
    // 只补一句 stage 让人在任务列表里看得见；**不动 status**（上游事实未知）
    db.prepare('UPDATE dola_videos SET stage=?, updated_at=? WHERE id=?')
      .run(`已人工核对放行（原状态：${from}，账号可复用）`, now(), taskId);
    return { resolution, from, taskStatus: row.status, refunded: 0 };
  }

  if (resolution === 'failed') {
    if (row.status === 'ready') {
      throw Object.assign(new Error('该任务已产出成片，不能按失败处理；请核对后放行账号'), { status: 409 });
    }
    let refunded = 0;
    // 复用「拒绝 + 结算」的原子组合（savepoint submission_journal 包住 generation_billing）
    settleRejectedSubmission(db, taskId, () => {
      // 强制落到 failed：原本可能是 cancelled（取消时没退款），也可能是 active
      db.prepare(`UPDATE dola_videos SET status='failed', error=?, stage=?, updated_at=?, finished_at=? WHERE id=?`)
        .run(String(note || '人工核对确认上游未产出').slice(0, 500),
          '失败（人工核对：上游未产出）', now(), now(), taskId);
      refunded = settleFailedVideoRefund(db, getVideoTask(taskId))?.points || 0;
    });
    void cleanupReferenceImages(taskId).catch(() => {});
    return { resolution, refunded, taskStatus: 'failed' };
  }

  throw Object.assign(new Error('resolution 只能是 failed 或 release'), { status: 400 });
}
