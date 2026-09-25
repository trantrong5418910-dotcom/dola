/**
 * 方案A提交通道：abort 取签名 + 页内重放提交。
 *
 * 和默认 browser 通道的区别：
 *   browser 通道：操作页面 UI（选模型/时长、填提示词、点发送），观察 SSE 拿 conversationId。
 *   方案A通道：
 *     ① 页内 fetch 触发一次 /chat/completion，路由拦截捕获带 a_bogus 签名的
 *        完整请求（URL / headers / postData），然后 abort 掉 —— 探测不消耗额度；
 *     ② 用同一浏览器页内 fetch 把捕获到的请求原样重放一次，这才是真正的提交
 *        （同源、同 TLS 指纹，不需要 tls_client 这类外部指纹库）；
 *     ③ 读 SSE 回执拿 conversationId，随后**立刻关浏览器**。
 *   拿回 conversationId 之后，轮询 /im/chain/single、fallback 解析、归档、
 *   计费、任务日志全部复用现有链路（pollSubmittedVideo 等），本模块只替换「提交」这一步。
 *
 * 切换：设置项 dola_submit_mode = browser（默认）| scheme-a。
 * 限制：暂不支持参考图（referenceImagePaths 非空时直接拒绝，请切回 browser）。
 *
 * 关键铁律（与 browser 通道一致）：
 *   - 提交完必须立刻关浏览器（保住会话；风控把每次开浏览器看作换设备登录）。
 *   - 拦掉限流时前端的自毁登出请求（guardLogoutRequests）。
 *   - 代理缺失绝不直连（requireGenerationProxy）。
 */
import { randomUUID } from 'node:crypto';
import { getPlaywright, parseCookies, guardLogoutRequests, DOLA_HEADERS, toPlaywrightCookies } from './provider.js';
import { proxyOf } from './proxy.js';
import { startSocksBridge } from './socks-bridge.js';
import { requireGenerationProxy } from './generation-policy.js';

export const SUBMIT_MODES = Object.freeze(['browser', 'scheme-a']);

/** 设置值 → 合法通道名，非法/缺失一律回退 browser（默认通道永远可用）。 */
export function resolveSubmitMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'scheme-a' ? 'scheme-a' : 'browser';
}

const SCHEME_A_BOT_ID = '7339470689562525703';
const SIGN_RE = /[?&]a_bogus=([^&]*)/;
const INPUT_SEL = 'textarea, [contenteditable="true"]';

/**
 * 构造 /chat/completion 的提交体（ability_type=17，Seedance 视频）。
 * 纯函数，可单测。字段顺序与线上验证过的实现保持一致。
 */
