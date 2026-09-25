/**
 * 生成前**只读**预检：一条视频提交前必须弄清楚的六件事。
 * 只发 GET / 只读查询，不建任务、不扣积分、不动 cookie。
 *
 *   ① 调度器此刻会选谁（GET /api/dola/route）——排除原因比"能不能"更重要；
 *   ② 号池每个号的真实状态（status / login_state / 额度 / 冷却 / 代理 / credits）；
 *   ③ 有没有可用的用户令牌（只打印 id 与长度，**不打印令牌值**）；
 *   ④ 全局生成开关与并发（operations/limits）；
 *   ⑤ 上一批任务的落点（最近 8 条 dola_videos 的 status/stage/error）；
 *   ⑥ 队列里有没有历史残留（避免把"旧任务"误当本次结果）。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { signJwt } = await import('../auth.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', 'data', 'admin.db'));

// ── ① 调度器视角
const jwt = signJwt({ uid: 1 }, 1);
for (const secs of [10, 15]) {
  const r = await fetch(`${BASE}/api/dola/route?seconds=${secs}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const b = await r.json().catch(() => null);
  console.log(JSON.stringify({
    stage: `route-${secs}s`, httpStatus: r.status, ok: b?.ok ?? null,
    eligibleCount: (b?.eligible || []).length,
    eligible: (b?.eligible || []).map((x) => ({ id: x.id, label: x.label })),
    excluded: (b?.excluded || []).map((x) => ({ id: x.id, label: x.label, reason: x.reason })),
  }, null, 2));
}

// ── ② 号池
const pool = db.prepare(`SELECT id,label,status,login_state,quota_remaining,credits,
  cooldown_until, CASE WHEN proxy IS NULL OR proxy='' THEN 0 ELSE 1 END AS has_proxy,
  last_used_at, native_10s_state, native_15s_state
  FROM dola_accounts WHERE id BETWEEN 405 AND 425 ORDER BY id DESC`).all();
console.log(JSON.stringify({ stage: 'pool', pool }, null, 2));

// ── ③ 令牌（只给 id / 长度 / 前缀，不外泄值）
const tokens = db.prepare('SELECT id,value,note,created_at FROM tokens ORDER BY id').all()
  .map((t) => ({ id: t.id, note: t.note ?? null, valueLen: String(t.value || '').length,
    valueTypeHint: /^ey[A-Za-z0-9]/.test(String(t.value || '')) ? 'jwt形' : '网关令牌形',
    created_at: t.created_at ?? null }));
console.log(JSON.stringify({ stage: 'tokens', count: tokens.length, tokens }, null, 2));

// ── ④ 全局开关
const limits = db.prepare("SELECT key,value FROM settings WHERE key LIKE '%dola%' OR key LIKE '%generat%' OR key LIKE '%limit%'").all();
console.log(JSON.stringify({ stage: 'settings', limits }, null, 2));

// ── ⑤⑥ 最近任务与队列
const recent = db.prepare(`SELECT id,account_id,status,stage,seconds,substr(COALESCE(error,''),1,120) AS error,
  created_at,finished_at FROM dola_videos ORDER BY id DESC LIMIT 8`).all();
console.log(JSON.stringify({ stage: 'recent-videos', recent }, null, 2));
const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM dola_videos GROUP BY status').all();
console.log(JSON.stringify({ stage: 'video-status-counts', byStatus }, null, 2));
process.exit(0);
