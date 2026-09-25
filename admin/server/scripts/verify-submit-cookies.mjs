/**
 * 验证「提交链路 Cookie」修复（Bug 1），**零消耗**：不开页面、不导航、不提交任务。
 *
 * 只做一件事：用某个账号的真实 cookie 跑一遍 ctx.addCookies()，
 * 并且**同时跑修复前/修复后两种映射做对照**：
 *   - 老写法（一刀切 domain/path）  → 期望**抛错**（证明 bug 真实存在）
 *   - toPlaywrightCookies（新）     → 期望**成功**（证明修复有效）
 *
 * ⚠️ 必须从 ../dola/provider.js 引生产同一份函数，不许在脚本里重写。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ACCOUNT_ID = Number(process.argv[2] || 419);

const { toPlaywrightCookies, parseCookies } = await import('../dola/provider.js');

const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const acc = db.prepare('SELECT id, label, cookie, cookie_names FROM dola_accounts WHERE id=?').get(ACCOUNT_ID);
if (!acc) { console.log(JSON.stringify({ error: 'account not found', id: ACCOUNT_ID })); process.exit(1); }

const cookies = parseCookies(acc.cookie);
const names = Object.keys(cookies);
const reserved = names.filter(n => n.startsWith('__Host-') || n.startsWith('__Secure-'));

const pw = await import('playwright');
const browser = await pw.chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  executablePath: pw.chromium.executablePath(),
});

async function tryCookies(label, list) {
  const ctx = await browser.newContext();
  try {
    await ctx.addCookies(list);
    const inJar = await ctx.cookies();
    const gotReserved = reserved.filter(n => inJar.some(c => c.name === n));
    await ctx.close();
    return { label, ok: true, written: inJar.length, reservedPresent: gotReserved.length };
  } catch (e) {
    await ctx.close().catch(() => {});
    return { label, ok: false, error: String(e.message).split('\n')[0].slice(0, 160) };
  }
}

const legacy = names.map(name => ({ name, value: cookies[name], domain: '.dola.com', path: '/' }));
const fixed = toPlaywrightCookies(cookies);

const before = await tryCookies('legacy(domain/path 一刀切)', legacy);
const after = await tryCookies('toPlaywrightCookies(修复后)', fixed);

console.log(JSON.stringify({
  account: ACCOUNT_ID,
  label: acc.label,
  cookieCount: names.length,
  reservedCount: reserved.length,
  reserved,
  newCookieObjects: fixed.length,
  before,
  after,
  verdict: before.ok === false && after.ok === true
    ? 'OK：修复前抛错、修复后成功 —— Bug 1 已修复'
    : (before.ok && after.ok ? '注意：老写法也没抛错，该账号可能不带保留前缀 cookie（换一个 Google SSO 号再验）'
      : '异常：修复后仍然失败，需要继续排查'),
}, null, 2));

await browser.close().catch(() => {});
process.exit(0);
