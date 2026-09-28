/**
 * Executes the current generator with every external dependency replaced.
 * SQLite is :memory: only; no application DB import, real cookies, browser,
 * ffprobe, network, archive/cache reads or writes. No live server is started.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as policy from '../server/dola/generation-policy.js';
// generator.js 会剥离 import 后在沙箱里跑，所以它引用到的每个模块级标识都必须
// 由 box 提供。载体映射 / DURATION_SOURCE 都来自这个模块 —— 漏了会在运行时才炸
// ReferenceError，而外层 catch 会把它包成"只读预检异常"，症状是"十几个用例一起红、
// 报错信息完全看不出根因"（2026-09-26 实际踩到）。
import * as duration from '../server/dola/generation-duration.js';
import { installVideoRequestAdapter, rewriteVideoDurationBody } from '../server/dola/generation-request.js';
import { createGenerationWireGate } from '../server/dola/generation-wire.js';
import * as journal from '../server/dola/submission-journal.js';
import { chooseSubmitMode } from '../server/dola/scheme-a.js';
import { identifyGenerationRequest, createGenerationAckObserver } from '../server/dola/generation-ack.js';
import { GENERATION_GUARD_SCHEMA, hasGenerationGuard, recordGenerationGuard } from '../server/dola/generation-guards.js';
// 真函数（不是 stub）：见下面 box 里 upstreamPrompt 的注入说明。
import { upstreamPrompt as realUpstreamPrompt } from '../server/dola/prompt-wrap.js';
// geo 封锁码表（与限流码分属不同集合，见 geo-block.js 文件头）。
// ★ 这里**整模块注入**而不是挑几个名字：本 harness 会把 generator.js 的 import 行整段剥掉、
//   再由 box 提供依赖，漏一个标识符就是运行时 ReferenceError（文件头为这个坑记过两次账）。
//   整模块展开后，geo-block.js 将来新增导出也不必回来补 box。
import * as geoBlock from '../server/dola/geo-block.js';
// 出口地区（声明 vs 实测）的纯逻辑 + 实测入口。同样是**整模块注入**。
// ⚠️ `probeExitCountry` 不能用真函数 —— 它会走 undici 出网，而本 harness 承诺"无网络"。
//    所以 box 里给的是 stub，由 `overrides.exitProbe` 驱动（默认 ok:false = 探不出来），
//    于是默认行为 = fail-open = **与加这个守卫之前完全一致**，不会污染既有用例。
import * as exitRegion from '../server/dola/exit-region.js';
// ★ 真排名函数。沙箱里 `rankCandidates` 默认被换成恒等 stub（见下面 box 的说明），
//   所以"排序真的按新首键生效"这件事必须在某个用例里把真函数装回去才测得出来 ——
//   否则"字段挂上了但排序没生效"（= 死锁原样复发）这个 bug 会静默通过。
//   generator.js 被剥掉 import 后引用的是自由标识符 `rankCandidates`，运行时解析到
//   box 上的同名属性，所以用例里改 `box.rankCandidates` 真的能改变行为。
import { rankCandidates as realRankCandidates } from '../server/dola/account-score.js';

const source = readFileSync(new URL('../server/dola/generator.js', import.meta.url), 'utf8');
const code = source.replace(/^import[\s\S]*?;\n/gm, '').replace(/\bexport /g, '')
  .replaceAll('import.meta.url', JSON.stringify('file:///synthetic-only/generator.js'));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const liveProfile = () => ({ ok: true, status: 200, code: 0, membershipLevel: 'pro', hasActiveSubscription: true, entityId: 'synthetic-dola' });
const artifact = () => ({ path: '/synthetic-only/not-a-real-file.mp4', bytes: 4096 });
/** 提示词包装测试用的固定前缀（wrap:true 时生效）。 */
const WRAP_PREFIX = 'WRAP_PREFIX_ONLY';

/** 默认代理：**故意不含任何地区声明**，所以 `declaredRegionOf()` 返回 null ⇒ 出口守卫不参与判定。 */
const DEFAULT_PROXY = 'http://proxy.example.invalid:8080';

