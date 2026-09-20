# 视频任务 MVP — 创建 → 轮询 → 下载

> 当前任务以**自有 Dola 号池 + IPWeb + 原生 30 秒**为准，使用 `admin-dola`。最新能力核验、修复与验收边界见 [NATIVE_30S_ACCEPTANCE.md](NATIVE_30S_ACCEPTANCE.md)。当前新入池的 6 个账号均实测为免费身份，原生 30 秒尚未验证；下方第三方 provider 的历史成功记录不能替代这项验收。不要为开放按钮而修改能力开关。

> 后续纠正：免费身份不等于不支持 30 秒，Pro 也不是时长能力证明。用户确认已有插件成功案例；网站按“实际选择 Seedance 2.5 → 单次请求 30 秒 → 成片真实时长验收”接入，不要求官网显示原生 30 秒菜单，不伪造订阅、不拼接。当前源代码修复和网站真实出片验收须分开记录。

> 最近一次受控真实验收已到达 Dola 提交层，但被上游 `710022002` 限流，没有成片；积分已自动退款，真实 30 秒开关暂保持关闭。详见 [NATIVE_30S_ACCEPTANCE.md](NATIVE_30S_ACCEPTANCE.md)。

> 限流后的保护：生成只使用已配置代理、已核验且在本号池内唯一的出口 IP；共享/未核验出口会在提交前拦截，IPWeb 换 SID 仍撞 IP 时不写入重复配置。它不能替代真实 30 秒成片验收，也不代表供应商出口绝对独享。

对接 Dola 视频服务的可运行 MVP。**provider 可替换**：同一套代码，
`mock` 不联网就能跑通全链路，`dola-workbench` 走已抓包验证的旧工作台，`dola-api` 走新版 Bearer Token API。

接口分析（**已用真实令牌端到端实测**，含真实响应报文）：**[API_ANALYSIS.md](API_ANALYSIS.md)**

> ✅ 真实站点已跑通：浏览器创建任务 → CLI 轮询 5 分钟 → 成功 → 下载 24 MB 真 MP4（`mvp/out/bc5a145d….mp4`）。
> 登录/创建/查询/列表/下载/幂等全部实测；仅删除、带图创建、卡密、管理端未测（会动你的数据或额外扣积分，见文档 §7）。

```
capture/     浏览器抓包脚本 + 原始网络日志 + 截图（API_ANALYSIS 的证据）
mvp/         Node.js 版：核心库 + CLI + HTTP 服务 + Web 页面（零 npm 依赖）
python/      Python 版：单文件库 + CLI（零 pip 依赖）
```

---

## 0. 三十秒跑起来（不需要任何凭据）

```bash
cd mvp
node src/cli.js create --provider mock --prompt '一只橘猫在窗台上晒太阳' --wait --download ./out
```

输出长这样：

```
  [0s] 第 1 次查询：排队中
  [2s] 第 2 次查询：处理中 · 预计还需 1 分钟
  ...
✓ 完成 mock_7d686d6c（已成功，耗时 8s）
  已下载 out/mock_7d686d6c.mp4
```

Web 页面（可视化创建/预览/下载）：

```bash
node src/server.js            # 默认 mock，打开 http://127.0.0.1:8787
node src/server.js --provider dola-workbench   # 切真实站点
# node src/server.js --provider dola-api       # 切新版 Bearer API
```

要求：Node ≥ 20.11（用了内置 fetch / FormData）。**没有任何 npm 依赖，不用 install。**
Python 版要求 ≥ 3.9，同样零依赖。

---

## 1. 切到真实站点（dola-workbench）

### 第一步：配令牌

令牌已经写进 `mvp/.env`（该文件已被 `.gitignore` 忽略，不会进版本库）。换令牌时改那一行；
不想落盘就用环境变量：

```bash
export DOLA_CREDENTIAL='dv_你的令牌'
```

### 第二步：验证登录链路

```bash
cd mvp
node src/cli.js balance --provider dola-workbench
# {"balance": 87, "provider": "dola-workbench"}
```

