# 方悦浏览器「突破 Seedance 2.5 30 秒限制」技术分析

> 分析对象：`方悦浏览器`（Windows，安装于 `C:\Users\feige\AppData\Local\方悦浏览器`）
> 分析时间：2026-09-19
> 证据文件：`fangyue-evidence/`（扩展源码原样留档）

---

## 0. 一句话结论

**它不是"破解"，而是"伪造前端选项 + 改写请求体"。**

源码已确认扩展会提交 `duration: 30`；仅凭源码不能断言所有账号或版本的服务端都会接受。用户后续确认插件已有单次 30 秒成功案例，但本项目尚未将该案例与自有账号的真实请求及成片关联。
方悦浏览器通过一个 Chrome 扩展做了两件事：

1. 在时长下拉菜单里**造一个假的「30s」选项**骗过你的眼睛；
2. 在提交时 **monkey-patch `fetch`/`XHR`，把请求体里的 `duration` 强行改成 30**。

没有任何签名破解、没有加密绕过、没有逆向算法。核心就一行赋值：

```js
abilityParam.duration = 30;
```

---

## 1. 它是怎么实现的：一个 Chrome 扩展

方悦浏览器本体（`DolaMultiBrowser.dll`，.NET 10 + WebView2）**完全没有** `seedance` / `duration` 相关代码，
它只提供三样东西：多账号隔离的 WebView2 环境、指纹伪装（`BuildFingerprintScript`）、
每个账号独立的 sing-box 代理出口。

真正的活儿在一个**被导入的扩展**里：

```
C:\Users\feige\AppData\Local\DolaMultiBrowser\Extensions\ext-e2c1929ddbfe0fd0bdcb157b\
```

```json
{
  "manifest_version": 3,
  "name": "豆包 Dola 30秒去水印助手",
  "version": "1.1.1",
  "description": "支持 Seedance 2.0 15秒与 2.5 30秒配置，并提取豆包和 Dola 的无水印图片、视频资源。",
  "permissions": ["debugger", "tabs", "scripting", "downloads"],
  "host_permissions": ["*://*.doubao.com/*", "*://*.dola.com/*", "*://*.byteintlapi.com/*"],
  "content_scripts": [
    { "js": ["duration-main.js"], "world": "MAIN", "run_at": "document_idle" },
    { "js": ["content-panel.js"], "run_at": "document_idle" }
  ]
}
```

**扩展名字就把答案写脸上了。** 两个 `content_scripts` 分工完全不同 —— 见下。

---

## 2. 机制 A：30 秒时长解锁（`duration-main.js`，392 行）

### 2.1 第一步：UI 造一个假的「30s」选项

原生时长下拉里只有 **5s / 10s / 15s**（`dola-skill-pack-response.json` 可以佐证，默认 10s）。
扩展发现菜单里没有 30s，就**克隆「10s」那个 DOM 节点**：

```js
const clone = template.cloneNode(true);          // template = 10s 那一项
clone.setAttribute(MENU_MARK, "30");             // data-watermark-free-duration-option="30"
replaceDurationLabel(clone, 30);                 // 文字改成 "30s"
template.parentElement.appendChild(clone);       // 塞进菜单
```

点它会写 `localStorage.intl_doubao_enable_30s_v1 = "1"`，并把工具栏显示的文字改成 `30s`。

因为 SPA 会不断重渲染，它用 `setInterval(enhanceDurationOptions, 1000)` **每秒重来一遍**，
并在 0/50/120/300/800/1500/3000ms 各补一次工具栏文字。

> ⚠️ 注意：**界面上显示的「30s」是假的**。真实的下拉状态最多只能选到 15s，
> 30 只存在于 `localStorage` 的一个标记位里 —— 真正起作用的是下一步。

### 2.2 第二步（真正的关键）：改写请求体

```js
const VIDEO_COMPLETION_PATH = "/chat/completion";
const VIDEO_ABILITY_TYPE = 17;                 // 视频生成
const SEEDANCE_25_MODEL = "seedance_v2.5";

function patchBody(body, requestUrl) {
  if (!duration30Enabled() || typeof body !== "string") return body;
  if (!isVideoCompletionUrl(requestUrl)) return body;

  const payload = JSON.parse(body);
  const ability = payload?.chat_ability;
  if (Number(ability.ability_type) !== VIDEO_ABILITY_TYPE) return body;

  // ★ ability_param 是一个「JSON 字符串」
  let abilityParam = JSON.parse(ability.ability_param);
  if (abilityParam.model !== SEEDANCE_25_MODEL) return body;
  if (Number(abilityParam.duration) === 30) return body;

  abilityParam.duration = 30;                          // ← 就是这一行
  ability.ability_param = JSON.stringify(abilityParam);
  return JSON.stringify(payload);
}
```

