/**
 * 成片库（/api/media）隔离冒烟测试
 *
 * 三件必须做到的事：
 *   ① **不碰线上/既有数据** —— 独立库（ADMIN_DB）+ 独立端口 + 独立归档目录
 *   ② **不碰真实上游** —— 替换 `globalThis.fetch`，把 dola 消息链和 fallback_api
 *      全 mock 掉（`fetchVia` 在无代理时走全局 fetch，所以这是可行的注入点）
 *   ③ **端到端真跑**：扫描 → 解析无水印 → 换凭证 → 补录 → 归档 → 流式下载 → Range
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件住在 <admin>/test/ 下，上一级就是 admin 根 */
const ADMIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TAG = `smoke${Date.now()}`;
const DB = `/tmp/media-${TAG}.db`;
const VIDEO_DIR = `/tmp/media-videos-${TAG}`;
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

// ⚠️ 必须在 import db.js 之前设好
process.env.ADMIN_DB = DB;
process.env.MEDIA_VIDEO_DIR = VIDEO_DIR;

// ───────────────────────── mock 上游 ─────────────────────────
const FB = 'https://vod-urls-mya.byteintlapi.com/video/fplay/1/deadbeef/999';
const UW_MP4 = 'https://vod-urls-mya.byteintlapi.com/mock/no-wm-1.mp4';
const WM_MP4 = 'https://vod-urls-mya.byteintlapi.com/mock/wm-1.mp4';
const EXPIRED = 'https://vod-urls-mya.byteintlapi.com/mock/expired.mp4';
const MP4 = Buffer.alloc(4096, 0x41); // > 1024，通过「不像视频」的最小体积检查

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url);

  // ⚠️ 本机请求必须直通真实 fetch —— 否则测试自己打给自己后端的那几个请求
  //    也会被 mock 拦住（症状是「接口一律 404，且错误体是我 mock 的 JSON」）。
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init);

  const method = (init?.method || 'GET').toUpperCase();
  calls.push(`${method} ${u.host}${u.pathname}`);

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  // ① dola 消息链
  if (u.host === 'www.dola.com' && u.pathname === '/im/chain/single') {
    // fallback_api 故意套两层 JSON 字符串，模拟真实的多层转义
    const inner = JSON.stringify({ video: { fallback_api: FB }, play_url: WM_MP4 });
    return json({
      data: {
        message_list: [
          { index: 1, content: JSON.stringify({ text: `成片地址 ${WM_MP4}` }) },
          { index: 2, content: inner },
        ],
      },
    });
  }
  // ② fallback_api → 无水印（关键：必须带上那三个参数才给无水印版本）
  if (u.host === 'vod-urls-mya.byteintlapi.com' && u.pathname.startsWith('/video/fplay/')) {
    const wantUw = u.searchParams.get('logo_type') === 'unwatermarked'
      && u.searchParams.get('channel') === 'no'
      && u.searchParams.get('codec_type') === '8';
    if (!wantUw) return json({ video_info: { data: { main_url: WM_MP4, bitrate: 3294 } } });
    return json({ video_info: { data: { main_url: UW_MP4, bitrate: 14198, vwidth: 1920, vheight: 1080 } } });
  }
  // ③ 成片本体
  if (u.pathname === '/mock/no-wm-1.mp4') return new Response(MP4, { status: 200 });
  if (u.pathname === '/mock/wm-1.mp4') return new Response(MP4, { status: 200 });
  if (u.pathname === '/mock/expired.mp4') return new Response('gone', { status: 403 });

  return json({ error: `unmocked ${url}` }, 404);
};

// ───────────────────────── 断言工具 ─────────────────────────
let pass = 0; const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fails.push(name); console.log(`  ❌ ${name} ${extra}`); }
}

