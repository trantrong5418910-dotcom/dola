/**
 * Select an already-rendered duration option from Dola's page.
 *
 * This is deliberately an observation/selection gate, not a capability patch:
 * it never adds an option, edits a config response, or rewrites a request body.
 */
export const NATIVE_DURATION_CONTROL_SELECTOR = [
  '[data-input-engine-actionbar-control-key="video-duration"]',
  '[data-input-engine-actionbar-control-key="duration"]',
  '[data-testid*="duration"]',
  '[aria-label*="时长"]',
  '[aria-label*="Duration"]',
].join(', ');

const DURATION_OPTION_SELECTOR = [
  '[role="option"]',
  '[role="menuitem"]',
  '[data-slot="dropdown-menu-item"]',
].join(', ');

const durationPattern = seconds => new RegExp(
  `(?:^|[^\\d])${seconds}\\s*(?:s|秒)(?:$|[^\\d])`,
  'i',
);

const unavailable = (seconds, detail) => {
  const error = new Error(`未确认原生 ${seconds} 秒：${detail}，未提交`);
  error.code = 'NATIVE_CAPABILITY_UNAVAILABLE';
  return error;
};

export async function selectNativeVideoDuration(page, seconds) {
  if (![10, 15, 20, 30].includes(seconds)) {
    throw new TypeError('seconds must be 10, 15, 20 or 30');
  }

  const pattern = durationPattern(seconds);
  const control = page.locator(NATIVE_DURATION_CONTROL_SELECTOR).filter({ visible: true });
  if (await control.count() !== 1) {
    throw unavailable(seconds, '页面没有唯一可见的时长控件');
  }
  if (!await control.isEnabled()
      || await control.getAttribute('aria-disabled') === 'true'
      || await control.getAttribute('data-disabled') !== null) {
    throw unavailable(seconds, '时长控件不可用');
  }

  if (pattern.test(await control.innerText())) {
    return { seconds, native: true };
  }

  await control.click({ timeout: 5000 }).catch(() => {
    throw unavailable(seconds, '无法打开现有时长选项');
  });

  const option = page.locator(DURATION_OPTION_SELECTOR)
    .filter({ hasText: pattern })
    .filter({ visible: true });
  if (await option.count() !== 1
      || !await option.isEnabled()
      || await option.getAttribute('aria-disabled') === 'true'
      || await option.getAttribute('data-disabled') !== null) {
    throw unavailable(seconds, '页面没有唯一可选的原生时长选项');
  }

  await option.click({ timeout: 5000 }).catch(() => {
    throw unavailable(seconds, '无法选择原生时长选项');
  });

  await page.waitForFunction(({ selector, expected }) => {
    const pattern = new RegExp(`(?:^|[^\\d])${expected}\\s*(?:s|秒)(?:$|[^\\d])`, 'i');
    const controls = [...document.querySelectorAll(selector)]
      .filter(element => element.getClientRects().length);
    return controls.length === 1 && pattern.test(controls[0].textContent || '');
  }, { selector: NATIVE_DURATION_CONTROL_SELECTOR, expected: seconds }, { timeout: 5000 })
    .catch(() => { throw unavailable(seconds, '选择后控件没有显示原生时长'); });

  if (!pattern.test(await control.innerText())) {
    throw unavailable(seconds, '选择后控件文本仍不是目标时长');
  }
  return { seconds, native: true };
}
