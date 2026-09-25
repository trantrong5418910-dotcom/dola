import { selectSeedance } from './generation-model.js';
import { NATIVE_DURATION_CONTROL_SELECTOR, selectNativeVideoDuration } from './generation-duration.js';
import { waitForVideoComposerBootstrap } from './composer-bootstrap.js';

export const VIDEO_COMPOSER_INPUT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

function unknownCapability(label, detail, reason = '') {
  const error = new Error(`${label}能力探测未完成：${detail}`);
  error.code = 'NATIVE_CAPABILITY_UNKNOWN';
  if (reason) error.reason = reason;
  return error;
}

function unknown(seconds, detail, reason = '') {
  return unknownCapability(`原生 ${seconds} 秒`, detail, reason);
}

function preparationBudget(timeout, label) {
  const deadline = Date.now() + Math.min(120000, Math.max(1, Number(timeout) || 60000));
  return () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw unknownCapability(label, '页面准备超过总时限', 'VIDEO_PREPARATION_TIMEOUT');
    return remaining;
  };
}
const reportPhase = (callback, phase) => { try { callback(phase); } catch { /* Diagnostics cannot alter admission. */ } };


// Keep composer readiness checks aligned with the duration selector itself;
// newer Dola builds also expose the control via test id or accessible label.
const VIDEO_DURATION_CONTROL = NATIVE_DURATION_CONTROL_SELECTOR;

/** Open the bottom video composer chip — never the sidebar recent-chat title. */
async function openVideoComposerEntry(page, {
  timeout = 60000,
  clickDelayMs = 2500,
  log = () => {},
  label = '视频',
  onPhase = () => {},
} = {}) {
  const remaining = preparationBudget(timeout, label);
  const duration = page.locator(VIDEO_DURATION_CONTROL).filter({ visible: true });
  if (await duration.count().catch(() => 0) >= 1) {
    log('视频创作条已打开');
    return;
  }

  // A rendered/enabled chip is not yet hydrated. The site's configuration must
  // arrive first; otherwise an early click can permanently bind a generic skill.
  reportPhase(onPhase, 'bootstrap');
  if (!await waitForVideoComposerBootstrap(page, Math.min(remaining(), 60000))) {
    const error = unknownCapability(label, '视频工具栏启动配置未完成，未点击入口');
    error.reason = 'VIDEO_BOOTSTRAP_NOT_READY';
    throw error;
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  reportPhase(onPhase, 'entry');

  // The input shell appears before the video chip hydrates. Wait for real UI
  // evidence instead of immediately classifying a slow page as unsupported.
  await page.waitForFunction(selector => {
    const visible = el => el.getClientRects().length > 0;
    if ([...document.querySelectorAll(selector)].some(visible)) return true;
    return [...document.querySelectorAll('button, [role="button"], #flow-chat-guidance-page *')]
      .some(el => visible(el) && el.textContent?.trim() === '视频生成'
        && !el.closest('aside, nav, [class*="sidebar"], [class*="Sidebar"], #chat-route-aside'));
  }, VIDEO_DURATION_CONTROL, { timeout: remaining() }).catch(() => {
    throw unknownCapability(label, '视频生成入口尚未完成加载', 'VIDEO_ENTRY_NOT_READY');
  });
  if (await duration.count().catch(() => 0) >= 1) return;

  const candidates = [
    // Prefer true buttons in the guidance / action bar.
    () => page.getByRole('button', { name: /^视频生成$/ }),
    () => page.locator('#flow-chat-guidance-page, [data-guidance-input-sug-anchor], [data-guidance-input-boundary]')
      .getByRole('button', { name: /视频生成/ }),
    () => page.locator('#flow-chat-guidance-page, [data-guidance-input-sug-anchor]')
      .locator('button, [role="button"]').filter({ hasText: /^视频生成$/ }),
    // Quick-start chips sometimes are not role=button.
    () => page.locator('#flow-chat-guidance-page').getByText('视频生成', { exact: true }),
    () => page.locator('[data-input-engine-action-source="actionbar"]').filter({ hasText: /视频生成/ }),
  ];

  let clicked = false;
  for (const make of candidates) {
    const loc = make();
    const n = await loc.count().catch(() => 0);
    if (n < 1) continue;
    // Avoid sidebar "最近" conversation titles: they live outside guidance page
    // and navigate to /chat/<id> instead of opening the composer.
    for (let i = 0; i < Math.min(n, 3); i++) {
      const el = loc.nth(i);
      const inSidebar = await el.evaluate((node) => {
        const root = node.closest('#chat-route-layout, aside, nav, [data-container-name]');
        const text = (node.textContent || '').replace(/\s+/g, '');
        // Sidebar recent rows often repeat the title 2-3 times in nested nodes.
        return Boolean(node.closest('[class*="sidebar"], [class*="Sidebar"], #chat-route-aside'))
          || (text.includes('视频生成') && text.length > 12 && !node.closest('#flow-chat-guidance-page, [data-guidance-input-boundary], #input-engine-container'));
      }).catch(() => false);
      if (inSidebar) continue;
      const opened = await el.click({ timeout: Math.min(remaining(), 8000) }).then(() => true).catch(() => false);
      if (!opened) continue;
      clicked = true;
      // The chip is a toggle. A second click during hydration can close it.
      // Wait for the actual duration control after one successful click.
      await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
        .some(node => node.getClientRects().length), VIDEO_DURATION_CONTROL,
      { timeout: remaining() }).catch(() => {});
      if (await duration.count().catch(() => 0) >= 1) return;
      throw unknownCapability(label, '已点击视频生成入口，但创作条时长控件未完成加载', 'VIDEO_CONTROLS_NOT_READY');
    }
  }

  // Last resort: any role=button named 视频生成 (legacy path).
  if (!clicked) {
    const videoButtons = page.getByRole('button', { name: '视频生成' });
    if (await videoButtons.count().catch(() => 0) >= 1) {
      const videoButton = videoButtons.first();
      await videoButton.click({ timeout: Math.min(remaining(), 8000) }).catch(() => {});
      await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
        .some(node => node.getClientRects().length), VIDEO_DURATION_CONTROL,
      { timeout: remaining() }).catch(() => {});
    }
  }

  if (await duration.count().catch(() => 0) < 1) {
    throw unknownCapability(label, '页面没有可见的视频生成入口（未能打开创作条时长控件）', 'VIDEO_ENTRY_NOT_READY');
  }
  await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout: remaining() }).catch(() => {
    throw unknownCapability(label, '视频创作面板未完成加载');
  });
}


