/**
 * 兜底错误中间件（Express 的 4 参数签名）。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────────
 * 它原来写死在 `index.js` 里，而 `index.js` 一被 import 就 `app.listen()`，
 * 于是这段逻辑**只能靠"往生产上打畸形请求"来验证**，没法在本地单测。
 * 抽出来之后契约写在 `test/error-middleware.mjs` 里，改一行都能先证明再发布。
 * 行为上除了下面标注的修复点之外，与抽出来之前**完全一致**。
 *
 * ── 修的是什么（2026-09-28 压测实测：100/100 命中） ──────────────────────
 * 旧代码把**框架已经分好类**的错误一律改写成 500，顺带打全量日志：
 *   ① `body-parser` 的 `entity.parse.failed` 自带 `status=400 / statusCode=400 / expose=true`，
 *      却被抹成 500 ⇒ 客户端判「可重试」⇒ **重试风暴**（畸形 body 正是最容易被重试的那类错）；
 *   ② `console.error('[error]', err)` 输出全量 ⇒ **19 行/请求**（100 个请求灌进 1938 行日志）；
 *   ③ 同一份输出里有 `err.body`（**原始请求体**）⇒ 凭据落盘。
 *      这正是 `google-login` 那条**路径级特例**想防的事，特例之外一直在漏。
 *   而这条路径**无需任何鉴权即可触发** —— body 解析发生在 `requireApiToken` 之前。
 *
 * ── 为什么不用 err.message 当客户端文案 ──────────────────────────────────
 * Node 的 JSON 解析报错**会把请求体片段写进 message**，例如：
 *   `Unexpected token 'p', "{\"prompt\": " is not valid JSON`
 * 回显它等于换个地方泄漏同一段内容。所以解析失败类错误一律回**固定文案**。
 */

/**
 * 取出框架/中间件**已经分好类**的 HTTP 状态码。
 *
 * `body-parser` 的报错自带 `status` 与 `statusCode`（`entity.parse.failed` 是 400、
 * `entity.too.large` 是 413），Express 的其他中间件也遵循这个约定。
 * 取不到就返回 0，由调用方当作「真正的 5xx」处理。
 */
export function httpStatusOf(err) {
  const n = Number(err?.status ?? err?.statusCode);
  return Number.isInteger(n) && n >= 400 && n < 600 ? n : 0;
}

/** body-parser 常见类型 → **面向客户端**的文案（不外发它的英文原话，原因见文件头）。 */
export const PARSER_MESSAGES = Object.freeze({
  'entity.parse.failed': '请求体不是合法的 JSON',
  'entity.too.large': '请求体过大',
});

/**
 * 造一个兜底错误处理器。
 *
 * @param {{log?: (...args:any[]) => void}} [opts]
 *   `log` 默认 `console.error`。测试时注入一个收集器，就能断言**日志里没有请求体**——
 *   这是本次修复的三个坑里唯一"看不见但最贵"的那个，不注入就没法自动验。
 */
export function createErrorHandler({ log = console.error } = {}) {
  return function errorHandler(err, req, res, next) {
    // Body-parser errors carry err.body, which can contain submitted passwords.
    // Never log raw exceptions or echo parser messages on credential endpoints.
    const credentialRequest = req.path.toLowerCase().startsWith('/api/dola/google-login');
    if (credentialRequest) {
      log('[google-login] 请求失败，敏感内容已省略');
      if (res.headersSent) return next();
      return res.status(err.status >= 400 && err.status < 500 ? err.status : 500)
        .json({ ok: false, message: '登录请求格式错误或暂不可用，请检查后重试' });
    }

    const status = httpStatusOf(err);
    const clientError = status >= 400 && status < 500;
    const type = String(err?.type || err?.name || '');

    if (clientError) {
      // ★ 尊重框架分好的类，并且**只记一行元信息**（不打印 err.body、不打印堆栈）。
      //   `req.path` 而不是 `req.originalUrl`：路径里不含查询串，少一处外泄面。
      const where = `${req.method} ${String(req.path).replace(/\s+/g, ' ').slice(0, 120)}`;
      log(`[error] ${status} ${where}${type ? ` ${type}` : ''}（客户端错误，已省略请求体与堆栈）`);
      if (res.headersSent) return next(err);
      const message = PARSER_MESSAGES[type]
        || (err?.expose === true ? String(err.message || '') : '')
        || '请求格式不正确';
      return res.status(status).json({ ok: false, message });
    }

    // 真正的 5xx：保持原样（全量日志 + err.message）。**故意不动**，免得扩大爆炸半径。
    log('[error]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, message: err.message || '服务器内部错误' });
  };
}
