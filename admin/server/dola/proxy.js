/**
 * 出口代理：解析、生成、以及"让 HTTP 调用也走同一条代理"。
 *
 * ## 为什么 HTTP 调用也必须走代理（一开始漏了，是个真问题）
 *
 * 提交生成走的是浏览器（会带上账号的代理），但**轮询 `/im/chain/single` 用的是
 * 服务端自己的 fetch** —— 默认走本机出口 IP。于是同一个账号会在极短时间内
 * 从**两个完全不同的 IP** 出现：
 *
 *     浏览器提交   →  韩国住宅 IP（代理）
 *     30 秒后轮询  →  机房 IP（本机）
 *
 * 对风控来说这是比"一直用同一个机房 IP"更可疑的信号 —— 一个真实用户不会
 * 在 30 秒内从韩国住宅跳到中国机房。所以轮询、健康检查这些调用也得走同一条代理。
 *
 * ## 实现
 * Node 内置 fetch（undici）支持自定义 dispatcher，用 undici 的 ProxyAgent
 * 就能让 fetch 走 HTTP/SOCKS 代理。ProxyAgent 按 URL 缓存，避免每次请求重建连接池。
 *
 * ## 什么**不**走代理
 * 成片归档下载（`.../video/tos/...`）**不走代理** —— 那是带签名的直链，
 * 跟账号 IP 无关，而且视频动辄几十 MB，走住宅代理会白白烧流量费（按 GB 计费）。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// ---------------------------------------------------------------- 解析

/**
 * 从「账号行」或「代理字符串」里取出代理 URL。
 *
 * ⚠️⚠️ 这里踩过一个**会让所有账号突然不可用**的坑，务必注意写法：
 *
 *     const raw = String(acc?.proxy || acc || '').trim();   // ❌ 错！
 *
 * 当 `acc.proxy === ''`（没配代理，falsy）时，`||` 会**回落到 `acc` 整个对象**，
 * `String(账号对象)` 得到字面量 `"[object Object]"` —— 一个非空字符串，
 * 于是被当成合法的代理地址传下去，undici 拿它建 ProxyAgent，**所有请求全军覆没**。
 * 症状是"号明明是活的，但生成前体检一律失败"，错误信息还会显示成别的样子。
 *
 * 正确写法：先判断类型，再单独取值，**不要用 `||` 串联不同语义的表达式**。
 */
function pickProxyString(acc) {
  const raw = typeof acc === 'string' ? acc : (acc?.proxy ?? '');
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // 第二道防线：值必须长得像代理 URL。脏值（比如上面那种 "[object Object]"）
  // 一旦被当代理用，会让**所有**请求失败且错误信息指向别处 —— 宁可不走代理也要吼出来。
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    console.warn(`[proxy] 账号 #${acc?.id ?? '?'} 的 proxy 字段不像代理地址，本次按"无代理"处理：${s.slice(0, 60)}`);
    return '';
  }
  return s;
}

/**
 * 账号行上的 `proxy` 字段 → Playwright 要的 proxy 对象。
 * 空值/无效值返回 undefined（= 走本机出口）。
 */
export function proxyOf(acc) {
  const raw = pickProxyString(acc);
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const proxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return undefined;
  }
}

/** 账号行上的 `proxy` 字段 → 原始 URL 字符串（给 fetch 用）；没配就返回 null */
export function proxyUrlOf(acc) {
  return pickProxyString(acc) || null;
}

// ---------------------------------------------------------------- undici dispatcher（带缓存）

const AGENTS = new Map();

/**
 * 取（或建）某条代理的 dispatcher。
 * 缓存是必须的：ProxyAgent 内部维护连接池，每次请求新建会导致
 * 频繁 TCP+TLS 握手（一次生成要轮询十几轮，白白慢一截）。
 */
export function dispatcherFor(proxyUrl) {
  const key = String(proxyUrl || '').trim();
  if (!key) return undefined;
  let agent = AGENTS.get(key);
  if (!agent) {
    agent = new ProxyAgent({ uri: key, connections: 4 });
    AGENTS.set(key, agent);
  }
  return agent;
}

