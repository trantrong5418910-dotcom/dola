/**
 * Select an already-rendered duration option from Dola's page.
 *
 * Three ways a target duration can be proven, in the order we try them:
 *
 *   1. native_single   — the page really offers 「30秒」 as one shot.
 *   2. carrier_rewrite — the page offers a shorter carrier (20→10s, 30→15s)
 *                        and the request layer rewrites ability_param.duration.
 *   3. upstream_concat — the page offers its own concat tier for the target
 *                        duration, e.g. 「30s (15s ×2)」. Upstream splits into
 *                        two shots and joins them head-to-tail, then hands back
 *                        ONE continuous clip. We never stitch locally, so this
 *                        path carries no local duration drift.
 *
 * Path 3 is only reachable when the caller passes allowUpstreamConcat: true,
 * because it changes what this service is willing to admit as a 30-second task.
 *
 * Native one-shot vs dual concat:
 *   Dola's create UI can show both 「30秒」 (single Seedance 2.5 shot) and
 *   「15秒×2」 (dual 15s concat). Path 1 must never silently fall through to a
 *   concat tier — they are different products — so concat markers stay rejected
 *   there. Path 3 is the explicit, opt-in door for concat tiers.
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

/**
 * 时长菜单的**容器** —— 实测 Dola 渲染成
 * `div[role="menu"][data-slot="dropdown-menu-content"]`，
 * 里面的选项是 `div[role="menuitem"][data-slot="dropdown-menu-item"]`。
 *
 * 为什么要单独认容器：只有"容器确实打开了、里面确实有选项"，
 * 才能断定「这个账号没有这个档位」；否则"菜单压根没渲染"也会被记成
 * 同一句"未确认"，运营永远分不清是账号不行还是探测没跑完。
 *
 * 实测（2026-09-25，#419 日本住宅代理）：菜单内容是 `时长 5s 10s`，
 * 切到 Seedance 2.0 Fast 之后依然只有 5s / 10s —— 免费号额度用完就是这个样子。
 */
const DURATION_MENU_CONTENT_SELECTOR = [
  '[data-slot="dropdown-menu-content"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(', ');

/**
 * Labels that mean dual/concat generation, not a single native duration.
 *
 * 覆盖两种写法：`15s ×2`（实测样本）和 `2×15s`。
 * 后者也要认：不认的话 `isNativeSingleShotDurationText('2×15s', 15)` 会返回 true，
 * 把一个拼接档位当成 15 秒单次档位 —— 正是最不该放过去的那种误判。
 */
export const CONCAT_DURATION_LABEL = /[×xX*]\s*2|\b2\s*[×xX*]\s*\d|拼接|分段|两段|concat|dual/i;

/**
 * 一次探测最终认定的能力来源。日志/备注用它区分"这个时长是怎么拿到的"，
 * 避免把「原生单次」和「上游合成」混进同一个成功率里。
 */
export const DURATION_SOURCE = Object.freeze({
  NATIVE_SINGLE: 'native_single',
  CARRIER_REWRITE: 'carrier_rewrite',
  UPSTREAM_CONCAT: 'upstream_concat',
});

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

/**
 * 上游合成档位的文案判据：**同一段文案里既出现目标秒数，又出现 ×2/拼接 标记**。
 *
 * 实测样本形如 `30s (15s ×2)`、`30秒（15秒×2）`。
 * 两个条件必须同时成立，所以 `15秒×2` 在目标 30 时不成立 ——
 * 它声明的时长是 15，不是 30，不会被误当成 30 秒档。
 */
export function isUpstreamConcatDurationText(text, seconds) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return CONCAT_DURATION_LABEL.test(normalized) && durationPattern(seconds).test(normalized);
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

/**
 * 读出时长菜单里**实际提供**的档位（只读，不做选择）。
 *
 * 菜单没打开时返回空数组 —— 空数组只代表"没读到"，不代表"没有档位"。
 * 调用方要拿它区分「账号没有这个档位」和「菜单没渲染出来」。
 * 页面对象没有这两个方法时（离线单测的桩）同样返回空数组。
 */
export async function listNativeVideoDurations(page, { timeout = 5000 } = {}) {
  if (typeof page?.waitForFunction !== 'function') return [];
  const texts = await page.waitForFunction(selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
    return nodes.length
      ? nodes.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24))
      : false;
  }, DURATION_OPTION_SELECTOR, { timeout })
    .then(handle => (handle && typeof handle.jsonValue === 'function' ? handle.jsonValue() : null))
    .catch(() => null);
  return Array.isArray(texts) ? [...new Set(texts.filter(Boolean))].slice(0, 12) : [];
}

/** 菜单容器是否已打开（用来判断"没读到档位"到底是哪种情况） */
async function menuOpened(page) {
  if (typeof page?.evaluate !== 'function') return false;
  try {
    return await page.evaluate(selector => [...document.querySelectorAll(selector)]
      .some(el => el.getClientRects().length), DURATION_MENU_CONTENT_SELECTOR) === true;
  } catch {
    return false;
  }
}