/**
 * Open the existing video composer and inspect its current native controls.
 * This helper never fills a prompt and never presses Enter/send.
 *
 * `allowUpstreamConcat` 决定是否把页面自己的合成档位（`30s (15s ×2)`）也算作
 * 一种可用证据。默认关闭；开启后返回的 `source` 会标成 `upstream_concat`，
 * 调用方据此关闭请求改写（合成档位本身就是目标时长，不该再被改写）。
 */
export async function prepareNativeVideoComposer(page, {
  seconds = 30,
  model = seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5',
  timeout = 60000,
  clickDelayMs = 2500,
  log = () => {},
  onPhase = () => {},
  allowUpstreamConcat = false,
} = {}) {
  if (![10, 15, 20, 30].includes(Number(seconds))) throw new TypeError('seconds must be 10, 15, 20 or 30');
  if (!['seedance_v2.0', 'seedance_v2.5'].includes(model)) throw new TypeError('unsupported Seedance model');
  const targetSeconds = Number(seconds);
  const remaining = preparationBudget(timeout, `原生 ${targetSeconds} 秒`);
  try {
    await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout: Math.min(remaining(), 30000) });
  } catch {
    // Navigation belongs to the caller's bounded lifecycle. A second navigation
    // here discarded useful boot progress and could outlive the request budget.
    throw unknown(targetSeconds, '未确认已登录的创作页面', 'VIDEO_PAGE_NOT_READY');
  }

  log('只读打开视频创作控件');
  try {
    await openVideoComposerEntry(page, { timeout: remaining(), clickDelayMs, log, label: `原生 ${targetSeconds} 秒`, onPhase });
  } catch (error) {
    if (error?.code === 'NATIVE_CAPABILITY_UNKNOWN' || error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') throw error;
    throw unknown(targetSeconds, error?.message || '页面没有可见的视频生成入口');
  }

  try {
    reportPhase(onPhase, 'model');
    await selectSeedance(page, model, { timeout: Math.min(remaining(), 15000) });
  } catch (error) {
    if (['NATIVE_CAPABILITY_UNAVAILABLE', 'NATIVE_CAPABILITY_UNKNOWN'].includes(error?.code)) throw error;
    throw unknown(targetSeconds, '页面模型控件未完成加载');
  }
  let duration;
  try {
    reportPhase(onPhase, 'duration');
    duration = await selectNativeVideoDuration(page, targetSeconds, {
      timeout: Math.min(remaining(), 15000),
      allowUpstreamConcat,
    });
  } catch (error) {
    if (['NATIVE_CAPABILITY_UNAVAILABLE', 'NATIVE_CAPABILITY_UNKNOWN'].includes(error?.code)) throw error;
    throw unknown(targetSeconds, '页面时长控件未完成加载');
  }
  remaining();
  reportPhase(onPhase, 'verified');
  return {
    model,
    seconds: targetSeconds,
    uiSeconds: duration.uiSeconds,
    native: duration.native,
    rewriteCarrier: duration.rewriteCarrier,
    source: duration.source,
    concat: duration.concat === true,
  };
}

