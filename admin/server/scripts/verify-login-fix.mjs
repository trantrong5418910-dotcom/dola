/**
 * 端到端验证「登录态修复」是否真的生效（全程**只读**：不建生成任务、不扣积分、不提交提示词）。
 *
 * 验三件事，每一条都对应一个已经踩过的坑：
 *   ① 死代理是否终于说实话 —— reason 应为 VIDEO_NAVIGATION_FAILED，文案里带 net::ERR_*，
 *      而不是继续谎报「未确认已登录的创作页面」。
 *   ② 这条文案会不会被误判成 login/session —— 那就会把一个**可用账号**封掉（实测 #420 就是可用号）。
 *      正确结果是 proxy；而 proxy 没有作用域 → 不建防护。
 *   ③ 走**真实路由** POST /api/dola/accounts/:id/native-15s-probe 之后，
 *      账号的 login_state 必须**保持 unknown** —— 这是"绝不误封"的硬证据。
 *      （反过来，如果哪天 pageLoaded 为真且输入框确实没出现，才应该写 unavailable。）
 *
 * 用法: node verify-login-fix.mjs [id...]   默认 420 408
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DB = join(ROOT, 'server', 'data', 'admin.db');
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const IDS = process.argv.slice(2).map(Number).filter(Boolean);
const TARGETS = IDS.length ? IDS : [420, 408];

const { parseCookies, missingRequired, probeNativeVideoViaBrowser } = await import('../dola/provider.js');
const { proxyOf, proxyUrlOf, maskProxy } = await import('../dola/proxy.js');
const { classifyFailure } = await import('../dola/generation-analytics.js');
const { signJwt } = await import('../auth.js');

const db = new DatabaseSync(DB);
const snap = (id) => db.prepare(`SELECT id,label,status,login_state,login_at,login_note,
  native_15s_state,native_15s_note FROM dola_accounts WHERE id=?`).get(id);

const results = [];
for (const id of TARGETS) {
  const before = snap(id);
  const acc = db.prepare('SELECT * FROM dola_accounts WHERE id=?').get(id);
  console.log(JSON.stringify({ stage: 'input', id, label: acc.label,
    proxySafe: maskProxy(proxyUrlOf(acc)), exitIp: acc.exit_ip,
    loginStateBefore: before?.login_state ?? null,
    missingRequired: before ? missingRequired(parseCookies(acc.cookie)) : null }, null, 2));

  // ── ① 直接调生产探测函数，看它现在怎么描述失败
  let direct = null;
  try {
    direct = await probeNativeVideoViaBrowser(parseCookies(acc.cookie), {
      seconds: 15, proxy: proxyOf(acc), proxyUrl: proxyUrlOf(acc), timeout: 70000, accountId: id,
    });
  } catch (e) {
    direct = { threw: true, message: String(e?.message || e).slice(0, 200) };
  }
  const summary = {
    ok: direct.ok, state: direct.state, reason: direct.reason ?? null,
    pageLoaded: direct.pageLoaded ?? null,
    diagnosticPhase: direct.diagnostic?.phase ?? null,
    error: String(direct.error || direct.message || '').slice(0, 200),
    threw: direct.threw ?? false,
  };
  const classified = summary.error ? classifyFailure(summary.error) : null;
  console.log(JSON.stringify({ stage: 'direct-probe', id, summary,
    classifiedAs: classified?.code ?? null }, null, 2));

  // ── ③ 走真实路由（会写库），再看 login_state 变成了什么
  let routeBody = null, routeStatus = null, routeError = null;
  try {
    const jwt = signJwt({ uid: 1 }, 1);
    const resp = await fetch(`${BASE}/api/dola/accounts/${id}/native-15s-probe`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    routeStatus = resp.status;
    routeBody = await resp.json().catch(() => null);
  } catch (e) { routeError = String(e?.message || e).slice(0, 200); }

  const after = snap(id);
  console.log(JSON.stringify({ stage: 'route-probe', id, routeStatus, routeError,
    routeOk: routeBody?.ok ?? null, routeState: routeBody?.state ?? null,
    routeLoginState: routeBody?.loginState ?? null,
    routeMessage: String(routeBody?.message || '').slice(0, 200),
    loginStateBefore: before?.login_state ?? null,
    loginStateAfter: after?.login_state ?? null,
    noteAfter: String(after?.native_15s_note || '').slice(0, 200) }, null, 2));

  results.push({ id, reason: summary.reason, classifiedAs: classified?.code ?? null,
    loginStateBefore: before?.login_state ?? null, loginStateAfter: after?.login_state ?? null });
}

console.log(JSON.stringify({ stage: 'verdict', results }, null, 2));
const bad = results.filter(r => r.loginStateAfter === 'unavailable' && r.reason === 'VIDEO_NAVIGATION_FAILED');
console.log(JSON.stringify({ stage: 'summary',
  falselyBlocked: bad.map(r => r.id),
  pass: bad.length === 0 }, null, 2));
process.exit(0);
