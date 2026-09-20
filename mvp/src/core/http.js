/**
 * 极简 HTTP 客户端：只做三件 Node 内置 fetch 不做的事
 *   1. Cookie 持久化（Node fetch 默认丢掉 Set-Cookie）
 *   2. 统一判定业务失败（响应体 code === "0" 视为失败）
 *   3. 把 401 / 403 翻译成具体错误类型
 * 零外部依赖，Node >= 20.11 直接用。
 */
import { AuthError, CsrfError, BusinessError, VideoProviderError } from './errors.js';

export class CookieJar {
  constructor() {
    this.store = new Map(); // name -> {value, attrs}
  }

  /** 解析并合并 Set-Cookie（可能是数组） */
  absorb(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of list) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      const meta = { value, path: '/', secure: false };
      for (const a of attrs) {
        const [k, v] = a.split('=');
        if (k.toLowerCase() === 'path') meta.path = v || '/';
        if (k.toLowerCase() === 'secure') meta.secure = true;
        if (k.toLowerCase() === 'max-age' && Number(v) <= 0) meta.expired = true;
      }
      if (meta.expired) this.store.delete(name);
      else this.store.set(name, meta);
    }
  }

  /** 按请求路径拼 Cookie 头（只做最粗的 path 前缀匹配，够用） */
  headerFor(urlPath = '/') {
    const parts = [];
    for (const [name, meta] of this.store) {
      if (urlPath.startsWith(meta.path)) parts.push(`${name}=${meta.value}`);
    }
    return parts.join('; ');
  }

  get(name) {
    return this.store.get(name)?.value ?? null;
  }

  clear() {
    this.store.clear();
  }

  toJSON() {
    return [...this.store.entries()].map(([name, m]) => ({ name, value: m.value, path: m.path }));
  }
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {number} [opts.timeout] ms，默认 60s
   * @param {boolean} [opts.insecure] 跳过 TLS 校验（自签/裸 IP 证书场景）
   * @param {(evt:object)=>void} [opts.onTrace] 调试钩子
   */
  constructor({ baseUrl, timeout = 60_000, insecure = false, onTrace = null } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeout = timeout;
    this.insecure = insecure;
    this.onTrace = onTrace;
    this.jar = new CookieJar();
    /** 请求发送前调用，用来注入 CSRF 等动态头 */
    this.headerHook = null;
  }

  _trace(evt) {
    if (this.onTrace) this.onTrace(evt);
  }

  async request(method, path, { body = undefined, headers = {}, isJson = false, signal = null, rawResponse = false } = {}) {
    const url = this.baseUrl + path;
    const finalHeaders = { ...(this.headerHook ? await this.headerHook(method, path) : null), ...headers };

    const cookie = this.jar.headerFor(path);
    if (cookie) finalHeaders.Cookie = cookie;

    // 只有非 FormData / 非 undefined 的普通对象才自动 JSON 化
    let payload = body;
    if (body != null && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob) && !Buffer.isBuffer(body) && !isJson) {
      payload = JSON.stringify(body);
      if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) finalHeaders['Content-Type'] = 'application/json';
    } else if (body != null && typeof body === 'string' && isJson) {
      if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) finalHeaders['Content-Type'] = 'application/json';
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`请求超时 ${this.timeout}ms`)), this.timeout);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });

    const started = Date.now();
    if (this.insecure && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
      // Node 的 fetch 不支持按请求关 TLS 校验；只能在进程级放开。
      // 注意：Node 在加载 TLS 模块时就读了这个变量，最稳的是启动前设：
      //   NODE_TLS_REJECT_UNAUTHORIZED=0 node src/cli.js ...
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      this._trace({ phase: 'warn', message: 'insecure=true：已请求放开 TLS 校验，建议直接用 NODE_TLS_REJECT_UNAUTHORIZED=0 启动' });
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      this._trace({ phase: 'network-error', method, url: path, error: String(e), ms: Date.now() - started });
      throw new VideoProviderError(`网络请求失败：${e.message}`, { url: path, cause: e });
    }
    clearTimeout(timer);

    this.jar.absorb(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : res.headers.get('set-cookie'));

    const text = await res.text();
    this._trace({ phase: 'response', method, url: path, status: res.status, ms: Date.now() - started, body: text.slice(0, 2000) });

    if (rawResponse) return { status: res.status, headers: res.headers, text, body: text };

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON（比如直链下载视频），原样返回
      return { status: res.status, headers: res.headers, text, body: text, json: null };
    }

    // ---- 统一失败判定：HTTP 非 2xx，或业务 code === "0" ----
    const businessFail = json && String(json.code) === '0';
    if (!res.ok || businessFail) {
      const message = json?.message || `HTTP ${res.status}`;
      if (res.status === 401 || /请先登录|登录凭据无效|令牌无效或已禁用/.test(message)) {
        throw new AuthError(message, { code: json?.code ?? null, status: res.status, url: path, raw: json });
      }
      if (res.status === 403 || message === '请求校验失败') {
        throw new CsrfError(message, { code: json?.code ?? null, status: res.status, url: path, raw: json });
      }
      throw new BusinessError(message, { code: json?.code ?? null, status: res.status, url: path, raw: json });
    }

    return { status: res.status, headers: res.headers, text, body: text, json };
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  delete(path, opts) { return this.request('DELETE', path, opts); }
}
