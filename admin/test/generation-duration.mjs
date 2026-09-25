import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONCAT_DURATION_LABEL,
  DURATION_SOURCE,
  isNativeSingleShotDurationText,
  isUpstreamConcatDurationText,
  listNativeVideoDurations,
  selectNativeVideoDuration,
  uiCarrierSeconds,
} from '../server/dola/generation-duration.js';

/** 载体改写结果固定带上来源标记；各用例只关心差异部分。 */
const CARRIER = { source: DURATION_SOURCE.CARRIER_REWRITE, concat: false };
const NATIVE = { source: DURATION_SOURCE.NATIVE_SINGLE, concat: false };
const CONCAT = { source: DURATION_SOURCE.UPSTREAM_CONCAT, concat: true };

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

/**
 * 上游合成路径专用桩。
 *
 * 与上面的 fixture 关键差异：**单次档位等待一定失败**（页面只给合成档位），
 * 而合成档位等待由 concatOffered 控制；菜单容器用 evaluate 返回，
 * 菜单里实际提供的档位由 offered 注入（对应 listNativeVideoDurations）。
 */
function concatFixture({
  controlText = '5s', selectedOptionText = '30s (15s ×2)', concatOffered = true,
  menuOpen = true, offered = [], optionCount = 1, optionEnabled = true, controlConfirmed = true,
} = {}) {
  const calls = [];
  let selectedText = controlText;
  const control = {
    filter() { return this; },
    count: async () => 1,
    isEnabled: async () => true,
    getAttribute: async () => null,
    innerText: async () => selectedText,
    click: async () => { calls.push('open'); },
  };
  const option = {
    filter() { return this; },
    count: async () => optionCount,
    isEnabled: async () => optionEnabled,
    getAttribute: async () => null,
    innerText: async () => selectedOptionText,
    click: async () => { calls.push('select'); selectedText = selectedOptionText; },
  };
  return {
    page: {
      locator: selector => (/role="option"|role="menuitem"|dropdown-menu-item/.test(selector) ? option : control),
      waitForFunction: async (_fn, arg) => {
        if (typeof arg === 'string') {
          // 控件初始等待（字符串选择器）与 listNativeVideoDurations 的读取共用这一支。
          calls.push('wait-control');
          return { jsonValue: async () => offered };
        }
        if (arg.expected) { calls.push('verify'); return; }
        if (arg.secondsSource) {
          // 同一个等待助手既用于"等合成档位出现"，也用于"选完复核控件文案"，
          // 按 selector 区分这两件事，否则复核失败这条分支根本测不到。
          const isOption = /role="option"|role="menuitem"|dropdown-menu-item/.test(arg.selector);
          calls.push(isOption ? 'wait-concat' : 'wait-control');
          if (isOption && !concatOffered) throw Error('synthetic timeout');
          if (!isOption && !controlConfirmed) throw Error('synthetic timeout');
          return;
        }
        calls.push('wait-single');
        throw Error('synthetic timeout');
      },
      evaluate: async () => menuOpen,
    },
    calls,
  };
}

test('uiCarrierSeconds maps 30 to 15, 20 to 10, and leaves 10/15 alone', () => {
  assert.equal(uiCarrierSeconds(30), 15);
  assert.equal(uiCarrierSeconds(20), 10);
  assert.equal(uiCarrierSeconds(10), 10);
  assert.equal(uiCarrierSeconds(15), 15);
});

test('already-selected 15s carrier is preserved for 30s', async () => {
  const h = fixture({ controlText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), {
    seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true, ...CARRIER,
  });
  assert.deepEqual(h.calls, ['wait-control']);
});

