/**
 * 「登录未确认」账号级防护的单测。
 *
 * 这个测试是为了钉住三件**线上真实吃过亏**的事，任何一件退化都会让故障重现：
 *
 *  ① **分类必须诚实**：2026-09-25 实测同一个只读探测函数在同一天给出两种完全不同的失败——
 *     #420 代理会话失效（页面从未打开，diagnostic.phase=`navigate`）
 *     #408 登录正常（输入框已出现，diagnostic.phase=`entry`，只是时长控件没加载完）
 *     而两者都报「未确认已登录的创作页面」。如果分类不先把「页面没打开」摘出去，
 *     就会把**可用账号**当匿名态去折腾 cookie，而真正坏掉的出口没人修。
 *
 *  ② **必须真的建防护**：这句话原先被 session 分支的正则（含「登录」）吃掉，
 *     session 没有作用域 → failureScope 返回 null → recordGenerationGuard 返回 false
 *     → 一个防护都不建 → 该号永远留在待选池里，每轮白烧最多 3 分钟（60s 等输入框 ×3）。
 *
 *  ③ **必须解得开**：新增作用域若没有对应的解除分支，就会变成第二个「永久锁」
 *     —— 本项目已经吃过一次（submission-journal.js：uncertain 一旦写入就没有代码路径能离开它）。
 *     所以下面专门断言「只读探针能把 login 防护解掉」，并且解除后账号字段回到 available。
 *
 * 全程 :memory:，不碰应用库、不发网络、不读文件。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { classifyFailure, LOGIN_NOT_CONFIRMED_PATTERN, VIDEO_NAVIGATION_FAILURE_PATTERN,
  FAILURE_REASONS } from '../server/dola/generation-analytics.js';
import { GENERATION_GUARD_SCHEMA, failureScope, recordGenerationGuard, hasGenerationGuard,
  clearGenerationGuard, listGenerationGuards, seedHistoricalGenerationGuards } from '../server/dola/generation-guards.js';
import { FAILURE_WEIGHTS } from '../server/dola/account-score.js';

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dola_videos(id INTEGER PRIMARY KEY,account_id,seconds,status,error,created_at,finished_at,updated_at,has_reference_images);
    CREATE TABLE dola_accounts(id INTEGER PRIMARY KEY,status,cookie_hash,proxy,sec_user_id,updated_at,cooldown_until,
      login_state,login_at,login_note,
      native_15s_state,native_15s_at,native_15s_note,native_30s_state,native_30s_at,native_30s_note,
      reference_image_state,reference_image_at,reference_image_note);
    INSERT INTO dola_accounts(id,status,cookie_hash,proxy,sec_user_id,login_state,
      native_15s_state,native_30s_state,reference_image_state)
      VALUES(1,'valid','synthetic','synthetic-proxy','synthetic-user','unknown','unknown','unknown','unknown');`);
  db.exec(GENERATION_GUARD_SCHEMA);
  const add = (id, status, at, error, seconds = 10) => db.prepare(`INSERT INTO dola_videos
    (id,account_id,seconds,status,error,created_at,finished_at,updated_at) VALUES(?,1,?,?,?,?,?,?)`)
    .run(id, seconds, status, error, at, at, at);
  const account = () => db.prepare('SELECT * FROM dola_accounts WHERE id=1').get();
  const row = id => db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
  return { db, add, account, row };
}

/** 让页面真的"加载成功"的探针结果：认出原生 10 秒控件（#420 上的实测形态）。 */
const composerProbe = (seconds = 10) => ({
  ok: true, state: 'available', pageLoaded: true,
  seconds, uiSeconds: seconds,
  model: seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5',
  native: true, rewriteCarrier: false,
});

// ───────────────────────── ① 分类诚实性 ─────────────────────────

