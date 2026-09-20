/**
 * 给号池批量分配独立出口代理（IPWeb 自编代理）。
 *
 *   # 先验一条，确认账号密码和地区都对
 *   node scripts/assign-proxies.mjs --test --account B_36307 --password 123456 --country KR
 *
 *   # 干跑：只打印会生成什么，不写库
 *   node scripts/assign-proxies.mjs --account B_36307 --password 123456 --country KR --dry-run
 *
 *   # 真配：逐条验证通过才写库
 *   node scripts/assign-proxies.mjs --account B_36307 --password 123456 --country KR --minutes 60
 *
 *   # 只给指定账号配 / 覆盖已有
 *   node scripts/assign-proxies.mjs --account B_36307 --password 123456 --ids 110,111 --force
 *
 * ── IPWeb 代理账号结构（自编，不需要调它的 API）──
 *   gate1.ipweb.cc:7778:B_36307_KR____30_D0000110:密码
 *                       └用户编号┘└国家┘└州┘└城市┘└分钟┘└─SID─┘
 *   同一个 SID 固定同一个出口 IP；改 SID 就换 IP。
 *   所以"每账号一个固定 IP"只要给每个账号派生一个唯一 SID 就行。
 *   网关：gate1 美洲 / gate2 亚太 / gate3 欧非（入口，延迟用；出口由国家代码决定）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIpwebExport, maskProxy } from '../server/dola/proxy.js';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const BASE = flag('base', process.env.BASE || 'http://127.0.0.1:8788');
const USER = flag('user', process.env.ADMIN_USER || 'admin');
const PASS = flag('pass', process.env.ADMIN_PASSWORD || 'admin123');

// ── 凭据来源（三选一，优先级从高到低）──
//   ① --from-export "gate1.ipweb.cc:7778:B_xxx_KR___30_SID:密码"  直接粘后台导出的那一行
//   ② --export-file ./代理.txt                                    粘整段，取第一行可解析的
//   ③ --account + --password                                      手填
let EXPORT_LINE = flag('from-export');
const EXPORT_FILE = flag('export-file');
if (!EXPORT_LINE && EXPORT_FILE) {
  const text = fs.readFileSync(EXPORT_FILE.replace(/^~/, os.homedir()), 'utf8');
  EXPORT_LINE = text.split('\n').map((s) => s.trim()).find((l) => l && !l.startsWith('#') && l.includes(':'));
}

let IP_ACCOUNT = flag('account');
let IP_PASSWORD = flag('password');
let COUNTRY = flag('country');
let STATE = flag('state');
let CITY = flag('city');
let MINUTES = flag('minutes') ? Number(flag('minutes')) : null;

// 命令行显式传的 --state/--city 优先；没传才用导出行里的
const EXPLICIT_STATE = flag('state');
const EXPLICIT_CITY = flag('city');
const EXPLICIT_COUNTRY = flag('country');

if (EXPORT_LINE) {
  try {
    const p = parseIpwebExport(EXPORT_LINE);
    IP_ACCOUNT = p.account;
    IP_PASSWORD = p.password;
    COUNTRY = EXPLICIT_COUNTRY || p.country;
    // ★ 州/城市代码是**跟国家绑定**的（1474/10748 是美国的纽约州/纽约市）。
    //   如果用户用 --country 换了国家，却还带着原来的州码，会拼出
    //   `KR_1474_10748` 这种"韩国的美国州码"—— 取不到 IP，还很难看出原因。
    //   所以换国家时把州/城市一并清掉，除非用户自己显式指定了。
    const countryChanged = EXPLICIT_COUNTRY && EXPLICIT_COUNTRY.toUpperCase() !== String(p.country).toUpperCase();
    STATE = EXPLICIT_STATE ?? (countryChanged ? '' : p.state);
    CITY = EXPLICIT_CITY ?? (countryChanged ? '' : p.city);
    MINUTES = MINUTES ?? p.minutes;
    console.log(`已从导出行解析：用户编号 ${p.account}，原地区 ${p.country}${p.state ? '/' + p.state : ''}${p.city ? '/' + p.city : ''}，原持续 ${p.minutes} 分钟`);
    if (countryChanged) console.log(`（已把出口地区改成 ${COUNTRY.toUpperCase()}，并清掉原国家绑定的州/城市代码）`);
    console.log();
  } catch (e) {
    console.error(`解析导出行失败：${e.message}`);
    process.exit(2);
  }
}
COUNTRY = (COUNTRY || 'KR').toUpperCase();
STATE = STATE ?? '';
CITY = CITY ?? '';
MINUTES = MINUTES || 30;   // 默认 30：IPWeb 的粘性会话上限就是 1~30 分钟（见官方 FAQ）

/**
 * 网关（入口节点）选择。出口国家由**国家代码**决定，网关只影响延迟，
 * 但选错方向会白白多绕半个地球。官方划分：
 *   gate1 美洲（南美/北美）  gate2 亚太（含大洋洲）  gate3 欧洲及非洲
 *
 * 优先级：--gateway 显式指定 > 导出行里的网关 > 按国家推断。
 */
