# DOLA_ANALYSIS.md — dola.com 账号池接入分析

> 时间：2026-09-19（已用飞哥提供的真实 cookie 完成实测）
> 目标：`https://www.dola.com`（字节跳动海外 AI 助手，视频生成走 Seedance）
> 方法：① 真实浏览器抓包（`capture/dola-capture.mjs` → `capture/dola-network.json`）② 前端 bundle 逆向 ③ 用无效 cookie 实测错误码
> 相关代码：`admin/server/dola/provider.js`、`admin/server/routes/dola.js`、`admin/server/dola/probe.mjs`、`browser-capture.mjs`

---

## 0. 一句话结论（会影响方案，先看这个）

**dola 没有「账号密码登录」**，也没有对外的开放 API。网页登录只有六种方式：

```json
// 抓包取自 /alice/user/launch 的响应字段，逐字复制
"login":{"order":["line","google","phone_verify_code","apple","facebook"],"display_count":1}
```

加上扫码（弹窗右侧「Scan QR code with Dola App」）。也就是说：
`Line / Google / 手机验证码 / Apple / Facebook / 扫码`，**全是 OAuth 或 OTP**。

并且风险控制挂了字节自家的图形验证码（`bdturing` / RMC）。

⇒ **「输入账号密码批量登录」在技术上不存在**，不是难做的问题，是没有这个接口。

### ✅ 实测结论（2026-09-19，用真实 cookie）

拿一个真实账号（`2d5lel@ixzx.kdns.fr`，**免费版 free**）跑完全套探测：

| 项 | 结果 |
|---|---|
| cookie 是否有效 | ✅ 有效。`/alice/user/config/pull` 返回 `code 0`（无效时会明确回 `710012001`） |
| 账号身份 | ✅ 拿到 `id=1474977758469649`、`entity_id=7686323974691652661`、昵称 `2d5lel 2d5lel`、`user_name=432012642` |
| 会员等级 | ✅ `subs_status = "free"`、`has_active_subscription = false`、国家 `JP` |
| 可查询的额度数值 | ❌ **不存在**。6 个候选接口全部 `code 0`，但**没有任何额度/余额/剩余次数字段** |
| 页面 UI 是否显示额度 | ❌ 不显示。顶栏只有「下载电脑版」，没有任何数字 |

**关键发现：免费号根本没有可查询的「额度」数值。**
dola 免费版是按隐式的日/月次数限制走的，只有撞到上限时才弹付费墙
（i18n 里能翻到 `Doubao_paywall_FreeUser_quota_monthlyLimit_reached_global` 这类文案），
平时不暴露任何数字。`/alice/user/launch` 的 `quota_config` 恒为 `null`。

抓包全文搜索「credit」只命中模型消耗倍率（`Professional use • 4x credit usage`、
`Best quality • 5x credit usage`），那是「用一次扣多少」的介绍文案，不是余额。

⇒ **付费号（Pro）才可能有 credits**。要验证这条，需要一个付费号。

### 因此账号池走「cookie 导入」路线

```
浏览器/Dola App 里人工登录  →  导出 cookie  →  后台批量导入
                                              ├── 并发校验有效性（实测：/alice/user/config/pull 返回 710012001 = 失效）
                                              ├── 查额度
                                              └── 额度 → 后台积分（内部记账）
```

人工登录那一步无法消除。想全自动只能上接码平台 + 打码服务，成本和封号风险都很高，不建议。

---

## 1. 站点与接口基础信息（已验证）

| 项 | 值 | 来源 |
|---|---|---|
| API 基址 | `https://www.dola.com` | 抓包 |
| 应用标识 `aid` / `real_aid` | `495671` | 每个请求都带 |
| 环境 | `oversea-release-production-samantha`，`zone: sg` | 页面内嵌配置 |
| 客户端版本 | `pc_version=3.36.11`、`version_code=20800`、`pkg_type=release_version` | 抓包 |
| 登录配置 | `order: line/google/phone_verify_code/apple/facebook` + qrcode | `/alice/user/launch` 响应 |
| 视频模型 | Seedance（视频工作台报错文案里出现过 "Seedance 2.5"） | 交叉印证 |
| 静态资源 | `sf-flow-web-cdn.ciciai.com`、`lf-flow-web-cdn.doubao.com` | 页面 |

