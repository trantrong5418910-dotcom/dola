/**
 * /v1 —— 对外开放的生成 API。
 *
 * ── 契约来源 ──────────────────────────────────────────────────────────────
 * 逐条照抄参考站 68.64.176.15（dola2api 2.3.13）的 /v1 平面，依据是它的
 * /test.html（可匿名访问，里面就是完整的请求形状）与 /openapi.json。
 * 见 outputs/refsite-68.64.176.15-map.html §3。
 *
 * ── 与参考站唯一的（故意）不同 ────────────────────────────────────────────
 * 参考站是「一个共享 admin key + 每个请求再带用户 key」两层；
 * 我们直接拿用户自己的令牌（tokens.value，形如 dv_xxxxxxxx）当 `Bearer`，
 * 不再需要共享密钥。收益：一个令牌只能碰到自己的任务，泄了也只泄自己。
 *
 * ── 与既有 /api/gateway 的关系：不重复造轮子 ───────────────────────────────
 * 真正的业务（建任务、扣积分、排队、选号、浏览器提交、归档、退款）全在
 * routes/gateway.js 的 submitGenerationTask 与 dola/generator.js 里。
 * 本文件只是一层**契约适配**：把参考站的字段名翻成我们的入参，再把结果翻回去。
 * 因此这里没有任何 SQL 计费语句、没有浏览器操作、没有状态机。
 *
 * ── 为什么 /content 必须 302 ──────────────────────────────────────────────
 * 参考站的 `GET /v1/videos/{id}/content` 返回 302 到一个**现签**的地址，
 * 客户端从不持有会过期的链接 —— 它自己的 test.html 里就是
 * `if (res.status === 302) { player.src = res.headers.get("location"); }`。
 * 我们照抄这个形状，但落地点换成本机的短票据地址（见 /v1/files/:ticket）：
 *   · 有本地归档 → 302 到 /v1/files/<10 分钟 HMAC 票据>，永不 403
 *   · 没有归档（解析失败但有直链）→ 302 到上游 TOS 直链，**它会过期**，这是事实不是缺陷
 *
 * ── 挂载注意事项 ──────────────────────────────────────────────────────────
 * 必须在 server/index.js 的 SPA fallback **之前**挂载：那条兜底是
 * `app.get(/^(?!\/api).*\/, ...)`，而 `/v1/...` 不以 /api 开头，会掉进 SPA
 * 回 index.html —— 客户端拿到一坨 HTML 却以为是 API 响应。
 * 本文件自带 /v1 的 404 兜底，保证任何漏网路径都回 JSON。
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting } from './db.js';
import { audit } from './audit.js';
import { signJwt, verifyJwt } from './auth.js';
import { submitGenerationTask, GatewayTaskError, redeemCard } from './routes/gateway.js';
import { settleFailedVideoRefund } from './dola/generation-billing.js';
import { streamVideoFile } from './dola/video-file.js';
import {
  getVideoTask, listVideoTasks, cancelVideoTask, startVideoTask,
  generationStatus, nativeFifteenSecondPoolStats, nativeThirtySecondPoolStats,
  referenceImagePoolStats, localFileOf,
} from './dola/generator.js';
import { IMAGE_MAX_COUNT, REQUEST_MAX_BYTES } from './dola/reference-images.js';
import { listReferenceImageEntries, resolveReferenceImage } from './dola/reference-image-store.js';
// 只取"是否开启"这个布尔：包装文案属于运营话术，不下发给调用方（见 prompt-wrap.js）。
// 这里用 `promptWrapView` 拿三层视图（`enabled` / `scope_enabled` / `effective_enabled`），
// 供 /v1/status 表达"开关开着、但实际没生效"。包装文案本身仍然不下发。
import { promptWrapView } from './dola/prompt-wrap.js';
import { switchView, SWITCH_KEYS } from './dola/feature-switch.js';
import { usageSnapshot } from './dola/gateway-quota.js';
import { readinessSummary, publicReadiness } from './dola/readiness.js';

const router = express.Router();

/** 模型↔时长的唯一权威映射，抄自 dola/generation-policy.js。不要在这里另立一套。
 * 档位精简（2026-09-27）：10/20 下线，只剩 15（专家/2.0）与 30（2.5）。 */
const MODEL_FOR_SECONDS = { 15: 'seedance_v2.0', 30: 'seedance_v2.5' };
/** 页面真实提供过的比例（web/src/views/Dola.vue）。ratio 只做记录，不驱动上游。 */
const ADVERTISED_RATIOS = ['16:9', '9:16', '1:1'];
const SUPPORTED_SECONDS = [15, 30];

/** 票据有效期。短到"链接被转发出去也没多大用"，长到"够下载完一个大文件"。 */
const FILE_TICKET_HOURS = 10 / 60;
/**
 * 参考图票据有效期。和成片票据同口径（10 分钟）—— 参考图是给「重新提交」回填和
 * 任务详情渲染用的，页面一刷新就重新签，没必要给长有效期。
 */
const REFERENCE_TICKET_HOURS = 10 / 60;
/** multipart 解析的硬上限：合法请求最大 22 MiB（见 reference-images.js），留 2 MiB 给分隔符与其它字段。 */
const MULTIPART_MAX_BYTES = REQUEST_MAX_BYTES + 2 * 1024 * 1024;
const MULTIPART_MAX_PARTS = 24;

// ---------------------------------------------------------------- 响应形状

/**
 * 成功：`{ code: 0, data: ... }`。
 * 这个信封不是我们定的 —— 是参考站 /v1/model-groups 的真实响应
 * （`{"code":0,"data":[{"name":"SD-飞扬","models":[...]}]}`）。
 */
const ok = (res, data, status = 200) => res.status(status).json({ code: 0, data });

/**
 * 失败：`{ error: { message, type, code } }`。
 * 同样是照抄 —— 参考站所有鉴权失败都是
 * `{"error":{"message":"invalid api key","type":"invalid_request_error"}}`。
 */
const fail = (res, status, message, code = null, details = {}) =>
  res.status(status).json({ error: { message, type: 'invalid_request_error', ...(code ? { code } : {}), ...details } });

/** 400 的糖：参数不对。 */
const badRequest = (message, code = 'invalid_parameter') =>
  Object.assign(new Error(message), { status: 400, code });

/** 任务不存在 / 不属于你 —— 一律回同一个结果，不泄露「存在但不是你的」。 */
const taskNotFound = (res) => fail(res, 404, '任务不存在', 'TASK_NOT_FOUND');

// ---------------------------------------------------------------- 鉴权

/** 取 `Authorization: Bearer <token>`。 */
function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  return m ? m[1].trim() : '';
}

