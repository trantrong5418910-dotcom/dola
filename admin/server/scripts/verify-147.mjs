/**
 * 验证闭环最后一公里：成片真的落盘了 + /v1/videos/:id/content 能给用户拿到片。
 *
 * 只读：不写库、不删文件。token 从本机 DB 现取，不打印。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN = '/www/wwwroot/dola.fei85.cn/admin';
const BASE = 'http://127.0.0.1:8788';
const TASK = Number(process.argv[2] || 147);

const db = new DatabaseSync(join(ADMIN, 'server', 'data', 'admin.db'), { readOnly: true });
const v = db.prepare('SELECT * FROM dola_videos WHERE id=?').get(TASK);
if (!v) { console.log(JSON.stringify({ error: '任务不存在', id: TASK })); process.exit(1); }

console.log('=== ① 归档文件落盘核验 ===');
const p = v.local_path;
if (!p) {
  console.log('  ❌ local_path 为空，说明没有归档');
} else if (!existsSync(p)) {
  console.log(`  ❌ 文件不存在：${p}`);
} else {
  const st = statSync(p);
  console.log(`  ✅ 存在  size=${st.size}  bytes字段=${v.local_bytes}  一致=${st.size === v.local_bytes}`);
  console.log(`     路径 ${p}`);
}

// ffprobe 复核真实时长（我们自己再算一遍，不信库里的记录）
console.log('\n=== ② ffprobe 独立复核时长 ===');
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', p], { encoding: 'utf8' });
  const f = JSON.parse(out).format;
  console.log(`  ffprobe duration=${f.duration}  size=${f.size}`);
  console.log(`  库中 duration_sec=${v.duration_sec}  → 一致=${Math.abs(Number(f.duration) - Number(v.duration_sec)) < 0.05}`);
} catch (e) {
  console.log(`  ffprobe 不可用或失败：${String(e.message).slice(0, 120)}`);
}

console.log('\n=== ③ /v1/videos/:id/content（用户取片口）===');
const tok = db.prepare('SELECT id, value, points FROM tokens ORDER BY id LIMIT 1').get();
const r = await fetch(`${BASE}/v1/videos/${TASK}/content`, {
  headers: { authorization: `Bearer ${tok.value}` },
  redirect: 'manual',
});
console.log(`  HTTP ${r.status}  (期望 302)`);
const loc = r.headers.get('location');
if (loc) {
  const u = new URL(loc);
  console.log(`  Location host=${u.host}  path=${u.pathname.slice(0, 50)}…`);
  console.log(`  带签名参数: ${[...u.searchParams.keys()].slice(0, 6).join(', ')}`);
} else {
  const body = await r.text().catch(() => '');
  console.log(`  无 Location；body=${body.slice(0, 200)}`);
}

console.log('\n=== ④ /v1/videos/:id 状态查询 ===');
const r2 = await fetch(`${BASE}/v1/videos/${TASK}`, { headers: { authorization: `Bearer ${tok.value}` } });
const j2 = await r2.json().catch(() => ({}));
console.log(`  HTTP ${r2.status}`);
console.log(`  status=${j2?.data?.status ?? j2?.status}  duration=${j2?.data?.duration ?? j2?.duration}`);
console.log(`  ${JSON.stringify(j2).slice(0, 500)}`);
