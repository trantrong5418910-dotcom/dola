import { randomUUID } from 'node:crypto';
import { parseAccountLoginEntries } from './account-login-format.js';

const SECRET_FIELDS = ['password', 'recoveryEmail', 'googleSessionUrl', 'verificationUrl'];
function eraseSecrets(value, remove = false) {
  if (!value) return;
  for (const key of SECRET_FIELDS) { if (remove) delete value[key]; else value[key] = ''; }
}

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const waitingMessages = {
  captcha: 'Google 显示验证码：已停止自动填写，后续账号已暂停；请在登录窗口完成，最多保留 10 分钟，不会绕过验证',
  security: 'Google 要求安全验证：已停止自动填写，后续账号已暂停；请在登录窗口处理，最多保留 10 分钟',
  browser_blocked: 'Google 不接受当前登录浏览器：后续账号已暂停，请取消批次并使用 Google 支持的登录方式；不会伪装浏览器重试',
  manual_step: '本次登录曾触发安全验证，自动填写已停止；请在窗口继续登录（密码已从自动填写内存清除），后续账号仍暂停',
  manual_login: '请在独立窗口自行选择手机号或邮箱登录 Dola；系统将核验真实会话，完成后自动入池并关闭窗口',
  identity: '密码页显示的账号未能与输入邮箱对应，请核对登录窗口；未写入号池',
  google_step: 'Google 页面需要人工继续，请查看当前登录或授权步骤；未写入号池',
  dola_entry: 'Dola 登录入口或 Google 跳转尚未就绪，已停止自动操作；请检查最后阶段，这不代表账号密码错误',
  email_form: '尚未识别 Google 邮箱输入框，请在独立窗口确认页面已加载；未写入号池',
  callback: '尚未收到 Google 登录返回，请在独立窗口继续登录；未写入号池',
  binding: '尚未确认 Google 登录与 Dola 会话对应关系，请完成返回步骤；未写入号池',
  session: 'Google 身份已确认，但 Dola 会话尚未验证成功；未写入号池',
  saved_session: '已保存会话的在线核验暂未通过，或身份与号池不一致；未重新输入密码，请取消并检查原账号，也可选择独立窗口手动重新登录',
  otp_identity: '两步验证页的账号或前序登录未能核实，已停止取码并暂停后续账号；请在窗口核对',
  otp_fetch_failed: '未取得符合格式的验证器动态码，已停止自动填写并暂停后续账号；请检查取码服务或手动输入',
  otp_refresh_exhausted: '动态码自动刷新已达上限（最多取码 3 次、提交 2 个不同码），后续账号已暂停；请在窗口处理',
  otp_not_accepted: '动态码提交后尚未确认通过，已停止自动填写并暂停后续账号；请查看登录窗口',
  otp_step_changed: '取码期间账号或验证页面发生变化，已停止填写并暂停后续账号；未写入号池',
};
const securityReasons = new Set(['captcha', 'security', 'browser_blocked', 'otp_identity',
  'otp_fetch_failed', 'otp_refresh_exhausted', 'otp_not_accepted', 'otp_step_changed']);