/**
 * 用令牌原文换一份用户信息。
 * 返回 null 表示"没给令牌"；抛 401/403 表示"给了但不可用"。
 * 与 routes/gateway.js 的校验口径保持一致（状态 + 过期），别两套标准。
 */
function resolveToken(req, res) {
  const raw = bearerOf(req);
  if (!raw) { fail(res, 401, 'invalid api key', 'MISSING_API_KEY'); return null; }
  const t = db.prepare('SELECT * FROM tokens WHERE value = ?').get(raw);
  if (!t) { fail(res, 401, 'invalid api key', 'INVALID_API_KEY'); return null; }
  if (t.status !== 'active') {
    fail(res, 403, `令牌状态为「${t.status}」，无法使用`, 'TOKEN_INACTIVE');
    return null;
  }
  if (t.expires_at && Date.parse(t.expires_at) <= Date.now()) {
    fail(res, 403, `令牌已于 ${t.expires_at} 过期`, 'TOKEN_EXPIRED');
    return null;
  }
  return t;
}

/** 鉴权中间件：通过后把令牌段落挂在 req.apiToken 上。 */
function requireApiToken(req, res, next) {
  const t = resolveToken(req, res);
  if (!t) return;
  req.apiToken = t;
  next();
}

/** 审计里的操作人：/v1 没有登录用户，用令牌前缀代替，别记成 anonymous。 */
const actorOf = (t) => ({ id: null, username: `token:${t.prefix}` });

/**
 * 拼绝对地址。
 *
 * 为什么不能用相对路径：302 的 Location 是相对的时候，浏览器/播放器会按
 * **页面地址**解析，而 API 通常在另一个 host（参考站的客户端就是
 * `player.src = res.headers.get("location")`）—— 相对路径直接播不出来。
 *
 * host 的取法有讲究：优先用请求自带的 Host 头（宝塔的 nginx 默认就会
 * `proxy_set_header Host $host`，所以这里拿到的就是公网域名）。
 * 只有当 Host 是回环/为空（说明是内网代理转发且没带原始 Host）时，
 * 才退到 X-Forwarded-Host —— 这样既能在反代后正确工作，
 * 又不能让调用方用伪造的 X-Forwarded-Host 把我们 302 到别人的域名去。
 * proto 可以放心用 X-Forwarded-Proto：它只影响协议，不影响去向。
 */
function absoluteUrl(req, pathname) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const host = req.get('host') || '';
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host) || !host;
  const chosenHost = loopback ? (first(req.headers['x-forwarded-host']) || host) : host;
  const proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  return `${proto}://${chosenHost}${pathname}`;
}

// ---------------------------------------------------------------- 参数翻译

