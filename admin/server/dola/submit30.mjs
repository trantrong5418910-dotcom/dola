/**
 * 提交一条 30 秒视频（复刻方悦扩展的手法）。
 *
 * 做法：在页面里注入 fetch patch —— 对 POST /chat/completion，
 * 把 chat_ability.ability_param 里的 duration 强改为 30，并记录改前/改后的值作为证据。
 * 提交后用 IM 接口（比轮询页面可靠）读回结果。
 *
 *   node server/dola/submit30.mjs --file ./cookies.json                     # 只看模型选项，不提交
 *   node server/dola/submit30.mjs --file ./cookies.json --submit --force 30 # 真的提交
 *   node server/dola/submit30.mjs --file ./cookies.json --submit --force 30 --model seedance_v2.5
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCookies, guardLogoutRequests } from './provider.js';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const raw = flag('file') ? fs.readFileSync(flag('file'), 'utf8') : process.env.DOLA_COOKIE;
if (!raw) { console.error('用法：node server/dola/submit30.mjs --file ./cookies.json [--submit --force 30]'); process.exit(2); }

const SUBMIT = has('submit');
const FORCE = Number(flag('force', '30'));
const FORCE_MODEL = flag('model');
const PROMPT = flag('prompt', '海边日落，无人机航拍，海浪拍打礁石，暖橙色光芒');
const OUT = process.cwd();

const { chromium } = await import('playwright');
const ck = parseCookies(raw);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 1560, height: 950 }, locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));
await guardLogoutRequests(ctx);

// ★ 关键：在页面加载前就注入 patch（等价于扩展的 world:MAIN content script）
await ctx.addInitScript(([force, forceModel]) => {
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function patched(input, init = {}) {
      try {
        const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
        if (String(url).includes('/chat/completion') && init && typeof init.body === 'string') {
          const payload = JSON.parse(init.body);
          const ab = payload && payload.chat_ability;
          if (ab && Number(ab.ability_type) === 17 && typeof ab.ability_param === 'string') {
            const ap = JSON.parse(ab.ability_param);
            window.__CAP = window.__CAP || [];
            const rec = { model: ap.model, durationBefore: ap.duration };
            if (forceModel) ap.model = forceModel;
            ap.duration = force;
            rec.durationAfter = ap.duration;
            rec.modelAfter = ap.model;
            ab.ability_param = JSON.stringify(ap);
            window.__CAP.push(rec);
            init = { ...init, body: JSON.stringify(payload) };
          }
        }
      } catch (e) { window.__CAPERR = String(e && e.message || e); }
      return origFetch.call(this, input, init);
    };
  }
  // XHR 也挂上
  try {
    const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (String(this.__u || '').includes('/chat/completion') && typeof body === 'string') {
          const payload = JSON.parse(body);
          const ab = payload && payload.chat_ability;
          if (ab && Number(ab.ability_type) === 17 && typeof ab.ability_param === 'string') {
            const ap = JSON.parse(ab.ability_param);
            window.__CAP = window.__CAP || [];
            window.__CAP.push({ model: ap.model, durationBefore: ap.duration, via: 'xhr' });
            if (forceModel) ap.model = forceModel;
            ap.duration = force;
            ab.ability_param = JSON.stringify(ap);
            body = JSON.stringify(payload);
          }
        }
      } catch (e) { window.__CAPERR = String(e && e.message || e); }
      return oSend.call(this, body);
    };
  } catch { /* ignore */ }
}, [FORCE, FORCE_MODEL]);

console.log(`→ 打开 /chat/（patch 已注入：只改 ability_type=17 的 duration → ${FORCE}${FORCE_MODEL ? `，model → ${FORCE_MODEL}` : ''}）`);
const page = await ctx.newPage();
await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(11000);
await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(800);

console.log('→ 进入「视频生成」');
await page.getByRole('button', { name: '视频生成' }).first().click({ timeout: 6000 }).catch((e) => console.log('   点击失败:', e.message.slice(0, 60)));
await page.waitForTimeout(7000);
await page.screenshot({ path: path.join(OUT, 'submit30-01-toolbar.png') });

const toolbar = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log('   工具栏文字:', toolbar.slice(0, 300));

if (!SUBMIT) {
  console.log('\n（未提交。加 --submit 才真的生成）');
  await browser.close();
  process.exit(1 === 2 ? 0 : 0);
}

console.log(`→ 输入提示词并提交：${PROMPT}`);
const box = page.locator('textarea, [contenteditable="true"]').first();
await box.click({ timeout: 5000 }).catch(() => {});
await box.fill(PROMPT).catch(async () => page.keyboard.type(PROMPT));
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(18000);
await page.screenshot({ path: path.join(OUT, 'submit30-02-submitted.png'), fullPage: false });

const cap = await page.evaluate(() => ({ cap: window.__CAP || null, err: window.__CAPERR || null }));
console.log('\n=== patch 捕获到的请求改写 ===');
console.log('  ', JSON.stringify(cap));

const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
const url = page.url();
console.log('\n=== 当前会话 ===', url);
console.log('=== 页面文字 ===\n', text.slice(0, 1200));

fs.writeFileSync(path.join(OUT, 'submit30-result.json'), JSON.stringify({ at: new Date().toISOString(), prompt: PROMPT, force: FORCE, forceModel: FORCE_MODEL, patchCapture: cap, finalUrl: url, pageText: text.slice(0, 4000) }, null, 2));
console.log('\n→ 写入 submit30-result.json');
await browser.close();
