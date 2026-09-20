/** Select an existing model option. Never insert options or fake capability responses. */
const MODEL_SELECTOR = '[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]';
const MODEL_PATTERNS = Object.freeze({
  'seedance_v2.0': /(?:^|[^\d])(?:Seedance\s*)?2\.0(?:[^\d]|$)|Seedance\s*2\.0\s*Fast/i,
  'seedance_v2.5': /(?:^|[^\d])(?:Seedance\s*)?2\.5(?:[^\d]|$)/i,
});

function modelPattern(model) {
  return MODEL_PATTERNS[model] || null;
}

function unavailable(model) {
  const label = model === 'seedance_v2.0' ? 'Seedance 2.0' : 'Seedance 2.5';
  const error = new Error(`页面未能确认可用的 ${label} 模型，未提交；不会静默改用其他模型`);
  error.code = 'NATIVE_CAPABILITY_UNAVAILABLE';
  return error;
}

export async function selectSeedance(page, model = 'seedance_v2.5') {
  const pattern = modelPattern(model);
  if (!pattern) throw new TypeError(`unsupported Seedance model: ${model}`);
  const control = page.locator(MODEL_SELECTOR).filter({ visible: true });
  if (await control.count() !== 1) throw unavailable(model);
  if (pattern.test(await control.innerText())) return;
  if (!await control.isEnabled() || await control.getAttribute('aria-disabled') === 'true') throw unavailable(model);
  await control.click({ timeout: 5000 }).catch(() => { throw unavailable(model); });
  const option = page.locator('[role="option"], [role="menuitem"], [data-slot="dropdown-menu-item"]')
    .filter({ hasText: pattern }).filter({ visible: true });
  if (await option.count() !== 1 || !await option.isEnabled()
      || await option.getAttribute('aria-disabled') === 'true'
      || await option.getAttribute('data-disabled') !== null) throw unavailable(model);
  await option.click({ timeout: 5000 }).catch(() => { throw unavailable(model); });
  await page.waitForFunction(({ selector, source }) => {
    const controls = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
    return controls.length === 1 && new RegExp(source, 'i').test(controls[0].textContent || '');
  }, { selector: MODEL_SELECTOR, source: pattern.source }, { timeout: 5000 }).catch(() => { throw unavailable(model); });
  if (!pattern.test(await control.innerText())) throw unavailable(model);
}

export async function selectSeedance25(page) {
  return selectSeedance(page, 'seedance_v2.5');
}