### 每个业务接口都要带的固定 query ✅

```
version_code=20800 & language=en & device_platform=web & doubao_device_platform=web
aid=495671 & real_aid=495671 & pkg_type=release_version
pc_version=3.36.11 & doubao_pc_version=3.36.11
samantha_web=1 & web_platform=browser & use-olympus-account=1
```
（部分接口额外带 `web_id` / `tea_uuid` / `device_id` / `region` / `sys_region` / `web_tab_id`）

缺了这些参数服务端会走另一条路径或直接报错 —— `provider.js` 的 `COMMON_QUERY` 是逐字还原的。

### 请求头 ✅

```
accept: application/json, text/plain, */*
content-type: application/json
agw-js-conv: str                 ← 字节网关特有，别漏
referer: https://www.dola.com/chat/
origin: https://www.dola.com
```

### 登录后 key cookie ✅

`ttwid`、`odin_tt`（这两个是硬性）、`s_v_web_id`、`passport_csrf_token`、
`passport_csrf_token_default`、`flow_cur_user_sec_id`、`flow_user_country`

未登录时服务端也会下发 `ttwid` / `s_v_web_id` / `odin_tt` 匿名串 ——
所以**光有这几个 cookie 不代表已登录**，必须打接口验证。

---

## 2. `a_bogus` 请求签名（结论已修正）

抓包发现部分接口带 `a_bogus` 参数（192 字符），另有 `verifyFp` 设备指纹、`msToken`、`sign`、`qs`。
`a_bogus` 是客户端混淆 JS 算出来的防爬签名。

### ⚠️ 修正：不要看到 `710010202` 就断定「需要签名」

我一度以为 `710010202 system error` = 缺 `a_bogus`，**这个结论对一半**。
用无效 cookie 和有效 cookie 做对照实验后：

| 接口 | 无 cookie | 有效 cookie（纯 HTTP，不带 a_bogus） | 结论 |
|---|---|---|---|
| `/alice/user/config/pull` | `710012001` 会话失效 | `code 0` | 无需签名 ✅ |
| `/alice/user/launch` | `710012001` | `code 0` | 无需签名 ✅ |
| `/alice/commerce/sale/subscription/entry/config/` | `710012001` | `code 0` | 无需签名 ✅ |
| `/alice/profile/self_brief` | — | `code 0` | 无需签名 ✅ |
| `/alice/slot/action_bar_v3/get_item_conf` | `710010202` | **`code 0`** | 无需签名 ✅（之前的判断是错的） |
| `/alice/slot/action_bar_v3/brief_list` | — | `code 0` | 无需签名 ✅ |
| **`/alice/profile/self`** | `710010202` | **`710010202`** | **需要签名或额外参数** ❌ |

**准确的结论**：`710010202` 是「参数/会话校验不通过」的**通用**兜底错误，不是签名专属。
所以不能根据错误码推断，**必须逐接口用有效 cookie 实测**。

补充证据：浏览器里 `/alice/profile/self` 是 `200 + membership_info`，而纯 HTTP 调它是
`710010202` —— 同一个接口两种结果，差异就在浏览器带了 `a_bogus`。

### 实用做法

- 不需要签名的接口（上表前六个）走**纯 HTTP**，够用了。
- 确实需要签名的接口用**浏览器通道**（`fetchCreditsViaBrowser`）：
  带 cookie 起真实浏览器打开 dola，让页面自己发请求，我们只监听响应。
- 浏览器还会带 `region=JP`、`sys_region=JP`、`web_id`、`tea_uuid`、`device_id` 一整套上下文，
  纯 HTTP 很难 100% 对齐 —— 这也是浏览器通道更稳的原因。

