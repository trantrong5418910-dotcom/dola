/**
 * 「你好」探测 —— 向账号新建一条普通对话并发送固定文本「你好」，用来判定登录态。
 *
 * ★ 两条通道，默认走纯协议（2026-09-28 改）
 * --------------------------------------------------------------------
 *   pure-http（默认）：**完全不开浏览器**。复用已经过实测的普通对话 body
 *     （`chat-bridge.js` 的 `buildPlainChatBody`，已在 #415 实测拿到助手回复）
 *     + 把厂商 bdms SDK 跑在 Node 沙箱里算 a_bogus（`pure-http.js` 的签名器），
 *     再用账号代理直接 POST。**零 Playwright、零 profile 目录、零浏览器并发占用。**
 *
 *   browser（保留为回退）：旧实现，开 Chromium 操作 UI 填字点发送。
 *     慢代理下光等输入框就要 20~30 秒（见 INPUT_WAIT_MS 注释），还要占账号浏览器锁。
 *     现在只有显式要求 `mode: 'browser'` 才会走这条路。
 *
 * 为什么纯协议成立：视频提交通道（`pure-http.js`）与聊天桥（`chat-bridge.js`）
 * 都已经在同一条 `/chat/completion` 端点上过验签并拿到 ACK，本文件只是把
 * 「body 换成固定的你好、判定口径换成探测口径」而已，没有新的协议未知量。
 *
 * ⚠️ 判定语义（调用方 `routes/dola.js` 的 `dola_hello_probe` 会按 state 决定是否把账号
 * 置为 invalid，口径漂移会误杀好号）—— 判定逻辑集中在 `classifyHelloProbeReceipt()`：
 *   available   ：上游已受理这次普通对话（纯协议 = 拿到 conversation_id）
 *   unavailable ：上游**明确**说会话失效（710012001 / 710012014 或 HTTP 401/403）
 *   unknown     ：其余一切（限流 710022002 / 出口地区受限 710022003 / 代理不通 / 超时）—— 一律不判失效
 *
 * ★ 纯协议通道比旧浏览器通道**判得更严**，这是刻意修掉的一个误判（2026-09-28 实测）：
 *   旧通道只看 HTTP 状态，于是 `{"code":710022003,"message":"您所在的国家/地区不可用。"}`
 *   这种「HTTP 200 + body 里的错误」会被它判成 `available` —— **把地区受限的号标成"可用"**。
 *   纯协议要求真正的 `conversation_id`。副作用：同一批号里 `unknown` 会比从前多、
 *   `available` 会比从前少 —— 那是更诚实的读数，不是退化。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOLA_BASE, DOLA_HEADERS, getPlaywright, toPlaywrightCookies, cookieHeader as cookieHeaderOf } from './provider.js';
import { startSocksBridge } from './socks-bridge.js';
import { tryAcquireAccountBrowserLock } from './account-browser-lock.js';
import { buildPlainChatBody } from './chat-bridge.js';
import { abogusSignerFor, PURE_HTTP_SUBMIT_URL, PURE_HTTP_UA } from './pure-http.js';
import { fetchVia } from './proxy.js';

// ── 浏览器通道（回退）专用：选择器与等待常量 ─────────────────────────────
// 下面这一组常量、辅助函数与 `sendHelloProbeViaBrowser` 只服务于 mode='browser'，
// 默认的纯协议通道完全不碰它们（它连 Playwright 都不加载）。
//
// The ordinary composer has appeared as a textarea, a tiptap/ProseMirror
// contenteditable, and (in newer builds) a role=textbox. Prefer the site's
// stable test id and then the editable child. A broad selector alone can count
// both a wrapper (role=textbox) and its child, which falsely reports that the
// page has more than one composer.
const COMPOSER_SELECTORS = Object.freeze([
  '[data-testid="chat_input_input"] textarea',
  '[data-testid="chat_input_input"] [contenteditable="true"]',
  '[data-testid="chat_input_input"] [role="textbox"]',
  'textarea[data-testid="chat_input_input"]',
  '[contenteditable="true"][data-testid="chat_input_input"]',
  '[role="textbox"][data-testid="chat_input_input"]',
  'textarea',
  '[contenteditable="true"]',
  // Do not select an outer role=textbox which only wraps the real editor.
  '[role="textbox"]:not(:has(textarea, [contenteditable="true"]))',
]);
const INPUT_SELECTOR = COMPOSER_SELECTORS.join(', ');
const SEND_SELECTORS = Object.freeze(['#flow-end-msg-send', '[data-testid="chat_input_send_button"]']);
const SEND_SELECTOR = SEND_SELECTORS.join(', ');
const PROFILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'browser-profiles');
const DOLA_ORIGIN = new URL(DOLA_BASE).origin;

/**
 * 等待普通聊天输入框渲染出来的上限。
 *
 * 实测（2026-09-26，账号 424 走 as.udealproxy.com）：
 *   /chat/ 的 DOMContentLoaded 约 5.8s，但输入框要到约 19.5s 才出现。
 * 原实现只等 5s networkidle 就一次性 count()，对慢代理必然误判
 * 「未找到唯一普通聊天输入框，未发送」—— 这不是账号问题，是等待不足。
 * 快代理（如 420 号）侥幸能过，所以这个坑只在部分账号上暴露。
 */