export async function prepareNativeThirtySecondComposer(page, options = {}) {
  return prepareNativeVideoComposer(page, { ...options, seconds: 30, model: 'seedance_v2.5' });
}

/**
 * Open the video composer and inspect whether the live page exposes an
 * explicit image file input. This is deliberately stricter than merely
 * finding a plus button: a plus button can open many unrelated menus, while
 * an image-accepting file input is the concrete DOM capability we can safely
 * use for a later upload implementation.
 *
 * The probe never selects a file, fills a prompt, or submits a task.
 */
export async function prepareReferenceImageComposer(page, {
  timeout = 60000,
  clickDelayMs = 2500,
  log = () => {},
} = {}) {
  try {
    await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout });
  } catch {
    throw unknownCapability('参考图', '未确认已登录的创作页面');
  }

  log('只读打开视频创作控件，检查参考图上传入口');
  try {
    await openVideoComposerEntry(page, { timeout, clickDelayMs, log, label: '参考图' });
  } catch (error) {
    if (error?.code === 'NATIVE_CAPABILITY_UNKNOWN' || error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') throw error;
    throw unknownCapability('参考图', error?.message || '页面没有可见的视频生成入口');
  }

  const controls = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')].map((input) => ({
      accept: String(input.getAttribute('accept') || ''),
      multiple: Boolean(input.multiple),
      name: String(input.getAttribute('name') || ''),
      id: String(input.id || ''),
    }));
    const imageInputs = inputs.filter((input) => /image\//i.test(input.accept)
      || /\.(?:png|jpe?g|webp)(?:,|$)/i.test(input.accept));
    const labels = [...document.querySelectorAll('button, label, [role="button"]')]
      .map((node) => String(node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text && /图片|参考图|上传|image|reference|upload/i.test(text))
      .slice(0, 8);
    return { fileInputs: inputs.length, imageInputs, labels };
  }).catch(() => ({ fileInputs: 0, imageInputs: [], labels: [] }));

  if (!controls.imageInputs.length) {
    const detail = controls.fileInputs
      ? `页面有 ${controls.fileInputs} 个文件控件，但没有明确声明图片类型`
      : '页面没有发现明确的图片文件控件';
    const error = unknownCapability('参考图', `${detail}；暂不放开上传`);
    error.controls = controls;
    throw error;
  }
  return {
    referenceImages: true,
    imageInputs: controls.imageInputs,
    labels: controls.labels,
  };
}

export function nativeCapabilityState(error) {
  return error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE' ? 'unavailable' : 'unknown';
}

export function referenceImageCapabilityState(error) {
  return error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE' ? 'unavailable' : 'unknown';
}
