import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeVideoDuration, requireGenerationProxy, hasLiveSession,
  isNativeVideoRequest, isNativeThirtySecondRequest, isActiveGenerationStatus, validateArchivedVideo, hasConfirmedZeroVideoQuota,
  isVerifiedNativeCapability,
} from '../server/dola/generation-policy.js';
import { DURATION_SOURCE } from '../server/dola/generation-duration.js';

test('duration defaults and explicit/native 30s normalize to one contract', () => {
  // 档位精简（2026-09-27）：默认档位从 10 秒改为 30 秒（10/20 已下线）。
  assert.equal(normalizeVideoDuration().seconds, 30);
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
  assert.throws(() => normalizeVideoDuration({ seconds: 15, forceSeconds: 30 }), /必须一致/);
  assert.throws(() => normalizeVideoDuration({ seconds: 30, forceSeconds: 15 }), /必须一致/);
  // 已下线档位单独一类错误：先报 DURATION_RETIRED，不与"必须一致"混为一谈
  assert.throws(() => normalizeVideoDuration({ seconds: 10 }), /档位已下线/);
  assert.throws(() => normalizeVideoDuration({ seconds: 20 }), /档位已下线/);
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

test('native 30s guard accepts the same model with an explicit 30s duration', async () => {
  const native = body('seedance_v2.5', 30);
  const { isNativeVideoRequest } = await import('../server/dola/generation-policy.js');
  assert.equal(isNativeVideoRequest(native, 30), true);
  assert.equal(isNativeVideoRequest(body('seedance_v2.5', 15), 30), false);
  assert.equal(isNativeVideoRequest(body('other-model', 30), 30), false);
  // 档位精简：已下线的 10/20 不再被认作合法视频请求
  assert.equal(isNativeVideoRequest(body('seedance_v2.5', 10), 10), false);
  assert.equal(isNativeVideoRequest(body('seedance_v2.5', 20), 20), false);
});

test('wire guard cannot use prompt or arbitrary metadata as proof of a video request', () => {
  const video = JSON.parse(body('seedance_v2.5', 30));
  for (const input of [{ prompt: video }, { content: video }, { metadata: video },
    { messages: [{ content: video }] }, { unrelated_ability: video }]) {
    assert.equal(isNativeVideoRequest(JSON.stringify(input), 30), false);
  }
  assert.equal(isNativeVideoRequest(JSON.stringify({ ...video, prompt: { chat_ability: { ability_type: 999 } } }), 30), true);
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

test('preflight requires carrier evidence for 30s, native for 15s', () => {
  // 15s: native evidence (uiSeconds=seconds, no rewrite)。10s 已下线，不再有"10 秒原生"这一档。
  for (const seconds of [15]) {
    const good = { ok: true, state: 'available', seconds, uiSeconds: seconds, native: true,
      rewriteCarrier: false, source: DURATION_SOURCE.NATIVE_SINGLE,
      model: seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5' };
    assert.equal(isVerifiedNativeCapability(good, seconds), true);
    assert.equal(isVerifiedNativeCapability({ ...good, uiSeconds: 10, native: false, rewriteCarrier: true }, seconds), false);
    assert.equal(isVerifiedNativeCapability({ ...good, model: 'seedance_v2.0' }, seconds), seconds === 15);
    assert.equal(isVerifiedNativeCapability({ ...good, state: 'adapter_only' }, seconds), false);
    assert.equal(isVerifiedNativeCapability({ ...good, seconds: seconds + 1 }, seconds), false);
  }
  // 30s: carrier evidence (30→15s 历史口径, rewriteCarrier=true)
  for (const [seconds, carrier] of [[30, 15]]) {
    const good = { ok: true, state: 'available', seconds, uiSeconds: carrier, native: false,
      rewriteCarrier: true, model: 'seedance_v2.5' };
    assert.equal(isVerifiedNativeCapability(good, seconds), true);
    // Wrong carrier is rejected
    const wrongCarrier = carrier === 10 ? 15 : 10;
    assert.equal(isVerifiedNativeCapability({ ...good, uiSeconds: wrongCarrier }, seconds), false);
    // A native claim without the explicit source is rejected, even when the
    // UI fields happen to match the target. The future native-30s path remains
    // available when the duration probe supplies native_single evidence.
    const native30 = { ...good, uiSeconds: seconds, native: true, rewriteCarrier: false,
      source: DURATION_SOURCE.NATIVE_SINGLE };
    assert.equal(isVerifiedNativeCapability(native30, seconds), true);
    assert.equal(isVerifiedNativeCapability({ ...native30, source: undefined }, seconds), false);
    assert.equal(isVerifiedNativeCapability({ ...good, state: 'adapter_only' }, seconds), false);
    assert.equal(isVerifiedNativeCapability({ ...good, seconds: seconds + 1 }, seconds), false);
  }
  // 已下线档位：即使证据形态齐全也不能被认作可用能力
  assert.equal(isVerifiedNativeCapability({ ok: true, state: 'available', seconds: 10, uiSeconds: 10, native: true, rewriteCarrier: false, model: 'seedance_v2.5' }, 10), false);
  assert.equal(isVerifiedNativeCapability({ ok: true, state: 'available', seconds: 20, uiSeconds: 10, native: false, rewriteCarrier: true, model: 'seedance_v2.5' }, 20), false);
});

test('30s carrier rewrite stays behind its own opt-in', () => {
  // 30s 用页面真实存在的 10s 档做载体（实测服务端只下发 5s/10s，没有 15s）
  const tenCarrier = { ok: true, state: 'available', seconds: 30, uiSeconds: 10, native: false,
    rewriteCarrier: true, model: 'seedance_v2.5' };
  // 默认 = 现行为：只认历史口径的 15s 载体，10s 载体不算证据
  assert.equal(isVerifiedNativeCapability(tenCarrier, 30), false);
  // 显式放行后才接受任意"真实存在的更短载体"
  assert.equal(isVerifiedNativeCapability(tenCarrier, 30, { allowCarrierRewrite: true }), true);
  assert.equal(isVerifiedNativeCapability({ ...tenCarrier, uiSeconds: 15 }, 30, { allowCarrierRewrite: true }), true);
  // 证据必须齐全：没有改写标记、或声明成了原生 30s，都不算
  assert.equal(isVerifiedNativeCapability({ ...tenCarrier, rewriteCarrier: false }, 30, { allowCarrierRewrite: true }), false);
  assert.equal(isVerifiedNativeCapability({ ...tenCarrier, native: true }, 30, { allowCarrierRewrite: true }), false);
  // 载体必须是真实档位且严格短于目标 —— 不能拿 30/40 冒充载体，也不能是脏值
  for (const uiSeconds of [0, -1, 30, 40, 10.5, '10', null, undefined, NaN]) {
    assert.equal(
      isVerifiedNativeCapability({ ...tenCarrier, uiSeconds }, 30, { allowCarrierRewrite: true }),
      false, String(uiSeconds),
    );
  }
  // 档位精简：20 秒已下线，这个开关现在只服务于 30 秒；
  // 已下线档位即使打开开关也不得被认作可用能力（否则会有号被派去跑已下线的档）。
  const twenty = { ok: true, state: 'available', seconds: 20, uiSeconds: 10, native: false,
    rewriteCarrier: true, model: 'seedance_v2.5' };
  assert.equal(isVerifiedNativeCapability(twenty, 20, { allowCarrierRewrite: true }), false);
  const ten = { ok: true, state: 'available', seconds: 10, uiSeconds: 10, native: true,
    rewriteCarrier: false, model: 'seedance_v2.5' };
  assert.equal(isVerifiedNativeCapability(ten, 10, { allowCarrierRewrite: true }), false);
});

test('upstream concat evidence is admitted only with an explicit opt-in', () => {
  const concat = { ok: true, state: 'available', seconds: 30, uiSeconds: 30, native: false,
    rewriteCarrier: false, source: 'upstream_concat', concat: true, model: 'seedance_v2.5' };
  // 默认不放行：合成档位改变的是"什么算 30 秒任务"这个口径，必须显式拍板
  assert.equal(isVerifiedNativeCapability(concat, 30), false);
  assert.equal(isVerifiedNativeCapability(concat, 30, { allowUpstreamConcat: true }), true);
  // 证据必须齐全，少任何一项都不算
  assert.equal(isVerifiedNativeCapability({ ...concat, concat: false }, 30, { allowUpstreamConcat: true }), false);
  assert.equal(isVerifiedNativeCapability({ ...concat, source: undefined }, 30, { allowUpstreamConcat: true }), false);
  assert.equal(isVerifiedNativeCapability({ ...concat, rewriteCarrier: true }, 30, { allowUpstreamConcat: true }), false);
  assert.equal(isVerifiedNativeCapability({ ...concat, uiSeconds: 15 }, 30, { allowUpstreamConcat: true }), false);
  assert.equal(isVerifiedNativeCapability({ ...concat, model: 'seedance_v2.0' }, 30, { allowUpstreamConcat: true }), false);
  assert.equal(isVerifiedNativeCapability({ ...concat, state: 'adapter_only' }, 30, { allowUpstreamConcat: true }), false);
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
  assert.equal(validateArchivedVideo(archive, 29.2, 30), null);
  assert.equal(validateArchivedVideo(archive, 15, 15), null);
});

test('terminal statuses never qualify for a delayed state write', () => {
  for (const status of ['queued', 'submitting', 'generating', 'resolving']) assert.equal(isActiveGenerationStatus(status), true);
  for (const status of ['cancelled', 'ready', 'failed', undefined]) assert.equal(isActiveGenerationStatus(status), false);
});
