/**
 * 用户端网关：给 8787 工作台这类"用户端"调用的服务端接口。
 *
 * 定位：后台是**控制面**（发令牌 / 发卡密 / 管 dola 账号池 / 计积分），
 * 用户端是**用户面**（登录、看积分、提交生成）。两边的信任边界靠一个共享密钥。
 *
 * 鉴权：请求头 `X-Gateway-Key: <gateway_key>`（系统设置 → 用户端网关里能看到/重置）。
 *       网关接口**不认 JWT** —— 它们不是给人用的，是给另一个服务用的。
 *
 * 三个接口：
 *   POST /api/gateway/verify    {token}                      → 令牌是否有效 + 余额
 *   POST /api/gateway/redeem    {token, card}                → 用户自助兑换积分卡
 *   POST /api/gateway/consume   {token, points?, reason, ref} → 原子扣积分（幂等）
 *   POST /api/gateway/refund    {ref, note}                   → 按 ref 退款（幂等）
 *
 * 视频生成（用户端工作台用）：
 *   POST /api/gateway/gen             {token, prompt, ratio?, mode?, seconds?, forceSeconds?} → 扣积分 + 建生成任务
 *   GET  /api/gateway/gen/:id?token=  → 查进度；完成时返回**无水印直链**
 *   GET  /api/gateway/gen?token=      → 列自己的任务
 *   POST /api/gateway/gen/:id/cancel  {token} → 取消（仅在未提交到上游时可退款）
 *
 * 幂等为什么必须做：用户端提交生成后要扣积分，如果它重试或重启，
 * 没有幂等键就会重复扣。所以 consume/refund 都按 `ref`（一般用 task_id）唯一。
 */
import express from 'express';
import { db, getSetting } from '../db.js';
import { audit } from '../audit.js';
import { chargeVideoTask, settleFailedVideoRefund } from '../dola/generation-billing.js';
import { streamVideoFile } from '../dola/video-file.js';
import {
  createVideoTask, startVideoTask, getVideoTask, listVideoTasks, cancelVideoTask,
  toPublic, generationStatus, nativeFifteenSecondPoolStats,
  nativeThirtySecondPoolStats, referenceImagePoolStats, localFileOf,
} from '../dola/generator.js';
import { validateReferenceImages } from '../dola/reference-images.js';
import { saveReferenceImages, cleanupReferenceImages } from '../dola/reference-image-store.js';
import { findUnsettledPrompt } from '../dola/submission-journal.js';
import { sanitizePreflightDiagnostic } from '../dola/preflight-diagnostics.js';

const router = express.Router();

const numSetting = (k, d) => {
  const v = Number(getSetting(k, String(d)));
  return Number.isFinite(v) ? v : d;
};

const DEFAULT_PROMPT_COOLDOWN_SECONDS = 120;
const PROMPT_RESERVATIONS = new Map();

/** 给重复提交保护用的提示词归一化：只折叠空白，不改用户实际保存的原文。 */
export function normalizePromptForGuard(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

function promptCooldownSeconds() {
  const value = Math.floor(numSetting(
    'gateway_prompt_cooldown_seconds',
    DEFAULT_PROMPT_COOLDOWN_SECONDS,
  ));
  return Math.min(3600, Math.max(0, value));
}

function promptReservationKey(ownerTokenId, prompt) {
  return `${ownerTokenId}:${normalizePromptForGuard(prompt)}`;
}

/**
 * 找出同一令牌近期提交过的相同提示词。
 *
 * 这里查数据库而不是只靠内存，服务重启后仍能挡住短时间重复提交；
 * 进程内 reservation 则补上两个并发请求都在账号体检阶段时的竞态窗口。
 */
export function findRecentPromptDuplicate(ownerTokenId, prompt, nowMs = Date.now()) {
  if (ownerTokenId == null) return null;
  const unsettled = findUnsettledPrompt(db, ownerTokenId, prompt);
  if (unsettled) return { id: unsettled.id, status: unsettled.status, createdAt: unsettled.created_at,
    retryAfterSeconds: null, requiresReconciliation: true };
  const cooldown = promptCooldownSeconds();
  if (cooldown <= 0) return null;

  const key = promptReservationKey(ownerTokenId, prompt);
  const cutoffMs = nowMs - cooldown * 1000;
  const reservedAt = PROMPT_RESERVATIONS.get(key);
  if (reservedAt != null) {
    if (reservedAt >= cutoffMs) {
      return {
        id: null,
        status: 'submitting',
        createdAt: new Date(reservedAt).toISOString(),
        retryAfterSeconds: Math.max(1, Math.ceil((reservedAt + cooldown * 1000 - nowMs) / 1000)),
      };
    }
    PROMPT_RESERVATIONS.delete(key);
  }

  const cutoff = new Date(cutoffMs).toISOString();
  const target = normalizePromptForGuard(prompt);
  const rows = db.prepare(`SELECT id, prompt, status, created_at
                           FROM dola_videos
                           WHERE owner_token_id = ?
                             AND created_at >= ?
                             AND status <> 'cancelled'
                           ORDER BY id DESC LIMIT 50`).all(ownerTokenId, cutoff);
  const row = rows.find((item) => normalizePromptForGuard(item.prompt) === target);
  if (!row) return null;

  const createdMs = Date.parse(row.created_at);
  const elapsed = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    retryAfterSeconds: Math.max(1, Math.ceil((cooldown * 1000 - elapsed) / 1000)),
  };
}

