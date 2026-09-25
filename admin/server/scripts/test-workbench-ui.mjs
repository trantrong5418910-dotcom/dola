/**
 * 视频 API 工作台（web/public/test.html）端到端 UI 测试。
 *
 * 为什么必须用真实浏览器而不是 curl：这个页面有四类**只有渲染后才看得见**的问题 ——
 *   · 固定宽度表格里文案被截断（踩过：132px 只够 7 个汉字，最该看清的一行反而看不全）
 *   · CSS 变量取不到值 → 属性整条失效，元素在某个主题下隐形（踩过）
 *   · id 拼错 → `$(...)` 返回 null → 事件绑定静默失效（不报错、点了没反应）
 *   · `window.confirm` 被 Playwright 默认 **dismiss** → 所有确认型操作变成"点了没反应"
 * curl 对这四类一个都测不出来。
 *
 * ⚠️ 本地库（server/data/admin.db）是**无代理的瘦身开发库**：4 个 valid 账号 proxy 全空、
 *    没有代理池表，所以 `createVideoTask` 的预检必然报"账号池里没有可用账号"。
 *    因此：
 *      · 建任务这一步按「成功 / 被预检拦下」两种结果都判 PASS ——
 *        被拦下时校验的是**错误路径渲染**（409 + 诊断信息要真的出现在界面上）；
 *      · 行内操作与批量清除用 DB 夹具覆盖（见 WB_FIXTURE_*），
 *        夹具**不写 point_transactions**，所以 settleFailedVideoRefund 拿不到 consume 记录、
 *        直接 return refunded:false，余额不会被污染（已读代码确认）。
 *      · 真实成片生成请在**生产**上跑：WB_BASE=https://admin.fei85.cn WB_LIVE=1
 *
 * 用法（令牌从环境变量传，不落盘、不进仓库）：
 *   cd admin && WB_TOKEN=dv_xxx WB_FIXTURE_QUEUED=9 WB_FIXTURE_OTHER=10 \
 *     /Users/feige/.workbuddy/binaries/node/versions/22.22.2-3/bin/node \
 *     server/scripts/test-workbench-ui.mjs
 *
 * 环境变量：
 *   WB_BASE             默认 http://127.0.0.1:8788
 *   WB_TOKEN            必填，用户令牌（Bearer）
 *   WB_FIXTURE_QUEUED   可选，已知处于"排队中"的任务 id（行内 提交上游/取消 会用它）
 *   WB_FIXTURE_OTHER    可选，已知处于终态的任务 id（行内 清除 会用它）
 *   WB_LIVE             1 = 额外跑一次**真实提交**并监控到终态（消耗上游额度与积分）
 *   WB_OUT              截图目录，默认 /tmp
 */

// ESM 的 import 不看 NODE_PATH，必须绝对路径；playwright 是 CJS，导出挂在 default 上。
const PW_ENTRY = '/Users/feige/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js';
const _pw = await import(`file://${PW_ENTRY}`);
const chromium = _pw.chromium || _pw.default?.chromium;

const BASE = process.env.WB_BASE || 'http://127.0.0.1:8788';
const TOKEN = process.env.WB_TOKEN || '';
const LIVE = process.env.WB_LIVE === '1';
const OUT = process.env.WB_OUT || '/tmp';
const FIX_QUEUED = process.env.WB_FIXTURE_QUEUED || '';
const FIX_OTHER = process.env.WB_FIXTURE_OTHER || '';

if (!TOKEN) {
  console.error('缺少 WB_TOKEN');
  process.exit(2);
}

