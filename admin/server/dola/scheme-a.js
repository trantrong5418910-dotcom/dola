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
 * 切换：设置项 dola_submit_mode = browser（默认）| scheme-a | pure-http。
 *   · pure-http 是同族的第三条通道（不开浏览器、Node 自算签名），实现见 dola/pure-http.js；
 *     它复用本模块的 buildSchemeARequestBody / parseSchemeAAck，所以两者放在一起看。
 *
 * ★ 2026-09-27：**参考图不再回落 browser**。参考图改走纯协议上传
 *   （`dola/reference-upload.js` 四跳，实测 7.6~10.4 秒），拿到 uri 后再拼进 body 一起签名。
 *   两条通道都在"造 body 之前"先上传 —— **顺序不能颠倒**：a_bogus 绑定 body，
 *   body 里必须已经是最终 uri。契约见 RECON-2026-09-27-纯协议参考图上传-契约.md。
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
import { uploadReferenceImages } from './reference-upload.js';
import { parseSubmissionReceipt } from './submission-receipt.js';
import { DEFAULT_VIDEO_SECONDS, requireGenerationProxy } from './generation-policy.js';

export const SUBMIT_MODES = Object.freeze(['browser', 'scheme-a', 'pure-http']);

/** 设置值 → 合法通道名，非法/缺失一律回退 browser（默认通道永远可用）。 */
export function resolveSubmitMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return SUBMIT_MODES.includes(v) ? v : 'browser';
}

/**
 * 通道选择：把「配置值 + 任务特征」映射成「实际用哪个通道」。
 *
 * ★ 2026-09-27：**参考图不再触发回落**。
 *
 * 历史：2026-09-26 时 scheme-a / pure-http 都只发一个 JSON body、没有任何上传链路，
 * 所以带参考图时回落 browser（否则任务 #160/#161 直接判失败，报"请把 dola_submit_mode
 * 切回 browser"）。现在两条通道都有了纯协议上传（`dola/reference-upload.js`），
 * 参考图这个理由不再成立，回落规则收窄成只剩「专家模式」一条。
 *
 * 保留回落的仍然是**实现细节不该让用户承担**这个原则：能自动选对通道就自动选，
 * 但专家模式必须由浏览器真实切换控件，那是服务端会校验的东西，无法用纯协议伪造。
 *
 * 纯函数，便于单测；generator.js 的提交分发直接用它的结果。
 */
export function chooseSubmitMode(configuredValue, {
  hasReferenceImages = false,
  requiresExpertMode = false,
} = {}) {
  const configured = resolveSubmitMode(configuredValue);
  // `hasReferenceImages` 仍接收但**不再影响选择**：留着是为了调用方签名稳定，
  // 也方便以后真要再收紧时不用改调用点。
  void hasReferenceImages;
  if (configured !== 'browser' && requiresExpertMode) {
    return { mode: 'browser', configured, fellBack: true, fallbackReason: 'expert_mode' };
  }
  return { mode: configured, configured, fellBack: false, fallbackReason: null };
}

const SCHEME_A_BOT_ID = '7339470689562525703';
const SIGN_RE = /[?&]a_bogus=([^&]*)/;
const INPUT_SEL = 'textarea, [contenteditable="true"]';