/** 列出已缓存的代理（调试用） */
export function cachedProxies() {
  return [...AGENTS.keys()];
}

/**
 * 走指定代理的 fetch。不传 proxy 时等价于普通 fetch。
 *
 * ⚠️⚠️ 必须用 **undici 自带的 fetch**，不能用全局 `fetch` ——
 * 那是两份额外的实现：Node 内置的 undici（本机 6.24.1）vs `node_modules` 里装的
 * undici（8.10.2）。把 npm 版的 ProxyAgent 交给内置 fetch，接口对不上，
 * 会报 **`invalid onRequestStart method`（UND_ERR_INVALID_ARG）**。
 * 这个错还会被 fetch 包成一句笼统的 `fetch failed`，看起来像"代理不通"，
 * 极难定位 —— 实测把整个"代理验证"功能判成全部失败。
 *
 * @param {string} url
 * @param {object} [init]  标准 fetch 参数
 * @param {string|null} [proxy] 代理 URL（http:// 或 socks5://）
 */
export function fetchVia(url, init = {}, proxy = null) {
  const d = dispatcherFor(proxy);
  // 不挂代理时用全局 fetch 也行，但统一用同一份实现更不容易再踩上面的坑
  return (d ? undiciFetch : fetch)(url, d ? { ...init, dispatcher: d } : init);
}

// ---------------------------------------------------------------- IPWeb 自编代理

/**
 * IPWeb 代理账号的结构（见 https://docs.ipweb.cc/user-guide/）：
 *
 *   代理服务器:端口:代理账号:密码
 *   gate1.ipweb.cc:7778:B_36307_US_1474_10748_5_Ab000001:123456
 *                       └─用户编号─┘└国家┘└州┘└城市┘│ └──SID──┘
 *                                              持续分钟
 *
 * 关键点：**账号是"自编"的，不需要调 API 生成**。
 * 只要改 SID 就能得到一条全新的代理，而**同一个 SID 固定同一个出口 IP**
 * （在 IP 持续时间内）。所以"每账号一个固定出口 IP"用自编就够了 ——
 * 不用去后台点几千次"生成代理"。
 *
 * 网关节点（入口，出口由国家代码决定；选近的延迟低）：
 *   gate1 = 美洲 / gate2 = 亚太（含大洋洲）/ gate3 = 欧洲及非洲
 *
 * 国家代码：US / HK / KR / JP …；填 `000` = 全球随机。
 * 州、城市代码可留空（表示不限）。
 */
export const IPWEB_GATEWAYS = {
  americas: 'gate1.ipweb.cc',
  apac: 'gate2.ipweb.cc',
  emea: 'gate3.ipweb.cc',
};

/**
 * 从账号 id 派生一个**稳定**的 SID。
 *
 * 为什么要稳定：SID 决定出口 IP，如果每次重启都换 SID，
 * 同一个 dola 账号就会不停换 IP —— 那代理就白配了。
 * 所以由 id 确定性派生（8 位，只用字母数字，符合 IPWeb 的字符要求）。
 *
 * ⚠️ 为什么有 `attempt`：SID 不同**不代表出口 IP 一定不同** ——
 * 实测 13 个号里有 3 对撞了同一个 IP（同一个城市可用的住宅 IP 是有限的）。
 * 两个账号共用出口 IP 就等于没隔离，所以撞了要换个 SID 重试。
 * attempt=0 是主 SID（稳定），1..N 是去重时的变体。
 *
 * @param {number} accountId
 * @param {number} [attempt=0] 0=主 SID；>0 表示第几次去重重试
 */
export function sidForAccount(accountId, attempt = 0) {
  const n = Number(accountId) || 0;
  if (!attempt) return `D${String(n).padStart(7, '0')}`.slice(0, 8);
  // 去掉容易看错的 0/O/1/I，避免以后手工核对时认错
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = attempt - 1;
  const ch = LETTERS[a % LETTERS.length];
  const digit = Math.floor(a / LETTERS.length) % 10;
  return `D${String(n).padStart(5, '0')}${ch}${digit}`.slice(0, 8);
}