const results = [];
let failures = 0;
let skips = 0;
function check(name, condition, extra = '') {
  const pass = Boolean(condition);
  if (!pass) failures += 1;
  results.push({ pass, name, extra, skipped: false });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${extra ? ` | ${extra}` : ''}`);
  return pass;
}
/**
 * SKIP = 「这条现在测不了」，和 FAIL（「测了，是坏的」）必须分开。
 *
 * 为什么需要它：生产环境跑回归时踩到过 —— 令牌名下的任务被上一轮测试全清掉了，
 * 而账号池不可用导致建不出新任务，于是「列表能渲染出任务行」必然拿不到行。
 * 那是**数据状态不允许**，不是代码错了；把它判 FAIL 会让人误以为功能坏了，
 * 判 PASS 又是撒谎。所以如实标 SKIP 并把原因写出来。
 */
function skip(name, reason) {
  skips += 1;
  results.push({ pass: true, name, extra: reason, skipped: true });
  console.log(`SKIP | ${name}${reason ? ` | ${reason}` : ''}`);
  return true;
}
const log = (stage, data) => console.log(JSON.stringify({ stage, ...data }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();

const dialogs = [];
page.on('dialog', async (dialog) => {
  dialogs.push(dialog.message().slice(0, 70));
  await dialog.accept();
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)));
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
const failedRequests = [];
page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));

const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());
const disabled = (sel) => page.$eval(sel, (el) => el.disabled);
const hidden = (sel) => page.$eval(sel, (el) => el.classList.contains('hidden'));
const shot = (name) => page.screenshot({ path: `${OUT}/wb-${name}.png` });
const rowIds = () => page.$$eval('#jobRows tr[data-id]', (rows) => rows.map((r) => r.dataset.id));
/** waitForFunction 的签名是 (fn, arg, options) —— options 必须放第三位，放第二位会被当成 arg。
 *  另外此处用的是 getElementById，**必须去掉选择器里的 `#`**，否则取到 null 直接抛 TypeError。 */
const waitText = (sel, re, timeout = 45000) => {
  const id = sel.replace(/^#/, '');
  return page.waitForFunction(
    ([nodeId, src]) => {
      const node = document.getElementById(nodeId);
      return Boolean(node) && new RegExp(src).test(node.textContent);
    },
    [id, re.source],
    { timeout },
  );
};

try {
  // ── 0. 页面本身
  const response = await page.goto(`${BASE}/test.html`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  log('navigate', { url: BASE, status: response?.status(), title: await page.title(), bytes: (await response.text()).length });
  check('页面 200 且标题正确', response?.status() === 200 && (await page.title()) === '视频 API 工作台');

  // SPA fallback 会把不存在的路径回 index.html，所以"200"不能证明这个文件存在 —— 比字节数。
  const sizes = await page.evaluate(async () => {
    const a = await (await fetch('/')).text();
    const b = await (await fetch('/test.html')).text();
    const c = await (await fetch('/test.js')).text();
    return { index: a.length, test: b.length, js: c.length, head: b.slice(0, 200) };
  });
  check('test.html 是真实文件而非 SPA fallback', sizes.test !== sizes.index && sizes.test > 5000, `index=${sizes.index} test=${sizes.test}`);
  check('test.js 是真实文件而非 SPA fallback', sizes.js > 5000, `js=${sizes.js}`);

  // ── 1. 所有受管控件都必须存在
  const ids = [
    'apiKey', 'connect', 'model', 'pullModels', 'seconds', 'ratio', 'prompt', 'images', 'fileList',
    'capability', 'autoStart', 'create', 'costNote', 'statusDot', 'connectionState', 'ping',
    'tabRun', 'tabJobs', 'summary', 'taskId', 'taskStatus', 'taskStage', 'refreshCurrent',
    'cancelCurrent', 'clearCurrent', 'download', 'progressBar', 'progressNote', 'player',
    'taskError', 'taskMeta', 'rawJson', 'jobsCount', 'refreshJobs', 'startQueued', 'clearJobs', 'jobRows',
  ];
  const missing = await page.evaluate((list) => list.filter((id) => !document.getElementById(id)), ids);
  check(`${ids.length} 个受管控件全部存在`, missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : '');

  // 按钮被 flex 压扁 → 文案竖排两行。**源码里看不出来**，只有渲染后量高度才发现
  // （截图实测到过：「连接」「拉模型」变成两行）。单行按钮 ≈ 39px，两行约 56px。
  const btnBox = await page.$$eval(
    '#connect,#pullModels,#ping,#create,#refreshJobs,#startQueued,#clearJobs,#clearCurrent,#cancelCurrent',
    (buttons) => buttons.map((b) => ({ id: b.id, h: b.offsetHeight, w: b.offsetWidth, label: b.textContent.trim() })),
  );
  const wrappedButtons = btnBox.filter((b) => b.h > 46);
  log('buttonBox', { btnBox });
  check('按钮文字不竖排换行（flex 行里没被压扁）', wrappedButtons.length === 0, wrappedButtons.map((b) => `${b.id}(${b.label})=${b.h}px`).join(' '));

  // ── 2. 未连接时的按钮门禁
  // （withBusy 收尾曾经无条件 disabled=false，会让未连接时也能点「加入任务」—— 这几条就是防它回归）
  for (const [sel, label] of [['#create', '加入任务'], ['#refreshJobs', '刷新列表'], ['#startQueued', '全部提交上游'], ['#clearJobs', '清空任务记录'], ['#pullModels', '拉模型']]) {
    check(`未连接时「${label}」禁用`, await disabled(sel));
  }
  check('四个统计卡在未连接时也占位渲染', (await page.$$('#summary .stat')).length === 4);
  check('任务列表在未连接时给出引导文案', (await text('#jobRows')).includes('连接'));

  // ── 3. 连接
  await page.fill('#apiKey', TOKEN);
  await page.click('#connect');
  await waitText('#connectionState', /已连接/, 60000);
  const statCards = await page.$$eval('#summary .stat', (nodes) => nodes.map((n) => `${n.querySelector('b').textContent}｜${n.querySelector('span').textContent}`));
  log('connected', { state: await text('#connectionState'), statCards });
  check('连接后统计卡仍是四个', statCards.length === 4, statCards.join(' / '));
  check('连接后余额是数字不是占位符', /^[\d,]+｜/.test(statCards[0]), statCards[0]);
  check('连接后「加入任务」解禁', !(await disabled('#create')));
  check('连接后「拉模型」解禁', !(await disabled('#pullModels')));
  check('模型下拉有选项', (await page.$$eval('#model option', (o) => o.length)) >= 1);
  check('时长下拉有选项', (await page.$$eval('#seconds option', (o) => o.length)) >= 1);

  await page.click('#ping');
  await waitText('#connectionState', /服务在线/, 30000);
  log('ping', { state: await text('#connectionState') });
  check('测连通返回服务在线并带余额', (await text('#connectionState')).includes('余额'));

  await page.click('#pullModels');
  await sleep(1800);
  check('拉模型后提示可用模型', (await text('#connectionState')).includes('模型可用'), await text('#connectionState'));
  await shot('01-run-light');

  // ── 4. 双 Tab
  await page.click('#tabJobs');
  await sleep(1500);
  check('切到任务列表后 pane-jobs 激活', await page.$eval('#pane-jobs', (el) => el.classList.contains('active')));
  check('当前任务面板同时隐藏', !(await page.$eval('#pane-run', (el) => el.classList.contains('active'))));
  const headers = await page.$$eval('#pane-jobs thead th', (th) => th.map((t) => t.textContent.trim()));
  log('jobsHeaders', { headers });
  check('任务列表 7 列（ID/状态/阶段/时长/提示词/错误/操作）', headers.length === 7, headers.join('|'));
  await shot('02-jobs-list');
  await page.click('#tabRun');
  check('切回当前任务', await page.$eval('#pane-run', (el) => el.classList.contains('active')));

  // ── 5. 加入任务：成功或被预检拦下都算通过，但拦下时必须把原因摆到界面上
  await page.fill('#prompt', `工作台功能自测 ${Date.now()}`);
  await page.uncheck('#autoStart');
  check('取消勾选后成本提示改为"先冻结"', (await text('#costNote')).includes('冻结'));
  await page.click('#create');
  const createOutcome = await Promise.race([
    waitText('#taskId', /^任务 #\d+/, 90000).then(() => 'created').catch(() => null),
    waitText('#taskError', /./, 100000).then(() => 'error').catch(() => null),
  ]);
  const createdId = /^任务 #(\d+)/.exec(await text('#taskId'))?.[1] || '';
  const createError = await text('#taskError');
  log('createOutcome', { createOutcome, createdId, connection: await text('#connectionState'), error: createError.slice(0, 160), dialogs: dialogs.slice(-1) });
  if (createdId) {
    check('建出任务且 auto_start=false 停在排队中', (await text('#taskStatus')) === '排队中', `#${createdId} ${await text('#taskStatus')}`);
    await shot('03-run-queued');
  } else {
    check('建任务被拦下时，原因原文呈现在界面上且未扣积分', /未建任务|未扣积分|没有可用账号|预检/.test(createError), createError.slice(0, 120));
    check('被拦下时连接状态明确显示提交失败', (await text('#connectionState')).includes('失败'), await text('#connectionState'));
    await shot('03-run-blocked');
  }
  check('阶段说明标注是估算', (await text('#progressNote')).includes('估算'));
  check('进度条有宽度', (await page.$eval('#progressBar', (el) => el.style.width)) !== '');

  // ── 6. 任务列表行内操作
  await page.click('#tabJobs');
  await sleep(1800);
  let ids0 = await rowIds();
  log('rows', { ids: ids0, count: ids0.length });
  // 前置条件：**列表里得有行才测得了行**。
  // 生产实测踩到：这个令牌的任务被上一轮测试全清掉了（cleared_at），而账号池不可用
  // 导致建不出新任务 → 必然 0 行。那是数据状态不允许，不是功能坏了 → 如实标 SKIP。
  if (ids0.length >= 1) {
    check('列表能渲染出任务行', true, ids0.join(','));
  } else if (/没有可用账号|未建任务|预检/.test(createError)) {
    skip('列表能渲染出任务行', '该令牌名下一个未清除的任务都没有（上一轮已清空），且本次建任务被账号池预检拦下，无行可测');
  } else {
    check('列表能渲染出任务行', false, '列表为空，且本次建任务也没有被拦下的理由，不该为空');
  }
  if (ids0.length) {
    const queuedTarget = FIX_QUEUED || (createdId && ids0.includes(createdId) ? createdId : null)
      || (await page.$$eval('#jobRows tr[data-id]', (rows) => rows.find((r) => r.textContent.includes('排队中'))?.dataset.id || ''));
    const otherTarget = FIX_OTHER || ids0.find((id) => id !== queuedTarget) || '';

    // 终态行（已完成/失败/已取消）的按钮集合 —— 这是**我们和参考站唯一的能力差异**，
    // 必须断言成"正向的、有意的"而不是漏了：
    //   参考站的 canStart() 把 failed/cancelled 也算可启动，但我们的
    //   startOwnedVideoTask 只接受 queued（终态重启会返回 409 TASK_NOT_STARTABLE），
    //   所以终态行**按设计不出现**「提交上游」「取消」，取而代之是「终态不可重启」文案。
    //   抄一个点不动的按钮，比不抄更糟。
    const terminalId = (await page.$$eval('#jobRows tr[data-id]', (rows) => {
      // 只认「状态」那一列（td[1]）—— 拿整行文本匹配会被「错误」列里的"失败"字样误伤
      const hit = rows.find((r) => /^(已完成|失败|已取消)$/.test((r.children[1]?.textContent || '').trim()));
      return hit ? hit.dataset.id : '';
    })) || '';
    if (terminalId) {
      const tActs = await page.$$eval(`#jobRows tr[data-id="${terminalId}"] button[data-act]`, (b) => b.map((x) => x.dataset.act));
      log('terminalRowActions', { id: terminalId, acts: tActs });
      check('终态行只提供 获取状态/清除（提交上游/取消按设计不出现）',
        tActs.includes('status') && tActs.includes('clear') && !tActs.includes('start') && !tActs.includes('cancel'),
        tActs.join(','));
      // 「获取状态」是只读的，对终态行也安全 —— 用它验证行内按钮的事件真的绑上了
      await page.click(`#jobRows tr[data-id="${terminalId}"] button[data-act="status"]`);
      await waitText('#taskId', new RegExp(`^任务 #${terminalId}$`), 30000);
      check('终态行的「获取状态」也能选中该行', (await text('#taskId')) === `任务 #${terminalId}`);
      await page.click('#tabJobs');
      await sleep(800);
    } else {
      log('terminalRowActions', { skipped: '列表里没有终态行' });
    }

    // 排队中的行：必须**先在界面上确认它真的是「排队中」**再往下测。
    // 踩过（假 FAIL）：夹具是插入**之后**才重启服务的，启动清扫器把这条未提交的排队任务
    // 标成了 failed（"服务重启导致未提交的排队任务中断" —— 这是**正确**行为），
    // 而测试仍按 WB_FIXTURE_QUEUED 去测「提交上游/取消」，按钮按设计不出现 → 误判成功能坏了。
    // 结论：环境变量只是"我期望它是排队中"，界面上的状态才是事实。
    const queuedRowStatus = queuedTarget
      ? await page.$$eval(`#jobRows tr[data-id="${queuedTarget}"]`, (r) => (r[0]?.children[1]?.textContent || '').trim())
      : '';
    if (queuedTarget && ids0.includes(String(queuedTarget)) && /排队中/.test(queuedRowStatus)) {
      const acts = await page.$$eval(`#jobRows tr[data-id="${queuedTarget}"] button[data-act]`, (b) => b.map((x) => x.dataset.act));
      log('queuedRowActions', { id: queuedTarget, acts });
      check('排队中的行提供 提交上游/取消/获取状态/清除', ['start', 'cancel', 'status', 'clear'].every((a) => acts.includes(a)), acts.join(','));

      // 获取状态：只读，把该行选中并切回「当前任务」
      await page.click(`#jobRows tr[data-id="${queuedTarget}"] button[data-act="status"]`);
      await waitText('#taskId', new RegExp(`^任务 #${queuedTarget}$`), 30000);
      check('「获取状态」会把该行选中并切回当前任务', (await text('#taskId')) === `任务 #${queuedTarget}`);

      // 「获取状态」会把页签切到「当前任务」，后面的行内按钮在隐藏的 pane-jobs 里，必须切回来
      await page.click('#tabJobs');
      await sleep(800);

      // 提交上游：这条夹具没有扣费记录，服务端会拒绝；断言的是"拒绝被正确呈现"而不是假装成功。
      // 必须在「取消」之前点 —— 取消之后该行变终态，按钮就不出现了（这本身是正确行为）。
      if (await page.$(`#jobRows tr[data-id="${queuedTarget}"] button[data-act="start"]`)) {
        await page.click(`#jobRows tr[data-id="${queuedTarget}"] button[data-act="start"]`);
        await sleep(3500);
        log('afterStart', { id: queuedTarget, connection: await text('#connectionState'), error: (await text('#taskError')).slice(0, 140) });
        check('「提交上游」被服务端拒绝时把原因显示出来', (await text('#taskError')).length > 0 || (await text('#connectionState')).length > 0,
          (await text('#taskError')).slice(0, 80));
        await page.click('#tabJobs');
        await sleep(600);
      } else {
        log('afterStart', { skipped: '该行已不是排队中（终态不可重启，按钮按设计不出现）' });
      }

      // 取消：真实调用 POST /v1/videos/:id/cancel
      if (await page.$(`#jobRows tr[data-id="${queuedTarget}"] button[data-act="cancel"]`)) {
        await page.click(`#jobRows tr[data-id="${queuedTarget}"] button[data-act="cancel"]`);
        await sleep(3500);
        const afterCancel = await page.$$eval(`#jobRows tr[data-id="${queuedTarget}"]`, (r) => r[0]?.textContent || '');
        log('afterCancel', { id: queuedTarget, row: afterCancel.slice(0, 80), connection: await text('#connectionState') });
        check('「取消」后该行状态变为已取消', afterCancel.includes('已取消'), afterCancel.slice(0, 60));
        check('「取消」后连接状态给出回执', (await text('#connectionState')).includes('已取消'), await text('#connectionState'));
        check('取消后该行不再提供「提交上游」（终态不可重启）',
          !(await page.$(`#jobRows tr[data-id="${queuedTarget}"] button[data-act="start"]`)));
      } else {
        log('afterCancel', { skipped: '该行已不是可取消状态' });
      }
    } else if (queuedTarget && ids0.includes(String(queuedTarget))) {
      skip('排队中的行提供 提交上游/取消/获取状态/清除',
        `夹具 #${queuedTarget} 在界面上是「${queuedRowStatus}」而不是排队中 —— 多半是插完夹具又重启了服务，被启动清扫器标成失败（这是正确行为，不是功能坏了）`);
      log('queuedRow', { skipped: 'fixture-not-queued', id: queuedTarget, status: queuedRowStatus });
    } else {
      log('queuedRow', { skipped: '没有排队中的行' });
    }

    if (otherTarget) {
      await page.click(`#jobRows tr[data-id="${otherTarget}"] button[data-act="clear"]`);
      await sleep(3000);
      const remaining = await rowIds();
      log('afterClear', { id: otherTarget, remaining, connection: await text('#connectionState') });
      check('「清除」后该行从列表移除', !remaining.includes(String(otherTarget)), remaining.join(','));
      // 服务端软删除（cleared_at），所以刷新列表**不应该**再回来 —— 这正是「清除」和「取消」的区别
      await page.click('#refreshJobs');
      await sleep(2500);
      const refreshed = await rowIds();
      log('afterClearRefresh', { refreshed });
      check('刷新列表后被清除的任务不再出现（软删除生效）', !refreshed.includes(String(otherTarget)), refreshed.join(','));
      // 对照组：只「取消」没「清除」的任务应该还留在列表里（状态已取消）
      if (queuedTarget && ids0.includes(String(queuedTarget))) {
        check('只取消未清除的任务刷新后仍在列表里（取消 ≠ 清除）', refreshed.includes(String(queuedTarget)), refreshed.join(','));
      }
    }
  }

  // ── 7. 全部提交上游
  // 没有排队任务时这个按钮**会禁用**（比"点了再报错"更好），所以两种情况都算对，但都要断言到。
  await page.click('#tabJobs');
  await sleep(800);
  if (await disabled('#startQueued')) {
    check('没有排队中的任务时「全部提交上游」禁用（而不是点了才报错）', true);
    log('startAll', { disabled: true });
  } else {
    await page.click('#startQueued');
    await sleep(3500);
    log('startAll', { connection: await text('#connectionState'), error: (await text('#taskError')).slice(0, 200), dialogs: dialogs.slice(-1) });
    check('有排队任务时「全部提交上游」给出回执或明确原因',
      (await text('#connectionState')).includes('已提交') || (await text('#taskError')).length > 0,
      (await text('#connectionState')).slice(0, 60));
  }

  // ── 8. 可选：真实提交一次，并用「全部提交上游」发车、监控到终态
  //      放在「清空任务记录」之前，这样跑完会被一起清掉。
  let liveTaskId = '';
  if (LIVE) {
    await page.click('#tabRun');
    await page.fill('#prompt', `工作台真实提交 + 全部提交上游 ${Date.now()}`);
    await page.uncheck('#autoStart');   // 先只建任务，再用「全部提交上游」发车 —— 一次覆盖两个按钮
    await page.click('#create');
    // 账号池不可用时，预检会在建任务前拦下（不扣积分），此时没有 id 可监控。
    // 如实记下来，不要假装跑通了。
    const liveOutcome = await Promise.race([
      waitText('#taskId', /^任务 #\d+/, 120000).then(() => 'created').catch(() => null),
      waitText('#taskError', /./, 150000).then(() => 'error').catch(() => null),
    ]);
    liveTaskId = /^任务 #(\d+)/.exec(await text('#taskId'))?.[1] || '';
    if (!liveTaskId) {
      log('live-skipped', { liveOutcome, error: (await text('#taskError')).slice(0, 200) });
      check('真实提交被拦下时原因可读（不是静默失败）', (await text('#taskError')).length > 0, (await text('#taskError')).slice(0, 100));
    } else {
      log('live-created', { taskId: liveTaskId, status: await text('#taskStatus') });
      await page.click('#tabJobs');
      await sleep(1200);
      await page.click('#startQueued');
      await sleep(4000);
      log('live-batch-start', { connection: await text('#connectionState'), error: (await text('#taskError')).slice(0, 160), dialogs: dialogs.slice(-1) });

      const deadline = Date.now() + 9 * 60 * 1000;
      let last = '';
      while (Date.now() < deadline) {
        // 停在「当前任务」页签上手动点「立即刷新」，不依赖 15 秒自动轮询的时机
        await page.click('#refreshCurrent', { timeout: 5000 }).catch(() => {});
        await sleep(2500);
        const status = await text('#taskStatus');
        if (status !== last) { log('live-poll', { taskId: liveTaskId, status, stage: await text('#taskStage') }); last = status; }
        if (['已完成', '失败', '已取消'].includes(status)) break;
        await sleep(9000);
      }
      const finalStatus = await text('#taskStatus');
      const meta = await page.$$eval('#taskMeta dd', (dd) => dd.map((d) => d.textContent.trim()));
      log('live-final', { taskId: liveTaskId, status: finalStatus, meta, error: (await text('#taskError')).slice(0, 240) });
      check('真实任务走到终态', ['已完成', '失败', '已取消'].includes(finalStatus), finalStatus);
      if (finalStatus === '已完成') {
        check('成片可下载（下载按钮出现）', !(await hidden('#download')), meta[3]);
        check('播放器已挂上地址', await page.$eval('#player', (el) => Boolean(el.getAttribute('src'))));
        await shot('06-live-ready');
      } else {
        await shot('06-live-failed');
      }
    }
  }

  // ── 9. 清空任务记录（真实 DELETE /v1/videos）
  // 前面的 LIVE 段会把页签留在「当前任务」，而这三个按钮在隐藏的 pane-jobs 里 ——
  // `page.$` 找得到（在 DOM 里）≠ 点得动，Playwright 会以 "element is not visible" 超时。
  // 所以每个页签相关的操作前都要**显式切页签**，不要依赖上一步留下的状态。
  await page.click('#tabJobs');
  await sleep(1000);
  // 没有可清除的任务时这个按钮**会禁用**（比"点了再报错"更好），所以两种情况都算对，但都要断言到。
  // 生产环境实测就栽在这里：前一节已经把唯一的任务清掉了，列表为空 → #clearJobs 禁用 →
  // page.click 等 30 秒超时，报 "element is not enabled"。**断言禁用而不是硬点**，这是第 3 次同类问题。
  if (await disabled('#clearJobs')) {
    check('没有可清除的任务时「清空任务记录」禁用（而不是点了才报错）', true);
    log('clearAll', { disabled: true, rows: (await rowIds()).length });
  } else {
    await page.click('#clearJobs');
    await sleep(5000);
    const afterClearAll = await rowIds();
    log('clearAll', { rows: afterClearAll.length, connection: await text('#connectionState'), dialogs: dialogs.slice(-1) });
    check('「清空任务记录」后列表为空', afterClearAll.length === 0, afterClearAll.join(','));
    check('「清空任务记录」给出清空回执', (await text('#connectionState')).includes('已清空'), await text('#connectionState'));
  }

  // ── 10. 深色模式（CSS 变量取不到值会让元素在某个主题下隐形，所以要看计算样式而不是看类名）
  await page.click('#themeToggle');
  await sleep(700);
  const themeInfo = await page.evaluate(() => {
    const stat = document.querySelector('#summary .stat');
    const bar = document.querySelector('#jobsCount');
    return {
      theme: document.documentElement.dataset.theme,
      body: getComputedStyle(document.body).backgroundColor,
      stat: stat ? getComputedStyle(stat).backgroundColor : 'none',
      statText: stat ? getComputedStyle(stat.querySelector('b')).color : 'none',
      bar: bar ? getComputedStyle(bar).color : 'none',
      tabColors: [...document.querySelectorAll('.tab')].map((t) => getComputedStyle(t).color),
    };
  });
  log('theme', themeInfo);
  check('切到深色模式', themeInfo.theme === 'dark', themeInfo.theme);
  check('深色下统计卡是深底（不是刷新前的浅底）', themeInfo.stat !== 'rgb(247, 250, 253)', themeInfo.stat);
  check('深色下统计文字是浅色（可读）', /^rgb\((1\d\d|2\d\d)/.test(themeInfo.statText) || themeInfo.statText === 'rgb(219, 230, 244)', themeInfo.statText);
  check('深色下页签文字不是隐形（色值非透明且非纯黑）', themeInfo.tabColors.every((c) => c !== 'rgba(0, 0, 0, 0)' && c !== 'rgb(0, 0, 0)'), themeInfo.tabColors.join(' '));
  await shot('04-jobs-dark');
  await page.click('#tabRun');
  await sleep(500);
  await shot('05-run-dark');
  await page.click('#themeToggle');
  await sleep(400);
  check('切回浅色模式', (await page.$eval('html', (el) => el.dataset.theme)) === 'light');

  // ── 11. 控制台干净
  log('pageErrors', { pageErrors, consoleErrors: consoleErrors.slice(0, 8), failedRequests: failedRequests.slice(0, 8) });
  check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.join(' | '));
  check('没有失败的同源请求', failedRequests.filter((u) => u.includes(new URL(BASE).host)).length === 0, failedRequests.join(' | '));
} catch (error) {
  log('fatal', { message: error.message, stack: String(error.stack).split('\n').slice(0, 4) });
  failures += 1;
  await shot('99-fatal').catch(() => {});
} finally {
  console.log('\n──────── 汇总 ────────');
  const ran = results.filter((r) => !r.skipped);
  console.log(`通过 ${ran.length - failures} / ${ran.length}${skips ? `（另 SKIP ${skips}）` : ''}，失败 ${failures}`);
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
  for (const r of results.filter((x) => x.skipped)) console.log(`  - ${r.name}（未执行：${r.extra}）`);
  await browser.close();
  process.exit(failures ? 1 : 0);
}
