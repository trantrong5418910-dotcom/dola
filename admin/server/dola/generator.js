/**
 * dola 视频生成编排器（服务端常驻版）。
 *
 * 把 verify-flow.mjs 里那套已验证的流程搬到服务里，并补上「无水印解析」：
 *
 *   queued → submitting（开浏览器提交，拿到 conversationId，**归还浏览器会话**）
 *          → generating（纯 HTTP 轮询 /im/chain/single 等成片）
 *          → resolving（发现 fallback_api，解析无水印直链）
 *          → ready / failed / cancelled
 *
 * 三个踩过的关键点，别再犯：
 *   ① **不要开着浏览器等结果**。用 page.reload() 循环等结果的做法会踢掉会话
 *      （每次开浏览器在风控眼里像"换设备登录"），而且 SPA 重载根本拿不到新消息。
 *      ★ 2026-09-26 更新：浏览器改为**会话池复用**（见 browser-sessions.js）——
 *      同一账号连续任务共用同一实例，只有空闲超时才真关。这样既避免了
 *      "换设备登录"，也保留了「关浏览器 = HTTP 缓存 flush 到磁盘」的时机。
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
import { parseCookies, getPlaywright, fetchProfile, DOLA_HEADERS, toPlaywrightCookies } from './provider.js';
import { pullChain, extractUnwatermarked } from './unwatermark.js';
import { proxyOf } from './proxy.js';
import { startSocksBridge } from './socks-bridge.js';
import { parseVideoQuotaReceipt } from './account-observations.js';
// 出口地区（geo）封锁码。★ 与 RATE_LIMIT_CODES / SESSION_DEAD_CODES **分属不同集合**：
//   geo 封锁 = 账号会话是好的、代理也通，只是**出口 IP 落地的国家/地区**不被上游支持。
//   混进限流集合会让系统对着"地区不可用"说"访问频繁"（详见 geo-block.js 文件头）。
import { isGeoBlockedCode, geoBlockedKind, describeGeoBlock,
  GEO_BLOCK_REMARK, GEO_BLOCK_COOLDOWN_MIN, GEO_COOLDOWN_SETTING } from './geo-block.js';
// ★ 出口地区**实测**（2026-09-28 新增）。与 geo-block.js 的关系：
//   geo-block 处理「上游**主动告诉我们**这个出口不行」（回 710022003 / 710022017）；
//   exit-region 处理「上游不说、但我们自己**测出来**这个出口不行」
//   （实测 5 个号的代理声明 HK、出口却落在 VE/PS，且 ipweb 的 8 个号全是真 HK）。
//   为什么必须自己测：`pickLiveAccount()` 的预检打 `/alice/profile/self_brief`，
//   而真正受限的是 `/chat/completion` —— 同一出口在不同接口族白名单不同，
//   所以预检在**结构上**就拦不住坏出口，坏出口会一路走到提交、烧光换号预算。
//   详细取证与"出口按连接/会话分配"的实测结论见 exit-region.js / exit-probe.js 文件头。
import { declaredRegionOf, exitRegionVerdict, exitRegionMismatchKind, describeExitRegionMismatch,
  describeExitRegionMatch, EXIT_REGION_REMARK, EXIT_REGION_COOLDOWN_MIN, EXIT_REGION_SKIP_CODE,
  EXIT_REGION_COOLDOWN_SETTING } from './exit-region.js';
import { probeExitCountry } from './exit-probe.js';
import { acquireSession, releaseSession, invalidateSession, sessionStats } from './browser-sessions.js';
import { tryAcquireAccountBrowserLock } from './account-browser-lock.js';
// 提示词包装（前缀/中缀/后缀）。见 prompt-wrap.js 文件头：只作用于发给上游的那一刻。
import { upstreamPrompt } from './prompt-wrap.js';
// 上游文本分类 + 协议漂移告警（对标参考站的 chain_text_rules_total / protocol_drift）。
// 见 chain-text-rules.js 文件头：纯计数，不碰数据库、不发网络。
import { classifyChainText, recordChainText, readChainClarifying, readChainRefused } from './chain-text-rules.js';
// 失败分调度（对照参考站 fail_score 机制，见 account-score.js 文件头）：
// 选号排序、成败记账、最短提交间隔（让早已配置的 dola_gen_min_submit_interval_sec 真正生效）。
import { recordTaskSuccess, recordTaskFailure, markAccountSubmitted, rankCandidates, submitThrottle,
  routeRow, FAIL_SCORE_CAP, FAIL_SCORE_DECAY_PER_HOUR } from './account-score.js';
import { settleFailedVideoRefund } from './generation-billing.js';
import { hasGenerationGuard, recordGenerationGuard } from './generation-guards.js';
import { installVideoRequestAdapter, installVideoRequestWire, getVideoRequestWire, disposeVideoRequestWire } from './generation-request.js';
import { DURATION_SOURCE, resolveDurationCarrierMap,
  uiCarrierSeconds } from './generation-duration.js';
import { prepareNativeVideoComposer, prepareReferenceImageComposer } from './native-capability.js';
import { observeVideoComposerBootstrap } from './composer-bootstrap.js';
import { fillAndSubmitVideoPrompt } from './generation-submit.js';
import { submitViaSchemeA, chooseSubmitMode } from './scheme-a.js';
import { submitViaPureHttp } from './pure-http.js';
import { createGenerationWireGate } from './generation-wire.js';
import { solveSliderIfPresent } from './generation-captcha.js';
import { resolveFfprobePath, probeMp4ContainerDuration } from './media-probe.js';
import { identifyGenerationRequest, createGenerationAckObserver } from './generation-ack.js';
import { getSubmission, recordSubmissionDispatch, recordSubmissionConversation, holdUncertainSubmission,
  closeSubmission, settleRejectedSubmission, accountHasUnsettledSubmission, canRecoverSubmission,
  releaseSubmission, PENDING_SUBMISSION_STATES } from './submission-journal.js';
import { listReferenceImages, cleanupReferenceImages } from './reference-image-store.js';
import {
  normalizeVideoDuration, DEFAULT_VIDEO_SECONDS, requireGenerationProxy, hasLiveSession,
  isActiveGenerationStatus, validateArchivedVideo, hasConfirmedZeroVideoQuota,
  SUPPORTED_VIDEO_SECONDS, RETIRED_VIDEO_SECONDS,
} from './generation-policy.js';

const now = () => new Date().toISOString();
const execFileAsync = promisify(execFile);
const num = (k, d) => {
  const v = Number(getSetting(k, String(d)));
  return Number.isFinite(v) && v > 0 ? v : d;
};
const bool = (k, d = false) => String(getSetting(k, d ? 'true' : 'false')) === 'true';

/**
 * 是否允许把页面上游合成档位（`30s (15s ×2)`）当作 30 秒可用证据。
 *
 * 默认关闭：它改变的是"我们愿意把什么算成 30 秒任务"这个口径，属于要显式拍板的事。
 * 开启后，30 秒多一条路 —— 页面自己标着 30 秒的合成档位，拆段与首尾相接都在上游完成，
 * 交回来的是一条连续成片，所以本地不跑 ffmpeg、没有拼接导致的时长漂移。
 */
const upstreamConcatEnabled = () => bool('dola_upstream_concat', false);

/**
 * 30 秒「短档位载体 + 请求改写」通道开关。
 *
 * ⚠️ **默认 `false`，等于现行为**：30 秒仍然要求账号 `native_30s_state = 'available'`，
 *    所以这个改动上线本身不改变线上任何行为；要开放 30 秒必须显式把设置改成 true。
 *
 * 为什么需要它（2026-09-25 实测）：三处硬门禁（选号池过滤 / 只读预检陈旧判定 /
 * 路由诊断排除原因）都要求 30 秒账号有 `native_30s_state = 'available'`，
 * 而这个字段只能由探针写成 available，探针又要求「页面有原生 15 秒载体」——
 * 服务端 `video-duration` 控件实测**只下发 5s/10s**，15s 在配置层面不存在。
 * 于是 30 秒在整条链上永久不可达，跟"上游到底收不收 30 秒"是两件事。
 *
 * 打开后的验收口子不在入口而在出口：归档阶段用 ffprobe 量真实时长，
 * 不达标走 `fail()` → 自动退款（见 `validateArchivedVideo` / `settleFailedVideoRefund`）。
 */
const allow30sRewrite = () => bool('dola_allow_30s_rewrite', false);

/**
 * 本次生效的载体映射。显式配置优先，没配就按开关取内置默认。
 * 必须**同一个值贯穿探测与生成**，否则会出现"探针说可用、生成选不到档位"。
 */
const durationCarrierMap = () => resolveDurationCarrierMap({
  configured: getSetting('dola_duration_carrier_map', ''),
  allowRewrite: allow30sRewrite(),
});

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
 * 归档阶段最多试几个成片候选。
 *
 * 上游合成档位会把一次任务拆成两段生成，消息链里可能既有中间段也有成品；
 * 只取第一个直链有可能把 15 秒中间段当成 30 秒交付。给到 3 个候选是
 * 「够覆盖中间段 + 成品」和「不无节制下载」之间的折中。
 */
const MAX_ARCHIVE_ATTEMPTS = 3;

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
  id, account_id, account_label, conversation_id, prompt, ratio, mode, seconds, force_seconds,
  status, stage, watermarked_url, unwatermarked_url, unwatermark_note, is_unwatermarked,
  local_path, local_bytes,
  duration_sec, bytes, error, owner_token_id, owner_prefix, charge_ref,
  cleared_at,
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
 * 每个账号「到达过上游」的次数：该账号在 `dola_videos` 里有过 `conversation_id`
 * 的提交条数。**纯读**，不写任何东西。
 *
 * 为什么在选号前现算，而不是给 `dola_accounts` 加一列：
 *   · 这是 `rankCandidates()` 的**首排序键**（有实绩者优先），语义上属于「证据」；
 *   · 加列就要维护一条写入路径（在哪些地方 +1、任务被删要不要 -1、历史怎么回填），
 *     而写入路径一旦和上游回执不同步，就会静默地把选号带偏；
 *   · `dola_videos` 的规模是"每天几条"，聚合成本可忽略，而正确性是可现算的。
 *
 * 判据是 `conversation_id` 非空（= 上游回过会话/任务 id），**不是** journal 的 state：
 *   710022002 这类被出口/验签层挡回的拒绝**同样是** `journal.state='rejected'`，
 *   但它的 conversation_id 是空的（生产实测 #442 / #436）。用 state 当判据会把
 *   "连门都没进去"的号误判成"有实绩"，正好把这次要修的病重新种回去。
 */
function upstreamReachedCounts() {
  const rows = db.prepare(`SELECT account_id, COUNT(*) AS n FROM dola_videos
                            WHERE COALESCE(conversation_id, '') <> ''
                            GROUP BY account_id`).all();
  return new Map(rows.map((r) => [Number(r.account_id), Number(r.n) || 0]));
}

/** 给账号列表挂上 `upstream_reached`（`rankCandidates()` 首键的输入）。返回新数组。 */
function attachUpstreamReached(accounts) {
  const counts = upstreamReachedCounts();
  return accounts.map((account) => ({ ...account, upstream_reached: counts.get(Number(account.id)) || 0 }));
}

/**
 * 挑一个可用账号：优先用指定的，否则在 valid 里挑「最久没用过的」。
 *
 * 为什么按 last_used_at 排而不是随机：同一 IP 高频操作多账号会被风控（已经踩过：
 * 8 个号批量操作后失效 3 个）。轮转能让单号的使用频率尽量均匀，别可着一个号薅。
 */