/**
 * 选择页面自己提供的**上游合成档位**（例如 `30s (15s ×2)`）。
 *
 * 这条路径的性质：上游拆两段、首尾相接，交回来的是**一条连续的成片** ——
 * 合成发生在上游，所以本地不跑 ffmpeg，也就没有拼接导致的时长漂移。
 *
 * 找不到这样的档位返回 null（交给调用方按"这个账号没有该档位"处理）；
 * 找到了但不可用/选不中则抛错，绝不静默降级成更短的载体。
 */
async function selectUpstreamConcatDuration(page, seconds, { timeout = 12000 } = {}) {
  const target = durationPattern(seconds);
  const waitFor = (selector, budget) => page.waitForFunction(({ selector, secondsSource, concatSource }) => {
    const wanted = new RegExp(secondsSource, 'i');
    const concat = new RegExp(concatSource, 'i');
    return [...document.querySelectorAll(selector)].some(el => el.getClientRects().length
      && wanted.test(el.textContent || '') && concat.test(el.textContent || ''));
  }, { selector, secondsSource: target.source, concatSource: CONCAT_DURATION_LABEL.source }, { timeout: budget })
    .then(() => true).catch(() => false);

  if (!await waitFor(DURATION_OPTION_SELECTOR, Math.min(timeout, 5000))) return null;

  const option = page.locator(DURATION_OPTION_SELECTOR)
    .filter({ hasText: target })
    .filter({ hasText: CONCAT_DURATION_LABEL })
    .filter({ visible: true });
  if (await option.count() !== 1) {
    throw unknown(seconds, 'UPSTREAM_CONCAT_AMBIGUOUS', '页面没有唯一可选的上游合成档位（不等于账号无权限）');
  }
  if (await disabled(option)) throw unavailable(seconds, '上游合成档位不可用');

  await option.click({ timeout: 5000 }).catch(() => {
    throw unknown(seconds, 'UPSTREAM_CONCAT_SELECTION_FAILED', '无法选择上游合成档位');
  });
  if (!await waitFor(NATIVE_DURATION_CONTROL_SELECTOR, timeout)) {
    throw unknown(seconds, 'UPSTREAM_CONCAT_NOT_CONFIRMED', '选择后控件没有显示上游合成档位');
  }
  return {
    seconds,
    // 合成档位**自己声明**了目标时长，所以 UI 上就是目标秒数，也不需要请求层改写。
    uiSeconds: seconds,
    native: false,
    rewriteCarrier: false,
    source: DURATION_SOURCE.UPSTREAM_CONCAT,
    concat: true,
  };
}

export async function selectNativeVideoDuration(page, seconds, {
  timeout = 12000,
  allowUpstreamConcat = false,
} = {}) {
  if (![10, 15, 20, 30].includes(seconds)) {
    throw new TypeError('seconds must be 10, 15, 20 or 30');
  }

  // 20/30 秒默认走改写路径：20s 用 10s 做载体，30s 用 15s 做载体（2 额度档），请求层改写 duration。
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
    source: rewriteCarrier ? DURATION_SOURCE.CARRIER_REWRITE : DURATION_SOURCE.NATIVE_SINGLE,
    concat: false,
  };

  // 上游合成档位已经选中（控件显示「30s (15s ×2)」）——它自己就声明了目标时长，直接成立。
  if (allowUpstreamConcat && isUpstreamConcatDurationText(await control.innerText(), seconds)) {
    return {
      ...result, uiSeconds: seconds, native: false, rewriteCarrier: false,
      source: DURATION_SOURCE.UPSTREAM_CONCAT, concat: true,
    };
  }

  // Preserve an already-selected target; never shorten a native 20/30s option.
  if (isNativeSingleShotDurationText(await control.innerText(), uiSeconds)) {
    return result;
  }

  await control.click({ timeout: 5000 }).catch(() => {
    throw unknown(uiSeconds, 'DURATION_MENU_OPEN_FAILED', '无法打开现有时长选项');
  });

  const confirmed = await page.waitForFunction(({ selector, source, concatSource }) => [...document.querySelectorAll(selector)]
    .some(el => el.getClientRects().length && new RegExp(source, 'i').test(el.textContent || '')
      && !new RegExp(concatSource, 'i').test(el.textContent || '')),
  { selector: DURATION_OPTION_SELECTOR, source: pattern.source, concatSource: CONCAT_DURATION_LABEL.source }, { timeout })
    .then(() => true).catch(() => false);

  if (!confirmed) {
    /**
     * 单次档位没确认到。先看菜单**实际提供了什么**，再决定说哪句话：
     *   · 菜单确实打开、里面确实有档位 → 确定结论：这个账号就是没有这个档位，
     *     把实际档位写进错误（免费号额度用完只剩 5s/10s 正是这种）。
     *   · 菜单压根没渲染 → 证据不足，保持 unknown，不能记成"不支持"。
     */
    const offered = await menuOpened(page) ? await listNativeVideoDurations(page, { timeout: 3000 }) : [];
    if (allowUpstreamConcat) {
      const concat = await selectUpstreamConcatDuration(page, seconds, { timeout });
      if (concat) return concat;
    }
    if (offered.length) {
      throw unavailable(uiSeconds, `页面时长菜单只提供 ${offered.join(' / ')}，没有 ${uiSeconds} 秒档位`);
    }
    throw unknown(uiSeconds, 'DURATION_OPTION_NOT_CONFIRMED', '限时内未确认目标单次时长选项（不等于账号无权限）');
  }

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