然后挂到所有出网通道上：

```js
// fetch
window.fetch = function (input, init = {}) {
  if (init && typeof init.body === "string") {
    const body = patchBody(init.body, getRequestUrl(input));
    if (body !== init.body) init = { ...init, body };
  }
  return originalFetch.call(this, input, init);
};

// XHR
XMLHttpRequest.prototype.send = function (body) {
  return originalSend.call(this, patchBody(body, this.__watermarkFreeRequestUrl));
};
```

**只动 `seedance_v2.5`，不碰 2.0：**

```js
if (/2\.5|seedance[^\d]*2[^\d]*5/i.test(text))      lastKnownModelTarget = 30;
else if (/2\.0|seedance[^\d]*2[^\d]*0|\.\.\.fast/i.test(text)) lastKnownModelTarget = 0;  // 不改
```

这就是描述里「Seedance 2.0 **15秒**与 2.5 **30秒**」的来源 —— 2.0 的 15s 是原生就有的，2.5 的 30s 是造出来的。

---

## 3. 机制 B：无水印资源提取（`service-worker.js`，1056 行）

这部分用了 `debugger` 权限（= Chrome DevTools Protocol），比 `declarativeNetRequest` 强得多，
因为**CDP 能改写响应体**。

用 `Fetch.enable` 挂住四个接口：

| 目标 | 动作 |
|---|---|
| `*/samantha/skill/pack` | **`Fetch.fulfillRequest` 直接返回本地伪造的 JSON**（`dola-skill-pack-response.json` / `doubao-skill-pack-response.json`） |
| `*/alice/slot/action_bar_v3/get_item_conf` | 就地改写响应（`patchActionBarDuration`，递归遍历嵌套 JSON 字符串改 duration） |
| `*/im/chain/single` | 拦截**响应**，`extractUnwatermarkedItems()` 从消息体里扒出无水印图片/视频直链 |
| OPTIONS 预检 | 返回 204 + 自造 CORS 头 |

`content-panel.js` 负责在页面上画一个下载面板（`__watermarkFreeMediaPanelActive`）。

---

## 3.5 ✅ 硬证据：真实请求结构与扩展改的字段完全对得上

上面那套是**静态读代码**得出的。后来我拿一个真实 dola 账号提交了一次生成，
**服务端在消息元数据里回显了真实提交的 `chat_ability`**，原文如下（从
`/im/chain/single` 读回）：

```json
"chat_ability":"{\"ability_type\":17,\"ability_param\":\"{\\\"model\\\":\\\"seedance_v2.0\\\",\\\"duration\\\":10,\\\"input_box_content\\\":{...}}\"}"
```

剥掉转义看就是：

```json
{
  "ability_type": 17,
  "ability_param": "{"model":"seedance_v2.0","duration":10,"input_box_content":{...}}"
}
```

**结论：扩展改的三个字段（`ability_type` / `ability_param.model` / `ability_param.duration`）
与真实请求结构完全一致；`duration` 确实是嵌套 JSON 字符串里的一个普通字段。**

免费号默认走 `seedance_v2.0` + `duration: 10` —— 也就是说，
**原生提交出来就是 10 秒；改成 30 才可能出 30 秒。**

> 复现命令：`node server/dola/read-conv.mjs <conversationId> --cookie-file ./cookies.json`
> （注意 `/im/*` 接口的 Content-Type 必须带 `; encoding=utf-8`，否则报 `712012002 不支持编码类型`）

---

## 4. 三个值得记住的技术要点

### ① 命门是「JSON 里套 JSON 字符串」

```json
{ "chat_ability": { "ability_type": 17, "ability_param": "{\"model\":\"seedance_v2.5\",\"duration\":10}" } }
```

`ability_param` 是**字符串**，不是对象。这类"嵌套字符串参数"是前端改写的黄金位置 ——
因为服务端大概率不会把它拆开纳入签名校验。

