/**
 * 把一条**已经生成好的** dola 会话补录进任务表，并解析无水印直链。
 *
 *   node server/dola/import-conv.mjs --conv 38417915133082129 --cookie-file ./Dola_xxx_Cookies.json
 *   node server/dola/import-conv.mjs --conv <id> --cookie-file ./c.json --owner-token dv_xxx --dry-run
 *
 * 两个真实用途：
 *   ① **补录**：任务是在浏览器里手工生成的 / 生成成功但后台记录丢了 / 服务重启把
 *      跑一半的任务标成 failed 了 —— 会话还在 dola 上，重新登记一下就能继续用。
 *   ② **不花额度地验证链路**：生成要消耗账号额度，但"读会话 → 解析无水印 → 落库 →
 *      工作台取回"这条链路可以拿任何历史会话反复验证，成本为零。
 *
 * --owner-token 指定归属令牌，工作台那边才能看到（不指定则是后台内部记录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb, db } from '../db.js';
import { parseCookies } from './provider.js';
import { pullChain, extractUnwatermarked } from './unwatermark.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const CONV = flag('conv') ?? flag('conversation-id');
const COOKIE_FILE = flag('cookie-file') || process.env.DOLA_COOKIE_FILE;
const OWNER = flag('owner-token');
const DRY = has('dry-run');
const PROMPT = flag('prompt', '(补录：原始提示词未知)');
/** 已经下载好的成片：直接登记为本地归档，不必再联网 */
const LOCAL_FILE = flag('local-file');
/** 手工指定无水印直链（用于会话读不出来但链接还有效的情况） */
const UW_URL = flag('unwatermarked-url');
/**
 * 这个成片本身是不是无水印的。
 * 默认按文件名推断（归档时我们命名成 `xxx-nowatermark.mp4`），
 * 也可以用 `--unwatermarked` / `--watermarked` 显式指定。
 */
const IS_UW = has('unwatermarked') ? 1
  : (has('watermarked') ? 0
    : (LOCAL_FILE && /nowatermark|unwatermarked|无水印/i.test(LOCAL_FILE) ? 1 : 0));

// 两种模式：① 从会话读（要 cookie）② 直接登记本地文件（不用 cookie）
if (!LOCAL_FILE && (!CONV || !COOKIE_FILE)) {
  console.error([
    '用法：',
    '  ① 从会话读（要 cookie）：',
    '     node server/dola/import-conv.mjs --conv <conversationId> --cookie-file ./Dola_xxx_Cookies.json [--owner-token dv_xxx] [--dry-run]',
    '  ② 直接登记本地文件（不用 cookie）：',
    '     node server/dola/import-conv.mjs --local-file ./x.mp4 [--conversation-id <id>] [--unwatermarked-url <url>] [--owner-token dv_xxx]',
  ].join('\n'));
  process.exit(2);
}

await initDb();
const ck = COOKIE_FILE ? parseCookies(fs.readFileSync(COOKIE_FILE, 'utf8')) : {};
const acctName = COOKIE_FILE
  ? path.basename(COOKIE_FILE).replace(/^Dola_/, '').replace(/_Cookies\.json$/, '')
  : '(本地文件)';
const now = () => new Date().toISOString();

// 归属令牌（可选）
let owner = null;
if (OWNER) {
  owner = db.prepare('SELECT id, prefix FROM tokens WHERE value = ?').get(OWNER);
  if (!owner) { console.error(`找不到令牌 ${OWNER.slice(0, 12)}…`); process.exit(1); }
}

// 认一下账号（按 account_hint / label 匹配，认不出就留空）
const acc = COOKIE_FILE
  ? (db.prepare("SELECT id, label FROM dola_accounts WHERE label = ? OR account_hint LIKE ? ORDER BY id LIMIT 1")
    .get(acctName, `%${acctName}%`) ?? null)
  : null;

