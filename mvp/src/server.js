#!/usr/bin/env node
/**
 * 用户端：视频任务工作台。零依赖（node:http）。
 *
 *   node src/server.js --port 8787
 *
 * ---------- 架构 ----------
 * 管理后台（8788）= **控制面**：发令牌 / 发卡密 / 管 dola 账号池 / 计积分 / **跑真实生成**
 * 本服务（8787）  = **用户面**：用户登录、看积分、提交生成、下载成片
 *
 * 生成后端有两种（`--provider` 或 VIDEO_PROVIDER 决定）：
 *   admin-dola     —— 走后台网关。后台自己挑 dola 账号、开浏览器提交、等成片，
 *                     并**把无水印版本解析好**再返回。生产用这个。
 *   dola-workbench —— 老视频工作台（43.254.166.145），单租户模式。
 *   dola-api       —— 新 Bearer Token API（43.254.166.196），单租户模式。
 *
 * 认证：默认走**后台网关**（ADMIN_GATEWAY_URL + ADMIN_GATEWAY_KEY）。
 *      没配网关时退回旧模式（直接用 .env 里的上游令牌，单租户自用）。
 *
 * 计费：admin-dola 模式下**由后台扣**（先建任务占坑、再扣、扣不动就撤）；
 *      单租户模式下由本服务扣（consume + refund，都按同一个 ref 幂等）。
 *
 * 任务归属：admin-dola 后台自带归属（owner_token_id），本服务只做二次校验；
 *          单租户模式上游按平台账号返回列表，所有用户会看到彼此的任务，
 *          所以本地记一本「哪个 task 属于哪个令牌」（data/store.json）。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadEnv } from './core/env.js';
import { VideoClient } from './client.js';
import { listProviders } from './providers/index.js';
import { STATUS_LABEL_ZH } from './core/task.js';
import { createGateway, createTaskLedger } from './core/gateway.js';
import { publicTask } from './core/public-task.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');

/** Importing this module never loads .env, opens a ledger, or starts a listener. */
export async function createWorkbenchServer(options = {}) {
const env = options.env ?? process.env;
const logger = options.logger ?? console;
const createClient = options.createClient ?? ((config) => new VideoClient(config));

const argv = options.argv ?? [];
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}

const PORT = Number(flag('port', env.PORT || 8787));
const PROVIDER = flag('provider', env.VIDEO_PROVIDER || 'mock');
const PROVIDER_BASE_URL = PROVIDER === 'dola-api'
  ? env.DOLA_API_BASE_URL
  : env.DOLA_BASE_URL;
const DEFAULT_CREDENTIAL = PROVIDER === 'dola-api'
  ? (env.DOLA_API_TOKEN || null)
  : (env.DOLA_CREDENTIAL || null);
const FIXED_SECONDS = 30; // Legacy health field; native admin-dola supports 10/15/20/30.

// 去后台结算 / 校验令牌
const GATEWAY = options.gateway ?? createGateway({
  url: env.ADMIN_GATEWAY_URL || '',
  key: env.ADMIN_GATEWAY_KEY || '',
});
const ledger = options.ledger ?? createTaskLedger(options.ledgerFile ?? env.MVP_LEDGER_FILE ?? path.join(HERE, '..', 'data', 'store.json'));

// ---------------- 平台自己的生成资源 ----------------
// 两种模式（由 provider 名字决定）：
//   admin-dola     —— 生成能力在管理后台（dola 账号池 + 浏览器 + 无水印解析）。
//                     每个用户用**自己的访问令牌**提交，所以不能共用一个 client，
//                     要按令牌缓存（见 clientFor）。
//   其它 provider  —— 单租户模式：平台持有一份上游令牌，所有用户共用。
let platform = null;       // VideoClient（单租户 / 探活）
let platformReady = false;
let platformError = null;
let gatewayHealth = null;

/** 生成要不要按用户区分令牌 */
const PER_USER_PROVIDER = PROVIDER === 'admin-dola';
const SUPPORTED_SECONDS = Object.freeze(PER_USER_PROVIDER ? [10, 15, 20, 30] : [FIXED_SECONDS]);
const EXPERT_SECONDS = Object.freeze(PER_USER_PROVIDER ? [15] : []);
const DEFAULT_SECONDS = FIXED_SECONDS;

