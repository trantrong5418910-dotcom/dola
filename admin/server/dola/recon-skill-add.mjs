/**
 * 侦察 v3：专攻技能管理页的「+ 添加」按钮 —— 看上传技能的入口和格式。
 *
 *   node server/dola/recon-skill-add.mjs --account-id 154 [--out /tmp/skill-add]
 *
 * 只读侦察：只点「+ 添加」看弹层，**不上传任何文件、不创建技能、不发消息**。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 154));
const OUT = flag('out', '/tmp/skill-add');

const m = await import('../db.js');
const { proxyUrlOf } = await import('./proxy.js');
const { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests } = await import('./provider.js');
const { startSocksBridge } = await import('./socks-bridge.js');

await m.initDb();
const acc = m.db.prepare('SELECT id,label,cookie,proxy,exit_ip FROM dola_accounts WHERE id=?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
console.log(`账号 #${acc.id} ${acc.label}  出口 ${acc.exit_ip || '-'}`);

const proxyUrl = proxyUrlOf(acc);
let bridge = null;
if (proxyUrl && /^socks5?h?:/i.test(proxyUrl)) bridge = await startSocksBridge(proxyUrl);

const net = [];
const want = (u) => /office|skill|upload|file|upload_file|media|space/i.test(String(u));
const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 1000 },
  locale: 'zh-CN',
  userAgent: DOLA_HEADERS['user-agent'],
  ...(bridge ? { proxy: { server: bridge.url } } : {}),
});
await ctx.addCookies(Object.entries(parseCookies(acc.cookie)).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);
ctx.on('request', (r) => { if (!want(r.url())) return; let b; try { b = r.postData(); } catch { /* 忽略 */ } net.push({ kind: 'req', method: r.method(), url: r.url(), body: b ? String(b).slice(0, 800) : undefined }); });
ctx.on('response', async (r) => { if (!want(r.url())) return; let b; try { b = await r.text(); } catch { /* 忽略 */ } net.push({ kind: 'res', status: r.status(), url: r.url(), body: b ? String(b).slice(0, 1500) : undefined }); });

const page = await ctx.newPage();
let step = 0;
const shot = async (label) => {
  step++;
  const f = path.join(OUT, `${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: f }).catch(() => {});
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`\n── ${step}. ${label} ──  ${page.url()}`);
  console.log('   ', txt.slice(0, 300));
  console.log('    截图:', f);
  return txt;
};

// 直接进技能管理页（URL 已知，不用再点侧栏）
await page.goto('https://www.dola.com/chat/skills', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector('textarea, [contenteditable="true"], button', { timeout: 60000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
await shot('skills-page');

// 点右上角「+ 添加」
console.log('\n→ 点「添加」');
const addBtn = page.getByRole('button', { name: /添加|Add/ }).first();
const cnt = await addBtn.count().catch(() => 0);
console.log('   找到按钮数:', cnt);
if (!cnt) {
  // 兜底：找带 + 的元素
  await page.getByText('添加', { exact: false }).first().click({ timeout: 5000 }).catch(() => {});
} else {
  await addBtn.click({ timeout: 5000 }).catch(() => {});
}
await page.waitForTimeout(2500);
const t2 = await shot('after-add');

// 把弹层里的可点元素全列出来 —— 上传入口应该在这里
const items = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],[role="button"],[role="dialog"] button, li'))
  .map((e) => (e.innerText || '').trim().replace(/\s+/g, ' '))
  .filter((t) => t && t.length < 60)
  .filter((v, i, a) => a.indexOf(v) === i));
console.log('\n弹层可点元素:', JSON.stringify(items.slice(0, 40)));

// 有没有出现 file input（上传最直接的信号）
const fi = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=file]'))
  .map((e) => ({ accept: e.getAttribute('accept') || '', multiple: e.hasAttribute('multiple') })));
console.log('file input:', JSON.stringify(fi));

// 如果弹层里有「上传技能」，点它（只点，不上传文件）
for (const n of ['上传技能', '上传', '从文件导入', '导入', '本地']) {
  const loc = page.getByText(n, { exact: false }).first();
  if (await loc.count().catch(() => 0)) {
    const ok = await loc.click({ timeout: 4000 }).then(() => true).catch(() => false);
    if (ok) {
      console.log(`   ✅ 点了「${n}」`);
      await page.waitForTimeout(2000);
      break;
    }
  }
}
await shot('after-upload-click');
const fi2 = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=file]'))
  .map((e) => ({ accept: e.getAttribute('accept') || '', multiple: e.hasAttribute('multiple') })));
console.log('file input（点上传后）:', JSON.stringify(fi2));

await browser.close();
await bridge?.close().catch(() => {});
fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify(net, null, 2));
console.log(`\n网络记录 ${net.length} 条 → ${path.join(OUT, 'network.json')}`);
process.exit(0);