function fixture(t, { owner = null, seconds = 30, wrap = false, proxy = DEFAULT_PROXY } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dola_videos (
    id INTEGER PRIMARY KEY,account_id,account_label,conversation_id,prompt,ratio,
    -- ⚠️ mode 必须在：createVideoTask 的 INSERT 里带了它（真库 db.js 的 dola_videos 也有
    --    mode TEXT NOT NULL DEFAULT 'standard'）。2026-09-27 本地跑这个文件时踩到 ——
    --    少这一列会让**所有走到"建任务"的用例**一起红，报错是 'no such column: mode'，
    --    症状看起来像"生成器坏了"，实际只是夹具比源码旧了一列。
    mode TEXT NOT NULL DEFAULT 'standard',seconds,force_seconds,status,stage,
    watermarked_url,unwatermarked_url,unwatermark_note,is_unwatermarked,local_path,local_bytes,duration_sec,bytes,error,
    owner_token_id,owner_prefix,charge_ref,has_reference_images,reference_image_count,strict_account,created_by,created_at,updated_at,finished_at,
    cleared_at TEXT);
    CREATE TABLE dola_accounts (id INTEGER PRIMARY KEY,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,
    cooldown_until,last_used_at,updated_at,last_check_at,last_error,quota_remaining,quota_source,quota_at,exit_ip,
    login_state TEXT NOT NULL DEFAULT 'unknown', login_at TEXT, login_note TEXT NOT NULL DEFAULT '',
    native_15s_state TEXT NOT NULL DEFAULT 'available', native_15s_at TEXT, native_15s_note TEXT NOT NULL DEFAULT '',
    native_30s_state TEXT NOT NULL DEFAULT 'available', native_30s_at TEXT, native_30s_note TEXT NOT NULL DEFAULT '',
    reference_image_state TEXT NOT NULL DEFAULT 'available', reference_image_at TEXT, reference_image_note TEXT NOT NULL DEFAULT '');
    CREATE TABLE point_transactions (id INTEGER PRIMARY KEY,token_id,kind,ref,delta);
    CREATE TABLE dola_rate_limit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,account_id,video_id,exit_ip,cooldown_until,detail,created_at);`);
  db.prepare(`INSERT INTO dola_accounts (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES (1,'synthetic-account','SYNTHETIC_ONLY','valid',?,'synthetic-hash','synthetic-dola','pro','192.0.2.10','available')`).run(proxy);
  db.prepare(`INSERT INTO dola_videos (id,account_id,prompt,seconds,force_seconds,status,owner_token_id,charge_ref)
    VALUES (1,1,'synthetic-only',?,?,'queued',?,'')`).run(seconds, seconds === 30 ? 30 : null, owner);
  const calls = { profile: 0, preflight: 0, submit: 0, chain: 0, resolve: 0, archive: 0, probe: 0, containerProbe: 0, cookies: 0, exitProbe: 0, refunds: [], prompts: [] };
  db.exec(GENERATION_GUARD_SCHEMA);
  db.exec(journal.SUBMISSION_JOURNAL_SCHEMA);
  const immediate = [];
  const overrides = {
    profile: async () => liveProfile(),
    // 出口实测的默认值 = **探不出来**。这是刻意的：
    // 守卫在探不出来时必须 fail-open，所以默认行为与"没有这个守卫"完全一致，
    // 既有用例不会被新逻辑悄悄改掉。要测守卫本身，用例里显式覆盖它。
    exitProbe: async () => ({ ok: false, reason: 'isolated_test' }),
    preflight: async (_cookies, options) => {
      const s = options.seconds;
      const uiSeconds = s === 30 ? 15 : s === 20 ? 10 : s;
      const rewriteCarrier = uiSeconds !== s;
      return { ok: true, state: 'available', seconds: s,
        uiSeconds, native: !rewriteCarrier, rewriteCarrier,
        model: s === 15 ? 'seedance_v2.0' : 'seedance_v2.5' };
    },
    submit: async () => ({ conversationId: '1234567890123', cap: [] }),
    chain: async () => ({ ok: true, text: 'https://media.example.invalid/synthetic-output.mp4', json: {} }),
    resolve: async () => ({ videos: [], attempts: [] }),
    archive: async () => artifact(),
    probe: async () => ({ seconds, status: 'ok' }),
    containerProbe: async () => null,
  };
  const deny = () => { throw new Error('isolated_test_forbidden_io'); };
  const box = {
    hasGenerationGuard, recordGenerationGuard,
    ...journal,
    resolveFfprobePath: async () => '/synthetic-only/ffprobe',
    // 与 server/dola/scheme-a.js 的 resolveSubmitMode 同契约（纯函数）；隔离测试不走真实 scheme-a 提交。
    resolveSubmitMode: mode => (mode === 'scheme-a' ? 'scheme-a' : 'browser'),
    submitViaSchemeA: deny,
    chooseSubmitMode,
    ...geoBlock, ...exitRegion, ...policy, ...duration, installVideoRequestAdapter, rewriteVideoDurationBody, prepareNativeThirtySecondComposer: deny, prepareNativeVideoComposer: deny, prepareReferenceImageComposer: deny, listReferenceImages: async () => [], cleanupReferenceImages: async () => {},
    // 出口实测入口。stub（不是真函数）：真函数会走 undici 出网，而本 harness 承诺无网络。
    // 默认 ok:false ⇒ fail-open ⇒ 与加守卫之前行为一致。
    probeExitCountry: async (...args) => { calls.exitProbe++; return overrides.exitProbe(...args); },
    db, path, fileURLToPath, promisify, execFile: deny, fs: new Proxy({}, { get: () => deny }),
    getSetting: (_key, fallback) => fallback, getPlaywright: deny, proxyOf: acc => ({ server: acc.proxy }), fetch: deny, startSocksBridge: deny,
    probeNativeVideoViaBrowser: async (...args) => { calls.preflight++; assert.equal(args[1].proxyUrl, proxy); return overrides.preflight(...args); },
    parseCookies: value => { assert.equal(value, 'SYNTHETIC_ONLY'); calls.cookies++; return { synthetic: 'synthetic' }; },
    fetchProfile: async (...args) => { calls.profile++; assert.equal(args[1].proxy, proxy); return overrides.profile(...args); },
    pullChain: async (...args) => { calls.chain++; assert.equal(args[2].proxy, proxy); return overrides.chain(...args); },
    extractUnwatermarked: async (...args) => { calls.resolve++; return overrides.resolve(...args); },
    parseVideoQuotaReceipt: () => ({}), DOLA_HEADERS: {},
    // prompt-wrap.js 的入口（提示词前缀/中缀/后缀包装）。
    // ⚠️ 同上：这个 harness 会把 generator.js 的**所有 import 行剥掉**再由本 box 提供依赖，
    //    漏一个，被切的代码里就是 ReferenceError。这次正是踩在这里 —— 漏掉 upstreamPrompt 后
    //    23 个用例集体失败（提交路径整个断掉），而报错信息（"限流账号应进入冷却"之类）
    //    完全指向不了真正的原因，非常难查。
    // 这里注入的是**真函数**而不是 stub，两个原因：
    //   ① 真函数能连"调用点形状"一起验 —— 谁把 `upstreamPrompt(...).text` 写成忘了 `.text`，
    //      会在这里炸出来，而不是默默把 "[object Object]" 当提示词发给上游；
    //   ② 设置读取器换成假的：隔离测试里 db.js 的模块级 `db` 是 null，真去读设置会 TypeError。
    //      假读取器默认只回 fallback（= 开关关），wrap:true 时才开启并给一个固定前缀。
    upstreamPrompt: prompt => realUpstreamPrompt(prompt, {
      readSetting: (key, fallback) => {
        if (!wrap) return fallback;
        if (key === 'gateway_prompt_wrap_enabled') return 'true';
        if (key === 'gateway_prompt_prefix') return WRAP_PREFIX;
        return fallback;
      },
    }),
    // chain-text-rules.js 的两个入口（上游文本分类 + 漂移计数）。
    // ⚠️ 这个 harness 会把 generator.js 的**所有 import 行剥掉**，再由本 box 提供依赖；
    //    漏一个，被切的代码里就会 ReferenceError，表现是整条轮询断掉、任务永远停在 generating。
    //    分类器本身有专门单测（test/chain-text-rules.mjs），这里只要不炸即可。
    classifyChainText: () => ({ rule: 'none', evidence: 'isolated_test', classifiable: false }),
    recordChainText: result => result,
    // account-score.js 的 8 个入口（失败分调度）。同上：漏一个整条切片就 ReferenceError。
    //    排序/节流/记账各有专门单测（test/account-score.mjs），这里只要行为不错误：
    //    rankCandidates 恒等（保持原 last_used_at 轮转顺序，与改前行为一致）、
    //    submitThrottle 不节流、记账 noop。
    recordTaskSuccess: () => {},
    recordTaskFailure: () => ({ code: 'other', weight: 5, failScore: 5 }),
    markAccountSubmitted: () => {},
    rankCandidates: accounts => accounts,
    submitThrottle: () => ({ throttled: false, waitSeconds: 0 }),
    routeRow: (account, rank) => ({ id: account?.id, rank }),
    FAIL_SCORE_CAP: 50,
    FAIL_SCORE_DECAY_PER_HOUR: 10,
    settleFailedVideoRefund: (_db, row) => { assert.equal(row.status, 'failed'); calls.refunds.push(row.id); return { refunded: true }; },
    Date, URL, AbortController, Buffer, console: { log() {}, warn() {}, error() {} },
    setImmediate: fn => immediate.push(fn), setTimeout: deny, clearTimeout() {},
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  box.originalSubmit = box.submitViaBrowser;
  box.originalArchive = box.archiveVideo;
  box.submitViaBrowser = async (...args) => { calls.submit++; calls.prompts.push(args[1]?.prompt); return overrides.submit(...args); };
  box.archiveVideo = async (...args) => { calls.archive++; assert.equal(args[1].proxyUrl, undefined); return overrides.archive(...args); };
  box.probeVideoDuration = async (...args) => { calls.probe++; return overrides.probe(...args); };
  box.probeMp4ContainerDuration = async (...args) => { calls.containerProbe++; return overrides.containerProbe(...args); };
  return { db, box, calls, overrides, immediate,
    row: () => db.prepare('SELECT * FROM dola_videos WHERE id=1').get(),
    run: () => box.run(1, { maxMin: 1 }), cancel: () => box.cancelVideoTask(1),
  };
}

test('candidates() 挂上 upstream_reached 且排序真按「有实绩者优先」——挂着不生效就是死锁复发', async t => {
  const h = fixture(t);
  // 账号 1：**有实绩**（一条带 conversation_id 的提交），但记录在案的额度只剩 0。
  //   ⚠️ quota_at 故意留在往日：`hasConfirmedZeroVideoQuota` 只认「今日已确认」，
  //      否则这个号会被选号闸拦掉，就测不到排序了（那正是生产里 451/452 的情形）。
  h.db.prepare("UPDATE dola_videos SET conversation_id='38410000000000001' WHERE id=1").run();
  h.db.prepare(`UPDATE dola_accounts SET quota_remaining=0, quota_source='generation_receipt',
    quota_at='2020-01-01T00:00:00.000Z' WHERE id=1`).run();
  // 账号 2：**从未到达过上游**，额度却是满的 4 —— 旧口径下它会被排在前面。
  h.db.prepare(`INSERT INTO dola_accounts
    (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,quota_remaining)
    VALUES (2,'synthetic-account-2','SYNTHETIC_ONLY','valid',?,'synthetic-hash','synthetic-dola','pro','192.0.2.11',4)`)
    .run(DEFAULT_PROXY);
  // 装回真排名函数（沙箱默认是恒等 stub）。
  h.box.rankCandidates = realRankCandidates;

  const list = h.box.candidates(null, 30);
  const byId = new Map(list.map((a) => [a.id, a]));
  assert.equal(byId.get(1).upstream_reached, 1, '有 conversation_id 的账号必须被算成到达过上游');
  assert.equal(byId.get(2).upstream_reached, 0, '没有 conversation_id 的账号必须算 0');
  assert.deepEqual(list.map((a) => a.id), [1, 2],
    '额度 0 的活号必须排在额度 4 的死号前面 —— 旧口径（额度 DESC）会给 [2,1]');
});

test('archive and ffprobe remain resolving; only matching native-duration media becomes ready', async t => {
  const h = fixture(t), archive = deferred(), probe = deferred();
  h.overrides.archive = () => archive.promise;
  h.overrides.probe = () => probe.promise;
  const work = h.run(); await flush();
  assert.equal(h.row().status, 'resolving'); assert.equal(h.calls.archive, 1);
  archive.resolve(artifact()); await flush();
  assert.equal(h.row().status, 'resolving'); assert.equal(h.calls.probe, 1);
  probe.resolve({ seconds: 29.97, status: 'ok' }); await work;
  assert.equal(h.row().status, 'ready'); assert.equal(h.row().duration_sec, 29.97);
  assert.deepEqual(h.calls.refunds, []);
});

for (const condition of ['archive', 'unknown-duration', 'mismatch']) {
  test(`${condition} fails final acceptance and invokes failure settlement once`, async t => {
    const h = fixture(t);
    if (condition === 'archive') h.overrides.archive = async () => null;
    if (condition === 'unknown-duration') h.overrides.probe = async () => ({ seconds: null, status: 'unreadable' });
    if (condition === 'mismatch') h.overrides.probe = async () => ({ seconds: 10, status: 'ok' });
    await h.run();
    assert.equal(h.row().status, 'failed'); assert.deepEqual(h.calls.refunds, [1]);
    h.box.fail(1, 'late failure'); assert.deepEqual(h.calls.refunds, [1]);
  });
}

test('ffprobe missing falls back to container probe and becomes ready with a note', async t => {
  const h = fixture(t);
  h.overrides.probe = async () => ({ seconds: null, status: 'tool_missing' });
  h.overrides.containerProbe = async () => 29.97;
  await h.run();
  assert.equal(h.row().status, 'ready');
  assert.equal(h.row().duration_sec, 29.97);
  assert.equal(h.calls.containerProbe, 1);
  assert.match(h.row().stage, /MP4 容器解析/);
  assert.deepEqual(h.calls.refunds, []);
});

test('ffprobe missing with failed container probe stays failed without misjudging', async t => {
  const h = fixture(t);
  h.overrides.probe = async () => ({ seconds: null, status: 'tool_missing' });
  h.overrides.containerProbe = async () => null;
  await h.run();
  assert.equal(h.row().status, 'failed');
  assert.equal(h.calls.containerProbe, 1);
  assert.match(h.row().error, /ffprobe 不可用/);
  assert.deepEqual(h.calls.refunds, [1]);
});

for (const phase of ['profile', 'submit', 'chain', 'resolve', 'archive', 'probe']) {
  test(`cancel during ${phase} cannot be overwritten by late completion or refunded as failure`, async t => {
    const h = fixture(t), gate = deferred();
    const original = h.overrides[phase];
    h.overrides[phase] = () => gate.promise;
    const work = h.run(); await flush();
    assert.equal(h.calls[phase], 1);
    h.cancel(); assert.equal(h.row().status, 'cancelled');
    gate.resolve(await original()); await work;
    assert.equal(h.row().status, 'cancelled'); assert.deepEqual(h.calls.refunds, []);
    h.box.fail(1, 'late failure'); h.box.setStage(1, 'ready', 'late success');
    assert.equal(h.row().status, 'cancelled');
  });
}

test('cancel during submission rejection does not fail or refund the cancelled task', async t => {
  const h = fixture(t), gate = deferred(); h.overrides.submit = () => gate.promise;
  const work = h.run(); await flush(); h.cancel(); gate.reject(new Error('synthetic rejection'));
  await work; assert.equal(h.row().status, 'cancelled'); assert.deepEqual(h.calls.refunds, []);
});

// ---------------------------------------------------------------- 自动换号轮询

function addRotationAccount(h, id, exitIp, proxy = DEFAULT_PROXY) {
  h.db.prepare(`INSERT INTO dola_accounts (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES (?,'synthetic-account','SYNTHETIC_ONLY','valid',?,'synthetic-hash-${id}','synthetic-dola','pro',?,'available')`)
    .run(id, proxy, exitIp);
}

const signatureRejectedSubmit = () => ({ conversationId: null, streamErrors: [{ code: 710022002, error_msg: '当前服务访问频繁' }], cap: [] });
// 生产码表暂时没有确认的限流码；仅在当前测试 VM 内注入，保持真限流路径的回归覆盖。
const SYNTHETIC_RATE_LIMIT_CODE = 799999001;
const rateLimitedSubmit = () => ({ conversationId: null, streamErrors: [{ code: SYNTHETIC_RATE_LIMIT_CODE, error_msg: 'synthetic rate limit' }], cap: [] });
function enableSyntheticRateLimit(h) {
  vm.runInContext(`RATE_LIMIT_CODES.add(${SYNTHETIC_RATE_LIMIT_CODE})`, h.box);
}

function trackRotations(h) {
  const calls = [], original = h.box.switchTaskAccount;
  h.box.switchTaskAccount = async (id, options) => {
    const result = await original(id, options);
    calls.push({ id, excludeIds: Array.from(options.excludeIds), nextId: result.account?.id ?? null });
    return result;
  };
  return calls;
}

/**
 * `710022002` 文案的**语义边界**（两条不变式，对用户文案、stage、审计 detail 一律适用）。
 *
 * ⚠️ 2026-09-28 改写（原断言是 `/验签\/参数.*拒/`）。
 *
 * 为什么必须改：原来那条断言把成因**写死**成"验签/参数被拒"，
 * 而生产上 4 条任务的真正原因是**代理出口地区错配**（代理声明 HK、实测落地 VE/PS）——
 * 那句话把排查方向指反了，是本轮用户报障的直接来源。
 * 现在文案必须由**当场实测**决定，所以边界换成两条：
 *   ① **不许**再断言"验签/参数被上游拒绝"（除非实测证明出口一致，
 *      而本 harness 的出口实测默认是"探不出来"，所以这里永远不许出现）；
 *   ② 不许说成限流。
 *
 * ★ 这是**语义边界**，不是措辞偏好。放宽它们等于允许文案再次断言没验证过的成因。
 */
function assertNoUnverifiedCause(value) {
  assert.doesNotMatch(value, /验签\/参数被上游拒绝/);
  // ⚠️ 限流要按**断言句式**判，不能按"出现这四个字"判：
  //    geo / 出口地区的专属引导词里都含「那也不是上游限流」这种**否定句**，
  //    宽松匹配会把它们误判成"文案说成了限流"。真正的限流句式是「上游限流：当前服务访问频繁」。
  assert.doesNotMatch(value, /访问频繁/);
  assert.doesNotMatch(value, /上游限流[：:]/);
}

/**
 * 给**用户看**的拒绝文案：在语义边界之上，还要求写明 code。
 *
 * 为什么单独一层：这条消息会原样显示在前台任务表格里，运维要能拿着 code 去对照上游回执。
 *
 * ⚠️ 别拿它去断言 `dola_rate_limit_events.detail` 或 `stage` 这类**短字段** ——
 *    那些位置有自己的承载方式（code 在事件表里是**独立列**），把 code 再塞一遍只是冗余。
 *    对它们用 `assertNoUnverifiedCause` 即可。（2026-09-28 就是因为没区分这两者，
 *    一次性把 7 个原本通过的用例判红 —— 断言过宽和断言过窄一样是 bug。）
 */
function assertSignatureRejectionText(value) {
  assert.match(value, /710022002/);
  assertNoUnverifiedCause(value);
}

async function drainImmediate(h) {
  for (const fn of h.immediate.splice(0)) await fn();
  await flush();
}

test('rate-limited submission cools the account, auto-rotates and retries', async t => {
  const h = fixture(t);
  enableSyntheticRateLimit(h);
  addRotationAccount(h, 2, '192.0.2.11');
  let submits = 0;
  h.overrides.submit = async () => (++submits === 1 ? rateLimitedSubmit() : { conversationId: '1234567890123', cap: [] });
  await h.run();
  const acc1 = h.db.prepare('SELECT * FROM dola_accounts WHERE id=1').get();
  assert.ok(acc1.cooldown_until > new Date().toISOString(), '限流账号应进入冷却');
  assert.equal(h.row().account_id, 2);
  assert.equal(h.row().status, 'queued');
  assert.match(h.row().stage, /自动换号/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_rate_limit_events WHERE video_id=1').get().c, 1);
  assert.deepEqual(h.calls.refunds, [], '换号重试中途不应退款');
  await drainImmediate(h);
  assert.equal(h.row().status, 'ready');
  assert.equal(h.row().account_id, 2);
  assert.equal(submits, 2);
  assert.deepEqual(h.calls.refunds, []);
});

test('strict acceptance task never auto-rotates on rate limit', async t => {
  const h = fixture(t);
  enableSyntheticRateLimit(h);
  addRotationAccount(h, 2, '192.0.2.11');
  h.db.prepare('UPDATE dola_videos SET strict_account=1 WHERE id=1').run();
  h.overrides.submit = rateLimitedSubmit;
  await h.run();
  assert.equal(h.row().status, 'failed');
  assert.match(h.row().error, /不自动换号/);
  assert.equal(h.row().account_id, 1);
  assert.deepEqual(h.calls.refunds, [1]);
  assert.equal(h.immediate.length, 0, '不应重新排队');
});

test('signature-reject rotation excludes tried accounts and stops at the configured maximum', async t => {
  const h = fixture(t);
  addRotationAccount(h, 2, '192.0.2.11');
  addRotationAccount(h, 3, '192.0.2.12');
  addRotationAccount(h, 4, '192.0.2.13');
  addRotationAccount(h, 5, '192.0.2.14');
  const rotations = trackRotations(h);
  h.box.getSetting = (key, fallback) => key === 'dola_autorotate_max_attempts' ? '4' : fallback;
  h.overrides.submit = signatureRejectedSubmit;
  await h.run();
  await drainImmediate(h); // 第 2 次：2 号拒绝 → 换 3 号
  await drainImmediate(h); // 第 3 次：3 号拒绝 → 换 4 号，确认配置可覆盖默认上限 3
  await drainImmediate(h); // 第 4 次：4 号拒绝 → 达到上限，5 号仍可用也不再提交
  const row = h.row();
  assert.equal(row.status, 'failed');
  assertSignatureRejectionText(row.error);
  assert.match(row.error, /已自动轮询 4 个账号/);
  assert.match(row.error, /#1.*#2.*#3.*#4/);
  assert.match(row.error, /已达自动换号上限/);
  assert.deepEqual(rotations, [
    { id: 1, excludeIds: [1], nextId: 2 },
    { id: 1, excludeIds: [1, 2], nextId: 3 },
    { id: 1, excludeIds: [1, 2, 3], nextId: 4 },
  ]);
  assert.equal(h.calls.submit, 4);
  assert.equal(h.immediate.length, 0);
  const events = h.db.prepare('SELECT account_id, code, cooldown_until, detail FROM dola_rate_limit_events WHERE video_id=1 ORDER BY id').all();
  assert.deepEqual(events.map(event => event.account_id), [1, 2, 3, 4]);
  for (const event of events) {
    assert.equal(event.code, '710022002');
    assert.equal(event.cooldown_until, null);
    assertNoUnverifiedCause(event.detail);
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_accounts WHERE cooldown_until IS NOT NULL').get().c, 0);
  assert.deepEqual(h.calls.refunds, [1], '最终失败才退款一次');
});

test('signature-reject and rate-limit production code sets are disjoint and correctly classified', t => {
  const h = fixture(t);
  assert.deepEqual(Array.from(vm.runInContext('RATE_LIMIT_CODES', h.box)), []);
  assert.deepEqual(Array.from(vm.runInContext('SIGNATURE_REJECT_CODES', h.box)), [710022002]);
});

for (const state of ['null', 'expired', 'concurrent-future', 'configured-positive']) {
  test(`signature rejection never writes cooldown_until and preserves ${state} cooldown state`, async t => {
    const h = fixture(t);
    const expected = state === 'expired' ? '2000-01-01T00:00:00.000Z'
      : state === 'concurrent-future' ? '2099-01-01T00:00:00.000Z' : null;
    if (state === 'expired') h.db.prepare('UPDATE dola_accounts SET cooldown_until=? WHERE id=1').run(expected);
    if (state === 'configured-positive') {
      h.box.getSetting = (key, fallback) => key === 'dola_sigreject_cooldown_min' ? '30' : fallback;
    }
    h.overrides.submit = async () => {
      // 模拟本次提交等待回执期间，其他原因已写入冷却；拒绝处理不得覆盖/清空它。
      if (state === 'concurrent-future') h.db.prepare('UPDATE dola_accounts SET cooldown_until=? WHERE id=1').run(expected);
      // 从拒绝回执开始观测，连 UPDATE ... cooldown_until=NULL / 原值 都算违规。
      h.db.exec(`CREATE TABLE cooldown_writes(account_id);
        CREATE TRIGGER observe_cooldown AFTER UPDATE OF cooldown_until ON dola_accounts
        BEGIN INSERT INTO cooldown_writes(account_id) VALUES(NEW.id); END;`);
      return signatureRejectedSubmit();
    };
    await h.run();
    const account = h.db.prepare('SELECT status, cooldown_until, last_error FROM dola_accounts WHERE id=1').get();
    const event = h.db.prepare('SELECT code, cooldown_until, detail FROM dola_rate_limit_events WHERE video_id=1').get();
    assert.equal(h.row().status, 'failed');
    assert.equal(account.status, 'valid');
    assert.equal(account.cooldown_until, expected);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM cooldown_writes').get().c, 0);
    assertSignatureRejectionText(account.last_error);
    assertSignatureRejectionText(h.row().error);
    assert.equal(event.code, '710022002');
    assert.equal(event.cooldown_until, null, '本次拒绝事件没有产生冷却，不能借用旧冷却');
    assertNoUnverifiedCause(event.detail);
    assert.equal(h.calls.chain, 0);
    assert.deepEqual(h.calls.refunds, [1]);
  });
}

test('signature rejection invokes account rotation without cooling and the next account can succeed', async t => {
  const h = fixture(t);
  addRotationAccount(h, 2, '192.0.2.11');
  const rotations = trackRotations(h);
  let submits = 0;
  h.overrides.submit = async () => (++submits === 1 ? signatureRejectedSubmit() : { conversationId: '1234567890123', cap: [] });
  await h.run();
  assert.deepEqual(rotations, [{ id: 1, excludeIds: [1], nextId: 2 }]);
  assert.equal(h.row().account_id, 2);
  assert.equal(h.row().status, 'queued');
  assertNoUnverifiedCause(h.row().stage);
  // stage 是**短标签**（不含 code），但仍必须说清"这是上游拒绝"而不是含糊过去。
  // 原来的 stage 是「验签/参数被上游拒绝，已自动换号为 #N 重试」—— 那同样是在断言
  // 未经验证的成因，所以 2026-09-28 一起收敛成「上游拒绝，已自动换号为 #N 重试」。
  assert.match(h.row().stage, /上游拒绝/);
  assert.match(h.row().stage, /自动换号/);
  assert.equal(h.db.prepare('SELECT cooldown_until FROM dola_accounts WHERE id=1').get().cooldown_until, null);
  assert.deepEqual(h.calls.refunds, []);
  await drainImmediate(h);
  assert.equal(h.row().status, 'ready');
  assert.equal(h.row().account_id, 2);
  assert.equal(submits, 2);
  assert.deepEqual(h.calls.refunds, []);
});

test('strict acceptance task never auto-rotates or cools on signature rejection', async t => {
  const h = fixture(t);
  addRotationAccount(h, 2, '192.0.2.11');
  const rotations = trackRotations(h);
  h.db.prepare('UPDATE dola_videos SET strict_account=1 WHERE id=1').run();
  h.overrides.submit = signatureRejectedSubmit;
  await h.run();
  assert.equal(h.row().status, 'failed');
  assertSignatureRejectionText(h.row().error);
  assert.match(h.row().error, /不自动换号/);
  assert.equal(h.row().account_id, 1);
  assert.equal(h.db.prepare('SELECT cooldown_until FROM dola_accounts WHERE id=1').get().cooldown_until, null);
  assert.deepEqual(rotations, []);
  assert.deepEqual(h.calls.refunds, [1]);
  assert.equal(h.immediate.length, 0);
});

test('task assigned a cooling account rotates at pickup without consuming an attempt', async t => {
  const h = fixture(t);
  addRotationAccount(h, 2, '192.0.2.11');
  h.db.prepare("UPDATE dola_accounts SET cooldown_until='2099-01-01T00:00:00.000Z' WHERE id=1").run();
  await h.run();
  // 取号时换号成功：任务实际用 2 号跑完；stage 文案会被后续进度覆盖，只断言换号结果
  assert.equal(h.row().account_id, 2);
  assert.equal(h.row().status, 'ready');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_rate_limit_events WHERE video_id=1').get().c, 0);
});

test('cancelled task is not resurrected by rotation', async t => {
  const h = fixture(t);
  addRotationAccount(h, 2, '192.0.2.11');
  h.overrides.submit = signatureRejectedSubmit;
  const probeGate = deferred();
  let profiles = 0;
  h.overrides.profile = async (...args) => {
    if (++profiles === 1) return liveProfile(); // 首轮体检通过
    await probeGate.promise; // 换号探测时挂起，测试在此时取消
    return liveProfile();
  };
  const work = h.run(); await flush();
  h.cancel(); probeGate.resolve();
  await work; await flush();
  assert.equal(h.row().status, 'cancelled');
  assert.deepEqual(h.calls.refunds, []);
  assert.equal(h.immediate.length, 0, '取消的任务不应重新排队');
});

test('capability submission failure blocks subsequent admission before probe/charge and rejects queued repeat', async t => {
  const h = fixture(t, { seconds: 15 });
  h.overrides.submit = async () => { throw new Error('未确认原生 15 秒：页面没有唯一可选的原生单次时长选项'); };
  await h.run();
  assert.equal(h.row().status, 'failed'); assert.deepEqual(h.calls.refunds, [1]);
  assert.equal(h.db.prepare('SELECT native_15s_state FROM dola_accounts WHERE id=1').get().native_15s_state, 'unknown');
  const profileCount = h.calls.profile;
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic repeat', seconds: 15, mode: 'expert' }), e => e.status === 409);
  assert.equal(h.calls.profile, profileCount); assert.equal(h.immediate.length, 0); assert.equal(h.calls.submit, 1);
  h.db.exec("INSERT INTO dola_videos(id,account_id,prompt,seconds,status) VALUES(2,1,'queued repeat',15,'queued')");
  await h.box.run(2, { maxMin: 1 });
  assert.equal(h.calls.profile, profileCount); assert.equal(h.calls.submit, 1);
  assert.match(h.db.prepare('SELECT error FROM dola_videos WHERE id=2').get().error, /重复失败保护/);
});

test('cancelled capability failure cannot create a repeated-failure guard', async t => {
  const h = fixture(t), gate = deferred(); h.overrides.submit = () => gate.promise;
  const work = h.run(); await flush(); h.cancel(); gate.reject(new Error('原生 30 秒能力探测未完成'));
  await work;
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM dola_generation_guards').get().n, 0);
  assert.equal(h.row().status, 'cancelled');
});

for (const condition of ['missing-ref', 'missing-consume', 'wrong-owner', 'refunded', 'invalid-amount']) {
  test(`owned task ${condition} never reads cookies, probes or submits`, async t => {
    const h = fixture(t, { owner: 11 });
    if (condition !== 'missing-ref') h.db.exec("UPDATE dola_videos SET charge_ref='gen-1' WHERE id=1");
    if (!['missing-ref', 'missing-consume'].includes(condition)) {
      h.db.prepare("INSERT INTO point_transactions(token_id,kind,ref,delta) VALUES (?,'consume','gen-1',?)")
        .run(condition === 'wrong-owner' ? 12 : 11, condition === 'invalid-amount' ? 0 : 2);
    }
    if (condition === 'refunded') h.db.exec("INSERT INTO point_transactions(token_id,kind,ref,delta) VALUES (11,'refund','gen-1',2)");
    await h.run(); assert.equal(h.row().status, 'failed');
    assert.equal(h.calls.cookies, 0); assert.equal(h.calls.profile, 0); assert.equal(h.calls.submit, 0);
  });
}
test('matching settled owner charge allows the isolated workflow', async t => {
  const h = fixture(t, { owner: 11 });
  h.db.exec("UPDATE dola_videos SET charge_ref='gen-1'; INSERT INTO point_transactions(token_id,kind,ref,delta) VALUES (11,'consume','gen-1',2)");
  await h.run(); assert.equal(h.row().status, 'ready'); assert.equal(h.calls.submit, 1);
});

for (const seconds of [15, 30]) {
  test(`${seconds}s live capability preflight rejects before task/charge and releases reservations`, async t => {
    const h = fixture(t);
    h.overrides.preflight = async () => ({ ok: false, state: 'unknown', error: '模型控件未加载完成' });
    await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds, mode: seconds === 15 ? 'expert' : 'standard' }), e => e.code === 'GENERATION_PREFLIGHT_FAILED');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM dola_videos').get().n, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM point_transactions').get().n, 0);
    assert.equal(h.immediate.length, 0); assert.equal(h.calls.submit, 0);
    assert.equal(h.box.generationStatus().reservedAccounts, 0);
    assert.equal(h.box.generationStatus().admissionReserved, 0);
    assert.equal(h.db.prepare('SELECT status FROM dola_accounts WHERE id=1').get().status, 'valid');
  });
}

for (const [seconds, wrongCarrier] of [[30, 10]]) {
  test(`${seconds}s wrong-carrier probe is rejected before task creation or charge`, async t => {
    const h = fixture(t);
    h.overrides.preflight = async () => ({ ok: true, state: 'available', seconds,
      uiSeconds: wrongCarrier, native: false, rewriteCarrier: true, model: 'seedance_v2.5' });
    await assert.rejects(
      h.box.createVideoTask({ prompt: `carrier-only-${seconds}`, seconds }),
      error => error.code === 'GENERATION_PREFLIGHT_FAILED' && /未确认目标模型及时长/.test(error.message),
    );
    assert.equal(h.calls.submit, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM point_transactions').get().c, 0);
  });
}
for (const change of ["status='invalid'", "proxy='http://changed.invalid'", "cookie_hash='changed'", "exit_ip=''", "sec_user_id='changed'", "cooldown_until='2099-01-01'"]) {
  test(`preflight cannot admit a stale account snapshot: ${change}`, async t => {
    const h = fixture(t), gate = deferred(); h.overrides.preflight = () => gate.promise;
    const pending = h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }); await flush();
    h.db.exec(`UPDATE dola_accounts SET ${change} WHERE id=1`);
    gate.resolve({ ok: true, state: 'available', seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true, model: 'seedance_v2.5' });
    await assert.rejects(pending, e => e.code === 'GENERATION_PREFLIGHT_STALE');
    assert.equal(h.immediate.length, 0); assert.equal(h.box.generationStatus().reservedAccounts, 0);
  });
}
test('preflight exceptions are sanitized and do not poison login state', async t => {
  const h = fixture(t); h.overrides.preflight = async () => { throw new Error('SYNTHETIC_SECRET'); };
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }), e => e.code === 'GENERATION_PREFLIGHT_FAILED' && !e.message.includes('SYNTHETIC_SECRET'));
  assert.equal(h.db.prepare('SELECT status FROM dola_accounts WHERE id=1').get().status, 'valid');
  assert.equal(h.box.generationStatus().reservedAccounts, 0);
});
test('strict acceptance account never silently falls back', async t => {
  const h = fixture(t);
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30, accountId: 999, strictAccount: true }), e => e.status === 409);
  assert.equal(h.calls.profile, 0); assert.equal(h.calls.preflight, 0);
  const row = await h.box.createVideoTask({ prompt: 'synthetic', seconds: 30, accountId: 1, strictAccount: true });
  assert.equal(row.account_id, 1); assert.equal(h.calls.preflight, 1);
});

// ------------------------------------------------- 出口地区（geo）封锁（2026-09-27）
// 现场：生产 #429 的代理凭据声明 HK、实际出口漂到叙利亚（193.93.54.246），
// 上游按**真实出口 IP** 判 geo（710022003，改 URL 里的 region 参数无效）。
// 改前它落到"未知 code"兜底分支，对外只说 `HTTP 200 code=710022003`，
// 而引导词让人去查 cookie / 代理地址 —— 方向正好错开。
// 下面三条守的是：这类码必须被单独认出来，且**账号状态不被污染**。

test('geo 封锁：说明地区原因、不标 invalid、写短冷却，且不污染限流审计表', async t => {
  const h = fixture(t);
  h.overrides.profile = async () => ({ ok: false, status: 200, code: 710022003 });
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic geo', seconds: 30 }),
    e => e.status === 409 && /出口地区不受支持/.test(e.message) && /710022003/.test(e.message),
  );
  const acc = h.db.prepare('SELECT status, cooldown_until, last_error FROM dola_accounts WHERE id=1').get();
  // ★ 号是好的，坏的是出口 —— status 一行都不许动（这是改前 fallback 唯一做对的部分，要保住）。
  assert.equal(acc.status, 'valid');
  // 短冷却让它暂时退出选号：出口是粘性的，不重拨就一直撞同一面墙。
  assert.ok(acc.cooldown_until, 'geo 封锁应写入冷却');
  assert.ok(new Date(acc.cooldown_until).getTime() > Date.now(), '冷却必须指向未来');
  // 标记必须指向动作，运维在账号列表里看得见"下一步干什么"。
  assert.match(acc.last_error, /需重拨代理/);
  // ★ geo 不是限流：审计表里不许出现它，否则基于 dola_rate_limit_events 的分析全部失真。
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_rate_limit_events').get().c, 0);
  // 未建任务、未扣积分。
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
});

test('geo 封锁：锁定账号验收只报原因、不写冷却（否则真原因会被冷却过滤掉）', async t => {
  const h = fixture(t);
  h.overrides.profile = async () => ({ ok: false, status: 200, code: 710022003 });
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic geo strict', seconds: 30, accountId: 1, strictAccount: true }),
    e => e.status === 409 && /出口地区不受支持/.test(e.message),
  );
  const acc = h.db.prepare('SELECT status, cooldown_until FROM dola_accounts WHERE id=1').get();
  assert.equal(acc.status, 'valid');
  // strictAccount 时候选只有这一个号：一旦写冷却，它会被 candidates() 的冷却过滤掉、
  // skipped 变空，对外就报成「账号池里没有可用账号（status=valid）」—— 真正的原因反而消失。
  assert.equal(acc.cooldown_until, null);
  // 失败发生在选号阶段，不该碰页面（不跑原生能力预检）。
  assert.equal(h.calls.preflight, 0);
  assert.equal(h.calls.submit, 0);
});

test('geo 封锁：自动调度继续试下一个号，不把整次提交判死', async t => {
  const h = fixture(t);
  // 两个号必须同 proxy / 同 cookie：harness 的 fetchProfile 与 parseCookies 都对这两个值有断言。
  h.db.exec(`INSERT INTO dola_accounts(id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES(2,'healthy','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','hash-2','synthetic-dola','pro','192.0.2.11','available')`);
  // 用调用序号区分账号：candidates() 按 COALESCE(last_used_at,'') ASC, id ASC 排序 → 先 1 后 2。
  let probed = 0;
  h.overrides.profile = async () => (++probed === 1 ? { ok: false, status: 200, code: 710022003 } : liveProfile());
  const created = await h.box.createVideoTask({ prompt: 'synthetic geo rotate', seconds: 30 });
  assert.equal(created.account_id, 2, 'geo 号必须被跳过，改由下一个号承接');
  assert.equal(probed, 2, '两个候选都应被体检过');
  const geo = h.db.prepare('SELECT status, cooldown_until FROM dola_accounts WHERE id=1').get();
  assert.equal(geo.status, 'valid');
  assert.ok(geo.cooldown_until, '被跳过的 geo 号进入短冷却');
  const healthy = h.db.prepare('SELECT status, cooldown_until FROM dola_accounts WHERE id=2').get();
  assert.equal(healthy.status, 'valid');
  assert.equal(healthy.cooldown_until, null, '正常承接的号不得被误冷却');
});
// --------------------------------- 出口地区**一致性**守卫（2026-09-28）
// 现场：生产 4 条任务连吃 710022002，对外报「验签/参数被上游拒绝」。
// 核验后真因是**代理出口地区错配**：代理凭据声明 HK，实测出口落在 VE（委内瑞拉）/ PS（巴勒斯坦）。
// 为什么原来的预检拦不住：它打的是 `/alice/profile/self_brief`，而真正受限的是 `/chat/completion`
// —— `geo-block.js` 自己就写了"同一出口在不同接口族上的白名单不同"。所以坏出口能通过体检，
// 一路走到提交才被拒，还把那 3 个昂贵的体检名额吃光。
//
// 下面这组守的是**四件事**（每一件都有反向断言，不能只测正例）：
//   ① 错配 → **提交之前**就筛掉，不建任务、不扣积分；
//   ② 一致 → 正常放行（守卫不能把好号也拦了）；
//   ③ 探不出来 → **必须放行**（fail-open）。基础设施故障绝不能被判成"地区错配"；
//   ④ 处置语义与 geo 封锁一致：不标 invalid、不写限流事件表、短冷却 + 写清"需重拨代理"。

/** 声明地区 HK 的代理（形态照抄生产 udealproxy；密码是占位符）。 */
const DECLARED_HK_PROXY = 'http://userId-1-region-hk-session-A:pw@as.udealproxy.com:6666';
const exitVe = () => ({ ok: true, ip: '38.63.73.174', country: 'VE', org: 'COLNETWORK', cached: false });
const exitHk = () => ({ ok: true, ip: '223.16.134.111', country: 'HK', org: 'HGC', cached: false });

test('出口地区错配：提交前筛掉、不建任务、不标 invalid、不污染限流审计表', async t => {
  const h = fixture(t, { proxy: DECLARED_HK_PROXY });
  h.overrides.exitProbe = async () => exitVe();
  // ⚠️ 只调**一次**：非锁定路径的守卫会给这个号写冷却，第二次调用时它已被
  //    `candidates()` 的冷却过滤掉 → 消息会变成"账号池里没有可用账号"，断言就失真了。
  //    所以下面所有文案断言都复用**同一个** message。
  let message = '';
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic exit', seconds: 30 }),
    e => { message = String(e?.message || ''); return e.status === 409; },
  );
  assert.match(message, /出口地区与代理声明不一致/);
  assert.match(message, /声明 HK/);
  assert.match(message, /委内瑞拉/);
  // ★ 引导词必须**专属**：这类原因要指向"换出口/重拨代理"，
  //   而不是通用引导词里那句"请确认账号登录有效…查代理地址"（会把人引去查 cookie）。
  assert.match(message, /重新拨号或更换代理地区/);
  assert.match(message, /不是账号登录失效/);
  // ★ 两阶段之后，"试了几个"必须**分段报**。只报会话体检数会说出
  //   「本轮体检的 0 个账号都没通过」这种读起来像"一个都没试就失败了"的怪话
  //   （真实生产回执就是这么写的，见 ui-e2e-exit-region-guard.mjs）。
  assert.match(message, /出口地区预筛淘汰 1 个/);
  // ⚠️ 整句会原样显示在接口回执与前台表格里，**不许**出现 markdown 的 `**` 加粗。
  assert.doesNotMatch(message, /\*\*/);
  const acc = h.db.prepare('SELECT status, cooldown_until, last_error FROM dola_accounts WHERE id=1').get();
  // ★ 号是好的，坏的是出口 —— status 一行都不许动（与 geo 封锁同语义）。
  assert.equal(acc.status, 'valid');
  // 短冷却：出口是**粘性**的（带 -session-<SID>-sessTime-120 的号被钉死在坏出口 120 分钟），
  // 不冷却的话下一个任务立刻又选中它、又撞同一面墙、又烧掉一个换号名额。
  assert.ok(acc.cooldown_until, '错配应写入冷却');
  assert.ok(new Date(acc.cooldown_until).getTime() > Date.now(), '冷却必须指向未来');
  assert.match(acc.last_error, /需重拨代理/);
  assert.match(acc.last_error, /实测 VE/);
  // ★ 这不是限流：审计表必须为空，否则基于 dola_rate_limit_events 的分析全部失真。
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_rate_limit_events').get().c, 0);
  // 未建任务、未扣积分、未走到页面。
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM point_transactions').get().c, 0);
  assert.equal(h.calls.preflight, 0);
  assert.equal(h.calls.submit, 0);
});

test('出口地区一致：守卫必须放行（不能把好号也拦了）', async t => {
  const h = fixture(t, { proxy: DECLARED_HK_PROXY });
  h.overrides.exitProbe = async () => exitHk();
  const created = await h.box.createVideoTask({ prompt: 'synthetic exit ok', seconds: 30 });
  assert.equal(created.account_id, 1);
  const acc = h.db.prepare('SELECT status, cooldown_until, last_error FROM dola_accounts WHERE id=1').get();
  assert.equal(acc.status, 'valid');
  assert.equal(acc.cooldown_until, null, '一致的出口不得被冷却');
  // 夹具里 last_error 无默认值 ⇒ 未被写过时是 NULL，不是空串。
  assert.ok(!acc.last_error, '一致的出口不得写 last_error');
  // 确实探过（否则这条用例会"因为守卫根本没跑"而假通过）。
  assert.equal(h.calls.exitProbe, 1);
});

test('★ 探不出来必须放行（fail-open）：基础设施故障绝不能判成地区错配', async t => {
  const h = fixture(t, { proxy: DECLARED_HK_PROXY });
  // 三种"探不出来"：代理不通 / 超时 / socks5 不被 undici 支持（生产 #444 就是这种）。
  h.overrides.exitProbe = async () => ({ ok: false, reason: 'timeout_6000ms' });
  const created = await h.box.createVideoTask({ prompt: 'synthetic exit unknown', seconds: 30 });
  assert.equal(created.account_id, 1, '探不出来时必须照常选中该账号');
  const acc = h.db.prepare('SELECT status, cooldown_until, last_error FROM dola_accounts WHERE id=1').get();
  assert.equal(acc.status, 'valid');
  assert.equal(acc.cooldown_until, null, '探不出来 ≠ 坏出口：绝不能给好号写冷却');
  assert.ok(!acc.last_error, '探不出来不得写 last_error（那会把"不知道"说成"有问题"）');
});

test('出口地区错配：锁定账号验收只报原因、不写冷却（否则真原因会被冷却过滤掉）', async t => {
  const h = fixture(t, { proxy: DECLARED_HK_PROXY });
  h.overrides.exitProbe = async () => exitVe();
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic exit strict', seconds: 30, accountId: 1, strictAccount: true }),
    e => e.status === 409 && /出口地区与代理声明不一致/.test(e.message),
  );
  const acc = h.db.prepare('SELECT status, cooldown_until FROM dola_accounts WHERE id=1').get();
  assert.equal(acc.status, 'valid');
  // strictAccount 时候选只有这一个号：写了冷却它会被 candidates() 过滤掉、skipped 变空，
  // 对外就报成「账号池里没有可用账号（status=valid）」—— 真正的原因反而消失。
  // 这条与 geo 封锁的 strict 分支是同一个坑，两边必须一致。
  assert.equal(acc.cooldown_until, null);
  assert.equal(h.calls.preflight, 0);
});

test('★ 坏出口不再吃掉体检名额：3 个坏出口排在前，第 4 个好号仍能被选中', async t => {
  const h = fixture(t, { proxy: DECLARED_HK_PROXY });
  addRotationAccount(h, 2, '192.0.2.11', DECLARED_HK_PROXY);
  addRotationAccount(h, 3, '192.0.2.12', DECLARED_HK_PROXY);
  addRotationAccount(h, 4, '192.0.2.13', DECLARED_HK_PROXY);
  // 出口实测按**调用顺序**给结果：前 3 个落在 VE，第 4 个是真 HK。
  // （4 个号共用同一条代理 URL —— harness 的 fetchProfile 断言"体检走账号自己的代理"，
  //   所以只能靠顺序区分；Promise.all 按数组序同步发起，顺序是确定的。）
  let n = 0;
  h.overrides.exitProbe = async () => (++n <= 3 ? exitVe() : exitHk());
  const created = await h.box.createVideoTask({ prompt: 'synthetic exit budget', seconds: 30 });
  // ★ 这就是拆两阶段的核心收益。改前只有"会话体检"一层、且上限 3 个：
  //   坏出口的号 /alice 预检**是通过的**，于是 3 个名额全被它们吃掉，
  //   第 4 个好号**压根没被试** → 报「换号探测无可用账号（跳过 N 个）」。
  assert.equal(created.account_id, 4, '坏出口必须被便宜的阶段 1 筛掉，好号才有名额');
  assert.equal(h.calls.exitProbe, 4, '阶段 1 应按顺序探到第 4 个为止');
  // 3 个坏号进冷却，好号不受影响。
  const cooled = h.db.prepare('SELECT id FROM dola_accounts WHERE cooldown_until IS NOT NULL ORDER BY id').all().map(r => r.id);
  assert.deepEqual(cooled, [1, 2, 3]);
  assert.equal(h.db.prepare('SELECT status FROM dola_accounts WHERE id=4').get().status, 'valid');
});

test('出口地区错配：声明不出地区时不参与判定（宁可不说，也别瞎断言）', async t => {
  // 默认夹具的代理是 `http://proxy.example.invalid:8080`，用户名里没有地区声明。
  const h = fixture(t);
  h.overrides.exitProbe = async () => exitVe();
  const created = await h.box.createVideoTask({ prompt: 'synthetic exit undeclared', seconds: 30 });
  assert.equal(created.account_id, 1, '没有声明地区就无从比对，必须放行');
  // ★ 连探测都不该发生：没声明就没有可比对的基准，探了也没用（还会白白出网）。
  assert.equal(h.calls.exitProbe, 0);
  const acc = h.db.prepare('SELECT cooldown_until FROM dola_accounts WHERE id=1').get();
  assert.equal(acc.cooldown_until, null);
});

test('preflight concurrency is bounded and busy refusal releases the account', async t => {
  const h = fixture(t), gate = deferred();
  h.db.exec(`INSERT INTO dola_accounts(id,label,cookie,status,proxy,cookie_hash,sec_user_id,exit_ip)
    VALUES(2,'second','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','hash2','synthetic-dola','192.0.2.11')`);
  h.overrides.preflight = () => gate.promise;
  const pending = h.box.createVideoTask({ prompt: 'first', seconds: 30, accountId: 1, strictAccount: true }); await flush();
  await assert.rejects(h.box.createVideoTask({ prompt: 'second', seconds: 30, accountId: 2, strictAccount: true }), e => e.code === 'GENERATION_PREFLIGHT_BUSY');
  assert.equal(h.calls.preflight, 1);
  gate.resolve({ ok: true, state: 'available', seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true, model: 'seedance_v2.5' }); await pending;
  assert.equal(h.box.generationStatus().reservedAccounts, 0);
});

test('inconsistent duration is rejected before account lookup/probe/insert', async t => {
  const h = fixture(t);
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 15, forceSeconds: 30 }), e => e.status === 400);
  assert.equal(h.calls.cookies, 0); assert.equal(h.immediate.length, 0);
});