/**
 * admin-dola 的固定时长能力以后台实时号池状态为准。
 * 网关只返回计数和布尔值；失败时清空缓存，避免旧的 ready 状态误放行任务。
 */
async function refreshGatewayHealth() {
  if (!PER_USER_PROVIDER || !GATEWAY.enabled) return null;
  try {
    gatewayHealth = await GATEWAY.health();
    syncAdminDolaCapabilityFlags();
    return gatewayHealth;
  } catch {
    gatewayHealth = null;
    syncAdminDolaCapabilityFlags();
    return null;
  }
}

function adminDolaFixedSecondsReady() {
  return PER_USER_PROVIDER && gatewayHealth?.fixedSecondsReady === true;
}

function adminDolaExpertSecondsReady() {
  return PER_USER_PROVIDER && gatewayHealth?.expertSecondsReady === true;
}

function adminDolaReferenceImagesReady() {
  return PER_USER_PROVIDER && gatewayHealth?.referenceImagesReady === true;
}

function syncAdminDolaCapabilityFlags() {
  if (!PER_USER_PROVIDER) return;
  const ready = adminDolaReferenceImagesReady();
  if (platform?.p) platform.p.referenceImagesReady = ready;
  for (const client of userClients.values()) {
    if (client?.p) client.p.referenceImagesReady = ready;
  }
}

async function loginPlatform() {
  const providerOptions = PER_USER_PROVIDER
    ? { gateway: GATEWAY }
    : {
      ...(PROVIDER_BASE_URL ? { baseUrl: PROVIDER_BASE_URL } : {}),
      ...(DEFAULT_CREDENTIAL ? { credential: DEFAULT_CREDENTIAL } : {}),
    };

  const client = createClient({ provider: PROVIDER, providerOptions });

  // admin-dola 的"登录"是逐用户的，这里只做环境检查：网关配好了就算就绪
  if (PER_USER_PROVIDER) {
    platform = client;
    if (!GATEWAY.enabled) {
      platformReady = false;
      platformError = new Error('provider=admin-dola 需要配置 ADMIN_GATEWAY_URL + ADMIN_GATEWAY_KEY');
      logger.error(`✗ ${platformError.message}`);
    } else {
      try {
        const h = await refreshGatewayHealth();
        if (!h) throw new Error('管理后台网关健康检查失败');
        platformReady = true;
        platformError = null;
        logger.log(`✓ 生成后端 = 管理后台网关（${GATEWAY.base}），单价 ${h.pointsPerTask ?? '-'} 积分/条`);
        if (h.generation) logger.log(`  后台生成队列：运行中 ${h.generation.running}，排队 ${h.generation.queued}，并发上限 ${h.generation.concurrency}`);
      } catch (e) {
        platformReady = false;
        platformError = e;
        logger.error(`✗ 连不上管理后台网关：${e.message}`);
      }
    }
    return;
  }

  try {
    await client.login();
    platform = client;
    platformReady = true;
    platformError = null;
    logger.log(`✓ 生成 provider「${PROVIDER}」已就绪`);
  } catch (e) {
    platform = client;               // mock 之类可能不需要登录
    platformReady = PROVIDER === 'mock';
    platformError = e;
    logger.error(`✗ provider「${PROVIDER}」登录失败：${e.message}`);
  }
}
await loginPlatform();

// Keep capability gates fresh so the create UI flips without restart once
// the admin pool finishes a reference-image probe.
if (PER_USER_PROVIDER) {
  setInterval(() => { void refreshGatewayHealth(); }, 15_000).unref?.();
}

// ---------------- 按用户取生成客户端 ----------------

/** key = 用户令牌；值 = 已绑定该令牌的 VideoClient */
const userClients = new Map();

/**
 * 任务归属校验。
 *
 * admin-dola 模式下**不做本地账本判断** —— 归属由后台的 owner_token_id 说了算，
 * 后台的查询接口对"不是你的任务"直接返回 404，用户面再拿本地账本过滤一次是多余的，
 * 而且会把"后台补录进来的任务"（本地账本里当然没有）全部误判成不存在。
 *
 * 单租户模式（老工作台）上游按平台账号返回全部任务，那时才需要本地账本兜住。
 */
