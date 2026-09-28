/**
 * dola.com provider —— 账号池用。
 *
 * 契约来源：真实浏览器抓包（capture/dola-network.json）+ 前端 bundle 逆向。
 * 详细分析和已验证/未验证清单见 DOLA_ANALYSIS.md。
 *
 * ⚠️ 两条已知约束，代码里都做了显式标注：
 *   1. dola 只有 OAuth / 短信验证码 / 扫码登录，**没有账号密码登录**，
 *      本 provider 接受已登录 cookie；Google 登录由独立 google-login 模块处理。
 *   2. 部分接口需要 `a_bogus` 请求签名（防爬）。已验证若干部接口不带签名也能通，
 *      但「查额度」到底需不需要签名，必须用真实 cookie 实测 —— 见 probeCredits()。
 */
import crypto from 'node:crypto';
import { tryAcquireAccountBrowserLock } from './account-browser-lock.js';
import { observeVideoComposerBootstrap } from './composer-bootstrap.js';
import { createPreflightDiagnostics } from './preflight-diagnostics.js';
import {
  nativeCapabilityState,
  prepareNativeVideoComposer,
  prepareReferenceImageComposer,
  referenceImageCapabilityState,
} from './native-capability.js';

export const DOLA_BASE = process.env.DOLA_BASE || 'https://www.dola.com';
export const DOLA_AID = '495671';

/** 每个业务接口都要带的固定 query（抓包逐字还原） */
export const COMMON_QUERY = {
  version_code: '20800',
  language: 'en',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: DOLA_AID,
  real_aid: DOLA_AID,
  pkg_type: 'release_version',
  pc_version: '3.36.11',
  doubao_pc_version: '3.36.11',
  samantha_web: '1',
  web_platform: 'browser',
  'use-olympus-account': '1',
};

export const DOLA_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  'agw-js-conv': 'str',
  referer: `${DOLA_BASE}/chat/`,
  origin: DOLA_BASE,
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

export const newTabId = () => crypto.randomUUID();

// ---------------------------------------------------------------- cookie 解析

/** RFC 6265 的 cookie 名是 token：不允许空格、引号、冒号、逗号等 */
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * 把各种粘贴格式统一解析成 {name: value}。
 * 支持的格式（都是实际操作里真会遇到的）：
 *   1. 原始 Cookie 头：   a=1; b=2
 *   2. document.cookie 同 1
 *   3. 浏览器插件导出的 JSON 数组：[{"name":"a","value":"1","domain":".dola.com"}]
 *   4. Playwright/Puppeteer 导出的 JSON 数组（同上）
 *   5. 简单 JSON 对象：   {"a":"1","b":"2"}
 *   6. Netscape cookies.txt（制表符分隔，第 7 列是值）
 *
 * ⚠️ 名字必须过 RFC 6265 的 token 校验。
 * 否则把多行 JSON 误当 cookie 头解析时，`"name": "ttwid",` 这种行会被当成
 * cookie 名 = `"name"`（带引号）而混进来 —— 真踩过。
 */
/**
 * 在一层 JSON 对象里挖出「cookie 数组」。
 *
 * 为什么必须有这个函数：导出的 cookie 常常是**包装对象**，形状是
 *   { format, schemaVersion, exportedAtUtc, scope, instanceName, cookieCount, cookies: [ {name,value,...} ] }
 *
 * ⚠️ 不挖内层数组的后果（实测踩到，且症状极具误导性）：
 *   顶层剩下 format / schemaVersion / scope / instanceName / cookieCount 这些**字符串标量**，
 *   它们恰好都能通过 RFC 6265 的 token 校验 —— 于是被当成「cookie」装进结果里。
 *   keep() 返回非空 → JSON 分支直接短路 return，**真正的 cookie 一个都没解析到**。
 *   外部表现是「导入成功，但账号缺少 ttwid/odin_tt 被判 invalid」，
 *   让人以为是 cookie 本身坏了 / 复制不全，而不是解析器丢了内容。
 *
 * 只认一层（不递归），先按常见键名找，再退化为扫所有值。
 */
function findCookieArray(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const isCookieArray = (v) => Array.isArray(v) && v.length > 0
    && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string');

  // ① 常见键名（本项目导出工具用 cookies；Playwright storageState 也是 cookies）
  for (const k of ['cookies', 'cookieList', 'cookie_list']) {
    if (isCookieArray(obj[k])) return obj[k];
  }
  // ② 退化为扫一层值：找「全是 {name:string,...}」的数组
  for (const v of Object.values(obj)) {
    if (isCookieArray(v)) return v;
  }
  return null;
}