test('deferred owned task cannot dispatch before charge; confirmed start is idempotent', async t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_videos SET status='ready' WHERE id=1");
  const created = await h.box.createVideoTask({ prompt: 'synthetic', seconds: 30, ownerTokenId: 11, deferStart: true });
  await flush(); assert.equal(h.immediate.length, 0); assert.equal(h.calls.submit, 0);
  assert.throws(() => h.box.startVideoTask(created.id), e => e.status === 409);
  assert.equal(h.immediate.length, 0);
  h.db.prepare('UPDATE dola_videos SET charge_ref=? WHERE id=?').run(`gen-${created.id}`, created.id);
  h.db.prepare("INSERT INTO point_transactions(token_id,kind,ref,delta) VALUES(11,'consume',?,1)").run(`gen-${created.id}`);
  assert.equal(h.box.startVideoTask(created.id), true);
  assert.equal(h.box.startVideoTask(created.id), true);
  assert.equal(h.immediate.length, 1);
  h.box.cancelVideoTask(created.id);
  assert.equal(h.box.startVideoTask(created.id), false);
});

test('a guard created during asynchronous account selection stops admission', async t => {
  const h = fixture(t), gate = deferred(); h.overrides.profile = () => gate.promise;
  const pending = h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 });
  await flush();
  h.db.prepare(`INSERT INTO dola_generation_guards(account_id,scope,reason_code,source_task_id,blocked_at)
    VALUES(1,'duration:30','capability',1,?)`).run(new Date().toISOString());
  gate.resolve(liveProfile());
  await assert.rejects(pending, e => e.status === 409);
  assert.equal(h.immediate.length, 0); assert.equal(h.box.generationStatus().reservedAccounts, 0);
});

