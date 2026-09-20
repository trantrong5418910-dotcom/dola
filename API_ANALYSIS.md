# API_ANALYSIS.md — 「视频工作台」(https://43.254.166.145) 接口分析

> **最后更新：2026-09-19（已用真实令牌完成端到端实测）**
> 分析方式：① 真实浏览器（Chromium + Playwright）抓包复现「创建视频」② curl 直连实测 ③ 前端 bundle 逆向
> 抓包原始证据：[`capture/network-log.json`](capture/network-log.json)、`capture/01-login.png`、`capture/web-ui.png`

---

## 0. 结论速览

| 项目 | 结论 |
|---|---|
| 站点形态 | Vue 3 + Element Plus SPA，Go 后端 + nginx |
| 鉴权 | **Cookie 会话**（`video_session`，JWT），登录凭据是「访问令牌」（前缀 `dv_`） |
| 成功/失败判定 | ⚠️ **HTTP 200 + `code:"0"` 也是失败**；成功是 `code:"1"`（字符串，不是数字） |
| CSRF | 非 GET 必带 `X-CSRF-Token`；**csrf 每次刷新 `/api/session` 都会轮换**，必须用最新值 |
| 创建视频 | `POST /api/v1/videos`，**multipart/form-data**；响应**直接返回 task_id**（前端自己没用） |
| 计费 | **1 积分/任务**；失败自动退款（`billing_state: refunded`） |
| 幂等 | ✅ 实测生效：同 `Idempotency-Key` 重复提交返回 `existing:true` + 同一 task_id，**不重复扣费** |
| 下载 | 无独立下载接口，直接用任务里的 `url` 直链（dola.com），**不需要 Cookie** |
| 耗时 | 实测 8~15 分钟，最坏约 55 分钟 |

**验证状态图例**：✅ 已实测验证　🟡 前端源码确认（逻辑可信）　❌ 未验证

---

## 1. 鉴权 ✅

### `POST /api/session` — 登录

```
→ POST /api/session
   Content-Type: application/json
   {"credential":"dv_…"}

← 200 OK
   Set-Cookie: video_session=<JWT>; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict
   {"code":"1","csrf":"dcP5q71-GYBT4qiEj5C4n3u0Ce7HKt5tGAwkwNhpFH8","role":"user"}
```

- Cookie 名 `video_session`，内容是 JWT：`{"sub":47,"role":"user","exp":<unix>,"nonce":"…"}`，12 小时有效
- 登录响应**只给 csrf 和 role**，没有余额 —— 余额要再 GET 一次
- 错误：`401 {"code":"0","message":"登录凭据无效"}` ✅

### `GET /api/session` — 会话详情（登录后再查一次）

```
← 200
{"balance":46,"code":"1","csrf":"4DytwmsRFghCLcYLfyvJFjvR8Sw_urJCI5bB9Gzn3t0","role":"user","token_id":47}
```

⚠️ **`csrf` 每次调用都会变**（登录时是 `dcP5q71…`，这次是 `4DytwmsR…`，再刷又变）。
拿登录时那个 csrf 去发请求会 403。实现里必须「刷新会话 → 取最新 csrf → 再发业务请求」，
本项目 `login()` 内部就是这个顺序。

### CSRF 与幂等头

| 头 | 用在哪 | 缺失后果 |
|---|---|---|
| `X-CSRF-Token` | 所有非 GET（登录接口除外） | `403 {"code":"0","message":"请求校验失败"}` ✅ |
| `Idempotency-Key` | 创建视频、兑换卡密 | 不强制，但**带上才能防重复扣费**（见 §3）✅ |

未登录时的三种错误文案可区分（都实测过）：
`请先登录` / `登录凭据无效` / `令牌无效或已禁用`。

---

## 2. 创建视频 `POST /api/v1/videos` ✅

**请求**（浏览器真实抓包，`capture/network-log.json`）：

```
→ POST /api/v1/videos
   Content-Type: multipart/form-data; boundary=----…
   X-CSRF-Token: <最新 csrf>
   Idempotency-Key: <uuid v4>
   Cookie: video_session=…

   Content-Disposition: form-data; name="prompt"
   一只橘猫在窗台上晒太阳，电影感镜头，暖色调
   Content-Disposition: form-data; name="ratio"
   16:9
   Content-Disposition: form-data; name="seconds"
   30
```

