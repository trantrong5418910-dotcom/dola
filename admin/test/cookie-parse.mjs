/**
 * parseCookies 的格式兼容回归。
 *
 * 重点守的是**包装对象**这一种：{ format, schemaVersion, ..., cookies: [...] }。
 * 它曾经被静默吃掉 —— 顶层剩下的 format/scope/cookieCount 这些标量恰好都能通过
 * RFC 6265 的 token 校验，于是被当成 cookie 装进结果里，JSON 分支拿到非空结果直接
 * 短路返回，真正的 cookie 一个都没解析到。
 * 外部症状是「导入成功，但账号缺 ttwid/odin_tt 被判 invalid」，极具误导性。
 *
 * 全部用合成数据，不接触真实 cookie、不发网络请求。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCookies, missingRequired } from '../server/dola/provider.js';

const required = { name: 'ttwid', value: 'synthetic-ttwid' };

test('包装导出对象：从内层 cookies 数组取 cookie，不把元信息当 cookie', () => {
  const wrapper = {
    format: 'dola-cookie-export',
    schemaVersion: 2,
    exportedAtUtc: '2026-01-01T00:00:00.000Z',
    scope: 'profile',
    instanceName: 'Fixture',
    instanceKind: 'Dola',
    cookieCount: 3,
    cookies: [
      required,
      { name: 'odin_tt', value: 'synthetic-odin' },
      { name: 'sessionid', value: 'synthetic-session', domain: '.dola.com', path: '/' },
    ],
  };
  const ck = parseCookies(JSON.stringify(wrapper));

  // 真正的 cookie 必须在
  assert.equal(ck.ttwid, 'synthetic-ttwid');
  assert.equal(ck.odin_tt, 'synthetic-odin');
  assert.equal(ck.sessionid, 'synthetic-session');
  // 元信息一个都不能混进来
  for (const meta of ['format', 'schemaVersion', 'exportedAtUtc', 'scope', 'instanceName', 'instanceKind', 'cookieCount']) {
    assert.equal(meta in ck, false, `元信息字段 ${meta} 不该被当成 cookie`);
  }
  // 必备项齐全 —— 这正是修复前会失败的断言
  assert.deepEqual(missingRequired(ck), []);
});

test('包装导出对象：格式化多行 JSON 也能解析', () => {
  const wrapper = { format: 'x', cookies: [required, { name: 'odin_tt', value: 'synthetic-odin' }] };
  const ck = parseCookies(JSON.stringify(wrapper, null, 2));
  assert.equal(ck.ttwid, 'synthetic-ttwid');
  assert.deepEqual(missingRequired(ck), []);
});

test('包装键名变体与 Playwright storageState 都能解析', () => {
  for (const key of ['cookies', 'cookieList', 'cookie_list']) {
    const ck = parseCookies(JSON.stringify({ [key]: [required] }));
    assert.equal(ck.ttwid, 'synthetic-ttwid', `键名 ${key} 应被识别`);
  }
  const storageState = { cookies: [required, { name: 'odin_tt', value: 'synthetic-odin' }], origins: [{ origin: 'https://www.dola.com' }] };
  const ck = parseCookies(JSON.stringify(storageState));
  assert.equal(ck.ttwid, 'synthetic-ttwid');
  assert.equal('origins' in ck, false);
});

test('裸数组 / 扁平对象 / Cookie 头 / Netscape 文件 四种老格式不回归', () => {
  const arr = parseCookies(JSON.stringify([required, { name: 'odin_tt', value: 'synthetic-odin' }]));
  assert.equal(arr.ttwid, 'synthetic-ttwid');

  const flat = parseCookies(JSON.stringify({ ttwid: 'synthetic-ttwid', odin_tt: 'synthetic-odin' }));
  assert.equal(flat.ttwid, 'synthetic-ttwid');
  assert.equal(flat.odin_tt, 'synthetic-odin');

  const header = parseCookies('ttwid=synthetic-ttwid; odin_tt=synthetic-odin');
  assert.equal(header.ttwid, 'synthetic-ttwid');
  assert.equal(header.odin_tt, 'synthetic-odin');

  // ⚠️ 这里必须用 '\t' + 'ttwid' 拼接：直接写 "…\ttwid…" 时 JS 会把 \t 当转义符吃掉，
  //    名字变成 "twid"（少一个 t），测试会以「解析不出 ttwid」的形式假失败。
  const TAB = '\t';
  const netscape = [
    '# Netscape HTTP Cookie File',
    ['.dola.com', 'TRUE', '/', 'FALSE', '0', 'ttwid', 'synthetic-ttwid'].join(TAB),
    ['.dola.com', 'TRUE', '/', 'FALSE', '0', 'odin_tt', 'synthetic-odin'].join(TAB),
  ].join('\n');
  const nc = parseCookies(netscape);
  assert.equal(nc.ttwid, 'synthetic-ttwid');
  assert.deepEqual(missingRequired(nc), []);
});

test('内层数组里没有 name 字段时，不得从这些数组里造 cookie', () => {
  // 这些数组不是 cookie 列表：不能因为「值是对象数组」就把 name/value 硬凑出来。
  // 注：扁平对象分支仍会把顶层标量（format）当 cookie，这是历史行为，
  // 只保证**不会从非 cookie 数组里凭空造出** ttwid/odin_tt 这类关键项。
  const ck = parseCookies(JSON.stringify({ format: 'x', tags: [{ id: 1 }, { id: 2 }], nothing: [] }));
  assert.equal(ck.ttwid, undefined);
  assert.equal(ck.odin_tt, undefined);
  assert.equal('id' in ck, false);
  assert.deepEqual(missingRequired(ck), ['ttwid', 'odin_tt']);
});

test('RFC 6265 名字过滤仍然生效', () => {
  const ck = parseCookies(JSON.stringify({ cookies: [{ name: 'has space', value: 'x' }, required] }));
  assert.equal('has space' in ck, false);
  assert.equal(ck.ttwid, 'synthetic-ttwid');
});