const INPUT_WAIT_MS = 30_000;
const SEND_WAIT_MS = 15_000;
const HELLO_TEXT = '你好';

// ═══════════════════════════════════════════════ 纯协议通道（默认）

/** 可选通道：`pure-http`（默认，零浏览器）｜`browser`（回退，开 Chromium 走 UI）。 */
export const HELLO_PROBE_MODES = Object.freeze(['pure-http', 'browser']);

/** 设置值 → 通道名。非法/缺失一律回默认通道（与 `resolveSubmitMode` 同风格）。 */
export function resolveHelloProbeMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return HELLO_PROBE_MODES.includes(v) ? v : 'pure-http';
}

/**
 * 上游「会话失效」码。
 *
 * ⚠️ 与浏览器通道里的 `expired: /710012001|710012014/` 是**同一组**。
 * 两条通道各自维护一份很容易漂移（一边加了新码、另一边还在判 unknown），
 * 所以这里提成常量，改动时两处一起看。
 */
const SESSION_EXPIRED_CODES = Object.freeze([710012001, 710012014]);

const PROBE_CONVERSATION_ID_RE = /"conversation_id"\s*:\s*"(\d+)"/;
const PROBE_QUESTION_ID_RE = /"question_id"\s*:\s*"(\d+)"/;
const PROBE_ERROR_CODE_RE = /"error_code"\s*:\s*(\d+)/g;

/** 回执最多收多少字符（防上游异常刷流把内存吃光）。 */
const PROBE_MAX_RECEIPT_CHARS = 256 * 1024;

/**
 * 拿到 `conversation_id` 之后再多读多少字符就收手。
 *
 * 为什么不在 ACK 处立刻断：这段只要几百毫秒，顺带能确认流里没有 `error_code`；
 * 又不像视频通道那样需要为「长任务心跳」留 60 秒 drain 窗口 ——
 * 普通对话的回复内容我们**不需要**，探测只看「这次提问有没有被受理」。
 */
const PROBE_POST_ACK_CHARS = 4096;

/**
 * 同一账号同一时刻只允许一次纯协议探测。
 *
 * 浏览器通道靠 `account-browser-lock` 串行；纯协议不吃浏览器资源，
 * 但同一个号并发发两条「你好」既没意义、也更像异常流量，所以自己也串一下。
 */
const PURE_PROBE_LOCKS = new Set();

/**
 * 读 SSE 回执直到「拿到 conversation_id」或「流结束 / 超时 / 收满上限」。
 *
 * ⚠️ 判 conversation_id 必须在**累积文本**上做：SSE 分块，
 * `"conversation_id":"…"` 完全可能被切在两个 chunk 里。
 * 这也正是 chat-bridge（已实测拿到助手回复）的做法，口径保持一致。
 */
async function readProbeReceipt(reader, { deadline } = {}) {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let conversationId = null;
  let questionId = null;
  let timedOut = false;
  for (;;) {
    if (Date.now() > deadline) { timedOut = true; break; }
    if (text.length >= PROBE_MAX_RECEIPT_CHARS) break;
    let chunk;
    try {
      chunk = await reader.read(); // eslint-disable-line no-await-in-loop
    } catch {
      break; // 流被掐断：已收到的部分仍可判读
    }
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (!conversationId) {
      conversationId = PROBE_CONVERSATION_ID_RE.exec(text)?.[1] || null;
      questionId = PROBE_QUESTION_ID_RE.exec(text)?.[1] || null;
    }
    if (conversationId && text.length >= PROBE_POST_ACK_CHARS) break;
  }
  return { text, conversationId, questionId, timedOut };
}

/** 回执里出现过的 `error_code`（去重）。 */
function errorCodesIn(text) {
  return [...new Set([...String(text || '').matchAll(PROBE_ERROR_CODE_RE)].map((m) => Number(m[1])))];
}

