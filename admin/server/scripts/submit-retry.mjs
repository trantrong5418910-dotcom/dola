/**
 * 有界重试提交 → 拿到 taskId 立刻停手 → 盯到终局。
 *
 * 为什么需要重试：号池代理是**间歇性**的。实测同一账号 15:25 导航 2 秒完成，
 * 15:26 预检的 page.goto 就 60 秒超时。单次失败不足以判定"跑不通"。
 *
 * 三条硬约束（避免把重试变成乱花钱）：
 *   ① 一旦任何一次拿到 taskId，**立即停止提交**，转入只读盯盘；
 *   ② 每次用**唯一提示词**（同一 token 的相同提示词有冷却，会 409）；
 *   ③ 有界：最多 attempts 次，每次间隔 ≥ spacing 秒（账号级 60 秒提交间隔）。
 *
 * 用法: node submit-retry.mjs [seconds] [tokenId] [attempts] [spacingSec]
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const SECONDS = Number(process.argv[2]) || 10;
const TOKEN_ID = Number(process.argv[3]) || 551;
const ATTEMPTS = Number(process.argv[4]) || 3;
const SPACING_MS = (Number(process.argv[5]) || 75) * 1000;
const MAX_WATCH_MS = 20 * 60 * 1000;

const { signJwt } = await import('../auth.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const fs = await import('node:fs');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', 'data', 'admin.db'));
const log = (o) => console.log(JSON.stringify(o));
const snap = (id) => db.prepare(`SELECT id,account_id,account_label,status,stage,prompt,seconds,
  watermarked_url,unwatermarked_url,unwatermark_note,duration_sec,bytes,error,
  local_path,local_bytes,is_unwatermarked,created_at,updated_at,finished_at
  FROM dola_videos WHERE id=?`).get(id);

const jwt = signJwt({ uid: 1 }, 1);
let taskId = null;

for (let attempt = 1; attempt <= ATTEMPTS && taskId === null; attempt++) {
  const stamp = `${Date.now()}`;
  const prompt = `闭环复测 ${stamp} 一只橘猫趴在窗台上晒太阳，毛发细节清晰，浅景深`;
  let body = null, status = null;
  try {
    const r = await fetch(`${BASE}/api/dola/stress-test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: TOKEN_ID, count: 1, seconds: SECONDS, prompt }),
    });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (e) {
    log({ stage: 'attempt-threw', attempt, message: String(e?.message || e).slice(0, 250) });
  }
  const res = body?.results?.[0];
  log({ stage: 'attempt', attempt, httpStatus: status, ok: res?.ok ?? null,
    taskId: res?.taskId ?? null, error: res?.error ? String(res.error).slice(0, 220) : null });
  if (res?.ok && Number(res.taskId) > 0) { taskId = Number(res.taskId); break; }
  if (attempt < ATTEMPTS) {
    log({ stage: 'backoff', attempt, waitSec: SPACING_MS / 1000 });
    await new Promise((r) => setTimeout(r, SPACING_MS));
  }
}

if (taskId === null) {
  log({ stage: 'verdict', pass: false, reason: `${ATTEMPTS} 次提交都没建出任务`,
    chargedPoints: 0, note: '预检失败路径会释放提示词预留且不扣积分' });
  process.exit(0);
}

log({ stage: 'task-created', taskId, initial: snap(taskId) });

const started = Date.now();
let last = '';
while (Date.now() - started < MAX_WATCH_MS) {
  await new Promise((r) => setTimeout(r, 10000));
  const row = snap(taskId);
  const line = `${row?.status}/${row?.stage}`;
  if (line !== last) {
    last = line;
    log({ stage: 'progress', taskId, elapsedSec: Math.round((Date.now() - started) / 1000),
      status: row?.status, account: row?.account_id, stageDetail: row?.stage,
      error: row?.error ? String(row.error).slice(0, 200) : null });
  }
  if (row && ['ready', 'failed', 'cancelled'].includes(row.status)) break;
}

const final = snap(taskId);
let archive = null;
if (final?.local_path) {
  try {
    const st = fs.statSync(final.local_path);
    archive = { exists: true, bytes: st.size, matchesLocalBytes: st.size === Number(final.local_bytes) };
  } catch (e) { archive = { exists: false, error: String(e?.message || e).slice(0, 160) }; }
} else archive = { exists: false, reason: 'local_path 为空' };

log({ stage: 'final-row', taskId, final });
log({ stage: 'archive', archive });
log({ stage: 'verdict', pass: final?.status === 'ready' && Boolean(final?.unwatermarked_url) && archive?.exists === true,
  status: final?.status ?? null, account: final?.account_id ?? null,
  hasUnwatermarked: Boolean(final?.unwatermarked_url), isUnwatermarked: final?.is_unwatermarked ?? null,
  unwatermarkNote: final?.unwatermark_note ?? null, durationSec: final?.duration_sec ?? null,
  archiveBytes: archive?.bytes ?? null });
process.exit(0);