能拿到余额 = Cookie 会话 + CSRF 整条链路通了。

### 第三步：创建 → 轮询 → 下载

```bash
node src/cli.js create --provider dola-workbench \
  --prompt '一只橘猫在窗台上晒太阳，电影感镜头' \
  --ratio 16:9 \
  --wait --interval 15 --timeout 3600 \
  --download ./out
```

| 参数 | 说明 |
|---|---|
| `--ratio` | `16:9` `9:16` `1:1` `3:4` `4:3` `21:9`，默认 16:9 |
| `--wait` | 阻塞到终态；不加则只提交，打印 task_id |
| `--interval` | 轮询秒数，默认 30（实测快速查询不会被惩罚，只是拿缓存，见文档 `refreshed` 字段） |
| `--timeout` | 总超时秒数，默认 3600；**实测生成耗时 8~15 分钟、最坏 55 分钟**，别设太小 |
| `--image ./a.png` | 参考图，可重复；最多 9 张、JPEG/PNG、合计 ≤ 20MiB |
| `--json` | 机器可读输出 |

其他命令：

```bash
node src/cli.js list                          # 任务列表
node src/cli.js status <task_id>              # 查单个
node src/cli.js download <task_id> --out ./out # 下载
node src/cli.js redeem card_xxxxxxxx          # 卡密兑换积分
node src/cli.js --provider dola-workbench --verbose status <task_id>   # 打印每次 HTTP
```

⚠️ 花积分的操作只有 `create`。`delete` 只隐藏记录不退款（站点原文提示）。

## 1.5 切到新版 Dola API（Bearer Token）

新版接口来自 `新Dola_API接口说明.md`，默认地址是 `https://43.254.166.196`，
认证方式是 `Authorization: Bearer <token>`，和旧工作台的 Cookie + CSRF 不是一套协议。
代码因此注册为独立的 `dola-api` provider，不会改变旧 provider 的行为。

```bash
export DOLA_API_TOKEN='你的 Bearer Token'
export DOLA_API_BASE_URL='https://43.254.166.196'   # 可省略，默认就是这个地址

cd mvp
node src/cli.js balance --provider dola-api
node src/cli.js create --provider dola-api \
  --prompt '一只橘猫在窗台上晒太阳' --ratio 16:9 \
  --wait --interval 10 --timeout 3600 --download ./out
```

这个 provider 已按文档接入：30 秒固定值、3,000 Unicode 字符 prompt 上限、JPG/PNG 参考图数量/尺寸/容量校验、
`Idempotency-Key` 重试、`code:"0"` 的排队/处理中查询、列表、删除、卡密兑换和直链下载。
目前只做了本地模拟接口验证；没有用真实令牌提交新版 API 的付费生成，因此新版服务端的实际扣费、结果直链和图片上传仍标记为待实测。

---

## 2. 作为库用（Node）

```js
import { VideoClient } from './mvp/src/client.js';

const c = new VideoClient({
  provider: 'dola-workbench',
  providerOptions: { credential: process.env.DOLA_CREDENTIAL },
});
await c.login();

const task = await c.createAndWait(
  { prompt: '一只橘猫在窗台上晒太阳', ratio: '16:9' },
  {
    pollIntervalMs: 15_000,
    timeoutMs: 60 * 60_000,
    onProgress: (t, info) => console.log(`#${info.round} ${t.status}`),
  },
);

console.log(task.url);                 // 视频直链
await c.downloadTo(task, './out');     // → out/<task_id>.mp4
```

归一化的任务对象长这样（所有 provider 一致，原始响应在 `.raw` 里）：

```js
{
  id: 'xxxx', status: 'succeeded',        // queued | processing | succeeded | failed | unknown
  url: 'https://...mp4',                   // 成功后才有
  error: null, notice: null,
  charged: 10, createdAt: '...', canDelete: true,
  raw: { /* 服务端原始字段，一个不丢 */ }
}
```

## 3. 作为 HTTP 服务用

```bash
node src/server.js --port 8787 --provider dola-workbench
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 就绪状态 / 登录失败原因 |
| GET | `/api/balance` | 积分余额 |
| GET | `/api/tasks?limit=20` | 列表 |
| POST | `/api/tasks` | `{prompt, ratio?, images?:[{name,dataBase64}], wait?, intervalMs?, timeoutMs?}` |
| GET | `/api/tasks/:id` | 单任务 |
| DELETE | `/api/tasks/:id` | 删除（只隐藏，不退款） |
| GET | `/api/tasks/:id/media` | 视频流代理（直链跨域时给 `<video>` 用） |
| GET | `/api/tasks/:id/download` | 下载（带 Content-Disposition） |
| GET | `/` | 可视化页面 |

