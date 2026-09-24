import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONCAT_DURATION_LABEL,
  isNativeSingleShotDurationText,
  selectNativeVideoDuration,
  uiCarrierSeconds,
} from '../server/dola/generation-duration.js';

function fixture({ controlCount = 1, controlText = '10s', optionCount = 1,
  controlEnabled = true, optionEnabled = true, selectedOptionText = '10s',
  dataDisabled = null, waitFails = '' } = {}) {
  const calls = [];
  let selectedText = controlText;
  const control = {
    filter() { return this; },
    count: async () => controlCount,
    isEnabled: async () => controlEnabled,
    getAttribute: async name => name === 'data-disabled' ? dataDisabled : null,
    innerText: async () => selectedText,
    click: async () => { calls.push('open'); },
  };
  const option = {
    filter() { return this; },
    count: async () => optionCount,
    isEnabled: async () => optionEnabled,
    getAttribute: async name => name === 'data-disabled' ? dataDisabled : null,
    click: async () => { calls.push('select'); selectedText = selectedOptionText; },
  };
  return {
    page: {
      locator(selector) {
        return /role="option"|role="menuitem"|dropdown-menu-item/.test(selector)
          ? option : control;
      },
      waitForFunction: async (_fn, arg) => {
        const stage = typeof arg === 'string' ? 'wait-control' : arg.expected ? 'verify' : 'wait-option';
        calls.push(stage);
        if (stage === waitFails) throw Error('synthetic timeout');
      },
    },
    calls,
  };
}

test('uiCarrierSeconds maps 20/30 to 10 and leaves 10/15 alone', () => {
  assert.equal(uiCarrierSeconds(30), 10);
  assert.equal(uiCarrierSeconds(20), 10);
  assert.equal(uiCarrierSeconds(10), 10);
  assert.equal(uiCarrierSeconds(15), 15);
});

test('already-selected native 30s is preserved, never changed to a 10s carrier', async () => {
  const h = fixture({ controlText: '30s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), {
    seconds: 30, uiSeconds: 30, native: true, rewriteCarrier: false,
  });
  assert.deepEqual(h.calls, ['wait-control']);
});

test('selects the actual 30s option without a shorter carrier', async () => {
  const h = fixture({ controlText: '5s', selectedOptionText: '30s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), {
    seconds: 30, uiSeconds: 30, native: true, rewriteCarrier: false,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

test('already-selected native 20s is recognized without opening or shortening', async () => {
  const h = fixture({ controlText: '20s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 20), {
    seconds: 20, uiSeconds: 20, native: true, rewriteCarrier: false,
  });
  assert.deepEqual(h.calls, ['wait-control']);
});

test('fails closed when the page has no unique duration control or target option', async () => {
  await assert.rejects(
    selectNativeVideoDuration(fixture({ controlCount: 0 }).page, 30),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN',
  );
  const h = fixture({ controlText: '5s', optionCount: 0 });
  await assert.rejects(selectNativeVideoDuration(h.page, 30), error => error.code === 'NATIVE_CAPABILITY_UNKNOWN');
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option']);
});

test('does not accept a disabled duration control', async () => {
  await assert.rejects(
    selectNativeVideoDuration(fixture({ controlEnabled: false }).page, 30),
    /未确认原生 30 秒/,
  );
});

test('selects an existing native 15s expert option without rewrite carrier', async () => {
  const h = fixture({ controlText: '10s', selectedOptionText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 15), {
    seconds: 15, uiSeconds: 15, native: true, rewriteCarrier: false,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

test('native 10s already selected does not open the menu', async () => {
  const h = fixture({ controlText: '10s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 10), {
    seconds: 10, uiSeconds: 10, native: true, rewriteCarrier: false,
  });
  assert.deepEqual(h.calls, ['wait-control']);
});

test('single-shot text helper accepts 30秒 and rejects 15秒×2', () => {
  assert.equal(isNativeSingleShotDurationText('30秒', 30), true);
  assert.equal(isNativeSingleShotDurationText('30s', 30), true);
  assert.equal(isNativeSingleShotDurationText('15秒', 15), true);
  assert.equal(isNativeSingleShotDurationText('15秒×2', 15), false);
  assert.equal(isNativeSingleShotDurationText('15秒×2', 30), false);
  assert.equal(isNativeSingleShotDurationText('15秒 x2', 30), false);
  assert.equal(isNativeSingleShotDurationText('30秒拼接', 30), false);
  assert.ok(CONCAT_DURATION_LABEL.test('15秒×2'));
});

test('selects a real 30s option instead of accepting an already-selected 15秒×2', async () => {
  const h = fixture({ controlText: '15秒×2', selectedOptionText: '30s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), {
    seconds: 30, uiSeconds: 30, native: true, rewriteCarrier: false,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

for (const seconds of [20, 30]) {
  test(`${seconds}s absent from a 5/10s menu stays unknown and never selects a carrier`, async () => {
    const h = fixture({ controlText: '10s', optionCount: 0, waitFails: 'wait-option' });
    await assert.rejects(selectNativeVideoDuration(h.page, seconds), error =>
      error.code === 'NATIVE_CAPABILITY_UNKNOWN' && error.reason === 'DURATION_OPTION_NOT_CONFIRMED'
      && error.message.includes(`${seconds} 秒`));
    assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option']);
  });

  test(`${seconds}s native option is selected and verified at its actual duration`, async () => {
    const h = fixture({ controlText: '10s', selectedOptionText: `${seconds}s` });
    assert.deepEqual(await selectNativeVideoDuration(h.page, seconds), {
      seconds, uiSeconds: seconds, native: true, rewriteCarrier: false,
    });
    assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
  });

  test(`${seconds}s disabled option is unavailable, with no carrier fallback`, async () => {
    const h = fixture({ controlText: '10s', optionEnabled: false });
    await assert.rejects(selectNativeVideoDuration(h.page, seconds), error =>
      error.code === 'NATIVE_CAPABILITY_UNAVAILABLE' && error.message.includes(`${seconds} 秒`));
    assert.ok(!h.calls.includes('select'));
  });

  test(`${seconds}s selection returning 10s fails final confirmation`, async () => {
    const h = fixture({ controlText: '10s', selectedOptionText: '10s' });
    await assert.rejects(selectNativeVideoDuration(h.page, seconds), error =>
      error.code === 'NATIVE_CAPABILITY_UNKNOWN' && error.reason === 'DURATION_SELECTION_NOT_CONFIRMED');
  });
}

test('data-disabled=false is enabled, empty or true is unavailable', async () => {
  const h = fixture({ controlText: '5s', dataDisabled: 'false' });
  await selectNativeVideoDuration(h.page, 10);
  assert.ok(h.calls.includes('select'));
  for (const dataDisabled of ['', 'true']) {
    await assert.rejects(selectNativeVideoDuration(fixture({ dataDisabled }).page, 10),
      error => error.code === 'NATIVE_CAPABILITY_UNAVAILABLE');
  }
});

for (const waitFails of ['wait-control', 'wait-option', 'verify']) {
  test(`duration loading/confirmation timeout stays unknown: ${waitFails}`, async () => {
    const h = fixture({ controlText: '5s', waitFails });
    await assert.rejects(selectNativeVideoDuration(h.page, 10), error => error.code === 'NATIVE_CAPABILITY_UNKNOWN' && Boolean(error.reason));
  });
}