/**
 * IPWeb 的端口 7778 **同时支持 HTTP 和 SOCKS5**，但实测：
 *
 *   ❌ `http://user:pass@gate2.ipweb.cc:7778`  → 带凭据就被**静默关闭**（HTTP 000）
 *   ✅ `socks5://user:pass@gate2.ipweb.cc:7778` → 正常，出口是真韩国住宅 IP
 *                                                （59.11.7.251 / Korea Telecom）
 *
 * 不带凭据的裸 GET 会正常回 `407 Proxy Authentication Required`，
 * 说明网关通、只是 HTTP 代理模式那边不接受我们的认证。
 * 既然 SOCKS5 能用就别在 HTTP 模式上耗 —— Playwright 和 undici 都支持 socks5。
 */
export const IPWEB_SCHEME = 'socks5';

/**
 * 生成一条 IPWeb 自编代理 URL。
 *
 * @param {object} p
 * @param {string} p.account  用户编号，形如 B_36307
 * @param {string} p.password 代理密码
 * @param {string} [p.country='KR'] 国家代码；`000` = 全球随机
 * @param {string} [p.state='']     州代码（可空）
 * @param {string} [p.city='']      城市代码（可空）
 * @param {number} [p.minutes=30]   IP 持续时间（分钟，上限 30）
 * @param {string} p.sid            SID（8 位字母数字）
 * @param {string} [p.gateway]      网关域名，默认亚太
 */
export function buildIpwebProxy({
  account, password, country = 'KR', state = '', city = '', minutes = 30, sid, gateway = IPWEB_GATEWAYS.apac,
}) {
  const acc = String(account || '').trim();
  if (!/^B_\d+$/i.test(acc)) throw new Error(`IPWeb 用户编号格式不对：${acc}（应形如 B_36307）`);
  if (!password) throw new Error('缺少代理密码');
  const sidStr = String(sid || '').trim();
  if (!/^[A-Za-z0-9]{8}$/.test(sidStr)) throw new Error(`SID 必须是 8 位字母或数字：${sidStr}`);
  const mins = Math.max(1, Math.min(30, Math.round(Number(minutes) || 30)));

  // 各段用 '_' 连接；州/城市留空就形成连续下划线，这是 IPWeb 允许的写法
  const username = [acc, String(country).toUpperCase(), String(state), String(city), String(mins), sidStr].join('_');
  return `${IPWEB_SCHEME}://${username}:${encodeURIComponent(password)}@${gateway}:7778`;
}

/** 把代理 URL 里的密码打码，方便写日志/审计 */
export function maskProxy(url) {
  return String(url || '').replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
}

// ---------------------------------------------------------------- 解析 IPWeb 后台导出的行

/**
 * 解析 IPWeb 后台「导出」出来的一行代理信息。
 *
 * 后台导出的 txt 里是**冒号分隔**的，而且顺序不唯一（官方文档里两种都列了）：
 *   gate1.ipweb.cc:7778:B_36307_US_1474_10748_5_Ab000001:123456   ← 服务器在前
 *   B_36307_US_1474_10748_5_Ab000001:123456:gate1.ipweb.cc:7778   ← 账号在前
 * 也兼容已经拼好的 `http://user:pass@host:port`。
 *
 * 做这个解析是为了让人**直接粘贴后台导出的那一行**，不用手抄用户编号和密码
 * （手抄 8 位 SID 和随机密码，错一个字符就是一条不通的代理）。
 *
 * @param {string} line
 * @returns {{account:string, password:string, country:string, state:string, city:string, minutes:number, sid:string, gateway:string, proxy:string}}
 */