export function parseCookies(input) {
  // 浏览器插件导出的 JSON 常带 UTF-8 BOM，JSON.parse 会因为首字符 \uFEFF 直接报错
  const raw = String(input || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return {};

  const keep = (out) => {
    const clean = {};
    for (const [k, v] of Object.entries(out)) {
      const name = String(k).trim();
      if (COOKIE_NAME_RE.test(name) && name.length <= 128) clean[name] = v;
    }
    return clean;
  };

  // JSON？
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const js = JSON.parse(raw);
      if (Array.isArray(js)) {
        const out = {};
        for (const c of js) {
          if (c && c.name) out[c.name] = String(c.value ?? '');
        }
        const clean = keep(out);
        if (Object.keys(clean).length) return clean;
      } else if (js && typeof js === 'object') {
        // ① 包装导出：先挖内层 cookies 数组（详见 findCookieArray 的说明）。
        //    必须在「扁平对象」分支之前做，否则会被顶层标量短路。
        const nested = findCookieArray(js);
        if (nested) {
          const out = {};
          for (const c of nested) out[c.name] = String(c.value ?? '');
          const clean = keep(out);
          if (Object.keys(clean).length) return clean;
        }
        // ② 扁平对象 {"a":"1","b":"2"}
        const out = {};
        for (const [k, v] of Object.entries(js)) {
          if (typeof v !== 'object') out[k] = String(v ?? '');
        }
        const clean = keep(out);
        if (Object.keys(clean).length) return clean;
      }
    } catch { /* 不是 JSON，继续按下面解析 */ }
  }

  // Netscape cookies.txt：domain \t flag \t path \t secure \t expiry \t name \t value
  if (raw.includes('\t')) {
    const out = {};
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const cols = l.split('\t');
      if (cols.length >= 7) out[cols[5].trim()] = cols[6].trim();
    }
    const clean = keep(out);
    if (Object.keys(clean).length) return clean;
  }

  // 原始 Cookie 头
  const out = {};
  for (const part of raw.split(/[;\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('=');
    if (i <= 0) continue;
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return keep(out);
}

/** 整段文本看起来是不是「一整个账号的 JSON」（插件导出的那种） */
export function looksLikeJsonBlob(text) {
  const t = String(text || '').trim().replace(/^\uFEFF/, '');
  return t.startsWith('[') || t.startsWith('{');
}

export function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 关键 cookie 是否齐全（缺了基本不可能登录成功） */
export const REQUIRED_COOKIES = ['ttwid', 'odin_tt'];
export function missingRequired(cookies) {
  return REQUIRED_COOKIES.filter((n) => !cookies?.[n]);
}

/**
 * ★ 把账号 cookie 映射成 Playwright / Chromium 能接受的结构 —— **不能一刀切**。
 *
 * Chromium 会按 RFC 6265bis 校验两个保留前缀：
 *   `__Secure-`  → 必须带 secure=true
 *   `__Host-`    → 必须 secure=true、path='/'，且**不能带 domain**（host-only，只能用 url 指定）
 *
 * 之前三处注入点都统一写成 `{ domain: '.dola.com', path: '/' }`，于是凡是 cookie 里
 * 带这类前缀的账号，都会在 `ctx.addCookies()` 直接抛
 *   `Protocol error (Storage.setCookies): Invalid cookie fields`
 * 再被上层裸 catch 吞成「页面、登录状态或网络未能完成只读能力探测」，
 * 根因长期不可见（2026-09-25 靠逐条二分才定位到）。
 */
export function toPlaywrightCookies(cookies) {
  return Object.entries(cookies || {})
    .filter(([name, value]) => typeof name === 'string' && name && typeof value === 'string')
    .map(([name, value]) => {
      if (name.startsWith('__Host-')) {
        // host-only：只能靠 url 指定（带 domain 会被 Chromium 拒）。
        // 注意 Playwright 不允许 url 与 domain/path 同时出现，否则报
        // "Cookie should have either url or path"；path='/' 会由 url 自动推出。
        return { name, value, url: `${DOLA_BASE}/`, secure: true };
      }
      if (name.startsWith('__Secure-')) {
        return { name, value, domain: '.dola.com', path: '/', secure: true };
      }
      return { name, value, domain: '.dola.com', path: '/' };
    });
}

// ---------------------------------------------------------------- 请求

export function buildQuery(extra = {}) {
  const p = new URLSearchParams({ ...COMMON_QUERY, ...extra });
  return p.toString();
}

/**
 * 不同接口的 Content-Type 不一样：
 *   `/im/*`（IM 协议族）必须带 `; encoding=utf-8` 后缀，否则返回
 *   `712012002 不支持编码类型`。这是实测踩出来的 —— 少个后缀整个 IM 接口全调不通。
 */
function contentTypeFor(path) {
  return path.startsWith('/im/') ? 'application/json; encoding=utf-8' : 'application/json';
}

/**
 * 把 fetch 的嵌套错误摊平成一句能定位的话。
 *
 * 为什么要单独写这个：fetch 会把所有底层错误都包成笼统的 `fetch failed`，
 * 不看 `cause` 就只能靠猜。实测被这个坑掉过一次 —— 真正原因是
 * `invalid onRequestStart method`（两份 undici 版本不匹配），
 * 而字面信息只有"fetch failed"。
 *
 * 注：`routes/dola.js` 的 describeFetchError 是同一份逻辑，
 * 那边注释里也留了这条教训。这里补上，避免服务端和脚本端行为不一致。
 */
export function describeFetchError(e) {
  const parts = [];
  for (let cur = e, depth = 0; cur && depth < 5; depth++) {
    const msg = cur.message || (typeof cur === 'string' ? cur : '');
    const code = cur.code ? `[${cur.code}]` : '';
    if (msg || code) parts.push(`${code}${msg}`.trim());
    cur = cur.cause;
  }
  return parts.filter(Boolean).join(' ← ') || '未知网络错误';
}

/**
 * 调 dola 的 JSON 接口。
 *
 * `proxy` 是**必须**要传的（多账号场景）：不传就走本机出口，
 * 会出现"浏览器提交从韩国住宅 IP、轮询从本机 IP"的错位，
 * 对风控来说比一直用同一个 IP 更可疑。详见 dola/proxy.js 顶部说明。
 *
 * @returns {Promise<{status:number, json:any, text:string, url:string, ms:number}>}
 */
export async function dolaFetch(path, {
  cookies = {},
  body = {},
  method = 'POST',
  query = {},
  timeout = 20000,
  aBogus = null,
  proxy = null,
} = {}) {
  const q = { ...query };
  if (aBogus) q.a_bogus = aBogus;
  const url = `${DOLA_BASE}${path}?${buildQuery(q)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${timeout}ms`)), timeout);
  const started = Date.now();
  try {
    const { fetchVia } = await import('./proxy.js');
    const res = await fetchVia(url, {
      method,
      headers: { ...DOLA_HEADERS, 'content-type': contentTypeFor(path), cookie: cookieHeader(cookies) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: ctrl.signal,
      redirect: 'follow',
    }, proxy);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text, url, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, json: null, text: describeFetchError(e), url, ms: Date.now() - started, error: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 登录态

/**
 * 实测到的业务错误码（对照实验：无 cookie → 有 cookie）：
 *   code 0        → 成功
 *   code 710012001 → 「Session expired. Log in again.」 明确表示会话失效
 *   code 710010202 → 「system error」 **通用失败**
 *
 * ⚠️ 纠正过一个错误结论：一度以为 710010202 = 「缺 a_bogus 签名」，
 * 实际是**会话无效/校验不通过**的兜底错误 —— 换成有效 cookie 后，
 * 同一批接口（含 action_bar_v3）全部 code=0，从不需要什么签名。
 */
export const DOLA_CODE = {
  OK: 0,
  SESSION_EXPIRED: 710012001,
  GENERIC_ERROR: 710010202,
};

/**
 * 曾经以为需要 a_bogus 的接口。
 * 实测纠正：带上有效 cookie 后它们全部 code=0，**并不需要签名**。
 * 留着这个集合只为在探测报告里标注「历史上误判过」，不再参与判定。
 */
export const HISTORICALLY_FLAGGED = new Set(['/alice/slot/action_bar_v3/get_item_conf']);

export function classify(json) {
  const code = json?.code;
  if (code === DOLA_CODE.OK) return 'ok';
  if (code === DOLA_CODE.SESSION_EXPIRED) return 'session_expired';
  if (code === DOLA_CODE.GENERIC_ERROR) return 'generic_error';
  if (typeof code === 'number') return 'error';
  return 'unknown';
}

/** 登录态判定用的字段（抓包看到未登录时 sec_user_id 为空串） */
export function looksLoggedIn(json) {
  const d = json?.data ?? {};
  const secUid = d.sec_user_id ?? d.secUid ?? '';
  const uid = d.user_id ?? d.uid ?? d.user_info?.user_id ?? null;
  return { loggedIn: Boolean(secUid) || Boolean(uid), secUid, uid };
}

/**
 * 校验 cookie 是否还有效。打两个接口交叉判定：
 *   /alice/user/config/pull  —— 会话失效会明确返回 710012001（最可靠）
 *   /alice/user/launch       —— 拿 sec_user_id
 */
export async function checkSession(cookies, { proxy = null, ...opts } = {}) {
  const launched = await dolaFetch('/alice/user/launch', {
    cookies,
    body: { select: { launch_config: true, assistant_bot_info: true, landing_config: true, user_info: true } },
    proxy,
    ...opts,
  });
  const pulled = await dolaFetch('/alice/user/config/pull', {
    cookies,
    body: { objects: [114, 111], reason: 2 },
    proxy,
    ...opts,
  });

  const st = looksLoggedIn(launched.json);
  const pullKind = classify(pulled.json);
  const missing = missingRequired(cookies);

  // 会话失效码是硬证据；否则看 launch 里有没有用户标识
  let valid = false;
  if (pullKind === 'session_expired') valid = false;
  else if (pullKind === 'ok' || pullKind === 'unknown') valid = st.loggedIn || pullKind === 'ok';
  else if (pullKind === 'generic_error' && st.loggedIn) valid = true;

  return {
    valid,
    missing,
    secUid: st.secUid,
    uid: st.uid,
    pullKind,
    pullCode: pulled.json?.code ?? null,
    pullStatus: pulled.status,
    launchCode: launched.json?.code ?? null,
    launchStatus: launched.status,
    launchMs: launched.ms,
    launchRaw: launched.json,
    pullRaw: pulled.json,
  };
}

// ---------------------------------------------------------------- 账号资料

/**
 * 账号资料：`POST /alice/profile/self_brief`（✅ 已用真实 cookie 实测，code=0）
 *
 * ⚠️ 注意是 `self_brief` 不是 `self` —— 实测 `/alice/profile/self` 恒返回
 * `710010202 system error`，`self_brief` 才通（且基础参数就够，不需要 region）。
 *
 * 这是**登录后最可靠的账号标识来源** —— `user/launch` 里的 `sec_user_id` 是空串，
 * 而这里能拿到 id / entity_id / 昵称 / user_name。
 * 同时给出会员状态，用来区分免费号（free）和付费号（有订阅才有 credits）。
 */
export async function fetchProfile(cookies, { timeout = 20000, proxy = null } = {}) {
  const r = await dolaFetch('/alice/profile/self_brief', { cookies, body: {}, timeout, proxy });
  const p = r.json?.data?.profile_brief ?? {};
  const m = p.membership_info ?? {};
  return {
    ok: r.status === 200 && r.json?.code === 0,
    status: r.status,
    code: r.json?.code ?? null,
    ms: r.ms,
    id: p.id ?? '',
    entityId: p.entity_id ?? '',
    nickname: p.nickname ?? '',
    userName: p.user_name ?? '',
    membershipLevel: m.level ?? '',                       // 实测：free / pro
    hasActiveSubscription: Boolean(m.has_active_subscription),
    membershipDisplayName: m.membership_display_name ?? '',
    raw: r.json,
  };
}

/**
 * 会员状态：`POST /alice/commerce/sale/subscription/entry/config/`（✅ 实测 code=0，无需签名）
 *
 * 这是**不依赖 a_bogus 就能拿到会员等级**的来源（`profile/self` 拿不到，见上）。
 * 实测免费号返回 `subs_status: "free"` + `has_active_subscription: false`。
 */
export async function fetchSubscription(cookies, { timeout = 20000, proxy = null } = {}) {
  const r = await dolaFetch('/alice/commerce/sale/subscription/entry/config/', { cookies, body: {}, timeout, proxy });
  const d = r.json?.data ?? {};
  return {
    ok: r.status === 200 && r.json?.code === 0,
    code: r.json?.code ?? null,
    subsStatus: d.subs_status ?? '',                       // 实测：free / pro…
    hasActiveSubscription: Boolean(d.has_active_subscription),
    membershipDisplayName: d.membership_display_name ?? '',
    countryCode: d.country_code ?? '',
    raw: r.json,
  };
}

// ---------------------------------------------------------------- 额度

/**
 * 额度候选接口。
 * 抓包里带 credit 字样的是 action_bar 那个；user/launch 的 user_info 里也可能带。
 * 注意 action_bar 需要 a_bogus —— 纯 HTTP 拿不到，得走浏览器（fetchCreditsViaBrowser）。
 */
export const CREDIT_CANDIDATES = [
  { path: '/alice/profile/self_brief', body: {}, note: '账号资料 + 会员等级（✅ 实测 code=0；免费号无额度字段）' },
  { path: '/alice/user/launch', body: { select: { user_info: true, launch_config: true } }, note: 'user_info；实测 quota_config 恒为 null' },
  { path: '/alice/commerce/sale/subscription/entry/config/', body: {}, note: '订阅入口；实测返回 subs_status: free/pro' },
  { path: '/alice/slot/action_bar_v3/get_item_conf', body: { language_code: 'en', item_ids: [], bot_id: '7339470689562525703' }, note: '顶栏配置；里面的 credit 是模型消耗倍率，不是余额' },
  { path: '/alice/slot/action_bar_v3/brief_list', body: { language_code: 'zh', bot_id: '7339470689562525703' }, note: '顶栏简报（✅ 实测 code=0，14KB，含模型配置）' },
  { path: '/alice/user/config/pull', body: { objects: [114, 111], reason: 2 }, note: '用户配置拉取（会话校验）' },
];

/** 递归找所有看起来像额度的数值字段 */
export function findCreditFields(obj, prefix = '', out = [], depth = 0) {
  if (depth > 6 || obj == null) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findCreditFields(v, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && /credit|quota|balance|remain|point|left|total|used|limit/i.test(k)) {
      out.push({ field: p, value: v });
    }
    if (v && typeof v === 'object') findCreditFields(v, p, out, depth + 1);
  }
  return out;
}

/**
 * 探测额度接口：把候选逐个打一遍，返回每个的原始响应 + 找到的可疑字段。
 * 用途：拿到真实 cookie 后跑一次，确定「额度到底在哪个接口、哪个字段」。
 */
export async function probeCredits(cookies, { timeout = 20000, proxy = null } = {}) {
  const results = [];
  for (const c of CREDIT_CANDIDATES) {
    const r = await dolaFetch(c.path, { cookies, body: c.body, timeout, proxy });
    results.push({
      path: c.path,
      note: c.note,
      status: r.status,
      code: r.json?.code ?? null,
      kind: classify(r.json),
      msg: r.json?.msg ?? (r.error ? r.text : null),
      ms: r.ms,
      flagged: HISTORICALLY_FLAGGED.has(c.path),
      numericHits: findCreditFields(r.json),
      sample: r.text.slice(0, 1200),
    });
  }
  return results;
}

// ---------------------------------------------------------------- 浏览器通道

let _playwright = null;
/** 懒加载 playwright：没装就返回 null，不拖垮整个服务 */
async function loadPlaywright() {
  if (_playwright !== null) return _playwright;
  for (const name of ['playwright', 'playwright-core']) {
    try {
      _playwright = await import(name);
      return _playwright;
    } catch { /* 试下一个 */ }
  }
  _playwright = false;
  return false;
}

export async function playwrightAvailable() {
  const pw = await loadPlaywright();
  return Boolean(pw?.chromium);
}

/** 给同目录下的生成编排器复用（它自己也要开浏览器提交） */
export async function getPlaywright() {
  return loadPlaywright();
}

/**
 * ★ 拦住 dola 前端在限流时「自己登出自己」的请求。
 *
 * 实测：提交撞上限流（710022002）后，dola 前端会自己调 `/passport/web/logout/`
 * 把会话销毁 —— **每失败一次就烧掉一个账号**。
 * 这里把它 abort 掉，限流就退化成"这次没成功"，账号还在。
 *
 * 必须用 `ctx.route(...)` 在**页面发起之前**注册（路由拦截只对注册后的请求生效），
 * 且要在 `addCookies` 之后、`newPage()` 之前调用，别放到导航之后。
 *
 * 原本这段代码在 `diag-submit.mjs` / `verify-flow.mjs` 里各抄了一份，
 * 而 `submit30.mjs` / `dola-generate.mjs` / `exp-capture-submit.mjs` 这些
 * **真会提交**的脚本反而漏了 —— 所以收口到这个函数，谁开浏览器谁调一次。
 * 对只读探测脚本也安全：任何脚本都不希望账号自己登出。
 *
 * @param {import('playwright').BrowserContext} ctx
 */
export async function guardLogoutRequests(ctx) {
  await ctx.route('**/passport/**/logout**', (route) => route.abort());
}

/**
 * 浏览器通道：带着账号 cookie 打开 dola，让页面自己算 a_bogus，
 * 我们只监听它发出的请求/响应，把额度字段扒出来。
 *
 * 为什么保留这条路：抓包确认浏览器会带 `region`/`web_id`/`a_bogus` 等一整套上下文参数，
 * 纯 HTTP 复刻不可能 100% 对齐；用浏览器复现「页面真实发出的请求」最稳。
 * 让页面自己发请求，参数与签名都由页面负责。
 */
export async function fetchCreditsViaBrowser(cookies, {
  headless = true,
  timeout = 45000,
  pageUrl = `${DOLA_BASE}/chat/`,
  proxy = undefined,
  proxyUrl = null,
} = {}) {
  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    return { ok: false, error: 'playwright 未安装：npm i playwright && npx playwright install chromium', hits: [], captured: [] };
  }

  const launchOptions = {
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  if (proxy) launchOptions.proxy = proxy;
  let browser = null;
  let bridge = null;
  // ★ ctx 必须声明在 try **外面**：下面的 finally 要用它做清理，
  //   而 `const ctx` 是块级作用域 —— 写在 try 里的话，finally 引用它会直接抛
  //   `ReferenceError: ctx is not defined`，把 try 里已经算好的成功返回值整个吞掉。
  //   实测后果：额度探测其实跑通了（26s、页面已加载），但调用方拿到的永远是
  //   `{ ok:false, error:'ctx is not defined' }` ⇒ 后台「dola 额度合计」恒为 0。
  let ctx = null;
  const captured = [];
  const hits = [];
  let seen = 0;
  try {
    if (proxyUrl && /^socks5h?:/i.test(proxyUrl)) {
      const { startSocksBridge } = await import('./socks-bridge.js');
      bridge = await startSocksBridge(proxyUrl);
      launchOptions.proxy = { server: bridge.url };
    }
    browser = await pw.chromium.launch(launchOptions);
    ctx = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      userAgent: DOLA_HEADERS['user-agent'],
    });
    await ctx.route('**/passport/**/logout**', route => route.abort());

    // Defense in depth: read-only capability probes must never submit a prompt.
    await ctx.route('**/chat/completion**', route => route.abort());
    await ctx.route('**/chat/**', route => route.request().method() === 'POST' ? route.abort() : route.continue());

    // 把导入的 cookie 灌进浏览器上下文
    const cookieList = toPlaywrightCookies(cookies);
    if (cookieList.length) await ctx.addCookies(cookieList);

    const page = await ctx.newPage();
    page.on('response', async (res) => {
      const u = res.url();
      if (!u.includes('/alice/') && !u.includes('/samantha/')) return;
      if (seen > 200) return;
      seen++;
      try {
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const json = await res.json();
        const found = findCreditFields(json);
        const path = new URL(u).pathname;
        captured.push({ path, status: res.status(), code: json?.code ?? null, hits: found });
        for (const h of found) hits.push({ ...h, from: path, status: res.status(), code: json?.code });
      } catch { /* 解析失败忽略 */ }
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    await page.waitForTimeout(Math.min(timeout, 15000)); // 等首屏接口打完
    await ctx.close();
    return { ok: true, cookiesLoaded: cookieList.length, hits, captured };
  } catch (e) {
    return { ok: false, error: e.message, hits, captured };
  } finally {
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bridge?.close().catch(() => {});
  }
}

/**
 * Read-only native video capability probe.
 *
 * It loads a temporary browser context with the account cookie and its bound
 * proxy, then inspects the real composer controls. It never fills a prompt,
 * presses send, captures cookies, or rewrites a request.
 */
export async function probeNativeVideoViaBrowser(cookies, {
  seconds = 30,
  model = seconds === 15 ? 'seedance_v2.0' : 'seedance_v2.5',
  headless = true,
  timeout = 60000,
  pageUrl = `${DOLA_BASE}/chat/`,
  proxy = undefined,
  proxyUrl = null,
  accountId = null,
  allowUpstreamConcat = false,
  carriers = null,
  allowLegacy = false,
} = {}) {
  timeout = Math.min(120000, Math.max(1, Number(timeout) || 60000));
  const diagnostic = createPreflightDiagnostics({ seconds });
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  if (!proxyUrl) {
    return { ok: false, state: 'unknown', error: '原生能力探测必须使用账号已绑定的代理' };
  }
  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    return { ok: false, state: 'unknown', error: 'playwright 未安装，未进行能力判定' };
  }

  const launchOptions = {
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  let browser = null;
  let ctx = null;
  let persistent = false;
  let bridge = null;
  let deadlineTimer = null;
  let deadlineExpired = false;
  // ★ 必须声明在 try 之外：catch 分支要用它判断「页面到底有没有打开」。
  let navError = null;
  let navigated = false;
  const releaseAccountBrowserLock = accountId == null ? null : tryAcquireAccountBrowserLock(accountId);
  if (accountId != null && !releaseAccountBrowserLock) {
    return { ok: false, state: 'unknown', error: '该账号浏览器正忙，未进行能力判定' };
  }
  try {
    // Keep the installed runtime identical to the generation worker. This does
    // not by itself establish page readiness; the composer must still confirm it.
    launchOptions.executablePath = pw.chromium.executablePath();
    if (/^socks5h?:/i.test(proxyUrl)) {
      const { startSocksBridge } = await import('./socks-bridge.js');
      bridge = await startSocksBridge(proxyUrl);
      launchOptions.proxy = { server: bridge.url };
    } else if (proxy?.server) {
      launchOptions.proxy = proxy;
    } else {
      return { ok: false, state: 'unknown', error: '账号代理未能建立浏览器配置' };
    }

    // Bound the whole read-only admission probe, not each navigation separately.
    // Otherwise a caller may time out while the backend continues creating a task.
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      void Promise.resolve(ctx?.close()).catch(() => {});
      void browser?.close().catch(() => {});
    }, remaining());
    /**
     * ★ 复用账号的持久化 profile（有 accountId 时）。
     *
     * 为什么必须：只读探测原本用临时上下文，**每次都冷启动**，
     * 拉 ~12MB 的 JS 包。走住宅代理（尤其是静态 IP 只有 5Mbps）时
     * 光加载就要 20 秒以上，探不到目标控件就超时 → 结果记成 `unknown`
     * （而 `unknown` 会被误读成"这号没有该能力"）。
     *
     * 复用 profile 后命中 HTTP 缓存，热启动只要 ~0.36MB —— **快 30 倍**，
     * 而且以后所有号的能力探测都受益。
     */
    const ctxOptions = {
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      userAgent: DOLA_HEADERS['user-agent'],
    };
    if (accountId) {
      persistent = true;
      const { mkdir } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const profileDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'browser-profiles', String(accountId));
      await mkdir(profileDir, { recursive: true });
      const launchPersistent = () => pw.chromium.launchPersistentContext(
        profileDir,
        { ...launchOptions, ...ctxOptions, timeout: Math.min(remaining(), 30000) },
      );
      /**
       * ★ 代理隧道自检（2026-09-28 实测加的，与 generator.js 是同一处修复）。
       *
       * 事实：persistent context + 带 Basic 认证的 HTTP 代理有约 20% 的间歇导航失败，
       * 报 `ERR_TUNNEL_CONNECTION_FAILED` / `ERR_EMPTY_RESPONSE`。证据（账号 429）：
       *   · 失败**那一刻**用 curl 走同一代理仍 200 ⇒ 不是网络/代理故障，是浏览器侧
       *   · `chromium.launch({proxy})` 6/6 成功，`launchPersistentContext({proxy})` 5/6
       *   · 同 page 原地重试只救回一半，另一半**必须销毁重建 context** 才恢复
       * 这就是「生成前只读预检偶发失败（页面未能加载）」的真身 ——
       * 以前只当成"代理抖动"加了等待，其实抖动在浏览器侧。
       *
       * 自检放在装 route / addCookies **之前**：重建成本最低（不用重做任何配置）。
       * 用 robots.txt + 随机 query：只验隧道通不通（404 也算过），
       * 随机 query 是为了不命中持久 profile 的磁盘缓存（命中就等于没检）。
       */
      const tunnelOk = async (c) => {
        let probe = null;
        try {
          probe = c.pages()[0] || await c.newPage();
          await probe.goto(`https://www.dola.com/robots.txt?_tunnel=${Date.now()}`,
            { waitUntil: 'commit', timeout: 10000 });
          return true;
        } catch {
          return false;
        } finally {
          await probe?.close().catch(() => {});
        }
      };
      const { rm } = await import('node:fs/promises');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          ctx = await launchPersistent();
        } catch (e) {
          // 进程被强杀时 Chromium 会留下 SingletonLock，不清理这个号以后永远起不来
          if (!/SingletonLock|ProcessSingleton|profile.*in use/i.test(String(e.message))) throw e;
          for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            await rm(join(profileDir, f), { force: true, recursive: true }).catch(() => {});
          }
          continue;
        }
        if (deadlineExpired) break;
        if (await tunnelOk(ctx)) break;
        console.warn(`[probe] 账号 #${accountId} 代理隧道自检未通过（第 ${attempt + 1}/3 次），销毁重建`);
        await ctx.close().catch(() => {});
        ctx = null;
      }
      if (!ctx) {
        return { ok: false, state: 'unknown', error: '页面未能加载（代理隧道自检连续 3 次未通过，多半是出口问题）' };
      }
    } else {
      browser = await pw.chromium.launch({ ...launchOptions, timeout: Math.min(remaining(), 30000) });
      ctx = await browser.newContext(ctxOptions);
    }
    if (deadlineExpired) throw new Error('capability_probe_timeout');
    diagnostic.mark('context');
    await ctx.route('**/passport/**/logout**', route => route.abort());

    await ctx.route('**/chat/completion**', route => route.abort());
    await ctx.route('**/chat/**', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    const cookieList = toPlaywrightCookies(cookies);
    if (!cookieList.length) {
      return { ok: false, state: 'unknown', error: '账号没有可用 cookie，未进行能力判定' };
    }
    await ctx.addCookies(cookieList);
    const page = await ctx.newPage();
    diagnostic.attach(page);
    observeVideoComposerBootstrap(page);
    diagnostic.mark('navigate');
    /**
     * ★ 导航异常必须**留住**，不能 `.catch(() => {})` 一口吞掉。
     *
     * 吞掉的代价（2026-09-25 实测，同一个函数、同一天）：
     *   #420 代理会话失效 → 页面从未打开，diagnostic.phase=`navigate`；
     *   #408 登录正常     → diagnostic.phase=`entry`（**输入框已出现**），只是时长控件没加载完。
     * 两者却都抛出同一句话「未确认已登录的创作页面」——
     * 于是"可用账号"被当成"未登录"去折腾 cookie，而真正坏掉的出口没人去修。双向误判。
     *
     * 对照参考站 §4：`logged_in` 与 `proxy_enabled/egress` 是**两个独立字段**，不能混为一谈。
     * 所以这里把"页面没打开"单独报出来，并归到 proxy（proxy 没有作用域 → 只提示、不封号）。
     */
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(remaining(), 60000) })
      .catch((e) => { navError = e; });
    if (navError && !deadlineExpired) {
      return {
        ok: false, state: 'unknown', pageLoaded: false,
        reason: 'VIDEO_NAVIGATION_FAILED',
        diagnostic: diagnostic.snapshot('VIDEO_NAVIGATION_FAILED'),
        error: `页面未能加载（代理或网络故障），未做能力判定：${String(navError?.message || navError).replace(/\s+/g, ' ').slice(0, 160)}`,
      };
    }
    navigated = true;
    // Streaming/telemetry can keep the network busy forever. Readiness comes
    // from the visible composer controls below, not from zero open requests.
    await page.waitForLoadState('networkidle', { timeout: Math.min(remaining(), 5000) }).catch(() => {});
    const capability = await prepareNativeVideoComposer(page, {
      seconds, model, timeout: remaining(), onPhase: diagnostic.mark, allowUpstreamConcat, carriers, allowLegacy,
    });
    if (deadlineExpired) throw new Error('capability_probe_timeout');
    return { ok: true, state: 'available', pageLoaded: true, ...capability, diagnostic: diagnostic.snapshot() };
  } catch (error) {
    // 诊断日志：把通用报错背后的真实异常打出来，否则永远看不到根因
    try {
      console.error(`[probe] native video probe failed: code=${error?.code || 'none'} reason=${deadlineExpired ? 'VIDEO_PREPARATION_TIMEOUT' : error?.reason || 'none'} message=${String(error?.message || error).slice(0, 300)}`);
    } catch { /* 日志不能影响探针返回 */ }
    return {
      ok: false,
      state: nativeCapabilityState(error),
      // pageLoaded 是「登录未确认」可信度的前提：只有页面真打开了，
      // "创作输入框没出现"才能当成登录态的证据；页面压根没加载时它什么也证明不了。
      pageLoaded: navigated,
      reason: deadlineExpired ? 'VIDEO_PREPARATION_TIMEOUT' : (error?.reason || error?.code || null),
      diagnostic: diagnostic.snapshot(deadlineExpired ? 'VIDEO_PREPARATION_TIMEOUT' : (error?.reason || error?.code || 'VIDEO_PROBE_ERROR')),
      error: ['NATIVE_CAPABILITY_UNAVAILABLE', 'NATIVE_CAPABILITY_UNKNOWN'].includes(error?.code)
        ? error.message
        : '页面、登录状态或网络未能完成只读能力探测',
    };
  } finally {
    diagnostic.dispose();
    clearTimeout(deadlineTimer);
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    releaseAccountBrowserLock?.();
  }
}

