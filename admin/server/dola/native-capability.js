import { selectSeedance } from './generation-model.js';
import { selectNativeVideoDuration } from './generation-duration.js';

export const VIDEO_COMPOSER_INPUT_SELECTOR = 'textarea, [contenteditable="true"]';

function unknownCapability(label, detail) {
  const error = new Error(`${label}能力探测未完成：${detail}`);
  error.code = 'NATIVE_CAPABILITY_UNKNOWN';
  return error;
}

function unknown(seconds, detail) {
  return unknownCapability(`原生 ${seconds} 秒`, detail);
}

/**
 * Open the existing video composer and inspect its current native controls.
 * This helper never fills a prompt and never presses Enter/send.
 */
export async function prepareNativeVideoComposer(page, {
  seconds = 30,
  model = seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5',
  timeout = 60000,
  clickDelayMs = 2500,
  log = () => {},
} = {}) {
  if (![10, 15, 20, 30].includes(Number(seconds))) throw new TypeError('seconds must be 10, 15, 20 or 30');
  if (!['seedance_v2.0', 'seedance_v2.5'].includes(model)) throw new TypeError('unsupported Seedance model');
  const targetSeconds = Number(seconds);
  try {
    await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout });
  } catch {
    throw unknown(targetSeconds, '未确认已登录的创作页面');
  }

  log('只读打开视频创作控件');
  const videoButtons = page.getByRole('button', { name: '视频生成' });
  if (await videoButtons.count().catch(() => 0) < 1) {
    throw unknown(targetSeconds, '页面没有可见的视频生成入口');
  }
  const videoButton = videoButtons.first();
  for (let i = 0; i < 2; i++) {
    await videoButton.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(clickDelayMs).catch(() => {});
  }
  await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout }).catch(() => {
    throw unknown(targetSeconds, '视频创作面板未完成加载');
  });

  try {
    await selectSeedance(page, model);
  } catch (error) {
    if (error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') throw error;
    throw unknown(targetSeconds, '页面模型控件未完成加载');
  }
  try {
    await selectNativeVideoDuration(page, targetSeconds);
  } catch (error) {
    if (error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') throw error;
    throw unknown(targetSeconds, '页面时长控件未完成加载');
  }
  return { model, seconds: targetSeconds, native: true };
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
  const videoButtons = page.getByRole('button', { name: '视频生成' });
  if (await videoButtons.count().catch(() => 0) < 1) {
    throw unknownCapability('参考图', '页面没有可见的视频生成入口');
  }
  const videoButton = videoButtons.first();
  for (let i = 0; i < 2; i++) {
    await videoButton.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(clickDelayMs).catch(() => {});
  }
  await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout }).catch(() => {
    throw unknownCapability('参考图', '视频创作面板未完成加载');
  });

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