export function buildSchemeARequestBody(prompt, { ratio = '16:9', model = 'seedance_v2.0', duration = 10 } = {}) {
  const text = String(prompt ?? '');
  return {
    client_meta: {
      local_conversation_id: `local_${Date.now()}`,
      conversation_id: '',
      bot_id: SCHEME_A_BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    messages: [{
      local_message_id: randomUUID(),
      content_block: [{
        block_type: 10000,
        content: { text_block: { text }, pc_event_block: '' },
        block_id: randomUUID(),
        parent_id: '',
        meta_info: [],
        append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      sse_recv_event_options: { support_chunk_delta: true },
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
    },
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify({ ratio, model, duration }),
    },
    user_context: [],
    ext: { is_finish: '1' },
  };
}

/** 从 SSE 回执文本里提 conversation_id / question_id / error_code。纯函数，可单测。 */
export function parseSchemeAAck(text) {
  const t = String(text || '');
  const conversationId = /"conversation_id"\s*:\s*"(\d+)"/.exec(t)?.[1] || null;
  const questionId = /"question_id"\s*:\s*"(\d+)"/.exec(t)?.[1] || null;
  const errorCodes = [...t.matchAll(/"error_code"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  return {
    ack: t.includes('SSE_ACK') && Boolean(conversationId),
    conversationId,
    questionId,
    errorCodes,
  };
}

/** 同一账号同一时刻只允许一个方案A提交（browser 通道有自己的锁，互不干扰即可） */
const SCHEME_A_LOCKS = new Set();

/**
 * 方案A提交。参数与返回值形状和 submitViaBrowser 对齐，
 * generator.run() 可以直接按通道名二选一调用。
 */
export async function submitViaSchemeA(cookieText, {
  prompt, seconds = 10, forceSeconds = null, targetModel = null, ratio = '16:9',
  proxyUrl, accountId, log = () => {},
  sessionVerified = false, isActive = () => true,
  referenceImagePaths = [],
  onDispatch, onConversation,
}) {
  proxyUrl = requireGenerationProxy(proxyUrl);
  if (!sessionVerified) throw new Error('未确认实时有效登录，拒绝提交');
  if (!isActive()) throw new Error('generation_cancelled');
  if (typeof onDispatch !== 'function' || typeof onConversation !== 'function') throw new Error('submission_journal_required');
  if (referenceImagePaths?.length) {
    throw Object.assign(
      new Error('方案A通道暂不支持参考图，请把 dola_submit_mode 切回 browser'),
      { code: 'SCHEME_A_NO_REFERENCE_IMAGES' },
    );
  }

  const duration = Number(forceSeconds ?? seconds ?? 10);
  const model = targetModel || (duration >= 20 ? 'seedance_v2.5' : 'seedance_v2.0');
  const pw = await getPlaywright();
  if (!pw?.chromium) throw new Error('playwright 未安装：npm i playwright && npx playwright install chromium');
  const ck = parseCookies(cookieText);

  const lockKey = String(accountId ?? 'anon');
  if (SCHEME_A_LOCKS.has(lockKey)) throw new Error(`账号 #${lockKey} 已有一个方案A提交在跑，跳过本次`);
  SCHEME_A_LOCKS.add(lockKey);

  // ⚠️ 必须在 try **外面**声明：finally 里要关它。
  let bridge = null;
  let browser = null;
  let ctx = null;
  try {
    // 代理：与 browser 通道一致 —— Chromium 不支持带认证的 SOCKS5，
    // 上游只认 SOCKS5 时架本地无认证 HTTP 桥，认证在桥里完成。
    let launchProxy;
    if (proxyUrl) {
      const scheme = (() => { try { return new URL(proxyUrl).protocol; } catch { return ''; } })();
      if (/^socks5?h?:$/.test(scheme)) {
        bridge = await startSocksBridge(proxyUrl);
        launchProxy = { server: bridge.url };
        log(`方案A：已架本地 SOCKS5 桥 ${bridge.url} → 上游带认证`);
      } else {
        launchProxy = proxyOf(proxyUrl);
      }
    }
    if (!launchProxy?.server) throw new Error('generation_proxy_required');
    if (!isActive()) throw new Error('generation_cancelled');

    // 临时 context 即可：方案A不需要持久化缓存（只开一次、取完签名就关）。
    // 省掉 profile 磁盘占用，也避开 SingletonLock 那一类坑。
    browser = await pw.chromium.launch({
      headless: true,
      executablePath: pw.chromium.executablePath(),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      proxy: launchProxy,
    });
    ctx = await browser.newContext({
      userAgent: DOLA_HEADERS['user-agent'],
      viewport: { width: 1400, height: 900 },
      locale: 'zh-CN',
    });

    // 保住会话：拦掉限流时前端的自毁登出（与 browser 通道同一招）。
    await guardLogoutRequests(ctx);

    // ★ 捕获 /chat/completion：只收「带有效 a_bogus 且确为视频提交体」的 POST，
    //   收完立刻 abort（探测不消耗额度）。其余请求一律放行。
    // 捕获阶段只保存请求，不做任何落库：真正的「提交意图落库」(onDispatch)
    // 必须发生在重放之前、且成功后才允许重放，避免「日志说已提交、实际没发出」。
    let cap = null;
    await ctx.route('**/chat/completion**', async (route) => {
      const req = route.request();
      if (!cap && req.method() === 'POST') {
        const m = SIGN_RE.exec(req.url());
        const postData = req.postData() || '';
        if (m?.[1]?.length > 50 && postData.includes('"ability_type":17')) {
          cap = { url: req.url(), headers: { ...req.headers() }, postData };
          await route.abort();
          return;
        }
      }
      await route.continue();
    });

    // 同 generator.js：`__Host-` / `__Secure-` 前缀必须按 RFC 6265bis 分流，
    // 不能用 `{ domain, path }` 一刀切，否则 addCookies 抛 Invalid cookie fields。
    await ctx.addCookies(toPlaywrightCookies(ck));

    const page = await ctx.newPage();
    log('方案A：打开 dola /chat/ 取签名');
    await page.goto('https://www.dola.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // 等输入框出现 = 已登录创作页（显式等待，快慢网络自适应，不按秒数猜）。
    const hasComposer = await page.waitForSelector(INPUT_SEL, { timeout: 60000 }).then(() => true).catch(() => false);
    if (!hasComposer) throw new Error('未确认已登录的创作页面（输入框未出现）');
    if (!isActive()) throw new Error('generation_cancelled');
    await page.waitForTimeout(1500);

    // ① 页内 fetch 触发提交请求 → 被路由捕获并 abort（只为拿签名，不消耗额度）。
    //    fetch 跑在页面上下文里，站点自身的签名逻辑会给请求加上 a_bogus。
    const body = buildSchemeARequestBody(prompt, { ratio, model, duration });
    log(`方案A：触发签名请求（model=${model} duration=${duration}s ratio=${ratio}）`);
    await page.evaluate(async (b) => {
      try {
        await fetch('/chat/completion?version_code=20800&language=zh&aid=495671', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
        });
      } catch { /* 被 abort 是预期的 */ }
    }, body);

    const t0 = Date.now();
    while (!cap && Date.now() - t0 < 20000) {
      if (!isActive()) throw new Error('generation_cancelled');
      await page.waitForTimeout(500);
    }
    if (!cap) throw new Error('方案A：20 秒内未能捕获带 a_bogus 签名的提交请求');
    const abLen = (SIGN_RE.exec(cap.url)?.[1] || '').length;
    log(`方案A：已捕获签名请求（a_bogus 长 ${abLen}），原请求已 abort，未消耗额度`);

    // ② 同页重放真正的提交（同源、同 TLS 指纹），读 SSE 回执。
    //    Cookie 等禁用头由浏览器按 credentials:'include' 自动带 —— 与捕获到的请求一致。
    if (!isActive()) throw new Error('generation_cancelled');
    // ★ 提交意图落库：必须在重放之前、成功后才允许重放。
    //   落库失败 = 禁止重放，避免「日志说已提交、实际没发出」的不一致。
    try {
      onDispatch(cap.postData);
    } catch (e) {
      throw new Error(`提交意图落库失败，已阻止重放：${e.message || e}`);
    }
    log('方案A：重放提交并等待上游回执');
    let ackText = '';
    try {
      ackText = await page.evaluate(async ({ url, bodyText, headers }) => {
        const skip = new Set(['cookie', 'cookie2', 'referer', 'origin', 'content-length',
          'connection', 'accept-encoding', 'transfer-encoding', 'host']);
        const out = {};
        for (const [k, v] of Object.entries(headers || {})) {
          if (skip.has(k.toLowerCase())) continue;
          out[k] = v;
        }
        out['content-type'] = 'application/json';
        const res = await fetch(url, { method: 'POST', credentials: 'include', headers: out, body: bodyText });
        return await res.text();
      }, { url: cap.url, bodyText: cap.postData, headers: cap.headers });
    } catch (e) {
      throw new Error(`方案A重放提交失败：${e.message || e}`);
    }

    const parsed = parseSchemeAAck(ackText);
    const streamErrors = parsed.errorCodes.map((code) => ({ code }));
    const loggedOut = /from_logout/.test(page.url());
    if (parsed.ack && parsed.conversationId) {
      log(`方案A：✅ SSE_ACK conversationId=${parsed.conversationId} questionId=${parsed.questionId || '?'}`);
      let persisted = true;
      try {
        persisted = onConversation(parsed.conversationId, 'sse_ack');
      } catch {
        persisted = false;
      }
      if (persisted === false && isActive()) {
        return {
          conversationId: null, cap: null, pageText: '', streamErrors, loggedOut,
          submissionBlocked: false, wire: { forwarded: 1, blocked: 0, mode: 'scheme-a' },
          ack: { ackMatched: false }, submissionOutcome: { error: 'receipt_persistence_failed' },
        };
      }
      return {
        conversationId: parsed.conversationId, cap: null, pageText: '', streamErrors, loggedOut,
        submissionBlocked: false, wire: { forwarded: 1, blocked: 0, mode: 'scheme-a' },
        ack: { ackMatched: true, conversationId: parsed.conversationId },
        submissionOutcome: { error: null },
      };
    }
    log(`方案A：未收到有效 ACK（回执 ${ackText.length}B${streamErrors.length ? `，error_code=${streamErrors.map((e) => e.code).join(',')}` : ''}）`);
    return {
      conversationId: null, cap: null, pageText: ackText.slice(0, 500), streamErrors, loggedOut,
      submissionBlocked: false, wire: { forwarded: 1, blocked: 0, mode: 'scheme-a' },
      ack: { ackMatched: false }, submissionOutcome: { error: null },
    };
  } finally {
    // ★ 无论成败立刻关浏览器 —— 保住会话（与 browser 通道同一铁律）。
    //   ctx.close() 只关上下文，browser.close() 才会杀掉 Chromium 进程。
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    SCHEME_A_LOCKS.delete(lockKey);
  }
}