curl 示例：

```bash
curl -X POST http://127.0.0.1:8787/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"海边日落，无人机航拍"}'
# {"taskId":"xxxx","status":"queued"}
```

## 3.5 架构：后台是控制面，用户端是用户面

```
┌─────────────── admin 后台（8788）＝ 控制面 ───────────────┐
│  发令牌 / 发卡密 / dola 账号池 / 额度→积分 / 操作审计        │
│  /api/gateway/*  ← 给用户端调的网关（X-Gateway-Key 共享密钥）│
└───────────────────────────┬───────────────────────────────┘
                            │ verify / consume / refund
┌───────────────────────────┴───────────────────────────────┐
│  mvp 工作台（8787）＝ 用户面                                │
│  令牌登录 → 看积分 → 提交生成（扣积分）→ 失败自动退款 → 下载  │
│  生成能力由平台统一持有（provider 可换：mock / dola-workbench / dola-api）│
└────────────────────────────────────────────────────────────┘
```

### ⚠️ 两套令牌长得一样，但**不是一回事**（踩过）

| | 前缀 | 谁发的 | 存在哪 | 用途 |
|---|---|---|---|---|
| **后台令牌** | `dv_` | 本项目 admin 的「访问令牌」页 | 你本机的 `admin/server/data/admin.db` | **用户端登录**（网关模式） |
| **上游令牌** | `dv_` | 43.254.166.145 那个「视频工作台」 | 上游服务器 | 调上游 API |

两个都是 `dv_` + 32 位，看起来能互换，**实际互不相认** ——
拿后台令牌去问上游，上游只会回「登录凭据无效」。

现在的默认接线是**后台为准**：用户端登录走后台网关，不再问上游。
上游令牌只在「平台自己需要调上游生成」时用（`mvp/.env` 的 `DOLA_CREDENTIAL`）。

### 网关接口（后台提供）

```bash
KEY=后台「系统设置 → 用户端网关」里的密钥

# 校验令牌（用户端登录时调）
curl -X POST http://127.0.0.1:8788/api/gateway/verify \
  -H "X-Gateway-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"token":"dv_xxx"}'

# 扣积分（幂等键 ref，一般用扣费流水号）
curl -X POST http://127.0.0.1:8788/api/gateway/consume \
  -H "X-Gateway-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"token":"dv_xxx","ref":"chg-001","points":1,"reason":"video"}'

# 退款（同一个 ref；找不到消费记录会拒绝，防止凭空加积分）
curl -X POST http://127.0.0.1:8788/api/gateway/refund \
  -H "X-Gateway-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"ref":"chg-001","note":"生成失败"}'
```

`consume` / `refund` 都按 `ref` **幂等**（`point_transactions` 表上 `(kind, ref)` 唯一索引），
扣减用 `UPDATE ... WHERE points >= ?` 原子判断，不会重复扣也不会扣成负数。

### 网关接口：视频生成（`provider=admin-dola` 时用）

生成能力放在**控制面**：真实生成要用账号池的 cookie 跑浏览器（要 `a_bogus` 签名），
还要集中管"哪个号在用、有没有被风控"——这些只有后台知道。
用户面只负责"提交意图 + 看进度 + 拿成片"。