function candidates(preferId = null, seconds = null, { requireReferenceImages = false, strictAccount = false, excludeIds = null } = {}) {
  const nowIso = now();
  const nowMs = Date.parse(nowIso) || Date.now();
  const minIntervalSec = num('dola_gen_min_submit_interval_sec', 60);
  const exclude = new Set((excludeIds || []).map((v) => Number(v)).filter(Number.isSafeInteger));
  // free/pro are billing labels, not evidence that a requested duration is supported.
  // 跳过已有冷却中的账号；710022002 不再按限流设置冷却。
  const pool = db.prepare(`SELECT * FROM dola_accounts
                           WHERE status = 'valid'
                             AND TRIM(COALESCE(proxy, '')) <> ''
                             AND (cooldown_until IS NULL OR cooldown_until <= ?)
                             AND (? IS NULL OR id = ?)
                           ORDER BY COALESCE(last_used_at, '') ASC, id ASC LIMIT 200`)
    .all(nowIso, strictAccount ? Number(preferId) : null, strictAccount ? Number(preferId) : null);
  // A proxy URL/SID alone does not establish the real exit IP.
  // Keep this gate read-only: proxy assignment/rotation is an explicit
  // maintenance action, never an implicit side effect of generation.
  const rest = pool
    .filter((account) => !exclude.has(Number(account.id)))
    .filter((account) => !ACCOUNT_SELECTION_RESERVATIONS.has(account.id))
    .filter((account) => !accountHasUnsettledSubmission(db, account.id))
    .filter((account) => !hasConfirmedZeroVideoQuota(account, nowIso))
    .filter((account) => !hasGenerationGuard(db, account.id, seconds, requireReferenceImages))
    .filter((account) => !generationExitIpIssue(account))
    // ★ 登录态「已确认未登录」的账号直接排除（对照参考站 §4 把 unsigned「未登录」列成独立状态、不参与调度）。
    //    只排除**有明确否定证据**的（unavailable）；unknown 一律放行 ——
    //    参考站的新号先入 standby、不立即探活（懒激活："等号池不够用了再探"），
    //    "没探过"绝不等于"不可用"，否则一次发版就能把整个号池清空。
    //    为什么 10 秒也必须有这道闸：下面两条原生能力闸只盖 15/30 秒，
    //    而线上真正在跑的是 **10 秒**任务 —— 于是没有任何闸能拦住一个连创作输入框都拿不到的号，
    //    每次都白等最多 3 分钟（60s 等输入框 + 60s 刷新 + 60s 再等，见本文件提交段的 BOOT_MS）。
    .filter((account) => account.login_state !== 'unavailable')
    // 能力缓存只作诊断，不代替本次真实页面或上游回执。unknown 不等于失败；
    // 模型、时长、参考图上传在任务进入 submitting 后按实际页面处理。
    // ★ 最短提交间隔：刚向上游派发过的号先缓缓（dola_gen_min_submit_interval_sec 的第一个真实使用点，
    //    这个设置早就存在但生成路径从没读过）。所有号都在间隔内时任务留在 queued，
    //    下一轮 dispatch 自然再试 —— 这就是节流本身，不需要额外等待逻辑。
    .filter((account) => !submitThrottle(account, minIntervalSec, nowMs).throttled);
  // ★ 选号排序（对照参考站 /admin/route，但**首键按本项目实测改过**）。
  //    原来的纯 last_used_at 轮转会让"最近连续失败"的号只要最久没用就被第一个选中。
  //    ★ 2026-09-28 追加「有实绩者优先」为首键。⚠️ `attachUpstreamReached()` 必须挂在
  //      这里 —— 不挂的话 `upstream_reached` 恒为 0，所有号在该键上并列，
  //      排序退化成改前的"额度多者优先"，于是下面 `slice(0, 8)` 又会把
  //      5 个有实绩的号全部切掉，死锁原样复发（详见 account-score.js 的长注释）。
  const ranked = rankCandidates(attachUpstreamReached(rest), { nowMs });
  if (!preferId) return ranked.slice(0, 8);
  // 指定的号排最前，**但不是唯一选项** —— 它体检不过时会自动落到后面的轮转队列，
  // 而不是直接报"没有可用账号"。
  const pref = ranked.find((a) => a.id === Number(preferId));
  if (strictAccount) return pref ? [pref] : [];
  if (!pref) return ranked.slice(0, 8);
  return [pref, ...ranked.filter((a) => a.id !== pref.id)].slice(0, 8);
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
 *
 * ## 两阶段（2026-09-28 拆开，原来只有阶段 2）
 *
 *   阶段 1  出口地区预筛  —— 便宜（~0.7s）、**并发**、看 `exitPreScreenLimit` 个
 *   阶段 2  会话体检      —— 贵（15s 超时）、逐个、最多 `accountProbeLimit` 个
 *
 * 为什么必须拆：阶段 2 的名额是稀缺资源（3 个），而坏出口的号**会话体检是通过的**
 * （`/alice/profile/self_brief` 走的是宽白名单接口族），于是它们一路通过体检、
 * 占掉名额、直到提交才被上游拒。拆开后坏出口在阶段 1 就被筛掉，
 * 阶段 2 的 3 个名额全留给真正可能可用的号。
 */
/**
 * 单次挑号**最多体检几个账号**（延迟上限，不是"池子有多大"）。
 *
 * ⚠️ 这个数字以前是硬编码的 `probe = 3`，而 `candidates()` 其实返回前 8 个。
 *    于是池子里 5 个候选全都不通时，报出来的话是
 *    「账号池里没有可用账号（status=valid）」—— **这是一句谎话**：
 *    真实情况是"只试了 3 个，另外 2 个压根没试"。
 *    排查的人会去查代理、查 cookie、查号池，而真相只是"试的个数不够"。
 *
 * 为什么不能直接把上限调大：每个候选是一次 15 秒超时的真实出站探测，
 * 试满 8 个最多 120 秒 —— 那是**把排障成本换成了接口延迟**。
 * 所以这里保留上限（可配置），但**把"被截断了"这件事如实说出来**。
 */
const accountProbeLimit = () => Math.max(1, num('dola_account_probe_limit', 3));

/**
 * 出口地区预筛**最多看几个候选**（阶段 1）。
 *
 * 为什么要单独一个、而且比 `accountProbeLimit` 大：两个阶段的**成本差一个数量级**。
 *   阶段 1（出口地区）：一次 ipinfo，实测 ~0.7s，而且可以**并发**打；
 *   阶段 2（会话体检）：一次 `/alice/profile/self_brief`，超时 15s，只能逐个来。
 * 原来只有阶段 2，于是「坏出口」会占掉那 3 个宝贵的体检名额 ——
 * 生产上那句话就是这么来的：「已自动轮询 3 个账号…换号探测无可用账号（跳过 1 个）」，
 * 3 个名额全被坏出口吃掉，后面 5 个健康号**压根没被试**。
 * 拆成两阶段之后，坏出口在便宜的那一层就被筛掉，不再消耗贵的名额。
 *
 * 上限 12 是防止有人把设置调成天文数字后，选号变成一次全池普查。
 */
const exitPreScreenLimit = () => Math.max(1, Math.min(12, num('dola_exit_prescreen_limit', 6)));

/**
 * 阶段 1：出口地区预筛 —— **实测**每个候选的出口国家，与代理声明地区比对。
 *
 * 判定与处置沿用 `geo-block.js` 的语义（**不标 invalid**、**不写限流事件表**），
 * 理由见 `exit-region.js` 文件头：号是好的，坏的是出口。
 *
 * ⚠️ 三条必须保持的性质：
 *   1. **并发探测**（`Promise.all`）。串行 6 个 × 0.7s 会把选号拖慢 4 秒；
 *      而并发 6 条连接各发 1 个请求对代理毫无压力。
 *   2. **fail-open**：`!exit.ok`（代理不通/超时/socks5 不支持）时**放行**，
 *      交给阶段 2 去判。基础设施故障绝不能被判成"地区错配"——
 *      那会给好号写错误的冷却，正是本项目已经写死过的铁律。
 *   3. **声明不出地区就不判**（`declaredRegionOf` 返回 null）—— 宁可不说，也别瞎断言。
 *
 * @returns {Promise<object[]>} 通过预筛的账号（保持入参顺序）；被筛掉的已 push 进 `skipped`
 */
async function screenExitRegions(accounts, { strictAccount, skipped, probed }) {
  // 已被别的并发选号预留的号不重复探测：省一次请求，也不与别人的预留窗口抢时序。
  const targets = accounts.filter((acc) => declaredRegionOf(acc.proxy)
    && !ACCOUNT_SELECTION_RESERVATIONS.has(acc.id));
  if (!targets.length) return accounts;

  const probes = await Promise.all(targets.map((acc) => probeExitCountry(acc.proxy)));
  const rejected = new Set();
  targets.forEach((acc, index) => {
    const declared = declaredRegionOf(acc.proxy);
    const exit = probes[index];
    probed.exitChecked++;
    if (!exit.ok) {
      // 探不出来 = 不知道，不是"坏"。如实计数，供排障看比例。
      probed.exitUnknown++;
      return;
    }
    if (exitRegionVerdict({ declared, actual: exit.country }) !== 'mismatch') return;
    probed.exitMismatched++;
    rejected.add(acc.id);
    skipped.push({
      id: acc.id, label: acc.label,
      // 哨兵码（不是上游码）：让调用方能把这条**单独拎出来引导**，
      // 而不是和其它跳过原因混在一起触发"去查 cookie / 代理地址"的通用话术。
      code: EXIT_REGION_SKIP_CODE,
      kind: exitRegionMismatchKind({ declared, actual: exit.country, ip: exit.ip }),
    });
    console.warn(`[gen] 账号 #${acc.id}（${acc.label}）出口地区与代理声明不一致`
      + `（声明 ${declared}，实测 ${exit.country} ${exit.ip}），跳过且不改状态`);
    // 与 geo 封锁同一套处置：短冷却 + 写清"要做什么"。
    // ⚠️ 锁定账号验收（strictAccount）时**不写冷却**，理由与 geo 分支完全相同：
    //    候选只有指定那一个号，写了冷却它就会被 `candidates()` 过滤掉 →
    //    `skipped` 为空 → 对外报"账号池里没有可用账号"，真正的地区原因反而消失。
    if (!strictAccount) {
      const mins = num(EXIT_REGION_COOLDOWN_SETTING, EXIT_REGION_COOLDOWN_MIN);
      const until = new Date(Date.now() + mins * 60_000).toISOString();
      db.prepare('UPDATE dola_accounts SET cooldown_until=?, last_error=?, updated_at=? WHERE id=?')
        .run(until, `${EXIT_REGION_REMARK}（声明 ${declared}，实测 ${exit.country} ${exit.ip}），`
          + `冷却至 ${until.slice(11, 16)}`, now(), acc.id);
    }
  });
  return accounts.filter((acc) => !rejected.has(acc.id));
}

async function pickLiveAccount(preferId = null, { probe = null, seconds = null, requireReferenceImages = false, strictAccount = false, excludeIds = null } = {}) {
  const list = candidates(preferId, seconds, { requireReferenceImages, strictAccount, excludeIds });
  const skipped = [];
  // 两条路径（创建 / 换号）以前一个用 3 一个用 5，口径不一致且都写死。
  // 现在统一走设置，`probe` 只在调用方确实要覆盖时才传。
  const limit = Math.max(1, Number(probe) || accountProbeLimit());
  const probed = { tried: 0, available: list.length, limit,
    // 阶段 1 的计数：让"为什么只剩这么少候选"在日志/回执里可算，而不是靠猜。
    exitChecked: 0, exitMismatched: 0, exitUnknown: 0 };
  // ★ 阶段 1：出口地区预筛（便宜、并发）。先看 `exitPreScreenLimit` 个，
  //    把坏出口挡在阶段 2 之前 —— 否则它们会吃掉那 3 个昂贵的体检名额。
  const preLimit = Math.max(limit, Math.min(list.length, exitPreScreenLimit()));
  const pre = list.slice(0, preLimit);
  // ⚠️ 没有任何候选带地区声明时（例如普通 http 代理，或 URL 里没写 `-region-`），
  //    预筛是**空操作** —— 此时连一次 `await` 都不做，直接沿用原列表。
  //    为什么刻意省这一次微任务让渡：`pickLiveAccount` 处在提交路径的**时序敏感**位置上
  //    （`createVideoTask` 的调用方按微任务格数对齐观测点），空转一次等于白让出一格。
  //    行为上等价，成本上不为零，所以不值得为"代码更整齐"付这个代价。
  const shortlist = pre.some((acc) => declaredRegionOf(acc.proxy))
    ? await screenExitRegions(pre, { strictAccount, skipped, probed })
    : pre;
  for (const acc of shortlist.slice(0, limit)) {
    probed.tried++;
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
        return { account: acc, skipped, probed };
      }

      if (SESSION_DEAD_CODES.has(Number(r.code))) {
        // 明确死了 → 才敢写状态
        skipped.push({ id: acc.id, label: acc.label, code: r.code, kind: `code=${r.code}` });
        db.prepare("UPDATE dola_accounts SET status='invalid', last_check_at=?, last_error=?, updated_at=? WHERE id=?")
          .run(now(), `生成前体检失败：self_brief code=${r.code}（会话已失效）`, now(), acc.id);
        console.warn(`[gen] 账号 #${acc.id}（${acc.label}）会话已失效（code=${r.code}），已标 invalid 并跳过`);
        continue;
      }

      // ★ 出口地区不受支持（geo 封锁，如 710022003 / 710022017）。
      //    这类账号**会话有效、代理也通**，坏的是"这个出口 IP 落地的国家/地区"。
      //    因此和下面那条一样**不改 status**，但比"未知原因"多做两件事：
      //      ① 把原因写清楚（含上次核验到的出口 IP）—— 原来只报 `HTTP 200 code=710022003`，
      //         排查的人得先知道这一串数字是"地区不可用"才看得出方向；
      //      ② 给**自动调度**路径一个短冷却，别让同一个坏出口被反复撞
      //         （出口是粘性的：不重拨就一直撞同一面墙）。
      //    ⚠️ 冷却**只在非锁定路径写**：strictAccount（锁定账号验收）时候选只有指定的那一个号，
      //       它一旦进入冷却就会被 `candidates()` 的冷却过滤掉 → `skipped` 为空 →
      //       对外报的是「账号池里没有可用账号（status=valid）」，真正的地区原因反而消失。
      //       那正是本次故障要消灭的假信息，所以锁定路径只报原因、不写冷却。
      if (isGeoBlockedCode(r.code)) {
        skipped.push({ id: acc.id, label: acc.label, code: r.code, exitIp: acc.exit_ip || '',
          kind: geoBlockedKind({ code: r.code, exitIp: acc.exit_ip }) });
        console.warn(`[gen] 账号 #${acc.id}（${acc.label}）出口地区不受支持（code=${r.code}），跳过且不改状态`);
        if (!strictAccount) {
          const mins = num(GEO_COOLDOWN_SETTING, GEO_BLOCK_COOLDOWN_MIN);
          const until = new Date(Date.now() + mins * 60_000).toISOString();
          // 写 cooldown_until 让它暂时退出选号；写 last_error 让运维在账号列表里看到"要做什么"。
          // ★ 刻意**不写 dola_rate_limit_events**：那张表的语义是"上游限流"，
          //   geo 不是限流，混进去会让后续所有基于它的限流分析跟着错
          //   （语义污染的老毛病，见 geo-block.js 文件头）。
          db.prepare('UPDATE dola_accounts SET cooldown_until=?, last_error=?, updated_at=? WHERE id=?')
            .run(until, `${GEO_BLOCK_REMARK}（code=${r.code}），冷却至 ${until.slice(11, 16)}`, now(), acc.id);
        }
        continue;
      }

      // 其余情况（HTTP 非 200、未知 code、超时…）**不动账号状态**
      skipped.push({ id: acc.id, label: acc.label, code: r.code ?? null, kind: `HTTP ${r.status} code=${r.code ?? '-'}` });
      console.warn(`[gen] 账号 #${acc.id}（${acc.label}）体检没通过但原因不是会话失效（HTTP ${r.status} code=${r.code ?? '-'}），跳过且不改状态`);
    } finally {
      if (!keepReservation) ACCOUNT_SELECTION_RESERVATIONS.delete(acc.id);
    }
  }
  return { account: null, skipped, probed };
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
  const picked = await pickLiveAccount(null, { seconds, requireReferenceImages, excludeIds });
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
/** Recheck only account safety after the asynchronous live-session selection. */
function assertGenerationAccountSnapshot(acc, seconds, requireReferenceImages) {
  const current = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(acc.id);
  if (!current || current.status !== 'valid'
      || accountHasUnsettledSubmission(db, acc.id)
      || current.login_state === 'unavailable'
      || hasConfirmedZeroVideoQuota(current)
      || ['cookie_hash', 'proxy', 'sec_user_id', 'exit_ip'].some(key => current[key] !== acc[key])
      || (current.cooldown_until && current.cooldown_until > now())
      || generationExitIpIssue(current)
      || hasGenerationGuard(db, acc.id, seconds, requireReferenceImages)) {
    throw Object.assign(new Error('选号期间账号或代理状态变化，请重新提交；未建任务、未扣积分'), {
      status: 409, code: 'GENERATION_ACCOUNT_CHANGED',
    });
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
    const { account: acc, skipped, probed } = await pickLiveAccount(accountId, { seconds: duration.seconds, requireReferenceImages: Boolean(hasReferenceImages), strictAccount });
    if (!acc) {
      // ★ 如实说明"试了几个 / 池里还有几个没试"。
      //   以前不管试了几个都报「账号池里没有可用账号」，池子明明还有候选没体检时这是假信息，
      //   会把人往"代理坏了 / cookie 过期了"上带，而真相只是本次体检名额用完了。
      //
      // ⚠️ 2026-09-28：选号拆成两阶段后，"试了几个"必须**分段报**。
      //    原来只报 `probed.tried`（会话体检数），于是出口预筛淘汰掉唯一候选时会说出
      //    「本轮体检的 0 个账号都没通过」—— 读起来像"一个都没试就失败了"，
      //    而真相是"便宜的出口预筛先淘汰了它，贵的会话体检一次都没跑"。
      //    这两种情况对排障的含义完全不同，不能糊成一句。
      //    （这段是被 `ui-e2e-exit-region-guard.mjs` 的真实回执照出来的。）
      const preScreened = Number(probed?.exitMismatched || 0);
      const untested = probed ? Math.max(0, probed.available - probed.tried - preScreened) : 0;
      const shortfallParts = [];
      if (preScreened) shortfallParts.push(`出口地区预筛淘汰 ${preScreened} 个（未进入会话体检）`);
      if (probed?.tried) shortfallParts.push(`会话体检 ${probed.tried} 个都没通过`);
      if (untested) shortfallParts.push(`池里还有 ${untested} 个候选尚未体检（单次体检有延迟上限，可用 dola_account_probe_limit 调整）`);
      // ⚠️ 这里不能出现 markdown 的 `**` 加粗 —— 整句会原样显示在接口回执与前台表格里，
      //    星号会字面露出来（原来那版 `**尚未体检**` 就是这个毛病）。
      const head = shortfallParts.length
        ? `本轮共 ${probed.available} 个候选：${shortfallParts.join('；')}`
        : '账号池里没有可用账号（status=valid）';
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
      // ★ 出口地区（geo）单独拎出来说。这类原因的**方向和其他完全不同**：
      //   不是"没配代理 / 代理不通 / 号没登录"（这些代理配了也通），而是
      //   **那个出口 IP 落地的国家/地区**被上游拒绝。
      //   原先它们和其它原因平等地拼进 `detail`，而后面的引导词让人去查 cookie、
      //   查代理地址 —— 方向正好错开，白花排查时间（2026-09-27 那次就是如此）。
      const geo = skipped.filter((s) => isGeoBlockedCode(s.code));
      const geoHint = geo.length
        ? `本次跳过中有 ${geo.length} 个账号（${geo.map((s) => `#${s.id}`).join('、')}）是出口地区问题：`
          + describeGeoBlock({ code: geo[0].code, recordedExitIp: geo[0].exitIp })
        : '';
      // ★ 出口地区**实测**错配（2026-09-28 新增）与上面的 geo 是**同方向、不同来源**：
      //   geo 是上游主动回码（710022003/710022017），这里是**我们自己实测**出
      //   "代理声明 HK、出口落在 VE"。两者的引导词都必须指向"换出口/重拨代理"，
      //   混进通用引导词里会让人去查 cookie（本次故障最花时间的那个错误方向）。
      const exitRegion = skipped.filter((s) => s.code === EXIT_REGION_SKIP_CODE);
      const exitRegionHint = exitRegion.length
        ? `本次跳过中有 ${exitRegion.length} 个账号（${exitRegion.map((s) => `#${s.id}`).join('、')}）`
          + '的出口地区与代理声明不一致：请重新拨号或更换代理地区后重试'
          + '（这不是账号登录失效，也不是上游限流）。'
        : '';
      const reason = `${exitRegionHint}${geoHint}请确认账号登录有效、身份匹配、已配置有效的 IPWeb 或显式代理，且出口 IP 已核验并只被一个有效账号使用；最新回执确认零额度的账号不参与分配。已触发重复失败保护的账号须在后台「生成统计与复核」通过只读复核。时长和参考图能力未知不会排除账号，将在实际提交时处理。${isolation}${queueHint}`;
      throw Object.assign(
        new Error(`${head}。${reason}${detail}`),
        { status: 409 },
      );
    }

    let info;
    try {
      assertGenerationAccountSnapshot(acc, duration.seconds, Boolean(hasReferenceImages));
      const refCount = hasReferenceImages ? Math.max(0, Number(referenceImageCount) || 0) : 0;
      info = db.prepare(`INSERT INTO dola_videos
        (account_id, account_label, prompt, ratio, mode, seconds, force_seconds, status, stage,
         owner_token_id, owner_prefix, charge_ref, has_reference_images, reference_image_count,
         strict_account, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(acc.id, acc.label || '', text, String(ratio), generationMode, duration.seconds,
          duration.forceSeconds, 'queued', '排队中',
          ownerTokenId, ownerPrefix, chargeRef, refCount > 0 ? 1 : 0, refCount,
          strictAccount ? 1 : 0, createdBy, now(), now());
      const id = Number(info.lastInsertRowid);
      // 从这里开始队列名额由 active task 统计接管；即使后续更新/调度报错，
      // 数据库里的 queued 任务也必须继续占用名额，避免容量被错误释放。
      releaseGenerationAdmission();
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
    const row = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
    settleFailedVideoRefund(db, getVideoTask(id));
    if (accountSnapshot) recordGenerationGuard(db, row, accountSnapshot);
    // ★ 失败分记账：从任务行取 account_id，覆盖**所有** fail 路径（包括没传快照的）。
    //    message 原文留给 classifyFailure 分类（会话/能力/代理重罚，限流/网络/中断轻罚）。
    const scored = recordTaskFailure(db, row?.account_id, message);
    if (scored) console.warn(`[gen] #${id} 失败 → 账号 #${row?.account_id} 记失败分（${scored.code} +${scored.weight}，当前 ${scored.failScore}/${FAIL_SCORE_CAP}）`);
    // ★ 2026-09-29：**失败不再删参考图**。
    //   原先这里无条件 `cleanupReferenceImages(id)`，导致任务一落 failed，图当场消失 ——
    //   而「重新提交失败任务」正需要复用 data/reference-uploads/<原taskId>/ 里的图
    //   （用户不必重选 6 张图）。改为交给保留期模型回收：
    //   sweepOrphanReferenceImages（终态 + 超过 REFERENCE_RETENTION_MS，见 index.js 的定时器）。
    //   ⚠️ 成功 / 取消 / 清除 / 下架这些路径的即时清理行为**保持不变**，别顺手一起改掉。
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

/**
 * Wait for the page-side reference-image upload to settle.
 *
 * `setInputFiles()` only updates the local file input. Dola then calls
 * `/alice/resource/prepare_upload` and uploads the bytes to a separate object
 * storage host; the input is often reset while that asynchronous work is in
 * progress. A preview/chip is optimistic UI and is not enough evidence to
 * submit a paid generation request.
 *
 * The page currently exposes three useful DOM states:
 *   - visible `thumb-loading-mask`: upload still in progress;
 *   - visible `thumb-retry-mask`: upload failed (the UI shows an exclamation);
 *   - blob previews with neither mask: upload settled successfully.
 * Counts are compared with the snapshot taken immediately before attaching
 * this batch, so an old failed thumbnail cannot fail a new upload.
 * The final completion request is still checked separately for real
 * `image.uri` attachment bindings by generation-wire.js.
 */
async function inspectReferenceImageUpload(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      try {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 1 && rect.height > 1
          && style.visibility !== 'hidden' && style.display !== 'none';
      } catch { return false; }
    };
    const nodes = [...document.querySelectorAll('*')].filter(visible);
    const classes = nodes.map((node) => String(node.className || '')).filter(Boolean);
    const retryMasks = classes.filter((name) => /retry.*mask|mask.*retry/i.test(name)).length;
    const loadingMasks = classes.filter((name) => /loading.*mask|mask.*loading/i.test(name)).length;
    const blobPreviews = [...document.querySelectorAll('img')]
      .filter((node) => visible(node) && /^(?:blob:|data:image)/i.test(node.getAttribute('src') || ''))
      .length;
    const progressTexts = [...new Set(
      nodes.map((node) => String(node.textContent || '').trim())
        .filter((text) => /^\d{1,3}%$/.test(text)),
    )].length;
    return { blobPreviews, retryMasks, loadingMasks, progressTexts };
  });
}

export async function waitForReferenceImageUpload(page, {
  count,
  timeoutMs = 20000,
  pollMs = 500,
  baseline = null,
  isActive = () => true,
} = {}) {
  const expected = Number(count);
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    throw new TypeError('reference image count must be a positive integer');
  }
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 20000);
  const base = {
    blobPreviews: Number(baseline?.blobPreviews) || 0,
    retryMasks: Number(baseline?.retryMasks) || 0,
    loadingMasks: Number(baseline?.loadingMasks) || 0,
    progressTexts: Number(baseline?.progressTexts) || 0,
  };
  let settledStreak = 0;
  let last = null;
  while (Date.now() < deadline) {
    if (!isActive()) return { status: 'cancelled', snapshot: last };
    const current = await inspectReferenceImageUpload(page).catch((error) => ({
      wanted: expected, blobPreviews: 0, retryMasks: 0, loadingMasks: 0,
      progressTexts: 0, settled: false, error: String(error?.message || error).slice(0, 120),
    }));
    const retryMasks = Math.max(0, (Number(current.retryMasks) || 0) - base.retryMasks);
    const loadingMasks = Math.max(0, (Number(current.loadingMasks) || 0) - base.loadingMasks);
    const blobPreviews = Math.max(0, (Number(current.blobPreviews) || 0) - base.blobPreviews);
    const progressTexts = Math.max(0, (Number(current.progressTexts) || 0) - base.progressTexts);
    last = { ...current, wanted: expected, retryMasks, loadingMasks, blobPreviews, progressTexts,
      baseline: base,
      settled: blobPreviews >= expected && retryMasks === 0 && loadingMasks === 0 && progressTexts === 0 };

    if (last.retryMasks > 0) return { status: 'failed', snapshot: last };
    if (last.settled) {
      settledStreak += 1;
      // Require two consecutive observations so the submit click cannot race
      // the final UI update that removes the loading mask.
      if (settledStreak >= 2) return { status: 'ok', snapshot: last };
    } else {
      settledStreak = 0;
    }
    const wait = Math.min(Math.max(100, Number(pollMs) || 500), Math.max(0, deadline - Date.now()));
    if (wait <= 0) break;
    await page.waitForTimeout(wait).catch(() => {});
  }
  return { status: 'timeout', snapshot: last };
}

