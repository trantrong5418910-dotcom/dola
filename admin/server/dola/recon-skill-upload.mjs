/**
 * 侦察：Dola「上传技能(Skill)」的接口与文件格式。
 *
 *   node server/dola/recon-skill-upload.mjs --account-id 154 [--out /tmp/skill-recon]
 *
 * ## 为什么做这个
 * 公众号文章（2026-09-23）指出一条我们没走过的路：在 Dola 里**上传一个 Skill 文件**，
 * 就能在专家模式下用 Seedance 2.5 生成 30 秒（不用技能时专家模式只有 15 秒 / 2.0 Fast）。
 * 这条是 Dola 官方支持的"自定义技能"功能，不是改请求参数那种灰色做法，
 * 跟我们"不注入、不伪造"的工程边界兼容。
 *
 * ## 目标（只读，不烧号）
 *   ① 找到「上传技能」的接口与文件格式
 *   ② 看看已发布/可用的技能长什么样（能不能自己造一个）
 *   ③ 顺带记录专家模式 / 技能入口的 DOM，为后续自动化做准备
 *
 * ## 严守的边界
 *   - **不填提示词、不点发送、不创建任何生成任务**
 *   - 拦截前端自毁登出请求（guardLogoutRequests）
 *   - 不用"点击技能"去触发绑定（早期点击会永久绑定 generic skill，见 composer-bootstrap.js）
 *     只走「技能管理 → 添加 → 上传」这条路径
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACC_ID = Number(flag('account-id', 154));
const OUT = flag('out', '/tmp/skill-recon');

// ⚠️ `const { db } = await import()` 会丢 live binding（拿到导入那一刻的 null）。
//    必须用命名空间访问 m.db —— 这个坑已经栽过两次了。
const m = await import('../db.js');
const { proxyUrlOf } = await import('./proxy.js');
const { parseCookies, getPlaywright, DOLA_HEADERS, guardLogoutRequests, playwrightAvailable } = await import('./provider.js');
const { startSocksBridge } = await import('./socks-bridge.js');

await m.initDb();
const acc = m.db.prepare('SELECT id,label,cookie,proxy,exit_ip FROM dola_accounts WHERE id=?').get(ACC_ID);
if (!acc) { console.error('账号不存在'); process.exit(1); }
if (!(await playwrightAvailable())) { console.error('需要 playwright'); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
console.log(`账号 #${acc.id} ${acc.label}  出口 ${acc.exit_ip || '-'}`);

const proxyUrl = proxyUrlOf(acc);
let bridge = null;
if (proxyUrl && /^socks5?h?:/i.test(proxyUrl)) {
  bridge = await startSocksBridge(proxyUrl);
  console.log(`本地 SOCKS5 桥 ${bridge.url}`);
}

const net = [];
const record = (kind, reqOrRes, body) => {
  try {
    const u = typeof reqOrRes === 'string' ? reqOrRes : reqOrRes.url();
    net.push({
      kind,
      url: String(u).slice(0, 220),
      method: reqOrRes.method ? reqOrRes.method() : undefined,
      status: reqOrRes.status ? reqOrRes.status() : undefined,
      ct: reqOrRes.headers ? (reqOrRes.headers()['content-type'] || '') : '',
      body: body ? String(body).slice(0, 1200) : undefined,
    });
  } catch { /* 忽略 */ }
};

const pw = await getPlaywright();
const browser = await pw.chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 1000 },
  locale: 'zh-CN',
  userAgent: DOLA_HEADERS['user-agent'],
  ...(bridge ? { proxy: { server: bridge.url } } : {}),
});
await ctx.addCookies(Object.entries(parseCookies(acc.cookie)).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);

// 只记录"技能相关"的请求，别的太多噪音
const WANT = /skill|skill_pack|office|ability|composer|expert|mode|plugin|bot/i;
ctx.on('request', (r) => {
  if (!WANT.test(r.url())) return;
  let body;
  try { const pd = r.postData(); if (pd) body = pd; } catch { /* 忽略 */ }
  record('req', r, body);
});
ctx.on('response', async (r) => {
  if (!WANT.test(r.url())) return;
  let body;
  try { body = await r.text(); } catch { /* 忽略 */ }
  record('res', r, body);
});

