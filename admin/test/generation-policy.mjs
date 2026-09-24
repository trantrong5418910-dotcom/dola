import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeVideoDuration, requireGenerationProxy, hasLiveSession,
  isNativeVideoRequest, isNativeThirtySecondRequest, isActiveGenerationStatus, validateArchivedVideo, hasConfirmedZeroVideoQuota,
  isVerifiedNativeCapability,
} from '../server/dola/generation-policy.js';

test('duration defaults and explicit/native 30s normalize to one contract', () => {
  assert.equal(normalizeVideoDuration().seconds, 10);
  for (const input of [{ seconds: 20 }, { forceSeconds: 20 }, { seconds: '20', forceSeconds: 20 }]) {
    assert.deepEqual(normalizeVideoDuration(input), {
      seconds: 20, forceSeconds: 20, requireSessionRecheck: true, targetModel: 'seedance_v2.5',
    });
  }
  for (const input of [{ seconds: 30 }, { forceSeconds: 30 }, { seconds: '30', forceSeconds: 30 }]) {
    assert.deepEqual(normalizeVideoDuration(input), {
      seconds: 30, forceSeconds: 30, requireSessionRecheck: true, targetModel: 'seedance_v2.5',
    });
  }
  for (const input of [{ seconds: 15 }, { forceSeconds: 15 }, { seconds: '15', forceSeconds: 15 }]) {
    assert.deepEqual(normalizeVideoDuration(input), {
      seconds: 15, forceSeconds: 15, requireSessionRecheck: true, targetModel: 'seedance_v2.0',
    });
  }
});

for (const value of [0, -1, 5, 31, 30.5, 40, NaN, Infinity, '', false, true, [], {}]) {
  test(`reject unsupported duration ${JSON.stringify(value)} before any I/O`, () => {
    assert.throws(() => normalizeVideoDuration({ seconds: value }), error => error.status === 400);
  });
}
test('seconds and forceSeconds mismatch is rejected in both directions', () => {
  assert.throws(() => normalizeVideoDuration({ seconds: 10, forceSeconds: 30 }), /必须一致/);
  assert.throws(() => normalizeVideoDuration({ seconds: 30, forceSeconds: 10 }), /必须一致/);
});

test('explicit proxy schemes and authenticated IPWeb are accepted without connecting', () => {
  for (const proxy of ['http://proxy.example.invalid:8080', 'https://proxy.example.invalid',
    'socks5://fixture:fixture@gate1.ipweb.cc:7778', 'socks5h://proxy.example.invalid:1080']) {
    assert.equal(requireGenerationProxy(proxy), proxy);
  }
});
test('absent, malformed, unsupported or incomplete IPWeb proxies fail closed with fixed text', () => {
  for (const proxy of [null, '', 'direct', 'ftp://proxy.example.invalid', 'http://p.invalid/path',
    'http://p.invalid?x=1', 'http://p.invalid#x', 'http://%0a:p@p.invalid',
    'socks5://gate1.ipweb.cc:7778', 'socks5://fixture:fixture@gate1.ipweb.cc:1080']) {
    assert.throws(() => requireGenerationProxy(proxy), error => error.status === 409 && !error.message.includes('fixture'));
  }
});

const profile = () => ({ ok: true, status: 200, code: 0, entityId: 'synthetic-user' });
test('live login requires successful response and identity, never a paid tier', () => {
  for (const membershipLevel of ['free', 'pro', '', 'unknown']) {
    assert.equal(hasLiveSession({ ...profile(), membershipLevel, hasActiveSubscription: false }), true);
  }
  for (const override of [{ ok: false }, { status: 0 }, { status: 403 }, { code: 123 }, { entityId: '' }]) {
    assert.equal(hasLiveSession({ ...profile(), ...override }), false);
  }
  assert.equal(hasLiveSession(null), false);
  assert.equal(hasLiveSession({ ...profile(), entityId: '', id: 'synthetic-fallback-id' }), true);
});

const body = (model, duration) => JSON.stringify({ chat_ability: {
  ability_type: 17, ability_param: JSON.stringify({ model, duration }),
} });

test('only fresh explicit zero quota blocks admission; never infer zero from missing or stale data', () => {
  const at = '2026-09-20T12:00:00.000Z';
  const account = { quota_remaining: 0, quota_source: 'generation_receipt', quota_at: '2026-09-20T11:00:00.000Z' };
  assert.equal(hasConfirmedZeroVideoQuota(account, at), true);
  for (const changed of [{ quota_remaining: null }, { quota_remaining: 1 }, { quota_remaining: '0' },
    { quota_at: '2026-09-19T23:00:00.000Z' }, { quota_at: '2026-09-20T13:00:00.000Z' }, { quota_source: 'unknown' }]) {
    assert.equal(hasConfirmedZeroVideoQuota({ ...account, ...changed }, at), false);
  }
  assert.equal(hasConfirmedZeroVideoQuota(null, at), false);
});
test('native 30s guard accepts only explicit matching model/duration and never changes payload', () => {
  const native = body('seedance_v2.5', 30);
  assert.equal(isNativeThirtySecondRequest(native), true);
  assert.equal(isNativeThirtySecondRequest(JSON.stringify({ payload: native })), true);
  for (const invalid of [body('seedance_v2.5', 10), body('other-model', 30), '{}', '{bad', '', null,
    JSON.stringify({ list: [JSON.parse(native), JSON.parse(body('other-model', 30))] })]) {
    assert.equal(isNativeThirtySecondRequest(invalid), false);
  }
  assert.equal(native, body('seedance_v2.5', 30));
});

