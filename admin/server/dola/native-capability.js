import { selectSeedance } from './generation-model.js';
import { NATIVE_DURATION_CONTROL_SELECTOR, selectNativeVideoDuration } from './generation-duration.js';
import { SUPPORTED_VIDEO_SECONDS } from './generation-policy.js';
import { waitForVideoComposerBootstrap } from './composer-bootstrap.js';
// Expert mode is a real composer state, not a gateway-only flag.  Keep the
// helper exported from this capability module so callers that already import
// the native composer probes use one stable entry point.
export { ensureExpertMode, EXPERT_MODE_UNCONFIRMED } from './generation-mode.js';

export const VIDEO_COMPOSER_INPUT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

/**
 * 造一个「能力未知」错误。
 *
 * ★ `reason` 是**必填的语义**，不是可选装饰：调用方（`provider.js` 的 catch、
 *   `routes/dola.js` 的写回）都是按 `error.reason` 决定：
 *     ① 账号备注里带不带 `［结构化原因］`；
 *     ② 诊断日志里能不能分清「网络没通 / 页面慢到超时 / 登录态没了 / DOM 变了」。
 *
 *   漏传的后果非常隐蔽（2026-09-27 实测账号 #436）：
 *   `reason` 为空 → provider 返回 `reason: null` → 路由层只能拼出一句通用文案
 *   「页面、登录状态或网络未能完成参考图能力探测」→ 管理后台**看不到任何原因**，
 *   而真正有用的信息（到底有没有文件控件、是不是图片类型）全被丢掉。
 *   同一天 #430 因为在别处带了 reason，备注就能显示 `［VIDEO_PAGE_NOT_READY］`。
 *
 *   所以：**新增任何 throw 点都必须给 reason**。`test/reference-image-probe.mjs`
 *   里有一条静态守卫会扫描本文件，漏传直接变红。
 */
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
    // 时长控件已经可见、创作输入框却等不到 —— 和「入口没打开」是两件事，
    // 给独立 reason，否则排障时只能看到一句通用文案。
    throw unknownCapability(label, '视频创作面板未完成加载', 'VIDEO_PANEL_NOT_READY');
  });
}


/**
 * Open the existing video composer and inspect its current native controls.
 * This helper never fills a prompt and never presses Enter/send.
 *
 * `allowUpstreamConcat` 决定是否把页面自己的合成档位（`30s (15s ×2)`）也算作
 * 一种可用证据。默认关闭；开启后返回的 `source` 会标成 `upstream_concat`，
 * 调用方据此关闭请求改写（合成档位本身就是目标时长，不该再被改写）。
 *
 * `carriers` 是本次生效的载体映射（见 generation-duration.js 的
 * `resolveDurationCarrierMap`）。**不传 = 历史口径**（20→10s、30→15s）；
 * 传 `{30: 10}` 才是"30 秒用页面上真实存在的 10s 档承载"。
 * 探测与生成两条路径必须传同一份映射，否则会出现"探针说可用、生成选不到档位"。
 */