```bash
# 提交生成（后台建任务 → 扣积分；积分不够会把任务撤掉不扣）
curl -X POST http://127.0.0.1:8788/api/gateway/gen \
  -H "X-Gateway-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"token":"dv_xxx","prompt":"一只橘猫在窗台上晒太阳","ratio":"16:9","seconds":10}'

# 查进度 —— 完成后 url 就是**无水印优先**的地址
curl "http://127.0.0.1:8788/api/gateway/gen/1?token=dv_xxx" -H "X-Gateway-Key: $KEY"

# 列自己的任务
curl "http://127.0.0.1:8788/api/gateway/gen?token=dv_xxx" -H "X-Gateway-Key: $KEY"

# 流式下载归档成片（支持 Range；工作台代理的就是它）
curl "http://127.0.0.1:8788/api/gateway/gen/1/file?token=dv_xxx" -H "X-Gateway-Key: $KEY"
```

几个刻意的设计：

| 设计 | 为什么 |
|---|---|
| **先建任务占坑，再扣积分；扣不动就撤坑** | 反过来做（先扣后建）会在"账号池空/浏览器不可用"时白扣用户积分 |
| **失败自动退款** | 挂在查询接口上、按 `ref` 幂等 —— 只要有人查过一次，钱就回去了，不依赖用户端实现退款 |
| **`url` 优先给无水印，再退带水印** | 用户拿到手就是干净的；解析失败也不至于没片子 |
| **归档优先于直链** | 上游直链带签名会过期，归档的才长期可下载 |
| **选号前现场体检** | 库里 `status='valid'` 只代表"上次校验时活着"，可能早就死了 |

> 无水印怎么拿到、怎么验证、以及当前账号池的问题，见 **[UNWATERMARK.md](./UNWATERMARK.md)**。

### 用户端登录（可选，向后兼容）

| 场景 | 行为 |
|---|---|
| `mvp/.env` 配了 `ADMIN_GATEWAY_URL` + `ADMIN_GATEWAY_KEY` | **网关模式**：用后台发的令牌登录，积分扣在后台账上 |
| 没配网关 | 旧模式：单租户自用，直接用 `.env` 里的上游令牌，不扣后台积分 |

网关模式下**归属分两种**（别搞混）：

| provider | 归属判据 |
|---|---|
| `admin-dola` | **后台说了算**（`dola_videos.owner_token_id`）。后台对越权请求直接 404，用户端不再用本地账本过滤 |
| 老 `dola-workbench` | 上游按平台账号返回全部任务 → 本地账本 `mvp/data/store.json` 兜住 |

> ⚠️ 踩过：`admin-dola` 模式下如果还用本地账本过滤，**后台补录进来的任务会被全部误判成不存在**。

## 3.6 用户端登录界面

工作台现在支持**用访问令牌登录**：

| 场景 | 行为 |
|---|---|
| 服务端 `.env` 配了 `DOLA_CREDENTIAL` | **免登录**直接进工作台，顶栏显示令牌前缀 + 余额，按钮是「切换令牌」 |
| 服务端没配令牌 | 打开页面就是登录页，要求输入 `dv_…` 令牌 |
| 用户点「切换令牌」/「退出登录」 | 清掉本地令牌，回到登录页，可输入自己的令牌 |

**令牌之间完全隔离**：任务归属按令牌记在本地账本，积分记在后台流水；
顶栏和所有响应里**只出现令牌前缀**，完整令牌不会被回传或写进日志。

接口：
```bash
# 验证令牌（成功返回余额）
curl -X POST http://127.0.0.1:8787/api/session \
  -H 'Content-Type: application/json' -d '{"credential":"dv_xxx"}'

# 之后所有请求带上它
curl -H 'Authorization: Bearer dv_xxx' http://127.0.0.1:8787/api/tasks

# 当前身份（不带令牌时会用服务端默认令牌，返回 source: default）
curl http://127.0.0.1:8787/api/session
```

没登录时业务接口返回 `401 {needLogin: true}`，前端据此弹登录页。

## 4. Python 版

```bash
cd python
export DOLA_CREDENTIAL='你的令牌'

python3 cli.py balance --provider dola-workbench
python3 cli.py create --provider dola-workbench --prompt '一只橘猫在窗台上晒太阳' \
  --wait --interval 15 --download ./out
python3 cli.py list --provider dola-workbench
```

