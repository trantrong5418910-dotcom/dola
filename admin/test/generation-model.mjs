import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSeedance, selectSeedance25 } from '../server/dola/generation-model.js';

// Locator-only double. No browser, upstream service, credentials or submit action.
function fixture({ model = '模型 2.0', target = '2.5', controls = 1, options = 1, enabled = true,
  ariaDisabled = null, dataDisabled = null, selectionChanges = true } = {}) {
  const calls = [];
  const control = {
    filter() { return this; }, count: async () => controls, innerText: async () => model,
    isEnabled: async () => true, getAttribute: async () => null,
    click: async () => calls.push('open-model-menu'),
  };
  const option = {
    filter() { return this; }, count: async () => options, isEnabled: async () => enabled,
    getAttribute: async name => name === 'aria-disabled' ? ariaDisabled : dataDisabled,
    click: async () => { calls.push(`select-${target}`); if (selectionChanges) model = `模型 Seedance ${target}`; },
  };
  const page = {
    locator: selector => selector.includes('actionbar') ? control : option,
    waitForFunction: async () => { calls.push('confirm-selection'); if (!selectionChanges) throw new Error('synthetic timeout'); },
  };
  return { page, calls };
}

test('already-selected 2.5 does not click or submit anything', async () => {
  const h = fixture({ model: '模型 2.5' }); await selectSeedance25(h.page);
  assert.deepEqual(h.calls, []);
});
test('selects an existing enabled 2.5 option and confirms selected control', async () => {
  const h = fixture(); await selectSeedance25(h.page);
  assert.deepEqual(h.calls, ['open-model-menu', 'select-2.5', 'confirm-selection']);
});
test('selects an existing enabled 2.0 option for expert 15s', async () => {
  const h = fixture({ model: '模型 2.5', target: '2.0' });
  await selectSeedance(h.page, 'seedance_v2.0');
  assert.deepEqual(h.calls, ['open-model-menu', 'select-2.0', 'confirm-selection']);
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