export function parseIpwebExport(line) {
  const raw = String(line || '').trim();
  if (!raw) throw new Error('内容为空');

  // 已经是 URL 形式（含 socks5）
  if (/^(https?|socks[45]?):\/\//i.test(raw)) {
    const u = new URL(raw);
    const parsed = parseIpwebUsername(decodeURIComponent(u.username));
    return { ...parsed, password: decodeURIComponent(u.password), gateway: u.hostname, proxy: raw };
  }

  const parts = raw.split(':').map((s) => s.trim());
  if (parts.length !== 4) {
    throw new Error(`格式不对（期望 4 段，实际 ${parts.length} 段）：${maskProxy(raw)}`);
  }

  // 哪一段像 IPWeb 用户名？用它**在数组里的位置**判断另外几段是什么。
  //
  // ⚠️ 这里踩过一个大坑：原本用"不含点的段就是密码"来挑，结果
  //    `gate2.ipweb.cc:7778:B_...:g3Ro267Rbx` 里的 **`7778`（端口）** 也不含点，
  //    被优先当成密码 → 每条代理都拿 `7778` 去认证 → 全部 `SOCKS5_AUTH_FAILED`。
  //    而且 `--test` 手工验证时是单独传密码的，所以那边正常 —— 只有批量分配会挂，
  //    看起来像"接口的问题"，实际是解析器的问题。
  //    官方文档给的两种段序里，端口和密码**都可能是纯数字**，按内容根本分不出来，
  //    只能按位置判断。
  const uIdx = parts.findIndex((p) => /^B_\d+_/i.test(p));
  if (uIdx < 0) throw new Error(`找不到用户编号段（应形如 B_36307_KR___30_Ab000001）：${maskProxy(raw)}`);

  const username = parts[uIdx];
  let gateway, password;
  if (uIdx === 0) {
    // 官方文档的第二种排法：代理账号:密码:服务器:端口
    password = parts[1];
    gateway = parts[2];
  } else {
    // 官方文档的第一种排法：服务器:端口:代理账号:密码
    gateway = parts[0];
    password = parts[3];
  }
  if (!/\d/.test(gateway) || !/[.:]/.test(gateway)) {
    throw new Error(`网关段看起来不像地址：${gateway}`);
  }

  const parsed = parseIpwebUsername(username);
  return { ...parsed, password, gateway, proxy: `${IPWEB_SCHEME}://${username}:${encodeURIComponent(password)}@${gateway}:7778` };
}

/**
 * 解析已经保存在账号池里的 IPWeb 代理，用于服务端复用现有凭据换 SID。
 *
 * 复用模式只接受我们已验证过的 SOCKS5 网关格式，拒绝直连、HTTP 代理和
 * 任意第三方代理，避免把账号表里的普通代理误当成 IPWeb 自编代理。
 * 密码只在服务端内存中参与生成新 URL，不返回给前端。
 */
export function parseReusableIpwebProxy(rawProxy) {
  const raw = String(rawProxy || '').trim();
  let u;
  try { u = new URL(raw); } catch { throw new Error('现有代理不是可解析的 IPWeb 地址'); }
  if (u.protocol.toLowerCase() !== 'socks5:' || u.port !== '7778'
    || !/^gate[123]\.ipweb\.cc$/i.test(u.hostname)) {
    throw new Error('现有代理不是受支持的 IPWeb SOCKS5 网关');
  }
  const parsed = parseIpwebExport(raw);
  if (!parsed.password || !parsed.account || !parsed.sid) {
    throw new Error('现有 IPWeb 配置缺少必要字段');
  }
  return parsed;
}

/** 拆解 IPWeb 的代理用户名：B_36307_KR_1474_10748_5_Ab000001 */
export function parseIpwebUsername(username) {
  const parts = String(username || '').trim().split('_');
  // B, 编号, 国家, 州, 城市, 分钟, SID  → 7 段（州/城市为空时会出现连续下划线，split 后仍是空串）
  if (parts.length < 7 || !/^B$/i.test(parts[0])) {
    throw new Error(`代理用户名格式不对：${username}`);
  }
  return {
    account: `${parts[0]}_${parts[1]}`,
    country: parts[2] || '000',
    state: parts[3] || '',
    city: parts[4] || '',
    minutes: Number(parts[5]) || 30,
    sid: parts[6],
  };
}