test('★ 页面没打开（死代理）绝不能判成登录问题 —— 必须归到 proxy', () => {
  // 逐字取自 2026-09-25 实测（#420，udearproxy 会话失效）：
  //   page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.dola.com/chat/
  // 判错的代价：可用账号被当成"未登录"去换 cookie，而真正坏掉的出口没人修。
  for (const text of [
    '页面未能加载（代理或网络故障），未做登录判定：page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.dola.com/chat/',
    '提交阶段失败：页面未能加载（代理或网络故障），未做登录判定：net::ERR_CONNECTION_RESET',
    'net::ERR_PROXY_CONNECTION_FAILED',
  ]) {
    assert.equal(classifyFailure(text).code, 'proxy', text);
    assert.notEqual(classifyFailure(text).code, 'login', text);
    assert.notEqual(classifyFailure(text).code, 'session', text);
  }
  assert.ok(VIDEO_NAVIGATION_FAILURE_PATTERN.test('net::ERR_TUNNEL_CONNECTION_FAILED'));
});

test('★ 「未确认已登录」才是 login；输入框已出现只是时长控件没加载 → capability', () => {
  // 生成链路的原文（generator.js）
  assert.equal(classifyFailure('提交阶段失败：未确认已登录的创作页面（输入框未出现）').code, 'login');
  assert.equal(classifyFailure('未确认已登录的创作页面（输入框未出现）').code, 'login');
  // 只读探测的原文（native-capability.js:156 的包装）
  assert.equal(classifyFailure('原生 15 秒能力探测未完成：未确认已登录的创作页面').code, 'login');

  // ⚠️ 这一条是**最容易判错**的：它同样描述"创作条"，但输入框已经出现 = 已登录，
  //    只是时长控件没加载完。判成 login 会冤枉一个登录正常的号（#408/#410 的实测形态）。
  for (const text of [
    '原生 15 秒能力探测未完成：已点击视频生成入口，但创作条时长控件未完成加载',
    '原生 15 秒能力探测未完成：页面时长控件未完成加载',
    '原生 15 秒能力探测未完成：页面模型控件未完成加载',
  ]) {
    assert.equal(classifyFailure(text).code, 'capability', text);
    assert.equal(LOGIN_NOT_CONFIRMED_PATTERN.test(text), false, text);
  }

  // 输入框加载后消失属于页面抖动，登录态早已被证明过 —— 不能再判 login。
  // 顺便钉住一个真实的措辞陷阱：这句必须**不含**裸词「登录」，
  // 因为 session 分支的正则就是抓裸词「登录」，一句善意的澄清（如「非登录问题」）
  // 会把分类带偏成 session —— 写这个测试时就实际踩到了。
  const churn = '创作输入框加载后消失，刷新后仍未恢复（页面抖动，非账号问题）';
  assert.notEqual(classifyFailure(churn).code, 'login');
  assert.notEqual(classifyFailure(churn).code, 'session');

  // 真正的身份问题仍然走 session（别把 session 整个弄丢）
  assert.equal(classifyFailure('现场账号身份不一致').code, 'session');
  assert.equal(classifyFailure('unexpected cookie_secret_value').code, 'session');
});

test('login 类已进权重表与文案表（漏登记会被这里和 account-score 一起拦住）', () => {
  assert.ok(FAILURE_REASONS.login, 'FAILURE_REASONS 缺 login');
  assert.ok(FAILURE_WEIGHTS.login, 'FAILURE_WEIGHTS 缺 login');
  assert.match(FAILURE_REASONS.login.label, /登录/);
  // 登录拿不到创作面板最像账号本身的问题，罚分不应轻于 session
  assert.ok(FAILURE_WEIGHTS.login >= FAILURE_WEIGHTS.session);
  assert.ok(FAILURE_WEIGHTS.login <= 10);
});

