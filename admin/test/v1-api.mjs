/**
 * /v1 对外 API 隔离冒烟测试
 *
 * 三件必须做到的事（与 test/media-library.mjs 同款约定）：
 *   ① **不碰线上数据** —— 独立库（ADMIN_DB）+ 独立端口 + 独立归档目录
 *   ② **不碰真实上游** —— 替换 globalThis.fetch（本机地址直通），并断言
 *      「纯参数校验类失败一次出站都没发」
 *   ③ **端到端真跑** —— 走真实 Express + 真实令牌鉴权 + 真实建任务链路，
 *      只把"账号池为空"当成成功路径的终点（那正是隔离环境该有的结果）
 *
 * 重点验两件容易被做错的事：
 *   · multipart 里的**二进制**参考图不能被破坏（用最小的合法 JPEG 当探针，
 *     它的字节里带 0xFF —— 一旦被当成 UTF-8 字符串处理就必然认不出来）
 *   · 对外任务视图**不能泄漏** local_path / account_label / owner_token_id /
 *     charge_ref（参考站就是在这类地方漏了 697 KB 的账号明细）
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TAG = `v1${Date.now()}`;
const DB = `/tmp/${TAG}.db`;
const VIDEO_DIR = `/tmp/${TAG}-videos`;
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;

// ⚠️ 必须在 import db.js 之前设好
process.env.ADMIN_DB = DB;
fs.mkdirSync(VIDEO_DIR, { recursive: true });

// ───────────────────────── mock 出站 ─────────────────────────
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url);
  // 本机请求必须直通，否则测试自己打给自己后端的那几个请求也会被拦
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init);
  outbound.push(`${(init?.method || 'GET').toUpperCase()} ${u.host}${u.pathname}`);
  return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 404 });
};

// ───────────────────────── 断言工具 ─────────────────────────
let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fails.push(name); console.log(`  ❌ ${name} ${extra}`); }
}
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ───────────────────────── 起服务 ─────────────────────────
// ⚠️ 不能解构 db：会切断 ESM live binding，db 会被固定在 initDb 之前的 null
const dbMod = await import(`${ADMIN}/server/db.js`);
await dbMod.initDb();
const db = dbMod.db;
if (!db) { console.error('initDb 之后 db 仍为 null —— 环境有问题'); process.exit(1); }

const { default: v1Routes } = await import(`${ADMIN}/server/v1-routes.js`);
const { authMiddleware } = await import(`${ADMIN}/server/auth.js`);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(authMiddleware);
app.use('/v1', v1Routes);
// 故意复刻 index.js 的 SPA 兜底：证明 /v1 的 404 不会掉进它
app.get(/^(?!\/api).*/, (_req, res) => res.status(200).type('html').send('<!doctype html>SPA'));

const server = await new Promise((res) => { const s = app.listen(PORT, '127.0.0.1', () => res(s)); });
console.log(`\n服务已起：${BASE}  库=${DB}\n`);

// ───────────────────────── 播种 ─────────────────────────
const now = () => new Date().toISOString();
const insToken = db.prepare(`INSERT INTO tokens (name,value,prefix,points,status,expires_at,note,created_by,created_at,updated_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`);
insToken.run('测试令牌A', 'dv_' + 'A'.repeat(32), 'dv_AAAAAA', 20, 'active', null, '', null, now(), now());
insToken.run('零积分令牌', 'dv_' + 'Z'.repeat(32), 'dv_ZZZZZZ', 0, 'active', null, '', null, now(), now());
insToken.run('停用令牌', 'dv_' + 'D'.repeat(32), 'dv_DDDDDD', 20, 'disabled', null, '', null, now(), now());
insToken.run('过期令牌', 'dv_' + 'E'.repeat(32), 'dv_EEEEEE', 20, 'active', '2020-01-01T00:00:00.000Z', '', null, now(), now());
insToken.run('测试令牌B', 'dv_' + 'B'.repeat(32), 'dv_BBBBBB', 20, 'active', null, '', null, now(), now());
const tk = (p) => db.prepare('SELECT * FROM tokens WHERE prefix=?').get(p);

const TK_A = tk('dv_AAAAAA').value;
const TK_Z = tk('dv_ZZZZZZ').value;
const TK_D = tk('dv_DDDDDD').value;
const TK_E = tk('dv_EEEEEE').value;
const TK_B = tk('dv_BBBBBB').value;

/** 真归档文件：>1024 字节，才不会被「不像视频」的最小体积检查挡掉 */
const ARCHIVED = path.join(VIDEO_DIR, '9001-nowatermark.mp4');
fs.writeFileSync(ARCHIVED, Buffer.alloc(6000, 0x41));
const ARCHIVED_BYTES = fs.statSync(ARCHIVED).size;