const progressMessages = {
  otp_submitted: '验证器动态码已提交，正在等待 Google 确认；尚未入池',
  otp_waiting_refresh: 'Google 未接受上个动态码，正在等待刷新间隔；不会连续重复提交',
  otp_same_code: '取码接口仍返回同一个动态码，暂不重复提交，等待有限刷新',
};
// Keep only one allowlisted phase in bounded batch memory, never driver text or URLs.
const stageLabels = {
  session_restore: '恢复已保存会话',
  browser_launch: '启动独立浏览器',
  proxy_check: '检查代理连通性',
  dola_home: '打开 Dola 首页',
  dola_login_button: '查找并点击 Dola 登录入口',
  dola_google_button: '查找并点击 Google 登录入口',
  google_redirect: '等待跳转至 Google',
  google_email: '填写 Google 邮箱',
  google_password: '填写 Google 密码',
  google_recovery: '填写 Google 恢复邮箱',
  email_otp: '邮件验证码验证',
  authenticator_otp: '验证器动态码验证',
  google_identity: '核验 Google 身份',
  dola_age_confirm: '确认 Dola 年龄提示',
  dola_binding: '确认 Dola 登录绑定',
  dola_session: '核验 Dola 会话',
  session_save: '保存登录会话',
  otp_submitted: '等待验证器动态码确认',
  otp_waiting_refresh: '等待验证器动态码刷新',
  otp_same_code: '等待不同的验证器动态码',
};
const failureMessages = {
  browser_closed: '登录窗口已关闭，登录未完成；未写入号池',
  credentials_rejected: 'Google 拒绝了账号或密码，请核对登录凭据；未写入号池',
  identity_mismatch: '返回的 Google 账号与输入邮箱不一致，已停止登录；未写入号池',
};
// 浏览器**启动失败**的具体原因（2026-09-29 加）。在此之前这里是一个裸 `catch`，
// 把 driver 抛出的原因码整个丢掉，运营端只剩一句「登录窗口启动失败」——
// 「手动登录窗口打不开」时一点线索都没有。下面只映射**固定原因码**，
// 不含任何上游文本 / URL / 凭据；不在表里的一律退回原来的通用文案。
const launchFailureMessages = {
  browser_missing: '运行环境缺少浏览器内核',
  manual_browser_unavailable: '本机没能启动独立窗口（未找到可用的 Chrome，或以 root 身份无法启动）',
  manual_browser_proxy_unsupported: '独立窗口需要「不带账号密码」的代理出口，而当前账号用的是带认证代理',
  manual_browser_context_missing: '独立窗口已启动但没有可用的页面上下文',
  cdp_browser_unavailable: '本机没能启动独立窗口（Chrome 未就绪）',
  cdp_browser_proxy_unsupported: '独立窗口的代理出口格式不被支持',
  cdp_context_missing: '独立窗口已启动但没有可用的页面上下文',
};
const allowedMessage = (messages, value) => typeof value === 'string' && Object.hasOwn(messages, value) ? messages[value] : '';
function withStage(item, message, last = false) {
  const label = allowedMessage(stageLabels, item.stage);
  return label ? `${message}；${last ? '最后' : '当前'}阶段：${label}` : message;
}
function stageProgress(item, fallback = '正在登录，尚未入池') {
  return allowedMessage(progressMessages, item.stage) || withStage(item, fallback);
}
const error = (message, status = 400) => Object.assign(new Error(message), { status });
export const normalizeEmail = value => String(value || '').trim().replace(/\\@/g, '@').toLowerCase();

/** Passwords are transient input, never database/job/audit fields. */
export function parseGoogleAccounts(raw) {
  if (typeof raw !== 'string' || raw.length > 32768) throw error('请输入不超过 32KB 的账号列表');
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || lines.length > 20) throw error('每批支持 1～20 个账号');
  const seen = new Set();
  return lines.map((line, index) => {
    const separator = line.indexOf('|');
    const email = normalizeEmail(line.slice(0, separator));
    const password = separator < 0 ? '' : line.slice(separator + 1);
    if (separator < 1 || !/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email) || email.length > 254
        || !password || password.length > 1024 || /[\x00-\x1f\x7f]/.test(password)) {
      throw error(`第 ${index + 1} 行格式不正确，请用 邮箱|密码`);
    }
    if (seen.has(email)) throw error(`第 ${index + 1} 行账号重复`);
    seen.add(email);
    return { email, password };
  });
}

export function matchesGoogleIdentity(identity, email) {
  return identity?.email_verified === true && Boolean(identity.sub)
    && normalizeEmail(identity.email) === normalizeEmail(email);
}

/** Only Dola cookies enter the pool. Never export Google or unrelated cookies. */
export function dolaCookieMap(cookies) {
  return Object.fromEntries((cookies || [])
    .filter(c => ['dola.com', 'www.dola.com'].includes(String(c.domain).replace(/^\./, '')) && c.name && c.value)
    .map(c => [c.name, c.value]));
}

/** Match an exact OAuth token value, never a partial substring or a guessed field. */
export function containsOAuthToken(body, token) {
  if (!token || typeof body !== 'string') return false;
  try {
    const visit = (value, depth = 0) => value === token || (depth < 5 && value && typeof value === 'object'
      && Object.values(value).some(child => visit(child, depth + 1)));
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && visit(parsed)) return true;
  } catch { /* Form-encoded requests are also used by OAuth providers. */ }
  return [...new URLSearchParams(body).values()].some(value => value === token);
}