export async function probeNativeThirtySecondViaBrowser(cookies, options = {}) {
  return probeNativeVideoViaBrowser(cookies, { ...options, seconds: 30, model: 'seedance_v2.5' });
}

export async function probeNativeFifteenSecondViaBrowser(cookies, options = {}) {
  return probeNativeVideoViaBrowser(cookies, { ...options, seconds: 15, model: 'seedance_v2.0' });
}

/**
 * Read-only reference-image capability probe.
 *
 * This does not upload a file and does not submit a generation task. It only
 * checks the real logged-in composer DOM for an explicit image file input so
 * the later upload path is based on observed page capability, not a guessed
 * private endpoint.
 *
 * ★ 2026-09-27 修复：本条链路曾经**漏掉了原生探测早已拿到的四项修复**，
 *   结果在真实账号上 100% 失败（#429 实测 253.4 秒后返回 unknown）。
 *
 *   1. **不复用持久化 profile**（最致命）。原生探测有 `accountId` → 用
 *      `launchPersistentContext` 命中 HTTP 缓存热启动（~0.36MB）；这里却一直
 *      `browser.newContext()` 冷启动，每次拉 ~12MB。走 5Mbps 住宅静态 IP 时
 *      光加载就 20 秒起，还没到「查 DOM」就已经超时。生产证据：`data/browser-profiles/`
 *      里 10 个 profile 全是老号（408~424），**429 及之后一个都没有** —— 因为
 *      原生探测会建、这条链路根本不会建。而唯一 `reference_image_state='available'`
 *      的 #424，恰好是唯一有热 profile 的号。
 *   2. **没有共享预算**。`goto` / `networkidle` / 能力探测各自吃满自己的 timeout，
 *      整条链路没有一层收敛（见下）。
 *   3. **`networkidle` 上限 90 秒**。原生探测明确写了「Streaming/telemetry can keep
 *      the network busy forever」所以只给 5 秒；这里给 90 秒，而 dola 的聊天页
 *      永远不会 idle ⇒ **每次都必然烧满**。
 *   4. **导航异常被 `.catch(() => {})` 吞掉**，无法区分「页面没打开」和「没登录」，
 *      于是坏掉的出口和失效的 cookie 会被混为一谈（原生链路踩过同一个坑，
 *      provider.js 的导航段落有完整记录）。
 *
 *   移植后两条链路口径一致：同一份 profile、同一个预算时钟、同样的归因字段。
 */