function reservePrompt(ownerTokenId, prompt, nowMs = Date.now()) {
  const duplicate = findRecentPromptDuplicate(ownerTokenId, prompt, nowMs);
  if (duplicate) return duplicate;
  if (promptCooldownSeconds() > 0) {
    PROMPT_RESERVATIONS.set(promptReservationKey(ownerTokenId, prompt), nowMs);
  }
  return null;
}

function releasePromptReservation(ownerTokenId, prompt) {
  PROMPT_RESERVATIONS.delete(promptReservationKey(ownerTokenId, prompt));
}

/** 网关鉴权：共享密钥。不通过一律 401。 */
function requireGatewayKey(req, res, next) {
  if (getSetting('gateway_enabled', 'true') !== 'true') {
    return res.status(503).json({ ok: false, message: '网关已在后台关闭（系统设置 → 用户端网关）' });
  }
  const expect = getSetting('gateway_key', '');
  const got = String(req.headers['x-gateway-key'] || '');
  if (!expect) return res.status(503).json({ ok: false, message: '后台还没生成网关密钥' });
  // 定长比较，避免时序侧信道（密钥是 hex，长度固定）
  if (got.length !== expect.length) return res.status(401).json({ ok: false, message: '网关密钥错误' });
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= got.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return res.status(401).json({ ok: false, message: '网关密钥错误' });
  next();
}

router.use(requireGatewayKey);

const publicToken = (t) => ({
  tokenId: t.id,
  name: t.name,
  prefix: t.prefix,
  points: t.points,
  status: t.status,
  expiresAt: t.expires_at,
});

/**
 * POST /api/gateway/verify —— 用户端登录时调
 * 只回令牌的"公开信息"，不含完整令牌值。
 */
router.post('/verify', (req, res) => {
  const raw = String(req.body?.token || '').trim();
  if (!raw) return res.status(400).json({ ok: false, message: '缺少 token' });

  const t = db.prepare('SELECT * FROM tokens WHERE value = ?').get(raw);
  if (!t) return res.status(401).json({ ok: false, message: '访问令牌无效' });
  if (t.status !== 'active') {
    return res.status(403).json({ ok: false, message: `令牌当前状态为「${t.status}」，无法登录` });
  }
  if (t.expires_at && new Date(t.expires_at) < new Date()) {
    return res.status(403).json({ ok: false, message: `令牌已于 ${t.expires_at} 过期` });
  }
  res.json({ ok: true, ...publicToken(t) });
});

/**
 * POST /api/gateway/redeem —— 用户端自助兑换卡密。
 *
 * 这里不复用后台的 /api/cards/redeem：那个接口是管理员把卡充给任意令牌，
 * 而本接口只允许把卡充给当前请求里验证通过的令牌，避免用户传入别人的 tokenId。
 */
router.post('/redeem', (req, res) => {
  const raw = String(req.body?.token || '').trim();
  const code = String(req.body?.card || '').trim();
  if (!raw) return res.status(400).json({ ok: false, message: '缺少 token' });
  if (!code) return res.status(400).json({ ok: false, message: '请输入卡密' });

  const token = db.prepare('SELECT * FROM tokens WHERE value = ?').get(raw);
  if (!token) return res.status(401).json({ ok: false, message: '访问令牌无效' });
  if (token.status !== 'active') return res.status(403).json({ ok: false, message: `令牌状态为「${token.status}」，不能兑换` });

  const card = db.prepare('SELECT * FROM cards WHERE code = ?').get(code);
  if (!card) return res.status(404).json({ ok: false, message: '卡密不存在' });
  if (card.status === 'redeemed') return res.status(409).json({ ok: false, message: `该卡密已于 ${card.redeemed_at} 被兑换` });
  if (card.status === 'revoked') return res.status(400).json({ ok: false, message: '该卡密已被撤销' });
  if (card.expires_at && new Date(card.expires_at) < new Date()) {
    return res.status(400).json({ ok: false, message: `该卡密已于 ${card.expires_at} 过期` });
  }

  const now = new Date().toISOString();
  // 关键：带 status='unused' 条件，和后台兑换接口一样兜住并发重复兑换。
  const info = db.prepare(
    'UPDATE cards SET status=?, redeemed_by_token=?, redeemed_at=?, updated_at=? WHERE id=? AND status=?',
  ).run('redeemed', token.id, now, now, card.id, 'unused');
  if (!info.changes) return res.status(409).json({ ok: false, message: '卡密已被其他请求兑换，请刷新后重试' });

  db.prepare('UPDATE tokens SET points = points + ?, updated_at=? WHERE id=?')
    .run(card.points, now, token.id);
  const balance = db.prepare('SELECT points FROM tokens WHERE id = ?').get(token.id).points;
  audit(req, 'gateway.card.redeem', 'card', card.id, `面额 ${card.points} → 令牌 ${token.prefix}（余额 ${balance}）`);
  res.json({ ok: true, points: card.points, balance, tokenPrefix: token.prefix });
});

