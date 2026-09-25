/**
 * 只读诊断：判断「页面没出现创作输入框」到底是**匿名态**还是**代理/网络根本没能打开页面**。
 *
 * 为什么要先做这个实验再动手改：
 *   生产探测里 page.goto(...).catch(()=>{}) 把导航异常**吞掉了**（provider.js:749），
 *   于是「代理由死」和「账号匿名」会抛出**完全同一句**「未确认已登录的创作页面」。
 *   如果我直接拿这句话去做「账号级封禁」，就会把好号也封掉 ——
 *   本人已经踩过一次同类坑（探测脚本自己撒谎，把好账号判成坏账号）。
 *
 * 做法：直接调用**生产同一个探测函数** probeNativeVideoViaBrowser（只读，不建任务、不扣额度、
 *   不写数据库 —— 写库的是上层 route，这里不走 route），把 result 连同 diagnostic 打出来。
 * 对照：一个已经证明能出片的号（#420，当前代理会话可能已失效）vs 一个疑似匿名的号（#408）。
 *
 * 用法: node anon-signal-probe.mjs <accountId> [seconds]
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = Number(process.argv[2] || 420);
const SECONDS = Number(process.argv[3] || 15);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function parseCookies(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}
function parseJsonCookies(raw) {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return v;
  } catch { /* fall through */ }
  return parseCookies(raw);
}

const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(ACCOUNT_ID);
if (!acc) { console.log(JSON.stringify({ error: 'account not found', id: ACCOUNT_ID })); process.exit(1); }

// 复用生产同一份 cookie 解析与代理解析，绝不自己另写一份（否则脚本自身会制造假结论）
const { parseCookies: prodParseCookies, missingRequired } = await import('../dola/provider.js');
const { proxyOf, proxyUrlOf, maskProxy } = await import('../dola/proxy.js');
const { probeNativeVideoViaBrowser } = await import('../dola/provider.js');

const cookies = prodParseCookies(acc.cookie);
const proxyUrl = proxyUrlOf(acc);
const input = {
  account: ACCOUNT_ID, label: acc.label, seconds: SECONDS,
  cookieCount: Object.keys(cookies).length,
  missingRequired: missingRequired(cookies),
  hasProxy: Boolean(proxyUrl), proxySafe: maskProxy(proxyUrl),
  status: acc.status, exitIp: acc.exit_ip,
  native15: { state: acc.native_15s_state, at: acc.native_15s_at, note: acc.native_15s_note || null },
};
console.log(JSON.stringify({ stage: 'input', ...input }, null, 2));

let result;
try {
  result = await probeNativeVideoViaBrowser(cookies, {
    seconds: SECONDS,
    proxy: proxyOf(acc),
    proxyUrl,
    timeout: 60000,
    accountId: ACCOUNT_ID,
  });
} catch (e) {
  result = { threw: true, name: e?.name, code: e?.code, message: String(e?.message || e).slice(0, 300) };
}

// 只留判定需要的字段，别把可能含敏感信息的诊断整包打出来
const summary = result && typeof result === 'object' ? {
  ok: result.ok, state: result.state, reason: result.reason ?? null,
  error: result.error ?? null,
  seconds: result.seconds ?? null, uiSeconds: result.uiSeconds ?? null,
  model: result.model ?? null, native: result.native ?? null,
  rewriteCarrier: result.rewriteCarrier ?? null,
  diagnostic: result.diagnostic ?? null,
  threw: result.threw ?? false, message: result.message ?? null,
} : result;

console.log(JSON.stringify({ stage: 'result', account: ACCOUNT_ID, result: summary }, null, 2));
console.log(JSON.stringify({
  stage: 'verdict',
  account: ACCOUNT_ID,
  pageLikelyLoaded: summary?.diagnostic ? summary.diagnostic.phase !== 'navigate' || summary.diagnostic.network.failedRequests === 0 : null,
  diagnosticPhase: summary?.diagnostic?.phase ?? null,
  failedRequests: summary?.diagnostic?.network?.failedRequests ?? null,
  httpErrors: summary?.diagnostic?.network?.httpErrors ?? null,
  composerReady: summary?.ok === true,
  messageSaysLoginNotConfirmed: /未确认已登录/.test(String(summary?.error || '')),
}, null, 2));
process.exit(0);