function canAccess(me, taskId) {
  if (PER_USER_PROVIDER) return true;
  if (me.tokenId == null) return true;
  return ledger.belongsTo(taskId, me.tokenId);
}

/**
 * admin-dola 模式下每个用户要有自己的 client（内部持有自己的令牌），
 * 否则 A 用 B 的令牌提交、扣 B 的积分。
 * 缓存一下避免每次请求都重新 verify（verify 是一次网络往返）。
 */
async function clientFor(me) {
  if (!PER_USER_PROVIDER) return platform;
  const key = me.token;
  const cached = userClients.get(key);
  if (cached) return cached;
  const c = createClient({ provider: PROVIDER, providerOptions: { gateway: GATEWAY } });
  await c.login(key);              // 顺带校验一次令牌
  if (c?.p) c.p.referenceImagesReady = adminDolaReferenceImagesReady();
  userClients.set(key, c);
  // 别让缓存无限长（令牌轮换 / 用户很多时）
  if (userClients.size > 200) {
    const first = userClients.keys().next().value;
    if (first !== key) userClients.delete(first);
  }
  return c;
}

// ---------------- 用户会话 ----------------

/** 只缓存"这个令牌是谁"，积分一律回源（避免用户端拿到过期余额） */
const userCache = new Map();     // token -> { tokenId, prefix, name, at }

function maskToken(t) {
  const s = String(t || '');
  return s.length <= 10 ? '***' : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function headerCredential(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return null;
}

/**
 * 认证用户。
 * @returns {Promise<{token:string, tokenId:number|null, prefix:string, name:string, points:number|null, source:string}|null>}
 */
async function authUser(req, res, { probe = false } = {}) {
  const deny = (code, body) => { if (!probe) json(res, code, body); return null; };
  const fromHeader = headerCredential(req);

  // ---------- 网关模式：令牌以管理后台为准 ----------
  if (GATEWAY.enabled) {
    const token = fromHeader;
    if (!token) {
      return deny(401, { ok: false, needLogin: true, message: '请先使用访问令牌登录' });
    }
    try {
      const v = await GATEWAY.verify(token);
      userCache.set(token, { tokenId: v.tokenId, prefix: v.prefix, name: v.name, at: Date.now() });
      return { token, tokenId: v.tokenId, prefix: v.prefix, name: v.name, points: v.points, source: 'gateway' };
    } catch (e) {
      return deny(e.status === 403 ? 403 : 401, { ok: false, needLogin: true, message: e.message });
    }
  }

  // ---------- 旧模式：单租户自用，直接用 .env 的上游令牌 ----------
  const token = fromHeader || DEFAULT_CREDENTIAL;
  if (!token) return deny(401, { ok: false, needLogin: true, message: '请先使用访问令牌登录' });
  if (!platformReady) {
    return deny(503, { ok: false, needLogin: false, message: `生成服务未就绪：${platformError?.message ?? '登录中'}` });
  }
  const points = platformReady ? await platform.getBalance() : null;
  return { token, tokenId: null, prefix: maskToken(token), name: '', points, source: fromHeader ? 'upstream' : 'default' };
}

// ---------------- 工具 ----------------

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求体不是合法 JSON'); }
}

/** 生成资源必须就绪（网关模式下平台可能没配上游令牌，mock 例外） */
function requirePlatform(res) {
  if (!platform) { json(res, 503, { ok: false, message: '生成服务未初始化' }); return false; }
  // admin-dola 的真实可用性取决于后台网关，而 clientFor() 每次都会现场 verify，
  // 所以这里不做启动时的死判断 —— 否则后台重启一次，工作台就得跟着重启。
  if (PER_USER_PROVIDER) return true;
  if (!platformReady && PROVIDER !== 'mock') {
    json(res, 503, { ok: false, message: `生成服务未就绪：${platformError?.message ?? '登录中'}` });
    return false;
  }
  return true;
}