/**
 * POST /api/gateway/consume —— 扣积分
 * 幂等：同一个 ref 只会成功扣一次；重复调用直接返回上次结果。
 */
router.post('/consume', (req, res) => {
  const raw = String(req.body?.token || '').trim();
  const ref = String(req.body?.ref || '').trim();
  const reason = String(req.body?.reason || 'consume');
  const points = Number(req.body?.points ?? numSetting('gateway_points_per_task', 1));

  if (!raw) return res.status(400).json({ ok: false, message: '缺少 token' });
  if (!ref) return res.status(400).json({ ok: false, message: '缺少 ref（幂等键，一般用 task_id）' });
  if (!Number.isInteger(points) || points <= 0) {
    return res.status(400).json({ ok: false, message: 'points 必须是正整数' });
  }

  const t = db.prepare('SELECT * FROM tokens WHERE value = ?').get(raw);
  if (!t) return res.status(401).json({ ok: false, message: '访问令牌无效' });
  if (t.status !== 'active') return res.status(403).json({ ok: false, message: `令牌状态为「${t.status}」，不能消费` });

  // 已经扣过就直接回上次结果（幂等）
  const existed = db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref = ?").get(ref);
  if (existed) {
    const now = db.prepare('SELECT points FROM tokens WHERE id = ?').get(t.id);
    return res.json({ ok: true, duplicated: true, charged: -existed.delta, balance: now.points, prefix: t.prefix });
  }

  // 原子扣减：把余额条件写进 WHERE，避免"先查再扣"的竞态
  const info = db.prepare(
    "UPDATE tokens SET points = points - ?, updated_at = ? WHERE id = ? AND status = 'active' AND points >= ?",
  ).run(points, new Date().toISOString(), t.id, points);

  if (!info.changes) {
    const cur = db.prepare('SELECT points FROM tokens WHERE id = ?').get(t.id).points;
    return res.status(402).json({ ok: false, message: `积分不足（需要 ${points}，当前 ${cur}）`, balance: cur, need: points });
  }

  db.prepare(`INSERT INTO point_transactions (token_id, token_prefix, delta, kind, reason, ref, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(t.id, t.prefix, points, 'consume', reason, ref, new Date().toISOString());

  const balance = db.prepare('SELECT points FROM tokens WHERE id = ?').get(t.id).points;
  res.json({ ok: true, duplicated: false, charged: points, balance, prefix: t.prefix, tokenId: t.id });
});

/**
 * 非任务类退款：加积分 + 写流水必须**同生共死**。
 *
 * 踩过的坑：这里原本是两条独立的 db.prepare().run()，没有事务。
 * 只靠 `point_transactions(kind,ref)` 的唯一索引挡不住真正的风险 ——
 * 唯一索引只能防「重复写流水」，防不住「加了积分、还没写流水就崩溃」：
 *   ① UPDATE tokens 加回积分 ✅
 *   ② 进程挂掉（或写盘失败）发生在两步之间
 *   ③ 流水里没有这条 refund → 幂等判据查不到 → 调用方重试
 *   ④ 再加一次积分 → **凭空多出积分，且不违反任何唯一约束**
 * 资金正确性不靠概率，包进事务即可。
 *
 * 为什么手写 SAVEPOINT 而不是 better-sqlite3 的 db.transaction()：
 * 见 db.js 的 wrap() —— db 是被包成 `{ exec, prepare }` 的，
 * 底层驱动可能是 better-sqlite3，也可能是 node:sqlite 回退（没有 transaction()）。
 * 所以全项目（generation-billing.js / submission-journal.js）统一走 SAVEPOINT。
 */
function atomic(db, work) {
  db.exec('SAVEPOINT gateway_refund');
  try {
    const result = work();
    db.exec('RELEASE SAVEPOINT gateway_refund');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT gateway_refund');
    db.exec('RELEASE SAVEPOINT gateway_refund');
    throw error;
  }
}

/** 加积分 + 记退款流水，同事务。返回最新余额。 */
function postRefundLedger({ tokenId, tokenPrefix, delta, reason, ref, at }) {
  return atomic(db, () => {
    const updated = db.prepare('UPDATE tokens SET points = points + ?, updated_at = ? WHERE id = ?')
      .run(delta, at, tokenId);
    if (!updated.changes) throw Object.assign(new Error('退款失败：令牌不存在'), { status: 404 });
    db.prepare(`INSERT INTO point_transactions (token_id, token_prefix, delta, kind, reason, ref, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(tokenId, tokenPrefix, delta, 'refund', reason, ref, at);
    return db.prepare('SELECT points FROM tokens WHERE id = ?').get(tokenId).points;
  });
}

/**
 * POST /api/gateway/refund —— 按 ref 退款
 * 生成失败时用户端调它（对齐上游"失败不扣费"的行为）。同样幂等；
 * 没找到对应的 consume 记录就直接拒绝，避免被拿来凭空加积分。
 */
router.post('/refund', (req, res) => {
  const ref = String(req.body?.ref || '').trim();
  const note = String(req.body?.note || '');
  if (!ref) return res.status(400).json({ ok: false, message: '缺少 ref' });

  const consume = db.prepare("SELECT * FROM point_transactions WHERE kind='consume' AND ref = ?").get(ref);
  if (!consume) return res.status(404).json({ ok: false, message: '没有找到这笔消费记录，拒绝退款' });

  const already = db.prepare("SELECT * FROM point_transactions WHERE kind='refund' AND ref = ?").get(ref);
  if (already) {
    const cur = db.prepare('SELECT points FROM tokens WHERE id = ?').get(consume.token_id);
    return res.json({ ok: true, duplicated: true, refunded: already.delta, balance: cur?.points ?? null });
  }

  // A client-side timeout is not a failed upstream generation. The dedicated
  // failed-task settlement rechecks the row inside a transaction.
  const video = db.prepare('SELECT * FROM dola_videos WHERE charge_ref=?').get(ref);
  if (video) {
    if (video.status !== 'failed' || video.owner_token_id !== consume.token_id) {
      return res.status(409).json({ ok: false, code: 'GENERATION_REFUND_UNCONFIRMED',
        message: '生成任务尚未确认失败，不能根据客户端超时退款；请查询原任务', refunded: false });
    }
    const result = settleFailedVideoRefund(db, video);
    return res.json({ ok: true, duplicated: Boolean(result.duplicated), refunded: result.points || 0, balance: result.balance });
  }

  // 兜底分支：没有对应任务行（例如充值类 ref）也走同一把事务。
  const now = new Date().toISOString();
  let balance;
  try {
    balance = postRefundLedger({
      tokenId: consume.token_id,
      tokenPrefix: consume.token_prefix,
      delta: consume.delta,
      reason: note || '生成失败退款',
      ref,
      at: now,
    });
  } catch (e) {
    // 撞唯一索引 = 另一个并发请求刚退过这笔，按幂等成功返回，别升级成 500。
    if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const cur = db.prepare('SELECT points FROM tokens WHERE id = ?').get(consume.token_id);
      return res.json({ ok: true, duplicated: true, refunded: consume.delta, balance: cur?.points ?? null });
    }
    throw e;
  }

  res.json({ ok: true, duplicated: false, refunded: consume.delta, balance });
});

