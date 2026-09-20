import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectNativeVideoDuration } from '../server/dola/generation-duration.js';

function fixture({ controlCount = 1, controlText = '10s', optionCount = 1,
  controlEnabled = true, optionEnabled = true, selectedOptionText = '30s' } = {}) {
  const calls = [];
  let selectedText = controlText;
  const control = {
    filter() { return this; },
    count: async () => controlCount,
    isEnabled: async () => controlEnabled,
    getAttribute: async () => null,
    innerText: async () => selectedText,
    click: async () => { calls.push('open'); },
  };
  const option = {
    filter() { return this; },
    count: async () => optionCount,
    isEnabled: async () => optionEnabled,
    getAttribute: async () => null,
    click: async () => { calls.push('select'); selectedText = selectedOptionText; },
  };
  return {
    page: {
      locator(selector) {
        return /role="option"|role="menuitem"|dropdown-menu-item/.test(selector)
          ? option : control;
      },
      waitForFunction: async () => { calls.push('verify'); },
    },
    calls,
  };
}

test('accepts an already selected, visible native 30s control', async () => {
  const h = fixture({ controlText: '30s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), { seconds: 30, native: true });
  assert.deepEqual(h.calls, []);
});

test('selects an existing native 30s option and verifies the control changed', async () => {
  const h = fixture();
  assert.deepEqual(await selectNativeVideoDuration(h.page, 30), { seconds: 30, native: true });
  assert.deepEqual(h.calls, ['open', 'select', 'verify']);
});

test('fails closed when the page has no unique duration control or native option', async () => {
  await assert.rejects(
    selectNativeVideoDuration(fixture({ controlCount: 0 }).page, 30),
    /未确认原生 30 秒/,
  );
  const h = fixture({ optionCount: 0 });
  await assert.rejects(selectNativeVideoDuration(h.page, 30), /未确认原生 30 秒/);
  assert.deepEqual(h.calls, ['open']);
});

test('does not accept a disabled duration control', async () => {
  await assert.rejects(
    selectNativeVideoDuration(fixture({ controlEnabled: false }).page, 30),
    /未确认原生 30 秒/,
  );
});

test('selects an existing native 20s option', async () => {
  const h = fixture({ controlText: '10s', selectedOptionText: '20s' });
  // The fixture represents the selected option after the click; the control
  // update is the same observation used for the 30s path.
  assert.deepEqual(await selectNativeVideoDuration(h.page, 20), { seconds: 20, native: true });
  assert.deepEqual(h.calls, ['open', 'select', 'verify']);
});

test('selects an existing native 15s expert option', async () => {
  const h = fixture({ controlText: '10s', selectedOptionText: '15s' });
  assert.deepEqual(await selectNativeVideoDuration(h.page, 15), { seconds: 15, native: true });
  assert.deepEqual(h.calls, ['open', 'select', 'verify']);
});
