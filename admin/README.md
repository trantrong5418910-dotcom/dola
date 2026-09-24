# 管理后台（通用骨架）

Vue3 + Element Plus 前端，Express + SQLite 后端。带登录、RBAC 权限、CRUD、系统设置、操作日志。
**零配置起步**：装完依赖、建库、启动，就能登录用。

```bash
cd admin
npm install
npm run build      # 构建前端（约 3 秒）
npm start          # 单端口启动 http://127.0.0.1:8788
```

默认账号 **admin / admin123**（首次登录后去「个人设置」改密码）。

---

## 功能

| 模块 | 说明 |
|---|---|
| 登录 | JWT + scrypt 密码哈希，登录有效期可在设置里改 |
| 仪表盘 | 用户/令牌/卡密/内容/角色/日志计数、令牌积分总量、待兑积分、内容状态分布、近 7 天趋势、最近操作时间线 |
| 用户管理 | 增删改查、搜索、状态筛选、分页、重置密码、不能删自己 |
| 角色权限 | **30 个权限点**分 8 组可视化勾选；内置角色受保护不可改不可删；在用角色不可删 |
| 访问令牌 | 单个/批量生成（`dv_` 前缀）、初始积分、有效期、启停/撤销、改积分、查看完整值、导出 CSV |
| 充值卡 | 单个/批量生成（`card_` 前缀）、面额、批次号、有效期、撤销/恢复、手动兑换、批量删除、导出 CSV |
| dola 账号池 | 批量导入 cookie（4 种格式自动识别 + 去重）、并发校验、查额度、**额度转积分**（自定义比例 / 充到令牌 / 防重复换算）、后台任务与进度、换算流水 |
| 内容管理 | 示例业务模块：CRUD、分类/状态筛选、关键字搜索、批量删除 |
| 系统设置 | 站点名、每页条数、页脚、开放注册、登录有效期（改完立即生效，写日志） |
| 操作日志 | 谁在什么时候干了什么、IP；按人/动作筛选。登录、失败登录、生成令牌/卡密、兑换、查看完整值都记 |
| 前台入口 | 顶栏一键打开「前台」。两种模式：新标签页直跳 / **在后台所在机器上开真实浏览器窗口** |
| 个人设置 | 改密码、深色/浅色切换 |

权限是**前后端同一份定义**（`server/rbac.js`）：前端菜单按它过滤，后端 `requirePerm()` 按它拦截。
只读用户看不到菜单项，直接敲 URL 或打接口也会被 403 —— 两边都拦。

## 令牌与充值卡的设计

```
生成令牌  dv_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX  ──┐
        （32 位随机，自带积分余额）                │
                                                  ├─ 兑换：卡密面额加到令牌积分上
生成卡密  card_XXXXXXXXXXXXXXXXXXXX  ─────────────┘
        （20 位随机，去掉了易混字符 0O1lI）
```

| 约定 | 说明 |
|---|---|
| 前缀 | 令牌 `dv_`、卡密 `card_`，和视频工作台那套模型对齐，以后要对接外部系统字段不用改 |
| 随机性 | 用 `crypto.randomBytes` + 拒绝采样，无模偏差；不用 `Math.random` |
| 卡密字符集 | 去掉 `0O1lI`，方便用户手输 |
| 完整值可见性 | **只在生成响应和「查看」接口出现**。列表永远只给掩码（`dv_AbCdEf********wXyZ`） |
| 查看留痕 | 每次「查看」完整值都会写审计日志（谁、何时、看了哪一个） |
| 兑换并发保护 | `UPDATE ... WHERE id=? AND status='unused'` 靠 `changes` 判断，两人同时提交同一张卡只有一个成功 |
| 已兑换不可删 | 保留资金流水。确实要清理测试数据用 `?force=1`（要权限 + 写 `force_delete` 审计） |
| 已撤销令牌不可再启用 | 撤销是单向的，想恢复就新建一个 |
| 单次生成上限 | 1000（防止误点把库写爆），服务端会裁剪 |

