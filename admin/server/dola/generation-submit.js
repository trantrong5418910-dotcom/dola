/** Submit using the actual send control, never a configurable Enter shortcut.
 * No retries: a click error may occur after dispatch, so callers must reconcile.
 */
export const VIDEO_SEND_SELECTOR = '#flow-end-msg-send';
const INPUT = 'textarea, [contenteditable="true"]';
const failure = (code, message) => Object.assign(new Error(message), { code });

export async function fillAndSubmitVideoPrompt(page, prompt, { timeout = 15000, isActive = () => true } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt is required');
  const input = page.locator(INPUT).filter({ visible: true });
  if (await input.count() !== 1) throw failure('GENERATION_INPUT_AMBIGUOUS', '没有唯一可见的提示词输入框，未提交');
  await input.fill(prompt, { timeout });
  const typed = await input.inputValue().catch(() => input.innerText());
  if (String(typed).trim() !== prompt.trim()) throw failure('GENERATION_INPUT_MISMATCH', '提示词内容未完整写入，未提交');
  // Let the input event/render commit before consulting a button that may still
  // reflect the previous draft's enabled state.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
    if (nodes.length !== 1) return false;
    const el = nodes[0], dataDisabled = el.getAttribute('data-disabled');
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true'
      && (dataDisabled === null || dataDisabled === 'false') && el.getAttribute('data-loading') !== 'true';
  }, VIDEO_SEND_SELECTOR, { timeout }).catch(() => {
    throw failure('GENERATION_SEND_NOT_READY', '发送按钮尚未就绪，未提交');
  });
  const send = page.locator(VIDEO_SEND_SELECTOR).filter({ visible: true });
  if (await send.count() !== 1) throw failure('GENERATION_SEND_NOT_READY', '没有唯一可见的发送按钮，未提交');
  const dataDisabled = await send.getAttribute('data-disabled');
  if (!await send.isEnabled() || await send.getAttribute('aria-disabled') === 'true'
      || (dataDisabled !== null && dataDisabled !== 'false') || await send.getAttribute('data-loading') === 'true') {
    throw failure('GENERATION_SEND_NOT_READY', '发送按钮状态变化，未提交');
  }
  if (!isActive()) throw failure('GENERATION_CANCELLED', 'generation_cancelled');
  // Exactly one send action. Never follow this with Enter or another click.
  await send.click({ timeout }).catch(() => {
    throw failure('GENERATION_SUBMISSION_UNCERTAIN', '发送动作结果未确认，请先核对上游任务，不要重复提交');
  });

  /**
   * ★ 点了却没派发时的**现场取证**。
   *
   * 为什么必须有：实测出现过"提示词写进去了、发送按钮看着也是可用的、点击也没报错，
   * 但浏览器**一个生成请求都没发出**（放行 0 次 / 阻断 0 次）"的情况。
   * 只有一段文字回执根本判断不了 —— 是按钮点错了？被遮挡了？还是应用没接住这次点击？
   * 所以这里**只观察、不重试**（绝不补一次 Enter 或再次点击，那会造成重复提交）：
   * 给几秒时间看 URL 有没有跳到会话页；没跳就截图 + 记录按钮的 DOM 状态。
   */
  const before = page.url();
  let dispatched = false;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    if (/\/chat\/\d{10,}/.test(page.url())) { dispatched = true; break; }
  }
  if (dispatched) return { dispatched: true };

  const dom = await page.evaluate((sel) => {
    const nodes = [...document.querySelectorAll(sel)];
    return nodes.map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        disabled: !!el.disabled,
        ariaDisabled: el.getAttribute('aria-disabled'),
        dataDisabled: el.getAttribute('data-disabled'),
        dataLoading: el.getAttribute('data-loading'),
        pointerEvents: cs.pointerEvents,
        visibility: cs.visibility,
        opacity: cs.opacity,
        // 点下去的时候到底命中了谁？被别的元素盖住的话这里会显示覆盖者
        topAtCenter: (() => {
          const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
          const t = document.elementFromPoint(cx, cy);
          return t ? (t.id ? '#' + t.id : t.tagName + (t.className ? '.' + String(t.className).slice(0, 40) : '')) : null;
        })(),
      };
    });
  }, VIDEO_SEND_SELECTOR).catch(() => []);

  let shot = null;
  try {
    const dir = process.env.DOLA_DIAG_DIR || '/tmp/dola-diag';
    // eslint-disable-next-line no-undef
    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    shot = `${dir}/no-dispatch-${Date.now()}.png`;
    await page.screenshot({ path: shot });
  } catch { shot = null; }

  return { dispatched: false, urlBefore: before, urlAfter: page.url(), sendButton: dom, shot };
}
