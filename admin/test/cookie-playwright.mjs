/**
 * toPlaywrightCookies 的**真实浏览器**回归 —— 不起 jsdom、不做近似。
 *
 * 为什么要真浏览器：
 *   被守的这条契约完全由 Chromium 实现（RFC 6265bis 的保留前缀校验），
 *   任何"我以为 RFC 是这么写的"的模拟都可能与真实实现不一致 —— 而这次踩坑
 *   恰恰就是"统一写 { domain: '.dola.com', path: '/' }"这种想当然。
 *   唯一可信的判据是：把 cookie 灌进真的 ctx.addCookies()，看它抛不抛。
 *
 * 守的规则（Chromium 强制）：
 *   __Host-  → 必须 secure=true，且**不能带 domain**（host-only，只能用 url）
 *   __Secure-→ 必须 secure=true
 *
 * 本测试用合成 cookie，不含任何真实凭据，不访问网络（只新建 about:blank 上下文）。
 * 若本机没有 Chromium，整个套件 skip 而不是 fail —— 避免在无浏览器的 CI 上制造假红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const DOLA_BASE = 'https://www.dola.com';
const { toPlaywrightCookies } = await import('../server/dola/provider.js');

/** 起一个真实 Chromium 上下文；不可用则返回 null（触发 skip）。 */
async function withChromium(fn) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { skipped: 'playwright 未安装' };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return { skipped: `Chromium 不可用：${String(error?.message || error).slice(0, 120)}` };
  }
  try {
    const ctx = await browser.newContext();
    return { result: await fn(ctx) };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 模拟参考站账号 #419 那一类 cookie：字节 passport + Google OAuth + Dola 产品会话。 */
const GOOGLE_LOGIN_SAMPLE = {
  sessionid: 'synthetic-sessionid',
  sid_tt: 'synthetic-sid-tt',
  uid_tt: 'synthetic-uid-tt',
  ttwid: 'synthetic-ttwid',
  odin_tt: 'synthetic-odin-tt',
  passport_csrf_token: 'synthetic-csrf',
  flow_cur_user_sec_id: 'synthetic-sec-id',
  'SID': 'synthetic-google-sid',
  'HSID': 'synthetic-google-hsid',
  'LSID': 'synthetic-google-lsid',
  '__Secure-1PSID': 'synthetic-secure-1psid',
  '__Secure-3PSID': 'synthetic-secure-3psid',
  '__Host-GAPS': 'synthetic-host-gaps',
};

test('真实 Chromium：旧写法（一刀切 domain）对 __Host- cookie 会抛异常', async (t) => {
  const { result, skipped } = await withChromium(async (ctx) => {
    // 修复前的写法，逐字复刻
    const legacy = Object.entries(GOOGLE_LOGIN_SAMPLE).map(([name, value]) => ({
      name, value, domain: '.dola.com', path: '/',
    }));
    try {
      await ctx.addCookies(legacy);
      return { threw: false };
    } catch (error) {
      return { threw: true, message: String(error?.message || error) };
    }
  });
  if (skipped) return t.skip(skipped);

  // 这是"修复前确实坏掉"的证据。若将来 Chromium 放宽了校验、这里变绿，
  // 不要删掉断言 —— 那意味着这条修复的必要性需要重新评估，而不是"可以简化"。
  assert.equal(result.threw, true, '旧写法必须抛，否则说明 Chromium 已放宽保留前缀校验');
  assert.match(result.message, /Invalid cookie fields|cookie/i);
});

test('真实 Chromium：toPlaywrightCookies 的输出必须被 ctx.addCookies 接受', async (t) => {
  const { result, skipped } = await withChromium(async (ctx) => {
    await ctx.addCookies(toPlaywrightCookies(GOOGLE_LOGIN_SAMPLE));
    const landed = await ctx.cookies();
    return landed;
  });
  if (skipped) return t.skip(skipped);

  const byName = new Map(result.map((c) => [c.name, c]));
  // 一个都不能少 —— addCookies 是整体接受或整体失败，但我们仍逐条确认落盘
  for (const name of Object.keys(GOOGLE_LOGIN_SAMPLE)) {
    assert.ok(byName.has(name), `cookie ${name} 应已写入上下文`);
  }
  // 关键登录字段必须真的到了 dola.com
  assert.equal(byName.get('flow_cur_user_sec_id').value, 'synthetic-sec-id');
});

test('保留前缀映射符合 Chromium 强制的形状（不经浏览器也能判）', () => {
  const list = toPlaywrightCookies(GOOGLE_LOGIN_SAMPLE);
  const byName = new Map(list.map((c) => [c.name, c]));

  // __Host- ：必须 secure，且**不能有 domain**（带 domain 会被 Chromium 拒）
  const host = byName.get('__Host-GAPS');
  assert.equal(host.secure, true, '__Host- 必须 secure');
  assert.equal('domain' in host, false, '__Host- 不能带 domain（host-only）');
  assert.ok(host.url, '__Host- 必须靠 url 指定作用域');
  assert.equal(host.url, `${DOLA_BASE}/`);

  // __Secure- ：必须 secure，可以带 domain
  for (const name of ['__Secure-1PSID', '__Secure-3PSID']) {
    const c = byName.get(name);
    assert.equal(c.secure, true, `${name} 必须 secure`);
    assert.equal(c.domain, '.dola.com');
  }

  // 普通 cookie：保持历史行为不变
  const plain = byName.get('sessionid');
  assert.deepEqual(plain, { name: 'sessionid', value: 'synthetic-sessionid', domain: '.dola.com', path: '/' });

  // Playwright 不允许 url 与 domain/path 同时出现 —— 逐条守住
  for (const c of list) {
    if (c.url) assert.equal('domain' in c || 'path' in c, false, `带 url 的 ${c.name} 不该再有 domain/path`);
    else assert.ok(c.domain && c.path, `${c.name} 缺 domain/path 会被 Playwright 报 "either url or path"`);
  }
});

test('边界输入不得造出畸形 cookie', () => {
  assert.deepEqual(toPlaywrightCookies(null), []);
  assert.deepEqual(toPlaywrightCookies(undefined), []);
  assert.deepEqual(toPlaywrightCookies({}), []);

  // 非字符串值 / 空名字必须被滤掉：Chromium 会因为 value 不是字符串整批拒绝
  const filtered = toPlaywrightCookies({ good: 'v', bad: 123, alsoBad: null, '': 'x' });
  assert.deepEqual(filtered.map((c) => c.name), ['good']);

  // 值为空字符串是**合法**的（cookie 允许空值），不能被当成"没有"而丢掉
  const empty = toPlaywrightCookies({ 'ttwid': '' });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].value, '');
});

test('全量真实样本：12 条 cookie 灌进 Chromium 一条不丢', async (t) => {
  const { result, skipped } = await withChromium(async (ctx) => {
    const list = toPlaywrightCookies(GOOGLE_LOGIN_SAMPLE);
    await ctx.addCookies(list);
    return { list, landed: await ctx.cookies() };
  });
  if (skipped) return t.skip(skipped);

  assert.equal(result.list.length, Object.keys(GOOGLE_LOGIN_SAMPLE).length);
  assert.equal(result.landed.length, result.list.length, '写入条数应与请求条数一致');
});