const GATEWAY_EXPLICIT = flag('gateway');
const GATEWAY_FROM_EXPORT = EXPORT_LINE ? parseIpwebExport(EXPORT_LINE).gateway : null;
const GATEWAY = GATEWAY_EXPLICIT || GATEWAY_FROM_EXPORT || gatewayForCountry(COUNTRY);

function gatewayForCountry(cc) {
  const c = String(cc || '').toUpperCase();
  const AMERICAS = new Set(['US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO']);
  const EMEA = new Set(['GB', 'DE', 'FR', 'NL', 'ES', 'IT', 'PL', 'SE', 'NO', 'FI', 'DK', 'IE', 'PT', 'CH', 'AT', 'BE', 'CZ', 'RO', 'GR', 'TR', 'RU', 'UA', 'ZA', 'EG', 'NG', 'KE', 'MA', 'SA', 'AE', 'IL']);
  if (AMERICAS.has(c)) return 'gate1.ipweb.cc';
  if (EMEA.has(c)) return 'gate3.ipweb.cc';
  return 'gate2.ipweb.cc';   // 亚太（KR/JP/SG/HK/TW/TH/VN/PH/ID/MY/AU…）与未知一律走亚太
}
const IDS = (flag('ids', '') || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const DRY = has('dry-run');
const FORCE = has('force');
const TEST_ONLY = has('test');
const BATCH_SIZE_INPUT = flag('batch-size');
const RESUME_FILE_INPUT = flag('resume-file');
const BATCH_SIZE = BATCH_SIZE_INPUT === null ? 5 : Number(BATCH_SIZE_INPUT);
const RESUME_FILE = RESUME_FILE_INPUT
  ? path.resolve(RESUME_FILE_INPUT.replace(/^~/, os.homedir()))
  : null;

if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 100) {
  console.error('--batch-size 必须是 1~100 的整数');
  process.exit(2);
}

if (!IP_ACCOUNT || !IP_PASSWORD) {
  console.error([
    '用法：三种方式任选其一提供凭据',
    '',
    '  ① 直接粘 IPWeb 后台导出的那一行（最省事，不用手抄密码）',
    '     node scripts/assign-proxies.mjs --from-export "gate1.ipweb.cc:7778:B_36307_KR___30_Ab000001:123456"',
    '',
    '  ② 粘整段导出内容（从文件里取第一行）',
    '     node scripts/assign-proxies.mjs --export-file ~/Downloads/代理.txt',
    '',
    '  ③ 手填',
    '     node scripts/assign-proxies.mjs --account B_36307 --password 123456',
    '',
    '  通用选项：',
    '    --country KR        国家代码（US/HK/JP…；000 = 全球随机）',
    '    --state / --city    州 / 城市代码，留空 = 不限',
    '    --minutes 30        IP 持续时间（分钟，1~30）',
    '    --gateway gate2.ipweb.cc   入口：gate1 美洲 / gate2 亚太 / gate3 欧非',
    '    --ids 110,111       只处理指定账号（默认处理所有还没配代理的）',
    '    --force             已有代理的也覆盖',
    '    --gap 3000          每条验证之间的间隔毫秒（默认 3000；连着发会被 SIPWeb 限流）',
    '    --batch-size 5      每批最多处理几个账号（默认 5，降低批量超时风险）',
    '    --resume-file PATH  保存/读取续跑进度（只存账号 ID 和结果摘要，不存密码）',
    '    --test              只验一条是否可用，不写库',
    '    --dry-run           只打印，不写库',
  ].join('\n'));
  process.exit(2);
}


// 密码也可以从文件读（避免密码进 shell 历史）
const PWFILE = flag('password-file');
if (PWFILE) IP_PASSWORD = fs.readFileSync(PWFILE.replace(/^~/, os.homedir()), 'utf8').trim();
const PASSWORD = IP_PASSWORD;

const api = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || `HTTP ${res.status}`);
  return j;
};
const login = await api('POST', '/api/auth/login', { username: USER, password: PASS });
const TOKEN = login.token;
const authed = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || `HTTP ${res.status}`);
  return j;
};

