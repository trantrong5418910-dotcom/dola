# 无水印成片：机制、实现与实测证据

> 目标：**生成的视频要拿到无水印版本，再返回给用户端工作台。**
> 本文记录它到底怎么做到的、我们怎么验证的、以及卡在哪。

---

## 1. 结论先行

| 问题 | 答案 |
|---|---|
| 无水印怎么拿？ | 从 dola 会话里取 `fallback_api`，追加 `channel=no&codec_type=8&logo_type=unwatermarked` 再请求一次 |
| 是"破解"吗？ | **不是**。这是服务端本来就认的渲染参数，网页 UI 没暴露而已。仍要带该账号的有效 cookie |
| 验证过吗？ | ✅ 真成了。同一会话同时拿到带水印/无水印两版，逐帧比对确认 |
| 画质差别 | **无水印版更清晰**：码率 `3294 → 14198`（约 4.3×），体积 2.03 MiB → 8.74 MiB |
| 返回给工作台了吗？ | ✅ 打通。工作台下载到的字节 sha256 与后台归档文件**完全一致** |
| 现在能直接生成吗？ | ⚠️ 代码已就绪，但**出口 IP 被上游限流**（`710022002 访问频繁`）。限流不再会烧账号（已修），但要真正跑通得换出口 IP。详见 §6 |

---

## 2. 机制：三行代码就是全部秘密

dola 的 IM 消息链（`/im/chain/single`）里，每条视频消息都带一个 `fallback_api` 字段 —— 它本身是一个**可以再次请求**的视频元信息接口：

```
https://vod-urls-mya.byteintlapi.com/video/fplay/1/dbd2c656.../v186a3gm000cdamv5cfog65js3
```

对它**改写三个查询参数**再请求一次：

```
channel=no   codec_type=8   logo_type=unwatermarked
```

返回体里的 `main_url` 就是无水印版本。

### 实测对比（同一会话、同一 prompt）

| | 原始直链（网页拿到的） | 追加参数后的直链 |
|---|---|---|
| `logo_type` / `lr` | `lr=cici_ai` | `lr=unwatermarked` |
| `codec_type` | `3` (hevc) | `8` (h264) |
| `br`（码率） | `3294` | `14198` |
| 体积 | 2.03 MiB | 8.74 MiB |
| 右下角 | **有 "Dola AI" 水印** | 干净 |
| 画质 | 糊 | 明显更锐利 |

> 证据文件：`admin/dola-native-10s.mp4`（带水印） vs `admin/server/data/videos/unwatermarked-38417915133082129.mp4`（无水印` 8.74 MiB`）

### `main_url` 有两种形态，第二种要解密

1. **直接是 http(s) 直链** → 拿来即用。
2. **`qAAB` 开头的密文** → 需要 `key_seed` 做 AES-128-CBC 解密：
   - 密钥/IV 由 `key_seed` 的 **SHA-512 摘要** 拼接固定 salt 后派生
     （salt 见 `unwatermark.js` 的 `QAAB_SALT_HEX`）
   - **坑**：token 整体就是一个 base64 串，解码后前 4 字节是魔数 `a8 00 01 00`。
     它之所以长成 `qAAB` 开头，是因为 `base64(a8 00 01 00 ...)` 的前 4 个字符恰好是 `qAAB`。
     所以**不能**写成 `'qAAB' + base64(...)`（那是双重编码，解密必废）。
     这个坑在冒烟测试里用加解密往返钉死了。

### 一个重要的维护性坑

`fallback_api` 藏在**多层转义**里（`\\/`、`\u0026`，甚至"字符串里又套了一层 JSON 字符串"）。
所以提取逻辑走**两条路**，互为兜底：

- 结构化递归遍历（遇到"字符串里嵌 JSON"继续钻进去）
- 正则扫原始响应文本

只留一条路，某天 dola 换个包装方式就会静默失效——**任务照样显示成功，只是没有无水印版本**，很难查。

