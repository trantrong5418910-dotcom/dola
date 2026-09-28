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
  const before = page.url();
  // Exactly one send action. Never follow this with Enter or another click.
  await send.click({ timeout }).catch(() => {
    throw failure('GENERATION_SUBMISSION_UNCERTAIN', '发送动作结果未确认，请先核对上游任务，不要重复提交');
  });

  // A missing numeric conversation URL does not establish that no request was sent.
  // Observe once after the click; never retry the send action here.
  let dispatched = false;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500).catch(() => {
      throw failure('GENERATION_SUBMISSION_UNCERTAIN', '发送动作已执行，页面观察中断；请核对上游结果，不要重复提交');
    });
    if (/\/chat\/\d{10,}/.test(page.url())) { dispatched = true; break; }
  }
  if (dispatched) return { sendActionCompleted: true, conversationLocated: true, dispatched: true };

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
        // This is sampled AFTER the click; it cannot identify the original click target.
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

  return { sendActionCompleted: true, conversationLocated: false,
    // Compatibility field: this describes URL observation only, never transport acceptance.
    dispatched: false, observationPhase: 'after_click',
    urlBefore: before, urlAfter: page.url(), sendButton: dom, shot };
}