/** 本地按同样规则拼一条，用于 --dry-run / --test 把 URL 打出来 */
function buildLocal(sid) {
  const username = [IP_ACCOUNT, COUNTRY, STATE, CITY, String(MINUTES), sid].join('_');
  // 必须 socks5：实测 HTTP 代理模式带凭据会被静默关闭（见 server/dola/proxy.js）
  return `socks5://${username}:${encodeURIComponent(PASSWORD)}@${GATEWAY}:7778`;
}

console.log('配置：');
console.log(`  IPWeb 用户编号 ${IP_ACCOUNT}`);
console.log(`  地区 ${COUNTRY}${STATE ? '/' + STATE : ''}${CITY ? '/' + CITY : ''}   IP 持续 ${MINUTES} 分钟   网关 ${GATEWAY}`);
console.log(`  样例：${maskProxy(buildLocal('D0000110'))}\n`);

if (TEST_ONLY) {
  const proxy = buildLocal('D0000110');
  console.log('验证这条代理是否可用 …');
  const r = await authed('POST', '/api/dola/accounts/proxy/verify', { proxy });
  if (r.ok) {
    console.log(`\n✅ 可用！出口 IP ${r.ip}（${r.country} ${r.region || ''} ${r.city || ''}）`);
    console.log(`   ${r.org || ''}`);
    console.log('\n接着跑真配（去掉 --test）：');
    console.log(`  node scripts/assign-proxies.mjs --account ${IP_ACCOUNT} --password <密码> --country ${COUNTRY} --minutes ${MINUTES} --gateway ${GATEWAY}`);
  } else {
    console.log(`\n❌ 不可用：${r.message || 'HTTP ' + r.status}`);
    console.log('   常见原因：用户编号写错 / 密码错 / 该地区当天没资源 / 余额或流量用尽');
    console.log('   可以去后台「获取代理」页面对照一下导出的格式。');
  }
  process.exit(r.ok ? 0 : 1);
}

if (DRY) {
  const acc = await authed('GET', '/api/dola/accounts?pageSize=500');
  const targets = IDS.length
    ? acc.items.filter((a) => IDS.includes(a.id))
    : acc.items.filter((a) => a.status !== 'disabled' && !a.proxy);
  console.log(`会处理 ${targets.length} 个账号（--dry-run，不写库）：`);
  for (const a of targets.slice(0, 15)) {
    const sid = `D${String(a.id).padStart(7, '0')}`;
    console.log(`  #${String(a.id).padEnd(4)} ${String(a.label).padEnd(24)} SID=${sid}  ${maskProxy(buildLocal(sid))}`);
  }
  if (targets.length > 15) console.log(`  …还有 ${targets.length - 15} 个`);
  console.log('\n（真正执行时每条代理都会先连一次 ipinfo.io 验证，只把通的写进库）');
  process.exit(0);
}

function checkpointConfig() {
  // 这里绝不保存 IPWeb 密码；配置只用于避免把续跑文件误用于另一批任务。
  return { ipAccount: IP_ACCOUNT, country: COUNTRY, state: STATE, city: CITY, minutes: MINUTES, gateway: GATEWAY, force: FORCE };
}