---

## 3. 实现位置

| 文件 | 职责 |
|---|---|
| `admin/server/dola/unwatermark.js` | **核心**。纯函数（可单测）+ 网络请求分开 |
| `admin/server/dola/generator.js` | 生成编排：提交 → 轮询 → 解析无水印 → **归档到本地** |
| `admin/server/routes/gateway.js` | 对用户端暴露：`/gen`（建任务）、`/gen/:id`（查，返回无水印 URL）、`/gen/:id/file`（流式下载归档） |
| `mvp/src/providers/admin-dola.js` | 用户端 provider，接网关 |
| `admin/server/dola/unwatermark-check.mjs` | 命令行验证工具（不耗额度） |
| `admin/server/dola/import-conv.mjs` | 把已有会话/本地文件补录进任务表 |

### 无水印优先的取值链

```
本地归档  >  无水印直链  >  带水印直链
```

**为什么归档排第一**：`.../video/tos/...` 是**带签名的临时链接**（URL 里有 `dy_q` 过期时间戳），
几小时到几天后就 403。不归档的话，用户隔天点"下载"只会拿到死链 ——
我们已经在解析无水印上花了功夫，白费。
所以解析成功后必须把文件抓回 `admin/server/data/videos/`。

**归档失败不算任务失败**：直链当次还有效，能看能下，只是本地没留底。

---

## 4. 怎么自己验证（不花账号额度）

```bash
# ① 只查一个会话，看能不能解析出无水印（不消耗任何额度）
node server/dola/unwatermark-check.mjs \
  --conv <conversationId> \
  --cookie-file "/path/Dola_xxx_Cookies.json"

# ② 顺带下载到本地
node server/dola/unwatermark-check.mjs --conv <id> --cookie-file ./c.json --download

# ③ 手工喂一个 fallback_api 试
node server/dola/unwatermark-check.mjs --fallback "https://vod-urls-mya.byteintlapi.com/..." --cookie-file ./c.json
```

输出会打印**参数改动前后对比**，能看到 `lr=cici_ai → lr=unwatermarked`、`br=3294 → br=14198`。

> ⚠️ 要有**活着的** cookie。死号连会话都读不出来（`/im/chain/single` 只回 148 字节）。

---

## 5. 端到端的完整验收记录

```
① 工作台登录          → {"ok":true,"credentialPrefix":"dv_AJf8XP","balance":1000}
② 工作台任务列表      → #4 | ready | 无水印=true | 归档=true
③ 经工作台取视频      → HTTP 200
                        content-type: video/mp4
                        content-length: 9159962
                        X-Video-Unwatermarked: 1
④ sha256 比对         → /tmp/via-workbench.mp4
                        a6eca7900749de896a85cf06666de721cd93ac72b03a0845ead879fb7c1b8b09
                        admin/server/data/videos/unwatermarked-*.mp4
                        a6eca7900749de896a85cf06666de721cd93ac72b03a0845ead879fb7c1b8b09   ← 完全一致
⑤ 下载模式            → Content-Disposition: attachment; filename="4-nowatermark.mp4"
⑥ Range 请求          → HTTP 206, Content-Range: bytes 0-1023/9159962   （浏览器拖进度条靠它）
⑦ 越权（别的令牌）    → 404
⑧ 别的令牌的任务列表  → {"items":[]}
```

冒烟测试：`admin` **200 项断言全绿**（含 18 项无水印纯函数 + 10 项网关生成接口）。

---

## 6. 曾经的"账号快速失效" —— 真因是**限流触发了前端自毁会话**（已修）

> 这一节最早写的是"账号以分钟级速度失效，外部原因"。**那个结论是错的。**
> 后来抓包坐实了真正的因果链，并已修复。保留排查过程是因为它很典型：
> 症状看起来像"账号被封"，实际是"我们的提交撞了限流，而 dola 前端遇到限流会把自己登出"。

