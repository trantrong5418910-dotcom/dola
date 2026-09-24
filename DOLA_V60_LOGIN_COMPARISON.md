# 虚拟机四段账号登录：实现核查与 8788 差异

检查日期：2026-09-21 UTC（本机 America/Chicago 为 9 月 20 日）。

后续实施说明：用户确认补齐后，8788 已加入受控端点白名单、独立 TOTP 与有限刷新，并通过离线回归及加载验证；当前行为见 [账号登录说明](admin/ACCOUNT_LOGIN.md) 和 [最新交接](HANDOVER.md)。以下为实施前的研究快照，不代表现在仍缺这些功能；仍未进行真实取码/新登录验收。

## 结论

这套工具使用“每账号独立 WebView2 + 第四段外部取码接口 + Google 两步验证码页面填写”，不是自动破解图形验证码。8788 已有四段导入和独立登录框架，但目前只自动处理邮件验证码，尚不兼容截图里的 HTTP / 公网 IP / 自定义端口取码服务，也没有独立的 Google TOTP 步骤。

**不能只把 HTTPS 改成 HTTP 就认为完成接入。** 必须同时明确接口返回协议、区分挑战类型、处理过期码，并保留最终身份核验。

## 证据与范围

- 通过 Parallels 进入已经运行的 `Windows 11`，只读检查本机 `127.0.0.1:55391` 的状态和运行程序。
- 主进程为 `HiggsfieldVideoGenerator`，来自共享 Downloads 的 `Portable_Protected`，SHA-256 为 `353422e19117ca358b4a387ed0b35f86debb78b30043641000f9a4003c72a594`。
- 实际登录脚本：`/Users/feige/Downloads/Portable_Protected/webview2_host/astra_login_step.js`；登录宿主为同目录 `DolaWebView2LoginHost_v60_1l_google_session_rtl.exe`。
- 使用 .NET `ReflectionOnlyLoadFrom` 读取宿主元数据和方法 IL，核查 `OtpCandidate`、`ExtractOtp`、`FetchOtpCode`，没有调用目标方法或重新启动目标程序。
- 本轮早先已成功读到的批次状态：`running=false, total=5, done=5, success=5, failed=0, human_verify=0`。这是工具自报的登录结果，未逐号独立复核，不是视频生成成功率。末次复读在本机 15 秒命令期限内未返回，已结束该只读命令；不将此前快照表述为持续实时状态，也不据此认定登录服务故障。
- 留存运行日志存在 `/challenge/totp` 路径。没有输出原始账号、密码、Cookie、完整取码链接或验证码。
- 没有触发新登录、调用真实取码服务、提交视频、切换代理、重启服务或改动应用代码。本文件仅记录研究结果。

## 它如何完成登录

1. 为账号启动独立 WebView2。宿主接收邮箱、密码、恢复邮箱、取码网址、Google 会话链接及 profile 参数；这些参数的 `*_B64` 表示传输编码，不等于加密存储。
2. 浏览器脚本识别 Google 邮箱、密码、恢复邮箱步骤，返回宿主需要执行的填写或点击动作。
3. `astra_login_step.js:94–107` 明确处理 `/signin/challenge/totp` 及相关两步验证线索；没有码时返回 `otp_required`，页面提示码错误时返回 `otp_retry`。
4. 宿主的 `FetchOtpCode` 使用 `DownloadString(otpUrl)` 请求第四段网址，读取 UTF-8，先尝试 JSON 解析及 `ExtractOtp`，没找到时再对完整响应调用 `OtpCandidate`。
5. 找到码后注入脚本的 `__OTP__`，脚本返回 `cdpfill:…:otp`，随后点击下一步（包括 `#totpNext`）。
6. 宿主存在等待刷新、取码失败、重试和可见窗口兜底状态；本次没有完整复原异步状态机，因此不确认具体重试次数、间隔或所有触发顺序。
7. `astra_login_step.js:77–86` 明确将 reCAPTCHA 交给人工处理，要求不自动点击该页控件。该版本同样不保证免人工验证。