test('native 20s guard accepts the same model with an explicit 20s duration', async () => {
  const native = body('seedance_v2.5', 20);
  const { isNativeVideoRequest } = await import('../server/dola/generation-policy.js');
  assert.equal(isNativeVideoRequest(native, 20), true);
  assert.equal(isNativeVideoRequest(body('seedance_v2.5', 30), 20), false);
  assert.equal(isNativeVideoRequest(body('other-model', 20), 20), false);
});

test('wire guard cannot use prompt or arbitrary metadata as proof of a video request', () => {
  const video = JSON.parse(body('seedance_v2.5', 10));
  for (const input of [{ prompt: video }, { content: video }, { metadata: video },
    { messages: [{ content: video }] }, { unrelated_ability: video }]) {
    assert.equal(isNativeVideoRequest(JSON.stringify(input), 10), false);
  }
  assert.equal(isNativeVideoRequest(JSON.stringify({ ...video, prompt: { chat_ability: { ability_type: 999 } } }), 10), true);
});

test('wire guard rejects multi-video requests, malformed abilities and excessive nesting', () => {
  const video = JSON.parse(body('seedance_v2.5', 10));
  assert.equal(isNativeVideoRequest(JSON.stringify({ list: [video, video] }), 10), false);
  assert.equal(isNativeVideoRequest(body('seedance_v2.5', [10]), 10), false);
  assert.equal(isNativeVideoRequest(JSON.stringify({ list: [video, { ability_type: 18 }] }), 10), false);
  let nested = video;
  for (let n = 0; n < 12; n++) nested = { payload: nested };
  assert.equal(isNativeVideoRequest(JSON.stringify(nested), 10), false);
});

test('native 15s expert guard accepts only Seedance 2.0', async () => {
  const { isNativeVideoRequest } = await import('../server/dola/generation-policy.js');
  assert.equal(isNativeVideoRequest(body('seedance_v2.0', 15), 15, 'seedance_v2.0'), true);
  assert.equal(isNativeVideoRequest(body('seedance_v2.5', 15), 15, 'seedance_v2.0'), false);
  assert.equal(isNativeVideoRequest(body('seedance_v2.0', 10), 15, 'seedance_v2.0'), false);
});

test('preflight requires exact native duration/model evidence, not a shorter carrier rewrite', () => {
  for (const seconds of [10, 15, 20, 30]) {
    const good = { ok: true, state: 'available', seconds, uiSeconds: seconds, native: true,
      rewriteCarrier: false, model: seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5' };
    assert.equal(isVerifiedNativeCapability(good, seconds), true);
    assert.equal(isVerifiedNativeCapability({ ...good, uiSeconds: 10, native: false, rewriteCarrier: true }, seconds), false);
    assert.equal(isVerifiedNativeCapability({ ...good, model: 'seedance_v2.0' }, seconds), seconds === 15);
    assert.equal(isVerifiedNativeCapability({ ...good, state: 'adapter_only' }, seconds), false);
    assert.equal(isVerifiedNativeCapability({ ...good, seconds: seconds + 1 }, seconds), false);
  }
  assert.equal(isVerifiedNativeCapability({ ok: true, state: 'available', seconds: 10, model: 'seedance_v2.5' }, 10), false);
});

test('archive and independently measured duration are both necessary', () => {
  const archive = { path: '/synthetic-only/not-a-real-file.mp4', bytes: 4096 };
  assert.equal(validateArchivedVideo(null, 30, 30), 'archive_failed');
  assert.equal(validateArchivedVideo({ ...archive, bytes: 0 }, 30, 30), 'archive_failed');
  for (const unknown of [null, undefined, NaN, Infinity, 0, '30']) {
    assert.equal(validateArchivedVideo(archive, unknown, 30), 'duration_unverified');
  }
  assert.equal(validateArchivedVideo(archive, 10, 30), 'duration_mismatch');
  assert.equal(validateArchivedVideo(archive, 29.97, 30), null);
  assert.equal(validateArchivedVideo(archive, 19.2, 20), null);
  assert.equal(validateArchivedVideo(archive, 10, 10), null);
});

test('terminal statuses never qualify for a delayed state write', () => {
  for (const status of ['queued', 'submitting', 'generating', 'resolving']) assert.equal(isActiveGenerationStatus(status), true);
  for (const status of ['cancelled', 'ready', 'failed', undefined]) assert.equal(isActiveGenerationStatus(status), false);
});