### 6.1 真因（抓包坐实）

```
提交 → POST /chat/completion  (SSE)
         event: STREAM_ERROR
         {"error_code":710022002, "error_msg":"当前服务访问频繁，请稍后重试"}
   ↓
       HTTP 302 /
       HTTP 200 /passport/web/logout/        ← ★ 前端自己把会话登出了
   ↓
       会话死亡，之后所有探测都是 code 710012014
```

**关键点：`710022002` 是"限流"，不是"账号坏了"。**
但 dola 的 Web 前端在收到这个错误后的处理是**主动调用登出接口**——
于是**每失败一次提交，就永久烧掉一个账号**（cookie 里的会话被服务端注销）。

这完美解释了所有"诡异"现象：

| 现象 | 旧解释（错） | 真因 |
|---|---|---|
| 校验说活 → 15 秒后死 | 账号被风控清号 | 提交撞限流 → 前端自毁会话 |
| 8 个号"同批签发、先后失效" | 按批清理 | 每个号被我们用失败提交"点掉"一个 |
| "开浏览器不踢会话，一提交就死" | （当时没测出来） | 开浏览器只读，提交才触发限流 |

### 6.2 修复：把前端的自动登出拦下来

```js
// generator.js / submitViaBrowser()
await ctx.route('**/passport/**/logout**', (route) => route.abort());
```

拦截后：限流就只是"这次没提交成功"，**会话还在**，稍后重试即可。

配套还加了两条：

1. **限流 ≠ 死号**：识别 `710022002` 后不再把账号标 `invalid`，
   而是写 `cooldown_until`（默认 30 分钟）并跳过 —— 库里 `status` 和 `cooldown` 是两个正交的维度。
2. **错误信息说清根因**：以前只报"没拿到 conversationId"（完全看不出是限流），
   现在明确说"上游限流 code 710022002，账号本身没问题，根因是同一 IP 打太多账号"。

### 6.3 实测对比

| | 修复前 | 修复后 |
|---|---|---|
| 提交撞限流 | 前端自毁会话 → **账号报废** | 拦截登出 → **账号存活**（实测 #112 提交失败后 `self_brief` 仍 ok） |
| 账号状态 | 被误标 `invalid` | 保持 `valid` + 写入冷却时间 |
| 提示 | "没拿到 conversationId" | "上游限流 710022002，账号没问题，冷却 30 分钟" |
| 积分 | 退款 | 退款（余额回到原值） |

### 6.4 剩下的真问题：出口 IP 被限流，而且**不是按小时重置的**

`710022002` 的根因是**同一个出口 IP 在短时间内操作了太多账号**
（那天我们在一个 IP 上跑了 13 账号批量校验 + 多次提交尝试）。

**实测：这个限流很"黏"。** 最后一次提交后隔了 **3 小时**再试，依然 `710022002`。
所以它不是"等一会儿就好"的软限流，而是这个 IP 在相当长时间内被标记了。

结论很直接：**没有独立出口 IP，就完全无法生成。** 这不是"规模化才需要考虑"的优化项，
而是**能否跑通的前提**。

唯一的解法是每账号一条独立出口代理（见 §7）。

### 6.5 修复的效果（两次实测确认）

拦截前端自登出之后，**限流不再烧账号**：

| 账号 | 事件 | 结果 |
|---|---|---|
| #112 | 提交撞限流 | ✅ 提交后 `self_brief` 仍 ok，写入 30 分钟冷却 |
| #21 (dola001) | 提交撞限流 | ✅ 提交后 `self_brief` 仍 ok，写入 30 分钟冷却 |

改动前，同样这两次序列会把账号打成 `710012014`（永久失效，只能重新登录导出）。

### 6.6 ⚠️ 一个自己踩出来的坑：探测失败 ≠ 会话失效

修好代理支持之后又踩了一次，值得单列：

