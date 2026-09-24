import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { generationAnalytics, classifyFailure } from '../server/dola/generation-analytics.js';
import { GENERATION_GUARD_SCHEMA, recordGenerationGuard, hasGenerationGuard,
  clearGenerationGuard, seedHistoricalGenerationGuards, listGenerationGuards } from '../server/dola/generation-guards.js';

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE dola_videos(id INTEGER PRIMARY KEY,account_id,seconds,status,error,created_at,finished_at,updated_at,has_reference_images);
    CREATE TABLE dola_accounts(id INTEGER PRIMARY KEY,status,cookie_hash,proxy,sec_user_id,updated_at,cooldown_until,
      native_15s_state,native_15s_at,native_15s_note,native_30s_state,native_30s_at,native_30s_note,
      reference_image_state,reference_image_at,reference_image_note);
    INSERT INTO dola_accounts(id,status,cookie_hash,proxy,sec_user_id,native_15s_state,native_30s_state)
      VALUES(1,'valid','synthetic','synthetic-proxy','synthetic-user','available','available');`);
  db.exec(GENERATION_GUARD_SCHEMA);
  const add = (id, status, at, error = '', seconds = 15) => db.prepare(`INSERT INTO dola_videos
    (id,account_id,seconds,status,error,created_at,finished_at,updated_at) VALUES(?,1,?,?,?,?,?,?)`)
    .run(id, seconds, status, error, at, at, at);
  const account = () => db.prepare('SELECT * FROM dola_accounts WHERE id=1').get();
  const row = id => db.prepare('SELECT * FROM dola_videos WHERE id=?').get(id);
  return { db, add, account, row };
}

const nativeProbe = seconds => ({ ok: true, state: 'available', seconds, uiSeconds: seconds,
  model: seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5', native: true, rewriteCarrier: false });

test('hourly cohorts reconcile, include current hour, fill zeros and use created not finished time', t => {
  const h = fixture(t);
  h.add(1, 'ready', '2026-09-20T17:01:00.000Z');
  h.db.exec("UPDATE dola_videos SET finished_at='2026-09-20T18:00:00.000Z' WHERE id=1");
  h.add(2, 'failed', '2026-09-20T17:30:00.000Z', '上游限流 code 710022002 secret=not-public');
  h.add(3, 'queued', '2026-09-20T18:00:00.000Z');
  h.add(4, 'cancelled', '2026-09-20T18:01:00.000Z');
  h.add(5, 'ready', '2026-09-18T18:00:00.000Z');
  const result = generationAnalytics(h.db, { at: '2026-09-20T18:05:00.000Z' });
  assert.equal(result.hourly.length, 24);
  assert.deepEqual(result.totals, { created: 4, succeeded: 1, failed: 1, pending: 1, cancelled: 1, other: 0 });
  assert.equal(result.allTime.created, 5); assert.equal(result.successRate, 50);
  assert.equal(result.hourly[1].succeeded, 1); assert.equal(result.hourly[0].succeeded, 0);
  assert.equal(result.hourly[2].created, 0);
  assert.equal(result.reasons.reduce((sum, r) => sum + r.count, 0), result.totals.failed);
  assert.equal(JSON.stringify(result).includes('not-public'), false);
  assert.equal(result.hourly.reduce((sum, r) => sum + r.created, 0), result.totals.created);
  assert.deepEqual(generationAnalytics(h.db, { at: result.until, timezone: 'Asia/Shanghai' }).totals, result.totals);
  for (const r of result.hourly) assert.equal(r.created, r.succeeded + r.failed + r.pending + r.cancelled + r.other);
});

test('empty range has no invented success rate; repeated DST hours remain distinct', t => {
  const { db } = fixture(t);
  const result = generationAnalytics(db, { at: '2026-11-01T08:00:00Z' });
  assert.equal(result.successRate, null);
  assert.notEqual(result.hourly[1].label, result.hourly[2].label);
  assert.match(result.hourly[1].label, /GMT-6/); assert.match(result.hourly[2].label, /GMT-5/);
  assert.throws(() => generationAnalytics(db, { hours: 10000 }), /范围/);
  assert.throws(() => generationAnalytics(db, { timezone: "UTC'; DROP TABLE dola_videos" }), /时区/);
});

test('failure categories use observed evidence, never return raw secrets or infer rate-limit root cause', () => {
  const samples = [
    ['上游限流 code 710022002；根因是同一个出口 IP', 'rate_limit'],
    ['未确认原生 15 秒：没有唯一可选的原生单次时长选项', 'capability'],
    ['原生 10 秒能力探测未完成：页面没有可见的视频生成入口', 'capability'],
    ['页面未能确认可用的 Seedance 2.5 模型', 'capability'],
    ['参考图能力探测未完成：没有图片控件', 'reference'],
    ['现场账号身份不一致', 'session'], ['网络 timeout', 'network'],
    ['原生视频时长验收失败', 'duration'], ['归档失败', 'archive'],
    ['服务重启中断', 'interrupted'], ['计费不一致', 'billing'],
    ['没拿到 conversationId', 'receipt'], ['unexpected cookie_secret_value', 'session'],
  ];
  for (const [text, code] of samples) assert.equal(classifyFailure(text).code, code, text);
  assert.equal(JSON.stringify(classifyFailure('cookie_secret_value')).includes('cookie_secret_value'), false);
  assert.match(classifyFailure('710022002').action, /不能单独证明/);
});

test('capability failure revokes stale available flag, blocks only matching capability, preserves login/cooldown', t => {
  const h = fixture(t);
  h.db.exec("UPDATE dola_accounts SET cooldown_until='2099-01-01'");
  h.add(1, 'failed', '2026-09-20T17:00:00.000Z', '未确认原生 15 秒');
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), true);
  assert.equal(h.account().native_15s_state, 'unknown'); assert.equal(h.account().native_30s_state, 'available');
  assert.equal(h.account().status, 'valid'); assert.equal(h.account().cooldown_until, '2099-01-01');
  assert.equal(hasGenerationGuard(h.db, 1, 15), true); assert.equal(hasGenerationGuard(h.db, 1, 10), false);
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), false);
});

test('cancel, changed credentials/proxy and newer probe cannot be poisoned by late failures', t => {
  const h = fixture(t);
  h.add(1, 'cancelled', '2026-09-20T17:00:00.000Z', '未确认原生 15 秒');
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), false);
  h.db.exec("UPDATE dola_videos SET status='failed'");
  const old = h.account(); h.db.exec("UPDATE dola_accounts SET proxy='changed'");
  assert.equal(recordGenerationGuard(h.db, h.row(1), old), false);
  h.db.exec("UPDATE dola_accounts SET native_15s_at='2026-09-20T18:00:00.000Z'");
  assert.equal(recordGenerationGuard(h.db, h.row(1), h.account()), false);
  assert.equal(listGenerationGuards(h.db).length, 0);
});

test('only successful, current and idle probe lifts guard; historical backfill does not re-block it', t => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-20T17:00:00.000Z', '原生 10 秒能力探测未完成', 10);
  assert.equal(seedHistoricalGenerationGuards(h.db), 1);
  const guard = listGenerationGuards(h.db)[0], account = h.account();
  assert.equal(clearGenerationGuard(h.db, guard, account, { ok: false, state: 'unknown' }), false);
  h.add(2, 'queued', '2026-09-20T18:00:00.000Z');
  assert.equal(clearGenerationGuard(h.db, guard, account, nativeProbe(10)), false);
  h.db.exec("UPDATE dola_videos SET status='cancelled' WHERE id=2");
  assert.equal(clearGenerationGuard(h.db, guard, { ...account, cookie_hash: 'old' }, nativeProbe(10)), false);
  assert.equal(clearGenerationGuard(h.db, guard, account, nativeProbe(10), '2026-09-20T18:01:00.000Z'), true);
  assert.equal(hasGenerationGuard(h.db, 1, 10), false);
  assert.equal(seedHistoricalGenerationGuards(h.db), 0);
  h.add(3, 'failed', '2026-09-20T19:00:00.000Z', '原生 10 秒能力探测未完成', 10);
  recordGenerationGuard(h.db, h.row(3), h.account());
  assert.equal(clearGenerationGuard(h.db, guard, account, nativeProbe(10)), false);
  assert.equal(hasGenerationGuard(h.db, 1, 10), true);
});

for (const seconds of [20, 30]) {
  test(`10s rewrite carrier cannot clear a prior ${seconds}s capability failure`, t => {
    const h = fixture(t);
    h.add(1, 'failed', '2026-09-20T17:00:00.000Z', `未确认原生 ${seconds} 秒`, seconds);
    recordGenerationGuard(h.db, h.row(1), h.account());
    const guard = listGenerationGuards(h.db)[0], account = h.account();
    const before = JSON.stringify({ account, task: h.row(1), guard });
    const carrier = { ...nativeProbe(seconds), uiSeconds: 10, native: false, rewriteCarrier: true };
    assert.equal(clearGenerationGuard(h.db, guard, account, carrier), false);
    assert.equal(hasGenerationGuard(h.db, 1, seconds), true);
    assert.equal(JSON.stringify({ account: h.account(), task: h.row(1), guard: listGenerationGuards(h.db)[0] }), before);
    // Exact target evidence is distinct from the carrier and remains admissible.
    assert.equal(clearGenerationGuard(h.db, guard, account, nativeProbe(seconds)), true);
    assert.equal(h.row(1).status, 'failed', 'historical failure is never rewritten');
  });
}

for (const [label, patch] of [
  ['missing evidence', { seconds: undefined, uiSeconds: undefined, model: undefined, native: undefined, rewriteCarrier: undefined }],
  ['wrong duration', { seconds: 15, uiSeconds: 15 }],
  ['wrong model', { model: 'seedance_v2.0' }],
  ['wrong UI duration', { uiSeconds: 5 }],
  ['non-native evidence', { native: false }],
  ['request rewrite', { rewriteCarrier: true }],
]) {
  test(`duration guard rejects ${label} even when generic probe state is available`, t => {
    const h = fixture(t);
    h.add(1, 'failed', '2026-09-20T17:00:00.000Z', '未确认原生 10 秒', 10);
    recordGenerationGuard(h.db, h.row(1), h.account());
    assert.equal(clearGenerationGuard(h.db, listGenerationGuards(h.db)[0], h.account(), { ...nativeProbe(10), ...patch }), false);
    assert.equal(hasGenerationGuard(h.db, 1, 10), true);
  });
}

test('exact native 15s evidence retains the correct expert model contract', t => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-20T17:00:00.000Z', '未确认原生 15 秒', 15);
  recordGenerationGuard(h.db, h.row(1), h.account());
  const guard = listGenerationGuards(h.db)[0];
  assert.equal(clearGenerationGuard(h.db, guard, h.account(), { ...nativeProbe(15), model: 'seedance_v2.5' }), false);
  assert.equal(clearGenerationGuard(h.db, guard, h.account(), nativeProbe(15)), true);
});

test('later successful task / newer probe supersedes old failure; rate limit does not create capability guard', t => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-20T17:00:00.000Z', '未确认原生 15 秒');
  h.add(2, 'ready', '2026-09-20T18:00:00.000Z');
  h.add(3, 'failed', '2026-09-20T19:00:00.000Z', '上游限流 710022002');
  assert.equal(seedHistoricalGenerationGuards(h.db), 0);
  h.add(4, 'failed', '2026-09-20T20:00:00.000Z', '参考图能力探测未完成');
  seedHistoricalGenerationGuards(h.db);
  assert.equal(hasGenerationGuard(h.db, 1, 15, true), true);
  assert.equal(hasGenerationGuard(h.db, 1, 15, false), false);
});

test('text-only success does not mask earlier successful reference-image evidence during backfill', t => {
  const h = fixture(t);
  h.add(1, 'failed', '2026-09-20T17:00:00.000Z', '参考图能力探测未完成');
  h.add(2, 'ready', '2026-09-20T18:00:00.000Z');
  h.db.exec('UPDATE dola_videos SET has_reference_images=1 WHERE id=2');
  h.add(3, 'ready', '2026-09-20T19:00:00.000Z');
  assert.equal(seedHistoricalGenerationGuards(h.db), 0);
  assert.equal(hasGenerationGuard(h.db, 1, 15, true), false);
});
