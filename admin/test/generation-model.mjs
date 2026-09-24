import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSeedance, selectSeedance25 } from '../server/dola/generation-model.js';

// Locator-only double. No browser, upstream service, credentials or submit action.
function fixture({ model = '模型 2.0', target = '2.5', controls = 1, options = 1, enabled = true,
  ariaDisabled = null, dataDisabled = null, selectionChanges = true, controlEnabled = true, controlDataDisabled = null,
  controlWaitFails = false, optionWaitFails = false } = {}) {
  const calls = [];
  const control = {
    filter() { return this; }, count: async () => controls, innerText: async () => model,
    isEnabled: async () => controlEnabled, getAttribute: async name => name === 'data-disabled' ? controlDataDisabled : null,
    click: async () => calls.push('open-model-menu'),
  };
  const option = {
    filter() { return this; }, count: async () => options, isEnabled: async () => enabled,
    getAttribute: async name => name === 'aria-disabled' ? ariaDisabled : dataDisabled,
    click: async () => { calls.push(`select-${target}`); if (selectionChanges) model = `模型 Seedance ${target}`; },
  };
  const page = {
    locator: selector => selector.includes('actionbar') ? control : option,
    waitForFunction: async (_fn, arg) => {
      if (typeof arg === 'string') {
        calls.push('wait-control');
        if (controlWaitFails || controls !== 1) throw new Error('synthetic control timeout');
      } else if (arg.selector.includes('role=')) {
        calls.push('wait-option');
        if (optionWaitFails || options < 1) throw new Error('synthetic option timeout');
      } else {
        calls.push('confirm-selection'); if (!selectionChanges) throw new Error('synthetic timeout');
      }
    },
  };
  return { page, calls };
}

test('already-selected 2.5 does not click or submit anything', async () => {
  const h = fixture({ model: '模型 2.5' }); await selectSeedance25(h.page);
  assert.deepEqual(h.calls, ['wait-control']);
});
test('selects an existing enabled 2.5 option and confirms selected control', async () => {
  const h = fixture(); await selectSeedance25(h.page);
  assert.deepEqual(h.calls, ['wait-control', 'open-model-menu', 'wait-option', 'select-2.5', 'confirm-selection']);
});
test('explicit data-disabled=false is enabled for both model control and option', async () => {
  const h = fixture({ dataDisabled: 'false', controlDataDisabled: 'false' });
  await selectSeedance25(h.page);
  assert.ok(h.calls.includes('select-2.5'));
});
test('selects an existing enabled 2.0 option for expert 15s', async () => {
  const h = fixture({ model: '模型 2.5', target: '2.0' });
  await selectSeedance(h.page, 'seedance_v2.0');
  assert.deepEqual(h.calls, ['wait-control', 'open-model-menu', 'wait-option', 'select-2.0', 'confirm-selection']);
});
for (const [name, config] of [
  ['missing control', { controls: 0 }], ['ambiguous controls', { controls: 2 }],
  ['no option', { options: 0 }], ['ambiguous options', { options: 2 }],
  ['disabled option', { enabled: false }], ['aria-disabled option', { ariaDisabled: 'true' }],
  ['data-disabled option', { dataDisabled: '' }], ['selection did not change', { selectionChanges: false }],
]) {
  test(`${name} fails before any prompt or generation action`, async () => {
    const h = fixture(config); await assert.rejects(selectSeedance25(h.page), /未提交/);
    assert.ok(!h.calls.includes('submit'));
  });
}

for (const config of [{ controlWaitFails: true }, { optionWaitFails: true }, { options: 0 }, { selectionChanges: false }]) {
  test(`loading or ambiguous evidence stays unknown: ${JSON.stringify(config)}`, async () => {
    const h = fixture(config);
    await assert.rejects(selectSeedance25(h.page), e => e.code === 'NATIVE_CAPABILITY_UNKNOWN' && Boolean(e.reason));
  });
}
test('explicitly disabled target is unavailable; selected disabled control cannot pass', async () => {
  for (const config of [{ enabled: false }, { model: '模型 2.5', controlEnabled: false }]) {
    await assert.rejects(selectSeedance25(fixture(config).page), e => e.code === 'NATIVE_CAPABILITY_UNAVAILABLE');
  }
});
test('version prefixes and ambiguous combined labels are never accepted as selected', async () => {
  for (const model of ['模型 12.5', '模型 2.50', '模型 2.5.1', '模型 2.5 / 2.0']) {
    const h = fixture({ model }); await selectSeedance25(h.page);
    assert.ok(h.calls.includes('select-2.5'));
  }
});