`pickLiveAccount`（生成前的体检）原本是「探测失败就标 invalid」。而当时
`proxyUrlOf` 有个写法错误 —— `String(acc?.proxy || acc || '')`，
在「没配代理」时 `'' || acc` 会**回落到整个账号对象**，`String(对象)` = `"[object Object]"`，
被当成代理地址用了。结果**所有请求全部失败**，然后体检把 **3 个健康账号误标成 invalid**。

**数据被自己污染，比探测失败本身严重得多。** 两条修正：

1. 取值不要用 `||` 串联不同语义的表达式（见 `dola/proxy.js` 的 `pickProxyString`）。
2. **只在拿到"会话确实死了"的业务码（`710012014` / `710012001`）时才写 `invalid`**；
   网络错误、超时、HTTP 非 200、未知 code —— 一律不碰账号状态。

已补 18 项回归测试钉死这类问题（`admin/test/smoke.js` 的「出口代理」段）。

### 6.7 保留：两个仍然有效的诊断手法

**① 匿名对照** —— 把 cookie 剥到只剩 `ttwid`/`odin_tt`/`s_v_web_id`/`msToken` 再打同样的接口。
若结果与完整 cookie 完全一致，说明接口链路健康，`710012014` 就是**"未登录"的普通返回**，
不是"封号"专属码。

**② 解码 `sid_guard`** —— 它内嵌会话的签发时间与有效期（URL 编码，`%7C` = `|`）：

```
<sessionid> | <签发时间戳> | <有效秒数> | <过期时刻>
4d5080ee…   | 1789721864   | 5184000    | Tue, 17-Nov-2026 08:57:44 GMT
```

判读：名义过期时间还没到却已判未登录 → **是被主动注销，不是自然过期**；
多个号签发时间戳挤在几分钟内 → 同一批批量登录出来的。

> ⚠️ 注意：这两个手法能证明"登录态被注销"，**不能证明"账号被永久封禁"**。
> dola 没有账号密码登录，验证账号还在不在的唯一办法是**用原登录方式重登一次**。

### 6.8 仍然是坑的地方

- **批量校验也走同一个 IP** —— 13 个号一次校验就是几十个请求，本身就在推高限流。
  真要多账号，校验也该分流到各自的出口 IP。
- `sid_guard` 的 TTL 是 60 天，但**不代表能活 60 天** —— 一旦被限流自毁就立刻作废。

### 顺带修掉的一个真 bug 🔧

批量校验之前用的是 `checkSession`，它走 `/alice/user/config/pull` ——
**那条接口对「半失效」状态（code `710012014`）完全无感，会返回 ok**。

结果：**8 个号批量校验全绿，其中 4 个其实早就死了**，拿去生成必然失败，
而且报错是"没拿到 conversationId"这种看不出根因的话。

已修：有效性 = `config/pull` 通 **且** `self_brief` 通，缺一不可（`routes/dola.js`）。
同时在生成前加了**现场体检**，死的当场标 invalid 并跳过、自动落到下一个号。

### 可靠的判据（记住这两个）

```
/alice/profile/self_brief   → code 0 = 活，710012014 = 半失效
/alice/user/launch          → is_login = "1" = 活，"0" = 死
```

两者实测完全一致，比 `config/pull` 灵敏得多。

---

## 7. 怎么办（给下一步的建议）

按性价比排序：

1. **每账号独立出口 IP（唯一的根治手段）** ——
   `710022002` 的根因就是同一个 IP 操作了太多账号。这正是方悦浏览器内置 **sing-box** 的原因。
   想上规模，这一步绕不过去。实现上给 `dola_accounts` 加一列 `proxy`，
   在 Playwright 的 `browser.newContext({ proxy })` 里用上即可。
2. **拉长间隔 + 低并发**：批量校验也走同一 IP，13 个号一次校验就是几十个请求，
   本身就在推高限流。校验并发降到 1～2，并且两次操作之间留出时间。