function writeCheckpoint({ requestedIds, pendingIds, completedIds, status, lastBatch = null }) {
  if (!RESUME_FILE) return;
  const payload = {
    version: 1,
    createdAt: checkpointCreatedAt,
    updatedAt: new Date().toISOString(),
    status,
    config: checkpointConfig(),
    requestedIds: [...new Set(requestedIds.map(Number).filter(Boolean))],
    completedIds: [...new Set(completedIds.map(Number).filter(Boolean))],
    pendingIds: [...new Set(pendingIds.map(Number).filter(Boolean))],
    lastBatch,
  };
  fs.mkdirSync(path.dirname(RESUME_FILE), { recursive: true });
  fs.writeFileSync(RESUME_FILE, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(RESUME_FILE, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

function loadCheckpoint() {
  if (!RESUME_FILE || !fs.existsSync(RESUME_FILE)) return null;
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`续跑文件无法读取：${e.message}`);
  }
  if (saved?.version !== 1 || !saved?.config || !Array.isArray(saved?.requestedIds) || !Array.isArray(saved?.pendingIds)) {
    throw new Error('续跑文件版本或结构不受支持，请换一个新路径');
  }
  const expected = checkpointConfig();
  for (const key of Object.keys(expected)) {
    if (String(saved.config[key] ?? '') !== String(expected[key] ?? '')) {
      throw new Error(`续跑文件配置不匹配：${key} 已改变；请使用原参数，或换一个 --resume-file 路径`);
    }
  }
  if (IDS.length && JSON.stringify([...new Set(IDS)]) !== JSON.stringify([...new Set(saved.requestedIds.map(Number))])) {
    throw new Error('续跑文件中的账号 ID 与本次 --ids 不一致；请使用原账号列表，或换一个 --resume-file 路径');
  }
  return saved;
}

function printBatchResult(batchNo, r) {
  console.log(`\n批次 ${batchNo}：成功 ${r.assigned || 0}，跳过 ${r.skipped || 0}，失败 ${r.failed || 0}（共 ${r.total || 0}）`);
  if (r.collisions) console.log(`  出口 IP 撞车 ${r.collisions} 次，其中换 SID 解决 ${r.rerolled} 次${r.duplicated ? `，仍有 ${r.duplicated} 个共用 IP` : ''}`);
  for (const x of r.results || []) {
    if (x.skipped) console.log(`  ⏭️ #${x.id} ${x.message}`);
    else if (!x.ok) {
      console.log(`  ❌ #${x.id} ${x.message}`);
      console.log(`      实际用: ${x.using || '(未记录)'}`);
    } else if (x.exitIp) {
      console.log(`  ${x.duplicated ? '⚠️' : '✅'} #${String(x.id).padEnd(4)} SID=${x.sid}  出口 ${x.exitIp}（${x.exitCountry || ''} ${x.exitCity || ''}）${x.duplicated ? ' ← 与别人共用，建议重跑' : ''}`);
    } else {
      console.log(`  ✅ #${x.id} 已写入代理`);
    }
  }
}

async function selectTargetIds() {
  if (IDS.length) return [...new Set(IDS)];
  const acc = await authed('GET', '/api/dola/accounts?pageSize=50000');
  const items = Array.isArray(acc.items) ? acc.items : [];
  return items
    .filter((a) => a.status !== 'disabled' && (FORCE || !a.proxy))
    .map((a) => Number(a.id))
    .filter(Boolean);
}

let saved = loadCheckpoint();
const checkpointCreatedAt = saved?.createdAt || new Date().toISOString();
const requestedIds = saved?.requestedIds?.length ? saved.requestedIds.map(Number) : await selectTargetIds();
let pendingIds = saved?.pendingIds?.map(Number) || requestedIds.slice();
let completedIds = saved?.completedIds?.map(Number) || [];

if (!requestedIds.length || !pendingIds.length) {
  if (RESUME_FILE) writeCheckpoint({ requestedIds, pendingIds: [], completedIds, status: 'done' });
  console.log('没有需要处理的账号。');
  process.exit(0);
}

console.log(`开始分配（逐条验证，批量 ${BATCH_SIZE} 个；可能需要一会儿）…`);
if (RESUME_FILE) console.log(`续跑文件：${RESUME_FILE}`);

let queue = pendingIds.slice();
const remaining = [];
let requestError = null;
let batchNo = 0;
while (queue.length) {
  const batch = queue.splice(0, BATCH_SIZE);
  batchNo++;
  let r;
  try {
    r = await authed('POST', '/api/dola/accounts/proxy/assign', {
      account: IP_ACCOUNT, password: PASSWORD, country: COUNTRY, state: STATE, city: CITY,
      minutes: MINUTES, gateway: GATEWAY, ids: batch, force: FORCE,
      ...(flag('gap') ? { gapMs: Number(flag('gap')) } : {}),
    });
  } catch (e) {
    requestError = e;
    remaining.push(...batch, ...queue);
    console.error(`\n批次 ${batchNo} 请求失败：${e.message}`);
    break;
  }

  printBatchResult(batchNo, r);
  const succeeded = new Set((r.results || []).filter((x) => x.ok).map((x) => Number(x.id)));
  completedIds.push(...batch.filter((id) => succeeded.has(id)));
  remaining.push(...batch.filter((id) => !succeeded.has(id)));
  pendingIds = [...remaining, ...queue];
  if (RESUME_FILE) {
    writeCheckpoint({
      requestedIds,
      pendingIds,
      completedIds,
      status: pendingIds.length ? 'pending' : 'done',
      lastBatch: { number: batchNo, ids: batch, assigned: r.assigned || 0, skipped: r.skipped || 0, failed: r.failed || 0 },
    });
  }
}

pendingIds = [...remaining, ...queue];
if (RESUME_FILE) writeCheckpoint({ requestedIds, pendingIds, completedIds, status: pendingIds.length ? 'pending' : 'done' });
if (pendingIds.length) console.log(`\n⚠️ 仍有 ${pendingIds.length} 个账号未完成，可用同一组参数和 --resume-file 继续。`);
if (requestError) process.exitCode = 1;
else if (pendingIds.length) process.exitCode = 1;

const s = await authed('GET', '/api/dola/accounts/proxy/summary');
console.log(`\n代理覆盖率：${s.withProxy}/${s.total}（不同代理 ${s.distinctProxies} 条）`);
console.log(`  ${s.hint}`);