/**
 * 把一次探测的回执判定成 `{ state, message, … }`。**纯函数**，可单测（见 `test/hello-probe-pure.mjs`）。
 *
 * 判定顺序就是优先级，不能随意调换：
 *   ① HTTP 401/403                    → `unavailable`
 *   ② 会话失效码 710012001/710012014  → `unavailable`
 *   ③ 拿到 `conversation_id`          → `available`
 *   ④ 其余一切                        → `unknown`（限流 / 地区受限 / 出口异常 / 超时）
 *
 * ⚠️ **未知一律 unknown，绝不当 unavailable**：调用方会按 `unavailable` 把账号置为
 *    `invalid`（等于断定这个号废了）。限流、出口抖动、地区受限都可能只是"这一次不行"。
 *
 * ⚠️ **「地区受限」必须留 unknown**：`710022003`（"您所在的国家/地区不可用"）是
 *    **出口地区**被上游拒绝，账号 cookie 往往是好的（换个出口就能用）。判它 unavailable
 *    就是误杀。这里只把原因写进 message，让排障一眼看到。
 *
 * ★ 与旧浏览器通道的口径差异（本次改造顺带修掉的一个误判）：
 *   旧通道只看 **HTTP 状态**，于是 `{"code":710022003,"message":"您所在的国家/地区不可用。"}`
 *   这种「HTTP 200 + body 里的错误」会被它判成 `available` —— 把地区受限的号
 *   标成"可用"。本函数要求真正的 `conversation_id` 才算通过。
 *
 * @param {object} input
 * @param {number} [input.status]   HTTP 状态码
 * @param {string} [input.text]     SSE / JSON 回执原文
 * @param {boolean} [input.timedOut] 是否读满预算仍没有 conversation_id
 * @param {number} [input.ms]       本次探测耗时（仅用于文案）
 * @param {number} [input.budgetMs] 读回执预算（仅用于文案）
 */
export function classifyHelloProbeReceipt({ status = 0, text = '', timedOut = false, ms = 0, budgetMs = 0 } = {}) {
  const raw = String(text || '');
  const errorCodes = errorCodesIn(raw);
  const conversationId = PROBE_CONVERSATION_ID_RE.exec(raw)?.[1] || null;
  const questionId = PROBE_QUESTION_ID_RE.exec(raw)?.[1] || null;
  // 上游的地区封禁有两种形状：SSE 里的 `error_code: 710022003`，或裸 JSON 的 `"code":710022003`。
  const countryRestricted = /710022003/.test(raw) || /country restricted|国家\/地区不可用/i.test(raw);
  const base = { conversationId, questionId, errorCodes, countryRestricted };

  if (status === 401 || status === 403) {
    return { ...base, state: 'unavailable', message: `上游拒绝账号会话（HTTP ${status}）` };
  }
  const expired = errorCodes.filter((c) => SESSION_EXPIRED_CODES.includes(c));
  if (expired.length) {
    return { ...base, state: 'unavailable', message: `上游明确返回登录会话失效（${expired.join(',')}）` };
  }
  if (conversationId) {
    return {
      ...base,
      state: 'available',
      message: `已通过纯协议发送“你好”，普通聊天接口已接受请求（conversation ${conversationId}`
        + `${questionId ? `，question ${questionId}` : ''}，${ms}ms）`,
    };
  }

  // 走到这里 ⇒ unknown。把"为什么"写清楚，否则只能看到一句"回执 138B"。
  const size = `${raw.length}B`;
  const detail = errorCodes.length ? `，error_code ${errorCodes.join(',')}` : '';
  let reason;
  if (countryRestricted) reason = '上游判定该出口地区不可用（710022003 country restricted）';
  else if (timedOut) reason = `发送后 ${Math.round(Number(budgetMs || 0) / 1000)}s 内未收到会话回执（回执 ${size}${detail}）`;
  else reason = `上游未受理这次普通对话（HTTP ${status}，回执 ${size}${detail}）`;
  return { ...base, state: 'unknown', message: `${reason}，不判定账号失效` };
}

/**
 * 纯协议发送「你好」—— **完全不开浏览器**。
 *
 * 链路：造普通对话 body → Node 侧算 a_bogus → 用账号代理 POST
 *       `https://www.dola.com/chat/completion` → 读 SSE 判有没有 `conversation_id`。
 *
 * 判定口径（与浏览器通道一致，**不能漂**：调用方会按 state 决定是否把账号置 invalid）：
 *   `available`   ← 拿到 conversation_id（上游已受理）
 *   `unavailable` ← 上游**明确**说会话失效（710012001/710012014 或 HTTP 401/403）
 *   `unknown`     ← 其余一切（限流 710022002、出口异常、网络错、超时）—— **不判失效**
 *
 * @param {object} cookies 账号 cookie（`{name: value}`，与浏览器通道同一个入参形状）
 * @param {object} [options]
 * @param {number|null} [options.accountId] 仅用于加锁与日志
 * @param {string|null} [options.proxyUrl]  账号代理 URL（**必填**：不直连）
 * @param {number} [options.timeout]        读回执预算，默认 45s
 * @param {string} [options.botId]          **仅供零副作用自检**：填一个无效 bot_id 让上游在
 *   「创建会话」之前把请求挡回来，于是能在不留下聊天记录的前提下验证
 *   「签名 → 发送 → 回执解析」整条链路。生产调用**不要传**（与 pure-http.js 同一约定）。
 */