3. **别再用"失败提交"去试探账号** —— 现在有拦截兜底（账号不会死），
   但每次试探都在给限流计数器加数。要判断号活不活，用 `self_brief`（只读，轻）就够。
4. **加"号池健康度"看板**：把 `self_brief` 结果和 `cooldown_until` 打点出来，
   一眼看出"还剩几个能用 / 几个在冷却"，别等用户提交了才发现没号。
5. **缩短反馈环**：生成前体检的结果都落库（`last_used_at` / `last_error` / `cooldown_until` 已有），
   能画出号池的衰减曲线，也能提早看出"限流是不是常态"。


---

## 8. 命令速查

```bash
# ---- 起服务 ----
cd admin && node server/index.js          # 控制面（后台）8788
cd mvp   && node src/server.js --port 8787 # 用户面（工作台）8787

# ---- 冒烟测试 ----
cd admin && node test/smoke.js            # 218 项
cd mvp   && node test/smoke.js            # 9 项

# ---- 代理配置（IPWeb）----
# ① 先验一条（不写库）
node scripts/assign-proxies.mjs --test \
  --from-export "gate2.ipweb.cc:7778:B_xxxxx_KR___30_Ab000001:密码"
# ② 验通了批量配给所有还没代理的号（逐条先连 ipinfo.io 验证）
node scripts/assign-proxies.mjs \
  --from-export "gate2.ipweb.cc:7778:B_xxxxx_KR___30_Ab000001:密码" --country KR --minutes 30
# ③ 看覆盖率
curl -H "Authorization: Bearer <后台JWT>" http://127.0.0.1:8788/api/dola/accounts/proxy/summary

# ---- 排查工具（都不消耗生成额度）----
node server/dola/exp-quota-visible.mjs --account-id 110      # 额度能不能在生成前查到
node server/dola/exp-measure-traffic.mjs --account-id 110 --profile /tmp/p  # 量代理流量
node server/dola/exp-kill-step.mjs --account-id 113          # 分步定位"哪一步弄死的会话"
node server/dola/import-conv.mjs --conv <id> --cookie-file ./c.json  # 补录历史会话

# ---- 运维 ----
node scripts/clean-profiles.mjs                              # 看浏览器缓存占了多少
node scripts/clean-profiles.mjs --older-than 30 --apply      # 清 30 天没用的

# ---- 生成一条（消耗 1 积分 + 1 个账号的日内额度）----
curl -X POST http://127.0.0.1:8788/api/gateway/gen \
  -H "X-Gateway-Key: <网关密钥>" -H 'Content-Type: application/json' \
  -d '{"token":"<用户令牌>","prompt":"一只橘猫在窗台上晒太阳","seconds":10}'

# 查进度（完成后 url 就是"本地归档 / 无水印"优先的地址）
curl "http://127.0.0.1:8788/api/gateway/gen/1?token=<用户令牌>" \
  -H "X-Gateway-Key: <网关密钥>"
```

## 9. 代理流量成本：一次生成要花多少？（实测）

住宅代理按 **GB 计费**，所以"一次生成消耗多少流量"直接决定成本。**实测数据**如下。

### 9.1 流量都花在哪了（CDP 实测，压缩后真实字节）

一次生成要拉 **500 个请求 / 约 12.2 MB**，构成是：

| 资源类型 | 流量 | 占比 |
|---|---|---|
| **Script** | **10.17 MB** | **84%** |
| Stylesheet | 0.69 MB | 6% |
| XHR（真正的业务接口） | 0.54 MB | 4% |
| Other / Image / Ping / Document | 0.79 MB | 6% |

**关键结论：84% 是应用的 JS 包**，业务接口只占 4%。
JS 包**拦不得**（拦了页面跑不起来），所以省这块只能靠**缓存**。

### 9.2 解法：每账号一个持久化浏览器 profile