export function authSessionMarkers(headers) {
  return Object.fromEntries((headers || []).filter(h => h.name.toLowerCase() === 'set-cookie')
    .map(h => /^\s*(sessionid|sessionid_ss|sid_tt)=([^;]+)/.exec(h.value))
    .filter(Boolean).map(match => [match[1], match[2]]));
}

export function matchesSessionBinding(cookies, markers) {
  return Boolean(markers && Object.keys(markers).length)
    && Object.entries(markers).every(([key, value]) => typeof value === 'string' && value.length > 0 && cookies?.[key] === value);
}

// Exact paths and response contract verified against Dola's public Passport SDK.
export function isGoogleAuthExchange(url, body, token) {
  if (!token || typeof body !== 'string') return false;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.origin !== 'https://www.dola.com'
        || !['/passport/web/auth/login_only/', '/passport/web/auth/login/'].includes(parsedUrl.pathname)) return false;
    let fields;
    try { fields = JSON.parse(body); } catch { fields = Object.fromEntries(new URLSearchParams(body)); }
    return fields?.access_token === token && String(fields?.platform_app_id) === '2085';
  } catch { return false; }
}

export function authExchangeSucceeded(json) {
  return json?.message === 'success' && Boolean(json.data) && typeof json.data === 'object'
    && !Array.isArray(json.data) && Object.keys(json.data).length > 0;
}

/** One isolated browser at a time; no persistent passwords, URLs, tokens or raw errors. */
export class GoogleLoginManager {
  constructor({ driver, lookupAccount, storeAccount, reserveProfiles, resolveProxy, clock = Date.now, timeoutMs = 300000, manualTimeoutMs = 600000, pollMs = 2500 }) {
    Object.assign(this, { driver, lookupAccount, storeAccount, reserveProfiles, resolveProxy, clock, timeoutMs, manualTimeoutMs, pollMs });
    this.batches = new Map();
    this.active = null;
    this.pending = new Set();
    this.closing = false;
  }

  public(batch) {
    if (!batch) return null;
    return { id: batch.id, status: batch.status, currentIndex: batch.currentIndex, createdAt: batch.createdAt,
      items: batch.items.map(({ email, status, message, accountId, accountCode, loginMethod }) => ({ email, status, message,
        ...(accountId ? { accountId } : {}), ...(accountCode ? { accountCode, loginMethod } : {}),
        ...(!accountCode && loginMethod === 'manual' ? { loginMethod } : {}) })) };
  }

  current(ownerId) {
    return this.public([...this.batches.values()].reverse().find(b => b.ownerId === ownerId));
  }

  create(raw, ownerId, { manual = false } = {}) {
    if (this.closing) throw error('登录服务正在退出，请稍后重试', 503);
    if (this.active || this.pending.size) throw error('已有登录批次正在处理或清理，请先完成或取消', 409);
    const entries = parseAccountLoginEntries(raw, { manual });
    const profiles = this.reserveProfiles ? this.reserveProfiles(entries) : [];
    const batch = { id: randomUUID(), ownerId, status: 'running', currentIndex: -1,
      createdAt: new Date(this.clock()).toISOString(), items: entries.map((entry, index) => ({ ...entry,
        ...(profiles[index]?.email === entry.email ? { profileId: profiles[index].profileId, accountCode: profiles[index].accountCode } : {}),
        status: 'queued', message: '等待独立登录窗口' })) };
    this.batches.set(batch.id, batch);
    this.active = batch;
    // Bounded metadata retention. Credentials are already erased for finished batches.
    while (this.batches.size > 20) this.batches.delete(this.batches.keys().next().value);
    this.scheduleAdvance(batch);
    return this.public(batch);
  }

  isCurrent(batch, item) {
    return this.active === batch && batch.items[batch.currentIndex] === item && !terminal.has(item.status);
  }

  recordStage(batch, item, stage) {
    if (!allowedMessage(stageLabels, stage) || !this.isCurrent(batch, item)
        || item.controller?.signal.aborted || this.clock() >= item.deadlineAt) return false;
    item.stage = stage;
    return true;
  }

  scheduleAdvance(batch) {
    setImmediate(() => {
      const operation = this.advance(batch);
      this.pending.add(operation);
      operation.finally(() => this.pending.delete(operation)).catch(() => {});
    });
  }

  async closeSession(session) {
    if (!session) return;
    const operation = Promise.resolve().then(() => session.close()).catch(() => {});
    this.pending.add(operation);
    try { await operation; } finally { this.pending.delete(operation); }
  }

