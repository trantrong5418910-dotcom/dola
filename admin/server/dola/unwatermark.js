/**
 * dola 无水印视频提取。
 *
 * 原理（逆向自方悦浏览器扩展「豆包 Dola 30秒去水印助手」v1.1.1 的 service-worker.js，
 * 源码留档见 ../../fangyue-evidence/service-worker.js）：
 *
 *   ① dola 的 `/im/chain/single` 消息链里，每条视频消息都带一个 `fallback_api` 字段 ——
 *      它本身就是个可再次请求的视频元信息接口（通常落在 dola.com 或 byteintlapi.com）。
 *   ② 对它**追加/改写**三个查询参数再请求一次：
 *          channel=no  codec_type=8  logo_type=unwatermarked
 *      这次返回的 `main_url` 就是**无水印**版本。
 *   ③ `main_url` 有两种形态：
 *        - 已经是 http(s) 直链 → 直接用；
 *        - 以 `qAAB` 开头的密文 token → 需要 `key_seed` 做 AES-128-CBC 解密
 *          （密钥/IV 由 key_seed 的 SHA-512 摘要 + 固定 salt 派生，见 decodeQaabToken）。
 *   ④ 图片同理：`image_ori_raw.url` 就是原图直链。
 *
 * 为什么不是"破解"：这三个参数是**服务端本来就认的**渲染选项，只是网页 UI 不暴露。
 * 属于"换个参数重新问一次"，没有绕过任何签名或鉴权 —— 仍要带该账号的有效 cookie。
 *
 * 本模块把纯函数与网络请求分开：纯函数（findFallbackApis / decodeMainUrl 等）
 * 可单测、可离线跑；extractUnwatermarked 才发请求。
 */
import { createHash, createDecipheriv } from 'node:crypto';
import { buildQuery, DOLA_HEADERS, cookieHeader } from './provider.js';

/** 允许再次请求的 fallback_api 域名白名单（防止响应里塞了外站 URL 造成 SSRF） */
export const FALLBACK_API_ROOT_HOSTS = Object.freeze(['dola.com', 'byteintlapi.com']);
export const MAX_FALLBACK_API_COUNT = 8;
export const FALLBACK_API_TIMEOUT_MS = 15000;

/** qAAB 解密用的固定 salt（从扩展源码原样搬过来） */
export const QAAB_SALT_HEX =
  '4dd4c2e6b83162090e52b3c7a6733ba4'
  + '1cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f'
  + '1f05a51892aef2949732b62a38aadd58';

// ---------------------------------------------------------------- 纯函数

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** 把可能被多层 JSON / Unicode 转义的片段还原成原始字符串 */
export function decodeJsonEscapedFragment(value) {
  let text = String(value ?? '');
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

export function isAllowedFallbackApiUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return FALLBACK_API_ROOT_HOSTS.some((root) => hostname === root || hostname.endsWith(`.${root}`));
  } catch {
    return false;
  }
}

function parseJsonString(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 递归遍历 JSON（遇到"字符串里又嵌了 JSON"也会继续钻进去） */
export function walkJsonAndStrings(value, visitor, seen = new Set()) {
  if (value == null) return;
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    if (parsed !== null) walkJsonAndStrings(parsed, visitor, seen);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJsonAndStrings(item, visitor, seen);
    return;
  }
  for (const key of Object.keys(value)) walkJsonAndStrings(value[key], visitor, seen);
}

function findValuesByKey(value, targetKey) {
  const out = [];
  walkJsonAndStrings(value, (node) => {
    if (node && typeof node === 'object' && !Array.isArray(node)
      && Object.prototype.hasOwnProperty.call(node, targetKey)) {
      out.push(node[targetKey]);
    }
  });
  return out;
}

/**
 * 从消息链 JSON（或原始响应文本）里挖出所有 fallback_api。
 * 两条路都走：结构化遍历（json 解析成功的部分）+ 正则扫原文（防止它藏在转义字符串里）。
 */
export function findFallbackApis(json, rawBody = '') {
  const apis = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    const url = decodeJsonEscapedFragment(value);
    if (isAllowedFallbackApiUrl(url)) apis.add(url);
  };

  for (const value of findValuesByKey(json, 'fallback_api')) add(value);

  const patterns = [
    /fallback_api\\":\\"(.*?)\\"/g,
    /"fallback_api"\s*:\s*"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    let m = pattern.exec(rawBody);
    while (m) {
      add(m[1]);
      m = pattern.exec(rawBody);
    }
  }

  return Array.from(apis);
}

/** 图片原图直链（通常本来就无水印） */
export function findImageOriRawUrls(json) {
  const urls = [];
  walkJsonAndStrings(json, (node) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const image = node.image_ori_raw;
      if (image && typeof image === 'object' && isHttpUrl(image.url)) urls.push(image.url);
    }
  });
  return urls;
}