// ───────────────────────── 起服务 ─────────────────────────
// ⚠️ 不能用 `const { initDb, db } = await import(...)`：
//    **解构会切断 ESM 的 live binding**，`db` 会被固定成解构那一刻的值（null），
//    因为 db.js 的 `db` 是 initDb() 之后才赋值的。必须走命名空间对象现取。
const dbMod = await import(`${ADMIN}/server/db.js`);
await dbMod.initDb();
const db = dbMod.db;
if (!db) { console.error('initDb 之后 db 仍为 null —— 环境有问题'); process.exit(1); }

const { default: mediaRoutes } = await import(`${ADMIN}/server/media-routes.js`);
const { default: authRoutes } = await import(`${ADMIN}/server/routes/auth.js`);
const { authMiddleware } = await import(`${ADMIN}/server/auth.js`);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(authMiddleware);            // 与 index.js 一致：全局挂
app.use('/api/auth', authRoutes);
app.use('/api/media', mediaRoutes);

const server = await new Promise((res) => { const s = app.listen(PORT, '127.0.0.1', () => res(s)); });
console.log(`\n服务已起：${BASE}  库=${DB}  归档=${VIDEO_DIR}\n`);

// ───────────────────────── 播种 ─────────────────────────
const now = () => new Date().toISOString();
db.prepare(`INSERT INTO dola_accounts (label, cookie, status, proxy, created_at, updated_at)
            VALUES (?,?,?,?,?,?)`).run('冒烟-有cookie无代理', 'ttwid=x; odin_tt=y', 'valid', '', now(), now());
db.prepare(`INSERT INTO dola_accounts (label, cookie, status, proxy, created_at, updated_at)
            VALUES (?,?,?,?,?,?)`).run('冒烟-没cookie', '', 'unknown', '', now(), now());
const accA = db.prepare("SELECT id FROM dola_accounts WHERE label='冒烟-有cookie无代理'").get().id;
const accB = db.prepare("SELECT id FROM dola_accounts WHERE label='冒烟-没cookie'").get().id;
console.log(`播种账号：#${accA}（有 cookie）、#${accB}（无 cookie）\n`);

async function req(method, p, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return r;
  let data = {};
  try { data = await r.json(); } catch { /* 空 */ }
  return { status: r.status, data, headers: r.headers };
}

// ───────────────────────── ① 鉴权 ─────────────────────────
console.log('① 鉴权');
let r = await req('GET', '/api/media/library');
ok('未登录访问成片库 → 401', r.status === 401, `实际 ${r.status}`);
r = await req('GET', '/api/media/library', { token: 'garbage.token.value' });
ok('坏 token → 401', r.status === 401, `实际 ${r.status}`);

r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
ok('默认管理员可登录（拿到 token）', r.status === 200 && r.data?.token, JSON.stringify(r.data).slice(0, 120));
const TOKEN = r.data?.token;
if (!TOKEN) { console.log('\n拿不到 token，后续无法继续。'); process.exit(1); }

// ───────────────────────── ② 只读接口 ─────────────────────────
console.log('\n② 只读接口');
r = await req('GET', '/api/media/stats', { token: TOKEN });
ok('stats 可读且字段齐全', r.status === 200 && r.data.ok && r.data.total === 0
  && 'diskBytes' in r.data && 'videoDir' in r.data, JSON.stringify(r.data));
ok('stats 的口径互斥（total=0 时全为 0）',
  r.data.archived === 0 && r.data.withUrlOnly === 0 && r.data.unwatermarked === 0);

r = await req('GET', '/api/media/accounts', { token: TOKEN });
const accts = r.data.items || [];
ok('账号选择器返回 2 条', r.status === 200 && accts.length === 2, `实际 ${accts.length}`);
ok('账号选择器 **不泄漏 cookie**（没有任何字段带 cookie 值）',
  !JSON.stringify(accts).includes('ttwid=x') && !('cookie' in (accts[0] || {})));
ok('账号选择器标出了「有无代理 / 有无 cookie」',
  accts.some((a) => a.hasCookie && !a.hasProxy) && accts.some((a) => !a.hasCookie));