### ② Manifest V3 改页面 `fetch` 必须用 `world: "MAIN"`

MV3 的 content script 默认跑在 **isolated world**，你改 `window.fetch` 只改了"自己那份"，
页面根本感觉不到。必须显式声明 `"world": "MAIN"` 才注入到页面上下文 —— 这个扩展做对了。

### ③ 用 `debugger` 权限做响应伪造

`declarativeNetRequest` 只能改请求头/URL，**改不了响应体**。
要伪造 JSON 响应就得用 CDP 的 `Fetch.fulfillRequest`，代价是扩展必须声明 `debugger` 权限
（安装时会弹"可读取和更改你访问的所有网站上的所有数据"这类警告）。

---

## 5. 所以「突破」的性质

| 常见误解 | 实际情况 |
|---|---|
| 破解了签名/加密算法 | ❌ 没碰任何签名，`a_bogus` 在 URL 上，body 不在其内 |
| 改了服务端返回的能力列表来"解锁" | ⚠️ 部分：`skill/pack` 与 `action_bar` 响应确实被本地改写，但那只是让 UI 有了选项 |
| **服务端照收前端没暴露的参数** | 待将成功任务与响应、真实成片关联；请求结构并不能证明服务器接受 |

**已验证**：请求结构（`duration` 确实是 `ability_param` 里的普通字段）、
免费号原生默认是 `duration: 10`、扩展会把 2.5 的该字段改成 30。
**未直接验证**：服务端是否对 `duration` 做白名单校验。
不能从前端下发选项推断服务端是否校验，也不能从 free/pro 推断时长能力；应核对已有成功任务，或在确认额度/费用后做一次受控生成验证。

本质是**「客户端 UI 没给，但请求层能塞」**。
这类洞见可以推广：遇到"某项功能被限制"时，先看**限制是前端做的还是后端做的** ——
如果是纯前端限制，改写请求往往就通了。

### 顺带发现的两个细节

- 扩展对 **15s 和 30s 的处理方式不同**：`service-worker.js` 的 `patchDurationSelector()`
  是把 15s **补进配置响应的 `option_list`**（改的是服务端下发的配置），
  而 30s 只能在 DOM 里造假 + 请求体硬塞。
  ⇒ 说明 15 属于"服务端支持但配置没下发"，30 属于"UI 完全不给"。
- 时长只会被写成 **30** 这一个值，且只在选中 `seedance_v2.5` 时生效；
  选 2.0 / Fast 时扩展主动不干预（`lastKnownModelTarget = 0`）。

---

## 5.5 ⚠️ 顺带实测到的一次失败

同一个免费号提交 `seedance_v2.0` + `duration: 10` 时，服务端回了：

> **视频生成失败，生成额度未扣除。**

额度没扣（这点服务端做得挺规矩），但也没生成成功。
原因文案里没给 —— 从账号侧看是 **免费号 + JP 区**，可能受区域/风控/模型可用性限制。
**所以"改 duration 能出 30 秒"这个大前提，是建立在"账号本身能正常生成"之上的**，
不是改了参数就能绕开所有限制。

---

## 6. 想自己做的话，最小复现路径

1. Chrome 里装一个 MV3 扩展；
2. `content_scripts` 声明 `world: "MAIN"`，注入一个脚本；
3. 脚本里 monkey-patch `window.fetch`，对 `/chat/completion` 的 body 做 JSON 解析；
4. 把 `chat_ability.ability_param` 解出来，改 `duration`，再塞回去；
5. （可选）再 patch 一下 UI 让用户看到 30s 选项。

**不需要** `debugger` 权限 —— 那部分是无水印提取用的，跟 30 秒无关。

---

## 7. 风险提示（照实说）

- 这类操作**违反 dola / 豆包的服务条款**，账号有被封的风险，而且封的是你花钱养的号。
- 服务端随时可以加校验（比如把 `ability_param` 纳入签名、或校验 duration 白名单），
  这个扩展就会失效 —— 事实上它版本号才 1.1.1，属于很脆的方案。
- 方悦浏览器内嵌 `sing-box` 代理 + 指纹伪装 + 每账号独立 cookie 环境，
  这套"多账号"能力本身也在对方风控的打击范围里。
- 本分析仅针对**你自己机器上已安装的软件**做静态逆向，目的是理解原理，不构成使用建议。