export async function prepareNativeVideoComposer(page, {
  seconds = 30,
  model = seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5',
  timeout = 60000,
  clickDelayMs = 2500,
  log = () => {},
  onPhase = () => {},
  allowUpstreamConcat = false,
  carriers = null,
  allowLegacy = false,
} = {}) {
  // allowLegacy=true：历史防护解锁探针专用，放行 10/20 这些已下线档位（见 LEGACY_DURATION_CHOICES）。
  if (!allowLegacy && !SUPPORTED_VIDEO_SECONDS.includes(Number(seconds))) {
    throw new TypeError('seconds must be 15 or 30');
  }
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
    // 入口点击本身的预算是**有上限**的：不能让它把整条准备预算吃光，
    // 否则后面的模型/时长控件就没有余量了（曾经是 remaining() 全给）。
    await openVideoComposerEntry(page, {
      timeout: Math.min(remaining(), 45000), clickDelayMs, log, label: `原生 ${targetSeconds} 秒`, onPhase,
    });
  } catch (error) {
    if (error?.code === 'NATIVE_CAPABILITY_UNKNOWN' || error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') throw error;
    throw unknown(targetSeconds, error?.message || '页面没有可见的视频生成入口', 'VIDEO_ENTRY_NOT_READY');
  }

  /**
   * ★ 控件水合顺序（2026-09-26 实测，账号 #424 经住宅代理）：
   *
   *   点击「视频生成」→ +3.0s 时长控件可见 → **+6.0s 模型控件才可见**
   *
   * 也就是说**模型控件是最后水合的**。而这里原先给它和时长控件各写死 15 秒，
   * 在慢代理下（页面启动实测 19.5s ~ 70.8s 波动）经常不够，表现为
   * 「模型控件未加载完成或存在多个可见控件」（MODEL_CONTROL_NOT_READY）。
   * 线上任务 #163 就是这么失败的。
   *
   * 现在按角色分配剩余预算：模型控件拿大头（它最晚），时长控件拿剩下的。
   * 注意不是"等更久"——`remaining()` 仍然兜住总时限，超了照样抛
   * VIDEO_PREPARATION_TIMEOUT，只是把余量给对了地方。
   */
  try {
    reportPhase(onPhase, 'model');
    await selectSeedance(page, model, { timeout: Math.min(remaining(), 40000) });
  } catch (error) {
    if (['NATIVE_CAPABILITY_UNAVAILABLE', 'NATIVE_CAPABILITY_UNKNOWN'].includes(error?.code)) throw error;
    throw unknown(targetSeconds, '页面模型控件未完成加载', 'VIDEO_MODEL_CONTROL_NOT_READY');
  }
  let duration;
  try {
    reportPhase(onPhase, 'duration');
    duration = await selectNativeVideoDuration(page, targetSeconds, {
      timeout: Math.min(remaining(), 30000),
      allowUpstreamConcat,
      carriers,
      allowLegacy,
    });
  } catch (error) {
    if (['NATIVE_CAPABILITY_UNAVAILABLE', 'NATIVE_CAPABILITY_UNKNOWN'].includes(error?.code)) throw error;
    throw unknown(targetSeconds, '页面时长控件未完成加载', 'VIDEO_DURATION_CONTROL_NOT_READY');
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
  /**
   * ★ 可选：与调用方**共享**的绝对截止时间戳（`Date.now()` 口径）。
   *
   * 为什么必须支持这个：原来这里只收 `timeout`，而 `timeout` 被**两处各自用满**
   * —— `waitForSelector` 用一次，`openVideoComposerEntry` 再用一次（后者内部还会
   * 自己 `preparationBudget(timeout)` 另开一个时钟）。于是"60 秒预算"实际可以跑出
   * 120 秒以上，整条探测链路没有任何一层收敛。2026-09-27 实测账号 #429 的参考图探测
   * 跑了 **253.4 秒**才失败，恰好等于各层超时上限之和（60+75+3+60+60≈258 秒）。
   *
   * 传了 `deadline` 就只认它，所有等待都从同一个时钟里扣（与
   * `prepareNativeVideoComposer` 的 `remaining()` 同口径）。
   */
  deadline = null,
  clickDelayMs = 2500,
  log = () => {},
  /**
   * 与 `prepareNativeVideoComposer` 同口径的阶段回调。**必须传下去**：
   * `openVideoComposerEntry` 内部是「等启动配置 → 点入口 → 等时长控件」三段，
   * 不细分就只能看到 entry 一整个阶段的总耗时。2026-09-27 实测 #429 的 entry
   * 阶段单吃 52 秒，正因为没有细粒度回调，无法判断到底卡在哪一段。
   */
  onPhase = () => {},
} = {}) {
  const budget = deadline
    ? () => {
      const left = deadline - Date.now();
      if (left <= 0) throw unknownCapability('参考图', '页面准备超过总时限', 'VIDEO_PREPARATION_TIMEOUT');
      return left;
    }
    : preparationBudget(timeout, '参考图');
  try {
    await page.waitForSelector(VIDEO_COMPOSER_INPUT_SELECTOR, { timeout: budget() });
  } catch {
    throw unknownCapability('参考图', '未确认已登录的创作页面', 'VIDEO_PAGE_NOT_READY');
  }

  log('只读打开视频创作控件，检查参考图上传入口');
  try {
    // 入口点击的预算是**有上限**的：不能让它把整条准备预算吃光，否则后面
    // 检查 DOM 的余量就没有了（曾经是把 timeout 全给，见上方 deadline 注释）。
    await openVideoComposerEntry(page, {
      timeout: Math.min(budget(), 45000), clickDelayMs, log, label: '参考图', onPhase,
    });
  } catch (error) {
    if (error?.code === 'NATIVE_CAPABILITY_UNKNOWN' || error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') throw error;
    throw unknownCapability('参考图', error?.message || '页面没有可见的视频生成入口', 'VIDEO_ENTRY_NOT_READY');
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
    /**
     * ★ 这两种情况必须给**不同**的 reason（2026-09-27 实测账号 #436 栽在这里）。
     *
     * 它们的含义完全相反，修法也完全不同：
     *   · 有 input[type=file] 但 accept 不声明图片 → **DOM 结构变了**，
     *     要去看 `controls`（fileInputs / labels）重新对选择器；
     *   · 一个 file input 都没有 → 这个号/这个页面**真的没有上传入口**，
     *     应该判 unavailable，而不是继续当 unknown 反复烧 80 秒预算。
     *
     * 之前这两种共用一句「暂不放开上传」且**没带 reason**，于是：
     * provider 返回 reason=null → 路由只写出一句通用文案 → 后台看不到任何原因，
     * 唯一能区分的证据只有 `controls`，而它从来没被写进备注。
     */
    const error = unknownCapability('参考图', `${detail}；暂不放开上传`,
      controls.fileInputs ? 'REFERENCE_IMAGE_CONTROL_UNSPECIFIED' : 'REFERENCE_IMAGE_CONTROL_MISSING');
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
