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
import { installVideoRequestAdapter } from '../server/dola/generation-request.js';

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
    owner_token_id,owner_prefix,charge_ref,has_reference_images,reference_image_count,created_by,created_at,updated_at,finished_at);
    CREATE TABLE dola_accounts (id INTEGER PRIMARY KEY,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,
    cooldown_until,last_used_at,updated_at,last_check_at,last_error,quota_remaining,quota_source,quota_at,exit_ip,
    native_15s_state TEXT NOT NULL DEFAULT 'available', native_15s_at TEXT, native_15s_note TEXT NOT NULL DEFAULT '',
    native_30s_state TEXT NOT NULL DEFAULT 'available', native_30s_at TEXT, native_30s_note TEXT NOT NULL DEFAULT '',
    reference_image_state TEXT NOT NULL DEFAULT 'available', reference_image_at TEXT, reference_image_note TEXT NOT NULL DEFAULT '');
    CREATE TABLE point_transactions (id INTEGER PRIMARY KEY,token_id,kind,ref,delta);`);
  db.prepare(`INSERT INTO dola_accounts (id,label,cookie,status,proxy,cookie_hash,sec_user_id,membership,exit_ip,native_30s_state)
    VALUES (1,'synthetic-account','SYNTHETIC_ONLY','valid','http://proxy.example.invalid:8080','synthetic-hash','synthetic-dola','pro','192.0.2.10','available')`).run();
  db.prepare(`INSERT INTO dola_videos (id,account_id,prompt,seconds,force_seconds,status,owner_token_id,charge_ref)
    VALUES (1,1,'synthetic-only',?,?,'queued',?,'')`).run(seconds, seconds === 30 ? 30 : null, owner);
  const calls = { profile: 0, submit: 0, chain: 0, resolve: 0, archive: 0, probe: 0, cookies: 0, refunds: [] };
  const immediate = [];
  const overrides = {
    profile: async () => liveProfile(),
    submit: async () => ({ conversationId: '1234567890123', cap: [] }),
    chain: async () => ({ ok: true, text: 'https://media.example.invalid/synthetic-output.mp4', json: {} }),
    resolve: async () => ({ videos: [], attempts: [] }),
    archive: async () => artifact(),
    probe: async () => seconds,
  };
  const deny = () => { throw new Error('isolated_test_forbidden_io'); };
  const box = {
    ...policy, installVideoRequestAdapter, prepareNativeThirtySecondComposer: deny, prepareNativeVideoComposer: deny, prepareReferenceImageComposer: deny, listReferenceImages: async () => [], cleanupReferenceImages: async () => {},
    db, path, fileURLToPath, promisify, execFile: deny, fs: new Proxy({}, { get: () => deny }),
    getSetting: (_key, fallback) => fallback, getPlaywright: deny, proxyOf: deny, fetch: deny, startSocksBridge: deny,
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
  probe.resolve(29.97); await work;
  assert.equal(h.row().status, 'ready'); assert.equal(h.row().duration_sec, 29.97);
  assert.deepEqual(h.calls.refunds, []);
});

for (const condition of ['archive', 'unknown-duration', 'mismatch']) {
  test(`${condition} fails final acceptance and invokes failure settlement once`, async t => {
    const h = fixture(t);
    if (condition === 'archive') h.overrides.archive = async () => null;
    if (condition === 'unknown-duration') h.overrides.probe = async () => null;
    if (condition === 'mismatch') h.overrides.probe = async () => 10;
    await h.run();
    assert.equal(h.row().status, 'failed'); assert.deepEqual(h.calls.refunds, [1]);
    h.box.fail(1, 'late failure'); assert.deepEqual(h.calls.refunds, [1]);
  });
}

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

test('inconsistent duration is rejected before account lookup/probe/insert', async t => {
  const h = fixture(t);
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 10, forceSeconds: 30 }), e => e.status === 400);
  assert.equal(h.calls.cookies, 0); assert.equal(h.immediate.length, 0);
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
    e => e.status === 409 && /页面原生能力探测/.test(e.message),
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
test('identity mismatch is rejected before selecting an account or running a queued job', async t => {
  const h = fixture(t); h.overrides.profile = async () => ({ ...liveProfile(), entityId: 'different-synthetic-user' });
  await assert.rejects(h.box.createVideoTask({ prompt: 'synthetic', seconds: 30 }), e => e.status === 409);
  await h.run(); assert.equal(h.row().status, 'failed'); assert.equal(h.calls.submit, 0);
});
test('native capability rejection never enters polling even if a conversation URL exists', async t => {
  const h = fixture(t); h.overrides.submit = async () => ({ conversationId: '1234567890123', submissionBlocked: true });
  await h.run(); assert.equal(h.row().status, 'failed'); assert.equal(h.calls.chain, 0);
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

test('browser installs the 30s duration observer with exactly one serializable option object', async () => {
  const start = source.indexOf('      await ctx.addInitScript(');
  const end = source.indexOf('\n    }\n\n    const page =', start);
  assert.ok(start > 0 && end > start);
  let argCount;
  const box = { forceSeconds: 30, targetModel: 'seedance_v2.5', installVideoRequestAdapter };
  box.ctx = { addInitScript: async (...args) => {
    argCount = args.length;
    assert.equal(args[0], installVideoRequestAdapter);
    assert.equal(JSON.stringify(args[1]), JSON.stringify({
      seconds: 30, targetModel: 'seedance_v2.5', rewrite: false,
    }));
  } };
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', box);
  assert.equal(argCount, 2);
});

test('the actual browser request interceptor blocks nonnative 30s and cancelled submission', async () => {
  const start = source.indexOf("    await ctx.route('**/*',");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  let callback;
  const box = { ctx: { route: async (_pattern, handler) => { callback = handler; } }, forceSeconds: 30,
    sessionVerified: true, isActive: () => true, isNativeThirtySecondRequest: policy.isNativeThirtySecondRequest,
    submissionBlocked: false, BLOCK_TYPES: new Set(['image', 'font', 'media']) };
  await vm.runInNewContext('(async()=>{' + source.slice(start, end) + '})()', box);
  const send = async (duration, model = 'seedance_v2.5') => {
    let decision;
    await callback({ request: () => ({ url: () => 'https://www.dola.com/chat/completion', resourceType: () => 'xhr',
      postData: () => JSON.stringify({ chat_ability: { ability_type: 17, ability_param: { model, duration } } }) }),
    abort: () => { decision = 'abort'; }, continue: () => { decision = 'continue'; } });
    return decision;
  };
  assert.equal(await send(10), 'abort');
  assert.equal(await send(30, 'unknown-model'), 'abort');
  assert.equal(await send(30), 'continue');
  box.sessionVerified = false;
  assert.equal(await send(30), 'abort');
  box.sessionVerified = true;
  box.isActive = () => false;
  assert.equal(await send(30), 'abort');
});

const readableProbe = () => ({ streams: [{ codec_type: 'video', width: 1280, height: 720, nb_read_frames: '750' }],
  format: { duration: '30.000000' } });

for (const [name, prepare, expected] of [
  ['exit0 with decoder stderr error', reply => { reply.stderr = 'Invalid NAL unit size'; }, null],
  ['no video streams', reply => { reply.json.streams = []; }, null],
  ['audio-only stream', reply => { reply.json.streams[0].codec_type = 'audio'; }, null],
  ['zero decoded frames', reply => { reply.json.streams[0].nb_read_frames = '0'; }, null],
  ['unknown decoded frames', reply => { reply.json.streams[0].nb_read_frames = 'N/A'; }, null],
  ['invalid video dimensions', reply => { reply.json.streams[0].width = 0; }, null],
  ['malformed JSON', reply => { reply.stdout = '{invalid'; }, null],
  ['process timeout', reply => { reply.error = Object.assign(new Error('synthetic timeout'), { killed: true }); }, null],
  ['readable frames with valid duration', () => {}, 30],
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
    const box = { execFile, promisify };
    vm.runInNewContext('const execFileAsync = promisify(execFile);\n' + source.slice(start, end)
      + '\nglobalThis.probe = probeVideoDuration;', box);
    assert.equal(await box.probe('/synthetic-only/no-media-file.mp4'), expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'ffprobe');
    assert.deepEqual(Array.from(calls[0].args), ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height,nb_read_frames:format=duration', '-of', 'json',
      '/synthetic-only/no-media-file.mp4']);
    assert.equal(calls[0].options.timeout, 30000);
  });
}
