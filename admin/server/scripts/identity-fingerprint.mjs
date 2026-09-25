/**
 * 服务端身份指纹：对 dola_accounts 里的身份字段做全值 sha256，只输出哈希前缀。
 * 与本地 /tmp/identity-fingerprint.mjs 用同一套字段和同一套哈希方式，两边才能比对。
 * 严格只读：不写库、不改文件、不打印原值。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIELDS = ['flow_cur_user_sec_id', 'oauth_token', 'uid_tt', 'sessionid', 'flow_user_country'];

const { parseCookies } = await import('../dola/provider.js');

const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const rows = db.prepare('SELECT id, label, sec_user_id, cookie FROM dola_accounts ORDER BY id').all();

const h = (s) => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);

for (const r of rows) {
  const cookies = parseCookies(r.cookie);
  const out = { id: r.id, label: r.label, sec_user_id: r.sec_user_id ?? null };
  for (const f of FIELDS) {
    const v = cookies[f];
    out[f] = f === 'flow_user_country' ? (v ?? null)
      : (v == null ? null : `len=${String(v).length} sha=${h(v)}`);
  }
  console.log(JSON.stringify(out));
}