/** 一份响应体里可能有多档清晰度，挑比特率/分辨率最高的那个 */
export function pickMainUrlToken(data) {
  const videoList = data?.video_list;
  const entries = videoList && typeof videoList === 'object' && Object.keys(videoList).length
    ? Object.values(videoList)
    : [data];
  let best = null;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const token = entry.main_url || entry.play_url || '';
    if (typeof token !== 'string' || !token.trim()) continue;
    const score = Number(entry.bitrate || entry.real_bitrate || 0)
      + Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
    if (!best || score > best.score) best = { token: token.trim(), score, entry };
  }
  return best ? best.token : '';
}

/** key_seed 可能藏在任意层级，或某个字符串值的 URL 参数里 */
export function findKeySeedDeep(value, depth = 0) {
  if (depth > 10 || value == null) return '';
  if (typeof value === 'string') {
    let m = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (m) return decodeURIComponent(m[1]);
    m = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
  if (typeof value !== 'object') return '';
  if (typeof value.key_seed === 'string' && value.key_seed.trim()) return value.key_seed.trim();
  for (const item of Object.values(value)) {
    const hit = findKeySeedDeep(item, depth + 1);
    if (hit) return hit;
  }
  return '';
}

/** token 可能是 base64（含 $-@# 变体字母表），也可能直接是 URL */
function base64DecodeLoose(text) {
  const input = String(text ?? '').trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, (c) => ({ $: '_', '@': '/', '#': '.' }[c])),
    input.replace(/[$@#]/g, (c) => ({ $: '+', '@': '/', '#': '=' }[c])),
  ];
  const seen = new Set();
  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const normalized = candidate.padEnd(candidate.length + ((4 - (candidate.length % 4)) % 4), '=')
        .replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(normalized, 'base64');
    } catch { /* 试下一个变体 */ }
  }
  return null;
}

function asciiUrlFromBytes(bytes) {
  if (!bytes || !bytes.length) return '';
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) return '';
  }
  return bytes.toString('latin1');
}

/** qAAB token → URL：key/iv 由 key_seed 派生，试几种切位组合 */
export function decodeQaabToken(token, keySeed) {
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed) return '';

  const digest1 = createHash('sha512').update(seed.subarray(0, 32)).digest();
  const salt = Buffer.from(QAAB_SALT_HEX, 'hex');
  const digest2 = createHash('sha512').update(Buffer.concat([digest1, salt])).digest();
  const key = digest2.subarray(0, 16);
  const iv = digest2.subarray(16, 32);

  const attempts = [];
  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push({ payload: data.subarray(4), key, iv });
    attempts.push({ payload: data.subarray(4), key: iv, iv: key });
    if (data.length > 36) {
      attempts.push({ payload: data.subarray(36), key, iv: data.subarray(20, 36) });
      attempts.push({ payload: data.subarray(36), key, iv });
    }
  } else {
    attempts.push({ payload: data, key, iv });
  }

  for (const a of attempts) {
    if (!a.payload.length || a.payload.length % 16 !== 0) continue;
    try {
      const decipher = createDecipheriv('aes-128-cbc', a.key, a.iv);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(a.payload), decipher.final()]);
      const direct = asciiUrlFromBytes(plain);
      if (isHttpUrl(direct)) return direct;
      const pad = plain[plain.length - 1];
      if (pad >= 1 && pad <= 16 && pad <= plain.length
        && plain.subarray(plain.length - pad).every((b) => b === pad)) {
        const stripped = asciiUrlFromBytes(plain.subarray(0, plain.length - pad));
        if (isHttpUrl(stripped)) return stripped;
      }
    } catch { /* 试下一组 */ }
  }
  return '';
}

/** 把 main_url token 还原成真正可下载的 URL */
export function decodeMainUrl(token, keySeed = '') {
  if (isHttpUrl(token)) return token.trim();
  const plain = asciiUrlFromBytes(base64DecodeLoose(token));
  if (isHttpUrl(plain)) return plain;
  if (String(token).startsWith('qAAB') && keySeed) return decodeQaabToken(token, keySeed);
  return '';
}

/** 从 fallback_api 里取出 data 层（响应结构见过三种包法） */
export function getVideoData(payload) {
  const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
  const data = videoInfo?.data || videoInfo;
  return data && typeof data === 'object' ? data : {};
}

export function withUnwatermarkedParams(fallbackApi) {
  const u = new URL(fallbackApi);
  u.searchParams.set('channel', 'no');
  u.searchParams.set('codec_type', '8');
  u.searchParams.set('logo_type', 'unwatermarked');
  return u.toString();
}

// ---------------------------------------------------------------- 网络

/**
 * 对一个 fallback_api 追加无水印参数并解析出可下载 URL。
 * @returns {Promise<{ok:boolean, url?:string, reason?:string, http?:number, bitrate?:number}>}
 */
