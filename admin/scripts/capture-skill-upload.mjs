#!/usr/bin/env node
/**
 * capture-skill-upload.mjs — 抓 Dola「上传技能」的接口与文件格式
 *
 * 用法（在 Mac 上，admin 目录下执行）：
 *   node scripts/capture-skill-upload.mjs --account 3
 *
 * 原理：
 *   ① 从 admin.db 只读取出该账号的 cookie + 代理；
 *   ② 用 headed Chromium 打开 dola.com（带账号代理，会话与后台共用链路）；
 *   ③ 非侵入式监听所有网络请求，把「URL 含 skill」或「multipart 上传」
 *      的请求/响应记到 JSONL 日志里（自动脱敏：不记 cookie/鉴权头）；
 *   ④ 你在打开的浏览器里手动走：专家模式 → 技能 → 技能管理 → 上传技能文件；
 *      上传完回终端按回车，脚本输出日志文件路径，把它发回来解析即可。
 *
 * 注意：
 *   - 只读库、不落库、不提交任何生成任务、不消耗额度（上传技能本身也不消耗）。
 *   - 上传时随便选个文件即可：即使格式不对，接口返回的校验报错本身
 *     就会暴露它期望的文件格式——这正是我们要抓的东西。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { getPlaywright, parseCookies, guardLogoutRequests, DOLA_HEADERS } from '../server/dola/provider.js';
import { proxyOf } from '../server/dola/proxy.js';
import { startSocksBridge } from '../server/dola/socks-bridge.js';
import { requireGenerationProxy } from '../server/dola/generation-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = path.resolve(HERE, '..');
const DB_PATH = process.env.ADMIN_DB || path.join(ADMIN_ROOT, 'server', 'data', 'admin.db');

const args = process.argv.slice(2);
const accountId = (() => {
  const i = args.indexOf('--account');
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  if (!Number.isInteger(v) || v <= 0) {
    console.error('用法: node scripts/capture-skill-upload.mjs --account <账号id>');
    process.exit(2);
  }
  return v;
})();

// ---------- 1. 只读读账号 ----------
async function loadAccount(id) {
  let db;
  try {
    const mod = await import('better-sqlite3');
    db = new (mod.default ?? mod)(DB_PATH, { readonly: true });
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  }
  try {
    const row = db.prepare('SELECT id, label, cookie, proxy, status FROM dola_accounts WHERE id = ?').get(id);
    return row || null;
  } finally {
    db.close();
  }
}

// ---------- 2. 脱敏与 multipart 解析 ----------
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie']);
function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = String(v).slice(0, 500);
  }
  return out;
}
function parseMultipartFields(buffer) {
  const fields = [];
  const text = buffer.toString('latin1');
  const re = /name="([^"]+)"(?:;\s*filename="([^"]*)")?/g;
  let m;
  while ((m = re.exec(text)) && fields.length < 50) {
    fields.push(m[2] !== undefined ? { name: m[1], filename: m[2] } : { name: m[1] });
  }
  return fields;
}
const PREVIEW_BYTES = 8192;

// ---------- 3. 主流程 ----------
const account = await loadAccount(accountId);
if (!account) {
  console.error(`账号 #${accountId} 不存在`);
  process.exit(1);
}
if (!account.cookie) {
  console.error(`账号 #${accountId} 没有 cookie`);
  process.exit(1);
}
console.log(`账号 #${account.id}（${account.label || '无备注'}，状态 ${account.status}），代理 ${account.proxy ? '已配' : '未配'}`);

const proxyUrl = requireGenerationProxy(account.proxy || '');
const ck = parseCookies(account.cookie);

const pw = await getPlaywright();
if (!pw?.chromium) throw new Error('playwright 未安装：npm i playwright && npx playwright install chromium');

let bridge = null;
let browser = null;
try {
  let launchProxy;
  const scheme = (() => { try { return new URL(proxyUrl).protocol; } catch { return ''; } })();
  if (/^socks5?h?:$/.test(scheme)) {
    bridge = await startSocksBridge(proxyUrl);
    launchProxy = { server: bridge.url };
    console.log(`已架本地 SOCKS5 桥 ${bridge.url}`);
  } else {
    launchProxy = proxyOf(proxyUrl);
  }
  if (!launchProxy?.server) throw new Error('generation_proxy_required：该账号没有配置代理，拒绝直连');

  browser = await pw.chromium.launch({
    headless: false, // 有头：需要你手动点上传流程
    executablePath: pw.chromium.executablePath(),
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: launchProxy,
  });
  const ctx = await browser.newContext({
    userAgent: DOLA_HEADERS['user-agent'],
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });
  await guardLogoutRequests(ctx);
  await ctx.addCookies(Object.entries(ck).map(([name, value]) => ({ name, value, domain: '.dola.com', path: '/' })));

  // ---------- 流量记录 ----------
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(HERE, `skill-upload-capture-acc${accountId}-${ts}.jsonl`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const rec = (obj) => logStream.write(JSON.stringify(obj) + '\n');
  let skillHits = 0;
  let uploadHits = 0;

  const interesting = (url, method, headers) => {
    if (/skill/i.test(url)) return 'skill-url';
    const ct = String(headers?.['content-type'] || '');
    if ((method === 'POST' || method === 'PUT') && /multipart\/form-data/i.test(ct)) return 'multipart-upload';
    return null;
  };

  const attachPage = (page) => {
    page.on('request', (req) => {
      const kind = interesting(req.url(), req.method(), req.headers());
      if (!kind) return;
      let bodyInfo = null;
      try {
        const buf = req.postDataBuffer();
        if (buf) {
          bodyInfo = {
            bytes: buf.length,
            fields: /multipart/i.test(String(req.headers()['content-type'] || '')) ? parseMultipartFields(buf) : undefined,
            preview: buf.slice(0, PREVIEW_BYTES).toString('utf-8').replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, ''),
          };
        }
      } catch { /* ignore */ }
      if (kind === 'skill-url') skillHits++; else uploadHits++;
      rec({ t: 'request', kind, ts: Date.now(), url: req.url(), method: req.method(), headers: sanitizeHeaders(req.headers()), body: bodyInfo });
      process.stdout.write(`\r已捕获: skill相关 ${skillHits} | 上传 ${uploadHits}`);
    });
    page.on('response', async (res) => {
      const req = res.request();
      const kind = interesting(req.url(), req.method(), req.headers());
      if (!kind) return;
      let bodyPreview = '';
      try {
        const text = await res.text().catch(() => '');
        bodyPreview = String(text).slice(0, 5000);
      } catch { /* ignore */ }
      rec({ t: 'response', kind, ts: Date.now(), url: res.url(), status: res.status(), headers: sanitizeHeaders(res.headers()), bodyPreview });
    });
  };
  ctx.on('page', attachPage);

  const page = await ctx.newPage();
  attachPage(page);
  console.log('正在打开 dola.com/chat/ …');
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const hasComposer = await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 30000 }).then(() => true).catch(() => false);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  if (hasComposer) {
    console.log('\n✅ 已登录（创作页输入框出现），流量记录已开始。');
  } else {
    console.log('\n⚠️ cookie 似乎失效，输入框没出现。');
    console.log('   你可以在打开的浏览器窗口里手动登录 Dola，登录好后回终端继续。');
    await ask('手动登录完成后按回车继续…');
  }

  console.log('\n请在浏览器里手动操作：');
  console.log('  1) 进专家模式 → 技能 → 技能管理');
  console.log('  2) 点「上传技能」，随便选一个文件上传（格式不对也没关系，报错信息正是我们要的）');
  console.log('  3) 上传完成后，回到终端按回车结束。\n');
  await ask('上传完成后按回车结束抓包…');
  rl.close();

  await new Promise((r) => logStream.end(r));
  console.log(`\n抓包结束。日志已写入：\n${logPath}`);
  console.log(`共记录 skill 相关请求 ${skillHits} 个，上传请求 ${uploadHits} 个。`);
  console.log('把这个 .jsonl 文件发回来即可解析。');
} finally {
  await browser?.close().catch(() => {});
  await bridge?.close?.().catch(() => {});
}
