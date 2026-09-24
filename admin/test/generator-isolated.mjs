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
import { installVideoRequestAdapter, rewriteVideoDurationBody } from '../server/dola/generation-request.js';
import { createGenerationWireGate } from '../server/dola/generation-wire.js';
import * as journal from '../server/dola/submission-journal.js';
import { identifyGenerationRequest, createGenerationAckObserver } from '../server/dola/generation-ack.js';
import { GENERATION_GUARD_SCHEMA, hasGenerationGuard, recordGenerationGuard } from '../server/dola/generation-guards.js';

const source = readFileSync(new URL('../server/dola/generator.js', import.meta.url), 'utf8');
const code = source.replace(/^import[\s\S]*?;\n/gm, '').replace(/\bexport /g, '')
  .replaceAll('import.meta.url', JSON.stringify('file:///synthetic-only/generator.js'));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const liveProfile = () => ({ ok: true, status: 200, code: 0, membershipLevel: 'pro', hasActiveSubscription: true, entityId: 'synthetic-dola' });
const artifact = () => ({ path: '/synthetic-only/not-a-real-file.mp4', bytes: 4096 });

function fixture(t, { owner = null, seconds = 30 } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dola_videos (
    id INTEGER PRIMARY KEY,account_id,account_label,conversation_id,prompt,ratio,seconds,force_seconds,status,stage,
    watermarked_url,unwatermarked_url,unwatermark_note,is_unwatermarked,local_path,local_bytes,duration_sec,bytes,error,
    owner_token_id,owner_prefix,charge_ref,has_reference_images,reference_image_count,strict_account,created_by,created_at,updated_at,finished_at);
    CREATE TABLE dola_accounts (id INTEGER PRIMARY KEY,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,
    cooldown_until,last_used_at,updated_at,last_check_at,last_error,quota_remaining,quota_source,quota_at,exit_ip,
    native_15s_state TEXT NOT NULL DEFAULT 'available', native_15s_at TEXT, native_15s_note TEXT NOT NULL DEFAULT '',
    native_30s_state TEXT NOT NULL DEFAULT 'available', native_30s_at TEXT, native_30s_note TEXT NOT NULL DEFAULT '',
    reference_image_state TEXT NOT NULL DEFAULT 'available', reference_image_at TEXT, reference_image_note TEXT NOT NULL DEFAULT '');
    CREATE TABLE point_transactions (id INTEGER PRIMARY KEY,token_id,kind,ref,delta);
    CREATE TABLE dola_rate_limit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT,account_id,video_id,exit_ip,cooldown_until,detail,created_at);`);
  db.prepare(`INSERT INTO dola_accounts (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES (1,'synthetic-account','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','synthetic-hash','synthetic-dola','pro','192.0.2.10','available')`).run();
  db.prepare(`INSERT INTO dola_videos (id,account_id,prompt,seconds,force_seconds,status,owner_token_id,charge_ref)
    VALUES (1,1,'synthetic-only',?,?,'queued',?,'')`).run(seconds, seconds === 30 ? 30 : null, owner);
  const calls = { profile: 0, preflight: 0, submit: 0, chain: 0, resolve: 0, archive: 0, probe: 0, containerProbe: 0, cookies: 0, refunds: [] };
  db.exec(GENERATION_GUARD_SCHEMA);
  db.exec(journal.SUBMISSION_JOURNAL_SCHEMA);
  const immediate = [];
  const overrides = {
    profile: async () => liveProfile(),
    preflight: async (_cookies, options) => ({ ok: true, state: 'available', seconds: options.seconds,
      uiSeconds: options.seconds, native: true, rewriteCarrier: false,
      model: options.seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5' }),
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
    ...policy, installVideoRequestAdapter, rewriteVideoDurationBody, prepareNativeThirtySecondComposer: deny, prepareNativeVideoComposer: deny, prepareReferenceImageComposer: deny, listReferenceImages: async () => [], cleanupReferenceImages: async () => {},
    db, path, fileURLToPath, promisify, execFile: deny, fs: new Proxy({}, { get: () => deny }),
    getSetting: (_key, fallback) => fallback, getPlaywright: deny, proxyOf: acc => ({ server: acc.proxy }), fetch: deny, startSocksBridge: deny,
    probeNativeVideoViaBrowser: async (...args) => { calls.preflight++; assert.equal(args[1].proxyUrl, 'http://proxy.example.invalid:8080'); return overrides.preflight(...args); },
    parseCookies: value => { assert.equal(value, 'SYNTHETIC_ONLY'); calls.cookies++; return { synthetic: 'synthetic' }; },
    fetchProfile: async (...args) => { calls.profile++; assert.equal(args[1].proxy, 'http://proxy.example.invalid:8080'); return overrides.profile(...args); },
    pullChain: async (...args) => { calls.chain++; assert.equal(args[2].proxy, 'http://proxy.example.invalid:8080'); return overrides.chain(...args); },
    extractUnwatermarked: async (...args) => { calls.resolve++; return overrides.resolve(...args); },
    parseVideoQuotaReceipt: () => ({}), DOLA_HEADERS: {},
    settleFailedVideoRefund: (_db, row) => { assert.equal(row.status, 'failed'); calls.refunds.push(row.id); return { refunded: true }; },
    Date, URL, AbortController, Buffer, console: { log() {}, warn() {}, error() {} },
    setImmediate: fn => immediate.push(fn), setTimeout: deny, clearTimeout() {},
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  box.originalSubmit = box.submitViaBrowser;
  box.originalArchive = box.archiveVideo;
  box.submitViaBrowser = async (...args) => { calls.submit++; return overrides.submit(...args); };
  box.archiveVideo = async (...args) => { calls.archive++; assert.equal(args[1].proxyUrl, undefined); return overrides.archive(...args); };
  box.probeVideoDuration = async (...args) => { calls.probe++; return overrides.probe(...args); };
  box.probeMp4ContainerDuration = async (...args) => { calls.containerProbe++; return overrides.containerProbe(...args); };
  return { db, box, calls, overrides, immediate,
    row: () => db.prepare('SELECT * FROM dola_videos WHERE id=1').get(),
    run: () => box.run(1, { maxMin: 1 }), cancel: () => box.cancelVideoTask(1),
  };
}

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

function addRotationAccount(h, id, exitIp) {
  h.db.prepare(`INSERT INTO dola_accounts (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES (?,'synthetic-account','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080',?,'synthetic-dola','pro',?,'available')`)
    .run(id, `synthetic-hash-${id}`, exitIp);
}

const rateLimitedSubmit = () => ({ conversationId: null, streamErrors: [{ code: 710022002, error_msg: '当前服务访问频繁' }], cap: [] });

async function drainImmediate(h) {
  for (const fn of h.immediate.splice(0)) await fn();
  await flush();
}

test('rate-limited submission cools the account, auto-rotates and retries', async t => {
  const h = fixture(t);
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

test('rotation stops after max attempts with a rotation summary', async t => {
  const h = fixture(t);
  addRotationAccount(h, 2, '192.0.2.11');
  addRotationAccount(h, 3, '192.0.2.12');
  h.overrides.submit = rateLimitedSubmit;
  await h.run();
  await drainImmediate(h); // 第 2 次：2 号限流 → 换 3 号
  await drainImmediate(h); // 第 3 次：3 号限流 → 达到上限，失败
  const row = h.row();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /已自动轮询 3 个账号/);
  assert.match(row.error, /#1.*#2.*#3/);
  assert.match(row.error, /已达自动换号上限/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM dola_rate_limit_events WHERE video_id=1').get().c, 3);
  assert.deepEqual(h.calls.refunds, [1], '最终失败才退款一次');
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
  h.overrides.submit = rateLimitedSubmit;
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

for (const seconds of [10, 15, 20, 30]) {
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

for (const seconds of [20, 30]) {
  test(`${seconds}s carrier-only probe is rejected before task creation or charge`, async t => {
    const h = fixture(t);
    h.overrides.preflight = async () => ({ ok: true, state: 'available', seconds,
      uiSeconds: 10, native: false, rewriteCarrier: true, model: 'seedance_v2.5' });
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
    const pending = h.box.createVideoTask({ prompt: 'synthetic', seconds: 10 }); await flush();
    h.db.exec(`UPDATE dola_accounts SET ${change} WHERE id=1`);
    gate.resolve({ ok: true, state: 'available', seconds: 10, uiSeconds: 10, native: true, rewriteCarrier: false, model: 'seedance_v2.5' });
    await assert.rejects(pending, e => e.code === 'GENERATION_PREFLIGHT_STALE');
    assert.equal(h.immediate.length, 0); assert.equal(h.box.generationStatus().reservedAccounts, 0);
  });
}
test('preflight exceptions are sanitized and do not poison login state', async t => {
  const h = fixture(t); h.overrides.preflight = async () => { throw new Error('SYNTHETIC_SECRET'); };
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10 }), e => e.code === 'GENERATION_PREFLIGHT_FAILED' && !e.message.includes('SYNTHETIC_SECRET'));
  assert.equal(h.db.prepare('SELECT status FROM dola_accounts WHERE id=1').get().status, 'valid');
  assert.equal(h.box.generationStatus().reservedAccounts, 0);
});
test('strict acceptance account never silently falls back', async t => {
  const h = fixture(t);
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10, accountId: 999, strictAccount: true }), e => e.status === 409);
  assert.equal(h.calls.profile, 0); assert.equal(h.calls.preflight, 0);
  const row = await h.box.createVideoTask({ prompt: 'synthetic', seconds: 10, accountId: 1, strictAccount: true });
  assert.equal(row.account_id, 1); assert.equal(h.calls.preflight, 1);
});
test('preflight concurrency is bounded and busy refusal releases the account', async t => {
  const h = fixture(t), gate = deferred();
  h.db.exec(`INSERT INTO dola_accounts(id,label,cookie,status,proxy,cookie_hash,sec_user_id,exit_ip)
    VALUES(2,'second','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','hash2','synthetic-dola','192.0.2.11')`);
  h.overrides.preflight = () => gate.promise;
  const pending = h.box.createVideoTask({ prompt: 'first', seconds: 10, accountId: 1, strictAccount: true }); await flush();
  await assert.rejects(h.box.createVideoTask({ prompt: 'second', seconds: 10, accountId: 2, strictAccount: true }), e => e.code === 'GENERATION_PREFLIGHT_BUSY');
  assert.equal(h.calls.preflight, 1);
  gate.resolve({ ok: true, state: 'available', seconds: 10, uiSeconds: 10, native: true, rewriteCarrier: false, model: 'seedance_v2.5' }); await pending;
  assert.equal(h.box.generationStatus().reservedAccounts, 0);
});

test('inconsistent duration is rejected before account lookup/probe/insert', async t => {
  const h = fixture(t);
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10, forceSeconds: 30 }), e => e.status === 400);
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
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10 }), e => e.status === 409);
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
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10, accountId: 1, strictAccount: true }),
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
    return { ok: true, state: 'available', seconds: options.seconds, uiSeconds: options.seconds,
      native: true, rewriteCarrier: false, model: options.seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5' };
  };
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10 }),
    e => e.code === 'GENERATION_PREFLIGHT_STALE');
  assert.equal(h.calls.submit, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM dola_videos').get().n, 1);
});

test('missing media-verification executable rejects before browser preflight or task creation', async t => {
  const h = fixture(t);
  h.box.resolveFfprobePath = async () => { throw Object.assign(new Error('synthetic missing ffprobe'), {
    code: 'GENERATION_PREFLIGHT_MEDIA_UNAVAILABLE', status: 503,
  }); };
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10 }),
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

test('numeric conversation URL cannot override an explicit upstream rate-limit response', async t => {
  const h = fixture(t);
  // dola_rate_limit_events 已由 fixture 建好
  h.overrides.submit = async () => ({ conversationId: '1234567890123', streamErrors: [{ code: 710022002 }],
    wire: { forwarded: 1, blocked: 0 } });
  await h.run();
  assert.equal(h.row().status, 'failed');
  assert.match(h.row().error, /710022002/);
  assert.match(h.row().error, /放行 1 次/);
  assert.equal(h.calls.chain, 0);
  assert.equal(h.calls.submit, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM dola_rate_limit_events').get().n, 1);
  assert.equal(h.db.prepare('SELECT status FROM dola_accounts').get().status, 'valid');
});
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
  assert.equal(h.row().status, 'submitting');
  assert.match(h.row().stage, /待核对/);
  assert.deepEqual(h.calls.refunds, []);
  assert.equal(h.calls.submit, 1);
  assert.equal(h.box.candidates(null, 10).length, 0);
  assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
  await assert.rejects(h.box.createVideoTask({ prompt: 'another prompt', accountId: 1, strictAccount: true, seconds: 10 }),
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
  const start = source.indexOf('      await ctx.addInitScript(');
  const end = source.indexOf('\n    }\n\n    const page =', start);
  assert.ok(start > 0 && end > start);
  let argCount;
  const box = { forceSeconds: 30, targetModel: 'seedance_v2.5', installVideoRequestAdapter };
  box.ctx = { addInitScript: async (...args) => {
    argCount = args.length;
    assert.equal(args[0], installVideoRequestAdapter);
    assert.equal(JSON.stringify(args[1]), JSON.stringify({
      seconds: 30, targetModel: 'seedance_v2.5', rewrite: true,
    }));
  } };
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', box);
  assert.equal(argCount, 2);
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
});

test('actual route aborts when durable dispatch intent cannot be committed', async () => {
  const start = source.indexOf("    await ctx.route('**/*',");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let handler, continued = 0, aborted = 0;
  const box = { ctx: { route: async (_pattern, fn) => { handler = fn; } }, submissionBlocked: false,
    wireGate: createGenerationWireGate({ seconds: 10, isActive: () => true, sessionVerified: () => true }),
    onDispatch: () => { throw Error('synthetic journal write failure'); },
    BLOCK_TYPES: new Set(), identifyGenerationRequest, createGenerationAckObserver };
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

test('rate-limit settlement write failure cannot leave a rejected receipt with an unsettled active task', async t => {
  const h = fixture(t);
  h.db.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON dola_rate_limit_events BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;`);
  h.overrides.submit = async (_cookie, options) => {
    options.onDispatch();
    return { streamErrors: [{ code: 710022002 }] };
  };
  h.box.startVideoTask(1);
  await h.immediate.shift()();
  assert.equal(h.row().status, 'submitting');
  assert.equal(journal.getSubmission(h.db, 1).state, 'uncertain');
  assert.equal(h.db.prepare('SELECT cooldown_until FROM dola_accounts').get().cooldown_until, null);
  assert.deepEqual(h.calls.refunds, []);
});

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