**响应**（✅ 关键未知项已解决 —— **响应里确实有 task_id**）：

```json
{"balance":45,"charged_points":1,"code":"1","status":"queued","task_id":"bc5a145d80d9b7089cba69b10b164a4d"}
```

| 字段 | 说明 |
|---|---|
| `task_id` | ✅ **就在响应里**。前端源码把它丢弃了（直接刷新列表），但服务端给了 |
| `status` | 创建后立刻是 `queued` |
| `charged_points` | 本次扣的积分（实测 **1**） |
| `balance` | 扣后余额（45，创建前 46）—— 省一次 `/api/session` 查询 |

**参数约束**（🟡 来自前端源码，服务端校验未实测）：

| 参数 | 约束 |
|---|---|
| `prompt` | 必填，≤ 12000 字 |
| `ratio` | `16:9` `9:16` `1:1` `3:4` `4:3` `21:9`，默认 `16:9` |
| `seconds` | 前端写死 `30`（输入框 disabled） |
| `images[]` | 可选，最多 9 张 JPEG/PNG，合计 ≤ 20MiB，单图单边 ≤ 8192px |

---

## 3. 幂等性 ✅（这条最值钱）

用**同一个** `Idempotency-Key` 连发两次创建：

```
第1次 → {"balance":44,"charged_points":1,"code":"1","status":"queued","task_id":"19f2baae…"}
第2次 → {"balance":44,"charged_points":1,"code":"1","existing":true,"status":"queued","task_id":"19f2baae…"}
                                                    ^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^ 同一个任务
余额：46 → 45(第一次) → 44…不对，是 45 → 44，第二次仍是 44 ⇒ 只扣了一次
```

结论：**网络超时后拿同一个 key 重试是安全的，不会重复扣费、不会建两个任务。**
本项目 `createTask()` 已把这个行为固化：网络层失败时自动用**同一个** key 重试一次。

---

## 4. 查询任务 `GET /api/v1/videos/{task_id}` ✅

**响应是「扁平字段 + 嵌套 `task`」双份**（`refreshed` / `query_notice` 只在顶层）：

```json
{
  "billing_state": "charged", "charged_points": 1, "code": "1",
  "error": "", "estimated_wait": "", "query_notice": "",
  "refreshed": false, "status": "processing",
  "task": {
    "task_id": "bc5a145d…", "status": "processing",
    "charged_points": 1, "billing_state": "charged",
    "created_at": "2026-09-18T22:52:52.111692Z",
    "updated_at": "2026-09-18T22:52:52.420827Z",
    "can_delete": false
  },
  "task_id": "bc5a145d…", "url": ""
}
```

成功态（`task` 里多一个 `url`，顶层同样有）：

```json
{"status":"succeeded","task":{…,"url":"https://v19-dola.dola.com/765e171e…/oMStqt4udiAUtAZ1Y3AzEtEtft1CHACsNB1GVi/","can_delete":true},
 "task_id":"79efff39…","url":"https://v19-dola.dola.com/765e171e…/"}
```

| 字段 | 说明 |
|---|---|
| `status` | `queued` / `processing` / `succeeded` / `failed` |
| `url` | 视频直链，**未完成时是空字符串 `""`**（前端判断用，别当 null 漏掉） |
| `estimated_wait` | 排队预估，实测值 `"15分钟"`；完成后为空串 |
| `refreshed` | **是否真去上游查了一次**。连续快速查询时只有第一次是 `true`，后续 `false`（服务端缓存/去抖） |
| `query_notice` | 查询侧提示，实测始终为空串 —— 快速轮询**不会被惩罚**，只是拿缓存 |
| `billing_state` | `charged` / `refunded`（失败自动退款） |
| `can_delete` | 处理中 `false`，终态 `true` |
| `error` | 失败原因，成功时为空串 |

实测失败样例（说明上游模型）：

> 出于肖像保护考虑，未认证人脸暂不支持用 Seedance 2.5 生成视频。你可以尝试换其它参考图或文生视频。

---

## 5. 任务列表 `GET /api/v1/videos?cursor=` ✅