// ---------------------------------------------------------------- 浏览器提交

/**
 * 开一次浏览器把提示词提交出去，拿回 conversationId，然后**立刻关掉**。
 * 页面先选择真实可用的目标模型，再选择页面真实提供的原生时长选项。
 * 15 秒走 Seedance 2.0；30 秒走 Seedance 2.5；载体路径在发送前改写真实请求，
 * 服务器结果与媒体时长仍须分别验收。
 *
 * ★★ 这里有一处**至关重要的拦截**，不写的话每失败一次就烧掉一个账号 ★★
 *
 * 实测因果链（抓包坐实）：
 *   提交 → /chat/completion 回 SSE `STREAM_ERROR {error_code:710022002, error_msg:"当前服务访问频繁"}`
 *        → **dola 前端自己请求 `/passport/web/logout/` 把自己登出**
 *        → 会话死亡，之后所有探测都变成 code 710012014
 *
 * 这是拒绝回执触发前端登出的观测；710022002 不能据此归为限流。
 * 拦截登出请求避免前端销毁会话，但拒绝回执本身不能证明账号一定有效。
 */
async function submitViaBrowser(cookieText, {
  prompt, seconds = DEFAULT_VIDEO_SECONDS, forceSeconds = null, targetModel = null, proxyUrl, accountId, log,
  mode = 'standard',
  sessionVerified = false, isActive = () => true, referenceImagePaths = [],
  onDispatch, onConversation,
}) {
  proxyUrl = requireGenerationProxy(proxyUrl);
  if (!sessionVerified) throw new Error('未确认实时有效登录，拒绝提交');
  if (!isActive()) throw new Error('generation_cancelled');
  if (typeof onDispatch !== 'function' || typeof onConversation !== 'function') throw new Error('submission_journal_required');
  const requestedSeconds = Number(forceSeconds ?? seconds);
  // 本次生效的载体映射：在提交入口算一次，整条浏览器链路（探针同款判定 + 选档位）
  // 共用同一个值，避免设置中途被改导致"判据说 10s 载体、选档位却找 15s"。
  const carriers = allow30sRewrite() ? durationCarrierMap() : false;
  const pw = await getPlaywright();
  if (!pw?.chromium) {
    throw new Error('playwright 未安装：npm i playwright && npx playwright install chromium');
  }
  const ck = parseCookies(cookieText);

  // 同一账号不能并发开两个（profile 目录会打架）。正常情况下队列会避开，
  // 但并发上限调大之后仍有可能撞上，这里兜住。
  const lockKey = String(accountId ?? 'anon');
  const releaseAccountBrowserLock = tryAcquireAccountBrowserLock(lockKey);
  if (!releaseAccountBrowserLock) throw new Error(`账号 #${lockKey} 已有一个浏览器在跑，跳过本次`);

  const profileDir = path.join(PROFILE_ROOT, lockKey);
  let ctx = null;
  let taskPage = null;
  let responseListener = null;
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

    // 用持久化 context：缓存写回磁盘，下次生成就不必重下那 10 MB 的 JS 包。
    // ★ 现在改走会话池复用：同一账号的连续任务共用同一个浏览器实例，
    //   避免「每次开 = 换设备登录」被风控判成异常（滑块 710022004 的主因，
    //   优先级高于签名本身 —— 滑块风控的权重高于签名是否"像真机"。
    //   ⚠️ 早先这里写过"纯协议方案已判定不投入"，那是当时的结论。2026-09-26 纯协议
    //      签名已被服务端接受（正例 SSE_ACK / 负对照 710022002），已接成第三条通道
    //      pure-http（见 dola/pure-http.js）。这条注释随即更正，避免误导后来人。
    /**
     * 代理隧道自检（2026-09-28 实测后加的）。
     *
     * 事实：persistent context + **带 Basic 认证的 HTTP 代理**有约 20% 的间歇导航失败，
     * 报 `ERR_TUNNEL_CONNECTION_FAILED` / `ERR_EMPTY_RESPONSE` / 被 chrome-error 打断。
     * 证据（scripts/_proxy-ab-stability.mjs，账号 429）：
     *   · 失败**那一刻**用 curl 走同一代理仍然 200 ⇒ 不是网络/代理故障，是浏览器侧
     *   · `chromium.launch({proxy})` 6/6 成功，`launchPersistentContext({proxy})` 5/6
     *   · 补救实验（_proxy-persistent-retry.mjs）：同 page 原地重试只救回一半，
     *     另一半**必须销毁重建 context** 才恢复
     * 这正好解释了「生成前预检偶发失败」：下面打开创作页那个 goto 失败后只做了
     * 一次 `page.reload()` 原地重试 —— 只能覆盖一半，剩下那半抛的就是
     * 「页面未能加载（代理或网络故障）」。
     *
     * 所以把「重建」提前到**启动阶段**：此时还没装 route / cookie，
     * 重建成本最低（不用重做任何 page 配置）。
     *
     * 用 robots.txt + 随机 query：只要**隧道通**就算过（404 也无所谓），
     * 随机 query 是为了不命中 persistent profile 里的磁盘 HTTP 缓存 ——
     * 命中缓存就等于没检（自检必须真的走一次网络，含代理 CONNECT）。
     *
     * ⚠️ 超时给 10s 就够（隧道建立正常 <3s）。**不要**拿这里去等页面渲染 ——
     *    自检只是个握手，吃掉的每一秒都是从后面"打开创作页"的预算里扣的。
     */
    const proxyTunnelOk = async (c) => {
      let probe = null;
      try {
        probe = c.pages()[0] || await c.newPage();
        await probe.goto(`https://www.dola.com/robots.txt?_tunnel=${Date.now()}`, {
          waitUntil: 'commit', timeout: 10000,
        });
        return true;
      } catch {
        return false;
      } finally {
        await probe?.close().catch(() => {});
      }
    };

    const launchPersistent = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let c;
        try {
          c = await pw.chromium.launchPersistentContext(profileDir, launchOpts);
        } catch (e) {
          lastError = e;
          // 进程被强杀时 Chromium 会留下 SingletonLock，导致下次启动失败。
          // 清掉锁文件重试 —— 这个坑不兜住的话，一个账号崩一次就永久起不来了。
          if (!/SingletonLock|ProcessSingleton|profile.*in use/i.test(String(e.message))) throw e;
          console.warn(`[gen] 账号 #${lockKey} 的 profile 被锁，清锁重试`);
          for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            await fs.rm(path.join(profileDir, f), { force: true, recursive: true }).catch(() => {});
          }
          continue;
        }
        if (await proxyTunnelOk(c)) return c;
        console.warn(`[gen] 账号 #${lockKey} 代理隧道自检未通过（第 ${attempt + 1}/3 次），销毁重建`);
        await c.close().catch(() => {});
      }
      // ⚠️ 措辞必须落在 generation-analytics 的 VIDEO_NAVIGATION_FAILURE_PATTERN 里
      //    （含「页面未能加载」/`net::ERR_`），否则会被 classifyFailure 归错类，
      //    跑去折腾 cookie —— 而真正的问题在出口。
      throw new Error('页面未能加载（代理隧道自检连续 3 次未通过）：'
        + `${String(lastError?.message || 'net::ERR_TUNNEL_CONNECTION_FAILED').replace(/\s+/g, ' ').slice(0, 160)}`);
    };
    ctx = await acquireSession(lockKey, {
      launch: launchPersistent,
      // persistent context 的 proxy 是**启动参数**，运行期改不了
      // ⇒ 代理或 profile 一变就必须销毁重建，否则会拿旧出口去请求。
      launchKey: JSON.stringify({ profileDir, proxy: launchProxy }),
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
      isActive, sessionVerified: () => sessionVerified, referenceImageCount: referenceImagePaths.length });
    wireGate.setRewrite(requestedSeconds === 30 && allow30sRewrite());
    const requestFlow = { completion: 0, asyncStream: 0, otherChat: 0, logoutBlocked: 0, asyncStreamBlocked: 0 };
    await ctx.route('**/*', async (route) => {
      const request = route.request();
      // Aggregate endpoint classes only. Never log URLs, query strings, cookies or bodies.
      try {
        const url = new URL(request.url());
        if (url.origin === 'https://www.dola.com' && request.method() === 'POST') {
          if (url.pathname === '/chat/completion') requestFlow.completion++;
          else if (url.pathname === '/chat/async/chunk_stream') requestFlow.asyncStream++;
          else if (url.pathname.startsWith('/chat/')) requestFlow.otherChat++;
        }
      } catch { /* diagnostics must not change request handling */ }
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
      // The async chunk stream is a known Dola chat endpoint, but its request
      // body has not been validated by this generation gate. Fail closed until
      // its video schema is explicitly supported; never send it without a journal.
      try {
        const url = new URL(request.url());
        if (url.origin === 'https://www.dola.com' && url.pathname === '/chat/async/chunk_stream'
            && request.method() === 'POST') {
          requestFlow.asyncStreamBlocked++;
          if (!wireGate.snapshot().forwarded) submissionBlocked = true;
          return route.abort();
        }
      } catch { /* malformed or unrelated requests retain the existing handling */ }
      try {
        if (BLOCK_TYPES.has(request.resourceType())) return route.abort();
      } catch { /* 拿不到类型就放行 */ }
      return route.continue();
    });

    // Playwright 的路由按注册的**逆序**执行，且 route.continue() 不会调用
    // 其他匹配 handler ⇒ 登出拦截必须注册在全量路由**之后**才会真正生效。
    // ★ 拦住"前端自毁会话"的登出请求（见上方说明）。这是保住账号的关键。
    await ctx.route('**/passport/**/logout**', (route) => {
      requestFlow.logoutBlocked++;
      console.warn('[gen] 已拦截页面发起的登出请求；会话有效性仍需服务端核验');
      return route.abort();
    });

    // 抓限流/错误码：/chat/completion 是 SSE，结束后能整段读到
    const streamErrors = [];
    responseListener = (res) => {
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
    };
    ctx.on('response', responseListener);

    // ⚠️ 必须走 toPlaywrightCookies：带 `__Host-` / `__Secure-` 前缀的 cookie
    // 一刀切成 `{ domain: '.dola.com', path: '/' }` 会让 addCookies 直接抛
    // `Invalid cookie fields`（__Host- 禁带 domain；__Secure- 必须 secure=true），
    // 提交链路静默失败。详见 provider.js 里的注释。
    await ctx.addCookies(toPlaywrightCookies(ck));

    const page = taskPage = await ctx.newPage();
    if (forceSeconds || seconds) {
      const targetSeconds = Number(forceSeconds ?? seconds ?? DEFAULT_VIDEO_SECONDS);
      const wireModel = targetModel || (targetSeconds === 15 ? 'seedance_v2.0' : targetSeconds >= 20 ? 'seedance_v2.5' : null);
      // 30 秒：按授权的载体策略，可用更短页面档位承载并改写 duration；15 秒原样观察。
      // 10/20 已下线，不再存在「10 秒原样提交」这类目标档位。
      // Keep the adapter on this task's page; pooled contexts must not retain
      // init scripts with the previous task's duration/model.
      await page.addInitScript(installVideoRequestAdapter, {
        seconds: targetSeconds,
        targetModel: wireModel,
        rewrite: targetSeconds === 30 && allow30sRewrite(),
      });
      /**
       * ★ 网络层改写（2026-09-26）：页内 adapter 在 Dola 上实测命中不了
       *   （body 不走 init.body 字符串），必须再装一层 `ctx.route` 才能真正改写
       *   `ability_param.duration`。两者并存、互不冲突：页内那层只是观察。
       */
      try {
        await installVideoRequestWire(ctx, {
          seconds: targetSeconds,
          targetModel: wireModel,
          rewrite: targetSeconds === 30 && allow30sRewrite(),
        });
      } catch (error) {
        log(`网络层改写器安装失败（不影响页内适配器）: ${String(error?.message || error).slice(0, 120)}`);
      }
    }

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
    /**
     * 创作条级预算，与页面级 BOOT_MS 分开。
     *
     * 为什么不复用 BOOT_MS：页面能打开（输入框出现）只证明"已登录 + 骨架到了"，
     * 不证明创作条已经可用。实测控件水合顺序是
     *   「视频生成」点击 → +3s 时长控件 → +6s 模型控件（模型最后到）。
     * 把这两段挤在同一个 60s 里，慢代理下必然先耗在入口点击上，
     * 然后模型控件只剩十几秒 → MODEL_CONTROL_NOT_READY。
     *
     * 90s 的依据：实测最慢一次"输入框出现"是 70.8s（含 networkidle），
     * 创作条本身约 10s，留足余量。总时长仍受 preparationBudget 的
     * min(120000, timeout) 与客户端超时约束。
    */
    const COMPOSER_MS = 90000;

    log('打开 dola /chat/');
    // ★ 导航异常不能吞（同 provider.js 里的注释）：吞掉之后「代理/隧道挂了」和「账号未登录」
    //   抛出的是**同一句话**，于是会被记账成 login/session 去折腾 cookie，
    //   而账号真正的问题在出口 —— 修错地方，而且每轮白等最多 3 分钟。
    let navError = null;
    await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch((e) => { navError = e; });

    // 等输入框出现 = 已登录创作页。代理冷启动常抖，失败则刷新再等一次。
    let hasComposer = await page.waitForSelector(INPUT_SEL, { timeout: BOOT_MS }).then(() => true).catch(() => false);
    if (!hasComposer) {
      log('创作页输入框未出现，刷新重试');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => { navError = navError || e; });
      hasComposer = await page.waitForSelector(INPUT_SEL, { timeout: BOOT_MS }).then(() => true).catch(() => false);
    }
    if (!hasComposer) {
      // 页面压根没打开 → 关于"登录态"什么都推不出来，必须报出口问题而不是登录问题。
      if (navError) {
        throw new Error(`页面未能加载（代理或网络故障），未做登录判定：${String(navError?.message || navError).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
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
      // ⚠️ 这里的措辞刻意**不再**用「未确认已登录」：输入框刚刚是可见的，
      //    登录态已经被证明过了，消失是页面/链路抖动。若沿用旧文案，
      //    classifyFailure 会把它归成 login → 建账号级防护 → 冤枉一个已登录的号。
      //    同理也不能写「非登录问题」这种带「登录」二字的说明 ——
      //    session 分支的正则就是抓裸词「登录」，一句善意的澄清会把分类带偏（写测试时实际踩到）。
      if (!back) throw new Error('创作输入框加载后消失，刷新后仍未恢复（页面抖动，非账号问题）');
      await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // `mode=expert` is a real Dola page state, not a local label.  Switch the
    // action-bar control after the composer is hydrated and require visible
    // selected-state evidence before sending any paid request.
    if (String(mode).toLowerCase() === 'expert') {
      await ensureExpertMode(page, { timeout: Math.min(30000, Math.max(1000, COMPOSER_MS)), log, isActive });
    }

    // The video composer and the reference-image composer are two views of the
    // same page preparation.  Give them one absolute budget so a slow native
    // capability check cannot be followed by another full 90s reference-image
    // check.  `prepareReferenceImageComposer` accepts this absolute deadline;
    // the native helper still accepts a relative timeout, so pass it the
    // remaining portion of the same clock.
    const composerDeadline = Date.now() + COMPOSER_MS;
    const composerRemaining = () => Math.max(1, composerDeadline - Date.now());

    if (SUPPORTED_VIDEO_SECONDS.includes(requestedSeconds)) {
      if (!isActive()) throw new Error('generation_cancelled');
      const requestedModel = targetModel || (requestedSeconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5');
      const modelLabel = requestedModel === 'seedance_v2.0' ? 'Seedance 2.0' : 'Seedance 2.5';
      if (requestedSeconds === 30) {
        // 载体必须和探针用同一份映射，否则会"探针说可用、这里选不到档位"。
        const carrier = uiCarrierSeconds(requestedSeconds, carriers);
        log(carrier === requestedSeconds
          ? `确认并选择 ${modelLabel}：要求页面原生 ${requestedSeconds} 秒档位（当前载体映射未配置更短载体）`
          : `确认并选择 ${modelLabel}：优先页面原生/上游合成档位，否则选 ${carrier}s 承载 + 请求改写 duration→${requestedSeconds}（方悦路径）`);
      } else {
        log(`确认并选择 ${modelLabel} 与页面原生 ${requestedSeconds} 秒选项`);
      }
      const composer = await prepareNativeVideoComposer(page, {
        seconds: requestedSeconds,
        model: requestedModel,
        timeout: composerRemaining(),
        log,
        allowUpstreamConcat: upstreamConcatEnabled(),
        carriers,
      });
      /**
       * ★ 上游合成档位**自己就声明了目标时长**（页面写着 `30s (15s ×2)`），
       *   所以请求体里的 duration 本来就该是目标值 —— 这时候再改写反而会破坏它。
       *
       * 适配器是 addInitScript 装上去的，装的时候还不知道最终走哪条路；
       * 这里把 settings 改回"只观察不改写"（installVideoRequestAdapter 命中已装分支会更新设置）。
       * 位置在提交之前，所以不存在"先被改写一次"的窗口。
       */
      if (composer?.source === DURATION_SOURCE.UPSTREAM_CONCAT) {
        log(`上游合成档位已选中（${requestedSeconds}s = 拆段后首尾相接，由上游合成）；本次关闭请求改写，只观察`);
        await page.evaluate(installVideoRequestAdapter, {
          seconds: requestedSeconds,
          targetModel: requestedModel,
          rewrite: false,
        }).catch(() => {});
        // 同步关掉网络层那一路：它才是实际生效的改写通道，不关就会把上游合成
        // 档位的请求改坏。
        const wire = getVideoRequestWire(ctx);
        if (wire) wire.rewrite = false;
        wireGate.setRewrite(false);
        // 必须**确认**改写真的关了再往下走：适配器在非 dola.com 源上会静默不装，
        // 那种情况下改写仍然生效，会把上游合成档位请求改坏。
        const applied = await page.evaluate(() => {
          const state = window[Symbol.for('dola.generation-request.adapter.v1')];
          return state ? { seconds: state.seconds, rewrite: state.rewrite } : null;
        }).catch(() => null);
        const wireApplied = wire ? wire.rewrite === false : null;
        if (applied?.rewrite !== false && wireApplied !== false) {
          throw new Error('无法确认上游合成档位的请求不被改写，已中止本次提交（未发送提示词）');
        }
      }
    }

    if (referenceImagePaths?.length) {
      if (!isActive()) throw new Error('generation_cancelled');
      log(`挂载 ${referenceImagePaths.length} 张参考图`);
      let composer;
      try {
        composer = await prepareReferenceImageComposer(page, { deadline: composerDeadline, log });
      } catch (error) {
        // The capability helper already has structured diagnostics.  Preserve
        // them instead of turning a slow page (or an unknown DOM state) into
        // the much narrower "control missing" code.  That distinction drives
        // the retry/triage decision for the account and is especially important
        // for VIDEO_PREPARATION_TIMEOUT.
        if (['NATIVE_CAPABILITY_UNKNOWN', 'NATIVE_CAPABILITY_UNAVAILABLE', 'VIDEO_PREPARATION_TIMEOUT']
          .includes(error?.code) || error?.reason === 'VIDEO_PREPARATION_TIMEOUT') {
          if (error?.reason === 'VIDEO_PREPARATION_TIMEOUT' && !error?.code) {
            const timeoutError = new Error(error?.message || '页面准备超过总时限');
            timeoutError.code = 'VIDEO_PREPARATION_TIMEOUT';
            timeoutError.reason = error.reason;
            if (error?.controls) timeoutError.controls = error.controls;
            throw timeoutError;
          }
          throw error;
        }
        const err = new Error(error?.message || '参考图上传控件不可用');
        err.code = error?.code || 'REFERENCE_IMAGE_CONTROL_MISSING';
        if (error?.reason) err.reason = error.reason;
        if (error?.controls) err.controls = error.controls;
        throw err;
      }
      if (!composer?.referenceImages || !composer.imageInputs?.length) {
        throw Object.assign(new Error('页面没有可用的参考图上传控件'), {
          code: 'REFERENCE_IMAGE_CONTROL_MISSING',
        });
      }
      // Use an image input that supports the whole batch. An unrelated file
      // input or a single-file input must not silently lose reference images.
      const handle = await page.evaluateHandle((count) => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        return inputs.find((input) => !input.disabled && (count === 1 || input.multiple)
          && (/image\//i.test(input.accept || '')
          || /\.(?:png|jpe?g|webp)(?:\s*,|\s*$)/i.test(input.accept || '')))
          || null;
      }, referenceImagePaths.length);
      const element = handle.asElement();
      if (!element) {
        throw Object.assign(new Error('未找到支持本次数量的参考图文件控件'), {
          code: 'REFERENCE_IMAGE_CONTROL_MISSING',
        });
      }
      const uploadBaseline = await inspectReferenceImageUpload(page).catch(() => null);
      try {
        await element.setInputFiles(referenceImagePaths);
      } catch (error) {
        throw Object.assign(new Error(`参考图上传失败：${error.message || error}`), {
          code: 'REFERENCE_IMAGE_UPLOAD_FAILED',
        });
      }
      const selectedCount = await element.evaluate(input => input.files?.length ?? 0).catch(() => null);
      await handle.dispose().catch(() => {});
      // The UI may reset the input after starting an upload. A nonempty partial
      // selection is an error; an empty/reset input is not upload evidence.
      if (selectedCount > 0 && selectedCount !== referenceImagePaths.length) {
        throw Object.assign(new Error('页面选中的参考图数量不完整，已中止提交'), {
          code: 'REFERENCE_IMAGE_UPLOAD_FAILED',
        });
      }
      // The preview list may already contain old/history images or a stale retry
      // chip. Pass the before-attach snapshot so only this batch's changes can
      // satisfy the completion check.
      const uploadOutcome = await waitForReferenceImageUpload(page, {
        count: referenceImagePaths.length,
        timeoutMs: 20000,
        baseline: uploadBaseline,
        isActive,
      });
      if (uploadOutcome.status !== 'ok') {
        const detail = uploadOutcome.status === 'failed'
          ? '页面显示上传失败/重试标记'
          : uploadOutcome.status === 'cancelled'
            ? '任务已取消'
            : '超时未确认上传完成';
        throw Object.assign(new Error(`参考图上传未完成：${detail}，已中止提交`), {
          code: uploadOutcome.status === 'failed'
            ? 'REFERENCE_IMAGE_UPLOAD_FAILED'
            : 'REFERENCE_IMAGE_UPLOAD_TIMEOUT',
          upload: uploadOutcome.snapshot,
        });
      }
      log(`参考图上传已完成（${referenceImagePaths.length} 张）；等待 completion 请求核对 image.uri`);
    }

    log('填提示词并提交');
    // 返回值是"点击后有没有真的派发"的诊断（没派发时会带截图与按钮 DOM 状态）。
    // 之前忽略它，导致出现过"放行 0 次/阻断 0 次"却完全看不出原因的失败。
    const dispatch = await fillAndSubmitVideoPrompt(page, prompt, { isActive });

    /**
     * ★ 滑块处理（2026-09-26）
     * 提交被 Shark 风控拦下时页面会拉起 bdcaptcha iframe（710022004 / subtype=slide）。
     * 关键点：**原请求已经被风控丢弃了**，所以过掉滑块之后必须重新派发一次提交，
     * 否则这次生成等于白跑。此前链路完全没有处理器，撞上就是卡死。
     */
    if (bool('dola_auto_slider', true)) {
      const slider = await solveSliderIfPresent(page, {
        log,
        isActive,
        waitAppearMs: num('dola_slider_wait_ms', 22000),
        attempts: num('dola_slider_attempts', 3),
      });
      if (slider.appeared && slider.solved) {
        log(`滑块已通过（第 ${slider.attempts} 次，${slider.method || 'n/a'}），原请求已被风控丢弃，重新派发一次提交`);
        await fillAndSubmitVideoPrompt(page, prompt, { isActive }).catch(() => {});
      } else if (slider.appeared) {
        log(`滑块未通过（${slider.error || '未知原因'}，试了 ${slider.attempts} 次）；本次提交大概率失败`);
      }
    }

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
    return { conversationId, cap, pageText, streamErrors, loggedOut, submissionBlocked, wire: wireGate.snapshot(), ack, submissionOutcome, dispatch, requestFlow };
  } catch (error) {
    // 出错时不复用：页面可能停在滑块/登出页，状态未知，下次重建比复用稳。
    await invalidateSession(lockKey).catch(() => {});
    throw error;
  } finally {
    // Settle task response readers before returning this context to the pool.
    // Releasing first lets the next task close this page while its ACK is read.
    if (receiptReads.size) {
      let timer;
      await Promise.race([Promise.allSettled([...receiptReads]), new Promise(resolve => {
        timer = setTimeout(() => { submissionOutcome.error = 'receipt_unfinished'; resolve(); }, 3000);
      })]);
      clearTimeout(timer);
    }
    receiptCollectorClosed = true;
    if (ctx && responseListener) ctx.off('response', responseListener);
    if (taskPage) await taskPage.close().catch(() => {});
    if (ctx) {
      try {
        await disposeVideoRequestWire(ctx);
        await ctx.unrouteAll({ behavior: 'wait' });
      } catch {
        // Never reuse a context with a previous task's submission handlers.
        await invalidateSession(lockKey).catch(() => {});
      }
    }
    releaseSession(lockKey);
    await bridge?.close().catch(() => {});
    releaseAccountBrowserLock();
  }
}

/**
 * 已确认的上游限流码；目前没有确认的码，保留入口供后续证据补充。
 * 710022002 已迁出：09-26 交错对照实验记录中，健康对照成功而破坏签名/请求后返回该码。
 * 09-27 交接记录的生产 #167/#168/#169 展示了将它误判为限流后的冷却后果，
 * 这三条记录本身不能证明拒绝根因。证据见 PURE-PROTOCOL-RESEARCH-2026-09-26.md
 * 与 HANDOFF-CODEX-2026-09-27-并发-710022002-非限流化.md；本次未连接生产复验。
 * ★ 2026-09-28 生产复验（`scripts/diag-710022002-triage.mjs` + `diag-exit-region-audit.mjs`）
 *   确认了"非限流"这个结论，但**推翻了对它的单因解释**：见下面 SIGNATURE_REJECT_CODES。
 */
export const RATE_LIMIT_CODES = new Set();

/**
 * `710022002` 的归属集合。
 *
 * ⚠️⚠️ 2026-09-28 定案：**这是一个重载码（overloaded code），不是单一成因的码。**
 *   同一个数字至少有两个来源，实测证据两边都有：
 *     ① 好出口 + 故意破坏 a_bogus  → 710022002（请求确实没过验签）
 *     ② 坏出口 + **正常**签名      → **同一个码**（#433 的负对照失效：破坏与不破坏
 *        回的是同一个码 ⇒ 该请求根本没走到验签层就被挡了）
 *   上游给的文案「当前服务访问频繁」是第三层伪装，与两个真实成因都无关。
 *
 *   ⇒ 因此**不能再从码本身推断成因**，也不能据此写"验签失败"这类断言。
 *     判读必须落到**当场实测**上：见 `run()` 里拒绝分支的 `probeExitCountry()` ——
 *     出口地区错配就说错配（并按 `exit-region.js` 语义短冷却），
 *     出口实测与声明一致才指向签名/参数。这样文案才是有依据的推断。
 *
 * 为什么仍留在"签名/参数"这个集合里而不是新建一个：它承担的**行为**是对的 ——
 * "允许有上限的换号重试、不标账号失效、不按限流冷却"。集合名描述的是
 * "最可能的成因"，而实测已把出口那一支单独拆走（`exit-region.js`），
 * 剩下的这一支就是签名/参数。改名会牵动 `generation-analytics.js` 等按名取用的地方，
 * 收益不抵风险 —— 所以**保留名字、把重载事实写在这里**。
 */
export const SIGNATURE_REJECT_CODES = new Set([710022002]);
// 出口地区封锁码（710022003 / 710022017）不属于以上集合，仍由 geo-block.js 独立处理。
// 出口地区**实测**错配（上游不告诉我们、我们自己测出来的）由 exit-region.js 处理 ——
// 它不需要上游的码，所以不参与上面的集合划分。


// ---------------------------------------------------------------- 轮询

/** 从消息链原文里扒带水印直链 + 失败/额度线索，并给这一轮的原文分类 */
function analyzeChain(raw, { prompt = '', clarifying = '', refused = '' } = {}) {
  const text = String(raw || '').replace(/\\\//g, '/');
  const vids = [...new Set([...text.matchAll(/https?:\/\/[^"\\\s]{20,240}?(?:\.mp4|video\/tos)[^"\\\s]{0,160}/g)].map((m) => m[0]))];
  // ★ 每轮都把原文分类并记账。连续 3 轮连「提示词回显」都认不出来 → 日志里报协议漂移。
  //   放在这里是因为这是**唯一的**上游原文入口；别的地方再补一处必然漏。
  const classified = recordChainText(classifyChainText(text, { prompt, hasVideo: vids.length > 0, clarifying, refused }));
  return {
    vids,
    // ⚠️ failed 的**唯一口径是分类器的 rule**，这里不再另写一条正则。
    //    原先它是 /视频生成失败|生成失败/，与 chain-text-rules.js 的 VOIDED_PATTERN
    //    各存一份 —— 上游换措辞时改一处漏一处必然漂移。已经收口。
    // 终态判定有四种形态，都必须立刻判失败 + 退款 + 放行账号：
    //   content_refused  = 上游「内容生成限制」，直接拒绝生成（换提示词才可能出片）
    //   voided           = 内容/审核层面被拒
    //   quota_exhausted  = 当日生成次数用尽（今天重试多少次都是同一句，无意义）
    //   duration_inquiry = 上游在等你回答时长方案（我们的轮询循环里没有"作答"这一步）
    // 反过来，把它们留成 active 会让轮询跑满时限，再被判成 uncertain，
    // 而 uncertain 会永久锁死账号 —— 生产上已经这样锁掉过 419，
    // 2026-09-28 又锁掉过 448（见 chain-text-rules.js 的 DURATION_INQUIRY_PATTERN），
    // 同一天 #210 又因为 content_refused 空转到时限（见 CONTENT_REFUSED_PATTERN）。
    failed: classified.rule === 'voided' || classified.rule === 'quota_exhausted'
      || classified.rule === 'duration_inquiry' || classified.rule === 'content_refused',
    // 上游的通用错误回执（实测样本：「出了点问题，请稍后重试。」）**只作证据，不作终态**。
    // 它是可重试的抖动措辞，直接判死会把偶发抖动变成任务失败 —— 而积分这时已经扣了。
    // 但也不能像以前那样丢掉：丢掉的结果就是"跑了 20 分钟只说一句到时限了"。
    upstreamError: classified.upstreamError ?? null,
    rule: classified.rule,
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

    // ---- ① 提交（browser / scheme-a / pure-http 三通道，见 dola_submit_mode 设置） ----
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
      if (row.has_reference_images && referenceImagePaths.length !== Number(row.reference_image_count)) {
        return fail(id, '参考图文件数量与任务记录不一致，未提交；请重新上传全部参考图');
      }
      // 提交通道（设置项 dola_submit_mode，默认 browser）：
      //   browser   —— 开浏览器操作 UI 提交（默认，兼容性最好）
      //   scheme-a  —— 开浏览器，页内取签名后原样重放（实验性）
      //   pure-http —— 不开浏览器，Node 自己算 a_bogus 后直接发（见 dola/pure-http.js）。
      //                签名器实测已被服务端接受：正例拿到 SSE_ACK，负对照（破坏签名）
      //                立刻回 710022002。详见 PURE-PROTOCOL-RESEARCH-2026-09-26.md。
      //
      // ★ 2026-09-27：**带参考图不再回落 browser**。
      //   参考图现在由三条通道共用同一条纯协议上传（dola/reference-upload.js 四跳，
      //   实测 7.6~10.4 秒，不需要页面），所以"scheme-a/pure-http 没有上传链路"
      //   这个理由不再成立。回落规则只剩「专家模式必须开浏览器真实切控件」一条。
      //   （历史：2026-09-26 任务 #160/#161 曾因这个原因直接判失败，见
      //    test/generation-submit-mode.mjs 的回归测试。）
      const requestedExpertMode = String(row.mode || 'standard').toLowerCase() === 'expert';
      const picked = chooseSubmitMode(getSetting('dola_submit_mode', 'browser'), {
        hasReferenceImages: Boolean(row.has_reference_images),
        requiresExpertMode: requestedExpertMode,
      });
      const submitMode = picked.mode;
      const submitFn = submitMode === 'scheme-a' ? submitViaSchemeA
        : submitMode === 'pure-http' ? submitViaPureHttp
          : submitViaBrowser;
      if (picked.fellBack) {
        const why = picked.fallbackReason === 'expert_mode'
          ? '专家模式必须使用浏览器真实切换'
          : '本次任务特征需要浏览器通道';
        log(`提交通道：配置为 ${picked.configured}，${why}，自动回落到 browser 通道`);
      } else if (submitMode === 'scheme-a') {
        log('提交通道：方案A（abort 取签名 + 页内重放提交）');
      } else if (submitMode === 'pure-http') {
        log('提交通道：纯协议（Node 自算 a_bogus + 直连发出，不开浏览器）');
      }
      if (!picked.fellBack && referenceImagePaths.length) {
        log(`参考图：${referenceImagePaths.length} 张改走纯协议上传（四跳，无需页面挂图）`);
      }
      sub = await submitFn(acc.cookie, {
        // ★ 提示词包装只作用于**发给上游的那一刻**（见 dola/prompt-wrap.js）：
        //   `row.prompt`（库里存的、以及 /v1 返回给调用方的）始终是用户原文。
        //   三条提交通道（browser / scheme-a / pure-http）都走这一行，所以只在这里
        //   包一次就够；在 submitViaBrowser 内部包会漏掉另外两条通道。
        prompt: upstreamPrompt(row.prompt).text,
        seconds: duration.seconds,
        forceSeconds: duration.forceSeconds ?? duration.seconds,
        targetModel: duration.targetModel,
        ratio: row.ratio || '16:9',
        mode: row.mode || 'standard',
        proxyUrl: accProxy, accountId: acc.id, log,
        sessionVerified, isActive: () => taskActive(id),
        referenceImagePaths,
        // `x-storage-u` 的值：实测 `dola_accounts.sec_user_id` **就是** `/alice/profile/self_brief`
        // 的 `entity_id`（429 号三者同为 7687664544680051765）。白拿，不用额外请求。
        // 纯协议上传里这个头**不是必需的**（不带也全通），带上只是与页面真实请求更一致。
        storageUserId: acc.sec_user_id || null,
        onDispatch: () => {
          recordSubmissionDispatch(db, { taskId: id, account: acc,
            deadlineAt: new Date(Date.now() + maxMin * 60_000).toISOString() });
          // ★ 最短提交间隔的记账点：只在"确认已派发"时记。提交失败不记 ——
          //   下次可以立刻换号重试，不该被一次没发出去的尝试卡住。
          markAccountSubmitted(db, acc.id);
        },
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
    // 放行/阻断计数：只有开浏览器的两条通道（browser / scheme-a）才有"请求门"。
    // 纯协议通道是"自己造一个请求直接发出去"，没有第三方请求要放行或阻断，如实说明。
    const wireNote = sub.wire
      ? (sub.wire.mode === 'pure-http'
        ? `（纯协议提交：直发 1 次，无浏览器请求门）`
        : `（浏览器生成请求：放行 ${sub.wire.forwarded} 次，阻断 ${sub.wire.blocked} 次）`)
      : '';
    // 点了却没派发时，把现场取证（截图路径 + 按钮状态）一并写进失败原因，
    // 否则下次还是只能看到"放行 0 次"这种没法定位的话。
    const dispatchNote = sub.dispatch && sub.dispatch.dispatched === false
      ? `（点击后未派发：截图 ${sub.dispatch.shot || '无'}；`
        + `命中元素 ${(sub.dispatch.sendButton || []).map((b) => b.topAtCenter).filter(Boolean).join(',') || '未知'}；`
        + `disabled=${(sub.dispatch.sendButton || []).map((b) => b.disabled).join(',') || '-'}；`
        + `url ${sub.dispatch.urlAfter || '-'}）`
      : '';
    const networkNote = sub.requestFlow
      ? `（请求计数：completion=${sub.requestFlow.completion}, asyncStream=${sub.requestFlow.asyncStream}, otherChat=${sub.requestFlow.otherChat}, logoutBlocked=${sub.requestFlow.logoutBlocked}）`
      : '';
    if (sub.submissionBlocked) {
      if (getSubmission(db, id)) return holdUncertainSubmission(db, id, '请求拦截与已记录的发送状态不一致，需核对原任务；不会退款或重新提交');
      if (sub.wire?.lastReason === 'reference_images_unconfirmed') {
        return fail(id, '发送请求中未确认全部参考图的上传标识，已在发送前拦截；请检查图片上传结果或核对页面请求结构，不会自动降为无参考图任务。');
      }
      return fail(id, `未确认 ${duration.targetModel === 'seedance_v2.0' ? 'Seedance 2.0' : 'Seedance 2.5'} 的原生 ${duration.seconds} 秒请求或任务已取消，已拦截提交；不会降级或拼接视频`);
    }

    const rl = (sub.streamErrors || []).find(e => RATE_LIMIT_CODES.has(e.code));
    const sig = (sub.streamErrors || []).find(e => SIGNATURE_REJECT_CODES.has(e.code));
    if (!sub.conversationId || rl || sig) {
      // 已识别的上游拒绝按 dola_autorotate_max_attempts 换号重试；
      // 710022002 是**重载码**（既可能是验签/参数被拒、也可能是出口地区被拒），
      // 不能据此认定账号失效或访问频繁 —— 具体是哪一种，下面当场实测出口来判。
      const hit = rl || sig;
      if (hit) {
        const isRateLimit = Boolean(rl);
        // ★ 2026-09-28：判读之前先**实测一次出口地区**。
        //
        // 为什么必须量、不能猜：`710022002` 是**重载码**，实测证明同一串数字至少有两个来源 ——
        //   · 好出口 + 破坏 a_bogus → 710022002（真的没过验签）
        //   · 坏出口 + 正常签名     → **同一个码**（请求根本没走到验签层）
        // 生产上 4 条任务的这句「验签/参数被上游拒绝」就是这么来的：
        // 它把「出口地区错配」说成了「签名有问题」，把人引去查一个没坏的东西。
        // 现在改为当场量一次出口，让文案**有依据**：错配就说错配、一致才谈签名。
        //
        // 开销：选号阶段刚探过同一个代理 URL，这里命中缓存 → **零网络请求**。
        const exitNow = await probeExitCountry(acc.proxy);
        const exitDeclared = declaredRegionOf(acc.proxy);
        const exitVerdict = exitNow.ok
          ? exitRegionVerdict({ declared: exitDeclared, actual: exitNow.country })
          : 'unknown';
        const exitMismatch = exitVerdict === 'mismatch';
        const exitMatch = exitVerdict === 'match';
        // ⚠️ 三态必须**分开写**。把 `unknown` 落进 `match` 的分支，
        //    就会在"根本没测出来"的时候说"已实测与声明一致"——
        //    那正是本项目反复警告的老毛病：把没验证过的事说成事实。
        //    （这条是被 `test/generator-isolated.mjs` 的断言当场抓出来的，别改回去。）
        const exitObservation = exitNow.ok
          ? `出口实测 ${exitNow.country} ${exitNow.ip}（声明 ${exitDeclared || '未声明'}，`
            + `${exitMismatch ? '不一致' : '一致'}）`
          : `出口未能实测（${exitNow.reason}）`;
        // 给用户/运维看的"下一步该查什么"。必须由实测结果决定，不能先入为主。
        const exitNextStep = exitMismatch
          ? describeExitRegionMismatch({ declared: exitDeclared, actual: exitNow.country, ip: exitNow.ip })
          : exitMatch
            ? `${describeExitRegionMatch({ declared: exitDeclared, actual: exitNow.country, ip: exitNow.ip })}`
              + '出口不是原因，请核验请求签名、参数及账号状态。'
            : '出口地区未能实测（探测失败），请先确认代理连通性，再核验请求签名、参数及账号状态。';
        const rejectionLabel = isRateLimit ? '上游限流' : (exitMismatch ? '出口地区错配' : '上游拒绝');
        // 最终语义：只有确认的限流才写冷却；不再读取 Step 1 的临时验签冷却设置。
        // ★ 新增：出口地区**实测错配**时也写冷却 —— 与 geo-block.js **同语义、同时长**
        //   （不标 invalid、不写限流事件表的"限流"语义）。
        //   为什么必须冷却：出口是**粘性**的，带 `-session-<SID>-sessTime-120` 的号会被
        //   钉死在那一个坏出口上（实测 #424/#433/#440/#446/#448 连续两次审计都在同一个
        //   坏国家）。不冷却 → 下一个任务立刻又选中它、又撞同一面墙、又烧掉一个换号名额。
        const mins = isRateLimit
          ? num('dola_ratelimit_cooldown_min', 30)
          : (exitMismatch ? num(EXIT_REGION_COOLDOWN_SETTING, EXIT_REGION_COOLDOWN_MIN) : 0);
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
            console.warn(`[gen] #${id} ${rejectionLabel}换号：探测后无可用账号（跳过 ${switched.skipped.length} 个）`);
          }
        }
        let requeued = false;
        settleRejectedSubmission(db, id, () => {
        // Start the cooldown after account failover probing, as before; probing can take time.
        const until = mins > 0
          ? new Date(Date.now() + mins * 60_000).toISOString()
          : null;
        const cooldownNote = until ? `已进入冷却 ${mins} 分钟。` : '本次未对该账号设置冷却。';
        // 账号列表里那行 last_error：让人一眼看到**下一步该干什么**。
        const accountError = isRateLimit
          ? `上游限流（code=${hit.code} 访问频繁），冷却至 ${until.slice(11, 16)}`
          : exitMismatch
            ? `${EXIT_REGION_REMARK}（code=${hit.code}，声明 ${exitDeclared || '?'}，`
              + `实测 ${exitNow.country} ${exitNow.ip}），冷却至 ${until.slice(11, 16)}`
            : `上游拒绝（code=${hit.code}，${exitObservation}），${cooldownNote}`;
        if (until) {
          db.prepare('UPDATE dola_accounts SET cooldown_until=?, last_error=?, updated_at=? WHERE id=?')
            .run(until, accountError, now(), acc.id);
        } else {
          // 不清空或覆盖其他操作设置的冷却，仅记录这次拒绝。
          db.prepare('UPDATE dola_accounts SET last_error=?, updated_at=? WHERE id=?')
            .run(accountError, now(), acc.id);
        }
        // 沿用事件表和 code 供换号去重；detail 区分拒绝类型，不迁移表结构。
        // ★ 出口字段改用**本次实测值**。原来写的是 `acc.exit_ip` —— 那是账号表里的
        //   **上次核验快照**，出口漂移时它会指着一个本次根本没用的 IP。
        //   本次故障里最花时间的一步就是"回执里那个 IP 到底是不是当时的出口"，
        //   而当时唯一能查的就是这个字段，且它是错的。现在实测优先、快照兜底。
        const observedExitIp = exitNow.ok ? exitNow.ip : (acc.exit_ip || null);
        db.prepare(`INSERT INTO dola_rate_limit_events
          (code, account_id, video_id, exit_ip, cooldown_until, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(String(hit.code), acc.id, id, observedExitIp, until,
            isRateLimit
              ? '上游返回访问频繁，已按出口隔离策略冷却账号'
              : (exitMismatch
                ? `上游拒绝且出口地区实测与代理声明不一致（非限流），已按出口地区策略冷却账号；${exitObservation}`
                // ⚠️ 这一支同时覆盖 match 与 unknown —— 所以措辞只能写**已确证的事实**（实测值本身），
                //    不能写"因此指向签名/参数"这种推断：unknown 时我们什么都不知道。
                : `上游拒绝，非限流（${exitMatch ? '出口地区已排除' : '出口地区未排除'}）；${exitObservation}`),
            now());
        if (switched.account) {
          // 换号：本轮提交记录已终结（rejected），删掉它让下一轮能重新记录派发；
          // 审计留在 dola_rate_limit_events 里，不丢。任务回到排队，重新调度。
          // 状态守卫：换号期间任务若被取消/删除，不复活它。
          db.prepare('DELETE FROM dola_submission_journal WHERE task_id=?').run(id);
          const updated = db.prepare(`UPDATE dola_videos SET conversation_id=NULL, status='queued',
            stage=?, error='', updated_at=? WHERE id=?
            AND status IN ('queued','submitting','generating','resolving')`)
            .run(`${rejectionLabel}，已自动换号为 #${switched.account.id} 重试（第 ${triedIds.length + 1}/${maxAttempts} 次）`,
              now(), id);
          requeued = updated.changes > 0;
          return;
        }
        const observed = requestCaptureNote(sub.cap) + wireNote + dispatchNote;
        const triedDesc = triedIds.length > 1
          ? `已自动轮询 ${triedIds.length} 个账号（${triedIds.map((n) => `#${n}`).join('、')}），均收到上游拒绝回执；`
          : '';
        const noRotateReason = row.strict_account
          ? '锁定账号验收任务，不自动换号。'
          : triedIds.length >= maxAttempts
            ? `已达自动换号上限（${maxAttempts} 个账号）。`
            : (switched.skipped.length
              ? `换号探测无可用账号（跳过 ${switched.skipped.length} 个）。`
              : '账号池暂无可用账号。');
        // 结尾那句"该去查什么"由 `exitNextStep` 提供（在本分支顶部按**实测结果**算好）。
        // 原来固定写「请核验请求签名、参数及账号状态」—— 生产上 4 条任务的真正原因是
        // 出口地区错配，这句话把排查方向指反了（见本分支顶部注释）。
        return fail(id, (isRateLimit
          ? `上游限流：当前服务访问频繁（code ${hit.code}）。`
          : exitMismatch
            ? `上游拒绝：出口地区与代理声明不一致（code ${hit.code}）。`
            : `上游拒绝（code ${hit.code}）。`)
          + cooldownNote
          + triedDesc + noRotateReason
          // 注意别在这里写 markdown 的 ** 加粗 —— 这条消息会原样显示在前台表格里，
          // 星号会字面露出来。
          + exitNextStep
          + (sub.loggedOut ? '（本次已拦截前端登出请求）' : '')
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
      const outHint = sub.loggedOut ? '；页面出现登出跳转标记（from_logout=1），会话状态待核验' : '';
      if (getSubmission(db, id) || sub.dispatch?.sendActionCompleted) {
        return holdUncertainSubmission(db, id,
          `发送动作已执行，但未取得可靠会话回执；请核对原任务，不会自动重提或退款${outHint}${wireNote}${networkNote}${dispatchNote}`);
      }
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
      prompt: row.prompt,
      deadline: Date.parse(getSubmission(db, id)?.deadline_at || '') || Date.now() + maxMin * 60_000 });
  } finally {
    if (globalAcquired) release();
    releaseAccountLock();
  }
}

