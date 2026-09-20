/**
 * 端到端验证 dola 生成链路能不能跑通。
 *
 * 相比早期版本的关键改进（踩过）：
 *   ① **提交完立刻关浏览器**，之后只走 IM 接口轮询 ——
 *      早期用 page.reload() 循环等结果，既看不到成片（SPA 重载拿不到新消息），
 *      还把会话搞挂了（每开一次浏览器都像"换设备登录"，风控会踢）。
 *   ② 用 self_brief 判定会话活性（比 config/pull 灵敏：会话死时它是 710012014）。
 *   ③ 成片链接从消息链里扒（`/alice/user/...` 那种 tos 直链），不依赖页面 DOM。
 *
 * 用法：
 *   node server/dola/verify-flow.mjs --cookie-file ./Dola_xxx_Cookies.json              # 只检查会话
 *   node server/dola/verify-flow.mjs --cookie-file ./c.json --submit                   # 真提交并等成片
 *   node server/dola/verify-flow.mjs --cookie-file ./c.json --submit --force 30        # 顺带把时长改成 30
 *   node server/dola/verify-flow.mjs --cookie-file ./c.json --poll <conversationId>     # 只轮询已有会话
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCookies, fetchProfile, fetchSubscription, dolaFetch } from './provider.js';

const execFileP = promisify(execFile);

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const COOKIE_FILE = flag('cookie-file') || process.env.DOLA_COOKIE_FILE;
if (!COOKIE_FILE) { console.error('用法：node server/dola/verify-flow.mjs --cookie-file ./Dola_xxx_Cookies.json [--submit]'); process.exit(2); }
const SUBMIT = has('submit');
const FORCE = flag('force') ? Number(flag('force')) : null;
const POLL_ID = flag('poll');
const PROMPT = flag('prompt', '海边日落，无人机航拍，海浪拍打礁石，暖橙色光芒');
const MAX_MIN = Number(flag('minutes', '15'));
const OUT = process.cwd();

const ck = parseCookies(fs.readFileSync(COOKIE_FILE, 'utf8'));
const acct = path.basename(COOKIE_FILE).replace(/^Dola_/, '').replace(/_Cookies\.json$/, '');
console.log(`══════ 验证对象：${acct}（${Object.keys(ck).length} 个 cookie）══════`);

// ---------------- ① 会话检查 ----------------
const prof = await fetchProfile(ck);
const sub = await fetchSubscription(ck);
console.log(`① 会话：${prof.ok ? '✅ 活动' : `❌ 不可用（code=${prof.code}）`}`);
console.log(`   账号：${prof.nickname || '-'} | entity_id=${prof.entityId || '-'}`);
console.log(`   会员：${sub.subsStatus || '-'}${sub.hasActiveSubscription ? '（有订阅）' : ''} | 地区：${sub.countryCode || '-'}`);
if (!prof.ok) {
  console.log('\n会话不可用，换一个 cookie 再试。');
  process.exit(1);
}

// ---------------- ② 只轮询模式 ----------------
async function pullChain(convId) {
  const r = await dolaFetch('/im/chain/single', {
    cookies: ck,
    body: {
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: convId, anchor_index: 0, conversation_type: 3,
          direction: 1, limit: 50, ext: {}, filter: { index_list: [] },
          evaluate_ab_params: '', evaluate_common_params: '',
        },
      },
      sequence_id: `vf-${Date.now()}`, channel: 2, version: '1',
    },
    query: { region: 'JP', sys_region: 'JP' },
  });
  return r.text || '';
}

/** 从消息链原文里扒成片直链与关键文案 */
function analyze(raw) {
  const text = raw.replace(/\\\//g, '/');
  const vids = [...new Set([...text.matchAll(/https?:\/\/[^"\\\s]{20,240}?(?:\.mp4|video\/tos)[^"\\\s]{0,160}/g)].map((m) => m[0]))];
  const fails = /视频生成失败|生成失败/.test(text);
  const refund = /生成额度未扣除/.test(text);
  const doneMsg = /已为你生成|生成好了|已生成好|请查收/.test(text);
  const quota = text.match(/今日剩余\s*(\d+)\s*个视频生成额度/);
  const cost = text.match(/消耗\s*(\d+)\s*个视频生成额度/);
  return { vids, fails, refund, doneMsg, remaining: quota ? Number(quota[1]) : null, cost: cost ? Number(cost[1]) : null, text };
}

async function pollUntilDone(convId) {
  const deadline = Date.now() + MAX_MIN * 60_000;
  let round = 0;
  while (Date.now() < deadline) {
    round++;
    const raw = await pullChain(convId);
    const a = analyze(raw);
    const el = ((MAX_MIN * 60_000 - (deadline - Date.now())) / 60000).toFixed(1);
    console.log(`   [${el}min] #${round} 直链=${a.vids.length} 失败=${a.fails} 剩余额度=${a.remaining ?? '-'}`);
    if (a.vids.length) return { ok: true, ...a };
    if (a.fails) return { ok: false, failed: true, ...a };
    await new Promise((r) => setTimeout(r, 30000));
  }
  return { ok: false, timeout: true, vids: [] };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(dest, buf);
  return { file: dest, bytes: buf.length };
}

if (POLL_ID) {
  console.log(`\n② 轮询会话 ${POLL_ID} …`);
  const r = await pollUntilDone(POLL_ID);
  if (r.vids.length) {
    const dest = path.join(OUT, `dola-${acct}-${POLL_ID}.mp4`);
    const d = await download(r.vids[0], dest);
    console.log(`\n✅ 成片：${d.file}（${(d.bytes / 1048576).toFixed(2)} MiB）`);
  } else {
    console.log(`\n${r.failed ? '❌ 上游报生成失败' : '⏱ 等待超时'}`);
  }
  process.exit(r.vids.length ? 0 : 1);
}

if (!SUBMIT) {
  console.log('\n（未提交。加 --submit 才真的生成；会消耗该账号的生成额度）');
  process.exit(0);
}

// ---------------- ③ 浏览器提交（只开一次，提交完就关） ----------------
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 950 }, locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

