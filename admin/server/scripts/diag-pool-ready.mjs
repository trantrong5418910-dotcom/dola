/** 只读：看现在号池到底还有没有"能接活"的账号（冷却 / 状态 / 额度 / 代理）。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));

const now = Date.now();
const rows = db.prepare(`SELECT id, label, status, credits, quota_remaining, quota_total,
                                cooldown_until, last_used_at, proxy, exit_ip,
                                native_15s_state, native_30s_state
                         FROM dola_accounts ORDER BY id`).all();

const fmt = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return String(v);
  const diffMin = Math.round((t - now) / 60000);
  return { at: v, inMinutes: diffMin, cooling: diffMin > 0 };
};

const list = rows.map(r => ({
  id: r.id,
  label: r.label,
  status: r.status,
  credits: r.credits,
  quota: `${r.quota_remaining ?? '?'}/${r.quota_total ?? '?'}`,
  hasProxy: Boolean(r.proxy && String(r.proxy).length),
  exitIp: r.exit_ip || null,
  cooldown: fmt(r.cooldown_until),
  n15: r.native_15s_state,
  n30: r.native_30s_state,
}));

const usable = list.filter(a => a.status === 'valid' && a.hasProxy && !(a.cooldown?.cooling));

console.log(JSON.stringify({
  now: new Date(now).toISOString(),
  total: list.length,
  usableNow: usable.map(a => a.id),
  usableCount: usable.length,
  cooling: list.filter(a => a.cooldown?.cooling)
    .map(a => ({ id: a.id, minutes: a.cooldown.inMinutes, until: a.cooldown.at })),
  noProxy: list.filter(a => !a.hasProxy).map(a => a.id),
  invalid: list.filter(a => a.status !== 'valid').map(a => ({ id: a.id, status: a.status })),
  accounts: list,
}, null, 2));
process.exit(0);