test('concurrent submissions reserve different accounts before async session probes', async t => {
  const h = fixture(t);
  h.db.exec(`UPDATE dola_videos SET status='failed' WHERE id=1;
    INSERT INTO dola_accounts
      (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES (2,'synthetic-account-2','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','synthetic-hash-2','synthetic-dola','pro','192.0.2.11','available'),
           (3,'synthetic-account-3','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','synthetic-hash-3','synthetic-dola','pro','192.0.2.12','available');`);
  h.box.getSetting = (key, fallback) => key === 'dola_gen_concurrency' ? '2' : fallback;

  const [first, second] = await Promise.all([
    h.box.createVideoTask({ prompt: 'synthetic one', seconds: 30 }),
    h.box.createVideoTask({ prompt: 'synthetic two', seconds: 30 }),
  ]);
  assert.notEqual(first.account_id, second.account_id);
  assert.deepEqual([first.account_id, second.account_id].sort((a, b) => a - b), [1, 2]);
  assert.equal(h.box.generationStatus().reservedAccounts, 0);
  assert.equal(h.box.generationStatus().concurrency, 2);
  assert.equal(h.immediate.length, 2);
});

test('same-account execution lock is FIFO while different accounts can acquire immediately', async t => {
  const h = fixture(t);
  const releaseFirst = await h.box.acquireAccount(1);
  let sameAccountGranted = false;
  const waiting = h.box.acquireAccount(1).then((release) => {
    sameAccountGranted = true;
    release();
  });
  const releaseOther = await h.box.acquireAccount(2);
  assert.equal(sameAccountGranted, false);
  releaseOther();
  releaseFirst();
  await waiting;
  assert.equal(sameAccountGranted, true);
});