兑换的用法：进「充值卡」→ 右上角「手动兑换」→ 填卡密、选要充值到的令牌。
客服补单、自己测链路都走这里。卡密兑换后会在列表里显示「兑换去向」（哪个令牌）和兑换时间。

---

## 目录结构

```
admin/
├── server/                  后端（Express）
│   ├── index.js             入口：路由挂载、静态托管、错误兜底、仪表盘统计
│   ├── db.js                SQLite 建表 + 种子数据（--reset 可重建）
│   ├── auth.js              scrypt 密码 / JWT / 鉴权与权限中间件
│   ├── rbac.js              权限点清单（前后端共用）
│   ├── audit.js             操作日志写入
│   ├── generate.js          令牌/卡密生成、掩码、CSV 导出
│   ├── jobs.js              进程内后台任务运行器（并发池 + 进度落库）
│   ├── dola/
│   │   ├── provider.js      dola.com 接口封装（参数还原、cookie 解析、额度探测、浏览器通道）
│   │   └── probe.mjs        命令行探测工具：实测某个 cookie 的额度在哪个接口
│   ├── routes/              auth / users / roles / content / tokens / cards / dola / frontend / settings / logs
│   ├── public/              前端构建产物（vite 输出到这里）
│   └── data/admin.db        SQLite 数据库（已 gitignore）
├── web/                     前端（Vue3 + Element Plus）
│   ├── src/api.js           请求封装：自动带 token、401 踢回登录、统一报错
│   ├── src/store.js         全局状态、权限判断 can()、主题、登录态恢复
│   ├── src/router.js        路由 + 守卫（登录校验 + 权限校验）
│   ├── src/layouts/         侧边栏布局
│   └── src/views/           11 个页面
└── test/
    ├── smoke.js             端到端冒烟（157 项断言，可重复跑、不污染数据）
    └── ui-walk.mjs          浏览器走查 + 截图 + 真实生成流程（需 playwright）
```

## 命令

| 命令 | 说明 |
|---|---|
| `npm start` | 生产模式：8788 单端口同时提供 API + 前端 |
| `npm run dev:api` | 只起 API（开发用） |
| `npm run dev:web` | 起 Vite dev server（5173，已配代理到 8788），带热更新 |
| `npm run build` | 构建前端到 `server/public` |
| `npm run smoke` | 端到端冒烟（**先起服务**） |
| `npm run reset-db` | 删库重建 + 灌种子数据（会清空所有数据！） |
| `node server/dola/probe.mjs --file ./cookie.txt` | 拿一个真实 cookie 实测额度接口落在哪（见 DOLA_ANALYSIS.md） |

开发时最顺手的组合：一个终端 `npm run dev:api`，另一个 `npm run dev:web`，浏览器开 5173。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8788 | 服务端口 |
| `ADMIN_JWT_SECRET` | 自动生成并存在 `server/data/.jwt-secret` | 想多实例共享登录态就显式设一个 |
| `ADMIN_INIT_PASSWORD` | `admin123` | 只在**首次建库**时生效 |
| `ADMIN_DB` | `server/data/admin.db` | 换数据库文件位置 |

---

## 主要接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/tokens/generate` | `token:generate` | `{count, points, name?, note?, expiresInDays?}` → 返回**完整令牌**（仅此一次） |
| GET | `/api/tokens` | `token:list` | 列表（掩码）+ summary 统计 |
| GET | `/api/tokens/:id/reveal` | `token:reveal` | 取完整值，写审计 |
| POST | `/api/tokens/:id/action` | `token:update` | `{action: disable\|enable\|revoke\|points\|expire, delta?, days?}` |
| GET | `/api/tokens/export` | `token:list` | CSV（带 BOM，Excel 不乱码） |
| POST | `/api/cards/generate` | `card:generate` | `{count, points, batchNo?, note?, expiresInDays?}` → 返回**完整卡密** |
| GET | `/api/cards` | `card:list` | 列表 + 批次筛选 + summary |
| GET | `/api/cards/batches` | `card:list` | 批次聚合（总数/未用/已兑/面额区间） |
| POST | `/api/cards/redeem` | `card:redeem` | `{code, tokenId}` 把面额充到令牌 |
| POST | `/api/cards/:id/action` | `card:update` | `{action: revoke\|restore}` |
| DELETE | `/api/cards/:id?force=1` | `card:delete` | 已兑换的卡默认拒绝，`force=1` 可强制（留审计） |

