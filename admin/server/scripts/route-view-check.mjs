/**
 * 只读检查：10 秒任务的路由视图里，被确认"未登录"的账号是否真的被排除了。
 * 只 GET /api/dola/route，不建任务、不写库。
 * 用法: node route-view-check.mjs [seconds]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const SECONDS = Number(process.argv[2] || 10);

const { signJwt } = await import('../auth.js');
const jwt = signJwt({ uid: 1 }, 1);

const resp = await fetch(`${BASE}/api/dola/route?seconds=${SECONDS}&limit=10`, {
  headers: { Authorization: `Bearer ${jwt}` },
});
const body = await resp.json();

console.log(JSON.stringify({
  status: resp.status,
  seconds: SECONDS,
  eligibleCount: body.eligible?.length ?? null,
  eligible: (body.eligible || []).map(a => ({ id: a.id, label: a.label, rank: a.rank, quota: a.quotaRemaining, reason: a.reason })),
  excludedCount: body.excluded?.length ?? null,
  excluded: (body.excluded || []).map(a => ({ id: a.id, label: a.label, reason: a.reason })),
}, null, 2));
process.exit(0);