// ---------------- 请求处理 ----------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  try {
    // ---------- 页面 ----------
    if (p === '/' || p === '/index.html' || p === '/login') {
      const html = await fs.readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // 浏览器会自动请求 favicon；它不应进入用户登录鉴权流程。
    if (p === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---------- 无需登录 ----------
    if (p === '/api/health') {
      if (PER_USER_PROVIDER) await refreshGatewayHealth();
      json(res, 200, {
        ok: true,
        provider: PROVIDER,
        authMode: GATEWAY.enabled ? 'gateway' : 'upstream',
        platformReady,
        /** 是否由后台解析无水印版本（admin-dola 才有） */
        unwatermark: PER_USER_PROVIDER,
        supportedSeconds: [...SUPPORTED_SECONDS],
        expertSeconds: [...EXPERT_SECONDS],
        fixedSeconds: FIXED_SECONDS,
        expertSecondsReady: PROVIDER === 'mock' ? false : adminDolaExpertSecondsReady(),
        fixedSecondsReady: PROVIDER === 'mock'
          || PROVIDER === 'dola-workbench'
          || PROVIDER === 'dola-api'
          || adminDolaFixedSecondsReady(),
        /** 后台生成队列状态，供前端显示排队与可用并发；失败时为 null，不使用旧缓存。 */
        generation: PER_USER_PROVIDER ? (gatewayHealth?.generation || null) : null,
        promptMax: PROVIDER === 'dola-api' ? 3_000 : 12_000,
        referenceImagesSupported: PER_USER_PROVIDER
          ? adminDolaReferenceImagesReady()
          : true,
        gateway: GATEWAY.enabled ? { url: GATEWAY.base } : null,
      });
      return;
    }

    if (p === '/api/providers') {
      json(res, 200, { available: listProviders(), current: PROVIDER });
      return;
    }

    // 登录：网关模式下让后台校验令牌
    if (p === '/api/session' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const credential = String(body.credential || '').trim();
      if (!credential) { json(res, 400, { ok: false, message: '请输入访问令牌' }); return; }
      try {
        if (GATEWAY.enabled) {
          const v = await GATEWAY.verify(credential);
          userCache.set(credential, { tokenId: v.tokenId, prefix: v.prefix, name: v.name, at: Date.now() });
          json(res, 200, { ok: true, credentialPrefix: v.prefix, balance: v.points, name: v.name });
          return;
        }

        // 旧工作台直连模式：登录凭据就是上游令牌，不经过管理后台网关。
        // mock 也走这条分支，便于本地预览和回归测试，不会联网。
        if (PROVIDER !== 'mock') {
          await platform.login(credential);
          // 启动时没有默认令牌时，用户登录成功也应让后续 GET /api/session
          // 和任务接口进入就绪态；否则同一个令牌会被 POST 接受、GET 又被 503 拒绝。
          platformReady = true;
          platformError = null;
        }
        const balance = await platform.getBalance();
        json(res, 200, { ok: true, credentialPrefix: maskToken(credential), balance, name: '' });
      } catch (e) {
        json(res, e.status === 403 ? 403 : 401, { ok: false, message: e.message });
      }
      return;
    }

    // 当前身份
    if (p === '/api/session' && req.method === 'GET') {
      const me = await authUser(req, res, { probe: true });   // 探测：不改响应
      if (!me) {
        json(res, 200, {
          ok: true, authenticated: false, authMode: GATEWAY.enabled ? 'gateway' : 'upstream',
          canSwitchToken: true,
        });
        return;
      }
      json(res, 200, {
        ok: true, authenticated: true, source: me.source,
        credentialPrefix: me.prefix, balance: me.points, name: me.name, canSwitchToken: true,
      });
      return;
    }

    // ---------- 以下都要登录 ----------
    const me = await authUser(req, res);
    if (!me) return;

    if (p === '/api/balance') {
      if (me.source === 'gateway') {
        const v = await GATEWAY.verify(me.token);
        json(res, 200, { balance: v.points, credentialPrefix: v.prefix });
      } else {
        json(res, 200, { balance: platformReady ? await platform.getBalance() : null, credentialPrefix: me.prefix });
      }
      return;
    }

    if (p === '/api/redeem' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const card = String(body.card || '').trim();
      if (!card) { json(res, 400, { ok: false, message: '请输入卡密' }); return; }

      if (me.source === 'gateway') {
        const result = await GATEWAY.redeem({ token: me.token, card });
        json(res, 200, result);
        return;
      }

      if (!platform?.p?.redeemCard) {
        json(res, 501, { ok: false, message: '当前生成服务不支持卡密兑换' });
        return;
      }
      const result = await platform.p.redeemCard(card);
      const balance = await platform.getBalance();
      json(res, 200, { ok: true, ...result, balance });
      return;
    }

    if (p === '/api/tasks' && req.method === 'GET') {
      if (!requirePlatform(res)) return;
      const client = await clientFor(me);
      const limit = Number(u.searchParams.get('limit') || 20);
      const { items } = await client.listTasks({ limit: 200 });
      // 只回属于当前令牌的任务（网关模式才有归属概念）
      const visible = items.filter((t) => canAccess(me, t.id));
      json(res, 200, { items: visible.slice(0, limit).map(publicTask) });
      return;
    }

    if (p === '/api/tasks' && req.method === 'POST') {
      if (!requirePlatform(res)) return;
      const body = await readJsonBody(req);
      if (!body.prompt) { json(res, 400, { ok: false, message: '缺少 prompt' }); return; }
      const mode = String(body.mode || 'standard').trim().toLowerCase();
      if (!['standard', 'expert'].includes(mode)) {
        json(res, 400, { ok: false, code: 'UNSUPPORTED_MODE', message: 'mode 仅支持 standard 或 expert' });
        return;
      }
      const seconds = Number(body.seconds ?? DEFAULT_SECONDS);
      if (!Number.isInteger(seconds) || !SUPPORTED_SECONDS.includes(seconds)) {
        json(res, 400, {
          ok: false,
          code: 'UNSUPPORTED_DURATION',
          message: `当前工作台支持 ${SUPPORTED_SECONDS.join('、')} 秒视频`,
        });
        return;
      }
      if (seconds === 15 && mode !== 'expert') {
        json(res, 400, { ok: false, code: 'EXPERT_MODE_REQUIRED', message: '15 秒视频只能在专家模式提交，任务未提交，也未扣积分' });
        return;
      }
      if (PER_USER_PROVIDER && [15, FIXED_SECONDS].includes(seconds)) {
        // Re-read the control-plane readiness immediately before accepting the
        // task.  A cached startup flag could become stale after an account is
        // disabled, its proxy loses isolation, or its native capability is
        // invalidated.
        await refreshGatewayHealth();
      }
      if (PER_USER_PROVIDER && seconds === 15 && !adminDolaExpertSecondsReady()) {
        json(res, 409, {
          ok: false,
          code: 'EXPERT_DURATION_UNAVAILABLE',
          message: '当前后台没有已确认原生 15 秒且代理隔离的可用账号，任务未提交，也未扣积分；请先在后台账号池检查原生 15 秒能力并完成代理核验',
        });
        return;
      }
      if (PER_USER_PROVIDER && seconds === FIXED_SECONDS && !adminDolaFixedSecondsReady()) {
        json(res, 409, {
          ok: false,
          code: 'FIXED_DURATION_UNAVAILABLE',
          message: '当前后台没有已确认原生 30 秒且代理隔离的可用账号，任务未提交，也未扣积分；请先在后台账号池检查原生 30 秒能力并完成代理核验',
        });
        return;
      }
      if (!Array.isArray(body.images ?? [])) {
        json(res, 400, { ok: false, message: 'images 必须是数组' });
        return;
      }
      if (PER_USER_PROVIDER && body.images?.length) {
        await refreshGatewayHealth();
        if (!adminDolaReferenceImagesReady()) {
          json(res, 409, {
            ok: false,
            code: 'REFERENCE_IMAGES_UNSUPPORTED',
            message: '当前没有已确认支持参考图且代理隔离的可用账号，任务未提交、未扣积分',
          });
          return;
        }
      }
      const client = await clientFor(me);

      const images = (body.images || []).map((i) => ({ name: i.name, data: Buffer.from(i.dataBase64, 'base64') }));
      const payload = {
        prompt: body.prompt,
        ratio: body.ratio || '16:9',
        mode,
        seconds,
        images,
        ...(PER_USER_PROVIDER ? { forceSeconds: seconds } : {}),
      };

      // ---------- admin-dola：计费在后台做，这里不碰积分 ----------
      if (PER_USER_PROVIDER) {
        let created;
        try {
          created = await client.createTask(payload);
        } catch (e) {
          const uncertain = e.code === 'GATEWAY_CREATE_TIMEOUT';
          json(res, e.status && e.status < 500 ? e.status : uncertain ? 504 : 502, { ok: false, code: e.code, submissionUnknown: uncertain, message: uncertain ? e.message : `提交失败：${e.message}` });
          return;
        }
        if (me.tokenId != null) {
          ledger.own(created.taskId, { tokenId: me.tokenId, prefix: me.prefix, ref: `gen-${created.taskId}`, prompt: payload.prompt });
        }
        const out = {
          taskId: created.taskId, createdVia: created.via, status: 'queued',
          chargedPoints: created.chargedPoints ?? null, balance: created.balance ?? me.points,
        };
        if (body.wait) {
          try {
            const t = await client.waitFor(created.taskId, {
              pollIntervalMs: Number(body.intervalMs || 15000),
              timeoutMs: Number(body.timeoutMs || 30 * 60_000),
            });
            json(res, 200, { ...out, status: t.status, task: publicTask(t), failed: t.status === 'failed', refunded: Boolean(t.refunded), balance: t.balance ?? out.balance });
          } catch (e) {
            // Local polling failure is not evidence of upstream failure. Never refund here.
            json(res, 200, { ...out, task: null, waiting: true, waitTimedOut: e.name === 'TimeoutError', message: '暂未确认最终结果，请继续查询任务；不会自动重提或退款' });
          }
          return;
        }
        json(res, 202, out);
        return;
      }

      // ---------- 单租户模式：本地扣费 + 退款 ----------
      // ⚠️ 扣费和退款必须用**同一个 ref**（否则退款找不到那笔消费 → 400/404）。
      // taskId 在 createTask 之后才知道，所以这里先生成一个 uuid 当 ref，
      // 并且把它记进归属账本，方便日后对账。
      const chargeRef = `chg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      let billing = null;
      if (me.source === 'gateway') {
        try {
          const c = await GATEWAY.consume({ token: me.token, ref: chargeRef, reason: 'video' });
          billing = { ref: chargeRef, charged: c.charged, balance: c.balance, duplicated: c.duplicated };
        } catch (e) {
          json(res, e.status === 402 ? 402 : 500, { ok: false, message: e.message });
          return;
        }
      }

      let created;
      try {
        created = await client.createTask(payload);
      } catch (e) {
        if (billing) await GATEWAY.refund({ ref: chargeRef, note: '提交失败退款' }).catch(() => {});
        json(res, 500, { ok: false, message: `提交失败：${e.message}` });
        return;
      }

      if (me.tokenId != null) {
        ledger.own(created.taskId, { tokenId: me.tokenId, prefix: me.prefix, ref: chargeRef, prompt: payload.prompt });
      }

      const out = { taskId: created.taskId, createdVia: created.via, status: 'queued', chargedPoints: billing?.charged ?? null, balance: billing?.balance ?? me.points };
      if (body.wait) {
        try {
          const t = await client.waitFor(created.taskId, {
            pollIntervalMs: Number(body.intervalMs || 30000),
            timeoutMs: Number(body.timeoutMs || 60 * 60_000),
          });
          const failed = t.status === 'failed';
          let refunded = false;
          if (failed && me.source === 'gateway') {
            const refund = await GATEWAY.refund({ ref: chargeRef, note: '已确认生成失败退款' });
            refunded = Boolean(refund.refunded);
          }
          json(res, 200, { ...out, status: t.status, task: publicTask(t), failed, refunded });
        } catch (e) {
          json(res, 200, { ...out, task: null, waiting: true, waitTimedOut: e.name === 'TimeoutError', message: '暂未确认最终结果，请继续查询任务；不会自动重提或退款', refunded: false });
        }
        return;
      }
      json(res, 202, out);
      return;
    }

    let m = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (m) {
      if (!requirePlatform(res)) return;
      const client = await clientFor(me);
      const id = decodeURIComponent(m[1]);
      if (!canAccess(me, id)) {
        json(res, 404, { ok: false, message: '任务不存在' });   // 不暴露"存在但不属于你"
        return;
      }
      if (req.method === 'GET') { json(res, 200, publicTask(await client.getTask(id))); return; }
      if (req.method === 'DELETE') {
        const r = await client.deleteTask(id);
        ledger.forget(id);
        json(res, 200, { ok: Boolean(r.ok), refunded: Boolean(r.refunded), message: r.message });
        return;
      }
    }

    // 视频流代理
    m = p.match(/^\/api\/tasks\/([^/]+)\/(media|download)$/);
    if (m && req.method === 'GET') {
      if (!requirePlatform(res)) return;
      const client = await clientFor(me);
      const id = decodeURIComponent(m[1]);
      const mode = m[2];
      if (!canAccess(me, id)) {
        json(res, 404, { ok: false, message: '任务不存在' });
        return;
      }
      const t = await client.getTask(id);
      // t.url 已经是「优先无水印」的直链
      if (t.status !== 'succeeded' || !t.url) { json(res, 409, { ok: false, message: `任务尚未完成或无媒体地址，当前状态 ${t.status}`, status: t.status, stage: t.stage ?? null }); return; }

      if (String(t.url).startsWith('mock://')) {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vt-'));
        const tmp = path.join(tempDir, 'video.mp4');
        let buf;
        try {
          await client.p.download(t, tmp);
          buf = await fs.readFile(tmp);
        } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': buf.length,
          ...(mode === 'download' ? { 'Content-Disposition': `attachment; filename="${id}.mp4"` } : {}),
        });
        res.end(buf);
        return;
      }

      const controller = new AbortController();
      const disconnect = () => { if (!res.writableFinished) controller.abort(); };
      res.once('close', disconnect);
      const upstream = await GATEWAY.fetchMedia(t.url, { range: req.headers.range, signal: controller.signal });
      if (!upstream.ok && upstream.status !== 416) {
        await upstream.body?.cancel();
        json(res, 502, { ok: false, message: '视频文件暂不可用，请稍后重试' });
        return;
      }
      if (upstream.ok && !/^(video\/|application\/octet-stream\b)/i.test(upstream.headers.get('content-type') || '')) {
        await upstream.body?.cancel();
        json(res, 502, { ok: false, message: '媒体响应不是视频文件' });
        return;
      }
      const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
      const outHeaders = { 'Accept-Ranges': 'bytes' };
      for (const h of pass) {
        const v = upstream.headers.get(h);
        if (v) outHeaders[h] = v;
      }
      // 把"这是无水印版"透出去，前端下载时能直接确认
      if (t.isUnwatermarked) outHeaders['X-Video-Unwatermarked'] = '1';
      if (mode === 'download') outHeaders['Content-Disposition'] = `attachment; filename="${id.replace(/[^A-Za-z0-9_-]/g, '_')}${t.isUnwatermarked ? '-nowatermark' : ''}.mp4"`;
      res.writeHead(upstream.status, outHeaders);
      try {
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
      } finally { res.off('close', disconnect); }
      return;
    }

    json(res, 404, { ok: false, message: `未找到 ${p}` });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    json(res, e.status >= 400 && e.status <= 599 ? e.status : 500, { ok: false, error: e.name || 'Error', message: e.message });
  }
});

server.once('close', () => { ledger.close?.(); userClients.clear(); userCache.clear(); });
return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Tests should import the factory. CLI users can disable all .env reads explicitly.
  if (!['0', 'false'].includes(process.env.MVP_LOAD_ENV)) loadEnv();
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 8787);
  const server = await createWorkbenchServer({ argv: args });
  server.listen(port, process.env.MVP_HOST || '127.0.0.1', () => {
    console.log(`\n  视频任务工作台已启动 http://${process.env.MVP_HOST || '127.0.0.1'}:${server.address().port}`);
  });
}
