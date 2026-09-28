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
import path from 'node:path';
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
import { saveReferenceImages, cleanupReferenceImages, listReferenceImages } from '../dola/reference-image-store.js';
import { findUnsettledPrompt } from '../dola/submission-journal.js';
import { sanitizePreflightDiagnostic } from '../dola/preflight-diagnostics.js';
import { SUPPORTED_VIDEO_SECONDS, RETIRED_VIDEO_SECONDS } from '../dola/generation-policy.js';
import { resolveTaskPoints, quotaView, usageSnapshot, parseModelCosts, QUOTA_SETTING_KEYS } from '../dola/gateway-quota.js';
import { switchView, SWITCH_KEYS } from '../dola/feature-switch.js';
import { readinessSummary } from '../dola/readiness.js';

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
  // 三层开关：总开关 × 范围（all/v1/admin）。`/api/gateway/*` 与 `/v1/*` 同属**对外**入口，
  // 所以这一层的 scope 是 `v1`（范围设成 v1 时对外关、后台工作台照常）。
  // fallback='true'：与改造前 `getSetting('gateway_enabled','true')` 的默认值保持一致 ——
  // 设置行万一丢失，不能把对外网关静默关掉。
  const view = switchView({ key: SWITCH_KEYS.gateway, scope: 'v1', fallback: 'true' });
  if (!view.effective_enabled) {
    return res.status(503).json({
      ok: false,
      code: 'GATEWAY_DISABLED',
      message: `网关已在后台关闭（系统设置 → 用户端网关）：${view.reasons.join('；') || '未开启'}`,
      switch: view,
    });
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
 * 卡密兑换的**唯一实现**。
 *
 * 两条入口共用它，不要再各写一份：
 *   · POST /api/gateway/redeem  —— 机器对机器（X-Gateway-Key），给 8787 那类用户端服务调
 *   · POST /v1/redeem           —— 调用方拿自己的 Bearer 令牌，直接给 /test.html 工作台用
 * 两份实现最容易走偏的地方是「并发重复兑换」那条原子条件（UPDATE ... AND status='unused'）
 * 与审计字段，一旦其中一份被改漏，卡就能被重复兑换成两份积分。
 *
 * ⚠️ 也刻意不复用后台的 /api/cards/redeem：那个接口是管理员把卡充给**任意**令牌，
 *    而这里只允许把卡充给入参里这个**已经校验过**的令牌 —— 不接受调用方传 tokenId，
 *    否则用户 A 能把自己的卡充到 B 头上，也能凭空给自己加积分。
 *
 * @param {{ token: object, code: string, req?: object|null,
 *           action?: string, actor?: object|null }} args
 *        token 必须是一条 tokens 行（已按调用方口径校验过存在性）。
 *        action / actor 只影响审计日志的操作名与操作人 —— 两条入口的审计动作名不同
 *        （gateway.card.redeem / v1.card.redeem），查询时才能分辨卡是从哪条路兑的。
 * @returns {{ ok: true, points: number, balance: number, at: string, tokenPrefix: string, cardId: number }
 *          | { ok: false, status: number, message: string }}
 */
export function redeemCard({
  token, code, req = null,
  action = 'gateway.card.redeem', actor = null,
} = {}) {
  const value = String(code ?? '').trim();
  if (!value) return { ok: false, status: 400, message: '请输入卡密' };
  if (!token) return { ok: false, status: 401, message: '访问令牌无效' };
  if (token.status !== 'active') {
    return { ok: false, status: 403, message: `令牌状态为「${token.status}」，不能兑换` };
  }

  const card = db.prepare('SELECT * FROM cards WHERE code = ?').get(value);
  if (!card) return { ok: false, status: 404, message: '卡密不存在' };
  if (card.status === 'redeemed') {
    return { ok: false, status: 409, message: `该卡密已于 ${card.redeemed_at} 被兑换` };
  }
  if (card.status === 'revoked') return { ok: false, status: 400, message: '该卡密已被撤销' };
  if (card.expires_at && new Date(card.expires_at) < new Date()) {
    return { ok: false, status: 400, message: `该卡密已于 ${card.expires_at} 过期` };
  }

  const now = new Date().toISOString();
  // 关键：带 status='unused' 条件，兜住并发重复兑换。
  const info = db.prepare(
    'UPDATE cards SET status=?, redeemed_by_token=?, redeemed_at=?, updated_at=? WHERE id=? AND status=?',
  ).run('redeemed', token.id, now, now, card.id, 'unused');
  if (!info.changes) return { ok: false, status: 409, message: '卡密已被其他请求兑换，请刷新后重试' };

  db.prepare('UPDATE tokens SET points = points + ?, updated_at=? WHERE id=?')
    .run(card.points, now, token.id);
  const balance = db.prepare('SELECT points FROM tokens WHERE id = ?').get(token.id).points;
  if (req) {
    audit(req, action, 'card', card.id, `面额 ${card.points} → 令牌 ${token.prefix}（余额 ${balance}）`, actor);
  }
  return { ok: true, points: card.points, balance, at: now, tokenPrefix: token.prefix, cardId: card.id };
}

/**
 * POST /api/gateway/redeem —— 用户端自助兑换卡密（机器对机器入口）。
 * 业务全在 redeemCard() 里；这里只负责按网关的口径（token 原文）取行与翻译响应。
 */
router.post('/redeem', (req, res) => {
  const raw = String(req.body?.token || '').trim();
  if (!raw) return res.status(400).json({ ok: false, message: '缺少 token' });

  const token = db.prepare('SELECT * FROM tokens WHERE value = ?').get(raw);
  if (!token) return res.status(401).json({ ok: false, message: '访问令牌无效' });

  const result = redeemCard({ token, code: req.body?.card, req });
  if (!result.ok) return res.status(result.status).json({ ok: false, message: result.message });
  res.json({ ok: true, points: result.points, balance: result.balance, tokenPrefix: result.tokenPrefix });
});

/**
 * POST /api/gateway/consume —— 扣积分
 * 幂等：同一个 ref 只会成功扣一次；重复调用直接返回上次结果。
 */
router.post('/consume', (req, res) => {
  const raw = String(req.body?.token || '').trim();
  const ref = String(req.body?.ref || '').trim();
  const reason = String(req.body?.reason || 'consume');
  // ⚠️ 这里**有意**不接「按模型计费」：本接口是通用的"扣多少分"入口，调用方
  //    （mvp 用户面）自己带 `points`，服务端看不到 seconds、也就无从判断模型。
  //    硬套 modelForTask 会把它变成"按 v2.5 的价扣"，是**静默涨价**。
  //    视频任务走 `submitGenerationTask`，那条路才做按模型计价。
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
  const costs = parseModelCosts(getSetting(QUOTA_SETTING_KEYS.modelCosts, ''));
  const gatewayView = switchView({ key: SWITCH_KEYS.gateway, scope: 'v1', fallback: 'true' });
  const generation = generationStatus();
  // 合成就绪度：把"能不能提交"收成一个结论，别让每个调用方自己拼四个布尔。
  // 本接口有网关密钥保护，所以可以回完整理由。
  const readiness = readinessSummary({
    gatewayEnabled: gatewayView.effective_enabled,
    generation,
    pools: {
      expertSecondsReady: native15?.ready,
      fixedSecondsReady: native30?.ready,
      referenceImagesReady: referenceImages?.ready,
    },
  });
  res.json({
    ok: true,
    pointsPerTask: numSetting('gateway_points_per_task', 1),
    // 价目表：用户端要能在下单**之前**算出这一单多少钱，否则只能在被扣费后才发现价不对。
    // `costsReason` 揭示价目表是不是坏的（invalid_json 等）—— 坏表会整份回落。
    pricing: {
      defaultPoints: numSetting('gateway_points_per_task', 1),
      costs: costs.ok ? costs.costs : {},
      costsOk: costs.ok,
      costsReason: costs.reason,
      dailyPointsLimit: numSetting(QUOTA_SETTING_KEYS.dailyLimit, 0),
    },
    gateway: gatewayView,
    // 三分级：ok / degraded / down。`degraded` 是常态（原生 15s/30s 本来就不常确认），
    // 所以调用方应当按"能不能用它想要的档位"来判，而不是要求 ok。
    readiness,
    generation,
    // These are accepted native request targets. 15s is the expert Seedance
    // 2.0 path; readiness is reported only when a matching account has a
    // read-only page probe plus an exclusive verified exit.
    // 档位精简（2026-09-27）：10 秒与 20 秒已下线，只对外宣告 15 / 30。
    supportedSeconds: [...SUPPORTED_VIDEO_SECONDS],
    retiredSeconds: [...RETIRED_VIDEO_SECONDS],
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
 * 解析「复用某个已存在任务的参考图」这个请求，返回服务端本地的图片路径列表。
 *
 * 用途：失败任务的「重新提交」。用户不想为了重试再把 6 张图从浏览器重传一遍，
 * 而图本来就躺在 `data/reference-uploads/<原taskId>/` 里（或曾经躺着）。
 * 前端只报「复用哪个任务、保留哪几张」，真正的字节走服务端内部读取。
 *
 * 三道关：
 *   ① **归属**：只能复用当前令牌自己创建的任务。任务不存在与不属于你回同一个错，
 *      避免用错误码把「别人的任务号存在」透出去。
 *   ② **存在**：原目录为空（被保留期回收 / 已被清理）时**明确报错**，
 *      绝不静默降级成「建一条没有参考图的任务」—— 那会让用户以为带图提交了。
 *   ③ **保留清单**：`keep` 里的名字必须在原目录里真实存在；一个都没匹配上同样报错。
 *
 * @param {object} args
 * @param {number|string|null} args.sourceTaskId 原任务 id（空 = 不复用）
 * @param {string|string[]|null} args.keep 要保留的原图文件名（空 = 全部保留）
 * @param {number} args.ownerTokenId 请求方令牌 id
 * @returns {Promise<{paths:string[], sourceTaskId:number|null}>}
 */
async function resolveReusedReferenceImages({ sourceTaskId, keep, ownerTokenId }) {
  const raw = sourceTaskId === null || sourceTaskId === undefined ? '' : String(sourceTaskId).trim();
  if (!raw) return { paths: [], sourceTaskId: null };
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new GatewayTaskError({ status: 400, code: 'REFERENCE_SOURCE_INVALID', message: 'reference_source_task 必须是任务号' });
  }
  const row = db.prepare('SELECT id, owner_token_id FROM dola_videos WHERE id = ?').get(id);
  if (!row || row.owner_token_id !== ownerTokenId) {
    throw new GatewayTaskError({
      status: 404, code: 'REFERENCE_SOURCE_NOT_FOUND',
      message: `原任务 #${id} 不存在或不属于当前令牌；未创建任务、未扣积分`,
    });
  }
  const all = await listReferenceImages(id);
  if (!all.length) {
    throw new GatewayTaskError({
      status: 400, code: 'REFERENCE_SOURCE_MISSING',
      message: `原任务 #${id} 的参考图已清理（暂存保留 24 小时），请重新上传后再提交；未创建任务、未扣积分`,
    });
  }
  let keepList = null;
  if (keep !== null && keep !== undefined && String(keep).trim() !== '') {
    let parsed = keep;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new GatewayTaskError({ status: 400, code: 'REFERENCE_SOURCE_INVALID', message: 'reference_source_keep 必须是 JSON 数组' });
      }
    }
    if (!Array.isArray(parsed)) {
      throw new GatewayTaskError({ status: 400, code: 'REFERENCE_SOURCE_INVALID', message: 'reference_source_keep 必须是数组' });
    }
    keepList = new Set(parsed.map((name) => path.basename(String(name ?? ''))));
  }
  const picked = keepList ? all.filter((p) => keepList.has(path.basename(p))) : all;
  if (!picked.length) {
    throw new GatewayTaskError({
      status: 400, code: 'REFERENCE_SOURCE_MISSING',
      message: `指定复用的参考图在 #${id} 里已不存在（可能已被清理），请重新上传后再提交；未创建任务、未扣积分`,
    });
  }
  return { paths: picked, sourceTaskId: id };
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
 * @param {number} [input.seconds=30] 15 或 30（10/20 已下线，会被 DURATION_RETIRED 拒绝）
 * @param {number|null} [input.forceSeconds=null] 同上白名单；不填则等于 seconds
 * @param {string} [input.ratio='16:9']
 * @param {Array} [input.images=[]] 参考图（base64 数组 / {dataBase64,name} / Buffer / 本地路径）
 * @param {number|string|null} [input.referenceSourceTaskId=null] 复用该**已有任务**暂存的参考图
 *        （失败任务的「重新提交」用：图不必从浏览器重传，服务端内部读出再按新任务落盘）
 * @param {string[]|string|null} [input.referenceSourceKeep=null] 只复用原目录里的这些文件名；
 *        不传 = 原目录全部复用
 * @param {number|null} [input.accountId=null] 指定账号
 * @param {boolean} [input.strictAccount=false]
 * @param {number|null} [input.points=null] 每任务扣积分。**不传时按模型与秒数计价**
 *        （见 dola/gateway-quota.js）；传了就按传的算（后台批量/测试用）。
 * @param {boolean} [input.autoStart=true] false = 只建任务并扣积分，等调用方自己启动（见 /v1 的 auto_start）
 * @returns {{taskId, status, started, chargedPoints, balance, chargeRef, account, skippedAccounts,
 *            prompt, tokenId, tokenPrefix, pricing, usage}}
 * @throws {GatewayTaskError} 额度超限时 `status=429, code=DAILY_POINTS_LIMIT`
 */
export async function submitGenerationTask(input = {}) {
  const fail = (opts) => { throw new GatewayTaskError(opts); };
  const tokenValue = String(input.tokenValue || '').trim();
  const prompt = String(input.prompt || '').trim();
  if (!tokenValue) fail({ status: 400, message: '缺少 token' });
  if (!prompt) fail({ status: 400, message: '缺少 prompt' });
  // auto_start=false：建任务 + 扣积分，但**不**派发。给 /v1 的 auto_start 用。
  // 默认 true，既有调用方（后台批量、/api/gateway/gen）行为完全不变。
  const autoStart = input.autoStart !== false;

  const mode = String(input.mode || 'standard').trim().toLowerCase();
  if (!['standard', 'expert'].includes(mode)) {
    fail({ status: 400, code: 'UNSUPPORTED_MODE', message: 'mode 仅支持 standard 或 expert' });
  }
  // 档位精简（2026-09-27）：10 秒与 20 秒**直接拒绝**，不做静默降级、不受理。
  // 放在令牌校验之前：这种请求根本不该消耗任何后端资源（令牌查询、额度判定、账号体检都不跑）。
  // 默认档位从 10 秒改为 30 秒 —— 30 秒是精简后的主档位，旧调用方不传 seconds 时
  // 拿到的是更长的成片、更低的单价（2 额度），而不是报错。
  const requestedSeconds = Number(input.seconds ?? 30);
  if (RETIRED_VIDEO_SECONDS.includes(requestedSeconds)) {
    fail({
      status: 400,
      code: 'DURATION_RETIRED',
      message: `${requestedSeconds} 秒档位已下线，请选择 15 秒（专家模式）或 30 秒；任务未提交，也未扣积分`,
      fields: { supportedSeconds: [...SUPPORTED_VIDEO_SECONDS] },
    });
  }
  if (!SUPPORTED_VIDEO_SECONDS.includes(requestedSeconds)) {
    fail({
      status: 400,
      code: 'DURATION_UNSUPPORTED',
      message: `seconds 仅支持 15 或 30；任务未提交，也未扣积分`,
      fields: { supportedSeconds: [...SUPPORTED_VIDEO_SECONDS] },
    });
  }
  if (requestedSeconds === 15 && mode !== 'expert') {
    fail({ status: 400, code: 'EXPERT_MODE_REQUIRED', message: '15 秒视频只能在专家模式提交，任务未提交，也未扣积分' });
  }
  // forceSeconds 会真的改变上游时长，必须一起受档位精简约束，否则
  // 「seconds=30（合法）+ forceSeconds=10（已下线）」就能绕过上面的拦截。
  const rawForced = input.forceSeconds;
  if (rawForced !== null && rawForced !== undefined && String(rawForced).trim() !== '') {
    const forcedSeconds = Number(rawForced);
    if (RETIRED_VIDEO_SECONDS.includes(forcedSeconds)) {
      fail({
        status: 400, code: 'DURATION_RETIRED',
        message: `forceSeconds=${forcedSeconds} 档位已下线，仅支持 15 或 30；任务未提交，也未扣积分`,
        fields: { supportedSeconds: [...SUPPORTED_VIDEO_SECONDS] },
      });
    }
    if (!SUPPORTED_VIDEO_SECONDS.includes(forcedSeconds)) {
      fail({
        status: 400, code: 'DURATION_UNSUPPORTED',
        message: 'forceSeconds 仅支持 15 或 30；任务未提交，也未扣积分',
        fields: { supportedSeconds: [...SUPPORTED_VIDEO_SECONDS] },
      });
    }
  }

  const t = db.prepare('SELECT * FROM tokens WHERE value = ?').get(tokenValue);
  if (!t) fail({ status: 401, message: '访问令牌无效' });
  if (t.status !== 'active') fail({ status: 403, message: `令牌状态为「${t.status}」，不能消费` });

  if (t.expires_at && Date.parse(t.expires_at) <= Date.now()) {
    fail({ status: 403, message: '访问令牌已过期' });
  }

  // 计价的「秒数口径」：`forceSeconds` 会真的改变上游时长（见 generator.js 的时长注入），
  // 所以按**实际要跑的秒数**计价，而不是按请求里写的那个。否则会出现
  // 「请求 10 秒、强改为 30 秒、按 10 秒的价收」——成本与收入对不上。
  const forcedSeconds = Number(input.forceSeconds);
  const pricingSeconds = Number.isFinite(forcedSeconds) && forcedSeconds > 0 ? forcedSeconds : requestedSeconds;

  // 定价优先级：显式 points > 价目表（模型|秒数 → 模型 → default）> gateway_points_per_task。
  // 显式 points 保留，是因为后台批量与测试都靠它钉住价格。
  const explicitPoints = input.points === null || input.points === undefined ? null : Number(input.points);
  const priced = explicitPoints === null
    ? resolveTaskPoints({ seconds: pricingSeconds })
    : { points: explicitPoints, source: 'explicit', key: 'input.points', costsReason: 'n/a' };
  const points = priced.points;
  if (!Number.isInteger(points) || points <= 0) {
    fail({ status: 400, message: 'points 必须是正整数' });
  }
  if (t.points < points) fail({ status: 402, message: '积分不足，任务未提交', fields: { balance: t.points, need: points } });

  // 每日额度闸门。放在这里（提示词占位、参考图校验、账号体检**之前**）有两个理由：
  //   ① 那些步骤都带副作用或很贵（体检要真发请求），额度不够就不该走到那一步；
  //   ② 这里是纯读+判断，失败时没有任何东西需要回滚。
  // ⚠️ 这个前置检查**挡不住并发**：两个请求可以同时读到"还没超"。真正的强一致
  //    在 `chargeVideoTask` 的 guard 里（同一个事务内复核）。两处共用同一段判断逻辑。
  const quota = quotaView({ token: t, points });
  if (!quota.ok) {
    fail({
      status: 429,
      code: 'DAILY_POINTS_LIMIT',
      message: `已达今日积分上限（上限 ${quota.limit}，今日已用 ${quota.used}），任务未提交，也未扣积分；`
        + `额度按服务器本地日结算，${quota.day} 当天内不再放行`,
      fields: { quota },
    });
  }

  // ── 复用原任务参考图（失败任务「重新提交」）─────────────────────────────
  // 放在 reservePrompt **之前**：原图已被清理这类失败不该占用提示词冷却窗口。
  // 否则用户点一次「重新提交」拿到「图已清理」，紧接着正确重传并提交时还会被冷却挡
  // 120 秒 —— 两个错误叠在一起，排查成本很高。
  let reusedReferencePaths = [];
  let reusedReferenceSource = null;
  try {
    const reused = await resolveReusedReferenceImages({
      sourceTaskId: input.referenceSourceTaskId,
      keep: input.referenceSourceKeep,
      ownerTokenId: t.id,
    });
    reusedReferencePaths = reused.paths;
    reusedReferenceSource = reused.sourceTaskId;
  } catch (error) {
    if (error instanceof GatewayTaskError) throw error;
    throw new GatewayTaskError({
      status: error.status || 500,
      code: error.code || 'REFERENCE_SOURCE_INVALID',
      message: `读取原任务的参考图失败：${error.message}；未创建任务、未扣积分`,
    });
  }

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

  // 参考图：只做输入校验；页面上传控件和对象存储上传必须在真实提交阶段确认。
  // 不能把历史只读探测的 unknown 当成“不可用”，否则任务还没落库就会被判失败，
  // 也无法让 Dola 的本次页面回执给出最终结论。
  let inspectedImages = [];
  try {
    const fresh = input.images == null ? [] : (Array.isArray(input.images) ? input.images : [input.images]);
    // 复用图排在前，与表单里的显示顺序一致（回填进来的在前，用户新追加的在后面）。
    // 这些路径会当作普通参考图输入读盘并**重新复检格式/体积**，之后由
    // saveReferenceImages() 按新 taskId 落盘 —— 对使用者就是一次「服务端内部拷贝」，
    // 浏览器不必把这几 MiB 再传一遍。
    inspectedImages = await validateReferenceImages([...reusedReferencePaths, ...fresh], { prompt });
  } catch (error) {
    releasePromptReservation(t.id, prompt);
    fail({ status: error.status || 400, code: error.code || 'REFERENCE_IMAGE_INVALID', message: error.message });
  }
  // ① 建任务（内部只做账号安全复核；模型/时长/参考图能力在真实提交阶段确认）
  let task;
  try {
    task = await createVideoTask({
      prompt,
      ratio: input.ratio || '16:9',
      mode,
      seconds: requestedSeconds,
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
            seconds: SUPPORTED_VIDEO_SECONDS.includes(requestedSeconds) ? requestedSeconds : null,
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
  try {
    charge = chargeVideoTask(db, {
      taskId: task.id, tokenId: t.id, points,
      // 同一个事务里复核每日额度：前面那道 `quotaView` 是"快速失败"，挡不住
      // 两个并发请求同时通过。这里才是强一致的那道闸。
      // ⚠️ 只在**首次扣费**时触发（chargeVideoTask 对已扣过的 ref 会跳过 guard），
      //    否则重试会因为"额度已被自己占掉"而假报超限。
      guard: ({ token: fresh }) => {
        const q = quotaView({ token: fresh, points });
        if (!q.ok) {
          throw Object.assign(
            new Error(`已达今日积分上限（上限 ${q.limit}，今日已用 ${q.used}），任务已取消，未扣积分`),
            { status: 429, code: 'DAILY_POINTS_LIMIT', fields: { quota: q } },
          );
        }
      },
    });
  }
  catch (error) {
    // No worker is scheduled yet: cancelled preparation must never submit to Dola.
    cancelVideoTask(task.id);
    await cleanupReferenceImages(task.id).catch(() => {});
    fail({
      status: error.status || 500,
      message: error.status ? error.message : '计费未完成，任务已取消',
      code: error.code,
      // `fields` 里可能带着 quotas/诊断（如 guard 抛的 quota），别丢掉
      fields: { balance: error.balance, need: points, ...(error.fields || {}) },
    });
  }
  const { chargeRef, balance } = charge;
  // 扣费**之后**再算一次用量，返回的才是"这笔算进去之后"的状态。
  const usage = usageSnapshot({ token: t });
  // auto_start=false 时到此为止：任务已是 queued 且已有效扣费，由调用方决定何时启动。
  // 不启动是安全的 —— startVideoTask 会先复核这笔扣费，没扣成不会跑。
  if (autoStart) {
    try {
      if (!startVideoTask(task.id)) throw new Error('任务在准备期间已取消');
    } catch {
      cancelVideoTask(task.id);
      settleFailedVideoRefund(db, { ...task, status: 'queued' }, { cancelledBeforeSubmit: true });
      await cleanupReferenceImages(task.id).catch(() => {});
      fail({ status: 409, message: '任务未能启动，已取消并核对退还内部积分；未提交生成' });
    }
  }

  const skippedAccounts = (task._skipped || []).map((s) => ({ id: s.id, label: s.label, reason: s.kind ?? String(s.code) }));
  return {
    taskId: task.id, status: task.status, started: autoStart,
    chargedPoints: points, balance, chargeRef,
    account: task.account_label,
    // 体检过程中被剔除的失效账号（有值说明账号池在损耗，值得关注）
    skippedAccounts,
    prompt, mode, requestedSeconds, tokenId: t.id, tokenPrefix: t.prefix,
    // 参考图复用（失败任务「重新提交」）：调用方据此说明图是从哪来的、几张是复用的。
    referenceSourceTaskId: reusedReferenceSource,
    reusedReferenceCount: reusedReferencePaths.length,
    // 这一笔的价是怎么来的（source/key）+ 今天的额度状态。
    // 没有 source 的话，"价格不对"只能靠翻设置猜，没法定位到具体命中了哪一档。
    pricing: {
      points, source: priced.source, key: priced.key,
      seconds: pricingSeconds, costsReason: priced.costsReason,
    },
    usage,
  };
}

/** POST /api/gateway/gen —— 提交一次生成（扣积分 + 建任务） */
router.post('/gen', async (req, res) => {
  // HTTP callers use server pricing; explicit prices remain an internal admin option.
  if (Object.hasOwn(req.body ?? {}, 'points')) {
    return res.status(400).json({
      ok: false, code: 'UNSUPPORTED_PARAMETER', message: 'points 由服务端定价，不支持客户端指定',
    });
  }
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
      pricing: result.pricing,
      usage: result.usage,
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