/** Shared query/archive path. This function cannot submit a generation request. */
/**
 * 轮询间隔（毫秒）。可在后台配置 `dola_poll_interval_sec`（秒）。
 * 原先写死 30 秒：40 分钟的任务会打 80 次 /im/chain/single，过密的回查不利于稳定。
 * 下限 15 秒（再低意义不大，还可能徒增上游压力）。
 */
const POLL_INTERVAL_MS = () => Math.max(15_000, (num('dola_poll_interval_sec', 45) || 45) * 1000);

async function pollSubmittedVideo(id, { acc, accProxy, ck, duration, conversationId, maxMin, deadline, prompt = '' }) {
    const log = message => db.prepare("UPDATE dola_videos SET stage=?,updated_at=? WHERE id=? AND status IN ('generating','resolving')")
      .run(message, now(), id);
    let round = 0;
    let found = null;
    // 记住上游**最后**说的那句错误话，最终带进 stage / 终态说明。
    // 不记住的话，一次真实的上游拒绝在库里只留下「到达时限、待核对」，
    // 看日志的人根本没法判断该重试、该换号，还是该去查账号订阅。
    let lastUpstreamError = '';
    while (Date.now() < deadline) {
      if (!taskActive(id)) return;

      round++;
      const chain = await pullChain(conversationId, ck, { proxy: accProxy });
      if (!taskActive(id)) return;
      if (Date.now() >= deadline) break;
      if (!chain.ok) {
        log('会话轮询未确认成功，等待复查；不会重复提交');
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS()));
        continue;
      }
      // 结构化优先：json 里的 volcano_refused / safety_terminated（上游拒绝）
      // 和 is_creation_clarifying / 710082041（上游问询）比文案正则可靠得多。
      const a = analyzeChain(chain.text, {
        prompt,
        clarifying: readChainClarifying(chain.json),
        refused: readChainRefused(chain.json),
      });
      if (a.upstreamError) lastUpstreamError = a.upstreamError;
      const elapsed = ((round * 1) && Math.round((maxMin * 60_000 - (deadline - Date.now())) / 1000)) || 0;
      const cr = a.cost ?? null;
      db.prepare("UPDATE dola_videos SET stage=?, updated_at=? WHERE id=? AND status='generating'")
        .run(`生成中 ${elapsed}s｜已轮询 ${round} 次${cr ? `｜本条约耗 ${cr} 额度` : ''}`
          + (lastUpstreamError ? `｜上游回执：${lastUpstreamError}` : ''), now(), id);

      // 只保存成功响应中明确的剩余额度，不从消耗量推算，也不刷新旧读数。
      // 生成期间账号凭据/出口被替换或被停用时，不能把旧会话读数写回。
      if (chain.ok && a.remaining != null) {
        db.prepare(`UPDATE dola_accounts SET quota_remaining=?, quota_source=?,
                    quota_at=?, updated_at=? WHERE id=? AND cookie_hash=? AND proxy=? AND status <> 'disabled'`)
          .run(a.remaining, 'generation_receipt', now(), now(), acc.id, acc.cookie_hash, acc.proxy);
      }

      if (a.vids.length) { found = { url: a.vids[0], quota: a }; break; }
      if (a.failed) {
        // 把上游的原话写进终态 —— 操作者据此判断是该换号、该等明天，还是该查内容。
        const why = a.rule === 'content_refused'
          ? '上游回的是「内容生成限制」，直接拒绝了本次生成（重试同一提示词无意义）；已退款并放行账号'
          : a.rule === 'duration_inquiry'
          ? '上游回的是「时长问询」，在等我们选时长方案（方案 A=15 秒 / 方案 B=两段 15 秒），'
            + '本轮不会出片；已退款并放行账号'
          : a.upstreamError
            ? `上游明确拒绝（回执：「${a.upstreamError}」）；已退款并放行账号`
            : '上游明确报「生成失败」；上游额度是否退还以实际回执为准';
        return settleRejectedSubmission(db, id, () => fail(id, why));
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS()));
    }

    if (!found) {
      const suffix = lastUpstreamError ? `（上游最后回执：「${lastUpstreamError}」）` : '';
      if (getSubmission(db, id)) return holdUncertainSubmission(db, id, `查询原任务到达时限，最终结果待核对；不会重新生成或自动退款${suffix}`);
      return fail(id, `等待 ${maxMin} 分钟仍未出现成片直链${suffix}`);
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

    /**
     * ---- ④ 归档并按**真实时长**挑选成片 ----
     *
     * 为什么不能只看第一个直链：上游合成档位（`30s (15s ×2)`）会拆成两段生成，
     * 消息链里可能同时出现中间段和合成后的成品。只取 `vids[0]` 有可能把
     * 15 秒的中间段当成 30 秒交付 —— 那正是我们最不想要的错。
     *
     * 所以改成**有界多候选**：无水印候选优先，逐个归档 + 探测真实时长，
     * 接受第一个通过 validateArchivedVideo 的候选。判据没有放宽，
     * 只是把"一次机会"变成"最多三次机会"。
     */
    const candidates = [
      ...unw.videos.map(v => ({ url: v.url, unwatermarked: true })),
      { url: found.url, unwatermarked: false },
    ].filter((candidate, index, all) =>
      candidate.url && all.findIndex(other => other.url === candidate.url) === index)
      .slice(0, MAX_ARCHIVE_ATTEMPTS);

    let arch = null;
    let durationSec = null;
    let acceptNote = '';
    let probeStatus = 'unreadable';
    let rejection = null;
    const rejectedPaths = [];
    for (const candidate of candidates) {
      if (!taskActive(id)) return;
      const attempt = await archiveVideo(id, candidate.unwatermarked
        ? { unwatermarkedUrl: candidate.url }
        : { watermarkedUrl: candidate.url });
      if (!taskActive(id)) return;
      if (!attempt) { rejection = 'archive_failed'; continue; }

      const probe = await probeVideoDuration(attempt.path);
      let seconds = probe.seconds;
      let note2 = '';
      if (seconds == null && probe.status === 'tool_missing') {
        // ffprobe 不可用是工具链问题：退回纯 Node 的 MP4 容器解析（mvhd 时长），
        // 不把已归档的好片误判为失败。容器解析替代不了逐帧读取，明确标注。
        const fallbackSeconds = await probeMp4ContainerDuration(attempt.path);
        if (fallbackSeconds != null) {
          seconds = fallbackSeconds;
          note2 = '（ffprobe 不可用，已改用 MP4 容器解析验证时长）';
        }
      }
      if (!taskActive(id)) return;

      const bad = validateArchivedVideo(attempt, seconds, duration.seconds);
      arch = attempt;
      durationSec = seconds;
      acceptNote = note2;
      probeStatus = probe.status;
      rejection = bad;
      if (!bad) break;
      // 这一条不合格：先留着，等确定最终交付哪条再决定删谁。
      rejectedPaths.push(attempt.path);
    }

    // 已经挑中一条时，其余候选都是中间产物，删掉免得磁盘越攒越多。
    // 全都失败时**保留最后一条**：失败文案会告诉运维"文件已归档在本地，可手动核验"，
    // 把它删掉会让那句话变成假话。
    // 全都失败时保留最后一条（不参与清理），供运维手动核验。
    if (rejection) rejectedPaths.pop();
    for (const stale of rejectedPaths) {
      if (stale === arch?.path) continue;
      // ⚠️ 必须用 try/catch 而不是 `.catch()`：隔离测试里 fs 是一个"取属性就抛"的 Proxy，
      //    异常发生在**取值那一刻**（同步），链式 .catch() 根本挂不上去，
      //    结果是把一次清理失败放大成整条交付流程失败。清理永远不该决定交付结果。
      try { await fs.unlink(stale); } catch { /* 清理失败不影响交付 */ }
    }

    if (!taskActive(id)) return;
    if (arch) {
      db.prepare(`UPDATE dola_videos SET local_path=?, local_bytes=?, duration_sec=?, bytes=?, updated_at=?
        WHERE id=? AND status='resolving'`).run(arch.path, arch.bytes, durationSec, arch.bytes, now(), id);
    }
    if (rejection) {
      const messages = {
        archive_failed: '成片归档失败，未通过交付验收；不能仅凭临时直链标记成功',
        duration_unverified: probeStatus === 'tool_missing'
          ? 'ffprobe 不可用且 MP4 容器解析也失败，未通过验收；文件已归档在本地，可手动核验'
          : '无法探测实际媒体时长（文件不可读或已损坏），未通过验收',
        duration_mismatch: `实际媒体时长 ${durationSec} 秒，不符合请求的 ${duration.seconds} 秒；未通过验收`,
      };
      return fail(id, messages[rejection]);
    }
    const ready = db.prepare(`UPDATE dola_videos SET status='ready', error='', stage=?, updated_at=?, finished_at=?
      WHERE id=? AND status='resolving'`)
      .run(`完成（已归档 ${(arch.bytes / 1048576).toFixed(2)} MiB；真实时长 ${durationSec.toFixed(2)} 秒${acceptNote}）`, now(), now(), id);
    // ★ 成功记账：失败分清零、连续失败归零。只有真的落进 ready（changes=1）才记 ——
    //   并发下两个 resolving 同时到这，只有一个能赢，别把已被取消/失败的也算成功。
    if (ready.changes) {
      const accountId = db.prepare('SELECT account_id FROM dola_videos WHERE id=?').get(id)?.account_id;
      recordTaskSuccess(db, accountId);
      // ★ 出片成功是「已登录」的**最强证据**：坐实登录态，并顺手解掉历史上可能存在的登录防护。
      //   清 guard 的常规入口只有只读探针（generation-guard-probe），但真实出片比探针更强，
      //   没有任何理由让一个已经被证明能出片的号还被旧的登录防护挡在池外。
      const okId = Number(accountId);
      if (Number.isSafeInteger(okId) && okId > 0) {
        const at = now();
        db.prepare("UPDATE dola_accounts SET login_state='available',login_at=?,login_note=?,updated_at=? WHERE id=?")
          .run(at, '出片成功，已确认登录态与创作面板可用', at, okId);
        db.prepare("UPDATE dola_generation_guards SET cleared_at=? WHERE account_id=? AND scope='login' AND cleared_at IS NULL")
          .run(at, okId);
      }
    }
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
      prompt: row.prompt,
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

// ---------------------------------------------------------------- 删除（成片库，2026-09-27）

/** 运行中 / 排队中：**禁止删除**（前端置灰，后端也直接拒绝） */
export const UNDELETABLE_TASK_STATES = ['queued', 'submitting', 'generating', 'resolving'];

export function isTaskDeletable(status) {
  return !UNDELETABLE_TASK_STATES.includes(String(status || ''));
}

/**
 * 删除一条生成任务，并清掉三样会变成孤儿/隐患的东西：
 *
 *   ① `dola_submission_journal` 里 task_id 相同的记录 —— **最关键**。
 *      它不清，accountHasUnsettledSubmission() 会永久把这个账号排除出选号池
 *      （成因见 cancelVideoTask 顶部那段注释）。删了任务却留着它 = 号白丢了。
 *   ② `local_path` 指向的归档成片文件 —— 不删就是磁盘上的孤儿文件。
 *   ③ 参考图缓存。
 *
 * ⚠️ `dola_generation_guards` **故意不动**：它是账号×档位的能力防护，
 * 有自己的「被更新的探测结果证伪」解锁机制（generation-guards.js），
 * 与单条任务记录是否还在无关；跟着删反而会误放行能力校验。
 *
 * @returns null = 任务不存在；{ ok:false, reason } = 状态不允许删除；{ ok:true, ... } = 已删除
 */
export async function deleteVideoTask(id) {
  const taskId = Number(id);
  const row = db.prepare('SELECT id, status, local_path FROM dola_videos WHERE id = ?').get(taskId);
  if (!row) return null;
  if (!isTaskDeletable(row.status)) {
    return { ok: false, id: taskId, reason: `当前状态 ${row.status} 不允许删除（运行中/排队中的任务不能删）` };
  }

  const journalCleared = db.prepare('DELETE FROM dola_submission_journal WHERE task_id = ?').run(taskId).changes;
  const deleted = db.prepare('DELETE FROM dola_videos WHERE id = ?').run(taskId).changes;
  void cleanupReferenceImages(taskId).catch(() => {});

  const filePath = row.local_path ? String(row.local_path) : '';
  let fileRemoved = false;
  if (filePath) {
    try {
      await fs.unlink(filePath);
      fileRemoved = true;
    } catch {
      // 文件本来就不存在（归档失败 / 已被清过）—— 不算删除失败，只是没有东西可删
    }
  }

  return {
    ok: true, id: taskId, status: row.status,
    deleted: deleted > 0, journalCleared, fileRemoved, filePath: filePath || null,
  };
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
    // ★ 2026-09-29：与 fail() 同口径 —— 人工核对判「上游未产出」后任务落 failed，
    //   参考图**保留**（交给保留期回收），这样用户仍能「重新提交」复用原图。
    return { resolution, refunded, taskStatus: 'failed' };
  }

  throw Object.assign(new Error('resolution 只能是 failed 或 release'), { status: 400 });
}