## 已核实的取码解析规则

以下是宿主程序实际解析能力，不是第三方取码服务的接口承诺；本轮没有请求真实服务来确认它当前返回什么。

- `OtpCandidate` 把值转为字符串，用 `(?<![0-9])[0-9]{6,8}(?![0-9])` 取第一个匹配：接受 6、7、8 位数字，且不要求整个字符串只含验证码。
- `ExtractOtp` 优先按 `code → otp → totp → token → pin → verification_code → data` 查找，键名不区分大小写。
- 支持嵌套字典与数组；深度大于 6 时停止。优先键找不到有效候选时，还会遍历其他值。
- JSON 解析失败或没有提取到码时，对原始响应继续做数字匹配。因此它比 8788 宽松，但也可能把业务编号等数字误当验证码。
- 请求设置 `Accept: application/json,text/plain,*/*`。没有将截图的真实接口响应、TLS 能力、重定向行为或实际请求代理路径做独立验证。

**不建议照搬“任意文本抓第一串数字”。** 应为已确认的服务定义字段白名单，保留前导零，拒绝多个冲突验证码和错误响应；错误码、时间戳、业务编号不能充当 OTP。

## 8788 当前的具体缺口

| 环节 | 虚拟机证据 | 8788 当前实现 / 改进方向 |
|---|---|---|
| 第四段网址 | 截图为 HTTP、公网 IP、自定义端口；宿主通用 `DownloadString` 取码 | `account-login-format.js:55`、`google-login-form.js:28`、`login-verification-code.js` 均只接受公网域名 HTTPS。需要统一策略，不能只改导入层 |
| 挑战类型 | 脚本明确有 Google TOTP 分支，日志也出现该路径 | `google-login-form.js` 仅将明确邮件挑战识别为 `email_otp`；TOTP 转人工。需要独立 `authenticator_otp` 状态，不能混同邮件、短信或 CAPTCHA |
| 返回解析 | 多个字段、嵌套数组/对象、文本正则兜底 | 当前只接受纯 6/8 位码或严格浅层 JSON 的 `otp/verification_code/code`；应按服务协议补适配，不无差别放宽 |
| 自动操作 | `otp_required/otp_retry/fetching_otp/otp_retrying/otp_ready` 等状态 | `google-login-browser.js:290` 的邮件 OTP 最多尝试一次；应为过期/错误码设有界刷新、去重及明确的人工接管状态 |
| 成功判定 | 批次成功是工具自己的状态 | 8788 已有 Google 身份、OAuth 回调绑定和在线 Dola 身份核验；保留，不能以“码填完”或页面跳转替代 |

## 建议的接入顺序（尚未实施）

1. 先约定第四段服务的响应格式与可信主机；优先 HTTPS。若确需 HTTP，需明确接受取码链接中秘密和返回验证码可能明文传输的风险，并只放行指定主机、端口和路径，继续禁止内网、重定向和携带账号会话。
2. 为 `accounts.google.com` 的确定 TOTP 页面新增专门识别。取码前后均复核账号与步骤，只操作唯一可见输入框和明确的确认按钮；不复制宽泛域名匹配、首个输入框兜底或未知 RTL 坐标点击。
3. 为已约定服务增加响应适配与过期码有限刷新；相同码不反复提交，失败可解释，取消立即停止，敏感值不进入日志或数据库。
4. 先用模拟接口/页面覆盖导入、取码、刷新、身份不匹配、跳转、超时与取消，再另行确认一次真实登录验收。登录测试不提交视频、不承诺生成成功率。

相关文档：[8788 现有登录说明](admin/ACCOUNT_LOGIN.md)、[虚拟机整体对照](DOLA_V60_VM_COMPARISON.md)。