  async advance(batch) {
    if (this.active !== batch || batch.securityPaused) return;
    const current = batch.items[batch.currentIndex];
    if (current && (!terminal.has(current.status) || current.cleaning)) return;
    const index = batch.items.findIndex(item => item.status === 'queued');
    if (index < 0) { batch.status = 'done'; this.active = null; return; }
    batch.currentIndex = index;
    batch.status = 'running';
    const item = batch.items[index];
    item.status = 'opening'; item.message = item.loginMethod === 'manual' ? '正在打开独立手动登录窗口' : '正在打开独立 Google 登录窗口';
    item.startedAt = this.clock();
    item.deadlineAt = item.startedAt + this.timeoutMs;
    const secret = { email: item.email, loginMethod: item.loginMethod, profileId: item.profileId, accountCode: item.accountCode,
      ...Object.fromEntries(SECRET_FIELDS.map(key => [key, item[key] || ''])) };
    eraseSecrets(item, true);
    item.controller = new AbortController();
    item.pendingSecret = secret;
    item.expiryTimer = setTimeout(() => this.expire(batch, item), this.timeoutMs);
    item.expiryTimer.unref?.();
    try {
      const account = this.lookupAccount(item.email);
      if (account?.blocked) throw error('account_unavailable');
      item.accountSnapshot = account;
      item.loginProxy = this.resolveProxy ? this.resolveProxy(item.email, account) : account?.proxy;
      const session = await this.driver.open(secret, this.resolveProxy ? { ...account, proxy: item.loginProxy } : account, {
        signal: item.controller.signal,
        onStage: stage => {
          if (this.recordStage(batch, item, stage) && item.status === 'opening') item.message = stageProgress(item);
        },
      });
      eraseSecrets(secret);
      delete item.pendingSecret;
      if (!this.isCurrent(batch, item)) { await session.close(); return; }
      item.session = session;
      if (this.clock() >= item.deadlineAt) return await this.expire(batch, item);
      item.status = 'signing_in'; item.message = stageProgress(item, item.loginMethod === 'manual' ? '请在独立窗口登录 Dola，系统将核验真实会话' : '正在尝试 Google 登录');
      item.timer = setInterval(() => this.inspect(batch, item), this.pollMs);
      item.timer.unref?.();
      await this.inspect(batch, item);
    } catch (error) {
      eraseSecrets(secret);
      delete item.pendingSecret;
      if (this.isCurrent(batch, item)) {
        if (this.clock() >= item.deadlineAt) return await this.expire(batch, item);
        this.cancelQueued(batch, '前序账号或代理启动失败，已停止后续登录并清除密码；请检查后重新提交');
        const base = '登录窗口启动失败，或账号已停用/正在使用；请检查本机浏览器及代理';
        const reason = allowedMessage(launchFailureMessages, error?.message);
        await this.finish(batch, item, 'failed', reason ? `${reason}；${base}` : base);
      }
    }
  }

  cancelQueued(batch, message) {
    for (const entry of batch.items) {
      if (entry.status !== 'queued') continue;
      eraseSecrets(entry, true);
      entry.status = 'cancelled'; entry.message = message;
    }
  }

  pauseForSecurity(batch, item) {
    // One bounded hand-off. Repeated polling/checks must not extend credential retention.
    if (batch.securityPaused) return;
    batch.securityPaused = true;
    batch.pauseDeadlineAt = this.clock() + this.manualTimeoutMs;
    item.deadlineAt = batch.pauseDeadlineAt;
    clearTimeout(item.expiryTimer);
    batch.pauseTimer = setTimeout(() => this.expire(batch, item), this.manualTimeoutMs);
    batch.pauseTimer.unref?.();
  }

  async expire(batch, item) {
    if (this.active !== batch) return;
    const security = batch.securityPaused;
    clearTimeout(batch.pauseTimer);
    batch.securityPaused = false;
    this.cancelQueued(batch, '等待超过时限，后续账号未尝试，密码已清除；需要时重新提交');
    if (this.isCurrent(batch, item)) {
      await this.finish(batch, item, 'failed', security
        ? '安全验证等待超过 10 分钟，已关闭窗口并清除整批剩余密码；没有继续尝试其他账号'
        : '等待登录超过 5 分钟，已关闭窗口并清除整批剩余密码；没有继续尝试其他账号');
    } else if (!item.cleaning) {
      batch.status = 'done'; this.active = null;
    }
  }