/**
 * 构造 /chat/completion 的提交体（ability_type=17，Seedance 视频）。纯函数，可单测。
 *
 * ★★ 2026-09-26 深夜：本函数已按**页面真实抓包**重写（不再靠推断）。
 *
 * 为什么必须重写（血泪史，改动前必读）
 * ------------------------------------
 *   ① 纯协议通道能拿到 ACK（签名没问题），但服务端把请求执行成了**图片生成** ——
 *      会话里机器人的回复是「已生成 4 张：img_orange_cat_window_00X」，不是视频。
 *   ② 于是按服务端**回显**的 `ability_param` 补齐 `input_box_content` 等字段重发
 *      ⇒ **毫无变化**，仍然 4 张图片（研究文档 §10.8 已实测否证）。
 *   ③ 结论：**回显只是服务端自己的记录，不等于客户端发出的完整字节，不能拿来反推。**
 *   ④ 最终用 `capture-real-video-body.mjs` 走一遍真实 UI（点视频生成 → 选 Seedance 2.5
 *      → 选时长 → 填提示词 → 发送 → route **abort**，零额度）抓到真身，
 *      存于 `server/scripts/fixtures/real-video-body.json`。
 *
 * 与旧版的关键差异（旧版错在哪）
 * ------------------------------
 *   · `text_block.text` 页面发的是 **`生成视频：<提示词>`**（带前缀），旧版发裸提示词 ❌
 *   · `ability_param` 页面发 `{model, duration, input_box_content}`，**没有 `ratio`**，
 *     旧版多塞了一个 `ratio` ❌
 *   · `client_meta.local_permissions` 页面发 **3 条**（COARSE/FINE/BACKGROUND），旧版 1 条 ❌
 *   · `option` 页面发 **~40 个字段**（含 `conversation_init_option` / `aggregate_params` /
 *     `model_config` / `related_deleted_message_ids`…），旧版只有 8 个 ❌
 *   · `ext` 页面发 **6 个字段**，旧版只有 `is_finish` 一个 ❌
 *
 * ⚠️ 关于 `ratio`：真实抓包里**不含**该字段（那次是默认 16:9）。所以本函数保留入参
 *    但**不写入 body** —— 需要 9:16 时怎么传，尚未验证（没抓过 9:16 的真实体）。
 *
 * `botId` 可按需覆盖，**不是给生产用的开关**，只有一个用途：
 * 自检时填一个无效 bot_id（如 '1'），让服务端在「创建任务」之前把请求挡回来
 * （回执 `710022005 系统错误`），于是能在**零额度消耗**的前提下验证整条链路
 * （签名 → 发送 → SSE 解析 → 返回值形状）。见 server/scripts/pure-http-selfcheck.mjs。
 */
export function buildSchemeARequestBody(prompt, {
  ratio = '16:9', model = 'seedance_v2.5', duration = DEFAULT_VIDEO_SECONDS, botId = SCHEME_A_BOT_ID,
  referenceImages = [], abilityRatio = null, uiSeconds = null,
} = {}) {
  // ⚠️ ratio 目前**不写入 body**：真实抓包里没有这个字段（见上方文件头说明）。
  void ratio;
  const raw = String(prompt ?? '');
  // ★ 页面真实体里，输入框内容是「生成视频：<提示词>」而不是裸提示词。
  const refs = Array.isArray(referenceImages) ? referenceImages.filter((r) => r?.uri) : [];
  const hasRefs = refs.length > 0;
  /**
   * ★ 带参考图时，`text_block.text` 多一个「，<秒数>s」后缀。
   *
   * 依据：抓到的带图真实体里是 `生成视频：<提示词>，10s`，而**不带图**的那次抓包
   * （`fixtures/real-video-body.json`）没有后缀。所以后缀是"带图才出现"的行为，
   * 默认取本次要写的 duration，保持 body 自洽（样本里后缀 10s 与 duration:10 也是一致的）。
   */
  const suffixSeconds = Number(uiSeconds ?? duration);
  const text = hasRefs ? `生成视频：${raw}，${suffixSeconds}s` : `生成视频：${raw}`;
  const nowSec = Math.floor(Date.now() / 1000);
  /**
   * ★ 带参考图时 `collect_id` / `collection_id` 才非空（抓包样本里两者同值）。
   * 不带图时保持空串 —— 那条路径已经用真实抓包对过，不要动。
   */
  const collectId = hasRefs ? randomUUID() : '';
  /**
   * ★ `ability_param` 的键序与内容：抓包样本是
   *   `{"ratio":"auto","model":…,"duration":…,"input_box_content":…}`
   * 不带图时**没有** `ratio`。所以只有带图才在最前面插入 `ratio`。
   * 默认 `"auto"` —— 挂了图之后画幅由图片决定，与样本一致。
   */
  const abilityParam = {
    ...(hasRefs ? { ratio: abilityRatio || 'auto' } : {}),
    model,
    duration,
    input_box_content: { user_input_content: raw, reply_message_format: '生成视频：%s' },
  };
  /**
   * ★ 参考图是**独立的一条 message**，排在文本那条**前面**（抓包样本：2 条 messages）。
   * 枚举值：`block_type` 10052 = BLOCK_ATTACHMENT、`type` 1 = AttachmentTypeImage、
   * `parse_state` 0 = ParseStateDefault、`review_state` 1 = ReviewStateAccess、
   * `upload_status` 1 = UploadStatusSuccess、`progress` 100。
   * `image` 对象形状照抄厂商的构造器 `Nq(uri, width, height, name, url)`
   * （见 RECON 文档 §4.2）—— 也是 `generation-wire.js` 校验的那条路径。
   */
  const attachmentMessages = refs.map((ref) => ({
    local_message_id: randomUUID(),
    content_block: [{
      block_type: 10052,
      content: {
        attachment_block: {
          attachments: [{
            type: 1,
            identifier: randomUUID(),
            image: {
              name: String(ref.name || 'reference.png'),
              uri: String(ref.uri),
              image_ori: {
                url: String(ref.url || ''),
                width: Number(ref.width) || 0,
                height: Number(ref.height) || 0,
                format: String(ref.format || 'png'),
                url_formats: {},
              },
            },
            parse_state: 0,
            review_state: 1,
            upload_status: 1,
            progress: 100,
            src: '',
          }],
        },
        pc_event_block: '',
      },
      block_id: randomUUID(),
      parent_id: '',
      meta_info: [],
      append_fields: [],
    }],
    message_status: 0,
  }));
  return {
    client_meta: {
      local_conversation_id: `local_${Date.now()}`,
      conversation_id: '',
      bot_id: botId,
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 3 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 3 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 3 },
      ],
    },
    messages: [...attachmentMessages, {
      local_message_id: randomUUID(),
      content_block: [{
        block_type: 10000,
        content: {
          text_block: { text, icon_url: '', icon_url_dark: '', summary: '' },
          pc_event_block: '',
        },
        block_id: randomUUID(),
        parent_id: '',
        meta_info: [],
        append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      send_message_scene: '',
      create_time_ms: Date.now(),
      collect_id: collectId,
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: 0,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: false,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: nowSec,
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: { model_item_key: '', model_extra_params: {} },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        conversation_mode: '',
        mode_id: '',
        model_item_key: '',
        agent_mode: '',
        reasoning_effort: '',
        provider_id: '',
      },
    },
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify(abilityParam),
    },
    user_context: [],
    ext: {
      answer_with_suggest: '0',
      sub_conv_firstmet_type: '1',
      collection_id: collectId,
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  };
}

