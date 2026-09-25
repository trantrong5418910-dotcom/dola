/** 只读：把 /api/dola/route 的**原始响应体**和 dola_accounts 的真实列名打出来。 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { signJwt } = await import('../auth.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', 'data', 'admin.db'));

const cols = db.prepare("SELECT name FROM pragma_table_info('dola_accounts')").all().map((r) => r.name);
console.log(JSON.stringify({ stage: 'columns', cols }, null, 2));

const jwt = signJwt({ uid: 1 }, 1);
for (const secs of [10, 15]) {
  const r = await fetch(`${BASE}/api/dola/route?seconds=${secs}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const text = await r.text();
  console.log(`\n===== RAW /route?seconds=${secs} (HTTP ${r.status}) =====`);
  console.log(text.slice(0, 4000));
}

// 池子过滤条件复现：谁真正进入评估视野
const pool = db.prepare(`SELECT id,label,status,login_state,
  CASE WHEN proxy IS NULL OR TRIM(proxy)='' THEN 0 ELSE 1 END AS has_proxy,
  cooldown_until, quota_remaining, credits, last_used_at,
  native_15s_state, native_30s_state, reference_image_state
  FROM dola_accounts WHERE status='valid' ORDER BY id`).all();
console.log('\n===== valid 账号（含是否有代理）=====');
console.log(JSON.stringify(pool, null, 2));
process.exit(0);