/** 必须是整数，允许字符串数字（参考站的 test.html 就是这么发的：`seconds: Number(...)`）。 */
function integerOf(value, { name, allowed = null }) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${name} 必须是整数`);
  if (allowed && !allowed.includes(n)) throw badRequest(`${name} 仅支持 ${allowed.join(' / ')}`);
  return n;
}

/**
 * 把参考站的 `size` 翻成我们记录的 `ratio`。
 * 接受两种写法：比例串（`16:9`）或像素（`720x1280`）。
 * 像素写法做**约分**，不猜"最接近的常用比例" —— 猜出来的数字是假的。
 */
function ratioOf(size) {
  const s = String(size ?? '').trim();
  if (!s) return null;
  const px = /^(\d{1,5})\s*[x×*]\s*(\d{1,5})$/i.exec(s);
  if (!px) return s;
  const w = Number(px[1]); const h = Number(px[2]);
  if (!w || !h) throw badRequest('size 的宽高必须大于 0');
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/**
 * model 与 seconds 的一致性校验。
 *
 * 为什么必须拦：我们的 15 秒**只有** Seedance 2.0 这条路（原生探测路径），
 * 20/30 秒**只有** Seedance 2.5 的改写路径，10 秒用页面当前模型。
 * 客户端要是点 ``seedance_v2.5`` + 15 秒，我们**做不到** ——
 * 这种"看起来能跑其实跑不了"的请求必须当场 400，不能建了任务再失败。
 */
function assertModelSeconds(model, seconds) {
  if (!model) return;
  const expected = MODEL_FOR_SECONDS[seconds];
  if (expected && model !== expected) {
    throw badRequest(
      `${seconds} 秒只能走 ${expected}（当前传的是 ${model}）；请求未创建任务、未扣积分`,
      'UNSUPPORTED_MODEL_SECONDS',
    );
  }
}

/** 模型清单。只列我们真能提交的，resolution 一栏留空 —— 我们确实不控制分辨率，不编。 */
function modelCatalog() {
  return [
    {
      alias: 'seedance_v2.5',
      id: 'seedance_v2.5',
      name: 'Dreamina Seedance 2.5',
      duration: ['30'],
      resolution: [],
      ratio: ADVERTISED_RATIOS,
      image: IMAGE_MAX_COUNT,
      audio: 0,
      video: 0,
      remark: '30 秒按当前服务的 30 秒准入与提交路径执行；账号必须先通过只读能力探测。resolution 未由本服务控制，故留空。',
    },
    {
      alias: 'seedance_v2.0',
      id: 'seedance_v2.0',
      name: 'Dreamina Seedance 2.0 fast',
      duration: ['15'],
      resolution: [],
      ratio: ADVERTISED_RATIOS,
      image: IMAGE_MAX_COUNT,
      audio: 0,
      video: 0,
      remark: '15 秒是 Seedance 2.0 的原生单次路径，要求账号已通过只读原生能力探测；未通过时提交会被 409 拦下，不会扣积分。',
    },
  ];
}

// ---------------------------------------------------------------- 对外任务视图

/**
 * 面向调用方的任务字段白名单。
 *
 * ⚠️ 不能直接把 getVideoTask 的行扔出去：那张表里有 account_id / account_label
 * （账号身份）、local_path（服务器绝对路径）、owner_token_id / charge_ref（内部计费键）。
 * gateway 那边也做了同样的事，注释写得很直白：不要把文件系统路径和账号身份给用户面。
 */
function publicTask(row, { detail = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    object: 'video',
    status: row.status,
    stage: row.stage,
    prompt: row.prompt,
    ratio: row.ratio,
    seconds: row.seconds,
    duration_sec: row.duration_sec ?? null,
    bytes: row.local_bytes ?? row.bytes ?? null,
    archived: Boolean(row.local_path),
    is_unwatermarked: Boolean(row.is_unwatermarked),
    unwatermark_note: row.unwatermark_note,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
  if (!detail) return base;
  const ready = row.status === 'ready';
  return {
    ...base,
    ready,
    done: ['ready', 'failed', 'cancelled'].includes(row.status),
    // 归档优先：TOS 直链带签名会过期，归档过的才长期可靠。
    // 只给 /v1 内部的地址，客户端拿不到本地路径，也拿不到带令牌的 URL。
    url: ready ? (row.local_path ? `/v1/videos/${row.id}/content` : (row.unwatermarked_url || row.watermarked_url || null)) : null,
    url_source: !ready ? null
      : row.local_path ? 'archive'
        : row.unwatermarked_url ? 'unwatermarked-direct'
          : row.watermarked_url ? 'watermarked-direct' : null,
    watermarked_url: ready ? (row.watermarked_url || null) : null,
    unwatermarked_url: ready ? (row.unwatermarked_url || null) : null,
    /** 上游临时直链会过期；归档不会。说清楚，别让调用方以为两个一样可靠。 */
    url_expires: ready && !row.local_path && (row.unwatermarked_url || row.watermarked_url) ? 'upstream-temporary' : null,
  };
}

const ownedRow = (id, token) => {
  const row = getVideoTask(id);
  if (!row || row.owner_token_id !== token.id) return null;
  return row;
};

// ---------------------------------------------------------------- multipart

/**
 * 手写 multipart 解析，**不引第三方库**（项目一直只用 node 内置 + express/undici）。
 *
 * 参考站的 /test.html 就是 multipart 发的：
 *   form.append("prompt", …); form.append("model", …); form.append("seconds", …);
 *   form.append("size", …); form.append("auto_start", "true");
 *   images.forEach(f => form.append("input_reference", f));
 * 「照抄契约」的意思就是这种客户端改个 base URL 就能用，所以必须支持。
 *
 * 全程用 Buffer 定位边界，不做字符串切割 —— 参考图是二进制，
 * 一旦 toString() 就会被按 UTF-8 破坏（这是踩过的坑：测试数据里的 `\t` 会被吃掉）。
 * express.json / express.urlencoded 遇到 multipart 会跳过，所以原始流还在我们手里。
 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;              // 超限后继续排空，但不再累计
      total += c.length;
      if (total > limit) {
        settled = true;
        // 不 destroy：destroy 会让客户端看到连接重置，而不是我们这条 413。
        reject(Object.assign(new Error(`请求体超过 ${Math.round(limit / 1048576)} MiB 上限`),
          { status: 413, code: 'REQUEST_TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = String(m?.[1] || m?.[2] || '').trim();
  if (!boundary) throw badRequest('multipart 请求缺少 boundary');
  const dash = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let parts = 0;
  let pos = buf.indexOf(dash);
  if (pos === -1) throw badRequest('multipart 内容与 boundary 不匹配');
  while (pos !== -1) {
    let start = pos + dash.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;   // 结尾的 `--`
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    const next = buf.indexOf(dash, start);
    if (next === -1) throw badRequest('multipart 分段没有结束标记');
    let end = next;
    if (end - 2 >= start && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    else if (end - 1 >= start && buf[end - 1] === 0x0a) end -= 1;
    const part = buf.subarray(start, end);
    pos = next;
    if (++parts > MULTIPART_MAX_PARTS) throw badRequest(`multipart 分段超过 ${MULTIPART_MAX_PARTS} 个`, 'TOO_MANY_PARTS');
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) throw badRequest('multipart 分段缺少头部/正文分隔');
    // ⚠️ 头部块必须按 **UTF-8** 解，不能按 latin1。
    //    语法本身是 ASCII，但 `filename="参考图.jpg"` 里是 UTF-8 字节 ——
    //    按 latin1 解会变成 `åèæå¾.jpg`，最后写进错误信息和落盘文件名。
    //    只有 `content-disposition` 这一行的结构需要 ASCII 解析，中文只在值里出现。
    const headerText = part.subarray(0, sep).toString('utf8');
    const body = part.subarray(sep + 4);
    const disposition = (/content-disposition:[^\n\r]*/i.exec(headerText)?.[0]) || '';
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
      ?? /;\s*name=([^;\s]+)/i.exec(disposition)?.[1] ?? '';
    const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    if (!name) continue;
    if (filename !== null) files.push({ name, filename, data: Buffer.from(body) });
    else fields[name] = body.toString('utf8');
  }
  return { fields, files };
}

/**
 * 把一条请求（JSON 或 multipart）归一成 submitGenerationTask 的入参。
 * 两种入口走同一个归一化，避免"JSON 能过、multipart 过不了"这种分叉。
 */
async function readCreateInput(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/multipart\/form-data/i.test(contentType)) {
    return { fields: req.body || {}, files: [] };
  }
  const buf = await readRawBody(req, MULTIPART_MAX_BYTES);
  return parseMultipart(buf, contentType);
}

// ---------------------------------------------------------------- 探活 / 运行态

/**
 * 开关视图的**对外**投影：只保留三层布尔 + 范围，丢掉 `reasons`。
 *
 * 为什么要丢掉理由：`reasons` 是给运维看的（"号池没有可用账号""包装文案三段都为空"），
 * 它会把我们内部的资源状况透给调用方。而调用方真正需要的判断
 * ——"是关掉了，还是开着但没生效" —— 三层布尔已经足够表达。
 */
const publicSwitch = ({ enabled, scope_enabled, effective_enabled, scope, configuredScope }) =>
  ({ enabled, scope_enabled, effective_enabled, scope, configured_scope: configuredScope });

/** GET /v1/healthz —— 等价参考站的 2 字节 `ok`：无鉴权、无任何信息。 */
router.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

/** GET /v1/status —— 运行态。给自己令牌能看到的部分，**不给账号池明细**。 */
router.get('/status', requireApiToken, (req, res) => {
  const native15 = nativeFifteenSecondPoolStats();
  const native30 = nativeThirtySecondPoolStats();
  const refs = referenceImagePoolStats();
  // 开关的三层视图。范围按 `v1` 判 —— 本路由就是"对外接口"这一侧。
  const wrapView = promptWrapView({ scope: 'v1' });
  const gatewayView = switchView({ key: SWITCH_KEYS.gateway, scope: 'v1', fallback: 'true' });
  const generation = generationStatus();
  // 合成就绪度。⚠️ 只回 `{grade}`：这里的 `reasons` 是内部资源情报
  //    （"号池里没有有效账号"），不下发给调用方。公开的 `/v1/healthz`
  //    更是必须保持 2 字节 `ok`，一个字都不能多。
  const readiness = publicReadiness(readinessSummary({
    gatewayEnabled: gatewayView.effective_enabled,
    generation,
    pools: {
      expertSecondsReady: native15?.ready,
      fixedSecondsReady: native30?.ready,
      referenceImagesReady: refs?.ready,
    },
  }));
  ok(res, {
    version: '1',
    token: { prefix: req.apiToken.prefix, name: req.apiToken.name, points: req.apiToken.points, expires_at: req.apiToken.expires_at },
    points_per_task: Number(getSetting('gateway_points_per_task', '1')) || 1,
    supported_seconds: SUPPORTED_SECONDS,
    expert_seconds: [15],
    expert_seconds_ready: Boolean(native15?.ready),
    fixed_seconds: 30,
    fixed_seconds_ready: Boolean(native30?.ready),
    reference_images_ready: Boolean(refs?.ready),
    reference_images_max: IMAGE_MAX_COUNT,
    // 只回布尔：让调用方知道"你提交的 prompt 可能被运营话术包了一层"，
    // 但不回包装文案本身（那等于把提示词工程下发给调用方）。
    // 回这个字段是为了让"我提交的是原话、上游收到的不是"这件事可被主动发现，
    // 而不是等客户来问"为什么生成的视频里有一段我没写过的话"。
    // ⚠️ 这里取的是**实际生效**（effective）而不是"总开关写着 true"：
    //    开关开着但三段都空时，实际并没有包装，报 true 就是骗调用方。
    prompt_wrapped: wrapView.effective_enabled,
    prompt_wrap: publicSwitch(wrapView),
    // 网关是否对"对外接口"这一侧生效。三层都报，好让调用方能分清
    // "被关了" vs "开着但因为范围/前提没生效"。
    gateway: publicSwitch(gatewayView),
    // 本令牌今天还能用多少积分。没有这个字段的话，调用方只能在**被 429 拒绝之后**
    // 才知道有日上限这回事。
    daily: (() => {
      const u = usageSnapshot({ token: req.apiToken });
      return { limit: u.limit, used: u.used, remaining: u.remaining, day: u.day, limit_source: u.limitSource };
    })(),
    // 合成就绪度（只回分级，不回理由）：调用方不必自己拼四个布尔再得出不同结论。
    // `degraded` 是常态 —— 判"我这单能不能下"要看 readiness.seconds.ready 之类，
    // 而不是要求 grade==='ok'。
    readiness,
    generation,
    // 参考站的 /health 是 697 KB 且不需要 key，里面是全部 164 个账号的明细。
    // 这里刻意只回池容量与就绪布尔，不回任何账号标识。
    time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------- 模型

router.get('/models', requireApiToken, (_req, res) => {
  const data = modelCatalog().map((m) => ({
    id: m.id,
    object: 'model',
    owned_by: 'pixflow',
    created: Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000),
    name: m.name,
    aliases: [m.alias],
    // 调用方筛选用得上的都在这里，免得为了一句话去解析 model-groups
    supported_seconds: m.duration.map(Number),
    supports_reference_images: m.image > 0,
    remark: m.remark,
  }));
  ok(res, data);
});

/** GET /v1/model-groups —— 形状照抄参考站：`{code:0,data:[{name, models:[{alias,name,duration,…}]}]}`。 */
router.get('/model-groups', requireApiToken, (_req, res) => {
  const groupName = String(getSetting('v1_model_group_name', '') || '').trim() || '默认分组';
  ok(res, [{ name: groupName, models: modelCatalog() }]);
});

// ---------------------------------------------------------------- 提交生成

/**
 * POST /v1/videos
 *
 * JSON 与 multipart 都收。字段（参考站的口径 + 我们的少量扩展）：
 *   prompt          必填
 *   model           可选，seedance_v2.0 / seedance_v2.5
 *   seconds         可选，15 / 30（默认 30）
 *   size            可选，`16:9` 或 `720x1280`
 *   auto_start      可选，默认 true；false → 建任务并冻结积分，等 /start
 *   images          JSON 专用，base64 数组；multipart 用同名文件字段
 *   input_reference multipart 专用，参考图文件（可多张）
 *   audio           参考站有这个字段，**我们没有任何音频能力**，传了就 400
 *   扩展：account_id / strict_account / force_seconds / mode
 *   points 只允许后台受信任入口指定；公开 /v1 由服务端计价。
 */
router.post('/videos', requireApiToken, async (req, res) => {
  const t = req.apiToken;
  try {
    const { fields, files } = await readCreateInput(req);
    if (Object.prototype.hasOwnProperty.call(fields, 'points')) {
      return fail(res, 400, 'points 由服务端计价，不能由 API 请求指定；请求未创建任务、未扣积分', 'UNSUPPORTED_PARAMETER');
    }

    const prompt = String(fields.prompt ?? '').trim();
    if (!prompt) return fail(res, 400, '缺少 prompt', 'MISSING_PROMPT');

    // 档位精简后只保留 15/30；默认必须和网关及生成策略一致，否则省略
    // seconds 的合法请求会先被本适配层改成已下线的 10 秒，再被网关拒绝。
    const seconds = integerOf(fields.seconds, { name: 'seconds', allowed: SUPPORTED_SECONDS }) ?? 30;
    const model = String(fields.model ?? '').trim() || null;
    if (model && !modelCatalog().some((m) => m.id === model || m.alias === model)) {
      return fail(res, 400, `不支持的 model：${model}（仅支持 ${modelCatalog().map((m) => m.id).join(' / ')}）`, 'UNSUPPORTED_MODEL');
    }
    try {
      assertModelSeconds(model, seconds);
    } catch (e) {
      return fail(res, e.status || 400, e.message, e.code);
    }

    // audio：参考站的模型清单里 audio=3，我们一个都不支持。
    // 静默忽略等于骗人（调用方以为配了音），所以显式拒绝。
    if (fields.audio != null || files.some((f) => f.name === 'audio')) {
      return fail(res, 400, '本服务暂不支持 audio 参数，请移除后重试；请求未创建任务、未扣积分', 'UNSUPPORTED_PARAMETER');
    }

    // 参考图：multipart 的文件与 JSON 的 images 统一成同一份数组。
    const refFiles = files.filter((f) => f.name === 'input_reference' || f.name === 'images' || f.name === 'image');
    let images = fields.images;
    // multipart 里 images 只能是文本字段，允许塞 JSON 字符串。
    if (typeof images === 'string' && images.trim()) {
      try { images = JSON.parse(images); }
      catch { return fail(res, 400, 'images 文本字段必须是 JSON 数组', 'REFERENCE_IMAGE_INVALID'); }
    }
    if (refFiles.length) {
      images = refFiles.map((f) => ({ dataBase64: f.data.toString('base64'), name: f.filename || 'reference.png' }));
    }
    const rejected = files.filter((f) => !refFiles.includes(f));
    if (rejected.length) {
      return fail(res, 400, `不认识的 multipart 文件字段：${[...new Set(rejected.map((f) => f.name))].join(', ')}`, 'UNSUPPORTED_PARAMETER');
    }

    const ratio = ratioOf(fields.size ?? fields.ratio) ?? '16:9';
    const autoStart = String(fields.auto_start ?? 'true').trim().toLowerCase() !== 'false';
    // 参考站没有 mode；15 秒只有专家模式这一条路，所以由 seconds 反推，也允许显式覆盖（我们的扩展）。
    const mode = String(fields.mode ?? '').trim().toLowerCase() || (seconds === 15 ? 'expert' : 'standard');

    const result = await submitGenerationTask({
      tokenValue: t.value,
      prompt,
      mode,
      seconds,
      forceSeconds: integerOf(fields.force_seconds ?? fields.forceSeconds, { name: 'force_seconds', allowed: SUPPORTED_SECONDS }),
      ratio,
      images,
      accountId: integerOf(fields.account_id ?? fields.accountId, { name: 'account_id' }),
      strictAccount: String(fields.strict_account ?? fields.strictAccount ?? '').trim().toLowerCase() === 'true',
      autoStart,
      // 复用某个已存在任务的参考图（失败任务「重新提交」）。
      // 图在服务端暂存目录里，由服务端内部读出 → 复检 → 按新任务落盘，浏览器不必重传。
      // 空值 = 不复用；原目录缺失时 submitGenerationTask 会直接报错，不会静默建无图任务。
      referenceSourceTaskId: integerOf(fields.reference_source_task ?? fields.referenceSourceTask, { name: 'reference_source_task' }) ?? null,
      referenceSourceKeep: fields.reference_source_keep ?? fields.referenceSourceKeep ?? null,
    });

    audit(req, 'v1.video.create', 'dola_video', String(result.taskId), {
      prompt: prompt.slice(0, 80), seconds, model, points: result.chargedPoints,
      autoStart, references: refFiles.length,
      reusedReferences: result.reusedReferenceCount || 0,
      referenceSourceTask: result.referenceSourceTaskId || null,
    }, actorOf(t));

    return ok(res, {
      id: result.taskId,
      task_id: result.taskId,
      object: 'video',
      status: result.status,
      stage: result.stage,
      model: model || MODEL_FOR_SECONDS[seconds] || null,
      seconds: result.requestedSeconds,
      ratio,
      auto_start: autoStart,
      started: result.started,
      prompt: result.prompt,
      charged_points: result.chargedPoints,
      balance: result.balance,
      charge_ref: result.chargeRef,
      // 这次新建借用了哪条原任务的参考图、借了几张（0 = 没复用）。
      reference_source_task: result.referenceSourceTaskId || null,
      reused_reference_count: result.reusedReferenceCount || 0,
      created_at: new Date().toISOString(),
    }, 202);
  } catch (e) {
    if (e instanceof GatewayTaskError) {
      const diagnostic = e.fields?.diagnostic;
      return fail(res, e.status || 400, e.message, e.code, diagnostic ? { diagnostic } : {});
    }
    if (e.status) return fail(res, e.status, e.message, e.code || null);
    console.error('[v1] 提交失败:', e);
    return fail(res, 500, '提交失败，请稍后重试', 'INTERNAL_ERROR');
  }
});

// ---------------------------------------------------------------- 查询

/** GET /v1/videos —— 列自己的任务。已「清除」的（cleared_at 非空）不再出现在列表里。 */
router.get('/videos', requireApiToken, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  // 多取一些再过滤，避免「最近 20 条里有 18 条被清除过」导致只回 2 条。
  // 取 min(limit*4, 200) —— 200 是 listVideoTasks 的内部上限。
  const scan = Math.min(limit * 4, 200);
  const items = listVideoTasks({ ownerTokenId: req.apiToken.id, limit: scan })
    .filter((r) => !r.cleared_at)
    .slice(0, limit)
    .map((r) => publicTask(r));
  ok(res, { items, count: items.length });
});

/** GET /v1/videos/:id —— 查详情。顺手做一次幂等退款补偿（与 gateway 同口径）。
 *  被「清除」过的任务按 id 仍然查得到（它是扣费凭据），但会带上 `cleared: true`。 */
router.get('/videos/:id', requireApiToken, (req, res) => {
  const row = ownedRow(req.params.id, req.apiToken);
  if (!row) return taskNotFound(res);
  const billing = settleFailedVideoRefund(db, row);
  ok(res, {
    ...publicTask(row, { detail: true }),
    cleared: Boolean(row.cleared_at),
    refunded: billing.refunded || false,
    refunded_points: billing.points ?? 0,
    balance: billing.balance ?? null,
  });
});

/**
 * GET /v1/videos/:id/content —— 302 到现签地址。
 * 客户端永远不持有会过期的链接，这是参考站的设计，照抄。
 */
router.get('/videos/:id/content', requireApiToken, (req, res) => {
  const row = ownedRow(req.params.id, req.apiToken);
  if (!row) return taskNotFound(res);
  if (row.status !== 'ready') {
    return fail(res, 409, `成片尚未通过验收（当前 ${row.status}），暂不可下载`, 'CONTENT_NOT_READY');
  }
  if (localFileOf(row)) {
    // 本地归档 → 票据地址。票据 10 分钟过期，且不需要再带 Authorization。
    const ticket = signJwt({ vt: row.id }, FILE_TICKET_HOURS);
    return res.redirect(302, absoluteUrl(req, `/v1/files/${ticket}`));
  }
  const upstream = row.unwatermarked_url || row.watermarked_url;
  if (!upstream) return fail(res, 404, '该任务没有可下载的成片', 'CONTENT_MISSING');
  // 上游 TOS 直链带 dy_q 签名，**会过期**。本地归档失败时只能给这个。
  return res.redirect(302, upstream);
});

/**
 * GET /v1/files/:ticket —— 上一条 302 的落地点。
 * 票据本身就是鉴权（HMAC + 10 分钟过期），所以这里**不要** Authorization：
 * 播放器/下载器拖进度条时会重新发请求，带不上自定义头。
 */
router.get('/files/:ticket', async (req, res) => {
  const payload = verifyJwt(String(req.params.ticket || ''));
  const videoId = payload && Number.isSafeInteger(payload.vt) ? payload.vt : null;
  if (videoId == null) return fail(res, 401, '下载票据无效或已过期，请重新获取下载地址', 'TICKET_INVALID');
  const row = getVideoTask(videoId);
  if (!row) return fail(res, 404, '任务不存在', 'TASK_NOT_FOUND');
  const file = localFileOf(row);
  if (!file) return fail(res, 404, '该任务没有本地归档文件', 'CONTENT_MISSING');
  try {
    return await streamVideoFile(req, res, {
      file,
      filename: `${row.id}${row.is_unwatermarked ? '-nowatermark' : ''}.mp4`,
      isUnwatermarked: Boolean(row.is_unwatermarked),
    });
  } catch (e) {
    if (!res.headersSent) return fail(res, 502, '文件传输失败，请重试', 'STREAM_FAILED');
    try { res.end(); } catch { /* 已经没得救了 */ }
    return undefined;
  }
});

// ---------------------------------------------------------------- 参考图

/**
 * GET /v1/videos/:id/reference-images —— 列出该任务暂存的参考图。
 *
 * 给两个场景用：
 *   ① 失败任务的「重新提交」：把原任务的图回填到新建表单，顺手拿到票据地址直接显示缩略图；
 *   ② 任务详情要说明「这条任务带了哪些参考图」。
 *
 * ⚠️ 图是**暂存**的：失败任务保留 24 小时，成功/取消的任务即时清掉（见
 *    dola/reference-image-store.js 的保留期说明）。所以 `items` 为空是正常结果、不是错误，
 *    调用方要按「已清理」处理，别把空列表当成「这个任务本来就没带图」。
 */
router.get('/videos/:id/reference-images', requireApiToken, async (req, res) => {
  const row = ownedRow(req.params.id, req.apiToken);
  if (!row) return taskNotFound(res);
  let entries = [];
  try {
    entries = await listReferenceImageEntries(row.id);
  } catch (e) {
    return fail(res, 500, `读取参考图失败：${e.message}`, 'REFERENCE_IMAGE_READ_FAILED');
  }
  // ⚠️ 必须单独查这两列：getVideoTask() 走的是 PUBLIC_FIELDS 投影，**不含**它们
  //    （踩过：直接用 row.has_reference_images 会恒为 undefined，于是 cleared 永远是
  //    false —— 前端就把「图已被清理」误判成「本来就没带图」，少提示一句「请重新上传」）。
  const record = db.prepare('SELECT has_reference_images, reference_image_count FROM dola_videos WHERE id = ?')
    .get(row.id) || {};
  const expiresMinutes = Math.round(REFERENCE_TICKET_HOURS * 60);
  return ok(res, {
    task_id: row.id,
    count: entries.length,
    // 记录里说带过图、但暂存目录空了 → 就是「已被清理」。让调用方能明确区分
    // 「没带图」和「图没了」，才能给出「请重新上传」而不是「无需上传」。
    cleared: entries.length === 0 && Boolean(record.has_reference_images),
    recorded_count: Number(record.reference_image_count || 0),
    expires_in_minutes: expiresMinutes,
    items: entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      // 票据即鉴权（10 分钟），这样 <img src> 这种带不上 Authorization 的地方也能直接用。
      url: absoluteUrl(req, `/v1/videos/${row.id}/reference-images/${encodeURIComponent(entry.name)}`
        + `?ticket=${signJwt({ rt: row.id, rn: entry.name }, REFERENCE_TICKET_HOURS)}`),
    })),
  });
});

/**
 * GET /v1/videos/:id/reference-images/:name —— 取一张参考图的字节。
 *
 * 两条鉴权路，二选一：
 *   · `?ticket=`（上一条接口签发的 HMAC 票据，绑定 taskId + 文件名）—— 给 <img> / 下载器用；
 *   · `Authorization: Bearer <令牌>` + 归属校验 —— 给脚本 / 后端调用用。
 * 票据这条路与 /v1/files/:ticket 是同一个设计，理由也一样：`<img>` 带不上自定义头。
 */
router.get('/videos/:id/reference-images/:name', (req, res, next) => {
  if (String(req.query.ticket || '')) return next();   // 票据即鉴权，不再要求 Bearer
  return requireApiToken(req, res, next);
}, async (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return fail(res, 400, '任务号不合法', 'INVALID_TASK_ID');
  }
  const name = String(req.params.name || '');
  const ticket = String(req.query.ticket || '');
  if (ticket) {
    const payload = verifyJwt(ticket);
    // 票据必须**同时**匹配任务号与文件名。只校验任务号的话，一张图的票据就能把同一
    // 任务下其它参考图也读出来 —— 虽然都是同一个主人的图，但没有放宽的必要。
    if (!payload || payload.rt !== taskId || payload.rn !== name) {
      return fail(res, 401, '参考图地址无效或已过期，请重新获取', 'TICKET_INVALID');
    }
  } else if (!ownedRow(taskId, req.apiToken)) {
    return taskNotFound(res);
  }
  // resolveReferenceImage 已经把路径穿越挡掉了（只认目录里真实枚举出来的条目）。
  const file = await resolveReferenceImage(taskId, name);
  if (!file) return fail(res, 404, '参考图不存在或已清理', 'REFERENCE_IMAGE_MISSING');
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return fail(res, 404, '参考图不存在或已清理', 'REFERENCE_IMAGE_MISSING');
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.png' ? 'image/png' : 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
  // 票据只活 10 分钟；缓存压到 5 分钟，刷新页面拿新票据，旧地址过期前也不必反复回源。
  res.setHeader('Cache-Control', 'private, max-age=300');
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) fail(res, 502, '参考图读取失败，请重试', 'REFERENCE_IMAGE_READ_FAILED');
    else { try { res.end(); } catch { /* 已经没得救了 */ } }
  });
  stream.pipe(res);
  return undefined;
});

// ---------------------------------------------------------------- 生命周期

/**
 * POST /v1/videos/:id/start —— auto_start=false 建出来的任务靠这个启动。
 * 与 submitGenerationTask 内部同一套顺序：启动失败 → 取消 → 退款，绝不留下"扣了钱没跑"的任务。
 */
function startOwnedVideoTask(req, token, row) {
  // 已清除的任务从列表里消失了，再把它启动起来会造出一个「不在任何列表里、却在花钱跑」的任务。
  if (row.cleared_at) {
    throw Object.assign(new Error('任务已被清除，不能启动；需要重跑请新建一条任务'), { status: 409, code: 'TASK_CLEARED' });
  }
  if (row.status !== 'queued') {
    // 只有"确实还在跑"的三个中间态算幂等成功。
    // ready / failed / cancelled 是**终态** —— 对终态再调 start 是调用方搞错了，
    // 必须 409 明确告诉他，不能回一个看着像成功的 200（那样调用方会一直等一个不会再变的任务）。
    if (['submitting', 'generating', 'resolving'].includes(row.status)) {
      return { id: row.id, status: row.status, started: true, note: '任务已在运行中' };
    }
    throw Object.assign(new Error(`任务已是终态（${row.status}），不能启动`), { status: 409, code: 'TASK_NOT_STARTABLE' });
  }

  let started;
  try {
    started = startVideoTask(row.id);
  } catch (e) {
    cancelVideoTask(row.id);
    const billing = settleFailedVideoRefund(db, { ...row, status: 'queued' }, { cancelledBeforeSubmit: true });
    throw Object.assign(
      new Error(`任务未能启动，已取消；未提交生成（退款 ${billing.points ?? 0}）`),
      { status: e.status || 409, code: 'TASK_START_FAILED' },
    );
  }
  if (!started) {
    // 另一个请求可能刚刚启动了该任务；重新读状态后按幂等成功返回，避免误取消并退款。
    const current = getVideoTask(row.id);
    if (current && ['submitting', 'generating', 'resolving'].includes(current.status)) {
      return { id: row.id, status: current.status, started: true, note: '任务已在运行中' };
    }
    throw Object.assign(new Error('任务已不在可启动状态'), { status: 409, code: 'TASK_NOT_STARTABLE' });
  }
  try { audit(req, 'v1.video.start', 'dola_video', String(row.id), '', actorOf(token)); }
  catch (error) { console.error('[v1] 启动审计记录失败:', error); }
  return { id: row.id, status: 'queued', started: true };
}

router.post('/videos/start', requireApiToken, (req, res) => {
  const rawIds = req.body?.ids;
  if (!Array.isArray(rawIds)) return fail(res, 400, 'ids 必须是数组', 'INVALID_IDS');
  if (rawIds.length > 100) return fail(res, 400, '一次最多启动 100 个任务', 'TOO_MANY_IDS');

  const started = [];
  const errors = [];
  const seen = new Set();
  for (const rawId of rawIds) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      errors.push({ id: rawId, code: 'INVALID_TASK_ID', error: '任务 id 必须是正整数' });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const row = ownedRow(id, req.apiToken);
    if (!row) {
      errors.push({ id, code: 'TASK_NOT_FOUND', error: '任务不存在' });
      continue;
    }
    try {
      started.push(startOwnedVideoTask(req, req.apiToken, row));
    } catch (error) {
      errors.push({ id, code: error.code || 'TASK_START_FAILED', error: error.message || '任务未能启动' });
    }
  }
  return ok(res, { started, errors });
});

router.post('/videos/:id/start', requireApiToken, (req, res) => {
  const row = ownedRow(req.params.id, req.apiToken);
  if (!row) return taskNotFound(res);
  try {
    return ok(res, startOwnedVideoTask(req, req.apiToken, row));
  } catch (error) {
    return fail(res, error.status || 409, error.message || '任务未能启动', error.code || 'TASK_START_FAILED');
  }
});

/** 还在自己往终态走的四个状态（与 generator.cancelVideoTask 内部那份一致）。 */
const RUNNING_VIDEO_STATUSES = ['queued', 'submitting', 'generating', 'resolving'];

/**
 * 「清除」一条 = 取消（还在跑的话）+ 打 cleared_at 软删除。
 *
 * ⚠️ 为什么不是物理 DELETE：
 *   dola_videos 的行同时是扣费凭据、退款凭据和审计证据。物理删除会让
 *   「扣过积分的任务凭空消失」，事后对不上账（而 point_transactions 里还留着那条 consume）。
 *   所以打 cleared_at，列表里不再出现，按 id 仍然查得到。这是与参考站**表面行为一致、
 *   底层更保守**的做法 —— 参考站的 test.html 只依赖「列表里没了」，不依赖服务端删行。
 *
 * 退款口径与 POST /v1/videos/:id/cancel 完全一致：
 * 只有「还没提交到上游」（queued）与「上游明确失败」（failed）退；
 * 已在生成的任务退款等于平台自己贴钱 —— 上游额度已经花掉了。
 */
function clearOneVideoTask(row) {
  const before = row.status;
  const running = RUNNING_VIDEO_STATUSES.includes(before);
  if (running) cancelVideoTask(row.id);
  const at = new Date().toISOString();
  db.prepare('UPDATE dola_videos SET cleared_at=?, updated_at=? WHERE id=?').run(at, at, row.id);
  let billing = { refunded: false, points: 0, balance: null };
  if (before === 'queued' || before === 'failed') {
    // 必须用**取消前**的 row 当入参：settleFailedVideoRefund 靠 `row.status === 'queued'`
    // 判断「提交前取消」，这里传进去的 row 正是清除前的快照。
    billing = settleFailedVideoRefund(db, row, { cancelledBeforeSubmit: before === 'queued' }) || billing;
  }
  return {
    id: row.id,
    status: running ? 'cancelled' : before,
    cleared: true,
    refunded: Boolean(billing.refunded),
    // `settleFailedVideoRefund` 是幂等的：如果这条任务在失败时已经被自动退过款，
    // 它会返回 `duplicated:true` 且**不再加钱**。必须把这个区分透出去 ——
    // 否则前端会把「本来就已经退过的那 1 积分」再报一次「退款 1 积分」，
    // 用户以为清除动作又退了钱，对不上账（生产实测踩到，余额其实没变）。
    refunded_already: Boolean(billing.duplicated),
    refunded_points: billing.duplicated ? 0 : (billing.points ?? 0),
    balance: billing.balance ?? null,
  };
}

/**
 * DELETE /v1/videos —— 批量清除。补齐参考站 OpenAPI 2.3.13 里 `/v1/videos` 的 delete 操作
 * （我们原来只有 `/v1/videos/{id}`），让照抄参考站契约的客户端能原样跑起来。
 *
 * body 可选：`{ ids: [1,2,3] }` 只清指定任务；不给 `ids`（或 `{ all: true }`）清当前令牌名下
 * 所有还没被清除过的任务。ids 上限 200，与 listVideoTasks 的内部上限对齐 ——
 * 不做无界循环，避免一次请求把事件循环占住。
 */
router.delete('/videos', requireApiToken, (req, res) => {
  const t = req.apiToken;
  const rawIds = req.body?.ids;
  if (rawIds != null && !Array.isArray(rawIds)) return fail(res, 400, 'ids 必须是数组', 'INVALID_IDS');
  if (Array.isArray(rawIds) && rawIds.length > 200) return fail(res, 400, '一次最多清除 200 个任务', 'TOO_MANY_IDS');

  let rows;
  if (Array.isArray(rawIds)) {
    const seen = new Set();
    rows = [];
    for (const raw of rawIds) {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const row = ownedRow(id, t);
      if (row && !row.cleared_at) rows.push(row);
    }
  } else {
    rows = listVideoTasks({ ownerTokenId: t.id, limit: 200 }).filter((row) => !row.cleared_at);
  }

  const cleared = [];
  const errors = [];
  let refundedPoints = 0;
  let alreadyRefunded = 0;
  for (const row of rows) {
    try {
      const result = clearOneVideoTask(row);
      refundedPoints += result.refunded_points;
      if (result.refunded_already) alreadyRefunded += 1;
      cleared.push(result);
    } catch (error) {
      errors.push({ id: row.id, code: error.code || 'CLEAR_FAILED', error: error.message || '清除失败' });
    }
  }
  if (cleared.length) {
    try { audit(req, 'v1.video.clear', 'dola_video', cleared.map((c) => c.id).join(','), `cleared=${cleared.length} refunded=${refundedPoints} alreadyRefunded=${alreadyRefunded}`, actorOf(t)); }
    catch (error) { console.error('[v1] 批量清除审计记录失败:', error); }
  }
  return ok(res, {
    cleared: cleared.map((c) => c.id),
    cleared_count: cleared.length,
    // refunded_points **只算本次真的退回的**；失败时已自动退过的（settleFailedVideoRefund
    // 的 duplicated 分支）单独计数，不再重复累加 —— 否则前端报的退款数会比账上多。
    refunded_points: refundedPoints,
    refunded_already_count: alreadyRefunded,
    errors,
    note: '已从列表隐藏（cleared_at），计费/退款凭据保留；按 id 仍然查得到，并带 cleared:true。',
  });
});

/**
 * 取消。退款口径与 /api/gateway/gen/:id/cancel 完全一致：
 * 只有「还没提交到上游」（queued）或「上游明确失败」（failed）才退。
 * 已经在生成的退了就是平台自己贴钱 —— 上游额度已经花了。
 */
function cancelHandler(req, res) {
  const t = req.apiToken;
  const row = ownedRow(req.params.id, t);
  if (!row) return taskNotFound(res);
  const before = row.status;
  const refundable = before === 'queued' || before === 'failed';
  const updated = cancelVideoTask(row.id);
  const current = updated || row;
  if (!refundable) {
    return ok(res, {
      id: row.id, status: current.status, refunded: false, refunded_points: 0,
      message: '生成已提交到上游，无法退款（上游额度已经消耗）',
    });
  }
  const billing = settleFailedVideoRefund(db, row, { cancelledBeforeSubmit: before === 'queued' });
  audit(req, 'v1.video.cancel', 'dola_video', String(row.id), `refunded=${billing.points || 0}`, actorOf(t));
  return ok(res, {
    id: row.id, status: current.status,
    refunded: Boolean(billing.refunded), refunded_points: billing.points ?? 0,
    balance: billing.balance ?? null,
  });
}

router.post('/videos/:id/cancel', requireApiToken, cancelHandler);

/**
 * DELETE /v1/videos/:id —— 「清除」。语义是**取消 + 软删除（cleared_at）**，不是物理删除。
 *
 * 与 POST /:id/cancel 的区别必须守住：
 *   · POST cancel  → 只是停掉，任务仍在列表里（状态 已取消）
 *   · DELETE clear → 停掉 **并且** 从列表里消失
 * 所以两者不能共用同一个 handler（早先共用过，结果是「清除了刷新又回来」）。
 */
router.delete('/videos/:id', requireApiToken, (req, res) => {
  const t = req.apiToken;
  const row = ownedRow(req.params.id, t);
  if (!row) return taskNotFound(res);
  if (row.cleared_at) {
    // 幂等：再清一次不是错误，直接回当前状态。
    // 字段形状与首次清除保持一致（refunded_already 也带上），客户端不用分支判断。
    return ok(res, { id: row.id, status: row.status, cleared: true, refunded: false, refunded_already: false, refunded_points: 0, note: '该任务此前已清除' });
  }
  try {
    const result = clearOneVideoTask(row);
    // 审计里必须把「本次真退了」与「此前已退过、只是复用」分开记 —— 对账时只看得见这一行。
    try { audit(req, 'v1.video.clear', 'dola_video', String(row.id), `cleared=1 refunded=${result.refunded_points} alreadyRefunded=${result.refunded_already ? 1 : 0}`, actorOf(t)); }
    catch (error) { console.error('[v1] 清除审计记录失败:', error); }
    return ok(res, { ...result, note: '已从列表隐藏（cleared_at），计费凭据保留；按 id 仍可查询。' });
  } catch (error) {
    return fail(res, error.status || 500, error.message || '清除失败', error.code || 'CLEAR_FAILED');
  }
});

// ---------------------------------------------------------------- 账户

/**
 * POST /v1/redeem —— 令牌自助兑换积分卡。
 *
 * 与 POST /api/gateway/redeem 是**同一件事**（共用 redeemCard()），区别只有鉴权：
 *   · gateway 那条走 `X-Gateway-Key`，机器对机器，公网已被 nginx 封成 404；
 *   · 这条用调用方自己的 Bearer 令牌，所以卡只能充给令牌自己 ——
 *     不接受任何形式的 tokenId 入参，用户 A 无法把卡充到 B 头上。
 *
 * 字段：`card`（也接受 `code` 这个别名，对齐参考站卡密的叫法）。
 * 返回：`{ points, balance, token_prefix, redeemed_at }`。
 */
router.post('/redeem', requireApiToken, (req, res) => {
  const result = redeemCard({
    token: req.apiToken,
    code: req.body?.card ?? req.body?.code,
    req,
    action: 'v1.card.redeem',
    actor: actorOf(req.apiToken),
  });
  if (!result.ok) return fail(res, result.status, result.message, 'REDEEM_FAILED');
  return ok(res, {
    points: result.points,
    balance: result.balance,
    token_prefix: result.tokenPrefix,
    redeemed_at: result.at,
  });
});

/** GET /v1/accounts —— 令牌自身信息（对齐参考站的账号面板语义，但只给自己）。 */
router.get('/accounts', requireApiToken, (req, res) => {
  const t = db.prepare('SELECT * FROM tokens WHERE id = ?').get(req.apiToken.id);
  if (!t) return fail(res, 401, 'invalid api key', 'INVALID_API_KEY');
  ok(res, {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    points: t.points,
    status: t.status,
    expires_at: t.expires_at,
    created_at: t.created_at,
    points_per_task: Number(getSetting('gateway_points_per_task', '1')) || 1,
  });
});

// ---------------------------------------------------------------- 兜底

/**
 * /v1 的 404。
 * 没有这一条，漏网的 GET /v1/xxx 会掉进 index.js 的 SPA fallback，
 * 返回 200 + 一坨 HTML —— 客户端 json() 解析失败，报的错还跟真实原因无关。
 */
router.use((req, res) => fail(res, 404, `未找到接口 ${req.method} /v1${req.path}`, 'NOT_FOUND'));

export default router;