库用法：

```python
from video_provider import VideoClient

c = VideoClient(provider="dola-workbench", credential=os.environ["DOLA_CREDENTIAL"])
c.login()
t = c.create_and_wait({"prompt": "一只橘猫在窗台上晒太阳"}, poll_interval=15, timeout=3600)
print(t["url"])
c.download_to(t, "./out")
```

自定义 provider（Python）：

```python
from video_provider import VideoClient, MockProvider

class MyProvider(MockProvider): ...
c = VideoClient(provider="my", provider_registry={"my": MyProvider})
```

---

## 5. 架构：怎么换 provider

```
VideoClient（门面：createAndWait / waitFor / downloadTo）
   └── Provider 协议（5 个方法）
         login()  createTask()  getTask()  listTasks()  download()
              ├── MockProvider        本地模拟，8 秒跑完
              ├── DolaWorkbenchProvider  旧真实站点（Cookie + CSRF + multipart）
              ├── DolaApiProvider        新真实站点（Bearer + multipart）
              └── 你的 provider        实现同 5 个方法，注册进 REGISTRY 即可
```

Node 版注册：`mvp/src/providers/index.js` 的 `REGISTRY` 加一行。
换服务 = 换 `--provider` 参数，上层代码（CLI / HTTP 服务 / Web 页面）零改动。

### 设计里处理的三个坑（都来自真实站点行为）

1. **业务失败藏在 HTTP 200 里**：`{"code":"0","message":"…"}`。HTTP 层统一判定，抛成 `BusinessError`。
2. **创建响应可能没有 task_id**（前端自己都丢弃创建响应）：先从响应挖 id，挖不到走「列表 diff」兜底。
3. **查询有频率敏感**（前端对每个任务 5 秒去抖）：provider 内置最小查询间隔，轮询太快会自动等。

---

## 6. 实测得到的几条硬事实（都写进代码了）

| 事实 | 影响 |
|---|---|
| 成功是 `code:"1"`，失败是 `code:"0"` 且 **HTTP 仍是 200** | 只看状态码会漏判，HTTP 层统一判定 |
| **csrf 每次刷新 `/api/session` 都轮换** | 用登录时那个 csrf 会 403；`login()` 内部先刷新再取 |
| 创建响应**直接返回 `task_id`** | 不用走「列表 diff」兜底了（兜底逻辑保留，双保险） |
| **同 `Idempotency-Key` 重复提交不重复扣费**（返回 `existing:true`） | 网络超时重试是安全的，`createTask` 已自动用同 key 重试 |
| 列表 `data` 与 `tasks` 是同一份的别名 | 两个都兼容读取 |
| 未完成时 `url` / `error` 是**空串 `""`** 不是 null | 归一化统一转成 `null`，避免上层拿到假值 |
| 直链不需要 Cookie，域名不固定（`v16-` / `v19-dola.dola.com`） | 别硬编码域名 |
| 1 积分/任务，失败自动退款（`billing_state: refunded`） | 只有 `create` 花钱 |

## 7. 已知边界（诚实声明）

- **未实测**：`DELETE`（会抹掉你的任务记录）、带 `images[]` 的创建（额外扣积分）、卡密兑换、管理端。
  清单见 [API_ANALYSIS.md §7](API_ANALYSIS.md#7-未验证--有意未做)。
- mock 的下载产物是占位文件，仅供跑通链路；真实 provider 下的是真视频。
- 令牌在 `mvp/.env`，已加进 `.gitignore`；别提交到任何仓库。

## 7. 重新抓包（站点升级后核对契约）

```bash
cd capture
node capture.mjs                          # 无凭据：抓登录页 + 失败登录
CREDENTIAL=你的令牌 node capture.mjs       # 抓登录成功
CREDENTIAL=你的令牌 CREATE=1 node capture.mjs   # 完整复现「创建视频」（会扣积分！）
```

输出 `capture/network-log.json`（每条请求的 URL/方法/头/体/响应），截图落在同目录。
