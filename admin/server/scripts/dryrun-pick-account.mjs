/**
 * 只读干跑：模拟一次 10 秒提交会怎么选号，逐个给出被跳过的原因。
 * 不建任务、不扣积分、不写任何账号状态；只做一次 self_brief 现场体检（走账号自己的代理）。
 * 用法：node server/scripts/dryrun-pick-account.mjs [seconds]
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchProfile, parseCookies } from '../dola/provider.js';
import { requireGenerationProxy, hasLiveSession } from '../dola/generation-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const db = new DatabaseSync(join(ROOT, 'server', 'data', 'admin.db'));
const SECONDS = Number(process.argv[2] || 10);
const nowIso = new Date().toISOString();

const pool = db.prepare(`SELECT * FROM dola_accounts
  WHERE status='valid' AND (cooldown_until IS NULL OR cooldown_until <= ?)
  ORDER BY COALESCE(last_used_at,'') ASC, id ASC LIMIT 20`).all(nowIso);

const guards = db.prepare('SELECT * FROM dola_generation_guards').all();
const openJournal = db.prepare("SELECT account_id, COUNT(*) AS c FROM dola_submission_journal WHERE state IN ('submitted','pending','unresolved') GROUP BY account_id").all();
const guardOf = (id, sec) => guards.filter((g) => Number(g.account_id) === id
  && (g.seconds == null || Number(g.seconds) === sec)).length;
const unsettledOf = (id) => (openJournal.find((r) => Number(r.account_id) === id) || {}).c || 0;

const out = [];
for (const acc of pool.slice(0, 8)) {
  const row = { id: acc.id, label: acc.label };
  if (!(acc.proxy || '').trim()) { row.skip = 'SQL 层就被排除：proxy 为空'; out.push(row); continue; }
  let proxy;
  try { proxy = requireGenerationProxy(acc.proxy); } catch (e) { row.skip = '代理非法：' + e.message; out.push(row); continue; }
  if (!acc.exit_ip) { row.skip = 'exit_ip 未核验（代理串有，但隔离性未证明）'; out.push(row); continue; }
  const g = guardOf(acc.id, SECONDS);
  if (g) { row.skip = `有 ${g} 条生成守卫（需只读复核）`; out.push(row); continue; }
  const u = unsettledOf(acc.id);
  if (u) { row.skip = `有 ${u} 条上游结果未核对的提交`; out.push(row); continue; }
  try {
    const r = await fetchProfile(parseCookies(acc.cookie), { timeout: 20000, proxy });
    row.probe = { ok: r?.ok === true, code: r?.code ?? null, status: r?.status ?? null, entityId: r?.entityId ?? r?.id ?? null };
    row.live = hasLiveSession(r);
    if (row.live && acc.sec_user_id && String(r.entityId || r.id) !== String(acc.sec_user_id)) {
      row.skip = '现场身份与号池 sec_user_id 不一致';
    } else if (!row.live) {
      row.skip = `现场体检未通过（code=${r?.code ?? '?'}）`;
    } else {
      row.wouldPick = true;
    }
  } catch (e) {
    row.probe = { error: e.message };
    row.skip = '探测异常（基础设施问题，不写状态）：' + e.message;
  }
  out.push(row);
}
console.log(JSON.stringify({ seconds: SECONDS, candidates: out, wouldPick: out.find((r) => r.wouldPick)?.id ?? null }, null, 2));
