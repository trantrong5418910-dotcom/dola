/**
 * 只读诊断：回答「这个账号在页面上到底有哪些时长档位」。
 *
 * 做法：先用 10 秒（页面上确实存在的档位）把创作条完整打开，
 * 然后手动打开模型菜单 / 时长菜单，把真实选项 dump 出来。
 * 不填提示词、不点发送、不改库。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = Number(process.argv[2] || 419);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DOLA_BASE = process.env.DOLA_BASE || 'https://www.dola.com';

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

const { proxyOf, proxyUrlOf, maskProxy } = await import('../dola/proxy.js');
const { observeVideoComposerBootstrap } = await import('../dola/composer-bootstrap.js');
const { prepareNativeVideoComposer } = await import('../dola/native-capability.js');
const { selectSeedance } = await import('../dola/generation-model.js');
const { NATIVE_DURATION_CONTROL_SELECTOR, DURATION_OPTION_SELECTOR } = await import('../dola/generation-duration.js');
const MODEL_SELECTOR = '[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]';

const cookies = parseJsonCookies(acc.cookie);
const proxy = proxyOf(acc);
const proxyUrl = proxyUrlOf(acc);

const pw = await import('playwright');
const launchOptions = {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  executablePath: pw.chromium.executablePath(),
};
if (proxyUrl) {
  if (/^socks5h?:/i.test(proxyUrl)) {
    const { startSocksBridge } = await import('../dola/socks-bridge.js');
    launchOptions.proxy = { server: (await startSocksBridge(proxyUrl)).url };
  } else if (proxy?.server) {
    launchOptions.proxy = proxy;
  }
}
/**
 * 默认用**生产已预热**的 profile。
 *
 * 为什么不能新建：profile 是冷的时候要走代理拉 ~12MB 的 JS，
 * 30 秒内等不到输入框 → 直接报 VIDEO_PAGE_NOT_READY / VIDEO_ENTRY_NOT_READY，
 * 那是"加载慢"，不是"账号没档位"。用冷 profile 摸底会把两类问题混成一团。
 * 想故意测冷启动：PROFILE_SUFFIX=-scandur
 */
const profileDir = join(ROOT, 'server', 'data', 'browser-profiles',
  `${ACCOUNT_ID}${process.env.PROFILE_SUFFIX ?? ''}`);
await mkdir(profileDir, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profileDir, {
  ...launchOptions,
  serviceWorkers: 'block',
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  timeout: 30000,
});

function toPlaywrightCookies(map) {
  return Object.entries(map || {})
    .filter(([name, value]) => typeof name === 'string' && name && typeof value === 'string')
    .map(([name, value]) => {
      if (name.startsWith('__Host-')) return { name, value, url: `${DOLA_BASE}/`, secure: true };
      if (name.startsWith('__Secure-')) return { name, value, domain: '.dola.com', path: '/', secure: true };
      return { name, value, domain: '.dola.com', path: '/' };
    });
}
await ctx.addCookies(toPlaywrightCookies(cookies));
const page = await ctx.newPage();
observeVideoComposerBootstrap(page);
await ctx.route('**/chat/completion**', r => r.abort());
await ctx.route('**/chat/**', r => (r.request().method() === 'POST' ? r.abort() : r.continue()));
await page.goto(`${DOLA_BASE}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

const out = { account: ACCOUNT_ID, proxy: maskProxy(proxyUrl) };

async function dumpMenu(label) {
  return page.evaluate((args) => {
    const [optSel] = args;
    const vis = el => el.getClientRects().length > 0;
    const optNodes = [...document.querySelectorAll(optSel)].filter(vis);
    const leaves = [...new Set([...document.querySelectorAll('*')]
      .filter(el => vis(el) && el.children.length === 0 && /(\d+\s*(?:秒|s)\b|2\.\d)/i.test(el.textContent || ''))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()))];
    return {
      optionCount: optNodes.length,
      optionTexts: optNodes.map(n => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)),
      leafTexts: leaves.slice(0, 40),
    };
  }, [DURATION_OPTION_SELECTOR]);
}

async function openAndDump(controlSelector, label) {
  const ctrl = page.locator(controlSelector).filter({ visible: true }).first();
  if (!await ctrl.count()) return { label, error: '控件不存在' };
  const before = (await ctrl.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  await ctrl.click({ timeout: 5000 }).catch(e => ({ err: String(e.message).slice(0, 80) }));
  await page.waitForTimeout(1200);
  const popper = await page.evaluate(() => {
    const vis = el => el.getClientRects().length > 0;
    const pops = [...document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="listbox"], [data-state="open"]')].filter(vis);
    const texts = pops.map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200));
    // 把「像个时长选项」的元素真实标签与属性抓出来 —— 决定选择器该怎么写
    const cands = [...document.querySelectorAll('*')]
      .filter(el => vis(el) && /^\d+\s*(?:s|秒)$/i.test((el.textContent || '').trim()))
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        dataSlot: el.getAttribute('data-slot'),
        dataState: el.getAttribute('data-state'),
        cls: String(el.className || '').slice(0, 120),
        text: (el.textContent || '').trim(),
        parentTag: el.parentElement?.tagName,
        parentRole: el.parentElement?.getAttribute('role'),
        parentDataSlot: el.parentElement?.getAttribute('data-slot'),
      }));
    const popHtml = pops.slice(0, 2).map(el => el.outerHTML.slice(0, 900));
    return { texts, cands, popHtml };
  }).catch(e => ({ error: String(e.message).slice(0, 150) }));
  await page.screenshot({ path: `/tmp/dur-${ACCOUNT_ID}-${label}.png` }).catch(() => {});
  const menu = await dumpMenu(label).catch(e => ({ error: String(e.message).slice(0, 120) }));
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  return { label, controlTextBefore: before, popper, ...menu };
}

try {
  await prepareNativeVideoComposer(page, { seconds: 10, timeout: 90000 });
  out.composerOpened = true;
} catch (e) {
  out.composerOpened = false;
  out.composerError = { code: e?.code, reason: e?.reason, message: String(e?.message).slice(0, 200) };
}

// 不管创作条有没有打开成功，都把「页面长什么样」记下来：
// 英文界面的号会因为硬编码中文『视频生成』找不到入口，必须能被看出来。
out.page = await page.evaluate(() => {
  const vis = el => el.getClientRects().length > 0;
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    isEnglish: /New Chat|Search…|Recents|Pinned/i.test(text),
    hasChineseEntry: text.includes('视频生成'),
    buttonTexts: [...new Set([...document.querySelectorAll('button,[role="button"]')]
      .filter(vis).map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 30),
    durationControls: [...document.querySelectorAll('[data-input-engine-actionbar-control-key="video-duration"],[data-input-engine-actionbar-control-key="duration"]')]
      .filter(vis).map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()),
  };
}).catch(e => ({ error: String(e.message).slice(0, 150) }));

// 只要时长控件在，就直接读它的菜单 —— 创作条没打开成功也能拿到档位
const durCtrl = page.locator(NATIVE_DURATION_CONTROL_SELECTOR).filter({ visible: true }).first();
if (await durCtrl.count()) {
  out.durationMenu = await openAndDump(NATIVE_DURATION_CONTROL_SELECTOR, 'duration-direct');
  out.modelControlText = (await page.locator(MODEL_SELECTOR).filter({ visible: true }).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  out.modelMenu = await openAndDump(MODEL_SELECTOR, 'model-menu');
}

console.log(JSON.stringify(out, null, 2));
await ctx.close().catch(() => {});
process.exit(0);