/** GET /api/gateway/health —— 用户端启动时探活用 */
router.get('/health', (req, res) => {
  const native15 = nativeFifteenSecondPoolStats();
  const native30 = nativeThirtySecondPoolStats();
  const referenceImages = referenceImagePoolStats();
  res.json({
    ok: true,
    pointsPerTask: numSetting('gateway_points_per_task', 1),
    generation: generationStatus(),
    // These are accepted native request targets. 15s is the expert Seedance
    // 2.0 path; readiness is reported only when a matching account has a
    // read-only page probe plus an exclusive verified exit.
    supportedSeconds: [10, 15, 20, 30],
    expertSeconds: [15],
    expertSecondsReady: native15.ready,
    fixedSeconds: 30,
    fixedSecondsReady: native30.ready,
    native15,
    native30,
    // Reference-image uploads open only when at least one probed account is
    // available with an exclusive verified exit. Counts only — no labels/IPs.
    referenceImagesReady: referenceImages.ready,
    referenceImages,
    time: new Date().toISOString(),
  });
});

// ================================================================ 视频生成
//
// 为什么生成能力放在控制面而不是用户面：
//   真实生成要用 dola 账号池的 cookie 跑**有头/无头浏览器**（要 a_bogus 签名），
//   还得集中管「哪个号在用、用了多久、有没有被风控」。这些只有控制面知道。
//   用户面只负责"提交意图 + 看进度 + 拿成片"。
//
// 计费顺序（有意为之）：**先建任务占坑，再扣积分；扣不动就把坑撤掉**。
//   反过来做（先扣后建）会在"账号池空 / 浏览器不可用"时白扣用户积分，
//   而那种失败用户端退款链路要等到任务失败才触发，体验很差。