console.log(`补录 ${CONV ? `会话 ${CONV}` : '本地文件'}`);
console.log(`  cookie：${acctName}${acc ? ` → 账号 #${acc.id}（${acc.label}）` : '（账号池里认不出，记为未知账号）'}`);
console.log(`  归属：${owner ? `令牌 #${owner.id}（${owner.prefix}）` : '（无，只做后台记录）'}`);

// ---------- 模式 B：只有本地文件，不联网 ----------
if (!CONV || LOCAL_FILE) {
  if (!LOCAL_FILE) { console.error('既没有 --conv 也没有 --local-file'); process.exit(2); }
  const abs = path.resolve(LOCAL_FILE);
  let st; try { st = await fs.promises.stat(abs); } catch { console.error(`本地文件不存在：${abs}`); process.exit(1); }
  const note = `补录自本地文件（${IS_UW ? '无水印' : '带水印'}）`;
  if (DRY) { console.log(`\n--dry-run：会登记 ${abs}（${st.size} 字节，is_unwatermarked=${IS_UW}）`); process.exit(0); }
  const info = db.prepare(`INSERT INTO dola_videos
    (account_id, account_label, conversation_id, prompt, ratio, seconds, status, stage,
     watermarked_url, unwatermarked_url, unwatermark_note, local_path, local_bytes, is_unwatermarked,
     owner_token_id, owner_prefix, charge_ref, created_at, updated_at, finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      acc?.id ?? null, acc?.label ?? acctName, CONV ? String(CONV) : null, PROMPT, '16:9', 10,
      'ready', '补录（本地归档）',
      null, UW_URL ?? null, note, abs, st.size, IS_UW,
      owner?.id ?? null, owner?.prefix ?? '', '', now(), now(), now(),
    );
  console.log(`\n✅ 已补录为任务 #${info.lastInsertRowid}（本地归档 ${(st.size / 1048576).toFixed(2)} MiB，无水印=${IS_UW ? '是' : '否'}）`);
  process.exit(0);
}

// ① 拉消息链
console.log('\n① 拉消息链 …');
const chain = await pullChain(CONV, ck, { limit: 50 });
console.log(`   HTTP ${chain.status} | ${(chain.text || '').length} 字节`);
if (!chain.json) { console.error('   拉不到（cookie 失效？会话 id 写错？）', String(chain.text).slice(0, 200)); process.exit(1); }

// ② 带水印直链（从原文正则扒）
const text = String(chain.text).replace(/\\\//g, '/');
const vids = [...new Set([...text.matchAll(/https?:\/\/[^"\\\s]{20,240}?(?:\.mp4|video\/tos)[^"\\\s]{0,160}/g)].map((m) => m[0]))];
console.log(`\n② 找到带水印直链 ${vids.length} 条`);
if (vids[0]) console.log('   ', vids[0].slice(0, 160));

// ③ 解析无水印
console.log('\n③ 解析无水印版本 …');
const uw = await extractUnwatermarked(chain.json, chain.text, { cookies: ck });
for (const a of uw.attempts || []) {
  console.log(`   ${a.ok ? '✅' : '❌'} ${a.api.slice(0, 100)} → ${a.ok ? 'OK' : a.reason}`);
}
if (!uw.attempts?.length) console.log('   （消息链里没有 fallback_api）');

const uwUrl = uw.videos?.[0]?.url || null;
const note = uwUrl
  ? `补录自会话 ${CONV}（无水印解析成功，${uw.videos[0].tokenForm}）`
  : `补录自会话 ${CONV}（未解析到无水印源）`;
console.log(`\n   ${uwUrl ? '✅ 无水印：' + uwUrl.slice(0, 150) : '❌ 没拿到无水印版本'}`);

if (DRY) {
  console.log('\n--dry-run：不写库。');
  process.exit(uwUrl ? 0 : 1);
}

// ④ 落库
const info = db.prepare(`INSERT INTO dola_videos
  (account_id, account_label, conversation_id, prompt, ratio, seconds, status, stage,
   watermarked_url, unwatermarked_url, unwatermark_note, is_unwatermarked,
   owner_token_id, owner_prefix, charge_ref, created_at, updated_at, finished_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(
    acc?.id ?? null, acc?.label ?? acctName, String(CONV), PROMPT, '16:9', 10,
    'ready', '补录（已完成）',
    vids[0] ?? null, uwUrl, note, uwUrl ? 1 : 0,
    owner?.id ?? null, owner?.prefix ?? '',
    '', now(), now(), now(),
  );

console.log(`\n✅ 已补录为任务 #${info.lastInsertRowid}`);
console.log(`   工作台查看：GET /api/gateway/gen/${info.lastInsertRowid}?token=<令牌>`);
if (owner) console.log(`   该令牌登录工作台后即可在任务列表里看到并能下载。`);