const page = await ctx.newPage();
let step = 0;
const shot = async (label) => {
  step++;
  const f = path.join(OUT, `${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: f }).catch(() => {});
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`\n── ${step}. ${label} ──`);
  console.log(`   url : ${page.url()}`);
  console.log(`   文本: ${txt.slice(0, 260)}`);
  console.log(`   截图: ${f}`);
  return txt;
};

console.log('\n① 打开 dola /chat/');
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 60000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await shot('chat');

// ② 看看页面上有没有「专家模式」和「技能」入口
console.log('\n② 找「专家模式」与「技能」入口');
const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button,[role="button"],[role="tab"]'))
  .map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim())
  .filter((t) => t && t.length < 24)
  .filter((v, i, a) => a.indexOf(v) === i));
console.log('   可点元素:', JSON.stringify(buttons.slice(0, 40)));

const clickIfPresent = async (names) => {
  for (const n of names) {
    const loc = page.getByRole('button', { name: n, exact: false }).first();
    if (await loc.count().catch(() => 0)) {
      const ok = await loc.click({ timeout: 4000 }).then(() => true).catch(() => false);
      if (ok) { console.log(`   ✅ 点了「${n}」`); await page.waitForTimeout(1800); return true; }
    }
  }
  console.log(`   ⚠️ 没找到: ${names.join(' / ')}`);
  return false;
};

// 技能入口在**侧栏**，是个带快捷键的菜单项（"技能 · 连接器 ⇧⌘S"），
// 不是普通 button，所以 getByRole('button') 找不到 —— 用文本点，再不行用快捷键。
let opened = false;
for (const sel of ['技能 · 连接器', '技能', 'Skills']) {
  const loc = page.getByText(sel, { exact: false }).first();
  if (await loc.count().catch(() => 0)) {
    opened = await loc.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (opened) { console.log(`   ✅ 点了侧栏「${sel}」`); break; }
  }
}
if (!opened) {
  console.log('   ⚠️ 文本点击失败，改用快捷键 ⇧⌘S');
  await page.keyboard.press('Shift+Meta+s').catch(() => {});
}
await page.waitForTimeout(4000);
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await shot('skills-panel');

// 进去之后再试一次管理/上传入口
for (const n of ['技能管理', '管理', '添加', '新建', '上传技能', '上传', '创建技能']) {
  await clickIfPresent([n]);
}
await page.waitForTimeout(2500);
await shot('skill-manage-or-add');

// ③ 技能管理 → 添加 → 上传
console.log('\n③ 找「技能管理 / 添加 / 上传」');
const txt = await page.locator('body').innerText().catch(() => '');
console.log('   页面文本:', txt.replace(/\s+/g, ' ').slice(0, 400));
for (const n of ['技能管理', '管理技能', '添加', '新建', '上传技能', '上传']) {
  await clickIfPresent([n]);
}
await shot('skill-manage');

// 直接在页面里用带 cookie 的 fetch 探已知技能端点 —— 比靠 UI 导航快得多
console.log('\n⑤ 页面内直探技能端点');
const probe = await page.evaluate(async () => {
  const paths = [
    '/alice/office/skills/list_user_and_featured',
    '/samantha/skill/recommend',
    '/samantha/skill/pack',
    '/alice/office/skills/list',
    '/samantha/skill/list',
  ];
  const out = [];
  for (const p of paths) {
    try {
      const r = await fetch(p, { credentials: 'include' });
      const t = await r.text();
      out.push({ path: p, status: r.status, body: t.slice(0, 400) });
    } catch (e) { out.push({ path: p, error: String(e.message) }); }
  }
  return out;
});
for (const p of probe) {
  console.log(`   ${p.path}`);
  console.log(`      ${p.error ? 'ERR ' + p.error : p.status + ' ' + p.body.replace(/\s+/g, ' ').slice(0, 200)}`);
}

// 看看有没有 file input（最关键的信号）
const fileInputs = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=file]'))
  .map((e) => ({ accept: e.getAttribute('accept') || '', name: e.getAttribute('name') || '', id: e.id || '' })));
console.log('\n④ 页面上的 file input:', JSON.stringify(fileInputs));

await browser.close();
await bridge?.close().catch(() => {});
fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify(net, null, 2));
console.log(`\n网络记录 ${net.length} 条 → ${path.join(OUT, 'network.json')}`);
console.log('截图目录:', OUT);
process.exit(0);
