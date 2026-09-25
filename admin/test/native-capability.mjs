import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { observeVideoComposerBootstrap } from '../server/dola/composer-bootstrap.js';
import { isVerifiedNativeCapability } from '../server/dola/generation-policy.js';
import {
  nativeCapabilityState,
  prepareNativeVideoComposer,
  prepareNativeThirtySecondComposer,
  prepareReferenceImageComposer,
  referenceImageCapabilityState,
} from '../server/dola/native-capability.js';

function fixture({
  model = 'Seedance 2.5',
  duration = '30s',
  selectedDuration = duration,
  durationOptions = 1,
  videoButtons = 1,
  durationVisible = true,
  imageInputs = [],
  bootstrapReady = true,
} = {}) {
  const calls = [];
  let durationCount = durationVisible ? 1 : 0;
  const modelControl = {
    filter() { return this; }, count: async () => 1,
    isEnabled: async () => true, getAttribute: async () => null,
    innerText: async () => model, click: async () => { calls.push('model-open'); },
  };
  const durationControl = {
    filter() { return this; },
    count: async () => durationCount,
    isEnabled: async () => true, getAttribute: async () => null,
    innerText: async () => duration, click: async () => { calls.push('duration-open'); },
  };
  const option = {
    filter() { return this; }, count: async () => durationOptions,
    isEnabled: async () => true, getAttribute: async () => null,
    innerText: async () => selectedDuration, click: async () => { calls.push('duration-select'); duration = selectedDuration; },
  };
  const videoButton = {
    click: async () => { calls.push('video-button'); durationCount = 1; },
    evaluate: async () => false,
  };
  const videoButtonsLoc = {
    count: async () => videoButtons,
    first: () => videoButton,
    nth: () => videoButton,
  };
  const chain = {
    count: async () => videoButtons,
    first: () => videoButton,
    nth: () => videoButton,
    getByRole: () => videoButtonsLoc,
    getByText: () => videoButtonsLoc,
    locator: () => chain,
    filter: () => chain,
  };
  const h = {
    page: {
      waitForSelector: async () => {},
      getByRole: () => videoButtonsLoc,
      getByText: () => videoButtonsLoc,
      waitForTimeout: async () => {},
      evaluate: async () => ({ fileInputs: imageInputs.length, imageInputs, labels: [] }),
      locator: selector => {
        if (/video-model/.test(selector)) return modelControl;
        if (/video-duration|actionbar-control-key="duration"|时长|Duration|data-testid\*="duration"/.test(selector)) {
          return durationControl;
        }
        if (/flow-chat-guidance|guidance-input|input-engine-action|actionbar/.test(selector)) {
          return chain;
        }
        return option;
      },
      waitForFunction: async () => {},
    },
    calls,
  };
  const events = new EventEmitter();
  for (const name of ['on', 'once', 'off']) h.page[name] = events[name].bind(events);
  h.page.mainFrame = () => h.page;
  observeVideoComposerBootstrap(h.page);
  if (bootstrapReady) events.emit('response', {
    url: () => 'https://www.dola.com/alice/slot/action_bar_v3/get_item_conf', ok: () => true,
    json: async () => ({ code: 0, data: { item_list: { synthetic: {} } } }),
  });
  return h;
}

test('native 30s probe uses the 15s carrier without prompt or send', async () => {
  const h = fixture({ duration: '15s' });
  assert.deepEqual(await prepareNativeThirtySecondComposer(h.page, { clickDelayMs: 0 }), {
    model: 'seedance_v2.5', seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true,
    source: 'carrier_rewrite', concat: false,
  });
  // Duration control already visible → skip re-clicking 视频生成
  assert.deepEqual(h.calls, []);
});

test('native 30s probe stays unknown when no exact target option is selectable', async () => {
  const h = fixture({ duration: '5s', durationOptions: 0 });
  await assert.rejects(
    prepareNativeThirtySecondComposer(h.page, { clickDelayMs: 0 }),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN',
  );
  assert.equal(nativeCapabilityState({ code: 'NATIVE_CAPABILITY_UNAVAILABLE' }), 'unavailable');
});

test('native composer 20s recognizes the 10s carrier without submitting', async () => {
  const h = fixture({ duration: '10s' });
  assert.deepEqual(await prepareNativeVideoComposer(h.page, { seconds: 20, clickDelayMs: 0 }), {
    model: 'seedance_v2.5', seconds: 20, uiSeconds: 10, native: false, rewriteCarrier: true,
    source: 'carrier_rewrite', concat: false,
  });
  assert.deepEqual(h.calls, []);
});

test('expert composer selects native 15s with Seedance 2.0 without submitting', async () => {
  const h = fixture({ model: 'Seedance 2.0 Fast', duration: '15s' });
  assert.deepEqual(await prepareNativeVideoComposer(h.page, { seconds: 15, model: 'seedance_v2.0', clickDelayMs: 0 }), {
    model: 'seedance_v2.0', seconds: 15, uiSeconds: 15, native: true, rewriteCarrier: false,
    source: 'native_single', concat: false,
  });
  assert.deepEqual(h.calls, []);
});

test('unknown probe errors remain unknown and cannot mark capability available', () => {
  assert.equal(nativeCapabilityState(new Error('network')), 'unknown');
});

