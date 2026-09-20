/**
 * 清理浏览器 profile 缓存（会占磁盘，需要定期维护）。
 *
 *   # 先看占了多少（只读，不动任何文件）
 *   node scripts/clean-profiles.mjs
 *
 *   # 删掉 30 天没用过的
 *   node scripts/clean-profiles.mjs --older-than 30 --apply
 *
 *   # 全清（下次生成会重新冷启动，多花约 12MB 流量/账号）
 *   node scripts/clean-profiles.mjs --all --apply
 *
 * ── 为什么要清理 ──
 * 每个账号一个 Chromium profile，用来缓存 dola 的 JS 包：
 * **冷启动一次约 12 MB 代理流量，热启动只要约 0.4 MB**（实测 1/34）。
 * 代价是每个 profile 约 20 MB 磁盘。1000 个号就是 ~20 GB，不清会撑爆盘。
 *
 * ── 注意 ──
 * 删 profile 只是丢缓存，**不影响登录态**（cookie 是每次从库里注入的），
 * 所以清理是安全的：下次生成会冷启动一次、多花点流量而已。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', 'server', 'data', 'browser-profiles');

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');
const OLDER = Number(flag('older-than', 0));

const MB = (b) => (b / 1048576).toFixed(1);

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  }
  return total;
}

if (!fs.existsSync(ROOT)) {
  console.log(`还没有 profile 目录（${ROOT}）—— 说明还没跑过生成，无需清理。`);
  process.exit(0);
}

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
if (!dirs.length) { console.log('profile 目录是空的。'); process.exit(0); }

const now = Date.now();
const rows = dirs.map((e) => {
  const p = path.join(ROOT, e.name);
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { /* 忽略 */ }
  const ageDays = (now - mtime) / 86400000;
  return { name: e.name, path: p, size: dirSize(p), ageDays };
}).sort((a, b) => b.size - a.size);

const totalSize = rows.reduce((s, r) => s + r.size, 0);
console.log(`profile 目录：${ROOT}`);
console.log(`共 ${rows.length} 个账号，合计 ${MB(totalSize)} MB（平均 ${MB(totalSize / rows.length)} MB/个）\n`);
console.log('最大的 10 个：');
for (const r of rows.slice(0, 10)) {
  console.log(`  #${r.name.padEnd(8)} ${MB(r.size).padStart(8)} MB   ${r.ageDays.toFixed(1)} 天没用过`);
}

let targets;
if (ALL) targets = rows;
else if (OLDER > 0) targets = rows.filter((r) => r.ageDays > OLDER);
else {
  console.log(`\n（只读模式。加 --older-than 30 --apply 清理 30 天没用过的，或 --all --apply 全清）`);
  console.log(`  提示：按每账号 20MB 估，当前占 ${(totalSize / 1073741824).toFixed(2)} GB。`);
  process.exit(0);
}

if (!targets.length) { console.log('\n没有符合条件的目标。'); process.exit(0); }

const freeBytes = targets.reduce((s, r) => s + r.size, 0);
console.log(`\n将删除 ${targets.length} 个 profile，释放约 ${MB(freeBytes)} MB${APPLY ? '' : '（干跑，未实际删除）'}`);

if (!APPLY) { console.log('确认无误后加 --apply 执行。'); process.exit(0); }

let done = 0;
for (const t of targets) {
  try { fs.rmSync(t.path, { recursive: true, force: true }); done++; }
  catch (e) { console.error(`  删除失败 ${t.name}: ${e.message}`); }
}
console.log(`\n✅ 已删除 ${done}/${targets.length} 个，释放约 ${MB(freeBytes)} MB`);
console.log('   这些账号下次生成会冷启动一次（多花约 12MB 流量），之后再走缓存。');
