/**
 * 无水印提取的命令行验证工具。
 *
 * 用法：
 *   # 按会话 id 提取（最常用：先跑通生成，再拿它的 conversationId 来这儿）
 *   node server/dola/unwatermark-check.mjs --conv 38417915133082129 --cookie-file ./c.json
 *
 *   # 只看一个 fallback_api 能不能出无水印链接（手工喂 URL）
 *   node server/dola/unwatermark-check.mjs --fallback "https://.../video/...?..." --cookie-file ./c.json
 *
 *   # 顺带下载到本地
 *   node server/dola/unwatermark-check.mjs --conv <id> --cookie-file ./c.json --download
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies } from './provider.js';
import {
  fetchUnwatermarkedByConversation, extractUnwatermarked,
  resolveUnwatermarkedFromFallbackApi, pullChain,
} from './unwatermark.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const COOKIE_FILE = flag('cookie-file') || process.env.DOLA_COOKIE_FILE;
const CONV = flag('conv') ?? flag('poll');
const FALLBACK = flag('fallback');
const DOWNLOAD = has('download');
const KEEP = has('keep-chain');

if (!COOKIE_FILE || (!CONV && !FALLBACK)) {
  console.error('用法：node server/dola/unwatermark-check.mjs --conv <conversationId> --cookie-file ./Dola_xxx_Cookies.json [--download]');
  process.exit(2);
}

const ck = parseCookies(fs.readFileSync(COOKIE_FILE, 'utf8'));
console.log(`cookie：${path.basename(COOKIE_FILE)}（${Object.keys(ck).length} 个字段）`);

/** 对比"普通直链"和"无水印直链"的参数差异，证明改动确实生效 */
function diffParams(a, b) {
  try {
    const ua = new URL(a); const ub = new URL(b);
    const keys = new Set([...ua.searchParams.keys(), ...ub.searchParams.keys()]);
    const rows = [];
    for (const k of keys) {
      const va = ua.searchParams.get(k); const vb = ub.searchParams.get(k);
      if (va !== vb) rows.push(`      ${k}: ${va ?? '(无)'} → ${vb ?? '(无)'}`);
    }
    return rows.length ? rows : ['      （无参数差异）'];
  } catch { return ['      （URL 解析失败）']; }
}

// ---------------- 模式 A：手工喂一个 fallback_api ----------------
if (FALLBACK) {
  console.log('\n── 解析单个 fallback_api ──');
  console.log('  输入：', FALLBACK.slice(0, 160));
  const r = await resolveUnwatermarkedFromFallbackApi(FALLBACK, { cookies: ck });
  console.log('  结果：', JSON.stringify({ ok: r.ok, reason: r.reason, http: r.http, tokenForm: r.tokenForm, bitrate: r.bitrate }));
  if (r.ok) {
    console.log('  无水印 URL：');
    console.log('   ', r.url.slice(0, 300));
  }
  process.exit(r.ok ? 0 : 1);
}

// ---------------- 模式 B：按会话 id ----------------
console.log(`\n① 拉消息链（conversationId=${CONV}）…`);
const r = await fetchUnwatermarkedByConversation(CONV, ck, { limit: 50 });
console.log(`   HTTP ${r.chainStatus} | 命中 fallback_api ${r.fallbackApis?.length ?? 0} 个`);

if (!r.chainStatus || r.chainStatus !== 200) {
  console.log('   消息链没拉到：', String(r.reason || '').slice(0, 300));
  process.exit(1);
}

console.log('\n② fallback_api 逐个尝试：');
for (const a of r.attempts || []) {
  console.log(`   ${a.ok ? '✅' : '❌'} ${a.api.slice(0, 110)}`);
  console.log(`      → ${a.ok ? 'OK' : (a.reason || 'unknown')}${a.http ? ` (HTTP ${a.http})` : ''}`);
}
if (!r.attempts?.length) console.log('   （响应里没有 fallback_api 字段）');

console.log(`\n③ 提取结果：视频 ${r.videos?.length ?? 0} 个 / 图片 ${r.images?.length ?? 0} 个`);
for (const v of r.videos || []) {
  console.log('\n   🎬 无水印视频：');
  console.log('   ', v.url.slice(0, 300));
  console.log('      token 形态:', v.tokenForm, '| bitrate:', v.bitrate ?? '-');
  console.log('      参数改动（相对原始 fallback_api）：');
  for (const line of diffParams(v.via, v.url)) console.log(line);
}
for (const i of r.images || []) console.log('\n   🖼 原图：', i.url.slice(0, 200));

if (!r.videos?.length) {
  console.log('\n⚠️ 没拿到无水印视频。把响应原文存下来便于排查。');
  const chain = await pullChain(CONV, ck);
  const dump = path.join(process.cwd(), `dola-chain-${CONV}.json`);
  fs.writeFileSync(dump, chain.text || '');
  console.log('   已存:', dump, `(${(chain.text || '').length} 字节)`);
  // 关键词命中情况，快速判断是"没这个字段"还是"字段有但解析失败"
  const t = chain.text || '';
  for (const kw of ['fallback_api', 'logo_type', 'main_url', 'video_list', 'image_ori_raw', 'play_url']) {
    const n = (t.match(new RegExp(kw, 'g')) || []).length;
    console.log(`   关键词 ${kw}: ${n} 次`);
  }
  process.exit(1);
}

// ---------------- 下载 ----------------
if (DOWNLOAD) {
  const dest = path.join(process.cwd(), `unwatermarked-${CONV}.mp4`);
  console.log(`\n④ 下载到 ${dest} …`);
  const res = await fetch(r.videos[0].url, { redirect: 'follow' });
  if (!res.ok) { console.log(`   下载失败 HTTP ${res.status}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`   ✅ ${(buf.length / 1048576).toFixed(2)} MiB`);
  console.log('   注意：要确认是不是真无水印，用 ffprobe 看不出水印，得人工看一眼画面右下角。');
}

if (!KEEP) {
  const tmp = path.join(process.cwd(), `dola-chain-${CONV}.json`);
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}

console.log('\n✅ 无水印提取成功');