test('missing video entry is unknown rather than evidence of unsupported capability', async () => {
  await assert.rejects(
    prepareNativeThirtySecondComposer(fixture({ videoButtons: 0, durationVisible: false }).page, { clickDelayMs: 0 }),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN',
  );
});

test('opens video entry when duration control is not yet visible', async () => {
  const h = fixture({ duration: '15s', durationVisible: false, videoButtons: 1 });
  assert.deepEqual(await prepareNativeThirtySecondComposer(h.page, { clickDelayMs: 0 }), {
    model: 'seedance_v2.5', seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true,
    source: 'carrier_rewrite', concat: false,
  });
  assert.equal(h.calls.filter(call => call === 'video-button').length, 1, 'never double-toggle a loading video composer');
});

test('20s composer selection produces evidence accepted by the actual admission predicate', async () => {
  const h = fixture({ duration: '5s', selectedDuration: '10s' });
  const capability = await prepareNativeVideoComposer(h.page, { seconds: 20 });
  assert.equal(isVerifiedNativeCapability({ ...capability, ok: true, state: 'available' }, 20), true);
  assert.deepEqual(h.calls, ['duration-open', 'duration-select']);
});

test('upstream concat tier is admitted only when the caller opts in', async () => {
  const h = fixture({ duration: '5s', selectedDuration: '30s (15s ×2)' });
  // 页面只给合成档位：单次档位等待一定失败，合成档位等待成功。
  h.page.waitForFunction = async (_fn, arg) => {
    if (typeof arg === 'string' || arg.expected || arg.secondsSource) return;
    throw Error('synthetic timeout');
  };
  const capability = await prepareNativeVideoComposer(h.page, { seconds: 30, allowUpstreamConcat: true });
  assert.deepEqual(capability, {
    model: 'seedance_v2.5', seconds: 30, uiSeconds: 30, native: false, rewriteCarrier: false,
    source: 'upstream_concat', concat: true,
  });
  const evidence = { ...capability, ok: true, state: 'available' };
  assert.equal(isVerifiedNativeCapability(evidence, 30, { allowUpstreamConcat: true }), true);
  assert.equal(isVerifiedNativeCapability(evidence, 30), false, '未显式放行时不得当作可用证据');
});

test('30s composer does not reuse an already-selected 10s carrier when the 15s target is absent', async () => {
  const h = fixture({ duration: '10s', durationOptions: 0 });
  await assert.rejects(prepareNativeVideoComposer(h.page, { seconds: 30 }), error =>
    error.code === 'NATIVE_CAPABILITY_UNKNOWN' && error.message.includes('15 秒'));
  assert.deepEqual(h.calls, ['duration-open']);
});

test('visible enabled video chip is never clicked before bootstrap configuration', async () => {
  const h = fixture({ durationVisible: false, bootstrapReady: false });
  await assert.rejects(prepareNativeVideoComposer(h.page, { seconds: 10, timeout: 10 }),
    e => e.code === 'NATIVE_CAPABILITY_UNKNOWN' && e.reason === 'VIDEO_BOOTSTRAP_NOT_READY');
  assert.ok(!h.calls.includes('video-button'));
});

test('slow composer hydration uses the remaining caller budget, not a separate 30-second cutoff', async () => {
  const h = fixture({ duration: '10s', durationVisible: false });
  const waits = [];
  h.page.waitForFunction = async (_fn, _arg, options) => { waits.push(options.timeout); };
  const phases = [];
  await prepareNativeVideoComposer(h.page, { seconds: 10, timeout: 100000, onPhase: phase => phases.push(phase) });
  assert.ok(waits.some(timeout => timeout > 30000), 'entry hydration must receive its remaining bounded budget');
  assert.deepEqual(phases, ['bootstrap', 'entry', 'model', 'duration', 'verified']);
  assert.equal(h.calls.filter(call => call === 'video-button').length, 1);
});

test('missing composer does not silently navigate and reset the probe budget', async () => {
  const h = fixture(); let navigations = 0;
  h.page.waitForSelector = async () => { throw new Error('not ready'); };
  h.page.goto = async () => { navigations++; };
  await assert.rejects(prepareNativeVideoComposer(h.page, { seconds: 10, timeout: 20 }),
    e => e.code === 'NATIVE_CAPABILITY_UNKNOWN' && e.reason === 'VIDEO_PAGE_NOT_READY');
  assert.equal(navigations, 0);
});

test('reference-image probe only accepts an explicit image file input', async () => {
  const h = fixture({ imageInputs: [{ accept: 'image/png,image/jpeg', multiple: true, name: 'images[]', id: 'images' }] });
  const result = await prepareReferenceImageComposer(h.page, { clickDelayMs: 0 });
  assert.equal(result.referenceImages, true);
  assert.equal(result.imageInputs[0].multiple, true);
  assert.deepEqual(h.calls, []);
});

test('reference-image probe stays unknown when the page exposes no explicit image input', async () => {
  await assert.rejects(
    prepareReferenceImageComposer(fixture({ imageInputs: [] }).page, { clickDelayMs: 0 }),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN',
  );
  assert.equal(referenceImageCapabilityState(new Error('network')), 'unknown');
});