其余模块的接口（users / roles / contents / settings / logs）见对应 `server/routes/*.js`。

## dola 账号池

对接 `dola.com`（字节海外 AI 助手）的账号资源池。完整分析见仓库根目录的 **[DOLA_ANALYSIS.md](../DOLA_ANALYSIS.md)**。

### 先说四条硬事实（都是实测出来的）

1. **dola 没有站内邮箱密码直登。** 登录方式包括 `Line / Google / 手机验证码 / Apple / Facebook / 扫码`。
   账号池支持导入已登录 Cookie，也提供独立的「Google 登录入池」；这里输入的是 Google 凭据，
   不是 Dola 自有密码。遇到验证码、授权或 Google 安全限制必须人工处理。
2. **免费号没有可查询的额度数值。** 用真实账号实测：6 个候选接口全部 `code 0` 但没有任何额度/
   余额字段，页面 UI 也不显示，`quota_config` 恒为 `null`。只有付费号（有订阅）才可能有 credits。
   ⇒ 所以默认计价方式是**按账号数**（一个有效账号 = 固定积分），不依赖额度数值。
3. **额度/账号计价都是内部记账**，不会真的消费掉 dola 的额度（那边只有实际生成内容才扣）。
   刻意不调消费类接口：未验证 + 误调会真花掉你的额度。
4. `710010202 system error` 是**通用校验失败**，不是「缺签名」的专属错误 ——
   实测同一批接口换了有效 cookie 就全部 `code 0`。但 `/alice/profile/self` 确实需要
   `a_bogus` 签名，可以开浏览器通道（系统设置里 `dola_use_browser`，需装 playwright）。

### 怎么用

#### Google 登录入池

在后台所在电脑访问账号池，点击「Google 登录入池」，每行粘贴 `邮箱|密码`（支持输入中的 `\\@` 转义，最多 20 个）。
每次只处理一个账号，使用独立浏览器上下文，不共享日常浏览器或其他账号的 Google 会话。
**必须使用 IP 代理，不允许直连或失败后退回本机网络。** 已存在同名邮箱账号沿用已绑定代理；缺少代理时从已有有效账号的 IPWeb 配置中沿用网关/地区，为邮箱生成稳定独立 SID。
浏览器启动后先通过同一代理检查出口 IP；检查失败时不会输入账号密码。Google、UserInfo、Dola 登录及账号核验使用同一条代理，成功后代理与出口 IP 一并绑定账号。
若后台没有可用的 IPWeb 配置，先配置账号代理再登录，不会猜测代理凭据。独立 SID 不等于供应商保证独立物理出口 IP。
邮箱与密码按每字约 140ms 逐字输入，输入前等待 800ms、提交前等待 700ms，并核对输入结果；上一页提交后留出响应时间，不并发填写或连续重试。
这种节奏用于稳定表单操作，不保证 Google 不触发验证码，不修改浏览器指纹或绕过安全校验。