export async function resolveUnwatermarkedFromFallbackApi(fallbackApi, {
  cookies = {},
  timeout = FALLBACK_API_TIMEOUT_MS,
  proxy = null,
} = {}) {
  if (!isAllowedFallbackApiUrl(fallbackApi)) return { ok: false, reason: 'host_not_allowed' };

  const url = withUnwatermarkedParams(fallbackApi);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${timeout}ms`)), timeout);
  try {
    const { fetchVia } = await import('./proxy.js');
    const res = await fetchVia(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
        // 关键：这个接口没有 cookie 也能拿，但带上更稳（部分地区会要求登录态）
        ...(Object.keys(cookies).length ? { cookie: cookieHeader(cookies) } : {}),
        referer: 'https://www.dola.com/',
        'user-agent': DOLA_HEADERS['user-agent'] || 'Mozilla/5.0',
      },
    }, proxy);
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, http: res.status };
    if (res.url && !isAllowedFallbackApiUrl(res.url)) return { ok: false, reason: 'redirected_offsite' };

    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!payload) return { ok: false, reason: 'not_json', http: res.status };

    const data = getVideoData(payload);
    const token = pickMainUrlToken(data);
    if (!token) return { ok: false, reason: 'no_main_url', http: res.status };

    const keySeed = findKeySeedDeep(payload) || new URL(url).searchParams.get('key_seed') || '';
    if (token.startsWith('qAAB') && !keySeed) return { ok: false, reason: 'qaab_without_key_seed' };

    const decoded = decodeMainUrl(token, keySeed);
    if (!decoded) return { ok: false, reason: 'decode_failed' };
    return {
      ok: true,
      url: decoded,
      http: res.status,
      tokenForm: isHttpUrl(token) ? 'plain' : (token.startsWith('qAAB') ? 'qaab' : 'base64'),
      bitrate: Number(data?.bitrate || data?.real_bitrate || 0) || undefined,
      size: Number(data?.size || data?.data_size || 0) || undefined,
      raw: payload,
    };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从一份消息链响应里提取所有无水印媒体。
 * @param {object} json     解析后的响应体
 * @param {string} rawBody  原始响应文本（可选，用于正则兜底）
 */
export async function extractUnwatermarked(json, rawBody = '', { cookies = {}, max = MAX_FALLBACK_API_COUNT, proxy = null } = {}) {
  const items = [];
  const seen = new Set();
  const add = (type, url, extra = {}) => {
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    items.push({ type, url, ...extra });
  };

  for (const url of findImageOriRawUrls(json)) add('image', url);

  const fallbackApis = findFallbackApis(json, rawBody).slice(0, max);
  const results = await Promise.all(
    fallbackApis.map((api) => resolveUnwatermarkedFromFallbackApi(api, { cookies, proxy })),
  );
  results.forEach((r, i) => {
    if (r.ok) add('video', r.url, { via: fallbackApis[i], bitrate: r.bitrate, tokenForm: r.tokenForm });
  });

  return {
    items,
    videos: items.filter((i) => i.type === 'video'),
    images: items.filter((i) => i.type === 'image'),
    fallbackApis,
    attempts: results.map((r, i) => ({ api: fallbackApis[i], ok: r.ok, reason: r.reason, http: r.http })),
  };
}

/**
 * 供复用的 IM 消息链拉取（cmd 3100）。
 *
 * ⚠️ `proxy` 不传的话会走本机出口 —— 而提交生成走的是账号的代理，
 * 同一个账号瞬间从两个 IP 出现会被风控盯上。多账号场景**必须**传账号自己的代理。
 */
export async function pullChain(conversationId, cookies, { limit = 50, region = 'JP', timeout = 25000, proxy = null } = {}) {
  const body = {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: String(conversationId),
        anchor_index: 0,
        conversation_type: 3,
        direction: 1,
        limit,
        ext: {},
        filter: { index_list: [] },
        evaluate_ab_params: '',
        evaluate_common_params: '',
      },
    },
    sequence_id: `uw-${Date.now()}`,
    channel: 2,
    version: '1',
  };
  const q = buildQuery({ region, sys_region: region });
  const url = `https://www.dola.com/im/chain/single?${q}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${timeout}ms`)), timeout);
  try {
    const { fetchVia } = await import('./proxy.js');
    const res = await fetchVia(url, {
      method: 'POST',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { ...DOLA_HEADERS, 'content-type': 'application/json; encoding=utf-8', cookie: cookieHeader(cookies) },
      body: JSON.stringify(body),
    }, proxy);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一步到位：按会话 id 拿无水印视频。
 * @returns {Promise<{ok:boolean, videos:Array, images:Array, reason?:string}>}
 */
export async function fetchUnwatermarkedByConversation(conversationId, cookies, opts = {}) {
  const chain = await pullChain(conversationId, cookies, opts);
  if (!chain.json) return { ok: false, videos: [], images: [], reason: chain.text?.slice(0, 200) || `http_${chain.status}` };
  const r = await extractUnwatermarked(chain.json, chain.text, { cookies, max: opts.max, proxy: opts.proxy });
  return { ok: r.videos.length > 0, ...r, chainStatus: chain.status };
}
