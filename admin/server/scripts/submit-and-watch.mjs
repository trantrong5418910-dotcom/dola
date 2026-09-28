/**
 * 真跑一条视频：提交 → 盯盘 → 终局校验（**会真实消耗 1 积分 + 账号的 1 条额度**）。
 *
 * 为什么走 stress-test count=1 而不是 test-generate：
 *   test-generate 会 pin 死账号（strictAccount=true，不换号），一旦那个号的代理此刻在抖，
 *   得到的"失败"分不清是链路坏了还是单号坏了。
 *   stress-test 走的是**和公开 API 完全同一条** submitGenerationTask（含选号/换号），
 *   count=1 就是"一条"，既真实又有诊断力。
 *
 * 盯盘直接读库（比猜 API 响应形状稳），终局看三件事：
 *   ① status 终态；② 无水印是否真的拿到；③ 本地归档文件是否落盘且字节数对得上 ——
 *   这才是用户说的"闭环"。
 *
 * 用法: node submit-and-watch.mjs [seconds] [tokenId]
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const SECONDS = Number(process.argv[2]) || 10;
const TOKEN_ID = Number(process.argv[3]) || 551;
const MAX_WAIT_MS = 15 * 60 * 1000;

const { signJwt } = await import('../auth.js');
const { DatabaseSync } = await import('node:sqlite');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const fs = await import('node:fs');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(HERE, '..', 'data', 'admin.db'));

const snap = (id) => db.prepare(`SELECT id,account_id,account_label,status,stage,prompt,seconds,
  watermarked_url,unwatermarked_url,unwatermark_note,duration_sec,bytes,error,
  local_path,local_bytes,is_unwatermarked,owner_prefix,created_at,updated_at,finished_at
  FROM dola_videos WHERE id=?`).get(id);

const log = (o) => console.log(JSON.stringify(o));

// 提示词必须唯一：submitGenerationTask 对同一 token 的相同提示词有冷却，会直接 409
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const prompt = `预热复测 ${stamp} 一只橘猫趴在窗台上晒太阳，毛发细节清晰，浅景深`;

const jwt = signJwt({ uid: 1 }, 1);
log({ stage: 'submit-request', seconds: SECONDS, tokenId: TOKEN_ID, prompt,
  browser: '见 dola_use_browser 设置', at: new Date().toISOString() });

let body = null, httpStatus = null;
try {
  const r = await fetch(`${BASE}/api/dola/stress-test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId: TOKEN_ID, count: 1, seconds: SECONDS, prompt }),
  });
  httpStatus = r.status;
  body = await r.json().catch(() => null);
} catch (e) {
  log({ stage: 'submit-threw', message: String(e?.message || e).slice(0, 300) });
  process.exit(1);
}
log({ stage: 'submit-response', httpStatus, body });

const taskId = Number(body?.results?.[0]?.taskId);
if (!Number.isInteger(taskId) || taskId <= 0) {
  log({ stage: 'verdict', pass: false, reason: '提交阶段就没拿到 taskId，未进入生成',
    submitError: body?.results?.[0]?.error ?? body?.message ?? null });
  process.exit(0);
}
log({ stage: 'task-created', taskId, initial: snap(taskId) });

// ── 盯盘
const started = Date.now();
let last = '';
while (Date.now() - started < MAX_WAIT_MS) {
  await new Promise((r) => setTimeout(r, 10000));
  const row = snap(taskId);
  const line = `${row?.status}/${row?.stage}`;
  if (line !== last) {
    last = line;
    log({ stage: 'progress', taskId, elapsedSec: Math.round((Date.now() - started) / 1000),
      status: row?.status, account: row?.account_id, stageDetail: row?.stage,
      error: row?.error ? String(row.error).slice(0, 160) : null });
  }
  if (row && ['ready', 'failed', 'cancelled'].includes(row.status)) break;
}

// ── 终局校验
const final = snap(taskId);
let archiveOk = null;
if (final?.local_path) {
  try {
    const st = fs.statSync(final.local_path);
    archiveOk = { exists: true, bytes: st.size, matchesLocalBytes: st.size === Number(final.local_bytes),
      readable: st.size > 100000, mtime: st.mtime.toISOString() };
  } catch (e) { archiveOk = { exists: false, error: String(e?.message || e).slice(0, 160) }; }
} else { archiveOk = { exists: false, reason: 'local_path 为空' }; }

log({ stage: 'final-row', taskId, final });
log({ stage: 'archive', archiveOk });
log({ stage: 'verdict', pass: final?.status === 'ready' && Boolean(final?.unwatermarked_url) && archiveOk?.exists === true,
  status: final?.status ?? null,
  hasUnwatermarked: Boolean(final?.unwatermarked_url),
  isUnwatermarked: final?.is_unwatermarked ?? null,
  unwatermarkNote: final?.unwatermark_note ?? null,
  durationSec: final?.duration_sec ?? null });
process.exit(0);
