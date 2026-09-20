/**
 * 统一错误类型。上层只管 catch 这些，不用关心底层是 HTTP 401 还是业务 code=0。
 */

export class VideoProviderError extends Error {
  constructor(message, { code = null, status = null, url = null, raw = null, cause = null } = {}) {
    super(message);
    this.name = 'VideoProviderError';
    this.code = code;
    this.status = status;
    this.url = url;
    this.raw = raw;
    if (cause) this.cause = cause;
  }
}

/** 未登录 / 凭据无效 / 令牌被禁用 —— 需要重新 login */
export class AuthError extends VideoProviderError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

/** CSRF 校验失败（实测：403 + {"code":"0","message":"请求校验失败"}） */
export class CsrfError extends VideoProviderError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'CsrfError';
  }
}

/** 积分不足、参数非法等业务失败 */
export class BusinessError extends VideoProviderError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'BusinessError';
  }
}

/** 轮询超时：任务既没成功也没失败 */
export class TimeoutError extends VideoProviderError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'TimeoutError';
  }
}

/** 任务终态为 failed */
export class TaskFailedError extends VideoProviderError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'TaskFailedError';
  }
}

export class ConfigError extends VideoProviderError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ConfigError';
  }
}