## 3. 错误码（对照实验得出）✅

| code | 含义 | 证据 |
|---|---|---|
| `0` | 成功 | 所有正常响应 |
| `710012001` | **会话失效**，msg = `Session expired. Log in again.` | `/alice/user/config/pull`（无 cookie 时） |
| `710010202` | `system error` **通用校验失败** —— 可能是会话无效，也可能是缺参数/签名 | `/alice/profile/self` 即使带有效 cookie 也返回它；`action_bar_v3` 换了有效 cookie 就正常 |

**最可靠的会话判定**：打 `/alice/user/config/pull`，看是否 `710012001`。
比看 `launch` 的 `sec_user_id` 是否为空硬 —— 后者在匿名态也是空串（实测该字段恒为空）。

## 4. 登录流程（供参考，本项目不做自动登录）

```
GET  /passport/web/get_qrcode/      ← 取二维码
GET  /passport/web/check_qrconnect/?token=…   ← 轮询扫码状态（秒级）
       参数：aid=495671 & account_sdk_source=web & verifyFp=… & sign=… & qs=… & a_bogus=…
```

`verifyFp` 形如 `verify_mu7mcn4d_4X128VTU_2mSv_4AfA_8QPS_8Orw9gzTwW2U`，
`qs` 是十六进制串 —— 这两个由前端 SDK 生成，纯 HTTP 复刻成本高。

图形验证码由 `s2-security-verify` chunk 加载：
`rc-verifycenter/rmc-captcha`、`bdturing-verify`、`captcha.js`，
来源域 `lf-rc*.yhgfb-static.com`、`vcs-s.byteintlapi.com`。
代码里还有 `__verify_test_cookie__`（测试环境跳过验证用）。

---

## 5. 已实现并实测的能力

| 功能 | 状态 | 说明 |
|---|---|---|
| 批量导入 cookie | ✅ 实测 | 4 种格式自动识别；**整段 JSON 不会被按行拆**（踩过）；自动去重；逐行报告无效行；兼容 UTF-8 BOM |
| cookie 关键项检查 | ✅ 实测 | 缺 `ttwid`/`odin_tt` 直接标 invalid，不打接口浪费请求 |
| 会话校验 | ✅ 实测 | `/alice/user/config/pull` + `/alice/user/launch` 交叉判定；真实账号判定为「有效」 |
| **账号身份回填** | ✅ 实测 | `/alice/profile/self_brief` → 昵称、`entity_id`、`user_name`。**这是登录后唯一可靠的账号标识来源**（`sec_user_id` 恒为空） |
| **会员等级识别** | ✅ 实测 | `/alice/commerce/sale/subscription/entry/config/` → `subs_status`（free/pro）、`country_code`。不依赖签名 |
| 并发批量校验 | ✅ 实测 | 后台任务 + 并发池 + 进度落库 + 取消 |
| 额度接口探测 | ✅ 实测 | 6 个候选逐个打，返回 `ok`/`session_expired`/`generic_error` 三级判定 |
| 浏览器通道 | ✅ 实测可用 | 带 cookie 起浏览器抓全量响应，`playwrightAvailable()` 正常 |
| 额度 → 积分换算 | ✅ 实测 | 自定义比例、防重复换算、可充到令牌、流水 + 审计 |
| 手动录入额度 | ✅ 实测 | 自动查额度未落定前的过渡手段 |
| **自动查额度** | ❌ **做不到（免费号）** | 见 §0 实测结论：免费号没有额度数值 |

## 6. 待确认（需要你提供额外信息）

已经排掉的：免费号确实没有任何可查询的额度数值（6 个候选接口 + 页面 UI 全查过）。