export async function sendHelloProbeViaPureHttp(cookies, {
  accountId = null,
  proxyUrl = null,
  timeout = 45_000,
  botId = undefined,
  log = () => {},
} = {}) {
  if (!proxyUrl) return { state: 'unknown', message: '账号没有已配置的代理，未发送' };
  const cookie = cookieHeaderOf(cookies);
  if (!cookie) return { state: 'unavailable', message: '账号没有可用 Cookie，未发送' };

  // ① 签名器（把厂商 bdms SDK 跑在 Node 沙箱里）。构造失败要在"还没发任何请求"时暴露。
  let signer;
  try {
    signer = abogusSignerFor({ cookie, ua: PURE_HTTP_UA });
  } catch (e) {
    return {
      state: 'unknown',
      message: `a_bogus 签名器不可用，未发送：${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160)}`,
    };
  }

  // ② 造体 → ③ 签名。顺序不可换（a_bogus 绑定 body），签完之后一个字都不改。
  //    普通对话体的权威构造在 chat-bridge（已实测拿到过助手回复）；
  //    这里只做「换探测文本」和「自检用的无效 bot_id」两件事，不复制那份信封。
  const body = buildPlainChatBody(HELLO_TEXT);
  if (botId !== undefined) body.client_meta.bot_id = botId;
  const bodyText = JSON.stringify(body);
  const signed = signer.sign(PURE_HTTP_SUBMIT_URL, bodyText);

  const lockKey = String(accountId ?? 'anon');
  if (PURE_PROBE_LOCKS.has(lockKey)) {
    return { state: 'unknown', message: '该账号已有一次纯协议探测在进行，未发送' };
  }
  PURE_PROBE_LOCKS.add(lockKey);

  const budget = Math.max(10_000, Number(timeout) || 45_000);
  const deadline = Date.now() + budget;
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`上游回执超时 ${budget}ms`)), budget);
  timer.unref?.();

  try {
    log(`纯协议探测：账号 #${lockKey} 发送“你好”`);
    let res;
    try {
      res = await fetchVia(signed.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Agw-Js-Conv': 'str',
          origin: DOLA_ORIGIN,
          referer: `${DOLA_ORIGIN}/chat/`,
          'user-agent': PURE_HTTP_UA,
          cookie,
          accept: 'text/event-stream, application/json, text/plain, */*',
        },
        body: bodyText,
        signal: ctrl.signal,
        redirect: 'follow',
      }, proxyUrl);
    } catch (error) {
      // 请求压根没出去（DNS/代理/连接超时）：这里是**真的没发出**，
      // 文案必须与"发出去了但没收到回执"分开，否则排障时会以为消息已留在会话里。
      return {
        state: 'unknown',
        message: `纯协议发送失败（请求未完成），未发送：${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)}`,
      };
    }

    const { text, timedOut } = await readProbeReceipt(res.body.getReader(), { deadline });
    const ms = Date.now() - startedAt;
    // 判定收在纯函数 `classifyHelloProbeReceipt` 里（可单测）；这里只补排障证据字段：
    // `httpStatus / errorCodes / ms` + 一小段回执原文 —— 只写进任务日志与自检输出
    // （调用方 `routes/dola.js` 只取 state + message 落库），但少了它们就只能靠猜。
    return {
      ...classifyHelloProbeReceipt({ status: res.status, text, timedOut, ms, budgetMs: budget }),
      httpStatus: res.status,
      ms,
      receipt: text.replace(/\s+/g, ' ').slice(0, 200),
    };
  } catch (error) {
    return { state: 'unknown', message: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240) };
  } finally {
    clearTimeout(timer);
    // 流可能还挂着（ACK 之后上游继续推正文）：探测不需要正文，直接断。
    if (!ctrl.signal.aborted) ctrl.abort(new Error('probe_settled'));
    PURE_PROBE_LOCKS.delete(lockKey);
  }
}

