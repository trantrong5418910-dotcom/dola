/**
 * Offline browser regression of the production composer and admission predicate.
 * No DB, credentials, live URLs, generation or billing. Uses only synthetic DOM.
 *
 * ⚠️ 2026-09-26 重写：原先的用例表停在「20/30 秒 = 页面必须有原生档位」那个年代，
 *    跟后来的载体改写设计完全脱节，导致脚本**从加入那天起就一直红**（实测 HEAD 上
 *    第一句就挂在 `20s unchanged`：它期望 0 次点选，而代码选的是 10s 载体）。
 *    一个常年失败的脚本等于没有脚本 —— 它不会拦住任何回归，只会训练人忽略它。
 *
 * 现在的用例表按**载体契约**重排，并把新开关的两条路都覆盖到：
 *   · 原生单次（10s / 15s）：页面有档位就直接选，不改写。
 *   · 20s：载体固定 10s（历史口径）。
 *   · 30s 默认：载体 15s。服务端实测**只下发 5s/10s**，所以这条在真实页面上
 *     必然落到 `NATIVE_CAPABILITY_UNAVAILABLE` —— 这正是 30 秒死锁的形态。
 *   · 30s + `carriers:{30:10}`：改用页面真实存在的 10s 承载，且必须由
 *     `allowCarrierRewrite` 显式放行才算通过（默认关时仍不算证据）。
 *
 * 运行：`node scripts/check-native-duration-offline.mjs`（需要已安装 Playwright）。
 */
import assert from 'node:assert/strict';
import { getPlaywright } from '../server/dola/provider.js';
import { prepareNativeVideoComposer } from '../server/dola/native-capability.js';
import { isVerifiedNativeCapability } from '../server/dola/generation-policy.js';

const cases = [
  // ── 原生单次档位：页面真有的档位，选它、不改写
  { name: '10s native already selected', seconds: 10, current: '10s', options: ['5s', '10s'], clicks: 0 },
  { name: '15s expert native picked from menu', seconds: 15, current: '10s', options: ['10s', '15s'], clicks: 1 },
  { name: '20s 载体 10s 已选中，不再动菜单', seconds: 20, current: '10s', options: ['5s', '10s'], clicks: 0 },
  {
    name: '20s 载体 10s 从菜单里选出来（绝不跳到 20s 原生档）',
    seconds: 20, current: '5s', options: ['5s', '10s', '20s'], clicks: 1, expect: '10s',
  },

  // ── 30 秒默认口径：要求 15s 载体，而真实页面只有 5s/10s ⇒ 明确不可用
  {
    name: '30s 默认载体 15s：页面只有 5s/10s ⇒ 不可用（死锁形态）',
    seconds: 30, current: '5s', options: ['5s', '10s'], error: 'NATIVE_CAPABILITY_UNAVAILABLE',
  },
  {
    name: '30s 默认载体 15s：选到 15s 档也不算原生 30 秒证据',
    seconds: 30, current: '5s', options: ['5s', '15s'], clicks: 1, expect: '15s',
  },

  // ── 30 秒改写通道：载体换成页面真实存在的 10s
  {
    name: '30s 配 carriers{30:10}：用 10s 承载并放行',
    seconds: 30, carriers: { 30: 10 }, allowCarrierRewrite: true,
    current: '5s', options: ['5s', '10s'], clicks: 1, expect: '10s',
  },
  {
    name: '30s 配 carriers{30:10}：10s 已在控件上，不点菜单',
    seconds: 30, carriers: { 30: 10 }, allowCarrierRewrite: true,
    current: '10s', options: ['5s', '10s'], clicks: 0,
  },
  {
    name: '30s 配 carriers{30:10} 但未放行：载体存在也不算 30 秒证据',
    seconds: 30, carriers: { 30: 10 }, allowCarrierRewrite: false,
    current: '5s', options: ['5s', '10s'], clicks: 1, expect: '10s', admit: false,
  },

  // ── 证据不足 / 明确不可用：不能静默降级成更短的片子
  {
    name: '20s 菜单里连载体都没有 ⇒ 不可用',
    seconds: 20, current: '5s', options: ['5s'], error: 'NATIVE_CAPABILITY_UNAVAILABLE',
  },
  {
    name: '20s 载体被禁用 ⇒ 不可用，不退回更短档位',
    seconds: 20, current: '5s', options: ['5s', '10s', '20s'], disabled: '10s',
    error: 'NATIVE_CAPABILITY_UNAVAILABLE',
  },
  {
    name: '30s 合成档位不是单次档位，未放行时不算证据',
    seconds: 30, current: '5s', options: ['5s', '30s (15s ×2)'],
    error: 'NATIVE_CAPABILITY_UNAVAILABLE',
  },
];

