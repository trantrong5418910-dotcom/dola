/** 后台界面走查：登录 → 逐个页面截图，顺便收集控制台报错 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// playwright 是可选的（只给走查脚本用），没装就给个明确提示而不是报模块找不到
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('这个脚本需要 playwright。装一个即可： npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
// 注意：不要用 new URL('.').pathname —— 中文路径会被百分号编码，截图会写到诡异的目录
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

async function shot(name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('  📷', name);
}

console.log('→ 登录页');
await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('admin-01-login');

console.log('→ 登录');
await page.fill('input[placeholder="用户名"]', 'admin');
await page.fill('input[placeholder="密码"]', 'admin123');
await page.getByRole('button', { name: /登\s*录/ }).click();
await page.waitForTimeout(1800);
console.log('   当前地址:', page.url());
await shot('admin-02-dashboard');

const pages = [
  ['用户管理', '/users', 'admin-03-users'],
  ['角色权限', '/roles', 'admin-04-roles'],
  ['访问令牌', '/tokens', 'admin-05-tokens'],
  ['充值卡', '/cards', 'admin-06-cards'],
  ['dola 账号池', '/dola', 'admin-07-dola'],
  ['内容管理', '/contents', 'admin-08-contents'],
  ['系统设置', '/settings', 'admin-09-settings'],
  ['操作日志', '/logs', 'admin-10-logs'],
  ['个人设置', '/profile', 'admin-11-profile'],
];

for (const [label, path, name] of pages) {
  console.log('→', label);
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(name);
}

// 顺手验证一下过滤器上的下钻：内容管理搜索
console.log('→ 内容管理搜索验证');
await page.goto(BASE + '/contents', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const rowsBefore = await page.locator('tbody tr').count();
await page.fill('input[placeholder="搜索标题 / 正文"]', '欢迎');
await page.getByRole('button', { name: '查询' }).click();
await page.waitForTimeout(800);
const rowsAfter = await page.locator('tbody tr').count();
console.log(`   搜索前 ${rowsBefore} 行 → 搜索后 ${rowsAfter} 行`);

// 卡片：走一遍「生成卡密」真实交互（会写数据，跑完自己清理）
console.log('→ 充值卡：生成流程');
await page.goto(BASE + '/cards', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const cardsBefore = await page.locator('tbody tr').count();

await page.getByRole('button', { name: '生成卡密' }).click();
await page.waitForTimeout(500);
// 按 placeholder 精确定位「备注」（.el-dialog input 里混着 el-input-number 的数字框，不能按序号取）
await page.locator('input[placeholder*="淘宝渠道"]').fill(`UI走查 ${Date.now().toString(36)}`);
await shot('admin-12-card-generate-dialog');
await page.getByRole('button', { name: '确认生成' }).click();
await page.waitForTimeout(1600);
const resultVisible = await page.locator('.el-dialog__title:has-text("生成成功")').count();
console.log('   生成结果弹窗出现:', resultVisible > 0 ? '是' : '否');
await shot('admin-13-card-result');
await page.getByRole('button', { name: /我已保存/ }).click();
await page.waitForTimeout(1200);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const cardsAfter = await page.locator('tbody tr').count();
console.log(`   充值卡行数 ${cardsBefore} → ${cardsAfter}（本页 20 条/页，新增 10 张）`);

console.log('→ 访问令牌：查看完整值');
await page.goto(BASE + '/tokens', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.getByRole('button', { name: '查看' }).first().click();
await page.waitForTimeout(1000);
const hasValue = await page.locator('.el-dialog input[readonly]').first().inputValue();
console.log('   reveal 返回值长度:', hasValue.length, hasValue.startsWith('dv_') ? '(dv_ 开头 ✓)' : '(格式异常)');
await shot('admin-14-token-reveal');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// dola 账号池：真实走一遍「导入 → 批量校验 → 看任务进度」
console.log('→ dola 账号池：导入流程');
await page.goto(BASE + '/dola', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const stamp = Date.now().toString(36);
const fakeCookies = [
  `ttwid=1%7Cuid_${stamp}_a%7C1789000000%7Caaa; odin_tt=fakeodinAAAAAA; s_v_web_id=verify_${stamp}a`,
  `ttwid=1%7Cuid_${stamp}_b%7C1789000000%7Cbbb; odin_tt=fakeodinBBBBBB; s_v_web_id=verify_${stamp}b`,
].join('\n');

await page.getByRole('button', { name: '批量导入' }).click();
await page.waitForTimeout(600);
await page.locator('.el-dialog textarea').first().fill(fakeCookies);
await page.locator('input[placeholder*="某渠道"]').fill(`UI走查 ${stamp}`);
await page.locator('input[placeholder*="账号 →"]').fill('走查账号');
await shot('admin-15-dola-import-dialog');

await page.getByRole('button', { name: '开始导入' }).click();
await page.waitForTimeout(1800);
const importMsg = await page.locator('.el-dialog .el-alert__title').last().innerText().catch(() => '');
console.log('   导入结果:', importMsg.replace(/\s+/g, ' ').slice(0, 80));
await shot('admin-16-dola-import-result');
await page.getByRole('button', { name: '关闭', exact: true }).click();
await page.waitForTimeout(800);

// 批量校验（会真的打 dola 接口，假 cookie 必然失败 —— 正好验证失败路径）
console.log('→ dola 账号池：批量校验 + 任务进度');
await page.getByRole('button', { name: '批量校验' }).click();
await page.waitForTimeout(600);
await page.getByRole('button', { name: '确定' }).click().catch(() => {});
await page.waitForTimeout(2500);
const jobTitle = await page.locator('.el-dialog__title:has-text("任务进度")').count();
console.log('   任务进度弹窗出现:', jobTitle > 0 ? '是' : '否');
await page.waitForTimeout(6000);
await shot('admin-17-dola-job');
const jobText = await page.locator('.el-dialog').last().innerText().catch(() => '');
const m = jobText.replace(/\s+/g, ' ').match(/已完成 \d+\/\d+.*?失败 \d+/);
console.log('   进度:', m ? m[0] : '(未取到)');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// dola 任务/流水两个标签页
await page.getByRole('tab', { name: '批量任务' }).click();
await page.waitForTimeout(1200);
await shot('admin-18-dola-jobs-tab');
await page.getByRole('tab', { name: '换算流水' }).click();
await page.waitForTimeout(1200);
await shot('admin-19-dola-conversions-tab');

console.log('→ 清理走查产生的 dola 账号');
try {
  const token = await page.evaluate(() => localStorage.getItem('admin_token'));
  const hdr = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const list = await fetch(`${BASE}/api/dola/accounts?keyword=走查账号&pageSize=100`, { headers: hdr }).then((r) => r.json());
  const ids = (list.items || []).map((a) => a.id);
  if (ids.length) {
    const r = await fetch(`${BASE}/api/dola/accounts`, { method: 'DELETE', headers: hdr, body: JSON.stringify({ ids, force: true }) }).then((x) => x.json());
    console.log(`   已清理 ${r.deleted} 个账号`);
  } else {
    console.log('   没有需要清理的账号');
  }
} catch (e) {
  console.log('   清理失败（不影响使用）:', e.message);
}

console.log('→ 深色/浅色切换');
await page.goto(BASE + '/profile', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.locator('.el-switch').first().click();
await page.waitForTimeout(700);
await shot('admin-20-light-theme');

// 走查过程里真生成了 10 张卡，跑完自己清掉，别在库里留垃圾
console.log('→ 清理走查产生的卡密');
try {
  const token = await page.evaluate(() => localStorage.getItem('admin_token'));
  const list = await fetch(`${BASE}/api/cards?keyword=UI走查&pageSize=100`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  let removed = 0;
  for (const c of list.items || []) {
    const r = await fetch(`${BASE}/api/cards/${c.id}?force=1`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) removed++;
  }
  console.log(`   已清理 ${removed} 张`);
} catch (e) {
  console.log('   清理失败（不影响使用）:', e.message);
}

console.log('\n控制台错误：', errors.length ? errors : '无');
await browser.close();
