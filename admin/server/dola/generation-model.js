/** Select an existing model option. Never insert options or fake capability responses. */
const MODEL_SELECTOR = '[data-input-engine-actionbar-control-key="video-model"], [data-input-engine-actionbar-control-key="model"]';
const OPTION_SELECTOR = '[role="option"], [role="menuitem"], [data-slot="dropdown-menu-item"]';
const MODEL_PATTERNS = Object.freeze({
  'seedance_v2.0': /(?:^|[^\d.])2\.0(?![\d.])/i,
  'seedance_v2.5': /(?:^|[^\d.])2\.5(?![\d.])/i,
});

function capabilityError(model, reason, detail, unavailable = false) {
  const label = model === 'seedance_v2.0' ? 'Seedance 2.0' : 'Seedance 2.5';
  const error = new Error(label + ' 模型能力探测未完成：' + detail + '，未提交；不会静默改用其他模型');
  error.code = unavailable ? 'NATIVE_CAPABILITY_UNAVAILABLE' : 'NATIVE_CAPABILITY_UNKNOWN';
  error.reason = reason;
  return error;
}

async function disabled(locator) {
  const dataDisabled = await locator.getAttribute('data-disabled');
  return !await locator.isEnabled()
    || await locator.getAttribute('aria-disabled') === 'true'
    || (dataDisabled !== null && dataDisabled !== 'false');
}

export async function selectSeedance(page, model = 'seedance_v2.5', { timeout = 12000 } = {}) {
  const pattern = MODEL_PATTERNS[model];
  if (!pattern) throw new TypeError('unsupported Seedance model: ' + model);
  const fail = (reason, detail, unavailable) => capabilityError(model, reason, detail, unavailable);
  const control = page.locator(MODEL_SELECTOR).filter({ visible: true });
  // Duration and model controls hydrate independently. Never fall back to a hidden node.
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
    .filter(el => el.getClientRects().length).length === 1, MODEL_SELECTOR, { timeout })
    .catch(() => { throw fail('MODEL_CONTROL_NOT_READY', '模型控件未加载完成或存在多个可见控件'); });
  if (await control.count() !== 1) throw fail('MODEL_CONTROL_AMBIGUOUS', '没有唯一可见的模型控件');
  if (await disabled(control)) throw fail('MODEL_CONTROL_DISABLED', '模型控件不可用', true);
  const other = model === 'seedance_v2.5' ? MODEL_PATTERNS['seedance_v2.0'] : MODEL_PATTERNS['seedance_v2.5'];
  const matches = text => pattern.test(text) && !other.test(text);
  if (matches(await control.innerText())) return;

  await control.click({ timeout: 5000 })
    .catch(() => { throw fail('MODEL_MENU_OPEN_FAILED', '无法打开模型菜单'); });
  // A fixed 400ms sleep races lazy menu rendering, especially over a proxy.
  await page.waitForFunction(({ selector, source, exclude }) => [...document.querySelectorAll(selector)]
    .some(el => el.getClientRects().length && new RegExp(source, 'i').test(el.textContent || '')
      && !new RegExp(exclude, 'i').test(el.textContent || '')),
  { selector: OPTION_SELECTOR, source: pattern.source, exclude: other.source }, { timeout })
    .catch(() => { throw fail('MODEL_OPTION_NOT_CONFIRMED', '限时内没有确认目标模型选项（不等于账号无权限）'); });
  const option = page.locator(OPTION_SELECTOR).filter({ hasText: pattern })
    .filter({ hasNotText: other }).filter({ visible: true });
  if (await option.count() !== 1) throw fail('MODEL_OPTION_AMBIGUOUS', '没有唯一可见的目标模型选项');
  if (await disabled(option)) throw fail('MODEL_OPTION_DISABLED', '目标模型选项明确不可用', true);
  await option.click({ timeout: 5000 })
    .catch(() => { throw fail('MODEL_SELECTION_FAILED', '目标模型选择失败'); });
  await page.waitForFunction(({ selector, source, exclude }) => {
    const visible = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
    return visible.length === 1 && new RegExp(source, 'i').test(visible[0].textContent || '')
      && !new RegExp(exclude, 'i').test(visible[0].textContent || '');
  }, { selector: MODEL_SELECTOR, source: pattern.source, exclude: other.source }, { timeout })
    .catch(() => { throw fail('MODEL_SELECTION_NOT_CONFIRMED', '选择后未确认目标模型'); });
  if (await control.count() !== 1 || await disabled(control) || !matches(await control.innerText())) {
    throw fail('MODEL_SELECTION_NOT_CONFIRMED', '选择后模型控件未保持目标状态');
  }
}

export async function selectSeedance25(page, options) {
  return selectSeedance(page, 'seedance_v2.5', options);
}
