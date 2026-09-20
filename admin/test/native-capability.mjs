import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nativeCapabilityState,
  prepareNativeVideoComposer,
  prepareNativeThirtySecondComposer,
  prepareReferenceImageComposer,
  referenceImageCapabilityState,
} from '../server/dola/native-capability.js';

function fixture({ model = 'Seedance 2.5', duration = '30s', durationOptions = 1, videoButtons = 1, imageInputs = [] } = {}) {
  const calls = [];
  const modelControl = {
    filter() { return this; }, count: async () => 1,
    isEnabled: async () => true, getAttribute: async () => null,
    innerText: async () => model, click: async () => { calls.push('model-open'); },
  };
  const durationControl = {
    filter() { return this; }, count: async () => 1,
    isEnabled: async () => true, getAttribute: async () => null,
    innerText: async () => duration, click: async () => { calls.push('duration-open'); },
  };
  const option = {
    filter() { return this; }, count: async () => durationOptions,
    isEnabled: async () => true, getAttribute: async () => null,
    innerText: async () => '30s', click: async () => { calls.push('duration-select'); },
  };
  return {
    page: {
      waitForSelector: async () => {},
      getByRole: () => ({ count: async () => videoButtons, first: () => ({ click: async () => calls.push('video-button') }) }),
      waitForTimeout: async () => {},
      evaluate: async () => ({ fileInputs: imageInputs.length, imageInputs, labels: [] }),
      locator: selector => {
        if (/video-model|video-duration|data-testid\*="duration"|时长|Duration/.test(selector)) {
          return /video-model/.test(selector) ? modelControl : durationControl;
        }
        return option;
      },
      waitForFunction: async () => {},
    },
    calls,
  };
}

test('native probe selects existing controls without any prompt or send action', async () => {
  const h = fixture();
  assert.deepEqual(await prepareNativeThirtySecondComposer(h.page, { clickDelayMs: 0 }), {
    model: 'seedance_v2.5', seconds: 30, native: true,
  });
  assert.deepEqual(h.calls, ['video-button', 'video-button']);
});

test('native probe reports unavailable when the current page has no 30s option', async () => {
  const h = fixture({ duration: '10s', durationOptions: 0 });
  await assert.rejects(
    prepareNativeThirtySecondComposer(h.page, { clickDelayMs: 0 }),
    error => error.code === 'NATIVE_CAPABILITY_UNAVAILABLE',
  );
  assert.equal(nativeCapabilityState({ code: 'NATIVE_CAPABILITY_UNAVAILABLE' }), 'unavailable');
});

test('native composer can select an existing 20s option without submitting', async () => {
  const h = fixture({ duration: '20s' });
  assert.deepEqual(await prepareNativeVideoComposer(h.page, { seconds: 20, clickDelayMs: 0 }), {
    model: 'seedance_v2.5', seconds: 20, native: true,
  });
  assert.deepEqual(h.calls, ['video-button', 'video-button']);
});

test('expert composer selects native 15s with Seedance 2.0 without submitting', async () => {
  const h = fixture({ model: 'Seedance 2.0 Fast', duration: '15s' });
  assert.deepEqual(await prepareNativeVideoComposer(h.page, { seconds: 15, model: 'seedance_v2.0', clickDelayMs: 0 }), {
    model: 'seedance_v2.0', seconds: 15, native: true,
  });
  assert.deepEqual(h.calls, ['video-button', 'video-button']);
});

test('unknown probe errors remain unknown and cannot mark capability available', () => {
  assert.equal(nativeCapabilityState(new Error('network')), 'unknown');
});

test('missing video entry is unknown rather than evidence of unsupported capability', async () => {
  await assert.rejects(
    prepareNativeThirtySecondComposer(fixture({ videoButtons: 0 }).page, { clickDelayMs: 0 }),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN',
  );
});

test('reference-image probe only accepts an explicit image file input', async () => {
  const h = fixture({ imageInputs: [{ accept: 'image/png,image/jpeg', multiple: true, name: 'images[]', id: 'images' }] });
  const result = await prepareReferenceImageComposer(h.page, { clickDelayMs: 0 });
  assert.equal(result.referenceImages, true);
  assert.equal(result.imageInputs[0].multiple, true);
  assert.deepEqual(h.calls, ['video-button', 'video-button']);
});

test('reference-image probe stays unknown when the page exposes no explicit image input', async () => {
  await assert.rejects(
    prepareReferenceImageComposer(fixture({ imageInputs: [] }).page, { clickDelayMs: 0 }),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN',
  );
  assert.equal(referenceImageCapabilityState(new Error('network')), 'unknown');
});