/** 只有完整、且与实际发送请求关联的 ACK 才能确立会话。 */
export function parseSchemeAAck(text, bodyText) {
  return parseSubmissionReceipt(text, bodyText);
}

/** 同一账号同一时刻只允许一个方案A提交（browser 通道有自己的锁，互不干扰即可） */
const SCHEME_A_LOCKS = new Set();

/**
 * 方案A提交。参数与返回值形状和 submitViaBrowser 对齐，
 * generator.run() 可以直接按通道名二选一调用。
 */
export async function submitViaSchemeA(cookieText, {
  prompt, seconds = DEFAULT_VIDEO_SECONDS, forceSeconds = null, targetModel = null, ratio = '16:9',
  proxyUrl, accountId, log = () => {},
  sessionVerified = false, isActive = () => true,
  referenceImagePaths = [], storageUserId = null,
  onDispatch, onConversation,
}) {
  proxyUrl = requireGenerationProxy(proxyUrl);
  if (!sessionVerified) throw new Error('未确认实时有效登录，拒绝提交');
  if (!isActive()) throw new Error('generation_cancelled');
  if (typeof onDispatch !== 'function' || typeof onConversation !== 'function') throw new Error('submission_journal_required');

  const duration = Number(forceSeconds ?? seconds ?? 10);
  const model = targetModel || (duration >= 20 ? 'seedance_v2.5' : 'seedance_v2.0');
  const ck = parseCookies(cookieText);

  /**
   * ★ 参考图先上传（纯协议，不需要页面），再开浏览器取签名。
   *
   * 为什么放在开浏览器之前：上传要 7~10 秒，而浏览器是"开一次就占一个并发槽"的稀缺资源。
   * 上传失败时连浏览器都不用开 —— 失败得更早、更省。而且顺序上也没有别的选择：
   * body 里必须已经是最终 uri，而签名是拿 body 去签的。
   */
  let referenceImages = [];
  if (referenceImagePaths?.length) {
    const uploaded = await uploadReferenceImages(referenceImagePaths, {
      cookies: ck, proxyUrl, userId: storageUserId || '', log,
    });
    referenceImages = uploaded.map((item) => ({
      uri: item.uri, width: item.width, height: item.height, name: item.name, format: item.format,
    }));
    log(`方案A：${referenceImages.length} 张参考图已上传（uri 示例 ${referenceImages[0].uri}）`);
  }

  const pw = await getPlaywright();
  if (!pw?.chromium) throw new Error('playwright 未安装：npm i playwright && npx playwright install chromium');

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
    const body = buildSchemeARequestBody(prompt, { ratio, model, duration, referenceImages });
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

    const parsed = parseSchemeAAck(ackText, cap.postData);
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