r = await req('GET', '/api/media/tokens', { token: TOKEN });
ok('令牌选择器可读', r.status === 200 && r.data.ok);
ok('令牌选择器 **不返回令牌值**', !JSON.stringify(r.data).includes('"value"'));

r = await req('GET', '/api/media/library', { token: TOKEN });
ok('空库列表正常返回', r.status === 200 && r.data.total === 0 && Array.isArray(r.data.items));

// ───────────────────────── ③ 扫描的输入校验 ─────────────────────────
console.log('\n③ 扫描参数校验（这些分支必须在发出站请求之前就挡住）');
const before = calls.length;
r = await req('POST', '/api/media/conversation/scan', { token: TOKEN, body: { conversationId: 'x' } });
ok('没给账号 → 400', r.status === 400, `${r.status} ${r.data.message || ''}`);
r = await req('POST', '/api/media/conversation/scan', { token: TOKEN, body: { accountId: accA } });
ok('没给会话 id → 400', r.status === 400, `${r.status}`);
r = await req('POST', '/api/media/conversation/scan', { token: TOKEN, body: { accountId: 999999, conversationId: 'x' } });
ok('账号不存在 → 404', r.status === 404, `${r.status}`);
r = await req('POST', '/api/media/conversation/scan', { token: TOKEN, body: { accountId: accB, conversationId: 'x' } });
ok('账号无 cookie → 400', r.status === 400 && r.data.message.includes('cookie'), `${r.status} ${r.data.message || ''}`);
ok('上述 4 次非法请求**一次出站都没发**', calls.length === before, `多了 ${calls.length - before} 次`);