const pw = await getPlaywright();
if (!pw?.chromium) throw new Error('Installed Playwright runtime required; no automatic installation');
const browser = await pw.chromium.launch({ headless: true, executablePath: pw.chromium.executablePath(), timeout: 15000 });
let requests = 0;
try {
  const context = await browser.newContext({ serviceWorkers: 'block', offline: true });
  await context.route('**/*', route => { requests++; return route.abort(); });
  await context.routeWebSocket('**/*', socket => socket.close());
  for (const sample of cases) {
    const page = await context.newPage();
    try {
      // `role="menu"` 是必需的：只有菜单容器被认出来，代码才能断定
      // 「这个账号确实没有该档位」而不是「菜单没渲染完」——两者报不同的错。
      await page.setContent(`<textarea aria-label="Synthetic prompt"></textarea>
        <button data-input-engine-actionbar-control-key="video-model"></button>
        <button id="duration" data-input-engine-actionbar-control-key="video-duration"></button>
        <div id="menu" role="menu" hidden></div>`);
      await page.evaluate(sample => {
        document.querySelector('[data-input-engine-actionbar-control-key="video-model"]').textContent =
          sample.seconds === 15 ? 'Seedance 2.0 Fast' : 'Seedance 2.5';
        const control = document.querySelector('#duration'), menu = document.querySelector('#menu');
        control.textContent = sample.current;
        window.syntheticSelections = [];
        control.onclick = () => {
          menu.hidden = false;
          for (const label of sample.options) {
            const option = document.createElement('button');
            option.setAttribute('role', 'menuitem'); option.textContent = label;
            if (sample.disabled === label) option.setAttribute('aria-disabled', 'true');
            option.onclick = () => {
              window.syntheticSelections.push(label);
              control.textContent = label;
              menu.hidden = true;
            };
            menu.append(option);
          }
        };
      }, sample);
      // Capture the starting DOM before exercising the actual application selectors.
      const snapshot = await page.locator('body').ariaSnapshot();
      assert.ok(snapshot.includes(sample.current));
      let capability, error;
      try {
        capability = await prepareNativeVideoComposer(page, {
          seconds: sample.seconds, timeout: 650, carriers: sample.carriers ?? null,
        });
      } catch (caught) { error = caught; }
      if (sample.error) assert.equal(error?.code, sample.error, sample.name);
      else {
        assert.equal(error, undefined, sample.name);
        const admit = isVerifiedNativeCapability(
          { ...capability, ok: true, state: 'available' },
          sample.seconds,
          { allowCarrierRewrite: sample.allowCarrierRewrite === true },
        );
        assert.equal(admit, sample.admit !== false, sample.name);
      }
      const selections = await page.evaluate(() => window.syntheticSelections);
      assert.equal(selections.length, sample.clicks || 0, sample.name);
      if (selections.length) assert.equal(selections[0], sample.expect ?? `${sample.seconds}s`, sample.name);
      assert.equal(await page.locator('textarea').inputValue(), '');
      console.log(JSON.stringify({ test: sample.name, passed: true, state: error?.code || 'native_target_confirmed' }));
    } finally { await page.close(); }
  }
  assert.equal(requests, 0, 'Synthetic page must not attempt external requests');
  console.log(JSON.stringify({ passed: cases.length, networkRequests: requests, generated: 0 }));
} finally { await browser.close(); }
