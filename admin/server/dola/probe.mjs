#!/usr/bin/env node
/**
 * dola 账号探测：拿一个已登录的 cookie，实测出「登录态怎么判」和「额度在哪个接口」。
 *
 *   node server/dola/probe.mjs "ttwid=...; odin_tt=...; ..."
 *   DOLA_COOKIE="..." node server/dola/probe.mjs
 *   node server/dola/probe.mjs --file ./cookie.txt      # 从文件读（支持各类导出格式）
 *
 * 输出会写一份 dola-probe-report.json 到当前目录，方便回填文档。
 * cookie 在屏幕上会打码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, missingRequired, checkSession, probeCredits, findCreditFields, DOLA_BASE } from './provider.js';

function readCookieInput() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--file');
  if (fi >= 0 && args[fi + 1]) {
    const p = args[fi + 1];
    if (!fs.existsSync(p)) {
      console.error(`读不到文件：${p}`);
      process.exit(2);
    }
    return { raw: fs.readFileSync(p, 'utf8'), from: p };
  }
  const env = process.env.DOLA_COOKIE;
  if (env) return { raw: env, from: 'env DOLA_COOKIE' };
  const inline = args.filter((a) => !a.startsWith('--'))[0];
  if (inline) return { raw: inline, from: '命令行参数' };
  return null;
}

const input = readCookieInput();
if (!input) {
  console.error('用法：\n  node server/dola/probe.mjs "ttwid=...; odin_tt=..."\n  DOLA_COOKIE="..." node server/dola/probe.mjs\n  node server/dola/probe.mjs --file ./cookie.txt');
  process.exit(2);
}

const cookies = parseCookies(input.raw);
const names = Object.keys(cookies);
const mask = (v) => (v.length <= 8 ? '***' : `${v.slice(0, 4)}***${v.slice(-3)}`);

console.log('══════════ dola 账号探测 ══════════');
console.log(`来源：${input.from}`);
console.log(`解析出 ${names.length} 个 cookie：`);
for (const n of names) console.log(`   ${n.padEnd(30)} = ${mask(cookies[n])}`);

const missing = missingRequired(cookies);
if (missing.length) console.log(`\n⚠️  缺少关键 cookie：${missing.join(', ')}（很可能不是完整登录态）`);

const report = { base: DOLA_BASE, cookieNames: names, missingRequired: missing, at: new Date().toISOString() };

// ---------- ① 登录态 ----------
console.log('\n① 校验登录态（POST /alice/user/launch）');
const s = await checkSession(cookies);
console.log(`   launch:  HTTP ${s.launchStatus}  code=${s.launchCode ?? '-'}  ${s.launchMs}ms`);
console.log(`   pull:    code=${s.pullCode ?? '-'}  kind=${s.pullKind}`);
console.log(`   判定：${s.valid ? '✅ 已登录' : '❌ 未登录 / cookie 已失效'}`);
console.log(`   sec_user_id=${JSON.stringify(s.secUid)}  uid=${JSON.stringify(s.uid)}`);
if (s.missing?.length) console.log(`   缺少关键 cookie：${s.missing.join(', ')}`);
report.session = { valid: s.valid, launchStatus: s.launchStatus, launchCode: s.launchCode, pullCode: s.pullCode, pullKind: s.pullKind, secUid: s.secUid, uid: s.uid, missing: s.missing };
// 把 launch 的完整响应也存下来，方便翻字段
report.launchRaw = s.launchRaw;
report.pullRaw = s.pullRaw;

if (!s.loggedIn) {
  console.log('\n   未登录的话后面的额度探测意义不大，但照样跑一遍给你看返回长什么样。');
}

// ---------- ② 全量扫描 launch 响应里的数值字段 ----------
console.log('\n② 扫描 user/launch 响应里所有可疑数值字段');
const hits = findCreditFields(s.json);
if (hits.length) for (const h of hits.slice(0, 40)) console.log(`   ${h.field} = ${h.value}`);
else console.log('   （没扫到带 credit/quota/balance/point/... 字样的数值字段）');
report.launchNumericHits = hits;

// ---------- ③ 额度候选接口 ----------
console.log('\n③ 逐个探测额度候选接口');
const probes = await probeCredits(cookies);
for (const p of probes) {
  console.log(`\n   ${p.path}`);
  console.log(`      HTTP ${p.status}  code=${p.code ?? '-'}  ${p.ms}ms   ${p.note}`);
  if (p.msg) console.log(`      msg: ${String(p.msg).slice(0, 160)}`);
  if (p.numericHits.length) {
    for (const h of p.numericHits.slice(0, 25)) console.log(`      💰 ${h.field} = ${h.value}`);
  } else {
    console.log('      （无可疑额度字段）');
  }
}
report.probes = probes;

// ---------- 落盘 ----------
const out = path.join(process.cwd(), 'dola-probe-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n→ 完整报告（含原始响应）写入 ${out}`);

const totalHits = probes.reduce((n, p) => n + p.numericHits.length, 0) + hits.length;
console.log(`\n══════════ 小结 ══════════`);
console.log(`登录态：${s.valid ? '已登录 ✅' : '未登录 / 失效 ❌'}`);
console.log(`疑似额度字段命中：${totalHits} 个`);
if (totalHits) {
  console.log('把它们对照一下，哪个像「剩余额度」就是我们要的字段 —— 然后回填到 provider.js 的 fetchCredits。');
} else if (s.valid) {
  console.log('已登录但没扫到额度字段：说明额度接口不在候选里，需要再抓一次「打开额度面板」的包补充候选。');
} else {
  console.log('cookie 无效，换一个再试。');
}
