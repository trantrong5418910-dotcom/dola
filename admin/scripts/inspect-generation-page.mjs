/** Browser diagnostic with a tested read-only RPC/SDK allowlist. Generation,
 * unknown writes, Service Workers and outgoing WebSockets are blocked.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPlaywright, parseCookies, DOLA_HEADERS } from '../server/dola/provider.js';
import { proxyOf } from '../server/dola/proxy.js';
import { startSocksBridge } from '../server/dola/socks-bridge.js';
import { prepareNativeVideoComposer } from '../server/dola/native-capability.js';
import { observeVideoComposerBootstrap } from '../server/dola/composer-bootstrap.js';
import { fillAndSubmitVideoPrompt } from '../server/dola/generation-submit.js';
import { isNativeVideoRequest } from '../server/dola/generation-policy.js';
import { READONLY_CONTEXT_OPTIONS, installReadonlyNetwork } from '../server/dola/readonly-network.js';
import { createGenerationWireGate } from '../server/dola/generation-wire.js';
const id = Number(process.argv[2]);
if (!Number.isSafeInteger(id) || id < 1) throw Error('Expected account id');
const db = new Database(fileURLToPath(new URL('../server/data/admin.db', import.meta.url)), { readonly: true });
const a = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
if (!a || a.status !== 'valid' || !a.proxy || (a.cooldown_until && a.cooldown_until > new Date().toISOString())) throw Error('Ineligible');
if (db.prepare("SELECT 1 FROM dola_videos WHERE account_id=? AND status IN ('queued','submitting','generating','resolving')").get(id)) throw Error('Busy');
db.close();
const start = Date.now();
const bridge = /^socks5h?:/.test(a.proxy) ? await startSocksBridge(a.proxy) : null;
const pw = await getPlaywright();
const browser = await pw.chromium.launch({ headless: true, executablePath: pw.chromium.executablePath(), proxy: bridge ? { server: bridge.url } : proxyOf(a) });
try {
  const ctx = await browser.newContext({ ...READONLY_CONTEXT_OPTIONS, locale: 'zh-CN', viewport: { width: 1280, height: 900 }, userAgent: DOLA_HEADERS['user-agent'] });
  const blocked = [];
  // Evaluate production decisions on intercepted traffic, but NEVER forward it.
  const wireGate = createGenerationWireGate({ seconds: 10, isActive: () => true, sessionVerified: () => true });
  await installReadonlyNetwork(ctx, { repairWebSocketMock: process.argv.includes('--repair-ws-mock'), onBlocked: req => {
      const url = new URL(req.url());
      if (blocked.length > 50) return;
      blocked.push({ host: url.hostname, path: url.pathname, method: req.method(), ...(url.pathname.includes('/chat/completion')
        ? { matches10s: isNativeVideoRequest(req.postData(), 10, 'seedance_v2.5'),
          dryRunDecision: wireGate.inspect(req).action, wire: wireGate.snapshot() } : {}) });
  }});
  await ctx.addCookies(Object.entries(parseCookies(a.cookie)).map(([name,value]) => ({ name,value,domain: '.dola.com',path:'/' })));
  const page = await ctx.newPage();
  observeVideoComposerBootstrap(page);
  const configReady = page.waitForResponse(res => new URL(res.url()).pathname === '/alice/slot/action_bar_v3/get_item_conf', { timeout: 45000 })
    .then(async res => {
      const body = await res.json();
      return { ms: Date.now() - start, status: res.status(), code: body.code,
        itemCount: Object.keys(body.data?.item_list || {}).length };
    }).catch(() => ({ failed: true }));
  const failures = [];
  page.on('pageerror', error => failures.push({ kind: 'pageerror', message: String(error.message)
    .replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[long-value]').slice(0, 500) }));
  const responses = [];
  const recent = [];
  page.on('response', async res => {
    const url = new URL(res.url());
    if (res.status() >= 400 && failures.length < 30) failures.push({ kind: 'http', host: url.hostname,
      path: url.pathname.slice(-180), status: res.status(), resource: res.request().resourceType() });
    if (url.hostname.endsWith('dola.com') && ['xhr', 'fetch'].includes(res.request().resourceType())) {
      responses.push({ ms: Date.now() - start, path: url.pathname, status: res.status() });
    }
    if (url.hostname.endsWith('.dola.com') && url.pathname === '/im/chain/recent_conv') {
      const body = await res.json().catch(() => null);
      if (body) {
        const sections = [];
        function describe(v, path = '', depth = 0) {
          if (!v || typeof v !== 'object' || depth > 4 || sections.length > 50) return;
          sections.push({ path, ...(Array.isArray(v) ? { count: v.length } : { keys: Object.keys(v).slice(0, 20) }) });
          for (const [k, child] of Object.entries(v)) describe(child, `${path}/${k}`, depth + 1);
        }
        describe(body.downlink_body);
        const chain = body.downlink_body?.pull_recent_conv_chain_downlink_body;
        recent.push({ status: res.status(), statusCode: body.status_code, sections,
          hasMore: chain?.has_more, conversationMessages: chain?.cells?.map(cell => ({
            messages: cell.conversation?.messages?.length, updatedAt: cell.conversation?.update_time,
          })) });
      }
    }
  });
  await page.addInitScript(() => {
    const states = []; let prev = '';
    window.__composerReadiness = states;
    const observer = new MutationObserver(() => {
      const entries = [...document.querySelectorAll('[data-component-type="skill-item"]')]
        .filter(e => e.textContent?.trim() === '视频生成')
        .map(e => Object.fromEntries([...e.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])));
      const controls = [...document.querySelectorAll('[data-input-engine-actionbar-control-key]')]
        .map(e => ({ key: e.getAttribute('data-input-engine-actionbar-control-key'), text: e.textContent?.slice(0, 100) }));
      const state = JSON.stringify({ entries, controls });
      if (state !== prev && states.length < 30) { prev = state; states.push({ ms: Math.round(performance.now()), ...JSON.parse(state) }); }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true });
  });
  page.on('requestfailed', req => {
    const url = new URL(req.url());
    if (failures.length < 30 && (['script', 'stylesheet'].includes(req.resourceType()) || /sdk|\.wasm|captcha/i.test(url.pathname))) {
      failures.push({ host: url.hostname, path: url.pathname.slice(-180), error: req.failure()?.errorText });
    }
  });
  await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const log = message => console.log(JSON.stringify({elapsedMs:Date.now()-start,message}));
  if (process.argv.includes('--wait-config')) log({ config: await configReady });
  if (process.argv.includes('--settled')) await page.waitForTimeout(20000);
  log({ entries: await page.getByRole('button', {name:'视频生成', exact:true}).evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, loading: n.getAttribute('data-loading'), disabled: n.getAttribute('data-disabled') }))) });
  let capability = null;
  try { capability = await prepareNativeVideoComposer(page, { seconds: 10, timeout: process.argv.includes('--bounded-slow') ? 90000 : 30000, log }); log(capability); }
  catch(e) { log({ error: e.message, code: e.code, reason: e.reason }); }
  if (process.argv.includes('--observe-late')) {
    await page.waitForTimeout(20000);
    log('diagnostic-only: observed an additional 20s without clicking again');
  }
  if (process.argv.includes('--inspect-input') && capability?.model === 'seedance_v2.5' && capability?.seconds === 10) {
    const inputs = page.locator('textarea, [contenteditable="true"]');
    log({ inputs: await inputs.evaluateAll(nodes => nodes.map(n => ({ tag: n.tagName, role: n.getAttribute('role'),
      placeholder: n.getAttribute('placeholder'), contenteditable: n.getAttribute('contenteditable'), visible: !!n.getClientRects().length }))) });
    const input = inputs.first();
    await input.fill('只读输入检查，不提交');
    await page.waitForTimeout(1000);
    log({ sendControls: await page.locator('button, [role="button"]').evaluateAll(nodes => nodes
      .filter(n => n.getClientRects().length).map(n => ({ text: n.textContent?.slice(0, 50), type: n.getAttribute('type'),
        aria: n.getAttribute('aria-label'), disabled: n.hasAttribute('disabled'), attrs: Object.fromEntries(
          [...n.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])) })).slice(-25)), recent });
    if (process.argv.includes('--markup')) log({ sendMarkup: await page.locator('button').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length)
      .slice(-2).map(n => ({ html: n.outerHTML.slice(0, 5000), parent: n.parentElement?.tagName, parentClass: n.parentElement?.className, parentId: n.parentElement?.id }))) });
    if (process.argv.includes('--simulate-enter')) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      log({ blockedAfterEnter: blocked, remainingText: (await input.innerText()).trim(), path: new URL(page.url()).pathname });
    }
    if (process.argv.includes('--simulate-click')) {
      await fillAndSubmitVideoPrompt(page, '只读输入检查，不提交');
      await page.waitForTimeout(15000);
      log({ blockedAfterClick: blocked, path: new URL(page.url()).pathname });
    }
  }
  if (process.argv.includes('--inspect-input') && !capability) log('input/send simulation skipped: composer preflight did not pass');
  const controls = await page.evaluate(() => [...document.querySelectorAll('[data-input-engine-actionbar-control-key], [role="menuitem"], button')]
    .filter(e => e.getClientRects().length && (e.hasAttribute('data-input-engine-actionbar-control-key') || /视频生成|Seedance|模型/.test(e.textContent)))
    .map(e => ({ key:e.getAttribute('data-input-engine-actionbar-control-key'),role:e.getAttribute('role'),text:e.textContent?.slice(0,100) })));
  log({controls, path: new URL(page.url()).pathname});
  log({ failures, responses, readiness: await page.evaluate(() => window.__composerReadiness) });
  const output = new URL('../../output/playwright/', import.meta.url);
  await fs.mkdir(output, { recursive: true });
  const file = new URL(`production-probe-${id}-${Date.now()}.png`, output);
  await page.screenshot({path:decodeURIComponent(file.pathname)}); log({screenshot:decodeURIComponent(file.pathname)});
} finally { await browser.close(); await bridge?.close(); }