const insVideo = db.prepare(`INSERT INTO dola_videos
  (account_id, account_label, prompt, ratio, seconds, status, stage, watermarked_url, unwatermarked_url,
   unwatermark_note, is_unwatermarked, local_path, local_bytes, duration_sec, bytes, error,
   owner_token_id, owner_prefix, charge_ref, created_at, updated_at, finished_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// ⚠️ 任务 id 是自增主键 —— 必须取 lastInsertRowid，不能自己编一个 9001
const seedVideo = (...args) => Number(insVideo.run(...args).lastInsertRowid);
// ① 已归档的无水印成片（最完整的一条）
const A_ARCHIVED = seedVideo(7, '内部账号标签-不该外泄', '已归档的成片', '16:9', 10, 'ready', '已通过验收',
  'https://wm.example.com/wm.mp4', 'https://vod.example.com/nowm.mp4', '无水印解析成功（plain）',
  1, ARCHIVED, ARCHIVED_BYTES, 10.08, ARCHIVED_BYTES, '',
  tk('dv_AAAAAA').id, 'dv_AAAAAA', 'gen-1', now(), now(), now());
// ② 有直链但本地归档失败（TOS 直链会过期）
const A_DIRECT = seedVideo(8, '内部账号标签-不该外泄', '只有直链的成片', '9:16', 15, 'ready', '已通过验收',
  'https://wm.example.com/wm2.mp4', 'https://vod.example.com/nowm2.mp4', '无水印解析成功',
  1, null, null, 15.0, 4096, '',
  tk('dv_AAAAAA').id, 'dv_AAAAAA', 'gen-2', now(), now(), now());
// ③ 还没好
const A_RUNNING = seedVideo(9, '内部账号标签-不该外泄', '还在生成的', '16:9', 10, 'generating', '生成中 30s',
  null, null, '', 0, null, null, null, null, '',
  tk('dv_AAAAAA').id, 'dv_AAAAAA', 'gen-3', now(), now(), now());
// ④ 失败（测退款补偿口径）
const A_FAILED = seedVideo(10, '内部账号标签-不该外泄', '失败的', '16:9', 10, 'failed', '失败',
  null, null, '', 0, null, null, null, null, '上游明确报「生成失败」',
  tk('dv_AAAAAA').id, 'dv_AAAAAA', 'gen-4', now(), now(), now());
// ⑤ 别人的任务（隔离用）
const B_TASK = seedVideo(11, '内部账号标签-不该外泄', '别人的任务', '16:9', 10, 'ready', '已通过验收',
  null, 'https://vod.example.com/other.mp4', '', 1, null, null, 10.0, 2048, '',
  tk('dv_BBBBBB').id, 'dv_BBBBBB', 'gen-5', now(), now(), now());

console.log(`播种：令牌 A/B/零积分/停用/过期，任务 A=#${A_ARCHIVED}/#${A_DIRECT}/#${A_RUNNING}/#${A_FAILED}、B=#${B_TASK}\n`);

// ───────────────────────── 请求工具 ─────────────────────────
async function req(method, p, { token, body, rawBody, contentType, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (contentType) h['Content-Type'] = contentType;
  const r = await realFetch(`${BASE}${p}`, {
    method,
    headers: h,
    body: body === undefined ? rawBody : JSON.stringify(body),
    redirect: 'manual',
  });
  let data = null;
  const text = await r.text();
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data, text, headers: r.headers };
}

// ═════════════════════════ ① 探活与鉴权 ═════════════════════════
console.log('① 探活与鉴权');
let r = await req('GET', '/v1/healthz');
ok('healthz 无鉴权可访问', r.status === 200, `${r.status}`);
ok('healthz 就是 2 字节的 ok（无任何信息）', r.text === 'ok', JSON.stringify(r.text));
ok('healthz 不返回 JSON（对齐参考站 /healthz）', !/^[{[]/.test(r.text));

r = await req('GET', '/v1/models');
ok('没有 Bearer → 401', r.status === 401, `${r.status}`);
ok('错误体是参考站的形状 {error:{message,type}}',
  r.data?.error?.type === 'invalid_request_error' && r.data?.error?.message === 'invalid api key',
  JSON.stringify(r.data));
ok('错误体没有多塞内部细节（只有 message/type/code）',
  Object.keys(r.data?.error || {}).sort().join(',') === 'code,message,type', JSON.stringify(r.data?.error));

r = await req('GET', '/v1/models', { token: 'dv_not-a-real-token' });
ok('令牌不存在 → 401 invalid api key',
  r.status === 401 && r.data?.error?.code === 'INVALID_API_KEY', JSON.stringify(r.data));

r = await req('GET', '/v1/models', { token: TK_D });
ok('停用令牌 → 403', r.status === 403 && r.data?.error?.code === 'TOKEN_INACTIVE', JSON.stringify(r.data));
r = await req('GET', '/v1/models', { token: TK_E });
ok('过期令牌 → 403', r.status === 403 && r.data?.error?.code === 'TOKEN_EXPIRED', JSON.stringify(r.data));

// ═════════════════════════ ② 模型清单 ═════════════════════════
console.log('\n② 模型清单');
r = await req('GET', '/v1/models', { token: TK_A });
ok('models 可读', r.status === 200 && r.data?.code === 0, JSON.stringify(r.data).slice(0, 120));
ok('信封是参考站的 {code:0,data}', Array.isArray(r.data?.data), JSON.stringify(r.data).slice(0, 120));
const models = r.data?.data || [];
ok('列出了 seedance_v2.5 与 seedance_v2.0',
  models.some((m) => m.id === 'seedance_v2.5') && models.some((m) => m.id === 'seedance_v2.0'),
  JSON.stringify(models.map((m) => m.id)));
ok('15 秒只挂在 v2.0 上（与 generation-policy 的模型映射一致）',
  models.find((m) => m.id === 'seedance_v2.0')?.supported_seconds.includes(15)
  && !models.find((m) => m.id === 'seedance_v2.5')?.supported_seconds.includes(15),
  JSON.stringify(models.map((m) => [m.id, m.supported_seconds])));
ok('**没有编造 resolution**（/v1/models 里干脆不给这个字段）',
  models.every((m) => !has(m, 'resolution')),
  JSON.stringify(models.map((m) => m.resolution)));

r = await req('GET', '/v1/model-groups', { token: TK_A });
const groups = r.data?.data || [];
ok('model-groups 是参考站的形状 data[].models[]',
  r.status === 200 && groups.length === 1 && Array.isArray(groups[0].models), JSON.stringify(r.data).slice(0, 200));
ok('每个 model 带齐 alias/name/duration/resolution/ratio/image/audio/video/remark',
  ['alias', 'name', 'duration', 'resolution', 'ratio', 'image', 'audio', 'video', 'remark']
    .every((k) => has(groups[0]?.models?.[0] || {}, k)),
  JSON.stringify(Object.keys(groups[0]?.models?.[0] || {})));
ok('duration 是字符串数组（参考站就是 ["10","15",…]）',
  (groups[0]?.models?.[0]?.duration || []).every((d) => typeof d === 'string'),
  JSON.stringify(groups[0]?.models?.[0]?.duration));
ok('resolution 是**空数组**而不是编造的清单（我们确实不控制分辨率）',
  groups[0]?.models?.every((m) => Array.isArray(m.resolution) && m.resolution.length === 0),
  JSON.stringify(groups[0]?.models?.map((m) => m.resolution)));
ok('audio 明确是 0（我们没有任何音频能力，不虚标）',
  groups[0]?.models?.every((m) => m.audio === 0));

// ═════════════════════════ ③ 任务隔离与字段白名单 ═════════════════════════
console.log('\n③ 任务隔离与字段白名单');
r = await req('GET', '/v1/videos', { token: TK_A });
const listA = r.data?.data?.items || [];
ok('列表只回自己的任务（4 条）', r.status === 200 && listA.length === 4, `实际 ${listA.length}`);
ok('列表里没有别人的任务（B 的 #' + B_TASK + '）', !listA.some((x) => x.id === B_TASK));

r = await req('GET', `/v1/videos/${B_TASK}`, { token: TK_A });
ok('查别人的任务 → 404（不是 403，不暴露"存在但不属于你"）',
  r.status === 404 && r.data?.error?.code === 'TASK_NOT_FOUND', `${r.status} ${JSON.stringify(r.data)}`);

r = await req('GET', `/v1/videos/${A_ARCHIVED}`, { token: TK_A });
const detail = r.data?.data || {};
const blob = JSON.stringify(r.data);
ok('详情可读', r.status === 200 && detail.id === A_ARCHIVED, JSON.stringify(r.data).slice(0, 160));
ok('**不泄漏 local_path（服务器绝对路径）**', !blob.includes(VIDEO_DIR) && !has(detail, 'local_path'), blob.slice(0, 200));
ok('**不泄漏 account_label（账号身份）**', !blob.includes('内部账号标签') && !has(detail, 'account_label'));
ok('**不泄漏 account_id / owner_token_id / charge_ref / owner_prefix**',
  !has(detail, 'account_id') && !has(detail, 'owner_token_id')
  && !has(detail, 'charge_ref') && !has(detail, 'owner_prefix'),
  JSON.stringify(Object.keys(detail)));
ok('归档任务给的是 /v1 内部地址，不是上游直链',
  detail.url === `/v1/videos/${A_ARCHIVED}/content`, detail.url);
ok('标了 url_source=archive', detail.url_source === 'archive', detail.url_source);
ok('is_unwatermarked=true / archived=true', detail.is_unwatermarked === true && detail.archived === true);

r = await req('GET', `/v1/videos/${A_DIRECT}`, { token: TK_A });
ok('没归档的任务标出 url_expires=upstream-temporary（会过期是事实，要说清）',
  r.data?.data?.url_expires === 'upstream-temporary', JSON.stringify(r.data?.data?.url_expires));

r = await req('GET', `/v1/videos/${A_FAILED}`, { token: TK_A });
ok('失败任务可查且带 error', r.status === 200 && r.data?.data?.error.includes('生成失败'));
ok('失败任务的退款字段存在（退款补偿口径与 gateway 一致）',
  has(r.data?.data || {}, 'refunded') && has(r.data?.data || {}, 'balance'));

// ═════════════════════════ ④ content 的 302 与票据 ═════════════════════════
console.log('\n④ content 的 302 与票据');
r = await req('GET', `/v1/videos/${A_RUNNING}/content`, { token: TK_A });
ok('未通过验收 → 409，不给下载', r.status === 409 && r.data?.error?.code === 'CONTENT_NOT_READY', `${r.status}`);
r = await req('GET', `/v1/videos/${B_TASK}/content`, { token: TK_A });
ok('别人的成片 → 404', r.status === 404, `${r.status}`);

r = await req('GET', `/v1/videos/${A_ARCHIVED}/content`, { token: TK_A });
ok('归档成片 → 302（照抄参考站：客户端不持有会过期的链接）', r.status === 302, `${r.status}`);
const loc = r.headers.get('location') || '';
ok('Location 是**绝对地址**（相对地址会被按页面地址解析，播不出来）',
  loc.startsWith(`${BASE}/v1/files/`), loc);
ok('Location 里**不带令牌原文**（票据即鉴权，不是把 key 塞进 URL）', !loc.includes(TK_A), loc);

r = await req('GET', `/v1/videos/${A_DIRECT}/content`, { token: TK_A });
ok('没归档 → 302 到上游临时直链', r.status === 302 && (r.headers.get('location') || '').includes('vod.example.com'),
  `${r.status} ${r.headers.get('location')}`);

// 票据落地：不带 Authorization 也要能下（播放器拖进度条带不上自定义头）
const ticketPath = loc.replace(BASE, '');
r = await req('GET', ticketPath);
ok('票据地址**无需 Authorization** 即可下载', r.status === 200, `${r.status}`);
ok('带 Content-Length 且等于归档字节数', Number(r.headers.get('content-length')) === ARCHIVED_BYTES,
  `${r.headers.get('content-length')} vs ${ARCHIVED_BYTES}`);
ok('Accept-Ranges: bytes（拖动进度条要靠它）', r.headers.get('accept-ranges') === 'bytes');
ok('无水印成片带 X-Video-Unwatermarked: 1', r.headers.get('x-video-unwatermarked') === '1');

r = await req('GET', ticketPath, { headers: { Range: 'bytes=0-99' } });
ok('Range 请求 → 206 + Content-Range', r.status === 206 && /^bytes 0-99\//.test(r.headers.get('content-range') || ''),
  `${r.status} ${r.headers.get('content-range')}`);

r = await req('GET', ticketPath, { headers: { Range: 'bytes=999999999-' } });
ok('越界 Range → 416（不静默回全片）', r.status === 416, `${r.status}`);

// 改签名尾部（长度不变，专测"签名对不上"而不是"长度对不上"）
const tampered = `${ticketPath.slice(0, -2)}xy`;
r = await req('GET', tampered);
ok('票被改过 → 401', r.status === 401 && r.data?.error?.code === 'TICKET_INVALID', `${r.status} ${JSON.stringify(r.data)}`);
r = await req('GET', '/v1/files/not.a.jwt');
ok('乱写票据 → 401，不是 500', r.status === 401, `${r.status}`);

// ═════════════════════════ ⑤ 提交参数校验（必须零出站） ═════════════════════════
console.log('\n⑤ 提交参数校验（这些分支必须在建任务/扣积分/出站之前挡住）');
const before = outbound.length;
const cases = [
  ['缺 prompt', { seconds: 30 }, 400, 'MISSING_PROMPT'],
  ['seconds 非法（12）', { prompt: 'case-seconds', seconds: 12 }, 400, 'invalid_parameter'],
  ['model 不认识', { prompt: 'case-model', seconds: 30, model: 'seedance_v9' }, 400, 'UNSUPPORTED_MODEL'],
  ['model 与 seconds 组合做不到（v2.5 + 15 秒）', { prompt: 'case-combo', seconds: 15, model: 'seedance_v2.5' }, 400, 'UNSUPPORTED_MODEL_SECONDS'],
  ['传了 audio（我们没这个能力）', { prompt: 'case-audio', seconds: 30, audio: 'x' }, 400, 'UNSUPPORTED_PARAMETER'],
  ['调用方不能覆盖计价', { prompt: 'case-price', seconds: 30, points: 1 }, 400, 'UNSUPPORTED_PARAMETER'],
  ['size 宽高为 0', { prompt: 'case-size', seconds: 30, size: '0x0' }, 400, 'invalid_parameter'],
];
for (const [name, body, wantStatus, wantCode] of cases) {
  const rr = await req('POST', '/v1/videos', { token: TK_A, body });
  ok(`${name} → ${wantStatus} ${wantCode}`,
    rr.status === wantStatus && (rr.data?.error?.code === wantCode || (wantCode === 'invalid_parameter' && rr.data?.error?.code === 'invalid_parameter')),
    `${rr.status} ${JSON.stringify(rr.data)}`);
}
ok('上述 7 次非法提交**一次出站都没发**', outbound.length === before, `多了 ${outbound.length - before} 次`);

const pointsBefore = tk('dv_AAAAAA').points;
ok('非法提交后积分一分没动', pointsBefore === 20, `实际 ${pointsBefore}`);

r = await req('POST', '/v1/videos', { token: TK_Z, body: { prompt: 'case-poor', seconds: 30 } });
ok('零积分令牌 → 402（且不建任务）', r.status === 402, `${r.status} ${JSON.stringify(r.data)}`);
r = await req('POST', '/v1/videos', { token: TK_D, body: { prompt: 'case-disabled', seconds: 30 } });
ok('停用令牌 → 403', r.status === 403, `${r.status}`);

// ═════════════════════════ ⑥ 走到真实链路（账号池为空 = 隔离环境的终点） ═════════════════════════
console.log('\n⑥ 走到真实建任务链路（账号池为空）');
r = await req('POST', '/v1/videos', { token: TK_A, body: { prompt: 'case-nopool', seconds: 30 } });
ok('池里没可用账号 → 409（不是 500）', r.status === 409, `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
ok('409 的 code 不是参考图相关（说明走到了账号选择这一步）',
  r.data?.error?.code !== 'REFERENCE_IMAGES_NOT_READY', JSON.stringify(r.data?.error?.code));
const afterNoPool = tk('dv_AAAAAA').points;
ok('**建任务失败不扣积分**（先建后扣的顺序起作用了）', afterNoPool === 20, `实际 ${afterNoPool}`);

// ═════════════════════════ ⑦ multipart：二进制不能坏 ═════════════════════════
console.log('\n⑦ multipart 参考图（重点：二进制与中文文件名）');

/** 最小合法 JPEG：字节里带 0xFF（非法 UTF-8）—— 一旦被当字符串处理就必然认不出来 */
function tinyJpeg({ width, height }) {
  const b = Buffer.alloc(41);
  b[0] = 0xff; b[1] = 0xd8;                      // SOI
  b[2] = 0xff; b[3] = 0xe0;                      // APP0
  b.writeUInt16BE(16, 4);                        // 段长
  Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1').copy(b, 6);
  b[20] = 0xff; b[21] = 0xc0;                    // SOF0
  b.writeUInt16BE(17, 22);
  b[24] = 8;                                     // 精度
  b.writeUInt16BE(height, 25);
  b.writeUInt16BE(width, 27);
  b[29] = 3; b[30] = 1; b[31] = 0x11; b[32] = 0;
  b[33] = 2; b[34] = 0x11; b[35] = 1; b[36] = 3; b[37] = 0x11; b[38] = 1;
  b[39] = 0xff; b[40] = 0xd9;                    // EOI
  return b;
}

function multipart(fields, files) {
  const boundary = `----v1test${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const f of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n`
      + `Content-Type: ${f.type}\r\n\r\n`, 'utf8'));
    chunks.push(f.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

// ⑦-1 合法 JPEG → 必须通过 validateReferenceImages，然后被账号/参考图池挡下
let mp = multipart({ prompt: 'case-mp-ok', seconds: '30', auto_start: 'true' }, [
  { field: 'input_reference', filename: '参考图测试.jpg', type: 'image/jpeg', data: tinyJpeg({ width: 2559, height: 5 }) },
]);
r = await req('POST', '/v1/videos', { token: TK_A, rawBody: mp.body, contentType: mp.contentType });
ok('multipart 请求被正确解析（不是 400 格式错）', r.status === 409, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
ok('★ 二进制参考图**没被破坏**：认出了 JPEG 并走到参考图池检查',
  r.data?.error?.code === 'REFERENCE_IMAGES_NOT_READY', JSON.stringify(r.data?.error?.code));
ok('★ 走到这一步说明宽高也被正确读出来了（2559x5，含 0xFF 字节）', r.status === 409);

// ⑦-2 坏图 → 必须报"不是有效图片"，且把**中文文件名**原样带出来
mp = multipart({ prompt: 'case-mp-bad' }, [
  { field: 'input_reference', filename: '坏图-中文名.png', type: 'image/png', data: Buffer.from('not an image at all') },
]);
r = await req('POST', '/v1/videos', { token: TK_A, rawBody: mp.body, contentType: mp.contentType });
ok('坏图 → 400 REFERENCE_IMAGE_INVALID', r.status === 400 && r.data?.error?.code === 'REFERENCE_IMAGE_INVALID',
  `${r.status} ${JSON.stringify(r.data)}`);
ok('★ 中文文件名没被搞成乱码（头部按 UTF-8 解）',
  String(r.data?.error?.message || '').includes('坏图-中文名.png'), JSON.stringify(r.data?.error?.message));

// ⑦-3 JSON 里的 images（base64）走同一条校验
r = await req('POST', '/v1/videos', {
  token: TK_A,
  body: { prompt: 'case-json-img', seconds: 30, images: [{ dataBase64: tinyJpeg({ width: 1920, height: 1080 }).toString('base64'), name: 'a.jpg' }] },
});
ok('JSON base64 参考图走同一套校验 → REFERENCE_IMAGES_NOT_READY',
  r.status === 409 && r.data?.error?.code === 'REFERENCE_IMAGES_NOT_READY', `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);

// ⑦-4 multipart 的 404 兜底必须回 JSON
r = await req('POST', '/v1/videos', { token: TK_A, rawBody: Buffer.alloc(8), contentType: 'multipart/form-data' });
ok('multipart 没有 boundary → 400（不是崩）', r.status === 400, `${r.status}`);

// ⑦-5 不认识的 multipart 文件字段必须显式拒绝，不能静默丢掉
mp = multipart({ prompt: 'case-mp-unknown' }, [
  { field: 'mystery_file', filename: 'x.bin', type: 'application/octet-stream', data: Buffer.from('xyz') },
]);
r = await req('POST', '/v1/videos', { token: TK_A, rawBody: mp.body, contentType: mp.contentType });
ok('不认识的 multipart 文件字段 → 400（静默忽略等于骗人）',
  r.status === 400 && r.data?.error?.code === 'UNSUPPORTED_PARAMETER', `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);

// ═════════════════════════ ⑧ 生命周期 ═════════════════════════
console.log('\n⑧ 生命周期');
r = await req('POST', `/v1/videos/${A_RUNNING}/start`, { token: TK_A });
ok('已在生成的任务再 start → 幂等返回 started=true', r.status === 200 && r.data?.data?.started === true,
  `${r.status} ${JSON.stringify(r.data)}`);
r = await req('POST', `/v1/videos/${A_ARCHIVED}/start`, { token: TK_A });
ok('已完成的任务 start → 409 TASK_NOT_STARTABLE',
  r.status === 409 && r.data?.error?.code === 'TASK_NOT_STARTABLE', `${r.status} ${JSON.stringify(r.data)}`);
r = await req('POST', `/v1/videos/${B_TASK}/start`, { token: TK_A });
ok('start 别人的任务 → 404', r.status === 404, `${r.status}`);

r = await req('POST', `/v1/videos/${A_RUNNING}/cancel`, { token: TK_A });
ok('取消生成中的任务：成功但**不退款**（上游额度已花）',
  r.status === 200 && r.data?.data?.refunded === false && r.data?.data?.status === 'cancelled',
  JSON.stringify(r.data));
r = await req('DELETE', `/v1/videos/${A_FAILED}`, { token: TK_A });
ok('DELETE 与 cancel 同义（失败任务可退）', r.status === 200 && has(r.data?.data || {}, 'refunded'), JSON.stringify(r.data));
r = await req('DELETE', `/v1/videos/${B_TASK}`, { token: TK_A });
ok('取消别人的任务 → 404', r.status === 404, `${r.status}`);

// ── auto_start=false 的完整生命周期：建 → 冻结积分 → start → 失败自动退款 ──
// 这条最重要：它走的是真实的 startVideoTask + settleFailedVideoRefund，
// 证明"扣了钱没跑"这种状态在本服务里不可能长期存在。
console.log('\n⑧-b auto_start=false 的生命周期（真实启动 + 失败自动退款）');
insToken.run('生命周期令牌', 'dv_' + 'C'.repeat(32), 'dv_CCCCCC', 19, 'active', null, '', null, now(), now());
const TK_C = tk('dv_CCCCCC');
const lifeId = seedVideo(null, '内部账号标签-不该外泄', '生命周期任务', '16:9', 30, 'queued', '排队中',
  null, null, '', 0, null, null, null, null, '',
  TK_C.id, 'dv_CCCCCC', '', now(), now(), now());
// 种子：这笔扣费必须真实存在且 token_id 对得上，否则 startVideoTask 会拒绝启动（这是它的护栏）
db.prepare('UPDATE dola_videos SET charge_ref=? WHERE id=?').run(`gen-${lifeId}`, lifeId);
db.prepare(`INSERT INTO point_transactions (token_id, token_prefix, delta, kind, reason, ref, created_at)
            VALUES (?,?,?,?,?,?,?)`).run(TK_C.id, 'dv_CCCCCC', 1, 'consume', 'video', `gen-${lifeId}`, now());

r = await req('POST', `/v1/videos/${lifeId}/start`, { token: TK_C.value });
ok('queued 且计费有效 → start 成功', r.status === 200 && r.data?.data?.started === true, `${r.status} ${JSON.stringify(r.data)}`);

await new Promise((res) => setTimeout(res, 400));   // 让 setImmediate 里的 run() 跑完
const lifeRow = db.prepare('SELECT status, error FROM dola_videos WHERE id=?').get(lifeId);
ok('池里没账号 → 任务自动落 failed（不是永远卡在排队）',
  lifeRow.status === 'failed' && lifeRow.error.includes('账号'), JSON.stringify(lifeRow));
const refundTx = db.prepare("SELECT * FROM point_transactions WHERE kind='refund' AND ref=?").get(`gen-${lifeId}`);
ok('★ 失败后**自动退了积分**（流水里有 refund 记录）', Boolean(refundTx), JSON.stringify(refundTx));
ok('★ 余额确实退回来了（19 → 20）', tk('dv_CCCCCC').points === 20, `实际 ${tk('dv_CCCCCC').points}`);
r = await req('GET', `/v1/videos/${lifeId}`, { token: TK_C.value });
ok('查详情时也如实报告已退款', r.status === 200 && r.data?.data?.status === 'failed' && r.data?.data?.balance === 20,
  JSON.stringify(r.data?.data).slice(0, 200));

// ═════════════════════════ ⑨ 账户与兜底 ═════════════════════════
console.log('\n⑨ 账户信息与 404 兜底');
r = await req('GET', '/v1/accounts', { token: TK_A });
ok('accounts 返回自己的余额与前缀',
  r.status === 200 && r.data?.data?.prefix === 'dv_AAAAAA' && r.data?.data?.points === 20, JSON.stringify(r.data).slice(0, 160));
ok('accounts **不返回令牌原文**', !JSON.stringify(r.data).includes(TK_A));

r = await req('GET', '/v1/status', { token: TK_A });
ok('status 可读且给出池容量', r.status === 200 && r.data?.data?.generation && has(r.data.data, 'supported_seconds'));
ok('status **不泄漏账号池明细**（参考站那份 697 KB 的 /health 就是反面教材）',
  !/account_label|"cookie"|exit_ip/i.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 200));

r = await req('GET', '/v1/nope');
ok('不存在的 /v1 路径 → 404 JSON，**不是 SPA 的 HTML**',
  r.status === 404 && r.data?.error?.code === 'NOT_FOUND', `${r.status} ${r.text.slice(0, 80)}`);
r = await req('GET', '/v1/nope', { token: TK_A });
ok('带令牌访问不存在的路径 → 仍是 404 JSON', r.status === 404 && r.data?.error?.code === 'NOT_FOUND', `${r.status}`);
r = await req('POST', '/v1/videos/nope/whatever', { token: TK_A, body: {} });
ok('不存在的 POST 子路径 → 404 JSON', r.status === 404 && r.data?.error?.code === 'NOT_FOUND', `${r.status}`);

// ═════════════════════════ ⑩ 卡密兑换（/v1/redeem）═════════════════════════
// 这条是从 api.fei85.cn 的 /api/redeem 迁过来的能力，与 /api/gateway/redeem 共用
// 同一份 redeemCard()。重点验三件事：卡只能充给自己、并发不会重复兑换、失败码分得清。
console.log('\n⑩ 卡密兑换');
const insCard = db.prepare(`INSERT INTO cards (code, prefix, points, status, expires_at, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?)`);
const newCard = (code, points, { status = 'unused', expiresAt = null } = {}) =>
  insCard.run(code, code.slice(0, 8), points, status, expiresAt, now(), now());
const cardOf = (code) => db.prepare('SELECT * FROM cards WHERE code=?').get(code);

r = await req('POST', '/v1/redeem', { token: TK_A, body: {} });
ok('不带卡密 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);

r = await req('POST', '/v1/redeem', { body: { card: 'card_nokey' } });
ok('不带令牌 → 401 invalid api key', r.status === 401 && r.data?.error?.message === 'invalid api key', `${r.status}`);

newCard('card_missing_xxxx', 5);
r = await req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_nope_xxxx' } });
ok('卡密不存在 → 404', r.status === 404 && /不存在/.test(r.data?.error?.message || ''), `${r.status} ${JSON.stringify(r.data)}`);

newCard('card_revoked_xxxx', 5, { status: 'revoked' });
r = await req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_revoked_xxxx' } });
ok('卡密已撤销 → 400', r.status === 400 && /撤销/.test(r.data?.error?.message || ''), `${r.status}`);

newCard('card_expired_xxxx', 5, { expiresAt: '2020-01-01T00:00:00.000Z' });
r = await req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_expired_xxxx' } });
ok('卡密已过期 → 400', r.status === 400 && /过期/.test(r.data?.error?.message || ''), `${r.status}`);

// 停用令牌：requireApiToken 在进 handler 之前就拦掉，所以是 403 TOKEN_INACTIVE
newCard('card_disabled_xxxx', 5);
r = await req('POST', '/v1/redeem', { token: TK_D, body: { card: 'card_disabled_xxxx' } });
ok('停用令牌 → 403（鉴权层先拦，卡密保持未使用）',
  r.status === 403 && cardOf('card_disabled_xxxx').status === 'unused', `${r.status}`);

// ── 成功路径：余额真的加了，卡真的被标记为已兑换 ──
const pointsBeforeRedeem = tk('dv_AAAAAA').points;
newCard('card_ok_aaaa_xxxx', 7);
r = await req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_ok_aaaa_xxxx' } });
ok('有效卡密 → 200 且返回面额与新余额',
  r.status === 200 && r.data?.data?.points === 7 && r.data?.data?.balance === pointsBeforeRedeem + 7,
  `${r.status} ${JSON.stringify(r.data)}`);
ok('★ 余额确实落库了（不是只回给前端看）', tk('dv_AAAAAA').points === pointsBeforeRedeem + 7,
  `实际 ${tk('dv_AAAAAA').points}`);
const redeemedCard = cardOf('card_ok_aaaa_xxxx');
ok('★ 卡被标记为 redeemed 且记了兑换人', redeemedCard.status === 'redeemed'
  && redeemedCard.redeemed_by_token === tk('dv_AAAAAA').id, JSON.stringify(redeemedCard));
ok('兑换响应**不回令牌原文**', !JSON.stringify(r.data).includes(TK_A));
ok('审计日志记了 v1.card.redeem',
  Boolean(db.prepare("SELECT id FROM audit_logs WHERE action='v1.card.redeem'").get()));

// ── 同一张卡再兑一次 ──
r = await req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_ok_aaaa_xxxx' } });
ok('同一张卡重复兑换 → 409，且余额不再增加',
  r.status === 409 && tk('dv_AAAAAA').points === pointsBeforeRedeem + 7, `${r.status} ${tk('dv_AAAAAA').points}`);

// ── 并发兑换同一张卡：只能成功一次（原子条件是 UPDATE ... AND status='unused'）──
newCard('card_race_xxxx', 3);
const raceBefore = tk('dv_AAAAAA').points;
const race = await Promise.all([
  req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_race_xxxx' } }),
  req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_race_xxxx' } }),
  req('POST', '/v1/redeem', { token: TK_A, body: { card: 'card_race_xxxx' } }),
]);
const won = race.filter((item) => item.status === 200).length;
const lost = race.filter((item) => item.status === 409).length;
ok('★ 并发 3 次兑换同一张卡 → 只成功 1 次，另 2 次 409', won === 1 && lost === 2,
  `200×${won} 409×${lost} ${race.map((x) => x.status).join(',')}`);
ok('★ 并发下余额只加了一次（不是三次）', tk('dv_AAAAAA').points === raceBefore + 3,
  `期望 ${raceBefore + 3} 实际 ${tk('dv_AAAAAA').points}`);

// ── 卡只能充给自己：B 兑的卡不会落到 A 头上 ──
newCard('card_owner_xxxx', 11);
const aBefore = tk('dv_AAAAAA').points;
const bBefore = tk('dv_BBBBBB').points;
r = await req('POST', '/v1/redeem', { token: TK_B, body: { card: 'card_owner_xxxx' } });
ok('★ 用 B 的令牌兑换 → 只有 B 加积分，A 的余额不动',
  r.status === 200 && tk('dv_BBBBBB').points === bBefore + 11 && tk('dv_AAAAAA').points === aBefore,
  `A=${tk('dv_AAAAAA').points} B=${tk('dv_BBBBBB').points}`);

// 即使显式传一个别人的 tokenId，也只能充给令牌自己 —— 入参里根本没有这个口子
newCard('card_inject_xxxx', 13);
const aGuard = tk('dv_AAAAAA').points;
const bGuard = tk('dv_BBBBBB').points;
r = await req('POST', '/v1/redeem', {
  token: TK_B, body: { card: 'card_inject_xxxx', tokenId: tk('dv_AAAAAA').id },
});
ok('★ 显式传别人的 tokenId 也无效：积分仍然只加到持令牌的 B 上',
  r.status === 200 && tk('dv_BBBBBB').points === bGuard + 13 && tk('dv_AAAAAA').points === aGuard,
  `A=${tk('dv_AAAAAA').points} B=${tk('dv_BBBBBB').points}`);

// `code` 是 `card` 的别名（对齐参考站卡密的叫法）
newCard('card_alias_xxxx', 2);
r = await req('POST', '/v1/redeem', { token: TK_A, body: { code: 'card_alias_xxxx' } });
ok('code 与 card 等价（别名可用）', r.status === 200 && r.data?.data?.points === 2, `${r.status}`);

// ───────────────────────── 收尾 ─────────────────────────
server.close();
console.log(`\n${'─'.repeat(56)}`);
if (fails.length) {
  console.log(`❌ ${pass} 项通过，${fails.length} 项失败：`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 全部 ${pass} 项通过`);
process.exit(0);