/**
 * 「你好」探测统一入口。默认走纯协议，只有显式传 `mode: 'browser'` 才开浏览器。
 *
 * ★ 刻意**不做静默回落**：纯协议失败就如实返回 unknown + 原因，不会偷偷再开一次
 *   浏览器。理由与 `chooseSubmitMode` 一致 —— 静默回落会让「这次为什么慢」
 *   变得无法解释，也让判定口径在两条通道之间来回跳（那是误杀账号的温床）。
 *   真要用浏览器通道，把设置项 `dola_hello_probe_mode` 改成 `browser` 即可。
 */
export async function sendHelloProbe(cookies, { mode = 'pure-http', ...options } = {}) {
  const channel = resolveHelloProbeMode(mode);
  const result = channel === 'browser'
    ? await sendHelloProbeViaBrowser(cookies, options)
    : await sendHelloProbeViaPureHttp(cookies, options);
  return { ...result, channel };
}

// ═══════════════════════════════════════════════ 浏览器通道（回退）

function isEditableComposerElement(element) {
  return Boolean(element && (
    element.tagName === 'TEXTAREA'
    || element.tagName === 'INPUT'
    || element.isContentEditable
    || element.getAttribute('contenteditable') === 'true'
    || element.getAttribute('role') === 'textbox'
  ));
}

/**
 * Pick one visible editor without treating a wrapper and its editable child
 * as two editors. The returned locator is re-used for fill/type operations so
 * a later DOM count cannot accidentally select a different field.
 */
async function findVisibleComposer(page) {
  let visibleCount = 0;
  for (const selector of COMPOSER_SELECTORS) {
    const candidate = page.locator(selector).filter({ visible: true });
    const count = await candidate.count().catch(() => 0);
    visibleCount = Math.max(visibleCount, count);
    if (count !== 1) continue;
    const editable = await candidate.first().evaluate(isEditableComposerElement).catch(() => false);
    if (editable) return { locator: candidate.first(), selector, count: 1 };
  }

  // Keep the count useful in failure diagnostics. This is deliberately not
  // used for sending because it may include a role wrapper or another tool's
  // text field.
  const broad = page.locator(INPUT_SELECTOR).filter({ visible: true });
  const broadCount = await broad.count().catch(() => 0);
  return { locator: null, selector: '', count: Math.max(visibleCount, broadCount) };
}

async function waitForVisibleComposer(page, timeout) {
  const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
  let snapshot = await findVisibleComposer(page);
  while (!snapshot.locator && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now()))).catch(() => {});
    snapshot = await findVisibleComposer(page);
  }
  return snapshot;
}

async function findVisibleSendButton(page) {
  for (const selector of SEND_SELECTORS) {
    const candidate = page.locator(selector).filter({ visible: true });
    const count = await candidate.count().catch(() => 0);
    if (count === 1) return { locator: candidate.first(), selector, count: 1 };
  }
  const broad = page.locator(SEND_SELECTOR).filter({ visible: true });
  return { locator: null, selector: '', count: await broad.count().catch(() => 0) };
}

async function waitForVisibleSendButton(page, timeout) {
  const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
  let snapshot = await findVisibleSendButton(page);
  while (!snapshot.locator && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now()))).catch(() => {});
    snapshot = await findVisibleSendButton(page);
  }
  return snapshot;
}

function pageLoginPrompt(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const match = text.match(/(?:请先登录|登录后(?:使用|继续|开始)|登录已过期|登录状态已失效|重新登录)/i);
  return match ? match[0] : '';
}

function compactFailureDetails({ pathname = '', loginPrompt = '', resourceFailures = 0, consoleErrors = 0 } = {}) {
  const details = [];
  if (pathname) details.push(`url=${pathname}`);
  if (loginPrompt) details.push(`页面提示=${loginPrompt}`);
  if (resourceFailures) details.push(`资源失败=${resourceFailures}`);
  if (consoleErrors) details.push(`页面错误=${consoleErrors}`);
  return details.length ? `（${details.join('；')}）` : '';
}

function normalizeComposerText(value) {
  return String(value ?? '').replace(/\u200b/g, '').replace(/\r\n/g, '\n').trim();
}

async function readComposerText(input) {
  return input.evaluate((element) => {
    if ('value' in element && typeof element.value === 'string') return element.value;
    return element.innerText || element.textContent || '';
  }).catch(() => '');
}

async function selectAllComposer(page) {
  const modifier = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
  await page.keyboard.press(modifier).catch(() => {});
}

/**
 * Fill a normal text composer without relying on fill() for tiptap.  Dola's
 * ProseMirror editor can update its DOM when filled while skipping the editor
 * transaction that enables the send button; real keyboard input does not.
 */
