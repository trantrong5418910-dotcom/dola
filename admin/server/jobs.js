/**
 * 极简后台任务运行器（进程内，无外部队列）。
 *
 * 用途：几百个 dola 账号的「批量校验」「批量查额度」这类耗时活儿，
 * 不能让 HTTP 请求一直挂着 —— 提交后立刻返回 job_id，前端轮询进度。
 *
 * 设计取舍：
 *   - 单进程单队列，服务重启后 running 的任务会被标记为 interrupted（不假装能续跑）
 *   - 进度每个 item 都落库（SQLite 写入很快，几百条无压力）
 *   - 明细只保留前 N 条，避免 result 字段无限膨胀
 */
import { db } from './db.js';

const HANDLERS = new Map();
const MAX_DETAILS = 300;

/** @param {string} type @param {(item:any, ctx:{job:object, index:number}) => Promise<any>} fn */
export function registerJobHandler(type, fn) {
  HANDLERS.set(type, fn);
}

const now = () => new Date().toISOString();

export function createJob({ type, ids = [], concurrency = 5, userId = null, payload = {} }) {
  if (!HANDLERS.has(type)) throw Object.assign(new Error(`未注册的任务类型：${type}`), { status: 400 });
  const info = db.prepare(`INSERT INTO jobs (type,status,total,done,ok_count,fail_count,concurrency,payload,result,created_by,created_at,updated_at)
                           VALUES (?,?,?,0,0,0,?,?, '{}', ?,?,?)`)
    .run(type, 'queued', ids.length, Math.max(1, Math.min(50, Number(concurrency) || 5)),
      JSON.stringify({ ...payload, ids }), userId, now(), now());
  const id = info.lastInsertRowid;
  setImmediate(() => kick(id));
  return getJob(id);
}

export function getJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!job) return null;
  let payload = {}, result = {};
  try { payload = JSON.parse(job.payload || '{}'); } catch { /* ignore */ }
  try { result = JSON.parse(job.result || '{}'); } catch { /* ignore */ }
  return { ...job, payload, result };
}

export function listJobs({ limit = 20, type = '' } = {}) {
  const w = type ? ' WHERE type = ?' : '';
  const rows = db.prepare(`SELECT id,type,status,total,done,ok_count,fail_count,concurrency,error,payload,created_at,updated_at
                           FROM jobs${w} ORDER BY id DESC LIMIT ?`).all(...(type ? [type] : []), Number(limit));
  return rows.map(({ payload, ...row }) => ({
    ...row,
    automatic: /"autoMaintenance"\s*:\s*true/.test(String(payload || '')),
  }));
}

export function cancelJob(id) {
  const job = getJob(id);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') {
    db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run('cancelled', now(), id);
  }
  return getJob(id);
}

/** 服务启动时调用：把上次进程留下的 running/queued 任务标成中断 */
export function recoverStaleJobs() {
  const n = db.prepare(`UPDATE jobs SET status='failed', error=?, updated_at=?
                        WHERE status IN ('queued','running')`).run('服务重启导致任务中断', now()).changes;
  return n;
}

/** 简单并发池 */
async function pool(items, limit, worker) {
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  }));
}

const running = new Set();

async function kick(jobId) {
  if (running.has(jobId)) return;
  // Only one batch owns the account pool at a time. Each batch still has its own
  // configured worker concurrency; manual and automatic checks cannot race writes.
  if (running.size) return;
  running.add(jobId);
  const job = getJob(jobId);
  if (!job || job.status !== 'queued') {
    running.delete(jobId);
    // The selected job may have been cancelled between scheduling and execution.
    const next = db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (next) setImmediate(() => kick(next.id));
    return;
  }

  const handler = HANDLERS.get(job.type);
  const ids = job.payload.ids || [];
  const details = [];
  let ok = 0, fail = 0;

  db.prepare("UPDATE jobs SET status='running', updated_at=? WHERE id=?").run(now(), jobId);
  console.log(`[job] #${jobId} ${job.type} 开始，${ids.length} 项，并发 ${job.concurrency}`);

  const isCancelled = () => db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId)?.status === 'cancelled';

  try {
    await pool(ids, job.concurrency, async (itemId, index) => {
      if (isCancelled()) return;
      let detail;
      try {
        const r = await handler(itemId, { job: getJob(jobId), index });
        const succeeded = r?.ok !== false;
        if (succeeded) ok++; else fail++;
        detail = { id: itemId, ok: succeeded, message: r?.message ?? '' };
      } catch (e) {
        fail++;
        detail = { id: itemId, ok: false, message: e.message };
      }
      if (details.length < MAX_DETAILS) details.push(detail);
      db.prepare('UPDATE jobs SET done=done+1, ok_count=?, fail_count=?, updated_at=? WHERE id=?')
        .run(ok, fail, now(), jobId);
    });

    const cancelled = isCancelled();
    // 注意：任务状态只反映「任务本身跑没跑完」，不反映业务结果。
    // 例如批量校验 4 个账号全是无效 cookie —— 任务成功了，只是结果都是 invalid。
    // 如果这里按 fail 数判 failed，前端会显示成「任务失败」，非常误导。
    db.prepare('UPDATE jobs SET status=?, ok_count=?, fail_count=?, result=?, updated_at=? WHERE id=?')
      .run(cancelled ? 'cancelled' : 'done',
        ok, fail, JSON.stringify({ details, truncated: details.length >= MAX_DETAILS }), now(), jobId);
    console.log(`[job] #${jobId} 结束：ok=${ok} fail=${fail} 状态=${cancelled ? 'cancelled' : 'done'}`);
  } catch (e) {
    db.prepare('UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?').run('failed', e.message, now(), jobId);
    console.error(`[job] #${jobId} 异常：`, e);
  } finally {
    running.delete(jobId);
    // 队列里还有就接着跑
    const next = db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
    if (next) setImmediate(() => kick(next.id));
  }
}