| # | 待确认 | 需要什么 |
|---|---|---|
| 1 | **付费号（Pro/订阅）是否有 credits 字段** | 一个**付费账号**的 cookie。跑 `node server/dola/probe.mjs --file ./cookie.txt` 即可，我已经把候选接口补全了 |
| 2 | 付费号的额度字段名与单位 | 同上 |
| 3 | 免费号的实际可用次数 | 只能靠实际生成去撞（会消耗额度），**不建议** |
| 4 | 免费/付费的额度差异 | 两个号对比 |

**如果付费号也查不到额度**：说明 dola 前端根本不给客户端任何余额数值，
那「额度转积分」就只能换计价依据 —— 见下一节。

## 7. 额度转积分的语义（重要）

⚠️ **这是内部记账，不会真的消费掉 dola 账号的额度。**

```
dola 账号 (credits=250)  ──按比例 10:1──▶  可换 25 积分  ──▶  充到令牌
                                              └─ 记入 credit_conversions 流水
```

- dola 的额度只有在**那边实际生成内容**时才会被扣。本项目不调用任何消费类接口 ——
  这是刻意的：消费接口未验证，误调用会真花掉你的账号额度。
- 所以「换算」不会减少 dola 侧的余额，只是把「你有多少可用资源」折算成平台侧的积分发出去。
- 防重复换算靠 `dola_accounts.converted_credits` 累计：已换算过的额度不会被再算一次，
  余额不足 1 积分的零头会保留在账号上（下次凑够再换）。

如果你要的是「真的把 dola 额度用掉」，那是另一套东西（需要消费/生成接口），
得先把那条链路单独测通，再谈。

### 已采纳的方案：双计价方式

飞哥确认账号池**都是免费号**，所以默认走「按账号数」：

| 计价方式 | 公式 | 幂等保证 | 适用 |
|---|---|---|---|
| **`account` 按账号数**（默认） | 有效账号数 × 单账号积分（`dola_points_per_account`，默认 50） | `dola_accounts.counted_at` 非空即视为已计价，一个号只计一次；可「撤销计价标记」后重计 | 免费号（无额度数值） |
| **`credits` 按额度** | ⌊(credits − converted_credits) ÷ `dola_credits_per_point`⌋ | `converted_credits` 累计，换过的额度不再算，零头保留 | 付费号（有 credits 时） |

默认值由设置项 `dola_convert_basis` 决定。两种方式都支持：试算（dryRun）→ 确认、
可选充到指定令牌、写 `credit_conversions` 流水 + 审计日志。

**为什么不做「按实测次数」**：要真调一次生成接口才知道还剩几次，那会消耗掉账号额度，
且免费号的限制是隐式的，撞到上限才报错 —— 成本大于收益。

---

## 8. 复现命令

```bash
cd admin

# ① 探测某个账号：登录态 + 每个候选接口的判定（cookie 打码，报告落盘）
node server/dola/probe.mjs "ttwid=...; odin_tt=...; ..."
node server/dola/probe.mjs --file ./cookie.txt          # 插件导出的 JSON 也吃

# ② 带 cookie 起浏览器，抓页面加载的全部接口响应（找额度字段用）
node server/dola/browser-capture.mjs --file ./cookie.txt
#    产出 dola-browser-capture.json + 两张截图

# ③ 打开「AI 创作 / 视频」面板，看额度是否只在这里暴露
node server/dola/video-panel.mjs --file ./cookie.txt

# ④ 匿名抓包（不用 cookie）
cd ../capture && node dola-capture.mjs
```

后台界面里也有：账号行 → 「探测」按钮，可视化看每个候选接口的判定。

---

## 9. 风险与合规提示（照实说）

- 批量操作第三方账号属于对方 ToS 的灰色地带，对方有风控（设备指纹 + 图形验证码 + `a_bogus` 签名），
  **高频请求可能触发限制甚至封号**。项目里默认并发 5、超时 20s，建议别加大。
- 本项目不实现任何绕过验证码的手段，也不做自动登录。
- cookie 等同于账号登录凭证，明文存本地 SQLite。
  查看 cookie 会写审计日志；数据库文件已 gitignore。
  要更高的安全性请自行加密存储或改用密钥管理服务。