export async function probeReferenceImageViaBrowser(cookies, {
  headless = true,
  timeout = 60000,
  pageUrl = `${DOLA_BASE}/chat/`,
  proxy = undefined,
  proxyUrl = null,
  accountId = null,
} = {}) {
  timeout = Math.min(120000, Math.max(1, Number(timeout) || 60000));
  // ★ 诊断是必需的，不是锦上添花：这条链路历史上的失败文案是笼统的
  //   「页面、登录状态或网络未能完成参考图能力探测」，把「网络在失败」「单纯慢」
  //   「登录态没了」三件该修不同地方的事混成一句，导致长期无法定位。
  //   `seconds` 传 null：参考图探测没有档位概念，只有 PHASES 里的阶段名。
  const diagnostic = createPreflightDiagnostics({ seconds: null });
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  if (!proxyUrl) {
    return { ok: false, state: 'unknown', error: '参考图能力探测必须使用账号已绑定的代理' };
  }
  const pw = await loadPlaywright();
  if (!pw?.chromium) {
    return { ok: false, state: 'unknown', error: 'playwright 未安装，未进行能力判定' };
  }

  const launchOptions = {
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  let browser = null;
  let ctx = null;
  let bridge = null;
  let deadlineTimer = null;
  let deadlineExpired = false;
  // 必须声明在 try 之外：catch 分支要用它判断「页面到底有没有打开」。
  let navError = null;
  let navigated = false;
  const releaseAccountBrowserLock = accountId == null ? null : tryAcquireAccountBrowserLock(accountId);
  if (accountId != null && !releaseAccountBrowserLock) {
    return { ok: false, state: 'unknown', error: '该账号浏览器正忙，未进行能力判定' };
  }
  try {
    launchOptions.executablePath = pw.chromium.executablePath();
    if (/^socks5h?:/i.test(proxyUrl)) {
      const { startSocksBridge } = await import('./socks-bridge.js');
      bridge = await startSocksBridge(proxyUrl);
      launchOptions.proxy = { server: bridge.url };
    } else if (proxy?.server) {
      launchOptions.proxy = proxy;
    } else {
      return { ok: false, state: 'unknown', error: '账号代理未能建立浏览器配置' };
    }

    // 整条只读探测共享一个截止时间，而不是每段导航各给一份（见上方 ★ 第 2 点）。
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      void Promise.resolve(ctx?.close()).catch(() => {});
      void browser?.close().catch(() => {});
    }, remaining());

    const ctxOptions = {
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      userAgent: DOLA_HEADERS['user-agent'],
    };
    if (accountId) {
      // 与原生探测共用同一个 profile 目录：登录态、HTTP 缓存、指纹都复用，
      // 既热启动又少一次「新设备」风控暴露。
      const { mkdir } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const profileDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'browser-profiles', String(accountId));
      await mkdir(profileDir, { recursive: true });
      const launchPersistent = () => pw.chromium.launchPersistentContext(
        profileDir,
        { ...launchOptions, ...ctxOptions, timeout: Math.min(remaining(), 30000) },
      );
      /**
       * ★ 代理隧道自检（2026-09-28 实测加的，与 generator.js 是同一处修复）。
       *
       * 事实：persistent context + 带 Basic 认证的 HTTP 代理有约 20% 的间歇导航失败，
       * 报 `ERR_TUNNEL_CONNECTION_FAILED` / `ERR_EMPTY_RESPONSE`。证据（账号 429）：
       *   · 失败**那一刻**用 curl 走同一代理仍 200 ⇒ 不是网络/代理故障，是浏览器侧
       *   · `chromium.launch({proxy})` 6/6 成功，`launchPersistentContext({proxy})` 5/6
       *   · 同 page 原地重试只救回一半，另一半**必须销毁重建 context** 才恢复
       * 这就是「生成前只读预检偶发失败（页面未能加载）」的真身 ——
       * 以前只当成"代理抖动"加了等待，其实抖动在浏览器侧。
       *
       * 自检放在装 route / addCookies **之前**：重建成本最低（不用重做任何配置）。
       * 用 robots.txt + 随机 query：只验隧道通不通（404 也算过），
       * 随机 query 是为了不命中持久 profile 的磁盘缓存（命中就等于没检）。
       */
      const tunnelOk = async (c) => {
        let probe = null;
        try {
          probe = c.pages()[0] || await c.newPage();
          await probe.goto(`https://www.dola.com/robots.txt?_tunnel=${Date.now()}`,
            { waitUntil: 'commit', timeout: 10000 });
          return true;
        } catch {
          return false;
        } finally {
          await probe?.close().catch(() => {});
        }
      };
      const { rm } = await import('node:fs/promises');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          ctx = await launchPersistent();
        } catch (e) {
          // 进程被强杀时 Chromium 会留下 SingletonLock，不清理这个号以后永远起不来
          if (!/SingletonLock|ProcessSingleton|profile.*in use/i.test(String(e.message))) throw e;
          for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            await rm(join(profileDir, f), { force: true, recursive: true }).catch(() => {});
          }
          continue;
        }
        if (deadlineExpired) break;
        if (await tunnelOk(ctx)) break;
        console.warn(`[probe] 账号 #${accountId} 代理隧道自检未通过（第 ${attempt + 1}/3 次），销毁重建`);
        await ctx.close().catch(() => {});
        ctx = null;
      }
      if (!ctx) {
        return { ok: false, state: 'unknown', error: '页面未能加载（代理隧道自检连续 3 次未通过，多半是出口问题）' };
      }
    } else {
      browser = await pw.chromium.launch({ ...launchOptions, timeout: Math.min(remaining(), 30000) });
      ctx = await browser.newContext(ctxOptions);
    }
    if (deadlineExpired) throw new Error('reference_image_probe_timeout');
    diagnostic.mark('context');
    await ctx.route('**/passport/**/logout**', route => route.abort());

    const cookieList = toPlaywrightCookies(cookies);
    if (!cookieList.length) {
      return { ok: false, state: 'unknown', error: '账号没有可用 cookie，未进行能力判定' };
    }
    await ctx.addCookies(cookieList);
    const page = await ctx.newPage();
    diagnostic.attach(page);
    observeVideoComposerBootstrap(page);
    await ctx.route('**/chat/**', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    diagnostic.mark('navigate');
    // 导航异常必须留住：吞掉它就分不清「代理/网络坏了」和「cookie 失效了」。
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(remaining(), 60000) })
      .catch((e) => { navError = e; });
    if (navError && !deadlineExpired) {
      // ⚠️ 这里是 `try` 内的**提前 return**，不走下面的 catch —— 所以必须自己记日志。
      //    曾经漏掉，结果是「代理连不上」这条最该留痕的路径反而一条日志都没有。
      const navDiagnostic = diagnostic.snapshot('REFERENCE_IMAGE_NAVIGATION_FAILED');
      try {
        console.error('[probe] reference-image probe failed: code=nav reason=REFERENCE_IMAGE_NAVIGATION_FAILED '
          + `message=${String(navError?.message || navError).replace(/\s+/g, ' ').slice(0, 200)} `
          + `diagnostic=${JSON.stringify(navDiagnostic)}`);
      } catch { /* 日志不能影响探测返回 */ }
      return {
        ok: false, state: 'unknown', pageLoaded: false,
        reason: 'REFERENCE_IMAGE_NAVIGATION_FAILED',
        diagnostic: navDiagnostic,
        error: `页面未能加载（代理或网络故障），未做能力判定：${String(navError?.message || navError).replace(/\s+/g, ' ').slice(0, 160)}`,
      };
    }
    navigated = true;
    // ⚠️ 上限 5 秒，与原生探测同口径：聊天页有常驻流式/遥测请求，
    //    `networkidle` 永远不会触发，给 90 秒就等于每次白烧 90 秒。
    //    页面就绪与否由下面的可见控件决定，不由「零未完成请求」决定。
    await page.waitForLoadState('networkidle', { timeout: Math.min(remaining(), 5000) }).catch(() => {});
    await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => {});
    diagnostic.mark('entry');
    const capability = await prepareReferenceImageComposer(page, { deadline, log: () => {}, onPhase: diagnostic.mark });
    diagnostic.mark('verified');
    // 不在这里 close：上下文统一由 finally 关，避免同一次探测关两遍。
    return { ok: true, state: 'available', pageLoaded: true, ...capability };
  } catch (error) {
    /**
     * ★ 结构化原因的三级兜底：超时 > error.reason > error.code。
     *
     * 原来这里是 `error?.reason || null` —— 只要能力层漏传就退化成 null，
     * 于是一路变成「无原因」。2026-09-27 实测：#436 撞在没带 reason 的
     * 「页面没有发现明确的图片文件控件」上，后台只看到一句通用文案，
     * 完全不知道是「没有 file input」还是「网络没通」。
     * 退回 `error.code` 至少还能区分 NATIVE_CAPABILITY_UNKNOWN / ENOENT / TimeoutError。
     */
    const reasonCode = deadlineExpired
      ? 'REFERENCE_IMAGE_PREPARATION_TIMEOUT'
      : (error?.reason || error?.code || null);
    /**
     * ★ 文案必须从**同一个** `reasonCode` 派生，不能各自判断。
     *
     * 曾经这里用 `error?.reason === 'VIDEO_PAGE_NOT_READY'` 选文案、却用
     * `deadlineExpired` 选 reason，两者会在「等创作输入框正好耗尽共享预算」时打架：
     * 2026-09-27 实测 #449 / #451 的备注写「创作输入框未出现（登录态或页面结构不符）」，
     * 而原因标的是 `［REFERENCE_IMAGE_PREPARATION_TIMEOUT］` —— 一个说「登录态没了」、
     * 一个说「页面太慢」，指向的修法完全相反，排障时只能二选一瞎猜。
     *
     * 现在超时优先：真是预算耗尽，就老实说预算耗尽（并提示可能是登录态或网络慢），
     * 不要假装已经判定出「输入框不会出现」。
     */
    const failureMessage = (() => {
      if (error?.code === 'NATIVE_CAPABILITY_UNAVAILABLE') return error.message;
      if (reasonCode === 'REFERENCE_IMAGE_PREPARATION_TIMEOUT') {
        return '页面准备超过总时限（登录态或网络过慢），未完成参考图能力探测';
      }
      if (reasonCode === 'VIDEO_PAGE_NOT_READY') {
        return '页面已加载但创作输入框未出现（登录态或页面结构不符），未完成参考图能力探测';
      }
      if (error?.code === 'NATIVE_CAPABILITY_UNKNOWN') {
        // 能力层已经给出了具体原因（如「页面没有发现明确的图片文件控件」）。
        // 这句比笼统兜底文案有用得多，`［reason］` 会由路由层追加在后面。
        // ⚠️ 刻意**不**要求 reason 存在：恰恰在 reason 漏传时，这句 message
        //    是唯一还能看出「到底哪里不对」的线索（2026-09-27 #436 的教训）。
        return String(error.message).slice(0, 180);
      }
      return '页面、登录状态或网络未能完成参考图能力探测';
    })();
    // 失败必须留痕：把「真实异常 + 分阶段耗时 + 失败/错误请求数」打出来，
    // 否则永远只能看到一句笼统文案（2026-09-27 之前的实际状况）。
    try {
      console.error('[probe] reference-image probe failed: '
        + `code=${error?.code || 'none'} reason=${reasonCode} `
        + `message=${String(error?.message || error).slice(0, 200)} `
        + `diagnostic=${JSON.stringify(diagnostic.snapshot(reasonCode === null ? 'REFERENCE_IMAGE_PROBE_ERROR' : reasonCode))}`);
    } catch { /* 日志不能影响探测返回 */ }
    return {
      ok: false,
      state: referenceImageCapabilityState(error),
      pageLoaded: navigated,
      reason: reasonCode,
      diagnostic: diagnostic.snapshot(reasonCode === null ? 'REFERENCE_IMAGE_PROBE_ERROR' : reasonCode),
      error: failureMessage,
      controls: error?.controls || undefined,
    };
  } finally {
    diagnostic.dispose();
    clearTimeout(deadlineTimer);
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    releaseAccountBrowserLock?.();
  }
}

export const DOLA_LOGIN_OPTIONS = ['line', 'google', 'phone_verify_code', 'apple', 'facebook', 'qrcode'];