密码仅保存在此次请求/运行内存中，提交成功后页面清空；使用后、取消、超时和服务退出会清除。
不写入数据库、普通 jobs、审计日志或浏览器本地存储，因此服务器重启后不能自动恢复这批密码登录。
Google 验证码、安全检查、恢复流程及授权/条款页面不会自动处理。完成后点击「我已完成，检查登录」，也可跳过当前账号或取消整批。
识别到图片验证码（含普通邮箱页上的验证码）、两步验证或浏览器安全拦截时，立即停止该窗口的自动填写并锁住后续队列。
当前账号完成、失败或被跳过后，后续账号仍为「已暂停」，必须明确点击「确认继续剩余账号」才能启动；「检查登录」不解除暂停。
从首次安全验证起最多保留 10 分钟，重复检查不会延长；到期关闭窗口、清除排队密码，不继续换号。普通登录 5 分钟超时或代理/浏览器启动失败也会终止剩余队列。
这修复的是本地漏检、重复提交与队列推进问题，不是验证码破解。
[Google 官方说明](https://support.google.com/accounts/answer/7675428?hl=en)明确提到可能限制受软件自动化控制的浏览器；慢速输入或代理无法保证免验证。
2026-09-19 用户明确允许保存独立 Google 登录状态后，增加 cookie-only 会话缓存（不保存密码、表单、浏览器密码库、localStorage 或独立 OAuth 访问令牌）。
缓存位于当前用户的 `~/Library/Application Support/DolaLogin/sessions`，目录 0700、文件 0600，以邮箱散列命名、原子更新；这些 Cookie 本身是敏感登录凭据，不应共享、提交或打包。
仅接收 Google/Dola 允许域名的 Cookie，绑定精确邮箱身份、Dola 身份和原代理散列，有效期最多 7 天；新账号仍需首次成功登录，不能从旧账号备注名伪造缓存。
恢复后先经同一代理在线核验 Dola 会话及身份，一致才复用已验证的历史 Google 身份关联，不宣称重新获取了 Google UserInfo。明确失效才删除当前浏览器中的 Dola Cookie，使用独立 Google 会话重新走正常 OAuth；网络未知或身份不一致则停止，不自动重输密码。
本地缓存保存失败不影响已核验的入池结果，但会在进度中明确显示失败。服务重启保留此缓存，不保留队列密码；未授权导入日常浏览器个人资料。
Google 关于受信任设备的 Cookie 建议针对两步验证，不代表保存 Cookie 可以消除图片验证码，也不保证相同 SID 永远对应相同物理 IP。

入池前用 [Google 官方 UserInfo](https://developers.google.com/identity/openid-connect/openid-connect#obtaininguserprofileinformation) 验证返回邮箱与输入邮箱一致、邮箱已验证，再检查 Dola 会话与账号资料。
还必须观察到 Dola 的 `/passport/web/auth/login_only/` 或 `/passport/web/auth/login/` 使用同一个 Google OAuth 令牌（顶层 `platform_app_id=2085`）完成交换，响应 `message=success` 且 `data` 非空，该响应设置的会话 Cookie 与当前 Cookie 一致。
上述路径和成功标志来自 2026-09-19 的 [Dola 公开 Passport SDK](https://sf-flow-web-cdn.ciciai.com/obj/ocean-flow-web-sg/cici_web/static/js/async/14947.4150c52a.js)；其他平台或未识别协议不会自动放行。
未知认证格式会停在待确认，不把独立的 Google 身份与另一个 Dola 会话拼接入池。账号保存与审计记录在同一事务中提交。
号池数据库仍只保存 Dola 域名 Cookie；获授权的 Google Cookie 仅进入上述本机独立缓存，不进入账号池接口/日志。没有可信身份结果不会按备注名猜测入池；已停用、正在生成、重复身份或登录期间被更新的账号不会被覆盖。

接口（均需 `dola:import` 权限、仅允许本机连接）：

- `POST /api/dola/google-login/batches`：`{raw}` 创建批次。
- `GET /api/dola/google-login/batches/current`：读取当前管理员自己的最近批次，不返回密码。
- `GET /api/dola/google-login/batches/:id/preview`：只读查看当前批次的登录页，输入框遮挡，图片不落盘、不含浏览器地址栏，仅当前管理员可用。
- `POST /api/dola/google-login/batches/:id/action`：`{action: 'check'|'skip'|'cancel'|'resume'}`；`resume` 仅允许在当前窗口完全结束且批次已暂停后调用。

专项测试：`npm run test:google-login`，仅使用假驱动与隔离数据库。真实 Google 是否允许自动登录取决于账号和浏览器安全检查，不承诺批量免验证。
界面演练：`node test/google-login-ui-fixture.mjs`，仅监听 `127.0.0.1:18991`，使用 `synthetic-one@example.test|synthetic-password` 等合成账号。
该演练使用真实队列与 Vue 组件，但「检查登录」模拟身份成功，不访问 Google/代理、不读写数据库，不能作为真实登录验收；不挂载到正式后台。

**① 拿 cookie**：浏览器登录好 dola → 用浏览器插件导出（推荐），或 F12 → Network → 任一 `/alice/`
请求 → 复制完整 Cookie 头。
（`document.cookie` 拿不到 HttpOnly 的 `odin_tt` / `ttwid`，必须从 Network 或插件里取。）

**② 批量导入**：「dola 账号池」→「批量导入」→ 一行一个账号贴进去。
自动识别 4 种格式：原始 Cookie 头 / `document.cookie` / 浏览器插件导出的 JSON 数组 / Netscape `cookies.txt`。
相同 cookie 自动跳过，垃圾行会报出第几行。

**③ 批量校验**：「批量校验」→ 后台任务并发跑，弹窗实时看进度。
- 判定用 `POST /alice/user/config/pull`，会话失效会明确返回 `710012001`
  （比看 `sec_user_id` 是否为空可靠 —— 那个字段实测恒为空串）。
- 顺带回填**账号名**（`/alice/profile/self_brief`）和**会员等级**（`subs_status`，free/pro）。

**④ 查额度**：「批量查额度」。免费号会如实报告「没有额度字段」—— 这不是故障，是 dola 不给。
付费号才可能查到；需要签名时去系统设置开浏览器通道。

**⑤ 计价 / 转积分**：「额度转积分」→ 先选**计价方式** → 试算 → 确认。

| 计价方式 | 公式 | 适用 |
|---|---|---|
| **按账号数**（默认） | 有效账号数 × 单账号积分（默认 50） | 免费号；不依赖额度数值 |
| **按额度** | ⌊(额度 − 已换算额度) ÷ 比例⌋ | 付费号；比例默认 10 额度 = 1 积分 |

两种都**防重复计价**：按账号数靠 `counted_at`（每个号只计一次，可在行内「撤销计价标记」后重计）；
按额度靠 `converted_credits` 累计（换过的额度不再算，零头保留）。可选把积分充到某个令牌。
每一步都写换算流水 + 审计日志。

### 排查工具

账号行上的「探测」按钮（或命令行 `node server/dola/probe.mjs --file ./cookie.txt`）
会把每个候选接口都打一遍，返回 `ok / session_expired / needs_bogus_or_error` 三级判定，
并列出所有疑似额度字段。拿到真实 cookie 后先跑这个，就知道额度落在哪。

### 相关设置（系统设置 → dola 账号池）

| 设置 | 默认 | 说明 |
|---|---|---|
| `dola_convert_basis` | account | 默认计价方式：`account` 按账号数 / `credits` 按额度 |
| `dola_points_per_account` | 50 | 按账号数计价时，每个有效账号值多少积分 |
| `dola_credits_per_point` | 10 | 按额度计价时，多少 dola 额度 = 1 积分 |
| `dola_check_concurrency` | 5 | 批量校验并发（别调太大，对方有风控） |
| `dola_http_timeout` | 20 | 接口超时（秒） |
| `dola_use_browser` | false | 浏览器通道开关（吃内存） |
| `dola_browser_concurrency` | 3 | 浏览器通道并发 |
| `dola_auto_maintenance_enabled` | true | 定时校验账号；后台服务运行期间生效 |
| `dola_auto_cleanup_invalid` | true | 明确会话失效后隔离，保留账号和 Cookie；关闭时标为待复查 |
| `dola_auto_quota_probe` | true | 巡检时通过只读 HTTP 接口探测明确账户余额 |
| `dola_auto_maintenance_interval_minutes` | 180 | 巡检间隔，支持 15～1440 分钟 |
| `dola_submit_mode` | browser | 视频提交通道：`browser`=浏览器模拟提交（默认）/ `scheme-a`=Abort取签名+页内重放提交（实验） |

### 视频提交通道（browser / scheme-a）

`server/dola/generator.js` 的提交阶段支持双通道，由设置项 `dola_submit_mode` 切换（系统设置 → dola 账号池，保存即时生效，无需重启）：

- `browser`（默认）：操作页面 UI（选模型/时长、填提示词、点发送），观察 SSE 拿 conversationId。
- `scheme-a`（实验，`server/dola/scheme-a.js`）：页内 fetch 触发一次 `/chat/completion`，路由拦截捕获带 `a_bogus` 签名的完整请求后 abort（探测不消耗额度），再用同一浏览器把请求原样重放一次完成真正提交，随后立刻关浏览器。

两个通道拿回 conversationId 之后走同一条下游：纯 HTTP 轮询 `/im/chain/single` → fallback 解析无水印 → 归档 → 计费/退款 → 任务日志。限流（710022002）冷却、提交日志、防自毁登出等保护在两个通道都生效。

限制：`scheme-a` 暂不支持参考图任务（会直接失败并提示切回 browser）。

### 自动维护与额度读数

账号池顶部的「立即维护」可手动执行一轮，结果在「批量任务」查看。定时维护使用同一任务队列，重启后沿用上次巡检时间；首次启用约 15 秒后检查。停用账号会跳过，正在生成的账号留待下一轮。自动巡检只调用读取接口，不创建视频任务。

自动清理采用可恢复隔离：缺少必要 Cookie 或上游明确返回会话失效时移出可用池，账号记录仍保留。网络错误、限流和未知响应保留原状态并记下原因。重新导入新 Cookie 后校验通过可恢复。

免费日额度从生成回执「今日剩余 N 个视频生成额度」自动记录。列表展示读数时间，零额度与未知额度分别显示；过期或旧版无来源读数显示「待确认」，不会默认补满。UTC 日期切换仅用于保守地标记读数过期，不代表已验证上游额度重置时区。汇总仅统计有效、非冷却账号的当日确认读数，并标明未知账号数；无法据此保证后续生成成功。

可查账户余额与视频日额度分开保存。仅接受成功响应中明确的账户余额字段，模型单次消耗和配置上限不会当成余额。没有读数时保留原值与原时间。付费余额接口的字段支持仍需真实付费账号验证。

自动维护开关、隔离和额度探测可在「系统设置 → dola 账号池」调整。测试服务可设 `DOLA_AUTO_MAINTENANCE=false` 暂停定时巡检。测试必须同时给服务和测试进程设置同一个临时 `ADMIN_DB`，避免测试夹具写入真实数据库。

专项回归：`npm run test:maintenance` 自建临时数据库及本地模拟上游，不需要真实 Cookie，也不会提交生成。已知验证边界：免费回执目前沿用消息链文字提取，尚未取得足够结构样本验证提示词与回执的来源隔离；余额仅作为最近读数参考，不作为扣费或生成成功保证。

2026-09-19 验收：原 smoke 223 项通过；专项测试 81 用例通过（3036 次断言，0 次越界请求）；前端构建通过。浏览器已验证余额 0/未知/过期显示、汇总排除不可用账号、设置保存及重载、立即维护完成后刷新与停用账号跳过。测试使用独立数据；界面截图保存在 `output/playwright/dola-maintenance-desktop.png`。

> ⚠️ 批量操作第三方账号属于对方 ToS 灰色地带，且对方有设备指纹 + 图形验证码 + 请求签名三重风控。
> 高频请求可能触发限制甚至封号，建议保持默认并发。本项目不实现任何绕过验证码的手段。

## 前台入口

后台顶栏一个「前台」按钮，一键打开前台。**有权限就能看到按钮**（哪怕还没配地址 ——
那样点它会提示并直接跳到设置页，不至于变成一个找不到的死功能）。

> 最常见的用法：把它指到自己的**用户端**。比如本项目 `mvp/` 那个视频任务工作台跑在 8787，
> 就填 `http://127.0.0.1:8787`、名字叫「用户工作台」，后台一键就能跳过去。

| 设置 | 说明 |
|---|---|
| `frontend_name` | 按钮上显示的名字 |
| `frontend_url` | 前台地址，必须带 `http://` 或 `https://` |
| `frontend_open_mode` | `tab` = 新标签页直接跳转（默认，最简单）<br>`browser` = **在后台所在机器上开一个真实浏览器窗口** |
| `frontend_browser_visible` | browser 模式下是否显示窗口（关掉=后台静默打开） |

两种模式的区别：

- **tab**：服务端什么都不做，前端 `window.open`。零维护，但如果目标站需要登录态，靠的是你浏览器里已有的登录。
- **browser**：后台用 Playwright 真的开一个 Chromium 窗口（有头），你在这台机器上就能看到、能操作。
  再次点击会**复用已有窗口**（不会每次新起进程），顶栏右侧会出现一个「关闭」图标来关掉它。

### ⚠️ 两个必须知道的安全设计

1. **接口不接受传入的 URL，只打开设置里登记的那一个地址。**
   因为 `browser` 模式会在服务器上**启动进程**——如果允许传任意 URL，
   就等于开放了一个 SSRF 入口（能访问云元数据 `169.254.169.254`、内网管理页等）。
   代码里 `POST /api/frontend/open` 一律忽略请求体里的 `url`，并且校验协议必须是 http/https。
2. **每个 async 路由都要自己 try/catch。** Express 4 **不会**捕获 async handler 抛出的异常，
   未处理的 rejection 会直接终止 Node 进程（整个后台挂掉而不是返回 500）。
   这里真踩过：早期把 URL 校验写在 `try` 外面，在设置里填个 `file://` 就能把服务搞崩。
   现在 `index.js` 里额外加了进程级 `unhandledRejection` 兜底（只记录不退出），但**路由内 try/catch 才是首选**。

## 怎么接你自己的业务

「内容管理」就是给你照着抄的样板：

1. **加表** — 在 `server/db.js` 的 `SCHEMA` 里加一条 `CREATE TABLE`，想加种子数据就写进 `seed()`。
2. **加接口** — 复制 `server/routes/content.js` 改字段名，在 `server/index.js` 里 `app.use('/api/你的资源', ...)`。
   改数据的接口记得调 `audit(req, 'xxx.create', ...)` 写日志，加 `requirePerm('你的权限点')`。
3. **加权限点** — 在 `server/rbac.js` 的 `PERMISSIONS` 里加一行。
4. **加页面** — 复制 `web/src/views/Content.vue` 改列和表单，在 `web/src/router.js` 里注册路由、
   `meta.perm` 填同一个权限点，菜单会自动出现（有权限的用户才看得到）。

要**生成类**的功能（发码、发券、发密钥）直接复用 `server/generate.js`：
`insertMany(db, 表名, 生成函数, rows)` 已经把撞码重试、批量、唯一索引兜底都处理了。

改完 `npm run build` 再 `npm start` 即可。

## 技术选型说明

- **SQLite + better-sqlite3**：单文件、零运维、同步 API 写起来最短。装不上原生模块时会**自动退回**
  Node 内置的 `node:sqlite`（`server/db.js` 里有包装层，两套只差一个 import）。
  之后要换 MySQL/PG，改 `db.js` 那一层即可，路由里的 SQL 基本都是标准的。
- **不引 pinia / vuex / cors / cookie-parser / jsonwebtoken / bcrypt**：
  状态用 `reactive` 就够；前后端同源不需要 cors；JWT、cookie 解析、scrypt 哈希都用 `node:crypto` 自己写。
  依赖越少，接手的人越容易看懂。
- **深色优先**：默认深色，右上角可切浅色，存在 localStorage。

## 已知限制（诚实说明）

- 没有「刷新令牌」机制：JWT 到期就得重新登录（有效期可在设置里调到最长）。
- 没有密码强度策略、登录失败次数限制/验证码 —— 面向内网或小团队够用，
  要上公网请自己补这几项，或在前面挡一层网关。
- 操作日志只记「谁改了什么」，不记字段级 diff。
- 前端 bundle 有 1.2MB（Element Plus 全量引入），内网后台无所谓；
  要做公网首屏优化就改成按需引入 + manualChunks。
