/**
 * 确认「浏览器的流量真的走了代理」。
 *
 *   node scripts/verify-browser-proxy.mjs --account-id 83
 *
 * 为什么必须验：如果桥跑起来了但浏览器其实没走它，
 * 那"换了 IP 还被限流"就会被误判成"限流是按账号的"，
 * 而真相可能只是"代理没生效"。这种"以为改了其实没改"的误判代价很高。
 *
 * 判据有三条，缺一不可：
 *   ① 桥的隧道数 > 0（浏览器确实连了桥）
 *   ② 浏览器里访问 ipinfo.io 拿到的出口 IP ≠ 本机出口 IP
 *   ③ 出口 IP 的国家是代理配置的国家（KR）
 */
import { initDb, db } from '../server/db.js';
import { parseCookies, getPlaywright, DOLA_HEADERS } from '../server/dola/provider.js';
import { proxyUrlOf } from '../server/dola/proxy.js';
import { startSocksBridge } from '../server/dola/socks-bridge.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 83));
// 期望国家：默认 KR（历史用法）。换成日本/美国的静态 IP 时必须显式传，
// 否则会把正确的 JP 判成失败 —— 这个假阴性我自己踩过。
const EXPECT = String(flag('country', 'KR')).toUpperCase();

await initDb();
const acc = db.prepare('SELECT id,label,cookie,proxy,exit_ip FROM dola_accounts WHERE id=?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
const proxyUrl = proxyUrlOf(acc);
console.log(`账号 #${acc.id} ${acc.label}`);
console.log(`  配置代理: ${proxyUrl ? proxyUrl.replace(/\/\/[^@]+@/, '//***@') : '(无)'}`);
console.log(`  库中记录: ${acc.exit_ip || '(未验证过)'}\n`);

// 先看本机直连的出口 IP 做对照
let directIp = null;
try {
  const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(15000) });
  directIp = (await r.json()).ip;
} catch { /* 忽略 */ }
console.log(`本机直连出口 IP：${directIp || '(取不到)'}`);

if (!proxyUrl) { console.log('\n这个账号没配代理，无从验证。'); process.exit(0); }

const bridge = await startSocksBridge(proxyUrl);
console.log(`本地桥：${bridge.url}`);

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: 'zh-CN',
  userAgent: DOLA_HEADERS['user-agent'],
  proxy: { server: bridge.url },
});
await ctx.addCookies(Object.entries(parseCookies(acc.cookie)).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

const page = await ctx.newPage();
// 在浏览器里直接问出口 IP
await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
let browserIp = null;
let browserCountry = null;
try {
  const body = await page.locator('body').innerText();
  const j = JSON.parse(body);
  browserIp = j.ip; browserCountry = j.country;
} catch (e) { console.log('  浏览器里取 ipinfo 失败:', e.message); }

await browser.close();
await bridge.close();

console.log(`\n浏览器经代理的出口 IP：${browserIp || '(取不到)'}  国家 ${browserCountry || '-'}`);
console.log(`桥的隧道数：${bridge.stats.tunnels}`);
if (bridge.stats.errors.length) console.log(`桥内错误：${bridge.stats.errors.join(' / ')}`);

console.log('\n══════ 结论 ══════');
const usedBridge = bridge.stats.tunnels > 0;
const changed = browserIp && directIp && browserIp !== directIp;
console.log(`① 浏览器走了桥：${usedBridge ? '✅ 是' : '❌ 否 —— 代理根本没生效！'}`);
console.log(`② 出口 IP 变了：${changed ? `✅ 是（${directIp} → ${browserIp}）` : '❌ 否'}`);
console.log(`③ 出口地区符合预期(${EXPECT})：${browserCountry === EXPECT ? '✅ ' + browserCountry : `❌ 实际 ${browserCountry}`}`);
console.log(`   （② 需要能取到本机直连 IP 才可比；取不到时看 ③ 即可）`);
if (usedBridge && (changed || !directIp) && browserCountry === EXPECT) {
  console.log('\n→ 代理链路完全正常。"换了 IP 还被限流"就说明**限流是按账号（或账号+IP）的**，');
  console.log('  不单看 IP —— 那批被限过的号即使换新 IP 也不会立刻恢复，得等窗口过去。');
}