  inspect(batch, item) {
    // Polling may include a private-cache write. Cancellation/shutdown must wait
    // for that operation to settle before a new batch can reuse the same account.
    if (!this.isCurrent(batch, item) || item.busy) return Promise.resolve();
    const operation = this.inspectCurrent(batch, item);
    this.pending.add(operation);
    operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  async inspectCurrent(batch, item) {
    if (!this.isCurrent(batch, item) || item.busy) return;
    if (this.clock() >= item.deadlineAt) return this.expire(batch, item);
    item.busy = true;
    try {
      const result = await item.session.inspect();
      if (!this.isCurrent(batch, item)) return;
      if (this.clock() >= item.deadlineAt) {
        return await this.expire(batch, item);
      }
      this.recordStage(batch, item, result.stage);
      if (result.kind === 'ready') {
        const manualVerified = item.loginMethod === 'manual' && result.manual === true && result.identity == null
          && result.sessionVerified === true && result.profile?.ok === true && Boolean(result.profile.entityId || result.profile.id);
        if (item.loginMethod === 'manual' ? !manualVerified : (result.manual === true || !matchesGoogleIdentity(result.identity, item.email))) {
          return await this.finish(batch, item, 'failed', item.loginMethod === 'manual'
            ? '手动登录的真实 Dola 身份尚未核验通过，未入池' : '返回的 Google 账号与输入邮箱不一致或身份未验证，未入池');
        }
        item.status = 'verifying';
        // storeAccount is synchronous: cancellation cannot interleave with this commit.
        let saved;
        try {
          saved = this.storeAccount({ ...result, email: item.email, loginMethod: item.loginMethod, ownerId: batch.ownerId, snapshot: item.accountSnapshot, loginProxy: item.loginProxy });
        } catch {
          await this.finish(batch, item, 'failed', '账号池记录已变化、停用或身份重复，未覆盖原记录');
          return;
        }
        item.accountId = saved.id;
        const message = manualVerified ? 'Dola 会话已核验入池；显示邮箱为你填写的标注，不代表已核实上游邮箱绑定'
          : result.sessionReused
          ? '已通过原代理核验并复用已保存会话，没有重复输入密码；Dola 身份与原记录一致'
          : 'Google 身份与 Dola 会话已确认，登录凭据已自动入池';
        await this.finish(batch, item, 'succeeded', message + (result.loginStateSaved === true && !result.sessionReused
          ? '；独立登录状态已保存（不含密码）' : result.loginStateSaved === false ? '；登录状态保存失败，下次需重新登录' : ''));
      } else if (result.kind === 'failed') {
        await this.finish(batch, item, 'failed', allowedMessage(failureMessages, result.reason) || '登录未完成，请检查登录窗口或当前阶段；未写入号池');
      } else {
        if (result.kind === 'waiting_user' && securityReasons.has(result.reason)) {
          this.pauseForSecurity(batch, item);
        }
        item.status = result.kind === 'waiting_user' || batch.securityPaused ? 'waiting_user' : 'signing_in';
        batch.status = item.status === 'waiting_user' ? 'waiting_user' : 'running';
        item.message = item.status === 'waiting_user'
          ? withStage(item, allowedMessage(waitingMessages, result.reason || (batch.securityPaused ? 'manual_step' : '')) || '请在弹出的浏览器完成验证码、安全检查或授权，然后点击“检查登录”；不会自动处理验证或同意条款')
          : stageProgress(item);
      }
    } catch {
      if (this.isCurrent(batch, item)) {
        if (this.clock() >= item.deadlineAt) return await this.expire(batch, item);
        item.status = 'waiting_user'; batch.status = 'waiting_user';
        item.message = withStage(item, '暂未确认登录身份或会话，请检查浏览器后重试；未写入号池');
      }
    } finally { item.busy = false; }
  }

  async finish(batch, item, status, message) {
    if (!this.isCurrent(batch, item)) return;
    clearInterval(item.timer);
    clearTimeout(item.expiryTimer);
    item.cleaning = true;
    item.status = status; item.message = status === 'failed' ? withStage(item, message, true) : message; eraseSecrets(item, true);
    eraseSecrets(item.pendingSecret);
    item.controller?.abort();
    delete item.accountSnapshot;
    delete item.loginProxy;
    const session = item.session; delete item.session;
    await this.closeSession(session);
    item.cleaning = false;
    if (this.active === batch) {
      if (!batch.items.some(entry => entry.status === 'queued')) {
        clearTimeout(batch.pauseTimer);
        batch.status = 'done'; this.active = null;
      } else if (batch.securityPaused) {
        batch.status = 'paused';
      } else this.scheduleAdvance(batch);
    }
  }

  async action(id, ownerId, action) {
    const batch = this.batches.get(id);
    if (!batch || batch.ownerId !== ownerId) throw error('找不到此登录批次', 404);
    if (!['check', 'skip', 'cancel', 'resume'].includes(action)) throw error('未知登录操作');
    if (this.active !== batch) return this.public(batch);
    const item = batch.items[batch.currentIndex];
    if (action === 'cancel') {
      this.active = null; batch.status = 'cancelled';
      clearTimeout(batch.pauseTimer);
      const sessions = [];
      for (const entry of batch.items) {
        eraseSecrets(entry, true); clearInterval(entry.timer);
        clearTimeout(entry.expiryTimer);
        eraseSecrets(entry.pendingSecret);
        entry.controller?.abort();
        delete entry.accountSnapshot;
        delete entry.loginProxy;
        if (!terminal.has(entry.status)) { entry.status = 'cancelled'; entry.message = '已取消，密码已清除'; }
        if (entry.session) sessions.push(entry.session);
        delete entry.session;
      }
      // Erase every queued password before waiting for any browser cleanup.
      await Promise.all(sessions.map(session => this.closeSession(session)));
    } else if (action === 'resume') {
      if (batch.status !== 'paused' || !item || !terminal.has(item.status) || item.cleaning) {
        throw error('请先结束当前登录窗口，再明确继续剩余账号', 409);
      }
      if (this.clock() >= batch.pauseDeadlineAt) {
        await this.expire(batch, item);
      } else {
        clearTimeout(batch.pauseTimer);
        batch.securityPaused = false; batch.status = 'running';
        this.scheduleAdvance(batch);
      }
    } else if (item && action === 'skip') {
      await this.finish(batch, item, 'cancelled', '已跳过，未保存登录凭据');
    } else if (item) {
      await item.session?.focus?.().catch(() => {});
      setImmediate(() => this.inspect(batch, item));
    }
    return this.public(batch);
  }

  async preview(id, ownerId) {
    const batch = this.batches.get(id);
    if (!batch || batch.ownerId !== ownerId) throw error('找不到此登录批次', 404);
    const item = batch.items[batch.currentIndex];
    if (!item || !this.isCurrent(batch, item) || !item.session?.preview) throw error('当前没有可查看的登录窗口', 409);
    const picture = await item.session.preview();
    if (!this.isCurrent(batch, item)) throw error('登录页面已变化，请刷新批次', 409);
    return picture;
  }

  // 可交互画面（2026-09-29）：服务器上的浏览器窗口运营看不见，
  // 于是把「截图 + 尺寸」回传，由后台页面渲染成可点击的画布。
  async surface(id, ownerId) {
    const batch = this.batches.get(id);
    if (!batch || batch.ownerId !== ownerId) throw error('找不到此登录批次', 404);
    const item = batch.items[batch.currentIndex];
    if (!item || !this.isCurrent(batch, item) || !item.session?.surface) throw error('当前没有可操作的登录窗口', 409);
    const surface = await item.session.surface();
    if (!this.isCurrent(batch, item)) throw error('登录页面已变化，请刷新批次', 409);
    return surface;
  }

  // 把运营的点击 / 按键 / 文本转进真实窗口。
  // ⚠️ 故意**不写审计日志**：这里的事件可能携带账号密码，
  // 而审计表是明文落库的。批次的创建与动作已有审计，足够追溯。
  async interact(id, ownerId, event) {
    const batch = this.batches.get(id);
    if (!batch || batch.ownerId !== ownerId) throw error('找不到此登录批次', 404);
    const item = batch.items[batch.currentIndex];
    if (!item || !this.isCurrent(batch, item) || !item.session?.interact) throw error('当前没有可操作的登录窗口', 409);
    return await item.session.interact(event);
  }

  async close() {
    this.closing = true;
    if (this.active) await this.action(this.active.id, this.active.ownerId, 'cancel');
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    this.batches.clear();
  }
}
