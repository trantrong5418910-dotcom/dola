/**
 * `manual-login-browser.js` 的启动器单元测试。
 *
 * 回归目标（2026-09-29 生产事故「后台点手动登录弹不出浏览器」的两个根因）：
 *  ① Linux 上把可执行文件写死成 `/usr/bin/google-chrome`，而生产机只装了
 *    Playwright 自带的 chromium → spawn ENOENT；
 *  ② 该错误被 `stdio: ignore` + 空的 error 回调吞掉，界面只剩一句通用失败。
 *
 * 这里只测**路径退让顺序**（纯函数），不启动任何浏览器。
 * Run: node --test test/manual-login-browser-launcher.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeExecutable, proxyArgsFor } from '../server/dola/manual-login-browser.js';

const NODE = process.execPath;                                  // 一定存在的真实文件
const MISSING = '/nonexistent/definitely-not-here/chrome';
const bundled = path => ({ chromium: { executablePath: () => path } });
// `t.skip()` 只是打标记、**不会中断执行**，所以必须配合 `return` 使用。
const skipUnlessLinux = t => {
  if (process.platform === 'linux') return false;
  t.skip('这条退让顺序只在 Linux 上成立');
  return true;
};

test('CHROME_PATH wins over every other candidate', () => {
  process.env.CHROME_PATH = '/tmp/synthetic-chrome-override';
  try { assert.equal(chromeExecutable(bundled(NODE)), '/tmp/synthetic-chrome-override'); }
  finally { delete process.env.CHROME_PATH; }
});

test('a blank CHROME_PATH is ignored rather than used as an executable', () => {
  process.env.CHROME_PATH = '   ';
  try { assert.notEqual(chromeExecutable(bundled(MISSING)), '   '); }
  finally { delete process.env.CHROME_PATH; }
});

test('on Linux the bundled Playwright browser beats the hardcoded system path', t => {
  if (skipUnlessLinux(t)) return;
  assert.equal(chromeExecutable(bundled(NODE)), NODE);
});

test('a bundled path that does not exist is not trusted', t => {
  if (skipUnlessLinux(t)) return;
  assert.notEqual(chromeExecutable(bundled(MISSING)), MISSING);
});

test('a throwing executablePath probe degrades instead of crashing the launch', () => {
  const resolved = chromeExecutable({ chromium: { executablePath: () => { throw new Error('no browsers installed'); } } });
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.length > 0);
});

test('a missing playwright dependency still yields a diagnosable path', () => {
  const resolved = chromeExecutable(undefined);
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.length > 0);
});

/**
 * 出口代理参数（2026-09-29 补齐的第二个生产根因）。
 *
 * 直连当天被开成**默认兜底**（号池里没有可用 IPWeb 模板时 resolveProxy 返回
 * DIRECT_LOGIN_PROXY 哨兵 → 驱动把 proxy 置为 undefined）。而 manual 分支的旧守卫
 * 写的是 `if (!proxy?.server || …)`，把「直连」误判成「不支持的代理」，
 * 于是「直连账号 + 独立窗口手动登录」必定抛 manual_browser_proxy_unsupported，
 * 窗口永远不出现。下面四条把这个边界钉死。
 */
test('an absent proxy means direct connection, not an error', () => {
  assert.deepEqual(proxyArgsFor(undefined), []);
  assert.deepEqual(proxyArgsFor(null), []);
});

test('a credential-free proxy becomes a single --proxy-server argument', () => {
  assert.deepEqual(proxyArgsFor({ server: 'http://127.0.0.1:8899' }),
    ['--proxy-server=http://127.0.0.1:8899']);
});

test('a credentialed proxy is rejected: the command line would silently drop it', () => {
  const credentialed = { server: 'http://gate2.ipweb.cc:7778', username: 'u', password: 'p' };
  assert.throws(() => proxyArgsFor(credentialed), /manual_browser_proxy_unsupported/);
  assert.throws(() => proxyArgsFor({ server: 'http://gate2.ipweb.cc:7778', username: 'u' }),
    /manual_browser_proxy_unsupported/);
});

test('a malformed proxy object fails closed instead of degrading to direct', () => {
  assert.throws(() => proxyArgsFor({}), /manual_browser_proxy_unsupported/);
  assert.throws(() => proxyArgsFor({ server: '' }), /manual_browser_proxy_unsupported/);
});
