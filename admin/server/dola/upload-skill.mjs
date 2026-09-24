/**
 * 真上传一个技能文件到指定账号（只读之外的**第一个写操作**）。
 *
 *   node server/dola/upload-skill.mjs --account-id 373 \
 *        --file ../assets/dola-skills/long-video-30s/SKILL.md
 *
 * ## 前置（2026-09-24 侦察所得）
 * - 技能管理页：https://www.dola.com/chat/skills
 * - 右上角「+ 添加」→ 弹层三项：与 Dola 对话创建技能 / 上传技能 / 新建自定义连接器
 * - 点「上传技能」后出现 file input，accept = ".zip,.md"
 *
 * ## 严守的边界
 * - **只上传技能，不填提示词、不点发送、不创建任何生成任务、不消耗生成额度**
 * - 拦截前端自毁登出请求
 * - 复用该账号已绑定的代理（SOCKS5 走本地桥）
 *
 * ## 产出
 * - 截图每一步
 * - network.json：抓到的请求（重点找上传端点）
 * - 最后查一次页面，看技能列表里有没有出现我们上传的那个
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 373));
const FILE = flag('file', path.join(process.cwd(), 'assets/dola-skills/long-video-30s/SKILL.md'));
const OUT = flag('out', '/tmp/skill-upload');

if (!fs.existsSync(FILE)) { console.error(`技能文件不存在: ${FILE}`); process.exit(2); }

const m = await import('../db.js');
const { proxyUrlOf } = await import('./proxy.js');
const { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests } = await import('./provider.js');
const { startSocksBridge } = await import('./socks-bridge.js');

await m.initDb();
const acc = m.db.prepare('SELECT id,label,cookie,proxy,exit_ip FROM dola_accounts WHERE id=?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
console.log(`账号 #${acc.id} ${acc.label}  出口 ${acc.exit_ip || '-'}`);
console.log(`技能文件 ${FILE}（${fs.statSync(FILE).size} 字节）`);

const proxyUrl = proxyUrlOf(acc);
let bridge = null;
if (proxyUrl && /^socks5?h?:/i.test(proxyUrl)) bridge = await startSocksBridge(proxyUrl);

const net = [];
const want = (u) => /skill|upload|office|file|media|space|plugin/i.test(String(u));
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
ctx.on('request', (r) => { if (!want(r.url())) return; let b; try { b = r.postData(); } catch { /* 忽略 */ } net.push({ kind: 'req', method: r.method(), url: r.url(), body: b ? String(b).slice(0, 1000) : undefined }); });
ctx.on('response', async (r) => { if (!want(r.url())) return; let b; try { b = await r.text(); } catch { /* 忽略 */ } net.push({ kind: 'res', status: r.status(), url: r.url(), body: b ? String(b).slice(0, 2000) : undefined }); });

const page = await ctx.newPage();
let step = 0;
const shot = async (label) => {
  step++;
  const f = path.join(OUT, `${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: f }).catch(() => {});
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`\n── ${step}. ${label} ──  ${page.url()}`);
  console.log('   ', txt.slice(0, 320));
  console.log('    截图:', f);
  return txt;
};

console.log('\n① 打开技能管理页');
await page.goto('https://www.dola.com/chat/skills', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector('button, textarea', { timeout: 60000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await shot('skills-page');

console.log('\n② 点「+ 添加」');
await page.getByRole('button', { name: /添加|Add/ }).first().click({ timeout: 6000 }).catch(() => {});
await page.waitForTimeout(2000);
await shot('add-menu');

console.log('\n③ 点「上传技能」');
let clicked = false;
for (const n of ['上传技能', '上传']) {
  const loc = page.getByText(n, { exact: false }).first();
  if (await loc.count().catch(() => 0)) {
    clicked = await loc.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked) { console.log(`   ✅ 点了「${n}」`); break; }
  }
}
if (!clicked) { console.log('   ❌ 没点到上传入口'); await shot('no-upload-entry'); await browser.close(); await bridge?.close().catch(()=>{}); fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify(net, null, 2)); process.exit(1); }
await page.waitForTimeout(2500);
await shot('upload-dialog');

// 关键：把文件喂给 accept 为 .zip,.md 的那个 input
console.log('\n④ 选择技能文件');
const inputs = await page.locator('input[type=file]').all();
console.log('   file input 数:', inputs.length);
let target = null;
for (const inp of inputs) {
  const acc2 = await inp.getAttribute('accept').catch(() => '');
  console.log('    - accept:', JSON.stringify(acc2));
  if (/\.(zip|md)/i.test(String(acc2))) { target = inp; break; }
}
if (!target) { console.log('   ❌ 没找到接受 .zip/.md 的 file input'); await shot('no-file-input'); await browser.close(); await bridge?.close().catch(()=>{}); fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify(net, null, 2)); process.exit(1); }

await target.setInputFiles(FILE).catch((e) => console.log('   setInputFiles 异常:', e.message));
console.log('   ✅ 已提交文件，等待上传…');
await page.waitForTimeout(8000);
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
const after = await shot('after-upload');

console.log('\n⑤ 复查技能列表里有没有我们的技能');
await page.goto('https://www.dola.com/chat/skills', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
const finalTxt = await shot('final-skills');
const hasMine = /long[-_ ]?video|30s|长视频/i.test(finalTxt);
console.log('\n是否在页面上看到我们上传的技能:', hasMine ? '✅ 是' : '❓ 未直接匹配（看截图确认）');

await browser.close();
await bridge?.close().catch(() => {});
fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify(net, null, 2));
console.log(`\n网络记录 ${net.length} 条 → ${path.join(OUT, 'network.json')}`);
process.exit(0);