test('★ 判定登录态只能靠文案分类，不能靠 result.reason（外层超时会把它盖掉）', () => {
  // 实测 #408：探针整体超时 → 外层把 reason 覆写成 VIDEO_PREPARATION_TIMEOUT，
  // 把更具体的"输入框没出现"盖掉；但 error 文案仍然是那句真话。
  // 所以 routes/dola.js 用 classifyFailure(error) 判 login，而不是 reason === 'VIDEO_PAGE_NOT_READY'。
  const timedOut = {
    ok: false, state: 'unknown', pageLoaded: true,
    reason: 'VIDEO_PREPARATION_TIMEOUT',
    error: '原生 15 秒能力探测未完成：未确认已登录的创作页面',
  };
  assert.equal(classifyFailure(timedOut.error).code, 'login', '文案口径必须仍然判出 login');
  assert.notEqual(timedOut.reason, 'VIDEO_PAGE_NOT_READY', '这正是 reason 不可信的形态');

  // 反过来：reason 看起来像登录问题，但文案说明输入框已出现 → 不能判 login
  const controls = {
    ok: false, state: 'unknown', pageLoaded: true,
    reason: 'VIDEO_CONTROLS_NOT_READY',
    error: '原生 15 秒能力探测未完成：已点击视频生成入口，但创作条时长控件未完成加载',
  };
  assert.notEqual(classifyFailure(controls.error).code, 'login');

  // 页面没打开时，无论 reason 是什么都不该判 login
  const nav = {
    ok: false, state: 'unknown', pageLoaded: false,
    reason: 'VIDEO_NAVIGATION_FAILED',
    error: '页面未能加载（代理或网络故障），未做能力判定：net::ERR_TUNNEL_CONNECTION_FAILED',
  };
  assert.notEqual(classifyFailure(nav.error).code, 'login');
});

// ───────────────────────── ② 防护必须建得起来 ─────────────────────────

test('★ 登录失败建账号级防护，并解开原先「永远不建防护」的死结', (t) => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-25T02:00:00.000Z', '提交阶段失败：未确认已登录的创作页面（输入框未出现）');
  assert.equal(failureScope(h.row(1)), 'login');

  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), true);
  const guard = listGenerationGuards(h.db)[0];
  assert.equal(guard.scope, 'login');
  assert.equal(guard.reason_code, 'login');
  assert.equal(guard.label, '登录态');
  // 账号字段必须写成有证据的否定结论，而不是"没确认"
  assert.equal(h.account().login_state, 'unavailable');
  assert.match(h.account().login_note, /创作输入框未出现/);
  // 账号本身不能被判定失效（对照参考站：限流/异常都不写 invalid）
  assert.equal(h.account().status, 'valid');

  // ★ 账号级：10 秒也好、15 秒也好、参考图任务也好，全都不该再选它
  for (const seconds of [10, 15, 20, 30]) {
    assert.equal(hasGenerationGuard(h.db, 1, seconds), true, `${seconds}s 应被拦`);
  }
  assert.equal(hasGenerationGuard(h.db, 1, 10, true), true, '参考图任务也应被拦');
  assert.equal(hasGenerationGuard(h.db, 2, 10), false, '别的账号不受影响');

  // 重复记账不产生第二条；且旧的失败回调不能覆盖更新的既有事实
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), false);
  assert.equal(listGenerationGuards(h.db).length, 1);
});

test('更新的、已验证的登录探测可以压过更早的失败（不会误封）', (t) => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-25T02:00:00.000Z', '未确认已登录的创作页面（输入框未出现）');
  h.db.exec("UPDATE dola_accounts SET login_state='available',login_at='2026-09-25T03:00:00.000Z'");
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), false);
  assert.equal(listGenerationGuards(h.db).length, 0);
});

test('历史回填不会用「过期话术」封号（dola_videos 里没有任务就不该凭空建防护）', (t) => {
  const h = fixture(t);
  // #408–412 的真实形态：只有 native_15s_note 一句 09-24 的旧文案，没有任何任务行。
  // 那句旧的「未确认已登录」不可信（同一天 #408 再测已经能加载出输入框），
  // 所以回填必须什么都不做 —— 宁可不封，也不能拿旧话术封掉可能是好号的账号。
  h.db.exec(`UPDATE dola_accounts SET native_15s_state='unknown',
    native_15s_note='原生 15 秒能力探测未完成：未确认已登录的创作页面',
    native_15s_at='2026-09-24T16:45:54.240Z'`);
  assert.equal(seedHistoricalGenerationGuards(h.db), 0);
  assert.equal(listGenerationGuards(h.db).length, 0);
  assert.equal(h.account().login_state, 'unknown');
});

test('未取消/已取消的任务不能污染账号', (t) => {
  const h = fixture(t);
  h.add(1, 'cancelled', '2026-09-25T02:00:00.000Z', '未确认已登录的创作页面（输入框未出现）');
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), false);
  assert.equal(h.account().login_state, 'unknown');
});