async function fillHelloComposer(page, input) {
  const isContentEditable = await input.evaluate((element) => (
    element.getAttribute('contenteditable') === 'true' || element.isContentEditable
  )).catch(() => false);

  if (isContentEditable) {
    await input.click({ timeout: 10_000 });
    await selectAllComposer(page);
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(HELLO_TEXT, { delay: 35 });
  } else {
    await input.fill(HELLO_TEXT, { timeout: 10_000 }).catch(() => {});
  }

  let typed = normalizeComposerText(await readComposerText(input));
  // A remounted textarea or a non-standard role=textbox can still ignore
  // fill(). Retry once through the focused keyboard path, but never send until
  // the exact probe text is observable in the current element.
  if (typed !== HELLO_TEXT) {
    await input.click({ timeout: 5_000 });
    await selectAllComposer(page);
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(HELLO_TEXT, { delay: 35 });
    typed = normalizeComposerText(await readComposerText(input));
  }
  return typed;
}

function bodyHasModePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 * 1024) return true;
  let value;
  try { value = JSON.parse(raw); } catch { return true; }
  let visited = 0;
  const visit = (item, depth = 0) => {
    if (++visited > 4096 || depth > 10) return true;
    if (typeof item === 'string') {
      const text = item.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try { return visit(JSON.parse(text), depth + 1); } catch { return false; }
      }
      return false;
    }
    if (!item || typeof item !== 'object') return false;
    for (const [key, child] of Object.entries(item)) {
      if (/ability|video|image.?mode|generation.?mode/i.test(key)) return true;
      if (visit(child, depth + 1)) return true;
    }
    return false;
  };
  return visit(value);
}

function chatPath(url) {
  if (url.pathname === '/chat/completion') return true;
  return /^\/chat\/local_[A-Za-z0-9_-]+$/.test(url.pathname);
}

function isKnownChatTelemetry(raw) {
  try {
    const body = JSON.parse(raw);
    return body?.ev_type === 'batch' && Array.isArray(body.list);
  } catch { return false; }
}

function bodyHasHelloText(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 * 1024) return false;
  let root;
  try { root = JSON.parse(raw); } catch { return false; }
  let visited = 0;
  const visit = (item, depth = 0) => {
    if (++visited > 4096 || depth > 10 || item == null) return false;
    if (typeof item === 'string') {
      if (item.trim() === '你好') return true;
      if (item.startsWith('{') || item.startsWith('[')) {
        try { return visit(JSON.parse(item), depth + 1); } catch { return false; }
      }
      return false;
    }
    if (typeof item !== 'object') return false;
    return Object.values(item).some(child => visit(child, depth + 1));
  };
  return visit(root);
}

/**
 * Explicit, one-shot text-chat probe. It uses the normal Dola chat page and
 * sends exactly “你好”. Video/image-mode requests and repeated sends are
 * blocked before they leave the account browser.
 *
 * ★ 2026-09-28 起这是**回退通道**：默认入口 `sendHelloProbe()` 走纯协议
 *   （`sendHelloProbeViaPureHttp`，不开浏览器）。保留本实现用于
 *   ① 纯协议被上游针对时应急切换（设置项 `dola_hello_probe_mode=browser`）；
 *   ② 纯协议拿不到 ACK 时的对照实验（页面能过 = 签名/body 有问题；
 *      页面也过不了 = 账号或出口有问题）。
 *   不要再往这里加新的探测能力 —— 默认通道在纯协议那边。
 */