test('global semaphore never exceeds the configured concurrency and wakes FIFO', async t => {
  const h = fixture(t);
  h.box.getSetting = (key, fallback) => key === 'dola_gen_concurrency' ? '2' : fallback;
  await h.box.acquire();
  await h.box.acquire();
  let thirdGranted = false;
  const third = h.box.acquire().then(() => {
    thirdGranted = true;
  });
  await flush();
  assert.equal(thirdGranted, false);
  const blocked = h.box.generationStatus();
  assert.equal(blocked.running, 2);
  assert.equal(blocked.queued, 1);
  assert.equal(blocked.concurrency, 2);
  assert.equal(blocked.available, 0);
  assert.equal(blocked.reservedAccounts, 0);
  assert.equal(blocked.byStatus.queued, 1);

  h.box.release();
  await flush();
  assert.equal(thirdGranted, true);
  assert.equal(h.box.generationStatus().running, 2);
  await third;
  h.box.release();
  h.box.release();
  assert.equal(h.box.generationStatus().running, 0);
  assert.equal(h.box.generationStatus().queued, 0);
});

test('queue admission rejects at capacity before account probing', async t => {
  const h = fixture(t);
  h.box.getSetting = (key, fallback) => key === 'dola_gen_queue_limit' ? '1' : fallback;

  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic capacity check', seconds: 30 }),
    (error) => error.status === 429 && error.code === 'GENERATION_QUEUE_FULL' && /1\/1/.test(error.message),
  );
  assert.equal(h.calls.profile, 0);
  assert.equal(h.calls.cookies, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
  const status = h.box.generationStatus();
  assert.equal(status.activeTasks, 1);
  assert.equal(status.queueLimit, 1);
  assert.equal(status.queueAvailable, 0);
});