```json
{"code":"1","data":[…],"next_cursor":"","tasks":[…]}
```

- ⚠️ **`data` 和 `tasks` 是同一份内容的两个别名**（前端只认 `tasks`，实际两个都在）
- `next_cursor` 为空串 `""` 表示没有下一页
- 列表项字段比详情少：只有 `task_id / status / charged_points / billing_state / created_at / updated_at / can_delete`（成功时多 `url`、失败时多 `error`）
- **列表里没有 prompt** —— 想知道某任务写了什么，得看详情或用返回的 `url`

---

## 6. 下载 ✅

**没有独立下载接口**，直接 GET 任务里的 `url`：

```
→ GET https://v16-dola.dola.com/258bdaef…/video/tos/…/
← 200  binary/octet-stream  26,878,939 B   （不带 Cookie）
← 200  binary/octet-stream  26,878,939 B   （带 Cookie，结果一致）
```

`file` 校验：`ISO Media, MP4 Base Media v1` —— 是真视频。
本项目实测下载成功：`out/79efff399211c00ca336dbbc5bb6998a.mp4`（22.3 MB）。

> 直链域名不固定（`v16-dola` / `v19-dola` 都出现过），**不要硬编码**。

---

## 7. 未验证 / 有意未做

| 项 | 状态 | 原因 |
|---|---|---|
| `DELETE /api/v1/videos/{id}` 成功响应 | ❌ | 端点存在（未登录 401），但**删除会抹掉你的任务记录**，没实测 |
| 带 `images[]` 的创建 | ❌ | 会额外消耗积分，等你确认要测再说 |
| 服务端是否校验 `ratio` / `seconds` | ❌ | 前端已拦截，服务端未试（乱传会浪费积分） |
| `POST /api/v1/cards/redeem` | ❌ | 需要一张未使用的 `card_` 卡密 |
| `/api/admin/*` 全套 | ❌ | 需要管理员凭据 |
| `next_cursor` 分页语义 | 🟡 | 你的任务量一页就返回完，没触发翻页 |

其余（登录、创建、查询、列表、下载、幂等）**全部已用真实令牌端到端实测**。

---

## 8. 实测时间线（本次验证的真实记录）

| 时间(UTC) | 动作 | 结果 |
|---|---|---|
| 22:45 | `POST /api/session` | 200，拿到 `video_session`，`role=user` |
| 22:45 | `GET /api/session` | `balance=46, token_id=47`，csrf 轮换 |
| 22:52 | 浏览器复现「创建视频」 | `{"task_id":"bc5a145d…","status":"queued"}`，余额 46→45 |
| 22:52 | `GET /api/v1/videos/bc5a145d…` | `status=processing, refreshed=false` |
| — | 幂等测试（同 key 两次） | 第二次 `existing:true`，同一 task_id，**只扣 1 积分** |
| — | 下载直链（带/不带 Cookie） | 均 200，26.9 MB 真 MP4 |
| — | `79efff39` 处理中 → 成功 | 21:59:51 创建，22:54:20 完成（约 55 分钟） |

**生成耗时样本**（`created_at` → `updated_at`）：7.6 / 10 / 12 / **54** 分钟。
⇒ 轮询超时默认设 **60 分钟**、间隔 **30 秒**（本项目已按此设默认值）。

---

## 9. 完整时序

```
登录      POST /api/session {credential}
             ← Set-Cookie: video_session(JWT) + {code:"1", csrf, role}
刷新会话  GET  /api/session
             ← {balance, csrf(已轮换!), role, token_id}     ← 之后都用这个新 csrf
创建      POST /api/v1/videos   multipart(prompt/ratio/seconds/images[])
             头: X-CSRF-Token + Idempotency-Key
             ← {task_id, status:"queued", charged_points, balance}   ★ task_id 在这里
查询      GET  /api/v1/videos/{task_id}
             ← {status, url, error, estimated_wait, refreshed, query_notice, task:{…}}
列表      GET  /api/v1/videos?cursor=
             ← {code:"1", data:[…], tasks:[…], next_cursor:""}
下载      GET  task.url   （dola.com 直链，无需 Cookie）
删除      DELETE /api/v1/videos/{task_id}   （只隐藏记录，不退款 —— 未实测）
```
