import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIpwebProxy,
  parseReusableIpwebProxy,
} from '../server/dola/proxy.js';

test('existing IPWeb SOCKS5 config can be reused with a new SID without exposing the password', () => {
  const current = 'socks5://B_36307_KR___30_Ab000001:p%40ss@gate2.ipweb.cc:7778';
  const parsed = parseReusableIpwebProxy(current);
  assert.deepEqual({
    account: parsed.account,
    country: parsed.country,
    state: parsed.state,
    city: parsed.city,
    minutes: parsed.minutes,
    gateway: parsed.gateway,
  }, {
    account: 'B_36307', country: 'KR', state: '', city: '', minutes: 30, gateway: 'gate2.ipweb.cc',
  });
  const next = buildIpwebProxy({ ...parsed, sid: 'D000017A' });
  assert.match(next, /^socks5:\/\/B_36307_KR___30_D000017A:p%40ss@gate2\.ipweb\.cc:7778$/);
  assert.ok(!next.includes('p@ss'));
});

test('reuse mode rejects direct, HTTP and non-IPWeb proxy strings', () => {
  for (const raw of [
    '',
    'http://B_36307_KR___30_Ab000001:p%40ss@gate2.ipweb.cc:7778',
    'socks5://B_36307_KR___30_Ab000001:p%40ss@example.com:7778',
  ]) {
    assert.throws(() => parseReusableIpwebProxy(raw), /现有代理/);
  }
});
