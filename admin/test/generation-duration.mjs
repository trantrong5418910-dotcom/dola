import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONCAT_DURATION_LABEL,
  DEFAULT_DURATION_CARRIER_MAP,
  DURATION_SOURCE,
  NATIVE_DURATION_CONTROL_SELECTOR,
  REWRITE_DURATION_CARRIER_MAP,
  isNativeSingleShotDurationText,
  isUpstreamConcatDurationText,
  listNativeVideoDurations,
  parseDurationCarrierMap,
  resolveDurationCarrierMap,
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

test('uiCarrierSeconds maps 30 to 15 and leaves 15 alone', () => {
  // 档位精简：目标档位只剩 30（→15 载体）与 15（原生，不改写）。
  assert.equal(uiCarrierSeconds(30), 15);
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

test('already-selected 10s carrier is preserved for 30s when the map says so', async () => {
  const h = fixture({ controlText: '10s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30, { carriers: { 30: 10 } }), {
    seconds: 30, uiSeconds: 10, native: false, rewriteCarrier: true, ...CARRIER,
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

test('native 15s already selected does not open the menu', async () => {
  const h = fixture({ controlText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 15), {
    seconds: 15, uiSeconds: 15, native: true, rewriteCarrier: false, ...NATIVE,
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

for (const [seconds, carrier] of [[30, 15]]) {
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
  // 目标 15 秒是**原生档**，桩必须能把控件选成 15s，否则复核阶段必然失败
  // （这不是产品行为变化，是夹具默认选中项是 10s，跟不上新的目标档位）。
  const h = fixture({ controlText: '5s', selectedOptionText: '15s', dataDisabled: 'false' });
  await selectNativeVideoDuration(h.page, 15);
  assert.ok(h.calls.includes('select'));
  for (const dataDisabled of ['', 'true']) {
    await assert.rejects(selectNativeVideoDuration(fixture({ selectedOptionText: '15s', dataDisabled }).page, 15),
      error => error.code === 'NATIVE_CAPABILITY_UNAVAILABLE');
  }
});

for (const waitFails of ['wait-control', 'wait-option', 'verify']) {
  test(`duration loading/confirmation timeout stays unknown: ${waitFails}`, async () => {
    const h = fixture({ controlText: '5s', waitFails });
    await assert.rejects(selectNativeVideoDuration(h.page, 15), error => error.code === 'NATIVE_CAPABILITY_UNKNOWN' && Boolean(error.reason));
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
  // 文案必须把「目标档位缺失」和「载体档位也缺失」两件事都写出来 ——
  // 后者正是 2026-09-25 线上 30 秒死锁的形态（配的是 15s 载体，页面只有 5s/10s），
  // 只说"没有 15 秒档位"会让人以为是账号权限问题而往错的方向查。
  await assert.rejects(selectNativeVideoDuration(h.page, 30), error =>
    error.code === 'NATIVE_CAPABILITY_UNAVAILABLE'
    && error.message.includes('5s / 10s')
    && error.message.includes('没有 30 秒档位')
    && error.message.includes('也没有 15 秒载体档位'));
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

// ------------------------------------------------- 可配置载体映射（30 秒改写通道）

test('carrier map is parsed defensively and never throws', () => {
  assert.deepEqual(parseDurationCarrierMap('{"30":10}'), { 30: 10 });
  assert.deepEqual(parseDurationCarrierMap({ 30: 10 }), { 30: 10 });
  // 目标 20 已下线 → 整项丢弃（10/20 只能当载体，不能当目标）
  assert.deepEqual(parseDurationCarrierMap({ 20: 10, 30: 10 }), { 30: 10 });
  // 载体不短于目标 = 不是改写载体，而是"要求原生档位"，一律丢弃
  assert.deepEqual(parseDurationCarrierMap('{"30":30}'), {});
  assert.deepEqual(parseDurationCarrierMap('{"30":40}'), {});
  // 非法档位 / 非法类型 / 烂 JSON 全部静默丢弃，绝不抛错拖垮生成链路
  assert.deepEqual(parseDurationCarrierMap('{"5":5,"30":10}'), { 30: 10 });
  // ⚠️ 载体写成字符串 `"10"` 是**接受**的：这是一份人手写的配置，
  //    多一对引号是常见笔误，且数值范围仍然被校验，放行等于尊重操作者的本意。
  //    （对比 `isVerifiedNativeCapability` 拒绝字符串载体 —— 那里的值是机器产出的证据，
  //      出现字符串只可能意味着被篡改，两边严格度不同是有意的。）
  assert.deepEqual(parseDurationCarrierMap('{"30":"10"}'), { 30: 10 });
  // 非整数一律丢弃：载体只能是真实档位，10.5 不是档位
  assert.deepEqual(parseDurationCarrierMap('{"30":10.5}'), {});
  for (const bad of ['', null, undefined, 'not json', '[10]', '10', 42, '{"30":']) {
    assert.deepEqual(parseDurationCarrierMap(bad), {}, String(bad));
  }
});

test('resolveDurationCarrierMap: explicit config wins, otherwise switch decides', () => {
  // 开关关 = 历史口径（30→15），这正是"上线不改行为"的证据
  assert.deepEqual(resolveDurationCarrierMap({ allowRewrite: false }), DEFAULT_DURATION_CARRIER_MAP);
  // 开关开 = 页面真实存在的档（30→10）
  assert.deepEqual(resolveDurationCarrierMap({ allowRewrite: true }), REWRITE_DURATION_CARRIER_MAP);
  // 显式配置永远优先于开关默认
  assert.deepEqual(
    resolveDurationCarrierMap({ configured: '{"30":15}', allowRewrite: true }),
    { 30: 15 },
  );
});

test('uiCarrierSeconds honours an explicit map and keeps the legacy default', () => {
  // 不传 = 历史口径，绝不能被这次改动悄悄改掉
  assert.equal(uiCarrierSeconds(30), 15);
  assert.equal(uiCarrierSeconds(15), 15);
  // 传映射 = 按映射取载体（10s 是实测页面真实存在的档）
  assert.equal(uiCarrierSeconds(30, { 30: 10 }), 10);
  assert.equal(uiCarrierSeconds(30, REWRITE_DURATION_CARRIER_MAP), 10);
  // 映射里没有的秒数原样返回（不编造载体）
  assert.equal(uiCarrierSeconds(10, { 30: 10 }), 10);
  assert.equal(uiCarrierSeconds(15, { 30: 10 }), 15);
});

test('30s selects the 10s carrier when the map says so', async () => {
  const h = fixture({ controlText: '5s', selectedOptionText: '10s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30, { carriers: { 30: 10 } }), {
    seconds: 30, uiSeconds: 10, native: false, rewriteCarrier: true, ...CARRIER,
  });
  assert.deepEqual(h.calls, ['wait-control', 'open', 'wait-option', 'select', 'verify']);
});

/**
 * ★ 2026-09-27 前端改版回归：时长控件的旧属性全部消失。
 *
 * 实测（生产账号 #429，持久化 profile，dump 自真实 DOM）：
 *   旧 5 条候选命中数 0/0/0/0/0；
 *   现役控件是 BUTTON[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]，
 *   文案「自动 · 10s」，点击后弹出同时含「比例」与「时长」的菜单。
 *
 * 这个测试的作用是**双向钉死**：
 *   · 新属性不能被谁顺手删掉（删了探测与生成会一起卡到超时）；
 *   · 旧属性也不能被删掉（上游万一改回去，旧路径要照常工作）。
 */
test('duration control selector keeps both the legacy attributes and the 2026-09-27 params-panel trigger', () => {
  const selector = String(NATIVE_DURATION_CONTROL_SELECTOR);
  for (const legacy of [
    '[data-input-engine-actionbar-control-key="video-duration"]',
    '[data-input-engine-actionbar-control-key="duration"]',
    '[data-testid*="duration"]',
    '[aria-label*="时长"]',
    '[aria-label*="Duration"]',
  ]) {
    assert.ok(selector.includes(legacy), `旧属性不能删（上游可能改回去）：${legacy}`);
  }
  assert.ok(
    selector.includes('[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]'),
    '现役参数面板触发器必须在选择器里，否则时长控件永远找不到',
  );
});

test('params-panel trigger text 自动 · 10s is recognised as the 10s carrier without opening the menu', async () => {
  // 改版后控件的 innerText 形如「自动 · 10s」；生产配置是 30s 走 10s 载体，
  // 所以必须**不点菜单**就认出来 —— 这也是探测能不能在预算内跑完的关键。
  assert.equal(isNativeSingleShotDurationText('自动 · 10s', 10), true);
  assert.equal(isNativeSingleShotDurationText('自动 · 10s', 15), false, '不能把 10s 误认成 15s');
  const h = fixture({ controlText: '自动 · 10s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30, { carriers: { 30: 10 } }), {
    seconds: 30, uiSeconds: 10, native: false, rewriteCarrier: true, ...CARRIER,
  });
  assert.deepEqual(h.calls, ['wait-control'], '已选中目标载体时不该再点开菜单（不点 = 不冒险改错档位）');
});
