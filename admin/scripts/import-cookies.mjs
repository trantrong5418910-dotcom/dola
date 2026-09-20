/**
 * 从目录批量导入 dola cookie 文件。
 *
 *   node scripts/import-cookies.mjs --dir "~/Desktop/未命名文件夹 2"
 *   node scripts/import-cookies.mjs --dir ./cookies --dry-run
 *
 * 为什么要有这个脚本（而不是让人在页面上一个个粘贴）：
 *   dola 的会话会被踢，踢完唯一的解药就是**重新登录导出新 cookie**。
 *   一次十几二十个文件，手粘不现实；而且重新导出的 cookie 内容变了
 *   （sessionid 是新的），按 cookie_hash 去重根本认不出是同一个号，
 *   会变成"死号 + 新号"两行并存。所以这里的核心逻辑是**认账号名，命中就刷新**。
 *
 * 文件名约定：`Dola_<账号>@<域名>_Cookies.json`（浏览器插件导出的默认命名）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const BASE = flag('base', process.env.BASE || 'http://127.0.0.1:8788');
const USER = flag('user', process.env.ADMIN_USER || 'admin');
const PASS = flag('pass', process.env.ADMIN_PASSWORD || 'admin123');
const DRY = has('dry-run');

let DIR = flag('dir');
if (!DIR) {
  console.error('用法：node scripts/import-cookies.mjs --dir "<cookie 文件夹>" [--dry-run]');
  process.exit(2);
}
DIR = path.resolve(DIR.replace(/^~/, os.homedir()));
if (!fs.existsSync(DIR)) { console.error(`目录不存在：${DIR}`); process.exit(1); }

// ---------------- 登录 ----------------
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || `HTTP ${res.status}`), { status: res.status, raw: j });
  return j;
};

const login = await api('POST', '/api/auth/login', { username: USER, password: PASS });
const TOKEN = login.token || login.data?.token;
if (!TOKEN) { console.error('登录没拿到 token：', JSON.stringify(login).slice(0, 200)); process.exit(1); }
const authed = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || `HTTP ${res.status}`), { status: res.status, raw: j });
  return j;
};

// ---------------- 收集文件 ----------------
const files = fs.readdirSync(DIR).filter((f) => /^Dola_.*_Cookies\.json$/i.test(f)).sort();
if (!files.length) { console.error(`目录里没找到 Dola_*_Cookies.json：${DIR}`); process.exit(1); }
console.log(`目录：${DIR}`);
console.log(`找到 ${files.length} 个 cookie 文件\n`);

// ---------------- 取现有账号，建立"账号名 → 已有 label"的映射 ----------------
// 关键：重新导入时要命中**同一个账号行**，而不是新增。所以要把
// 现有的 label（可能只是本地部分，如 `umk1z0`）和新文件名（完整邮箱）对上。
const acc = await authed('GET', '/api/dola/accounts?pageSize=500');
const existing = acc.items || [];
const byLabel = new Map();
for (const a of existing) {
  const keys = new Set();
  if (a.label) keys.add(String(a.label).toLowerCase());
  // account_hint 可能是「昵称 昵称」重复串，取每个片段都试一遍
  for (const part of String(a.account_hint || '').split(/\s+/).filter(Boolean)) keys.add(part.toLowerCase());
  for (const k of keys) if (!byLabel.has(k)) byLabel.set(k, a);
}
console.log(`账号池现有 ${existing.length} 个账号，建立 ${byLabel.size} 条名称索引\n`);

/** 从文件名解析出账号（Dola_<邮箱>_Cookies.json） */
function parseName(file) {
  const m = file.match(/^Dola_(.+?)_Cookies\.json$/i);
  const full = (m ? m[1] : file).trim();
  const [local, domain = ''] = full.split('@');
  return { full, local, domain };
}

const items = [];
const plan = [];
for (const f of files) {
  const { full, local, domain } = parseName(f);
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
  // 先用完整邮箱匹配，再退回本地部分（兼容老账号只用了本地部分当 label）
  const hit = byLabel.get(full.toLowerCase()) || byLabel.get(local.toLowerCase()) || null;
  const label = hit ? hit.label : full;   // 命中已有账号 → 沿用它的 label（触发刷新）
  items.push({ raw, label });
  plan.push({
    file: f, label, mode: hit ? '刷新' : '新增',
    wasStatus: hit ? hit.status : '-',
    domain,
  });
}

console.log('计划：');
console.log('  文件'.padEnd(46), 'label'.padEnd(30), '动作');
for (const p of plan) {
  console.log('  ' + p.file.padEnd(44), p.label.padEnd(30), p.mode + (p.mode === '刷新' ? `（原状态 ${p.wasStatus}）` : ''));
}
const nNew = plan.filter((p) => p.mode === '新增').length;
const nRefresh = plan.filter((p) => p.mode === '刷新').length;
console.log(`\n合计：新增 ${nNew} 个、刷新 ${nRefresh} 个`);

if (DRY) { console.log('\n--dry-run：没有写库。'); process.exit(0); }

// ---------------- 提交 ----------------
const r = await authed('POST', '/api/dola/accounts/import', {
  items,
  note: `从 ${path.basename(DIR)} 导入`,
});
console.log(`\n✅ 导入完成：新增 ${r.inserted}，刷新 ${r.refreshed}，跳过重复 ${r.skipped}，无效 ${r.invalid}`);
if (r.problems?.length) {
  console.log('问题：');
  for (const p of r.problems) console.log('  ·', p);
}
console.log('\n下一步：去后台「dola 账号池 → 批量校验」跑一次，拿到真实的存活数。');
console.log('⚠️ 校验本身也是同 IP 打多个账号，会助攻风控 —— 别短时间内反复跑。');