const GEN_TERMINAL = new Set(['ready', 'failed', 'cancelled']);

/** 用户令牌可能放在 query 或 `X-User-Token` 头里（服务间调用，不走 JWT） */
const userTokenOf = (req) => String(
  req.body?.token || req.query?.token || req.headers['x-user-token'] || '',
).trim();

/**
 * 任务失败时自动退款（幂等）。
 *
 * 生成器写入失败时主动结算；查询只是幂等补偿入口。
 * 余额、退款流水处于同一事务，客户端关闭页面也不影响新失败任务退款。
 *
 * @returns {{refunded:boolean, duplicated?:boolean, points?:number, balance?:number}}
 */
function settleFailureRefund(row) {
  return settleFailedVideoRefund(db, row);
}

/** 网关建任务失败时的结构化错误：status/code/message + 透传给 HTTP 响应的附加字段。 */
export class GatewayTaskError extends Error {
  constructor({ status = 500, code = null, message = '任务提交失败', fields = {} } = {}) {
    super(message);
    this.name = 'GatewayTaskError';
    this.status = status;
    this.code = code;
    this.fields = fields || {};
  }
}

/**
 * 提交一次生成（扣积分 + 建任务）：给 8787 工作台和后台批量创建共用的唯一入口。
 *
 * 链路顺序与原来 POST /api/gateway/gen 完全一致：
 * 令牌校验 → 积分校验 → 提示词排重 → 参考图校验 → 账号预检（createVideoTask 内）
 * → 队列限制 → 落库 → 保存参考图 → 扣积分（幂等）→ 启动 → 失败退款。
 *
 * @param {object} input
 * @param {string} input.tokenValue 用户令牌原文
 * @param {string} input.prompt
 * @param {string} [input.mode='standard'] standard|expert
 * @param {number} [input.seconds=10]
 * @param {number|null} [input.forceSeconds=null]
 * @param {string} [input.ratio='16:9']
 * @param {Array} [input.images=[]] 参考图（base64 数组）
 * @param {number|null} [input.accountId=null] 指定账号
 * @param {boolean} [input.strictAccount=false]
 * @param {number|null} [input.points=null] 每任务扣积分，默认取 gateway_points_per_task
 * @returns {{taskId, status, chargedPoints, balance, chargeRef, account, skippedAccounts, prompt, tokenId, tokenPrefix}}
 * @throws {GatewayTaskError}
 */