export async function sendHelloProbeViaBrowser(cookies, {
  accountId,
  proxy = null,
  proxyUrl = null,
  timeout = 75_000,
} = {}) {
  const pw = await getPlaywright();
  if (!pw?.chromium) return { state: 'unknown', message: 'Playwright 不可用，未发送' };
  if (!proxyUrl) return { state: 'unknown', message: '账号没有已配置的代理，未发送' };
  const cookieList = toPlaywrightCookies(cookies);
  if (!cookieList.length) return { state: 'unavailable', message: '账号没有可用 Cookie，未发送' };

  const launchOptions = {
    executablePath: pw.chromium.executablePath(),
    headless: true,
    timeout: Math.min(timeout, 30_000),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  let bridge = null;
  let context = null;
  let browser = null;
  const releaseAccountBrowserLock = tryAcquireAccountBrowserLock(accountId);
  if (!releaseAccountBrowserLock) return { state: 'unknown', message: '该账号浏览器正忙，未发送' };
  let armed = false;
  let blockedReason = '';
  let localMessageRequests = 0;
  let completionRequests = 0;
  let page = null;
  const responses = [];
  const failedRequests = [];

  try {
    if (/^socks5h?:/i.test(proxyUrl)) {
      bridge = await startSocksBridge(proxyUrl);
      launchOptions.proxy = { server: bridge.url };
    } else if (proxy?.server) {
      launchOptions.proxy = proxy;
    } else {
      return { state: 'unknown', message: '账号代理无法用于浏览器，未发送' };
    }

    const contextOptions = {
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      userAgent: DOLA_HEADERS['user-agent'],
    };
    if (accountId) {
      const profileDir = join(PROFILE_ROOT, String(accountId));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(profileDir, { recursive: true });
      const launchPersistent = () => pw.chromium.launchPersistentContext(profileDir, {
        ...launchOptions, ...contextOptions,
      });
      context = await launchPersistent();
    } else {
      browser = await pw.chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }

    await context.route('**/passport/**/logout**', route => route.abort());
    await context.route('**/chat/**', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      let url;
      try { url = new URL(request.url()); } catch {
        blockedReason = '聊天请求地址异常，已拦截';
        return route.abort();
      }
      if (url.origin !== DOLA_ORIGIN) {
        blockedReason = '检测到跨站聊天写请求，已拦截';
        return route.abort();
      }
      if (url.pathname === '/chat/') {
        if (isKnownChatTelemetry(request.postData() || '')) return route.continue();
        blockedReason = '检测到非预期的 /chat/ 写请求，已拦截';
        return route.abort();
      }
      if (url.pathname === '/chat/create-image') {
        blockedReason = '检测到图片生成请求，已拦截';
        return route.abort();
      }
      if (!armed) {
        if (url.pathname === '/chat/completion' || /^\/chat\/local_/.test(url.pathname)) {
          blockedReason = '发送前出现聊天提交请求，已拦截';
          return route.abort();
        }
        blockedReason = '发送前出现非预期聊天写请求，已拦截';
        return route.abort();
      }
      if (!chatPath(url)) {
        blockedReason = '请求路径不属于普通文本聊天，已拦截';
        return route.abort();
      }
      if (bodyHasModePayload(request.postData() || '')) {
        blockedReason = '请求包含模式/生成参数，已拦截以避免提交生成任务';
        return route.abort();
      }
      if (url.pathname === '/chat/completion' && !bodyHasHelloText(request.postData() || '')) {
        blockedReason = '普通聊天请求中未确认探测文本为“你好”，已拦截';
        return route.abort();
      }
      if (url.pathname.startsWith('/chat/local_')) {
        if (++localMessageRequests > 1) {
          blockedReason = '检测到重复发送，已拦截后续请求';
          return route.abort();
        }
      } else if (++completionRequests > 1) {
        blockedReason = '检测到重复聊天提交，已拦截后续请求';
        return route.abort();
      }
      return route.continue();
    });

    if (cookieList.length) await context.addCookies(cookieList);
    page = await context.newPage();
    page.on('response', async response => {
      if (response.request().method() !== 'POST') return;
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (url.origin !== DOLA_ORIGIN || !chatPath(url)) return;
      const body = await response.text().catch(() => '');
      responses.push({
        path: url.pathname,
        status: response.status(),
        expired: /710012001|710012014/.test(body),
        upstreamError: /STREAM_ERROR|"error_code"\s*:\s*[1-9]\d*/i.test(body),
        rateLimited: /710022002/.test(body),
      });
    });
    page.on('requestfailed', request => {
      if (request.method() !== 'POST') return;
      let url;
      try { url = new URL(request.url()); } catch { return; }
      if (url.origin === DOLA_ORIGIN && chatPath(url)) failedRequests.push(request.failure()?.errorText || '聊天请求失败');
    });

    // One absolute budget covers navigation, composer hydration, the send
    // button and the response observation. Per-stage timers used to reset and
    // let a slow proxy spend an extra full timeout before being classified.
    const probeDeadline = Date.now() + Math.max(15_000, Number(timeout) || 75_000);
    const remainingMs = () => Math.max(1, probeDeadline - Date.now());

    await page.goto(`${DOLA_BASE.replace(/\/$/, '')}/chat/`, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(remainingMs(), 45_000),
    });
    await page.waitForLoadState('networkidle', { timeout: Math.min(5000, remainingMs()) }).catch(() => {});
    if (blockedReason) return { state: 'unknown', message: `${blockedReason}，未发送探测消息` };
    // ★ 先等输入框出现，再确认「唯一」。慢代理下渲染可达 20s+（见 INPUT_WAIT_MS 注释），
    //   直接 count() 会把「还没渲染出来」误判成「没有普通聊天输入框」。
    const input = page.locator(INPUT_SELECTOR).filter({ visible: true });
    const inputWaitMs = Math.min(INPUT_WAIT_MS, remainingMs());
    await page.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: inputWaitMs }).catch(() => {});
    const inputCount = await input.count().catch(() => 0);
    if (inputCount !== 1) {
      const pathname = new URL(page.url()).pathname;
      const loginPage = /^\/(?:login|passport)(?:\/|$)/.test(pathname);
      return {
        state: loginPage ? 'unavailable' : 'unknown',
        message: loginPage
          ? '跳转到登录页，账号登录态不可用'
          : (inputCount === 0
            ? `等待 ${Math.round(inputWaitMs / 1000)}s 仍未出现普通聊天输入框，未发送`
            : `页面出现 ${inputCount} 个输入框，无法确认唯一普通聊天输入框，未发送`),
      };
    }
    const placeholder = await input.first().getAttribute('placeholder').catch(() => '') || '';
    if (/视频|图像|图片生成|生成视频/i.test(placeholder)) {
      return { state: 'unknown', message: '页面当前不是普通聊天输入框，未发送' };
    }
    const videoModeSelected = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')]
      .filter(el => /视频生成/.test(el.innerText || ''))
      .some(el => el.getAttribute('aria-pressed') === 'true'
        || el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('data-state') === 'active'
        || /(?:^|\s)(?:active|selected|is-active)(?:\s|$)/i.test(String(el.className || ''))));
    if (videoModeSelected) return { state: 'unknown', message: '页面处于视频生成模式，未发送' };

    const typed = await fillHelloComposer(page, input.first());
    if (typed !== HELLO_TEXT) return { state: 'unknown', message: '未能确认探测文本已完整填写，未发送' };
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // 发送按钮要等输入内容触发状态更新后才会 enabled；同时检查
    // aria/data 状态，避免把视觉上可见但仍在加载的按钮当成可发送。
    const send = page.locator(SEND_SELECTOR).filter({ visible: true });
    const sendWaitMs = Math.min(SEND_WAIT_MS, remainingMs());
    await page.waitForFunction(selector => {
      const nodes = [...document.querySelectorAll(selector)].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1
          && style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0.01;
      });
      if (nodes.length !== 1) return false;
      const element = nodes[0];
      const dataDisabled = element.getAttribute('data-disabled');
      return !element.disabled
        && element.getAttribute('aria-disabled') !== 'true'
        && (dataDisabled === null || dataDisabled === 'false')
        && element.getAttribute('data-loading') !== 'true';
    }, SEND_SELECTOR, { timeout: sendWaitMs }).catch(() => {});
    const sendCount = await send.count().catch(() => 0);
    const dataDisabled = sendCount === 1 ? await send.getAttribute('data-disabled').catch(() => null) : null;
    const sendReady = sendCount === 1
      && await send.isEnabled().catch(() => false)
      && await send.getAttribute('aria-disabled').catch(() => null) !== 'true'
      && (dataDisabled === null || dataDisabled === 'false')
      && await send.getAttribute('data-loading').catch(() => null) !== 'true';
    if (!sendReady) {
      return { state: 'unknown', message: '普通聊天发送按钮未就绪，未发送' };
    }

    const clickTimeout = Math.min(10_000, remainingMs());
    armed = true;
    await send.click({ timeout: clickTimeout }).catch(() => {
      throw new Error('发送结果不确定；为避免重复消息，不会自动重试');
    });
    const until = probeDeadline;
    while (Date.now() < until) {
      if (blockedReason) return { state: 'unknown', message: blockedReason };
      if (responses.some(item => item.expired)) return { state: 'unavailable', message: '上游明确返回登录会话失效' };
      if (responses.some(item => item.status === 401 || item.status === 403)) {
        return { state: 'unavailable', message: '上游拒绝账号会话（HTTP 401/403）' };
      }
      if (responses.some(item => item.rateLimited)) return { state: 'unknown', message: '上游聊天限流（710022002），不判定账号失效' };
      const completionResponse = responses.find(item => item.path === '/chat/completion');
      if (completionResponse?.upstreamError) return { state: 'unknown', message: '上游未确认普通聊天回复，不判定账号失效' };
      if (completionResponse && completionResponse.status >= 200 && completionResponse.status < 300) {
        return { state: 'available', message: '已发送“你好”，普通聊天接口已接受请求' };
      }
      if (failedRequests.length) break;
      await page.waitForTimeout(200);
    }
    return {
      state: 'unknown',
      message: blockedReason || (failedRequests[0]
        ? `聊天请求未完成：${failedRequests[0]}`
        : (responses.some(item => item.path.startsWith('/chat/local_') && item.status >= 200 && item.status < 300)
          ? '“你好”已写入会话，但未确认普通聊天回复；不自动重试'
          : '发送后没有收到确定回执；不自动重试')),
    };
  } catch (error) {
    return { state: 'unknown', message: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240) };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    releaseAccountBrowserLock();
  }
}