test('missing proxy cannot fall back to direct at selection or execution', async t => {
  const h = fixture(t); h.db.exec("UPDATE dola_accounts SET proxy=''");
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }), e => e.status === 409);
  await assert.rejects(h.run(), /禁止直连/);
  assert.equal(h.calls.cookies, 0); assert.equal(h.calls.profile, 0); assert.equal(h.calls.submit, 0);
});

test('shared or unverified exits are excluded before submission', async t => {
  const h = fixture(t);
  h.db.exec(`INSERT INTO dola_accounts
           (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip)
    VALUES (2,'shared','SYNTHETIC_ONLY_2','valid','http://proxy-2.example.invalid:8080','hash-2','synthetic-2','free','192.0.2.10'),
           (3,'unique','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','hash-3','synthetic-dola','free','192.0.2.11'),
           (4,'unknown-exit','SYNTHETIC_ONLY_4','valid','http://proxy-4.example.invalid:8080','hash-4','synthetic-4','free','')`);
  const chosen = await h.box.createVideoTask({ prompt: 'synthetic', seconds: 30, accountId: 2 });
  assert.equal(chosen.account_id, 3, 'preferred shared-exit account must fall back to a unique verified exit');
  assert.equal(h.calls.profile, 1, 'only the unique verified candidate reaches the live probe');
});

test('no unique verified exit rejects without creating a task', async t => {
  const h = fixture(t);
  h.db.exec("INSERT INTO dola_accounts (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip) VALUES (2,'shared','SYNTHETIC_ONLY_2','valid','http://proxy-2.example.invalid:8080','hash-2','synthetic-2','free','192.0.2.10')");
  h.db.prepare("UPDATE dola_accounts SET exit_ip='192.0.2.10' WHERE id=1").run();
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }), e => e.status === 409 && /共享出口/.test(e.message));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
});

test('free and uncached accounts are eligible; subscription is not duration capability', async t => {
  const h = fixture(t); h.db.exec("UPDATE dola_accounts SET membership='free'");
  h.overrides.profile = async () => ({ ...liveProfile(), membershipLevel: 'free', hasActiveSubscription: false });
  await h.run(); assert.equal(h.row().status, 'ready'); assert.equal(h.calls.submit, 1);
  for (const membership of ['free', '']) {
    h.db.prepare('UPDATE dola_accounts SET membership=?').run(membership);
    const result = await h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 });
    assert.ok(result.id > 1);
  }
});
test('unverified native 30s capability is excluded before live probe or task insert', async t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_accounts SET native_30s_state='unknown'");
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }),
    e => e.status === 409 && /方悦改写路径/.test(e.message),
  );
  assert.equal(h.calls.profile, 0);
  assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
});
test('30s carrier-rewrite switch: off keeps the old gate, on admits the carrier path', async t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_accounts SET native_30s_state='unknown'");
  // ① 默认（未配置该设置）：与上一个用例完全同一条路，30 秒仍被挡在选号阶段
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }),
    e => e.status === 409 && /方悦改写路径/.test(e.message),
  );
  assert.equal(h.calls.profile, 0);
  assert.equal(h.calls.submit, 0);
  // ② 显式打开载体改写通道：同一个号、同一个 native_30s_state=unknown，
  //    这次必须被接纳 —— 这正是"服务端只下发 5s/10s 时 30 秒仍可用"的证明。
  h.box.getSetting = (key, fallback) => key === 'dola_allow_30s_rewrite' ? 'true' : fallback;
  const admitted = await h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 });
  assert.ok(admitted.id > 0, '开关打开后必须建出任务');
  assert.equal(h.calls.profile, 1, '只读预检必须只跑一次');
  assert.equal(
    h.db.prepare('SELECT native_30s_state FROM dola_accounts WHERE id=1').get().native_30s_state,
    'unknown',
    '开关不写库：能力字段仍保持 unknown，判据由设置在运行时决定',
  );
});

test('30s carrier-rewrite switch still refuses a probe with no rewrite evidence', async t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_accounts SET native_30s_state='unknown'");
  h.box.getSetting = (key, fallback) => key === 'dola_allow_30s_rewrite' ? 'true' : fallback;
  // 开关解决的是"载体口径"，不解决"证据缺失"：没有改写标记 / 声明成原生 30s 一律拒绝
  for (const bad of [
    { uiSeconds: 15, native: false, rewriteCarrier: false },
    { uiSeconds: 30, native: true, rewriteCarrier: false },
    { uiSeconds: 30, native: false, rewriteCarrier: true },
  ]) {
    h.overrides.preflight = async () => ({
      ok: true, state: 'available', seconds: 30, model: 'seedance_v2.5', ...bad,
    });
    await assert.rejects(
      h.box.createVideoTask({ prompt: `bad-${JSON.stringify(bad)}`, seconds: 30 }),
      e => e.code === 'GENERATION_PREFLIGHT_FAILED' && /未确认目标模型及时长/.test(e.message),
      JSON.stringify(bad),
    );
  }
  assert.equal(h.calls.submit, 0);
});
test('unverified native 15s expert capability is excluded before live probe or task insert', async t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_accounts SET native_15s_state='unknown'");
  await assert.rejects(
    h.box.createVideoTask({ prompt: 'synthetic', mode: 'expert', seconds: 15, forceSeconds: 15 }),
    e => e.status === 409 && /页面原生能力探测/.test(e.message),
  );
  assert.equal(h.calls.profile, 0);
  assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_videos').get().c, 1);
});
test('uncertain login never submits, regardless of cached membership', async t => {
  const h = fixture(t); h.overrides.profile = async () => ({ ...liveProfile(), ok: false, status: 0 });
  await h.run(); assert.equal(h.row().status, 'failed'); assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT status FROM dola_accounts WHERE id=1').get().status, 'valid');
});

const exhaust = db => db.prepare("UPDATE dola_accounts SET quota_remaining=0,quota_source='generation_receipt',quota_at=?").run(new Date().toISOString());
test('known zero quota prevents selection, browser checks, task creation and queued submissions', async t => {
  const h = fixture(t);
  exhaust(h.db);
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30, accountId: 1, strictAccount: true }),
    e => e.status === 409 && e.code === 'GENERATION_QUOTA_EXHAUSTED');
  assert.equal(h.box.candidates(null, 10).length, 0);
  assert.equal(h.box.nativeThirtySecondPoolStats().ready, false);
  assert.equal(h.box.nativeFifteenSecondPoolStats().ready, false);
  assert.equal(h.box.referenceImagePoolStats().ready, false);
  await h.run();
  assert.equal(h.row().status, 'failed');
  assert.equal(h.calls.profile, 0);
  assert.equal(h.calls.preflight, 0);
  assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM dola_videos').get().n, 1);
  assert.equal(h.box.generationStatus().admissionReserved, 0);
});

test('zero quota arriving during browser preflight rejects before task creation', async t => {
  const h = fixture(t);
  h.overrides.preflight = async (_cookies, options) => {
    exhaust(h.db);
    const seconds = Number(options.seconds);
    // 30 秒 = 15s 载体 + 请求改写；15 秒 = 页面原生。证据形态必须合法，
    // 否则会先撞"未确认目标模型及时长"，测不到"额度在预检期间变成 0"这件事。
    const carrier = seconds === 30 ? 15 : seconds;
    return { ok: true, state: 'available', seconds, uiSeconds: carrier,
      native: seconds !== 30, rewriteCarrier: seconds === 30, model: seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5' };
  };
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }),
    e => e.code === 'GENERATION_PREFLIGHT_STALE');
  assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM dola_videos').get().n, 1);
});

test('missing media-verification executable rejects before browser preflight or task creation', async t => {
  const h = fixture(t);
  h.box.resolveFfprobePath = async () => { throw Object.assign(new Error('synthetic missing ffprobe'), {
    code: 'GENERATION_PREFLIGHT_MEDIA_UNAVAILABLE', status: 503,
  }); };
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }),
    e => e.code === 'GENERATION_PREFLIGHT_MEDIA_UNAVAILABLE' && e.status === 503);
  assert.equal(h.calls.preflight, 0);
  assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM dola_videos').get().n, 1);
  assert.equal(h.box.generationStatus().admissionReserved, 0);
});

test('zero quota arriving during queued-task identity check cannot submit', async t => {
  const h = fixture(t);
  h.overrides.profile = async () => { exhaust(h.db); return liveProfile(); };
  await h.run();
  assert.equal(h.row().status, 'failed');
  assert.match(h.row().error, /额度为 0/);
  assert.equal(h.calls.submit, 0);
});
test('identity mismatch is rejected before selecting an account or running a queued job', async t => {
  const h = fixture(t); h.overrides.profile = async () => ({ ...liveProfile(), entityId: 'different-synthetic-user' });
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }), e => e.status === 409);
  await h.run(); assert.equal(h.row().status, 'failed'); assert.equal(h.calls.submit, 0);
});
test('native capability rejection never enters polling even if a conversation URL exists', async t => {
  const h = fixture(t); h.overrides.submit = async () => ({ conversationId: '1234567890123', submissionBlocked: true });
  await h.run(); assert.equal(h.row().status, 'failed'); assert.equal(h.calls.chain, 0);
});