export async function submitGenerationTask(input = {}) {
  const fail = (opts) => { throw new GatewayTaskError(opts); };
  const tokenValue = String(input.tokenValue || '').trim();
  const prompt = String(input.prompt || '').trim();
  if (!tokenValue) fail({ status: 400, message: '缺少 token' });
  if (!prompt) fail({ status: 400, message: '缺少 prompt' });

  const mode = String(input.mode || 'standard').trim().toLowerCase();
  if (!['standard', 'expert'].includes(mode)) {
    fail({ status: 400, code: 'UNSUPPORTED_MODE', message: 'mode 仅支持 standard 或 expert' });
  }
  const requestedSeconds = Number(input.seconds ?? 10);
  if (requestedSeconds === 15 && mode !== 'expert') {
    fail({ status: 400, code: 'EXPERT_MODE_REQUIRED', message: '15 秒视频只能在专家模式提交，任务未提交，也未扣积分' });
  }

  const t = db.prepare('SELECT * FROM tokens WHERE value = ?').get(tokenValue);
  if (!t) fail({ status: 401, message: '访问令牌无效' });
  if (t.status !== 'active') fail({ status: 403, message: `令牌状态为「${t.status}」，不能消费` });

  if (t.expires_at && Date.parse(t.expires_at) <= Date.now()) {
    fail({ status: 403, message: '访问令牌已过期' });
  }

  const points = Number(input.points ?? numSetting('gateway_points_per_task', 1));
  if (!Number.isInteger(points) || points <= 0) {
    fail({ status: 400, message: 'points 必须是正整数' });
  }
  if (t.points < points) fail({ status: 402, message: '积分不足，任务未提交', fields: { balance: t.points, need: points } });

  // 上游对短时间重复相同提示词会触发限流；先挡在账号体检和扣积分之前。
  const duplicate = reservePrompt(t.id, prompt);
  if (duplicate) {
    const wait = duplicate.retryAfterSeconds;
    fail({
      status: 409,
      code: duplicate.requiresReconciliation ? 'GENERATION_SUBMISSION_UNRESOLVED' : 'PROMPT_COOLDOWN',
      message: duplicate.requiresReconciliation
        ? '相同提示词的原任务仍待核对；不会重新提交、换号或扣积分，请先查询原任务'
        : `相同提示词刚提交过，请等待约 ${wait} 秒后再试；本次未创建任务，也未扣积分`,
      fields: { retryAfterSeconds: wait, duplicateTaskId: duplicate.id },
    });
  }

  // 参考图：先校验，再看号池是否就绪；两者都在建任务/扣积分之前。
  let inspectedImages = [];
  try {
    inspectedImages = await validateReferenceImages(input.images, { prompt });
  } catch (error) {
    releasePromptReservation(t.id, prompt);
    fail({ status: error.status || 400, code: error.code || 'REFERENCE_IMAGE_INVALID', message: error.message });
  }
  if (inspectedImages.length) {
    const refPool = referenceImagePoolStats();
    if (!refPool.ready) {
      releasePromptReservation(t.id, prompt);
      fail({
        status: 409,
        code: 'REFERENCE_IMAGES_NOT_READY',
        message: '当前没有已确认支持参考图且代理隔离的可用账号，任务未提交，也未扣积分',
        fields: { referenceImages: { ready: false, eligible: refPool.eligible } },
      });
    }
  }

  // ① 建任务（内部会**先给账号做会话体检**再挑号；挑不到直接 409，此时还没扣费）
  let task;
  try {
    task = await createVideoTask({
      prompt,
      ratio: input.ratio || '16:9',
      mode,
      seconds: input.seconds ?? 10,
      forceSeconds: input.forceSeconds ?? null,
      accountId: input.accountId ?? null,
      strictAccount: input.strictAccount === true,
      ownerTokenId: t.id,
      ownerPrefix: t.prefix,
      chargeRef: '',
      hasReferenceImages: inspectedImages.length > 0,
      referenceImageCount: inspectedImages.length,
      deferStart: true,
    });
  } catch (e) {
    releasePromptReservation(t.id, prompt);
    if (String(e.code || '').startsWith('GENERATION_PREFLIGHT_')) {
      const diagnostic = sanitizePreflightDiagnostic(e.diagnostic);
      fail({
        status: e.status || 409, code: e.code, message: e.message,
        fields: {
          diagnostic,
          preflightAudit: {
            code: e.code,
            seconds: [10, 15, 20, 30].includes(requestedSeconds) ? requestedSeconds : null,
            mode, diagnostic, taskCreated: false, charged: false,
          },
        },
      });
    }
    if (e.code === 'GENERATION_QUEUE_FULL') {
      const status = generationStatus();
      fail({
        status: 429, code: e.code, message: e.message,
        fields: { generation: { activeTasks: status.activeTasks, queueLimit: status.queueLimit, queueAvailable: status.queueAvailable } },
      });
    }
    fail({ status: e.status || 500, code: e.code, message: e.message });
  }
  // 任务行已经落库，后续请求由数据库历史记录继续拦截；释放进程内 reservation，避免内存累积。
  releasePromptReservation(t.id, prompt);

  if (inspectedImages.length) {
    try {
      await saveReferenceImages(task.id, inspectedImages);
    } catch (error) {
      cancelVideoTask(task.id);
      await cleanupReferenceImages(task.id).catch(() => {});
      fail({ status: 500, code: 'REFERENCE_IMAGE_STORE_FAILED', message: '参考图保存失败，任务已取消，未扣积分' });
    }
  }

  // ② 扣积分：幂等键绑在任务 id 上，重试不会重复扣
  let charge;
  try { charge = chargeVideoTask(db, { taskId: task.id, tokenId: t.id, points }); }
  catch (error) {
    // No worker is scheduled yet: cancelled preparation must never submit to Dola.
    cancelVideoTask(task.id);
    await cleanupReferenceImages(task.id).catch(() => {});
    fail({
      status: error.status || 500,
      message: error.status ? error.message : '计费未完成，任务已取消',
      fields: { balance: error.balance, need: points },
    });
  }
  const { chargeRef, balance } = charge;
  try {
    if (!startVideoTask(task.id)) throw new Error('任务在准备期间已取消');
  } catch {
    cancelVideoTask(task.id);
    settleFailedVideoRefund(db, { ...task, status: 'queued' }, { cancelledBeforeSubmit: true });
    await cleanupReferenceImages(task.id).catch(() => {});
    fail({ status: 409, message: '任务未能启动，已取消并核对退还内部积分；未提交生成' });
  }

  const skippedAccounts = (task._skipped || []).map((s) => ({ id: s.id, label: s.label, reason: s.kind ?? String(s.code) }));
  return {
    taskId: task.id, status: task.status,
    chargedPoints: points, balance, chargeRef,
    account: task.account_label,
    // 体检过程中被剔除的失效账号（有值说明账号池在损耗，值得关注）
    skippedAccounts,
    prompt, mode, requestedSeconds, tokenId: t.id, tokenPrefix: t.prefix,
  };
}

