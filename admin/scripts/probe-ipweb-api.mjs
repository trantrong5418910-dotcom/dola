/**
 * IPWeb 开放平台 API 探测。
 *
 *   IPWEB_TOKEN=xxx node scripts/probe-ipweb-api.mjs
 *
 * 目的：用自己的 Token **自己查出**代理凭据（用户编号 / 代理密码 / 余额），
 * 而不是让用户去后台一页页翻。
 *
 * 已知（来自官网示例）：
 *   base   http://user.ipweb.cc/prod-api/v2/
 *   鉴权   header `token: <开放平台Token>`
 *   示例   POST static-residential/countIdleIP  {"country_code":"US","city_name":"New York",...}
 */
const TOKEN = process.env.IPWEB_TOKEN;
if (!TOKEN) { console.error('需要 IPWEB_TOKEN 环境变量'); process.exit(2); }

const BASE = process.env.IPWEB_BASE || 'http://user.ipweb.cc/prod-api/v2/';

const PATHS = [
  // 静态住宅
  'static-residential/countIdleIP', 'static-residential/list', 'static-residential/extract',
  'static-residential/page', 'static-residential/detail',
  // 动态住宅
  'dynamic-residential/extract', 'dynamic-residential/list', 'dynamic-residential/countIdleIP',
  'dynamic-residential/page', 'dynamic-residential/generate', 'dynamic-residential/proxy',
  // 用户 / 账号
  'user/info', 'user/getUserInfo', 'user/balance', 'user/detail', 'user/getInfo',
  'account/info', 'account/balance', 'account/getInfo',
  // 流量
  'traffic/list', 'traffic/balance', 'traffic/used',
  // 地区字典
  'common/country', 'common/area', 'common/city', 'common/countryList',
  // 通用
  'proxy/extract', 'proxy/list', 'proxy/info',
];

async function probe(path, body = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 12000);
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { token: TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, text, j };
  } catch (e) {
    return { status: 0, text: String(e.message), j: null };
  } finally { clearTimeout(timer); }
}

console.log(`base = ${BASE}\n`);
console.log('端点探测（404 = 不存在；其它 = 存在，看返回体）：\n');

const found = [];
for (const p of PATHS) {
  const r = await probe(p);
  if (r.status === 404) { console.log(`  ${p.padEnd(38)} 404`); continue; }
  const brief = (r.text || '').replace(/\s+/g, ' ').slice(0, 180);
  console.log(`  ${p.padEnd(38)} ✅ ${r.status}  ${brief}`);
  found.push({ path: p, ...r });
}

console.log(`\n存在的端点：${found.length} 个`);
if (!found.length) console.log('（一个都没探到 —— 可能 base 不对，或者该 Token 所属产品线没有开放 API）');

// 对存在的端点，把返回体的**字段名**列出来，方便判断哪个含代理凭据
console.log('\n各端点的返回字段：');
for (const f of found) {
  if (!f.j || typeof f.j !== 'object') continue;
  const keys = [];
  (function walk(o, prefix, depth) {
    if (depth > 3 || !o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(Array.isArray(o) ? (o[0] ?? {}) : o)) {
      keys.push(prefix + k);
      if (v && typeof v === 'object') walk(v, `${prefix}${k}.`, depth + 1);
    }
  })(f.j, '', 0);
  console.log(`  ${f.path}: ${keys.slice(0, 24).join(', ')}`);
}