for (const rejection of ['signature', 'rate-limit']) {
  test(`numeric conversation URL cannot override an explicit upstream ${rejection} rejection`, async t => {
    const h = fixture(t);
    if (rejection === 'rate-limit') enableSyntheticRateLimit(h);
    const errorCode = rejection === 'signature' ? 710022002 : SYNTHETIC_RATE_LIMIT_CODE;
    h.overrides.submit = async () => ({ conversationId: '1234567890123', streamErrors: [{ code: errorCode }],
      wire: { forwarded: 1, blocked: 0 } });
    await h.run();
    assert.equal(h.row().status, 'failed');
    assert.ok(h.row().error.includes(String(errorCode)));
    assert.match(h.row().error, /放行 1 次/);
    assert.equal(h.calls.chain, 0);
    assert.equal(h.calls.submit, 1);
    const event = h.db.prepare('SELECT code, cooldown_until, detail FROM dola_rate_limit_events').get();
    const account = h.db.prepare('SELECT status, cooldown_until FROM dola_accounts').get();
    assert.equal(h.db.prepare('SELECT count(*) n FROM dola_rate_limit_events').get().n, 1);
    assert.equal(event.code, String(errorCode));
    assert.equal(account.status, 'valid');
    if (rejection === 'signature') {
      assertSignatureRejectionText(h.row().error);
      assertNoUnverifiedCause(event.detail);
      assert.equal(event.cooldown_until, null);
      assert.equal(account.cooldown_until, null);
    } else {
      assert.match(h.row().error, /上游限流/);
      assert.ok(account.cooldown_until > new Date().toISOString());
      assert.equal(event.cooldown_until, account.cooldown_until);
    }
  });
}
test('result arriving after the polling deadline is not accepted as ready', async t => {
  const h = fixture(t), gate = deferred(); let clock = 10000;
  h.box.Date = class extends Date { static now() { return clock; } };
  h.overrides.chain = () => gate.promise;
  const work = h.run(); await flush();
  clock += 60001;
  gate.resolve({ ok: true, text: 'https://media.example.invalid/synthetic-output.mp4', json: {} });
  await work; assert.equal(h.row().status, 'failed'); assert.equal(h.calls.archive, 0);
});

test('public-media archive is direct without cookies and does not write after cancel during download', async t => {
  const h = fixture(t), gate = deferred(); let writes = 0, requests = 0;
  h.db.exec("UPDATE dola_videos SET status='resolving' WHERE id=1");
  h.box.fs = { mkdir: async () => {}, writeFile: async () => { writes++; } };
  h.box.setTimeout = () => 1;
  h.box.fetch = async (_url, options) => {
    assert.deepEqual(Object.keys(options).sort(), ['redirect', 'signal']);
    assert.equal(options.headers, undefined); assert.equal(options.dispatcher, undefined);
    assert.ok(options.signal); requests++;
    return { ok: true, arrayBuffer: () => gate.promise };
  };
  const work = h.box.originalArchive(1, { watermarkedUrl: 'https://media.example.invalid/synthetic.mp4' });
  await flush(); assert.equal(requests, 1); h.cancel(); gate.resolve(new Uint8Array(2048));
  assert.equal(await work, null); assert.equal(writes, 0); assert.equal(h.row().status, 'cancelled');
});
test('startup recovery invokes settlement for failed consumed tasks, not cancelled tasks', t => {
  const h = fixture(t, { owner: 11 });
  h.db.exec(`INSERT INTO point_transactions(token_id,kind,ref,delta) VALUES (11,'consume','gen-1',2);
    INSERT INTO dola_videos(id,status,owner_token_id,charge_ref) VALUES (2,'failed',11,'gen-2'),(3,'cancelled',11,'gen-3');
    INSERT INTO point_transactions(token_id,kind,ref,delta) VALUES (11,'consume','gen-2',2),(11,'consume','gen-3',2);`);
  assert.equal(h.box.recoverStaleVideoTasks(), 1);
  assert.equal(h.row().status, 'failed'); assert.deepEqual(h.calls.refunds, [1]);
  assert.equal(h.box.recoverStaleVideoTasks(), 0);
  assert.deepEqual(h.calls.refunds, [1], 'recovery must never revisit historical failed or cancelled charges');
});

test('dispatched-but-unconfirmed submission is retained without refund or another account attempt', async t => {
  const h = fixture(t);
  h.overrides.submit = async (_cookie, options) => { options.onDispatch(); throw Error('synthetic connection lost after dispatch'); };
  await h.run();
  assert.equal(h.row().status, 'submitting', JSON.stringify(h.row()));
  assert.match(h.row().stage, /待核对/);
  assert.deepEqual(h.calls.refunds, []);
  assert.equal(h.calls.submit, 1);
  assert.equal(h.box.candidates(null, 10).length, 0);
  assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
  await assert.rejects(h.box.createVideoTask({ prompt: 'another prompt', accountId: 1, strictAccount: true, seconds: 30 }),
    e => e.code === 'GENERATION_SUBMISSION_UNRESOLVED');
});

function sentReceipt(h, { evidence = 'sse_ack' } = {}) {
  h.db.exec("UPDATE dola_videos SET status='submitting'");
  journal.recordSubmissionDispatch(h.db, { taskId: 1, account: h.db.prepare('SELECT * FROM dola_accounts').get(),
    deadlineAt: new Date(Date.now() + 60000).toISOString() });
  journal.recordSubmissionConversation(h.db, 1, '1234567890123', evidence);
  h.db.exec("UPDATE dola_videos SET status='generating'");
}

test('startup with a correlated receipt resumes queries and media validation, never generation or charging', async t => {
  const h = fixture(t); sentReceipt(h);
  exhaust(h.db); h.db.exec("UPDATE dola_accounts SET cooldown_until='2099-01-01'");
  assert.equal(h.box.recoverStaleVideoTasks(), 1);
  h.box.recoverStaleVideoTasks();
  assert.equal(h.immediate.length, 1, 'repeated recovery scans must not schedule duplicate work');
  await h.immediate.shift()();
  assert.equal(h.row().status, 'ready');
  assert.equal(h.calls.submit, 0); assert.equal(h.calls.profile, 0); assert.equal(h.calls.preflight, 0);
  assert.equal(h.calls.chain, 2); assert.equal(h.calls.archive, 1); assert.equal(h.calls.probe, 1);
  assert.deepEqual(h.calls.refunds, []);
});

for (const condition of ['legacy', 'url-only', 'changed-identity', 'expired']) {
  test(`startup holds ${condition} evidence for review instead of resubmitting or refunding`, t => {
    const h = fixture(t);
    if (condition === 'legacy') h.db.exec("UPDATE dola_videos SET status='submitting'");
    else {
      sentReceipt(h, { evidence: condition === 'url-only' ? 'conversation_url' : 'sse_ack' });
      if (condition === 'changed-identity') h.db.exec("UPDATE dola_accounts SET cookie_hash='replaced'");
      if (condition === 'expired') h.db.exec("UPDATE dola_submission_journal SET deadline_at='2020-01-01'");
    }
    h.box.recoverStaleVideoTasks();
    assert.equal(h.immediate.length, 0);
    assert.match(h.row().stage, /待核对/);
    assert.deepEqual(h.calls.refunds, []);
    assert.equal(h.calls.submit, 0);
    assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
  });
}

test('browser installs the 30s Fangyue rewrite adapter with exactly one serializable option object', async () => {
  // 切片必须从 targetSeconds 的声明开始：生产版把它提到了 addInitScript 之前，
  // 只切 addInitScript 那段会因为缺少变量声明而抛 ReferenceError。
  const start = source.indexOf('      const targetSeconds = Number(forceSeconds');
  const end = source.indexOf('\n    }\n\n    const page =', start);
  assert.ok(start > 0 && end > start);
  let argCount;
  let wireOptions = null;
  const box = { forceSeconds: 30, targetModel: 'seedance_v2.5', installVideoRequestAdapter,
    // 网络层改写器（生产版新增的第二层），失败时走 log，两者都要能在沙箱里跑
    installVideoRequestWire: async (_ctx, options) => { wireOptions = options; },
    log: () => {} };
  box.ctx = { addInitScript: async (...args) => {
    argCount = args.length;
    assert.equal(args[0], installVideoRequestAdapter);
    assert.equal(JSON.stringify(args[1]), JSON.stringify({
      seconds: 30, targetModel: 'seedance_v2.5', rewrite: true,
    }));
  } };
  box.URL = URL;
  box.requestFlow = { completion: 0, asyncStream: 0, otherChat: 0, logoutBlocked: 0, asyncStreamBlocked: 0 };
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', box);
  assert.equal(argCount, 2);
  // 两层改写必须口径一致：页内那层在 Dola 上实测命中不了，真正生效的是网络层。
  // 用 JSON 比对而不是 deepStrictEqual —— wireOptions 诞生在 vm 沙箱里，
  // 原型与本上下文的 Object.prototype 不同，deepStrictEqual 会因原型不等而误报。
  assert.equal(JSON.stringify(wireOptions), JSON.stringify({
    seconds: 30, targetModel: 'seedance_v2.5', rewrite: true,
  }));
});

test('the actual browser interceptor forwards one validated request and blocks duplicates or cancellation', async () => {
  const start = source.indexOf("    await ctx.route('**/*',");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let callback;
  const box = { ctx: { route: async (_pattern, handler) => { callback = handler; } }, forceSeconds: 30,
    sessionVerified: true, isActive: () => true, isNativeThirtySecondRequest: policy.isNativeThirtySecondRequest,
    submissionBlocked: false, BLOCK_TYPES: new Set(['image', 'font', 'media']), rewriteVideoDurationBody };
  box.onDispatch = () => {};
  Object.assign(box, { identifyGenerationRequest, createGenerationAckObserver, submittedRequest: null, ackObserver: null });
  box.wireGate = createGenerationWireGate({ seconds: 30, isActive: () => box.isActive(), sessionVerified: () => box.sessionVerified });
  box.URL = URL;
  box.requestFlow = { completion: 0, asyncStream: 0, otherChat: 0, logoutBlocked: 0, asyncStreamBlocked: 0 };
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', box);
  const send = async (duration, model = 'seedance_v2.5') => {
    let decision;
    await callback({ request: () => ({ url: () => 'https://www.dola.com/chat/completion', method: () => 'POST', resourceType: () => 'xhr',
      postData: () => JSON.stringify({ chat_ability: { ability_type: 17, ability_param: { model, duration } } }) }),
    abort: () => { decision = 'abort'; }, continue: () => { decision = 'continue'; } });
    return decision;
  };
  // Fangyue 20/30s intentionally use the page-native 10s carrier; the route
  // adapter upgrades it to the requested duration before the admission gate.
  assert.equal(await send(30, 'unknown-model'), 'abort');
  assert.equal(box.submissionBlocked, true);
  assert.equal(await send(10), 'continue');
  assert.equal(box.submissionBlocked, false, 'a successful journaled dispatch clears stale pre-send blocks');
  assert.equal(await send(30, 'unknown-model'), 'abort');
  assert.equal(await send(30), 'abort');
  assert.equal(box.wireGate.snapshot().forwarded, 1);
  assert.equal(box.submissionBlocked, false, 'blocking a duplicate must not discard the original result');
  box.sessionVerified = false;
  assert.equal(await send(30), 'abort');
  box.sessionVerified = true;
  box.isActive = () => false;
  assert.equal(await send(30), 'abort');
  let asyncDecision;
  await callback({ request: () => ({ url: () => 'https://www.dola.com/chat/async/chunk_stream', method: () => 'POST',
    resourceType: () => 'xhr', postData: () => '{"unvalidated":true}' }),
    abort: () => { asyncDecision = 'abort'; }, continue: () => { asyncDecision = 'continue'; } });
  assert.equal(asyncDecision, 'abort', 'unvalidated generation endpoint must not reach upstream');
  assert.equal(box.requestFlow.asyncStreamBlocked, 1);
});