/** POST /api/gateway/gen —— 提交一次生成（扣积分 + 建任务） */
router.post('/gen', async (req, res) => {
  try {
    const result = await submitGenerationTask({
      tokenValue: userTokenOf(req),
      prompt: req.body?.prompt,
      mode: req.body?.mode,
      seconds: req.body?.seconds,
      forceSeconds: req.body?.forceSeconds,
      ratio: req.body?.ratio,
      images: req.body?.images,
      accountId: req.body?.accountId,
      strictAccount: req.body?.strictAccount,
      points: req.body?.points,
    });
    audit(req, 'gateway.gen.create', 'dola_video', String(result.taskId), {
      prompt: String(req.body?.prompt || '').slice(0, 80),
      points: result.chargedPoints, account: result.account, skipped: result.skippedAccounts.length,
    });
    res.status(202).json({
      ok: true, taskId: result.taskId, status: result.status,
      chargedPoints: result.chargedPoints, balance: result.balance, chargeRef: result.chargeRef,
      account: result.account,
      skippedAccounts: result.skippedAccounts,
    });
  } catch (e) {
    if (e instanceof GatewayTaskError) {
      if (e.fields?.preflightAudit) {
        audit(req, 'gateway.gen.preflight_rejected', 'generation_attempt', '', e.fields.preflightAudit);
      }
      const { preflightAudit, ...rest } = e.fields || {};
      const body = { ok: false, message: e.message, ...rest };
      // 原路由在没有 code 的分支里就不带 code 键，保持一致
      if (e.code != null) body.code = e.code;
      return res.status(e.status || 500).json(body);
    }
    return res.status(500).json({ ok: false, message: e.message });
  }
});

/** GET /api/gateway/gen/:id —— 查进度；完成时**返回无水印直链** */
router.get('/gen/:id', (req, res) => {
  const raw = userTokenOf(req);
  if (!raw) return res.status(401).json({ ok: false, message: '缺少用户令牌' });
  const row = getVideoTask(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: '任务不存在' });
  if (raw) {
    const t = db.prepare('SELECT id FROM tokens WHERE value = ?').get(raw);
    if (!t || row.owner_token_id !== t.id) {
      return res.status(404).json({ ok: false, message: '任务不存在' });   // 不暴露"存在但不属于你"
    }
  }
  const pub = toPublic(row);
  // 失败的任务在查询时顺手把积分退回去（幂等，见 settleFailureRefund）
  const billing = settleFailureRefund(pub);

  // ★ url 优先级：本地归档 > 无水印直链 > 带水印直链。
  // 归档优先是因为 TOS 直链带签名会过期；归档过的文件是长期可靠的。
  // 归档文件的 URL 会把用户令牌带在 query 里 —— 这个接口本来就是服务间调用
  // （还要过网关密钥），而工作台代理时无法自定义上游请求头，所以令牌只能走 query。
  const tokenForUrl = userTokenOf(req);
  const localUrl = pub.ready && pub.archived && tokenForUrl
    ? `/api/gateway/gen/${pub.id}/file?token=${encodeURIComponent(tokenForUrl)}`
    : null;

  res.json({
    ok: true,
    taskId: pub.id,
    status: pub.status,
    stage: pub.stage,
    done: GEN_TERMINAL.has(pub.status),
    ready: pub.ready,
    url: pub.ready ? (localUrl || pub.url) : null,
    /** 给的是本地归档（不会过期）还是上游临时直链（会过期） */
    urlSource: !pub.ready ? null : localUrl ? 'archive' : (pub.unwatermarkedUrl ? 'unwatermarked-direct' : (pub.watermarkedUrl ? 'watermarked-direct' : null)),
    isUnwatermarked: pub.isUnwatermarked,
    archived: pub.archived,
    watermarkedUrl: pub.ready ? pub.watermarkedUrl : null,
    unwatermarkedUrl: pub.ready ? pub.unwatermarkedUrl : null,
    unwatermarkNote: pub.unwatermark_note,
    seconds: pub.seconds,
    durationSec: pub.duration_sec ?? null,
    forceSeconds: pub.force_seconds,
    bytes: pub.local_bytes ?? pub.bytes,
    error: pub.error,
    refunded: billing.refunded || false,
    balance: billing.balance ?? null,
    createdAt: pub.created_at,
    finishedAt: pub.finished_at,
  });
});

/**
 * GET /api/gateway/gen/:id/file —— 流式下载**本地归档**的成片。
 *
 * 为什么要走服务端流式而不是给个静态目录：视频可能几百 MB，
 * 一次性 readFile 进内存会顶爆；而且这个接口要按令牌校验归属，
 * 不能把文件目录直接暴露出去。所以支持 Range（浏览器拖进度条要靠它）。
 */