用 Playwright 的 `launchPersistentContext(profileDir)`，把 HTTP 缓存写到磁盘。
第二次起 JS/CSS 直接命中本地缓存：

| | 冷启动（首次） | 热启动（带缓存） |
|---|---|---|
| 打开页面 + 进面板 | **12.20 MB** | **0.36 MB** |
| 其中 Script | 10.17 MB | **0.00 MB** |
| profile 占盘 | — | 约 19 MB |

**流量降到 1/34。** 另外顺手拦掉 `image`/`font`/`media`（实测只省 1%，白省）。

所以单次生成的代理流量：

```
冷启动（每账号第一次）：约 12~15 MB
热启动（之后每次）    ：约 1~1.5 MB   ← 0.36MB 页面 + 提交/轮询
```

### 9.3 代价与运维

- **磁盘**：每账号约 19 MB。1000 个号 ≈ 19 GB，要定期清理：
  `node scripts/clean-profiles.mjs`（只读查看）→ `--older-than 30 --apply`
  删 profile 只丢缓存，**不影响登录态**（cookie 每次从库里注入）。
- **并发**：profile 目录不能并发用，所以同一账号同一时刻只允许一个浏览器
  （`generator.js` 里有 `ACCOUNT_LOCKS` 兜住）。
- **崩溃残留**：进程被强杀时 Chromium 会留下 `SingletonLock`，
  下次启动会失败 —— 代码里检测到就清锁重试一次，否则一个账号崩一次就永久起不来了。

### 9.4 充多少够用（IPWeb 定价 + 实测流量推算）

IPWeb 动态住宅的档位（随充随用，单位 USD）：

| 流量包 | 单价 | 价格 |
|---|---|---|
| 2 GB | $2.5/GB | $5 |
| 10 GB | $2.3/GB | $23 |
| 50 GB | $1.8/GB | $90 |
| 100 GB | $1.5/GB | $150 |
| 1 TB | $0.9/GB | $900 |

> 注：**粘性会话时长上限是 1~30 分钟**（官方 FAQ），不是越长越好。
> 一次生成从提交到出片约 4~5 分钟，30 分钟足够覆盖。

按"每号每天 2 条视频"（免费号每天 4 额度、每条耗 2）推算：

| 规模 | 冷启动一次性 | 日常流量/天 | 一个月 | 建议档位 |
|---|---|---|---|---|
| **13 个号** | 13 × 12 MB ≈ 160 MB | 26 条 × 1.2 MB ≈ **31 MB** | ≈ 0.95 GB | **$5（2 GB）够跑约 2 个月** |
| 100 个号 | 1.2 GB | 200 条 × 1.2 MB ≈ **240 MB** | ≈ 7 GB | $23（10 GB）/月 |
| 1000 个号 | 12 GB | 2000 条 × 1.2 MB ≈ **2.4 GB** | ≈ 72 GB | $150（100 GB）/月 |

**所以先充 $5（2 GB）就够把 13 个号跑通并长期用** —— 冷启动那 160 MB 是一次性的。



```bash
# 启动后台（8788）与用户端（8787）
cd admin && node server/index.js
cd mvp && node src/server.js --port 8787

# 端到端冒烟
cd admin && node test/smoke.js        # 200 项
cd mvp   && node test/smoke.js        # 9 项

# 生成一条（会消耗 1 点积分 + 1 个账号额度）
curl -X POST http://127.0.0.1:8788/api/gateway/gen \
  -H "X-Gateway-Key: <网关密钥>" -H "Content-Type: application/json" \
  -d '{"token":"<用户令牌>","prompt":"一只橘猫在窗台上晒太阳","seconds":10}'

# 查进度（完成后 url 就是无水印优先的地址）
curl "http://127.0.0.1:8788/api/gateway/gen/1?token=<用户令牌>" \
  -H "X-Gateway-Key: <网关密钥>"
```