// ---------------------------------------------------------------- 路由决策视图

/**
 * 生成路由决策（对照参考站 /admin/route 的「号 | 排序 | 剩余额度 | 失败分 | 占用 | 原因」）。
 *
 * 与 candidates() 同源的池评估：能参选的号给出完整排序键与排序原因，
 * 被排除的号给出**第一个命中的排除原因** —— 排障时不用翻日志猜"为什么没选它"。
 * 冷却中的号也列入 excluded（candidates() 的 SQL 会把它们滤掉，但运维需要看见它们）。
 *
 * 字段白名单由 routeRow() 保证：绝不带 cookie / proxy / exit_ip / cookie_hash。
 */
export function generationRouteView({ seconds = null, requireReferenceImages = false, limit = 8 } = {}) {
  const nowIso = now();
  const nowMs = Date.parse(nowIso) || Date.now();
  const minIntervalSec = num('dola_gen_min_submit_interval_sec', 60);
  const pool = db.prepare(`SELECT * FROM dola_accounts
                           WHERE status = 'valid' AND TRIM(COALESCE(proxy, '')) <> ''
                           ORDER BY id ASC LIMIT 300`).all();

  // 与 candidates() 完全同源的排除判据，只是返回原因而不是默默滤掉。
  const exclusionReason = (account) => {
    if (account.cooldown_until && account.cooldown_until > nowIso) return `冷却中（至 ${String(account.cooldown_until).slice(11, 16)}）`;
    if (ACCOUNT_SELECTION_RESERVATIONS.has(account.id)) return '刚被另一路选中，探测中';
    if (accountHasUnsettledSubmission(db, account.id)) return '有未完结的提交记录';
    if (account.login_state === 'unavailable') return '登录态未确认（创作输入框未出现）';
    if (hasConfirmedZeroVideoQuota(account, nowIso)) return '已确认今日额度为零';
    if (hasGenerationGuard(db, account.id, seconds, requireReferenceImages)) return '触发生成防护（近期同类失败）';
    const exitIssue = generationExitIpIssue(account);
    if (exitIssue) return exitIssue;
    const throttle = submitThrottle(account, minIntervalSec, nowMs);
    if (throttle.throttled) return `提交间隔未到（还需 ${throttle.waitSeconds}s）`;
    return null;
  };

  const eligible = [];
  const excluded = [];
  for (const account of pool) {
    const reason = exclusionReason(account);
    if (reason) excluded.push({ id: Number(account.id), label: String(account.label || ''), reason });
    else eligible.push(account);
  }

  const inflightIds = new Set(db.prepare(`SELECT DISTINCT account_id FROM dola_videos
    WHERE status IN ('submitting','generating','resolving') AND account_id IS NOT NULL`).all()
    .map((r) => Number(r.account_id)));
  const capped = Math.max(1, Math.min(50, Number(limit) || 8));
  // ⚠️ 与 `candidates()` **同源**：这里也必须挂 `upstream_reached`，否则排障面
  //    显示的顺序会和真正选号的顺序不一致 —— 那比不显示更糟（会让人按错的顺序排障）。
  const ranked = rankCandidates(attachUpstreamReached(eligible), { nowMs });
  return {
    at: nowIso,
    seconds: seconds == null ? null : Number(seconds),
    requireReferenceImages: Boolean(requireReferenceImages),
    minSubmitIntervalSec: minIntervalSec,
    failScoreCap: FAIL_SCORE_CAP,
    decayPerHour: FAIL_SCORE_DECAY_PER_HOUR,
    concurrency: concurrency(),
    // 把 30 秒的两个口径开关一起回显：排障时"为什么 30 秒能/不能选到号"
    // 取决于它们，而它们来自 settings，光看 excluded 列表看不出来。
    allow30sRewrite: allow30sRewrite(),
    upstreamConcatEnabled: upstreamConcatEnabled(),
    carrierMap: durationCarrierMap(),
    running,
    ranked: ranked.slice(0, capped).map((acc, i) => routeRow(acc, i + 1, {
      nowMs, minIntervalSec, inflight: inflightIds.has(Number(acc.id)),
    })),
    eligibleCount: eligible.length,
    excludedCount: excluded.length,
    excluded: excluded.slice(0, 50),
  };
}