router.get('/gen/:id/file', async (req, res) => {
  try {
    const raw = userTokenOf(req);
    if (!raw) return res.status(401).json({ ok: false, message: '缺少用户令牌' });
    const row = getVideoTask(req.params.id);
    if (!row) return res.status(404).json({ ok: false, message: '任务不存在' });
    if (raw) {
      const t = db.prepare('SELECT id FROM tokens WHERE value = ?').get(raw);
      if (!t || row.owner_token_id !== t.id) {
        return res.status(404).json({ ok: false, message: '任务不存在' });
      }
    }
    const file = localFileOf(row);
    if (row.status !== 'ready') return res.status(409).json({ ok: false, message: '成片尚未通过验收，暂不可下载' });
    if (!file) return res.status(404).json({ ok: false, message: '该任务没有本地归档文件' });
    return streamVideoFile(req, res, { file, filename: `${row.id}${row.is_unwatermarked ? '-nowatermark' : ''}.mp4`, isUnwatermarked: Boolean(row.is_unwatermarked) });
  } catch (e) {
    // Express 4 不捕获 async 抛错；流式传输中途出错时响应头可能已发出，此时不能再写 JSON
    if (!res.headersSent) return res.status(502).json({ ok: false, message: '文件传输失败，请重试' });
    try { res.end(); } catch { /* 忽略 */ }
  }
});

/** GET /api/gateway/gen —— 按令牌列自己的任务 */
router.get('/gen', (req, res) => {
  const raw = userTokenOf(req);
  if (!raw) return res.status(400).json({ ok: false, message: '缺少 token' });
  const t = db.prepare('SELECT * FROM tokens WHERE value = ?').get(raw);
  if (!t) return res.status(401).json({ ok: false, message: '访问令牌无效' });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const items = listVideoTasks({ ownerTokenId: t.id, limit }).map(row => {
    const item = toPublic(row);
    // Never expose a filesystem path or account identity to the user workbench.
    return { id: item.id, status: item.status, stage: item.stage, prompt: item.prompt, ratio: item.ratio,
      seconds: item.seconds, duration_sec: item.duration_sec, error: item.error, created_at: item.created_at,
      finished_at: item.finished_at, archived: item.archived, is_unwatermarked: item.is_unwatermarked,
      unwatermark_note: item.unwatermark_note, local_bytes: item.local_bytes, bytes: item.bytes,
      url: item.ready && item.archived ? `/api/gateway/gen/${item.id}/file?token=${encodeURIComponent(raw)}` : null };
  });
  res.json({ ok: true, items });
});

/**
 * POST /api/gateway/gen/:id/cancel —— 取消 + 退款
 *
 * 退款策略：只有「还没提交到上游」或「上游明确失败」才退。
 * 已经开始生成的（submitting 之后）**不退** —— 上游额度已经花了，
 * 退了就是平台自己贴钱。这条规则要跟前端说清楚，别让用户以为随时能取消退款。
 */
router.post('/gen/:id/cancel', (req, res) => {
  const raw = userTokenOf(req);
  if (!raw) return res.status(401).json({ ok: false, message: '缺少用户令牌' });
  const row = getVideoTask(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: '任务不存在' });

  if (raw) {
    const t = db.prepare('SELECT id FROM tokens WHERE value = ?').get(raw);
    if (!t || row.owner_token_id !== t.id) {
      return res.status(404).json({ ok: false, message: '任务不存在' });
    }
  }

  const before = row.status;
  const refundable = before === 'queued' || before === 'failed';
  const updated = cancelVideoTask(row.id);

  if (!refundable) {
    return res.json({
      ok: true, refunded: false, status: updated.status,
      message: '生成已提交到上游，无法退款（上游额度已经消耗）',
    });
  }

  const billing = settleFailedVideoRefund(db, row, { cancelledBeforeSubmit: before === 'queued' });
  audit(req, 'gateway.gen.cancel', 'dola_video', String(row.id), { refunded: billing.points || 0 });
  res.json({ ok: true, ...billing, status: updated.status, refundedPoints: billing.points ?? 0 });
});

/**
 * GET /api/gateway/transactions —— 积分流水（管理后台看，仍走网关密钥）
 * 有 JWT 时也能看，见 routes/tokens.js 那边的管理入口。
 */
router.get('/transactions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const items = db.prepare(`SELECT t.*, tk.name AS token_name
                            FROM point_transactions t
                            LEFT JOIN tokens tk ON tk.id = t.token_id
                            ORDER BY t.id DESC LIMIT ?`).all(limit);
  res.json({ ok: true, items });
});

export default router;

// 供管理端复用的审计辅助（网关操作也记一笔）
export function auditGateway(req, action, detail) {
  audit(req, action, 'gateway', '', detail);
}
