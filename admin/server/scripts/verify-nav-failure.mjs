/**
 * 专门验证「页面根本没打开」这条新分支 —— 全程只读、且**故意**用一个必然失败的代理。
 *
 * 为什么必须单独验：这条分支正是本轮修复的核心。修复前的代码把 page.goto 的导航异常
 * 一口吞掉（.catch(() => {})），于是：
 *   · 死代理  → 报「未确认已登录的创作页面」（谎报）
 *   · 匿名态  → 报「未确认已登录的创作页面」（真话）
 * 两者同句，导致把一个**可用账号**当成未登录去折腾 cookie，而真正坏掉的出口没人修。
 *
 * 本脚本不使用任何真实账号：cookie 与代理都是构造的，DB 一次都不碰。
 * 期望结果：reason=VIDEO_NAVIGATION_FAILED，文案含 net::ERR_*，分类为 proxy（不是 login/session）。
 */
import { probeNativeVideoViaBrowser } from '../dola/provider.js';
import { classifyFailure } from '../dola/generation-analytics.js';

// 1) 账号代理存在但连不通（discard 端口 9）→ 隧道必失败
const deadProxyUrl = 'http://127.0.0.1:9';
const cookies = { ttwid: 'synthetic-not-a-real-cookie', odin_tt: 'synthetic-not-a-real-cookie' };

let result;
try {
  result = await probeNativeVideoViaBrowser(cookies, {
    seconds: 10,
    proxy: { server: deadProxyUrl },
    proxyUrl: deadProxyUrl,
    timeout: 25000,
    // ★ 不给 accountId：用临时上下文，绝不碰生产里那个号的持久化 profile
    accountId: null,
  });
} catch (e) {
  result = { threw: true, message: String(e?.message || e).slice(0, 300) };
}

const summary = {
  ok: result.ok, state: result.state,
  reason: result.reason ?? null,
  pageLoaded: result.pageLoaded ?? null,
  diagnosticPhase: result.diagnostic?.phase ?? null,
  error: String(result.error || result.message || '').slice(0, 260),
  threw: result.threw ?? false,
};
const classified = summary.error ? classifyFailure(summary.error) : null;

console.log(JSON.stringify({ stage: 'nav-failure-probe', deadProxyUrl, summary }, null, 2));
console.log(JSON.stringify({
  stage: 'verdict',
  reasonIsNavigationFailure: summary.reason === 'VIDEO_NAVIGATION_FAILED',
  pageLoadedFalse: summary.pageLoaded === false,
  messageMentionsNetError: /net::ERR_|页面未能加载/.test(summary.error),
  messageAvoidsLoginClaim: !/未确认已登录/.test(summary.error),
  classifiedAs: classified?.code ?? null,
  classificationIsProxy: classified?.code === 'proxy',
  wouldCreateAccountGuard: false,   // proxy 无作用域 → failureScope 返回 null → 不建防护
  pass: summary.reason === 'VIDEO_NAVIGATION_FAILED' && summary.pageLoaded === false
    && classified?.code === 'proxy' && !/未确认已登录/.test(summary.error),
}, null, 2));
process.exit(0);