test('30s selects the 15s carrier option (2-credit tier)', async () => {
  const h = fixture({ controlText: '5s', selectedOptionText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), {
    seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true, ...CARRIER,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

test('already-selected 10s carrier is preserved for 20s', async () => {
  const h = fixture({ controlText: '10s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 20), {
    seconds: 20, uiSeconds: 10, native: false, rewriteCarrier: true, ...CARRIER,
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
    /未确认原生 15 秒/,
  );
});

test('selects an existing native 15s expert option without rewrite carrier', async () => {
  const h = fixture({ controlText: '10s', selectedOptionText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 15), {
    seconds: 15, uiSeconds: 15, native: true, rewriteCarrier: false, ...NATIVE,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

test('native 10s already selected does not open the menu', async () => {
  const h = fixture({ controlText: '10s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 10), {
    seconds: 10, uiSeconds: 10, native: true, rewriteCarrier: false, ...NATIVE,
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

test('upstream concat text requires the target seconds AND a concat marker', () => {
  for (const text of ['30s (15s ×2)', '30秒（15秒×2）', '30s 15s×2', '30 秒 拼接', '30s (2×15s)']) {
    assert.equal(isUpstreamConcatDurationText(text, 30), true, text);
  }
  // 声明 15 秒的档位不能当成 30 秒合成档位
  assert.equal(isUpstreamConcatDurationText('15秒×2', 30), false);
  assert.equal(isUpstreamConcatDurationText('15s (7.5s ×2)', 30), false);
  // 没有拼接标记的单次档位也不是合成档位
  assert.equal(isUpstreamConcatDurationText('30秒', 30), false);
  assert.equal(isUpstreamConcatDurationText('', 30), false);
  assert.equal(isUpstreamConcatDurationText(null, 30), false);
});

test('30s rejects already-selected 15秒×2 and selects the 15s carrier', async () => {
  const h = fixture({ controlText: '15秒×2', selectedOptionText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), {
    seconds: 30, uiSeconds: 15, native: false, rewriteCarrier: true, ...CARRIER,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

for (const [seconds, carrier] of [[20, 10], [30, 15]]) {
  test(`${seconds}s absent from a 5/10s menu stays unknown and never selects a wrong carrier`, async () => {
    const h = fixture({ controlText: '5s', optionCount: 0, waitFails: 'wait-option' });
    await assert.rejects(selectNativeVideoDuration(h.page, seconds), error =>
      error.code === 'NATIVE_CAPABILITY_UNKNOWN' && error.reason === 'DURATION_OPTION_NOT_CONFIRMED'
      && error.message.includes(`${carrier} 秒`));
    assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option']);
  });

  test(`${seconds}s carrier option is selected and verified at ${carrier}s`, async () => {
    const h = fixture({ controlText: '5s', selectedOptionText: `${carrier}s` });
    assert.deepEqual(await selectNativeVideoDuration(h.page, seconds), {
      seconds, uiSeconds: carrier, native: false, rewriteCarrier: true, ...CARRIER,
    });
    assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
  });

  test(`${seconds}s disabled carrier option is unavailable, with no fallback`, async () => {
    const h = fixture({ controlText: '5s', optionEnabled: false });
    await assert.rejects(selectNativeVideoDuration(h.page, seconds), error =>
      error.code === 'NATIVE_CAPABILITY_UNAVAILABLE' && error.message.includes(`${carrier} 秒`));
    assert.ok(!h.calls.includes('select'));
  });

  test(`${seconds}s selection returning a wrong duration fails final confirmation`, async () => {
    const wrongText = carrier === 15 ? '10s' : '5s';
    const h = fixture({ controlText: '5s', selectedOptionText: wrongText });
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

// ---------------------------------------------------------------- 上游合成路径

test('upstream concat tier is selected only when explicitly allowed', async () => {
  const h = concatFixture();
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30, { allowUpstreamConcat: true }), {
    seconds: 30, uiSeconds: 30, native: false, rewriteCarrier: false, ...CONCAT,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-single', 'wait-control', 'wait-concat', 'select', 'wait-control']);
});

test('upstream concat tier stays unknown when the caller has not opted in', async () => {
  const h = concatFixture({ offered: ['5s', '10s'] });
  await assert.rejects(selectNativeVideoDuration(h.page, 30), error =>
    error.code === 'NATIVE_CAPABILITY_UNAVAILABLE'
    && error.message.includes('5s / 10s')
    && error.message.includes('没有 15 秒档位'));
  assert.ok(!h.calls.includes('select'), '未放行时绝不点选合成档位');
});

test('an already-selected upstream concat tier is recognized without opening the menu', async () => {
  const h = concatFixture({ controlText: '30s (15s ×2)' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30, { allowUpstreamConcat: true }), {
    seconds: 30, uiSeconds: 30, native: false, rewriteCarrier: false, ...CONCAT,
  });
  assert.deepEqual(h.calls, ['wait-control']);
});

test('an already-selected concat tier is not silently accepted when not opted in', async () => {
  const h = concatFixture({ controlText: '30s (15s ×2)', concatOffered: false });
  await assert.rejects(selectNativeVideoDuration(h.page, 30),
    error => error.code === 'NATIVE_CAPABILITY_UNKNOWN');
});

test('a concat tier that is not offered falls back to a diagnosable unknown', async () => {
  const h = concatFixture({ concatOffered: false, offered: ['5s', '10s'] });
  await assert.rejects(selectNativeVideoDuration(h.page, 30, { allowUpstreamConcat: true }), error =>
    error.code === 'NATIVE_CAPABILITY_UNAVAILABLE' && error.message.includes('5s / 10s'));
});

test('a disabled concat tier is unavailable rather than silently skipped', async () => {
  const h = concatFixture({ optionEnabled: false });
  await assert.rejects(selectNativeVideoDuration(h.page, 30, { allowUpstreamConcat: true }), error =>
    error.code === 'NATIVE_CAPABILITY_UNAVAILABLE' && error.message.includes('上游合成档位不可用'));
});

test('a concat tier that cannot be confirmed on the control is unknown, never assumed', async () => {
  const h = concatFixture({ selectedOptionText: '10s', controlConfirmed: false });
  await assert.rejects(selectNativeVideoDuration(h.page, 30, { allowUpstreamConcat: true }), error =>
    error.code === 'NATIVE_CAPABILITY_UNKNOWN' && error.reason === 'UPSTREAM_CONCAT_NOT_CONFIRMED');
});

test('offered duration tiers are read back only from a rendered menu', async () => {
  assert.deepEqual(await listNativeVideoDurations(concatFixture({ offered: ['5s', '10s'] }).page), ['5s', '10s']);
  // 菜单没渲染 / 桩没有该方法时必须返回空数组，不能编造档位
  assert.deepEqual(await listNativeVideoDurations({}), []);
  assert.deepEqual(await listNativeVideoDurations(undefined), []);
});