test('actual route aborts when durable dispatch intent cannot be committed', async () => {
  const start = source.indexOf("    await ctx.route('**/*',");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let handler, continued = 0, aborted = 0;
  const box = { ctx: { route: async (_pattern, fn) => { handler = fn; } }, submissionBlocked: false,
    wireGate: createGenerationWireGate({ seconds: 30, isActive: () => true, sessionVerified: () => true }),
    onDispatch: () => { throw Error('synthetic journal write failure'); },
    BLOCK_TYPES: new Set(), identifyGenerationRequest, createGenerationAckObserver };
  box.URL = URL;
  box.requestFlow = { completion: 0, asyncStream: 0, otherChat: 0, logoutBlocked: 0, asyncStreamBlocked: 0 };
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', box);
  await handler({ request: () => ({ url: () => 'https://www.dola.com/chat/completion', method: () => 'POST',
    postData: () => JSON.stringify({ chat_ability: { ability_type: 17, ability_param: { model: 'seedance_v2.5', duration: 10 } } }) }),
    continue: () => { continued++; }, abort: () => { aborted++; } });
  assert.equal(continued, 0); assert.equal(aborted, 1); assert.equal(box.submissionBlocked, true);
});

test('actual response handler persists only an ACK correlated to the exact forwarded request', async t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_videos SET status='submitting'");
  journal.recordSubmissionDispatch(h.db, { taskId: 1, account: h.db.prepare('SELECT * FROM dola_accounts').get(),
    deadlineAt: new Date(Date.now() + 60000).toISOString() });
  const start = source.indexOf("    ctx.on('response', (res)");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let callback, resolved = 0;
  const request = {}, streamErrors = [];
  const box = { ctx: { on: (_event, fn) => { callback = fn; } }, submittedRequest: request, streamErrors,
    receiptReads: new Set(), receiptCollectorClosed: false, submissionOutcome: { error: null }, isActive: () => true,
    ackObserver: createGenerationAckObserver({ localConversationId: 'local-c', localMessageIds: ['local-m'] }),
    onConversation: (id, evidence) => journal.recordSubmissionConversation(h.db, 1, id, evidence),
    resolveAck: () => { resolved++; } };
  vm.runInNewContext(source.slice(start, end), box);
  let reads = 0;
  const text = 'event: SSE_ACK\ndata: ' + JSON.stringify({ ack_client_meta: { local_conversation_id: 'local-c',
    conversation_id: '1234567890123' }, query_list: [{ local_message_id: 'local-m' }] }) + '\n\n';
  await callback({ request: () => ({}), text: async () => { reads++; return text; } });
  assert.equal(reads, 0); assert.equal(resolved, 0);
  await callback({ request: () => request, text: async () => text });
  assert.equal(resolved, 1);
  assert.equal(journal.getSubmission(h.db, 1).evidence, 'sse_ack');
  assert.equal(h.row().conversation_id, '1234567890123');
  assert.deepEqual(streamErrors, []);
});

test('late ACK conflicting with persisted URL is reported to the worker, never swallowed', async t => {
  const h = fixture(t); sentReceipt(h, { evidence: 'conversation_url' });
  const start = source.indexOf("    ctx.on('response', (res)");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let callback;
  const request = {}, outcome = { error: null };
  const box = { ctx: { on: (_event, fn) => { callback = fn; } }, submittedRequest: request, streamErrors: [],
    receiptReads: new Set(), receiptCollectorClosed: false, submissionOutcome: outcome, isActive: () => true,
    ackObserver: createGenerationAckObserver({ localConversationId: 'local-c', localMessageIds: ['local-m'] }),
    onConversation: (id, evidence) => journal.recordSubmissionConversation(h.db, 1, id, evidence), resolveAck() {} };
  vm.runInNewContext(source.slice(start, end), box);
  const text = 'event: SSE_ACK\ndata: ' + JSON.stringify({ ack_client_meta: { local_conversation_id: 'local-c',
    conversation_id: '9999999999999' }, query_list: [{ local_message_id: 'local-m' }] }) + '\n\n';
  await callback({ request: () => request, text: async () => text });
  assert.equal(outcome.error, 'correlation_or_persistence_conflict');
  assert.equal(h.row().conversation_id, '1234567890123');
});

for (const condition of ['stale-block', 'late-ack-conflict']) {
  test(`${condition} after dispatch cannot refund or poll an unconfirmed conversation`, async t => {
    const h = fixture(t);
    h.overrides.submit = async (_cookie, options) => {
      options.onDispatch();
      return { conversationId: '1234567890123', submissionBlocked: condition === 'stale-block',
        submissionOutcome: { error: condition === 'late-ack-conflict' ? 'correlation_conflict' : null } };
    };
    await h.run();
    assert.equal(h.row().status, 'submitting');
    assert.equal(h.calls.chain, 0); assert.deepEqual(h.calls.refunds, []);
    assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
  });
}

for (const rejection of ['signature', 'rate-limit']) {
  test(`${rejection} settlement write failure cannot leave a rejected receipt with an unsettled active task`, async t => {
    const h = fixture(t);
    if (rejection === 'rate-limit') enableSyntheticRateLimit(h);
    h.db.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON dola_rate_limit_events BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;`);
    h.overrides.submit = async (_cookie, options) => {
      options.onDispatch();
      return rejection === 'signature' ? signatureRejectedSubmit() : rateLimitedSubmit();
    };
    h.box.startVideoTask(1);
    await h.immediate.shift()();
    assert.equal(h.row().status, 'submitting', JSON.stringify(h.row()));
    assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
    assert.equal(h.db.prepare('SELECT cooldown_until FROM dola_accounts').get().cooldown_until, null);
    assert.deepEqual(h.calls.refunds, []);
  });
}

test('startup finalizes a persisted rejection without changing it to uncertainty or resubmitting', t => {
  const h = fixture(t); sentReceipt(h);
  journal.closeSubmission(h.db, 1, 'rejected');
  h.box.recoverStaleVideoTasks();
  assert.equal(h.row().status, 'failed');
  assert.equal(journal.getSubmission(h.db, 1).state, 'rejected');
  assert.deepEqual(h.calls.refunds, [1]);
  assert.equal(h.immediate.length, 0); assert.equal(h.calls.submit, 0);
});

const readableProbe = () => ({ streams: [{ codec_type: 'video', width: 1280, height: 720, nb_read_frames: '750' }],
  format: { duration: '30.000000' } });

for (const [name, prepare, expected, ffprobeMissing] of [
  ['exit0 with decoder stderr error', reply => { reply.stderr = 'Invalid NAL unit size'; }, { seconds: null, status: 'unreadable' }],
  ['no video streams', reply => { reply.json.streams = []; }, { seconds: null, status: 'unreadable' }],
  ['audio-only stream', reply => { reply.json.streams[0].codec_type = 'audio'; }, { seconds: null, status: 'unreadable' }],
  ['zero decoded frames', reply => { reply.json.streams[0].nb_read_frames = '0'; }, { seconds: null, status: 'unreadable' }],
  ['unknown decoded frames', reply => { reply.json.streams[0].nb_read_frames = 'N/A'; }, { seconds: null, status: 'unreadable' }],
  ['invalid video dimensions', reply => { reply.json.streams[0].width = 0; }, { seconds: null, status: 'unreadable' }],
  ['malformed JSON', reply => { reply.stdout = '{invalid'; }, { seconds: null, status: 'unreadable' }],
  ['process timeout', reply => { reply.error = Object.assign(new Error('synthetic timeout'), { killed: true }); }, { seconds: null, status: 'unreadable' }],
  ['ffprobe binary missing', () => {}, { seconds: null, status: 'tool_missing' }, true],
  ['readable frames with valid duration', () => {}, { seconds: 30, status: 'ok' }],
]) {
  test(`original ffprobe function rejects damaged media: ${name}`, async () => {
    const reply = { json: readableProbe(), stderr: '' };
    prepare(reply);
    const calls = [];
    const execFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(reply.error || null, reply.stdout ?? JSON.stringify(reply.json), reply.stderr);
    };
    // Match node:child_process execFile's stdout/stderr promisified result without
    // starting any process or reading a fixture media file.
    execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
      execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
    const start = source.indexOf('async function probeVideoDuration(');
    const end = source.indexOf('\n/** 取归档文件路径', start);
    assert.ok(start > 0 && end > start);
    const box = { execFile, promisify,
      resolveFfprobePath: ffprobeMissing
        ? async () => { throw new Error('synthetic ffprobe missing'); }
        : async () => '/synthetic-only/ffprobe' };
    vm.runInNewContext('const execFileAsync = promisify(execFile);\n' + source.slice(start, end)
      + '\nglobalThis.probe = probeVideoDuration;', box);
    // vm 沙盒内创建的对象原型与外部 realm 不同，deepStrictEqual 会误判，逐字段断言。
    const probed = await box.probe('/synthetic-only/no-media-file.mp4');
    assert.equal(probed.seconds, expected.seconds);
    assert.equal(probed.status, expected.status);
    assert.equal(calls.length, ffprobeMissing ? 0 : 1);
    if (ffprobeMissing) return; // 工具缺失时不应启动任何子进程
    assert.equal(calls[0].file, '/synthetic-only/ffprobe');
    assert.deepEqual(Array.from(calls[0].args), ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height,nb_read_frames:format=duration', '-of', 'json',
      '/synthetic-only/no-media-file.mp4']);
    assert.equal(calls[0].options.timeout, 30000);
  });
}

// ─────────────── 提示词包装：两条硬约束（提交时包装、库里留原文）───────────────
//
// 这两条是 prompt-wrap.js 文件头写死的约束，也是最容易被"顺手改坏"的地方：
//   ① 发给上游的必须是包装后的文本（否则开关点了没意义）；
//   ② 库里存的、以及 /v1 回给调用方的必须是**用户原文**
//      （否则调用方会看到自己没写过的话术，历史任务也对不上）。
// 只验 ① 会漏掉 ② —— 而 ② 一旦写错，破坏的是对账与可复现性，事后再查非常难。
test('★ 开关关闭时：发给上游的就是用户原文（默认行为不许变）', async t => {
  const h = fixture(t);
  await h.run();
  assert.equal(h.calls.submit, 1);
  assert.deepEqual(h.calls.prompts, ['synthetic-only']);
  assert.equal(h.row().prompt, 'synthetic-only');
});

test('★ 开关开启时：发给上游的是包装文本，而库里仍存用户原文', async t => {
  const h = fixture(t, { wrap: true });
  await h.run();
  assert.equal(h.calls.submit, 1);
  // ① 上游看到的：前缀 + 换行 + 原文
  assert.deepEqual(h.calls.prompts, [`${WRAP_PREFIX}\nsynthetic-only`]);
  // ② 库里留的：仍然是用户原文（没被包装污染）
  assert.equal(h.row().prompt, 'synthetic-only');
});

test('a completed send click without a captured completion request stays pending for review', async t => {
  const h = fixture(t);
  h.overrides.submit = async () => ({ conversationId: null, streamErrors: [],
    wire: { forwarded: 0, blocked: 0 },
    dispatch: { sendActionCompleted: true, conversationLocated: false, dispatched: false },
    requestFlow: { completion: 0, asyncStream: 1, otherChat: 0, logoutBlocked: 0 } });
  await h.run();
  assert.equal(h.row().status, 'submitting');
  assert.match(h.row().stage, /待核对/);
  assert.match(h.row().error, /asyncStream=1/);
  assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
  assert.equal(h.calls.submit, 1);
  assert.deepEqual(h.calls.refunds, []);
  assert.equal(h.box.candidates(null, 10).length, 0);
});
