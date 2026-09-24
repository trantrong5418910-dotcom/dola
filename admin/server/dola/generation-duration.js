/**
 * Select an already-rendered duration option from Dola's page.
 *
 * For 20s the page is expected to expose only the 10s carrier option;
 * for 30s only the 15s carrier option (2-credit tier). The actual duration is
 * rewritten at the request layer (see installVideoRequestAdapter).
 * Confirming the carrier therefore proves 20/30s capability via the rewrite path.
 * Genuine native 20/30s controls, when present, are still accepted as-is.
 *
 * Native one-shot vs dual concat:
 *   Dola's create UI can show both 「30秒」 (single Seedance 2.5 shot) and
 *   「15秒×2」 (dual 15s concat). We only accept the single-shot label; concat
 *   markers (×2 / 拼接 / …) are rejected so 30s never falls through to dual 15s.
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

/** Labels that mean dual/concat generation, not a single native duration. */
export const CONCAT_DURATION_LABEL = /[×xX*]\s*2|拼接|分段|两段|concat|dual/i;

export const durationPattern = seconds => new RegExp(
  `(?:^|[^\\d])${seconds}\\s*(?:s|秒)(?:$|[^\\d])`,
  'i',
);

/** Legacy adapter mapping only; never used as native capability evidence. */
export function uiCarrierSeconds(seconds) {
  const n = Number(seconds);
  if (n === 30) return 15;  // 30s 用 15s 档做载体（2 额度档），请求层改写 duration=30
  if (n === 20) return 10;
  return n;
}

export function isNativeSingleShotDurationText(text, seconds) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || CONCAT_DURATION_LABEL.test(normalized)) return false;
  return durationPattern(seconds).test(normalized);
}

const unavailable = (seconds, detail) => {
  const error = new Error(`未确认原生 ${seconds} 秒：${detail}，未提交`);
  error.code = 'NATIVE_CAPABILITY_UNAVAILABLE';
  return error;
};

const unknown = (seconds, reason, detail) => {
  const error = new Error(`原生 ${seconds} 秒能力探测未完成：${detail}，未提交`);
  error.code = 'NATIVE_CAPABILITY_UNKNOWN';
  error.reason = reason;
  return error;
};

async function disabled(locator) {
  const dataDisabled = await locator.getAttribute('data-disabled');
  return !await locator.isEnabled()
    || await locator.getAttribute('aria-disabled') === 'true'
    || (dataDisabled !== null && dataDisabled !== 'false');
}

export async function selectNativeVideoDuration(page, seconds, { timeout = 12000 } = {}) {
  if (![10, 15, 20, 30].includes(seconds)) {
    throw new TypeError('seconds must be 10, 15, 20 or 30');
  }

  // 20/30 秒走改写路径：20s 用 10s 做载体，30s 用 15s 做载体（2 额度档），请求层改写 duration。
  // 探测时确认载体存在即为有效，不再要求页面有原生 20/30 秒选项。
  const uiSeconds = uiCarrierSeconds(seconds);
  const rewriteCarrier = uiSeconds !== seconds;
  const pattern = durationPattern(uiSeconds);
  const control = page.locator(NATIVE_DURATION_CONTROL_SELECTOR).filter({ visible: true });
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
    .filter(el => el.getClientRects().length).length === 1, NATIVE_DURATION_CONTROL_SELECTOR, { timeout })
    .catch(() => { throw unknown(uiSeconds, 'DURATION_CONTROL_NOT_READY', '时长控件未加载完成或存在多个可见控件'); });
  if (await control.count() !== 1) {
    throw unknown(uiSeconds, 'DURATION_CONTROL_AMBIGUOUS', '页面没有唯一可见的时长控件');
  }
  if (await disabled(control)) {
    throw unavailable(uiSeconds, '时长控件不可用');
  }

  const result = {
    seconds,
    uiSeconds,
    native: uiSeconds === seconds,
    rewriteCarrier,
  };

  // Preserve an already-selected target; never shorten a native 20/30s option.
  if (isNativeSingleShotDurationText(await control.innerText(), uiSeconds)) {
    return result;
  }

  await control.click({ timeout: 5000 }).catch(() => {
    throw unknown(uiSeconds, 'DURATION_MENU_OPEN_FAILED', '无法打开现有时长选项');
  });

  await page.waitForFunction(({ selector, source, concatSource }) => [...document.querySelectorAll(selector)]
    .some(el => el.getClientRects().length && new RegExp(source, 'i').test(el.textContent || '')
      && !new RegExp(concatSource, 'i').test(el.textContent || '')),
  { selector: DURATION_OPTION_SELECTOR, source: pattern.source, concatSource: CONCAT_DURATION_LABEL.source }, { timeout })
    .catch(() => { throw unknown(uiSeconds, 'DURATION_OPTION_NOT_CONFIRMED', '限时内未确认目标单次时长选项（不等于账号无权限）'); });

  // Prefer the unique single-shot option; explicitly exclude 「15秒×2」 etc.
  const option = page.locator(DURATION_OPTION_SELECTOR)
    .filter({ hasText: pattern })
    .filter({ hasNotText: CONCAT_DURATION_LABEL })
    .filter({ visible: true });
  if (await option.count() !== 1) {
    throw unknown(uiSeconds, 'DURATION_OPTION_AMBIGUOUS', '页面没有唯一可选的原生单次时长选项（已排除 ×2/拼接）');
  }
  if (await disabled(option)) {
    throw unavailable(uiSeconds, '页面没有唯一可选的原生单次时长选项（已排除 ×2/拼接）');
  }

  await option.click({ timeout: 5000 }).catch(() => {
    throw unknown(uiSeconds, 'DURATION_SELECTION_FAILED', '无法选择原生时长选项');
  });

  await page.waitForFunction(({ selector, expected, concatSource }) => {
    const pattern = new RegExp(`(?:^|[^\\d])${expected}\\s*(?:s|秒)(?:$|[^\\d])`, 'i');
    const concat = new RegExp(concatSource, 'i');
    const controls = [...document.querySelectorAll(selector)]
      .filter(element => element.getClientRects().length);
    if (controls.length !== 1) return false;
    const text = (controls[0].textContent || '').replace(/\s+/g, ' ').trim();
    return pattern.test(text) && !concat.test(text);
  }, {
    selector: NATIVE_DURATION_CONTROL_SELECTOR,
    expected: uiSeconds,
    concatSource: CONCAT_DURATION_LABEL.source,
  }, { timeout })
    .catch(() => { throw unknown(uiSeconds, 'DURATION_SELECTION_NOT_CONFIRMED', '选择后控件没有显示原生单次时长'); });

  if (await control.count() !== 1 || await disabled(control)
      || !isNativeSingleShotDurationText(await control.innerText(), uiSeconds)) {
    throw unknown(uiSeconds, 'DURATION_SELECTION_NOT_CONFIRMED', '选择后控件未保持目标单次时长');
  }
  return result;
}