// ───────────────────────── ③ 防护必须解得开（反永久锁）─────────────────────────

test('★★ 只读探针能解除登录防护——这是防「永久锁」的关键断言', (t) => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-25T02:00:00.000Z', '未确认已登录的创作页面（输入框未出现）');
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), true);
  assert.equal(hasGenerationGuard(h.db, 1, 10), true);
  assert.equal(h.account().login_state, 'unavailable');

  const guard = listGenerationGuards(h.db)[0];
  const account = h.account();

  // 证据不足一律不解：探测本身没跑成 / 只报了个笼统的 available
  assert.equal(clearGenerationGuard(h.db, guard, account, { ok: false, state: 'unknown' }), false);
  // 认出了控件但没给出合法时长 → 不足以证明"创作面板可用"
  assert.equal(clearGenerationGuard(h.db, guard, account, { ok: true, state: 'available' }), false);
  assert.equal(clearGenerationGuard(h.db, guard, account,
    { ...composerProbe(10), seconds: null, uiSeconds: null }), false);
  // 20/30 秒走改写载体：rewriteCarrier=true 同样说明控件被认出来了，应当接受
  assert.equal(hasGenerationGuard(h.db, 1, 10), true, '证据不足时防护必须还在');

  // ★ 真凭据：拿到了创作输入框 + 认出一个合法时长控件
  assert.equal(clearGenerationGuard(h.db, guard, account, composerProbe(10), '2026-09-25T03:00:00.000Z'), true);
  assert.equal(hasGenerationGuard(h.db, 1, 10), false, '解除后必须真的能再被选中');
  for (const seconds of [10, 15, 20, 30]) {
    assert.equal(hasGenerationGuard(h.db, 1, seconds), false, `${seconds}s 也该解开了`);
  }
  // 账号字段同步回到可用，且认证信息没被改动
  assert.equal(h.account().login_state, 'available');
  assert.equal(h.account().status, 'valid');
  assert.equal(h.account().cookie_hash, 'synthetic');
  // 解除后可再被选中 —— 用「无防护」这个判据表达，避免依赖 candidates() 的内部实现
  assert.equal(listGenerationGuards(h.db).length, 0);
});

test('账号凭证/代理/身份变了就不认旧探测，也不解旧防护', (t) => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-25T02:00:00.000Z', '未确认已登录的创作页面（输入框未出现）');
  recordGenerationGuard(h.db, h.row(1), h.account());
  const guard = listGenerationGuards(h.db)[0];
  const stale = h.account();
  h.db.exec("UPDATE dola_accounts SET proxy='another-proxy'");
  assert.equal(clearGenerationGuard(h.db, guard, stale, composerProbe(10)), false);
  assert.equal(clearGenerationGuard(h.db, guard, h.account(), composerProbe(10)), true);
});

test('有任务在飞时不解防护（防只读探测与生成抢同一个浏览器）', (t) => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-25T02:00:00.000Z', '未确认已登录的创作页面（输入框未出现）');
  recordGenerationGuard(h.db, h.row(1), h.account());
  const guard = listGenerationGuards(h.db)[0], account = h.account();
  h.add(2, 'generating', '2026-09-25T02:30:00.000Z', '');
  assert.equal(clearGenerationGuard(h.db, guard, account, composerProbe(10)), false);
  h.db.exec("UPDATE dola_videos SET status='ready' WHERE id=2");
  assert.equal(clearGenerationGuard(h.db, guard, account, composerProbe(10)), true);
});

test('未知作用域仍然拒绝解除（不能靠加个新 scope 绕过证据）', (t) => {
  const h = fixture(t);
  h.db.prepare(`INSERT INTO dola_generation_guards(account_id,scope,reason_code,source_task_id,blocked_at,cleared_at)
    VALUES(1,'made-up-scope','other',1,'2026-09-25T02:00:00.000Z',NULL)`).run();
  const guard = h.db.prepare("SELECT * FROM dola_generation_guards WHERE scope='made-up-scope'").get();
  assert.equal(clearGenerationGuard(h.db, guard, h.account(), composerProbe(10)), false);
});
