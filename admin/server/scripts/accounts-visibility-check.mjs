/**
 * 只读验证：账号列表接口到底有没有把「登录态」透出给运维看。
 *
 * 背景：登录态（login_state/login_at/login_note）是这次修复新增的字段。
 * 后端 `toRow()` 是 `...r` 全量展开 + 列表用 `SELECT *`，**理论上**应该自动透出，
 * 但"理论上"不值钱 —— 这个脚本直接打真实接口，检查返回体的 key 里有没有它们。
 *
 * 判据：
 *   ① payload 里必须出现 login_state 键（否则运维只能靠 /api/dola/route 的排除原因猜）；
 *   ② 顺便打印每个号的值，确认生产库里 #408-412 的现状（谁被暂停、谁还是 unknown）。
 *
 * 全程只读：只发 GET，不写库、不建任务、不扣积分。
 * 用法: node accounts-visibility-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { signJwt } = await import('../auth.js');

const jwt = signJwt({ uid: 1 }, 1);
const resp = await fetch(`${BASE}/api/dola/accounts?page=1&pageSize=100`, {
  headers: { Authorization: `Bearer ${jwt}` },
});
const body = await resp.json().catch(() => null);

if (!resp.ok || !body?.items) {
  console.log(JSON.stringify({ stage: 'fetch', status: resp.status, body: String(JSON.stringify(body)).slice(0, 300) }, null, 2));
  process.exit(1);
}

const items = body.items;
const keys = Object.keys(items[0] || {});
const has = (k) => keys.includes(k);

// 关注的账号：这次修复涉及的五个
const WATCH = new Set([408, 409, 410, 411, 412, 419, 420]);
const rows = items
  .filter((it) => WATCH.has(Number(it.id)))
  .map((it) => ({
    id: it.id,
    label: it.label,
    status: it.status,
    login_state: it.login_state ?? '(字段缺失)',
    login_at: it.login_at ?? null,
    login_note: String(it.login_note || '').slice(0, 60),
    native_15s: it.native_15s_state ?? null,
  }));

console.log(JSON.stringify({
  stage: 'field-presence',
  totalKeys: keys.length,
  login_state: has('login_state'),
  login_at: has('login_at'),
  login_note: has('login_note'),
  native_15s_state: has('native_15s_state'),
}, null, 2));
console.log(JSON.stringify({ stage: 'watched-accounts', rows }, null, 2));
console.log(JSON.stringify({
  stage: 'verdict',
  operatorCanSeeLoginState: has('login_state') && has('login_note'),
  pass: has('login_state') && has('login_note'),
}, null, 2));
process.exit(0);
