import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillAndSubmitVideoPrompt, VIDEO_SEND_SELECTOR } from '../server/dola/generation-submit.js';

function fixture({ inputs = 1, sends = 1, text = 'synthetic prompt', enabled = true, dataDisabled = 'false',
  ariaDisabled = 'false', loading = 'false', waitFails = false, clickFails = false, fillFails = false } = {}) {
  const calls = [];
  const input = {
    filter() { return this; }, count: async () => inputs,
    fill: async value => { calls.push(['fill', value]); if (fillFails) throw Error('synthetic fill error'); },
    inputValue: async () => { throw Error('contenteditable'); }, innerText: async () => text,
  };
  const send = {
    filter() { return this; }, count: async () => sends, isEnabled: async () => enabled,
    getAttribute: async key => ({ 'data-disabled': dataDisabled, 'aria-disabled': ariaDisabled, 'data-loading': loading })[key] ?? null,
    click: async () => { calls.push(['click']); if (clickFails) throw Error('synthetic timeout after dispatch'); },
  };
  const page = {
    evaluate: async () => {},
    // generation-submit.js 在点击后同步读 page.url() 做派发取证，并用
    // page.waitForTimeout 做轮询；桩必须提供这两个方法（Playwright 里 url() 是同步的）。
    url: () => 'https://example.invalid/',
    waitForTimeout: async () => {},
    locator: selector => selector === VIDEO_SEND_SELECTOR ? send : input,
    waitForFunction: async (_fn, selector) => { assert.equal(selector, VIDEO_SEND_SELECTOR); calls.push(['wait-ready']); if (waitFails) throw Error('not ready'); },
    keyboard: { press: async () => { throw Error('Enter shortcut forbidden'); }, type: async () => { throw Error('blind fallback forbidden'); } },
  };
  return { page, calls };
}

test('fills exact prompt and clicks explicit send button once, never presses Enter', async () => {
  const h = fixture(); await fillAndSubmitVideoPrompt(h.page, 'synthetic prompt');
  assert.deepEqual(h.calls, [['fill', 'synthetic prompt'], ['wait-ready'], ['click']]);
});

for (const options of [{ inputs: 0 }, { inputs: 2 }, { text: '' }, { text: 'partial' }, { fillFails: true },
  { sends: 0 }, { sends: 2 }, { enabled: false }, { dataDisabled: '' }, { dataDisabled: 'true' },
  { ariaDisabled: 'true' }, { loading: 'true' }, { waitFails: true }]) {
  test(`incomplete/ambiguous/disabled state cannot submit: ${JSON.stringify(options)}`, async () => {
    const h = fixture(options);
    await assert.rejects(fillAndSubmitVideoPrompt(h.page, 'synthetic prompt'));
    assert.ok(!h.calls.some(([call]) => call === 'click'));
  });
}

test('cancelled task cannot send after waiting for the button', async () => {
  const h = fixture();
  await assert.rejects(fillAndSubmitVideoPrompt(h.page, 'synthetic prompt', { isActive: () => false }),
    e => e.code === 'GENERATION_CANCELLED');
  assert.ok(!h.calls.some(([call]) => call === 'click'));
});

test('click timeout stays uncertain and never triggers a second send', async () => {
  const h = fixture({ clickFails: true });
  await assert.rejects(fillAndSubmitVideoPrompt(h.page, 'synthetic prompt'), e => e.code === 'GENERATION_SUBMISSION_UNCERTAIN');
  assert.equal(h.calls.filter(([call]) => call === 'click').length, 1);
});
