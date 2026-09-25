/**
 * 走正规 HTTP 路由提交一次真实生成，并轮询到终态（**不直接改库**，审计留痕）。
 *
 * 为什么用脚本而不是 curl：JWT 要现签（读服务器本机 .jwt-secret），
 * 而且终端状态需要轮询 —— curl 一行做不完，还会把 prompt 塞进 shell 引号里。
 *
 * 用法：
 *   node server/scripts/test-generate.mjs <accountId> [seconds] [prompt] [--write]
 * 无 --write 只做前置校验（账号可选中/额度未确认耗尽），不提交、不扣积分。
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const ADMIN = '/www/wwwroot/dola.fei85.cn/admin';
const BASE = 'http://127.0.0.1:8788';
const ID = Number(process.argv[2] || 420);
const SECONDS = Number(process.argv[3] || 10);
const PROMPT = process.argv[4] || `测试生成（账号 ${ID}，${SECONDS} 秒）`;
const WRITE = process.argv.includes('--write');
const TIMEOUT_MIN = Number(process.env.TIMEOUT_MIN || 12);

const { signJwt } = await import(`${ADMIN}/server/auth.js`);
const H = { authorization: `Bearer ${signJwt({ uid: 1 }, 1)}`, 'content-type': 'application/json' };
const show = (j) => JSON.stringify(j, null, 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = () => new DatabaseSync(join(ADMIN, 'server', 'data', 'admin.db'), { readOnly: true });

// 前置：确认这个号现在真的能被选中（否则提交必然落到别的号上）
let r = await fetch(`${BASE}/api/dola/route?seconds=${SECONDS}`, { headers: H });
let j = await r.json();
const row = (j.ranked || []).find((a) => a.id === ID);
console.log('=== 前置：可选中性 ===');
console.log(row ? show(row) : `❌ #${ID} 不在候选里（ranked=${(j.ranked || []).map((a) => a.id).join(',')}）`);
if (!row) process.exit(1);

if (!WRITE) { console.log('\n(演练模式：不提交。加 --write 才真的生成)'); process.exit(0); }

console.log(`\n=== 提交生成：账号 #${ID}，${SECONDS}s ===`);
r = await fetch(`${BASE}/api/dola/accounts/${ID}/test-generate`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ tokenId: 1, seconds: SECONDS, prompt: PROMPT }),
});
j = await r.json();
console.log(`HTTP ${r.status}  ${show(j)}`);
if (!j.taskId) { console.log('提交失败，中止'); process.exit(1); }
const TASK = Number(j.taskId);

console.log(`\n=== 轮询任务 #${TASK} 到终态（上限 ${TIMEOUT_MIN} 分钟）===`);
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);
const deadline = Date.now() + TIMEOUT_MIN * 60_000;
let last = '';
let finalRow = null;
while (Date.now() < deadline) {
  await sleep(5000);
  const d = db();
  finalRow = d.prepare(`SELECT id,status,stage,seconds,conversation_id,watermarked_url,unwatermarked_url,
      unwatermark_note,duration_sec,bytes,local_path,local_bytes,is_unwatermarked,COALESCE(error,'') AS error,
      created_at,updated_at,finished_at FROM dola_videos WHERE id=?`).get(TASK);
  const jr = d.prepare('SELECT state,evidence,conversation_id,deadline_at FROM dola_submission_journal WHERE task_id=?').get(TASK);
  const line = `[${new Date().toISOString().slice(11, 19)}] status=${finalRow?.status} stage=${String(finalRow?.stage || '').slice(0, 110)} | journal=${jr?.state || '-'}/${jr?.evidence || '-'}`;
  if (line !== last) { console.log(line); last = line; }
  if (TERMINAL.has(finalRow?.status)) break;
}

console.log('\n=== 终态 ===');
console.log(show(finalRow));
const d = db();
console.log('\n=== 退款/扣费流水 ===');
console.log(show(d.prepare("SELECT kind,delta,reason,ref,created_at FROM point_transactions WHERE ref=? ORDER BY id").all(`gen-${TASK}`)));
console.log('\n=== 账号状态 ===');
console.log(show(d.prepare('SELECT id,label,status,fail_score,consecutive_failures,success_count,fail_count,quota_remaining,cooldown_until,last_error FROM dola_accounts WHERE id=?').get(ID)));
console.log('\n=== 未结算提交（应为空）===');
r = await fetch(`${BASE}/api/dola/submissions`, { headers: H });
j = await r.json();
console.log(`total=${j.total}  blockedAccounts=${JSON.stringify(j.blockedAccounts)}`);