// ★ 拦住 dola 前端在限流时「自己登出自己」的请求。
// 实测：提交撞上限流后前端会调 /passport/web/logout/，把会话销毁 ——
// 每失败一次就烧掉一个账号。这里 abort 掉，限流就只是"这次没成功"。
await ctx.route('**/passport/**/logout**', (r) => r.abort());


// 需要改时长时，在页面里注入 patch（等价于方悦扩展的 world:MAIN content script）
if (FORCE) {
  await ctx.addInitScript((force) => {
    const orig = window.fetch;
    window.fetch = function (input, init = {}) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(url).includes('/chat/completion') && init && typeof init.body === 'string') {
          const p = JSON.parse(init.body);
          const ab = p && p.chat_ability;
          if (ab && Number(ab.ability_type) === 17 && typeof ab.ability_param === 'string') {
            const ap = JSON.parse(ab.ability_param);
            window.__CAP = window.__CAP || [];
            window.__CAP.push({ model: ap.model, before: ap.duration, after: force });
            ap.duration = force;
            ab.ability_param = JSON.stringify(ap);
            init = { ...init, body: JSON.stringify(p) };
          }
        }
      } catch { /* 忽略 */ }
      return orig.call(this, input, init);
    };
  }, FORCE);
}

const page = await ctx.newPage();
console.log('\n② 进 dola 提交生成');
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(800);
await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 6000 }).catch(() => {});
await page.waitForTimeout(6000);

const box = page.locator('textarea, [contenteditable="true"]').first();
await box.click({ timeout: 5000 }).catch(() => {});
await box.fill(PROMPT).catch(async () => page.keyboard.type(PROMPT));
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(15000);

const convMatch = page.url().match(/\/chat\/(\d{10,})/);
const convId = convMatch ? convMatch[1] : null;
const cap = await page.evaluate(() => window.__CAP || null);
const pageText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
const ack = analyze(pageText);

if (FORCE) console.log('   注入 patch 捕获:', JSON.stringify(cap));
console.log('   会话 id:', convId || '(没拿到)');
console.log('   页面回执:', pageText.slice(0, 260));
console.log(`   消耗额度=${ack.cost ?? '-'} 今日剩余=${ack.remaining ?? '-'}`);

// ★ 关键：立刻关掉浏览器，后面只走接口
await browser.close();
console.log('   已关闭浏览器（后续只走 IM 接口轮询，不再频繁开页面）');

if (!convId) { console.log('\n没拿到会话 id，无法继续轮询。'); process.exit(1); }

// ---------------- ④ 接口轮询 ----------------
console.log(`\n③ 轮询成片（最多 ${MAX_MIN} 分钟）…`);
const r = await pollUntilDone(convId);

if (r.vids.length) {
  const dest = path.join(OUT, `dola-${acct}-${convId}.mp4`);
  const d = await download(r.vids[0], dest);
  let probe = '';
  try {
    const { stdout } = await execFileP('ffprobe', ['-v', 'error',
      '-show_entries', 'format=duration,size:stream=codec_name,width,height',
      '-of', 'default=noprint_wrappers=1', d.file]);
    probe = stdout.trim();
  } catch { probe = '(ffprobe 不可用)'; }
  console.log(`\n✅ 链路跑通！`);
  console.log(`   成片：${d.file}`);
  console.log(`   大小：${(d.bytes / 1048576).toFixed(2)} MiB`);
  console.log(`   ffprobe：\n${probe.split('\n').map((l) => '     ' + l).join('\n')}`);
  fs.writeFileSync(path.join(OUT, 'verify-flow-result.json'), JSON.stringify({ acct, convId, prompt: PROMPT, force: FORCE, videoUrl: r.vids[0], file: d.file, bytes: d.bytes, probe, quota: { cost: r.cost, remaining: r.remaining } }, null, 2));
  process.exit(0);
}

console.log(`\n${r.failed ? '❌ 上游报生成失败' : '⏱ 等待超时，直链一直没出现'}`);
if (r.text) console.log('   消息链片段:', r.text.replace(/\\"/g, '"').slice(0, 600));
process.exit(1);