// ───────────────────────── ④ 扫描成功路径 ─────────────────────────
console.log('\n④ 扫描会话（mock 上游）');
r = await req('POST', '/api/media/conversation/scan', {
  token: TOKEN, body: { accountId: accA, conversationId: 'smoke-conv-1' },
});
ok('扫描成功', r.status === 200 && r.data.ok, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
const scan = r.data;
ok('拿到 ticket', typeof scan.ticket === 'string' && scan.ticket.length > 10);
ok('回传了 expirySec（前端不硬编码 TTL）', Number(scan.expirySec) === 600, `实际 ${scan.expirySec}`);
ok('解析出 1 条无水印成片', scan.unwatermarkedCount === 1, `实际 ${scan.unwatermarkedCount}`);
ok('列出的成片里有**明文直链**（后台允许绕计费，不做掩码）',
  scan.items[0]?.unwatermarkedUrl === UW_MP4, scan.items[0]?.unwatermarkedUrl);
ok('同时给了带水印直链做兜底', scan.items[0]?.watermarkedUrl === WM_MP4, scan.items[0]?.watermarkedUrl);
ok('标了 tokenForm=plain（http 直链）', scan.items[0]?.tokenForm === 'plain');
ok('usedProxy=false（该账号没配代理）', scan.usedProxy === false);
ok('没有配代理时给出风控提示', typeof scan.note === 'string' && scan.note.includes('代理'));
ok('走了真实的消息链 mock', calls.some((c) => c.includes('/im/chain/single')), calls.join(' | '));
ok('fallback_api 请求带了那三个无水印参数',
  calls.some((c) => c.includes('/video/fplay')), calls.filter((c) => c.includes('fplay')).join(' | '));

// ───────────────────────── ⑤ 补录 + 归档 ─────────────────────────
console.log('\n⑤ 补录（含归档）');
r = await req('POST', '/api/media/conversation/import', {
  token: TOKEN,
  body: { ticket: scan.ticket, indexes: [0], prompt: '冒烟提示词', seconds: 30, ratio: '16:9', archive: true },
});
ok('补录成功', r.status === 200 && r.data.imported === 1, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
const vid = r.data.results?.[0]?.id;
ok('结果里给出了新任务 id', Number.isInteger(vid), String(vid));
ok('结果标记已归档', r.data.results?.[0]?.archived === true);
ok('结果标记为无水印', r.data.results?.[0]?.isUnwatermarked === true);

const archivedFile = path.join(VIDEO_DIR, `${vid}-nowatermark.mp4`);
ok('磁盘上真出现了归档文件', fs.existsSync(archivedFile), archivedFile);
ok('归档文件大小正确', fs.existsSync(archivedFile) && fs.statSync(archivedFile).size === MP4.length);
// 归档必须落在 MEDIA_VIDEO_DIR 覆盖的那个目录，不能漏进仓库的 data/videos
ok('归档**没有**漏进仓库的 data/videos',
  !fs.existsSync(path.join(ADMIN, 'server', 'data', 'videos', `${vid}-nowatermark.mp4`)));

// 幂等
r = await req('POST', '/api/media/conversation/import', {
  token: TOKEN, body: { ticket: scan.ticket, indexes: [0], archive: true },
});
ok('同一 ticket 再补一次 → 判为 duplicate，不重复入库',
  r.status === 200 && r.data.imported === 0 && r.data.duplicate === 1,
  JSON.stringify(r.data).slice(0, 200));
ok('库里仍然只有 1 条', db.prepare('SELECT COUNT(*) n FROM dola_videos').get().n === 1);

// 假 ticket
r = await req('POST', '/api/media/conversation/import', { token: TOKEN, body: { ticket: 'bogus', indexes: [0] } });
ok('假 ticket → 410 且提示重新扫描', r.status === 410 && r.data.message.includes('重新扫描'), `${r.status}`);

// ───────────────────────── ⑥ 成片库列表 ─────────────────────────
console.log('\n⑥ 成片库');
r = await req('GET', '/api/media/library', { token: TOKEN });
const row = r.data.items?.[0];
ok('列表 1 条', r.status === 200 && r.data.total === 1);
ok('isUnwatermarked=true', row?.isUnwatermarked === true);
ok('onDisk=true / archived=true', row?.onDisk === true && row?.archived === true);
ok('lost=false', row?.lost === false);
ok('downloadable=true', row?.downloadable === true);
ok('列表里带了明文直链', row?.unwatermarkedUrl === UW_MP4);
ok('seconds 按传入值记录（30 而不是默认 10）', row?.seconds === 30, `实际 ${row?.seconds}`);

r = await req('GET', '/api/media/library?unwatermarked=1', { token: TOKEN });
ok('只看无水印 → 1 条', r.data.total === 1);
r = await req('GET', '/api/media/library?archived=0', { token: TOKEN });
ok('只看「仅直链」→ 0 条（已归档）', r.data.total === 0, `实际 ${r.data.total}`);
r = await req('GET', '/api/media/library?q=冒烟', { token: TOKEN });
ok('按提示词搜索命中', r.data.total === 1);
r = await req('GET', '/api/media/library?q=不存在的词', { token: TOKEN });
ok('搜不到就是 0', r.data.total === 0);

r = await req('GET', '/api/media/stats', { token: TOKEN });
ok('stats 已更新（total=1 archived=1 unwatermarked=1 withUrlOnly=0）',
  r.data.total === 1 && r.data.archived === 1 && r.data.unwatermarked === 1 && r.data.withUrlOnly === 0,
  JSON.stringify(r.data));
ok('stats 的 diskBytes 与实际文件一致', r.data.diskBytes === MP4.length, `${r.data.diskBytes} vs ${MP4.length}`);

// ───────────────────────── ⑦ 播放凭证 / 流式下载 ─────────────────────────
console.log('\n⑦ 播放凭证与流式下载');
r = await req('POST', `/api/media/library/${vid}/ticket`, { token: TOKEN, body: {} });
ok('换到凭证', r.status === 200 && r.data.ticket, `${r.status}`);
const t = r.data;
ok('给了 streamUrl / downloadUrl / refreshUrl 三种地址',
  t.streamUrl?.startsWith('/api/media/stream/') && t.downloadUrl?.includes('download=1') && t.refreshUrl?.includes('refresh=1'));
ok('凭证通道**不需要**登录态（<video> 带不了请求头）', true);

let raw = await req('GET', t.streamUrl, { raw: true });
const buf = Buffer.from(await raw.arrayBuffer());
ok('凭证流 → 200', raw.status === 200, `实际 ${raw.status}`);
ok('带 X-Video-Unwatermarked: 1', raw.headers.get('x-video-unwatermarked') === '1');
ok('带 Accept-Ranges: bytes（可拖进度条）', raw.headers.get('accept-ranges') === 'bytes');
ok('字节数一致', buf.length === MP4.length, `${buf.length} vs ${MP4.length}`);

raw = await fetch(`${BASE}${t.streamUrl}`, { headers: { Range: 'bytes=0-99' } });
ok('Range 请求 → 206', raw.status === 206, `实际 ${raw.status}`);
ok('Content-Range 正确', raw.headers.get('content-range') === `bytes 0-99/${MP4.length}`, raw.headers.get('content-range'));
ok('Content-Length=100', raw.headers.get('content-length') === '100');
await raw.arrayBuffer();

raw = await fetch(`${BASE}${t.downloadUrl}`);
ok('downloadUrl 带 Content-Disposition 附件头',
  (raw.headers.get('content-disposition') || '').includes('attachment'), raw.headers.get('content-disposition') || '(无)');
ok('文件名带 -nowatermark', (raw.headers.get('content-disposition') || '').includes('-nowatermark'));
await raw.arrayBuffer();

ok('凭证可**重复使用**（Range 会发多个请求，一次性会让拖动进度条 403）',
  (await fetch(`${BASE}${t.streamUrl}`)).status === 200);

r = await req('GET', '/api/media/stream/definitely-not-a-ticket');
ok('假凭证 → 403', r.status === 403, `实际 ${r.status}`);

r = await req('POST', `/api/media/library/999999/ticket`, { token: TOKEN, body: {} });
ok('给不存在的任务换凭证 → 404', r.status === 404, `实际 ${r.status}`);

r = await req('GET', `/api/media/library/${vid}/file`, { token: TOKEN, raw: true });
ok('JWT 直调也能下载（脚本/curl 用）', r.status === 200, `实际 ${r.status}`);
await r.arrayBuffer();

// ───────────────────────── ⑧ 归档丢失 / 直链过期 ─────────────────────────
console.log('\n⑧ 归档丢失与直链过期兜底');
// 造一条「库里记着有归档、磁盘上没了」
const ghostFile = path.join(VIDEO_DIR, 'ghost.mp4');
fs.writeFileSync(ghostFile, MP4);
const ghostId = db.prepare(`INSERT INTO dola_videos
  (account_id, account_label, conversation_id, prompt, ratio, seconds, status, stage,
   watermarked_url, unwatermarked_url, unwatermark_note, is_unwatermarked,
   local_path, local_bytes, owner_prefix, charge_ref, created_at, updated_at, finished_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(accA, '冒烟', 'smoke-conv-2', '归档丢失样本', '16:9', 10, 'ready', '补录',
    null, UW_MP4, '样本', 1, ghostFile, MP4.length, '', '', now(), now(), now())
  .lastInsertRowid;
fs.unlinkSync(ghostFile); // 文件消失 → lost

r = await req('GET', '/api/media/library', { token: TOKEN });
const ghost = r.data.items.find((x) => x.id === Number(ghostId));
ok('识别出「文件丢失」（库里有 local_path、磁盘上没有）', ghost?.lost === true, JSON.stringify(ghost && { lost: ghost.lost, onDisk: ghost.onDisk }));
ok('文件丢失时标记为可抢存', ghost?.recoverable === true && ghost?.downloadable === false);

r = await req('GET', `/api/media/library/${ghostId}/file?refresh=1`, { token: TOKEN, raw: true });
ok('丢失后带 refresh 能抢存回来 → 200', r.status === 200, `实际 ${r.status}`);
await r.arrayBuffer();
// 抢存后 local_path 会改写成按 id 规范命名的文件（`<id>-nowatermark.mp4`），
// 而不是原来那个自己编的名字 —— 所以断言要看库里的新值，不能盯老路径。
const ghostAfter = db.prepare('SELECT local_path, local_bytes FROM dola_videos WHERE id = ?').get(ghostId);
ok('抢存后 local_path 已改写为规范名', ghostAfter.local_path.endsWith(`${ghostId}-nowatermark.mp4`), ghostAfter.local_path);
ok('抢存后文件真的落在磁盘上', fs.existsSync(ghostAfter.local_path), ghostAfter.local_path);
ok('抢存后 local_bytes 已回填', ghostAfter.local_bytes === MP4.length, String(ghostAfter.local_bytes));
ok('旧的幽灵路径没有被复活', !fs.existsSync(ghostFile));
r = await req('GET', `/api/media/library/${ghostId}/file`, { token: TOKEN, raw: true });
ok('之后不带 refresh 也能直接下', r.status === 200, `实际 ${r.status}`);
await r.arrayBuffer();

// 直链过期
const expId = db.prepare(`INSERT INTO dola_videos
  (account_id, account_label, conversation_id, prompt, ratio, seconds, status, stage,
   watermarked_url, unwatermarked_url, unwatermark_note, is_unwatermarked,
   owner_prefix, charge_ref, created_at, updated_at, finished_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(accA, '冒烟', 'smoke-conv-3', '直链过期样本', '16:9', 10, 'ready', '补录',
    null, EXPIRED, '样本', 1, '', '', now(), now(), now())
  .lastInsertRowid;

r = await req('GET', `/api/media/library/${expId}/file`, { token: TOKEN });
ok('没归档、没 refresh → 409 且标记 refreshable', r.status === 409 && r.data.refreshable === true, `${r.status}`);
r = await req('GET', `/api/media/library/${expId}/file?refresh=1`, { token: TOKEN });
ok('直链已过期（403）→ 410 且 gone=true，提示去重扫',
  r.status === 410 && r.data.gone === true && r.data.message.includes('重新扫描'), `${r.status} ${r.data.message || ''}`);
r = await req('POST', `/api/media/library/${expId}/archive`, { token: TOKEN, body: {} });
ok('补归档同样报 gone（两个入口口径一致）', r.status === 410 && r.data.gone === true, `${r.status}`);
r = await req('POST', `/api/media/library/${ghostId}/archive`, { token: TOKEN, body: {} });
ok('已归档的再补 → already=true 且不重复抓', r.status === 200 && r.data.already === true, `${r.status}`);

// ───────────────────────── ⑨ 库一致性 ─────────────────────────
console.log('\n⑨ 收尾一致性');
r = await req('GET', '/api/media/stats', { token: TOKEN });
ok('withUrlOnly 恰好等于「有直链但没归档」的条数', r.data.withUrlOnly === 1, `实际 ${r.data.withUrlOnly}`);
ok('total=3', r.data.total === 3, `实际 ${r.data.total}`);

// ───────────────────────── 清理 ─────────────────────────
server.close();
globalThis.fetch = realFetch;
for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.unlinkSync(f); } catch { /* 无所谓 */ } }
try { fs.rmSync(VIDEO_DIR, { recursive: true, force: true }); } catch { /* 无所谓 */ }
// 确认没污染仓库
ok('仓库 data/videos 未被写入',
  !fs.existsSync(path.join(ADMIN, 'server', 'data', 'videos', `${vid}-nowatermark.mp4`)));
ok('仓库是否被建过库文件（不该有）', !fs.existsSync(`${ADMIN}/server/data/media-${TAG}.db`));

console.log(`\n${'─'.repeat(58)}`);
if (fails.length) {
  console.log(`❌ ${pass} 通过 / ${fails.length} 失败`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 全部 ${pass} 项通过`);
console.log(`   mock 上游调用 ${calls.length} 次，全部命中本地 mock（零真实出站）`);
process.exit(0);
