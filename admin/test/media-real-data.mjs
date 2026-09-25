#!/usr/bin/env node
/**
 * 真实数据端到端验证：拿真实 admin.db 的副本 + 真实归档的 mp4，
 * 在独立端口起一个实例，走完整条「列表 → 换凭证 → 流式下载 → Range」链路。
 *
 * 隔离原则（与冒烟测试同一套）：
 *   1. 只读真实库，操作的是 /tmp 下的副本
 *   2. 真实 videos 目录只做 `cp`，不动原文件
 *   3. 独立端口 8790，不碰用户正在跑的 8788
 *   4. 全程不调用任何「归档/重抓」端点（那会写盘 + 出网）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ADMIN = '/Users/feige/WorkBuddy/新网站/admin';
const REAL_DB = path.join(ADMIN, 'server/data/admin.db');
const REAL_VIDEOS = path.join(ADMIN, 'server/data/videos');
const WORK = '/tmp/media-real';
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const Database = require(path.join(ADMIN, 'node_modules/better-sqlite3'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅', m); };
const bad = (m, d) => { fail++; console.log('  ❌', m, d !== undefined ? `→ ${JSON.stringify(d)}` : ''); };
const is = (m, actual, expect) => (actual === expect ? ok(m) : bad(m, { actual, expect }));

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const dirHash = (dir) => crypto.createHash('md5')
  .update(fs.readdirSync(dir).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`).join('|'))
  .digest('hex');

// ───────────────────────── 0. 备份：改动前记录真实数据的指纹 ─────────────────────────
console.log('\n⑩ 改动前基线');
const beforeDbMd5 = md5(REAL_DB);
const beforeVideosHash = dirHash(REAL_VIDEOS);
const beforeVideosMtimes = fs.readdirSync(REAL_VIDEOS).map((f) => `${f}=${fs.statSync(path.join(REAL_VIDEOS, f)).mtimeMs}`).join(',');
console.log('  真实库 md5 :', beforeDbMd5.slice(0, 16));
console.log('  真实视频目录指纹:', beforeVideosHash.slice(0, 16));
console.log('  真实视频文件数:', fs.readdirSync(REAL_VIDEOS).length);

// ───────────────────────── 1. 造隔离工作区 ─────────────────────────
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'videos'), { recursive: true });
fs.copyFileSync(REAL_DB, path.join(WORK, 'admin.db'));
for (const f of fs.readdirSync(REAL_VIDEOS)) {
  fs.copyFileSync(path.join(REAL_VIDEOS, f), path.join(WORK, 'videos', f));
}

const db = new Database(path.join(WORK, 'admin.db'));
// 把副本里的 local_path 指向副本目录，真实目录就彻底不参与了
const rows = db.prepare(`SELECT id, local_path FROM dola_videos WHERE local_path IS NOT NULL AND local_path <> ''`).all();
for (const r of rows) {
  db.prepare('UPDATE dola_videos SET local_path = ? WHERE id = ?')
    .run(path.join(WORK, 'videos', path.basename(r.local_path)), r.id);
}
db.close();

console.log('\n① 隔离工作区');
console.log('  副本库 :', path.join(WORK, 'admin.db'));
console.log('  副本视频:', db_count(), '个文件,', fs.readdirSync(path.join(WORK, 'videos')).length, '个文件');
function db_count() { const d = new Database(path.join(WORK, 'admin.db'), { readonly: true }); const n = d.prepare(`SELECT COUNT(*) n FROM dola_videos WHERE local_path IS NOT NULL AND local_path <> ''`).get().n; d.close(); return n; }

// 取一个真实的、已归档的无水印成片当主角
const d0 = new Database(path.join(WORK, 'admin.db'), { readonly: true });
const HERO = d0.prepare(`SELECT id, local_path, local_bytes, is_unwatermarked, unwatermarked_url, account_label
                         FROM dola_videos WHERE local_path IS NOT NULL AND local_path <> '' AND is_unwatermarked = 1
                         ORDER BY id DESC LIMIT 1`).get();
const TOTAL = d0.prepare('SELECT COUNT(*) n FROM dola_videos').get().n;
const ARCHIVED = d0.prepare(`SELECT COUNT(*) n FROM dola_videos WHERE local_path IS NOT NULL AND local_path <> ''`).get().n;
const UW = d0.prepare('SELECT COUNT(*) n FROM dola_videos WHERE is_unwatermarked = 1').get().n;
const USER = d0.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
const NOFILE = d0.prepare(`SELECT id FROM dola_videos WHERE (local_path IS NULL OR local_path = '') AND unwatermarked_url IS NOT NULL AND unwatermarked_url <> '' ORDER BY id DESC LIMIT 1`).get();
d0.close();
console.log(`  主角成片: #${HERO.id} (${HERO.account_label}) ${HERO.local_bytes} bytes`);
console.log(`  真实规模: 总 ${TOTAL} 条 / 已归档 ${ARCHIVED} / 无水印 ${UW}`);
console.log(`  用它验证的账号: #${USER.id} ${USER.username}`);

// ───────────────────────── 2. 起独立实例 ─────────────────────────
const authMod = await import(`${ADMIN}/server/auth.js`);
const token = authMod.signJwt({ uid: USER.id, username: USER.username }, 1);

const LOG = '/tmp/media-real-server.log';
fs.writeFileSync(LOG, '');
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ADMIN,
  env: {
    ...process.env,
    PORT: String(PORT),
    ADMIN_DB: path.join(WORK, 'admin.db'),
    MEDIA_VIDEO_DIR: path.join(WORK, 'videos'),
    http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', all_proxy: '',
  },
  stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
});

const H = { Authorization: `Bearer ${token}` };
const req = async (p, init = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, headers: res.headers, body };
};

let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/api/media/stats', { headers: H }); if (r.status) { up = true; break; } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!up) {
  console.log('\n❌ 实例没起来，日志尾部：');
  console.log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-25).join('\n'));
  child.kill();
  process.exit(1);
}
console.log(`\n② 实例已起（${BASE}，独立库 + 独立归档目录）`);

try {
  // ─────────────── 3. 读真实规模 ───────────────
  console.log('\n③ 统计端点（读真实库）');
  const st = await req('/api/media/stats');
  is('stats 200', st.status, 200);
  is('总数与真实库一致', st.body.total, TOTAL);
  is('已归档数与真实库一致', st.body.archived, ARCHIVED);
  is('无水印数与真实库一致', st.body.unwatermarked, UW);
  // ⚠️ 注意：onDisk 是**每条记录**的字段（deliveryState），不是统计端点的字段。
  //    统计端点给的是 diskBytes / archived / withUrlOnly。别在这里凭空造字段。
  is('磁盘实际占用 > 0', st.body.diskBytes > 0, true);
  console.log('    total=%d archived=%d unwatermarked=%d withUrlOnly=%d diskBytes=%s',
    st.body.total, st.body.archived, st.body.unwatermarked, st.body.withUrlOnly, st.body.diskBytes);

  // ─────────────── 4. 列表 ───────────────
  console.log('\n④ 成片库列表');
  // ⚠️ 分页参数是 limit/offset（前端也是这么传的），不是 pageSize
  const lib = await req('/api/media/library?archived=1&limit=200');
  is('library 200', lib.status, 200);
  is('已归档条数与真实库一致', lib.body.items.length, ARCHIVED);
  is('total 字段与条数一致', lib.body.total, ARCHIVED);
  const heroRow = lib.body.items.find((x) => x.id === HERO.id);
  if (!heroRow) bad('列表里能找到主角成片');
  else {
    ok('列表里能找到主角成片');
    is('isUnwatermarked 透传正确', heroRow.isUnwatermarked, true);
    is('onDisk=true（磁盘上真有这个文件）', heroRow.onDisk, true);
    is('downloadable=true', heroRow.downloadable, true);
    is('lost=false', heroRow.lost, false);
    is('带了明文直链', typeof heroRow.unwatermarkedUrl === 'string' && heroRow.unwatermarkedUrl.length > 20, true);
    is('带了几何信息 seconds', typeof heroRow.seconds, 'number');
  }
  is('每条的 onDisk 都应为 true', lib.body.items.filter((x) => x.onDisk).length, ARCHIVED);
  const raw = JSON.stringify(lib.body);
  is('列表不泄露 cookie', /cookie|sessionid|passport|ttwid/i.test(raw), false);
  is('列表不泄露账号 cookie 字段', /"cookie"\s*:/.test(raw), false);

  // 筛选一致性
  const uwOnly = await req('/api/media/library?unwatermarked=1&limit=200');
  is('只看无水印 → 条数等于库里的无水印数', uwOnly.body.items.length, UW);
  is('只看无水印 → total 一致', uwOnly.body.total, UW);
  const missOnly = await req('/api/media/library?archived=0&limit=200');
  is('只看未归档 → 条数 = 总 - 已归档', missOnly.body.items.length, TOTAL - ARCHIVED);
  is('只看未归档 → total = 总 - 已归档', missOnly.body.total, TOTAL - ARCHIVED);
  is('已归档 + 未归档 = 总数', ARCHIVED + missOnly.body.total, TOTAL);
  is('未归档的里面没有一条在磁盘上', missOnly.body.items.filter((x) => x.onDisk).length, 0);

  // ─────────────── 5. 真字节流式下载（本轮核心） ───────────────
  console.log('\n⑤ 真字节下载（55MB 级真实 mp4）');
  const tk = await req(`/api/media/library/${HERO.id}/ticket`, { method: 'POST' });
  is('换凭证 200', tk.status, 200);
  if (tk.status !== 200) throw new Error('换不到凭证，后续无法验证');
  const streamUrl = tk.body.streamUrl.replace(BASE, '');
  const downloadUrl = tk.body.downloadUrl.replace(BASE, '');

  const srcMd5 = md5(HERO.local_path);

  // 5a 全文下载 → md5 必须与源文件完全相同
  const full = await fetch(BASE + downloadUrl);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  is('全文流式下载 200', full.status, 200);
  is('下载字节数 = 库里 local_bytes', fullBuf.length, HERO.local_bytes);
  is('下载字节数 = 磁盘文件大小', fullBuf.length, fs.statSync(HERO.local_path).size);
  is('★ 下载内容的 md5 与源文件逐字节一致', crypto.createHash('md5').update(fullBuf).digest('hex'), srcMd5);
  is('带 X-Video-Unwatermarked: 1', full.headers.get('x-video-unwatermarked'), '1');
  is('带 Content-Disposition 附件头', /attachment/.test(full.headers.get('content-disposition') || ''), true);
  is('文件名带 -nowatermark', /-nowatermark\.mp4/.test(full.headers.get('content-disposition') || ''), true);
  is('带 Accept-Ranges: bytes', full.headers.get('accept-ranges'), 'bytes');

  // 5b Range 请求 → 206 + 正确切片
  console.log('\n⑥ Range（拖进度条）');
  const r1 = await fetch(BASE + streamUrl, { headers: { Range: 'bytes=0-1023' } });
  const r1buf = Buffer.from(await r1.arrayBuffer());
  is('Range 请求 → 206', r1.status, 206);
  is('Content-Length=1024', r1buf.length, 1024);
  is('Content-Range 正确', r1.headers.get('content-range'), `bytes 0-1023/${HERO.local_bytes}`);
  is('★ 前 1024 字节与源文件一致', r1buf.equals(fs.readFileSync(HERO.local_path).subarray(0, 1024)), true);

  // 尾部切片 —— 验证 offset 不是假的
  const off = HERO.local_bytes - 512;
  const r2 = await fetch(BASE + streamUrl, { headers: { Range: `bytes=${off}-` } });
  const r2buf = Buffer.from(await r2.arrayBuffer());
  is('尾部 Range → 206', r2.status, 206);
  is('尾部切片长度 512', r2buf.length, 512);
  is('★ 尾部切片与源文件一致', r2buf.equals(fs.readFileSync(HERO.local_path).subarray(off)), true);

  // 5c 凭证可复用（播放器会连发多个 Range）
  const r3 = await fetch(BASE + streamUrl, { headers: { Range: 'bytes=2048-4095' } });
  is('同一凭证再用一次 → 206（不是一次性）', r3.status, 206);

  // 5d 无凭证 → 拒绝
  const noTk = await fetch(`${BASE}/api/media/stream/not-a-real-ticket`);
  is('假凭证 → 403', noTk.status, 403);

  // ─────────────── 6. 兜底路径 ───────────────
  console.log('\n⑦ 兜底路径（不碰网络）');
  if (NOFILE) {
    const t2 = await req(`/api/media/library/${NOFILE.id}/ticket`, { method: 'POST' });
    is(`#${NOFILE.id} 有直链无文件 → 换凭证 200`, t2.status, 200);
    const s2 = await fetch(BASE + t2.body.streamUrl.replace(BASE, ''));
    is(`#${NOFILE.id} 直接流 → 409（提示可抢存）`, s2.status, 409);
    const b2 = await s2.json();
    is('409 标记 refreshable', b2.refreshable, true);
  } else {
    console.log('  (库里没有「有直链无文件」的样本，跳过)');
  }

  const nope = await req('/api/media/library/999999/ticket', { method: 'POST' });
  is('不存在的任务 → 404', nope.status, 404);

  // ─────────────── 7. 权限 ───────────────
  console.log('\n⑧ 权限');
  const anon = await fetch(BASE + '/api/media/library');
  is('无 token → 401', anon.status, 401);

} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
}

// ───────────────────────── 8. 真实数据未被碰过 ─────────────────────────
console.log('\n⑨ 真实数据完整性');
const afterDbMd5 = md5(REAL_DB);
const afterVideosHash = dirHash(REAL_VIDEOS);
const afterVideosMtimes = fs.readdirSync(REAL_VIDEOS).map((f) => `${f}=${fs.statSync(path.join(REAL_VIDEOS, f)).mtimeMs}`).join(',');
is('★ 真实库 md5 前后一致', afterDbMd5, beforeDbMd5);
is('★ 真实视频目录指纹前后一致', afterVideosHash, beforeVideosHash);
is('★ 真实视频文件 mtime 前后一致', afterVideosMtimes, beforeVideosMtimes);

console.log('\n' + '─'.repeat(58));
if (fail === 0) console.log(`✅ 真实数据端到端：全部 ${pass} 项通过`);
else console.log(`❌ ${fail} 项失败 / ${pass} 项通过`);
console.log(`   （真实库副本 ${TOTAL} 条成片、${ARCHIVED} 个 ${(fs.statSync(HERO.local_path).size / 1048576).toFixed(1)}MB 级真实文件参与验证）`);
process.exit(fail === 0 ? 0 : 1);
