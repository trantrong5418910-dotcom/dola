/** Offline browser regression of the production composer and admission predicate.
 * No DB, credentials, live URLs, generation or billing. Uses only synthetic DOM.
 */
import assert from 'node:assert/strict';
import { getPlaywright } from '../server/dola/provider.js';
import { prepareNativeVideoComposer } from '../server/dola/native-capability.js';
import { isVerifiedNativeCapability } from '../server/dola/generation-policy.js';

const cases = [
  { name: '10s unchanged', seconds: 10, current: '10s', options: ['5s', '10s'], clicks: 0 },
  { name: '20s unchanged', seconds: 20, current: '20s', options: ['10s', '20s'], clicks: 0 },
  { name: '20s actual option', seconds: 20, current: '10s', options: ['5s', '10s', '20s'], clicks: 1 },
  { name: '30s actual option', seconds: 30, current: '10s', options: ['10s', '20s', '30s'], clicks: 1 },
  { name: '15s expert option', seconds: 15, current: '10s', options: ['10s', '15s'], clicks: 1 },
  { name: '20s absent', seconds: 20, current: '10s', options: ['5s', '10s'], error: 'NATIVE_CAPABILITY_UNKNOWN' },
  { name: '20s disabled', seconds: 20, current: '10s', options: ['10s', '20s'], disabled: '20s', error: 'NATIVE_CAPABILITY_UNAVAILABLE' },
  { name: '20s hidden', seconds: 20, current: '10s', options: ['10s', '20s'], hidden: '20s', error: 'NATIVE_CAPABILITY_UNKNOWN' },
  { name: '20s ambiguous', seconds: 20, current: '10s', options: ['10s', '20s', '20s'], error: 'NATIVE_CAPABILITY_UNKNOWN' },
  { name: '20s concat rejected', seconds: 20, current: '10s', options: ['10s', '20s (10s ×2)'], error: 'NATIVE_CAPABILITY_UNKNOWN' },
  { name: '30s concat rejected', seconds: 30, current: '10s', options: ['10s', '30s (15s ×2)'], error: 'NATIVE_CAPABILITY_UNKNOWN' },
  { name: '20s changed back', seconds: 20, current: '10s', options: ['10s', '20s'], rollback: true, clicks: 1, error: 'NATIVE_CAPABILITY_UNKNOWN' },
];
const pw = await getPlaywright();
if (!pw?.chromium) throw new Error('Installed Playwright runtime required; no automatic installation');
const browser = await pw.chromium.launch({ headless: true, executablePath: pw.chromium.executablePath(), timeout: 15000 });
let requests = 0;
try {
  const context = await browser.newContext({ serviceWorkers: 'block', offline: true });
  await context.route('**/*', route => { requests++; return route.abort(); });
  await context.routeWebSocket('**/*', socket => socket.close());
  for (const sample of cases) {
    const page = await context.newPage();
    try {
      await page.setContent(`<textarea aria-label="Synthetic prompt"></textarea>
        <button data-input-engine-actionbar-control-key="video-model"></button>
        <button id="duration" data-input-engine-actionbar-control-key="video-duration"></button>
        <div id="menu" hidden></div>`);
      await page.evaluate(sample => {
        document.querySelector('[data-input-engine-actionbar-control-key="video-model"]').textContent =
          sample.seconds === 15 ? 'Seedance 2.0 Fast' : 'Seedance 2.5';
        const control = document.querySelector('#duration'), menu = document.querySelector('#menu');
        control.textContent = sample.current;
        window.syntheticSelections = [];
        control.onclick = () => {
          menu.hidden = false;
          for (const label of sample.options) {
            const option = document.createElement('button');
            option.setAttribute('role', 'menuitem'); option.textContent = label;
            if (sample.disabled === label) option.setAttribute('aria-disabled', 'true');
            if (sample.hidden === label) option.style.display = 'none';
            option.onclick = () => {
              window.syntheticSelections.push(label);
              control.textContent = sample.rollback ? sample.current : label;
              menu.hidden = true;
            };
            menu.append(option);
          }
        };
      }, sample);
      // Capture the starting DOM before exercising the actual application selectors.
      const snapshot = await page.locator('body').ariaSnapshot();
      assert.ok(snapshot.includes(sample.current));
      let capability, error;
      try { capability = await prepareNativeVideoComposer(page, { seconds: sample.seconds, timeout: 650 }); }
      catch (caught) { error = caught; }
      if (sample.error) assert.equal(error?.code, sample.error, sample.name);
      else {
        assert.equal(error, undefined, sample.name);
        assert.equal(isVerifiedNativeCapability({ ...capability, ok: true, state: 'available' }, sample.seconds), true);
      }
      const selections = await page.evaluate(() => window.syntheticSelections);
      assert.equal(selections.length, sample.clicks || 0, sample.name);
      if (selections.length) assert.equal(selections[0], `${sample.seconds}s`);
      assert.equal(await page.locator('textarea').inputValue(), '');
      console.log(JSON.stringify({ test: sample.name, passed: true, state: error?.code || 'native_target_confirmed' }));
    } finally { await page.close(); }
  }
  assert.equal(requests, 0, 'Synthetic page must not attempt external requests');
  console.log(JSON.stringify({ passed: cases.length, networkRequests: requests, generated: 0 }));
} finally { await browser.close(); }
