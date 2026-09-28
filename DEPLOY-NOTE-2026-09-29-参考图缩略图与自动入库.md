# DEPLOY NOTE — 2026-09-29 参考图三连修：缩略图管线 + 上传即入库 + 缩略图不压字

- **上线时间**：2026-09-29 02:50（+08:00）／ 2026-09-28 18:50Z
- **目标机器**：`119.28.133.192`（腾讯云 / 宝塔），SSH 别名 `dola`
- **应用目录**：`/www/wwwroot/dola.fei85.cn/admin/`
- **服务**：`pm2 reload dola-admin`（新 PID 1996881），端口 8788，nginx 前门 `admin.fei85.cn`
- **备份**：
  - 远端静态：`/root/bak-public-20260929-024835-thumb-lib.tgz`（17.9 MB）
  - 远端服务端源码：`/root/bak-server-src-20260929-024930-thumb.tgz`（15 KB）
- **验收**：Playwright 端到端 **19/19**，脚本 `/tmp/verify-thumb-lib.mjs`，日志与截图 `admin/output/thumb-lib-20260929/`

---

## 0. 根因：一个「展示位只有几十像素，却一直在送 4MB 原图」的老问题

飞哥这轮发了两条反馈，加上上一轮留下的「参考图提交入口怎么还是空的」，
**三条其实是同一个根因的三种表现**：

参考图库 / 任务暂存里的图，**原图 1.8–5.2 MB 一张**，而所有展示位只有几十像素：

| 位置 | 展示尺寸 | 修复前实际下载 |
|---|---|---|
| 图库页封面 | 卡片几十 px | 14 张 = **57 MB**（十三个卡片是空框） |
| 「从参考图库选」卡片 | 58 px | 一开就并发拉 14 张原图 |
| 工作台「参考图片」行 | 56 px | 送原图（任务暂存侧） |

用户看到的观感就是「**是空的**」——不是没数据，是**图没到**。
上一轮实测「点『加入参考图』要等 **10.8 秒**」也是它。

**修法**：新增 `?w=` 缩略图通道（服务端按需用 ImageMagick 缩到 256px JPEG 落盘缓存）。
单张从 2.5 MB 降到 **7.5 KB**（335 倍），图库页首屏从 57 MB 降到 **219 KB**。

---

## 1. 缩略图管线（服务端 3 个文件）

| 文件 | 改动 |
|---|---|
| `admin/server/dola/reference-image-store.js` | 抽出 `renderThumbJpeg(srcPath, destPath, size)` —— 任务暂存与图库两处共用同一套 ImageMagick 参数（`-thumbnail 256x256>` 只缩不放 / `-strip` / `quality 82` / **`jpg:` 前缀必须写**，否则 IM 按 `.tmp` 后缀猜格式报错）。先写 `.tmp` 再 `rename`，防并发读到半截文件 |
| `admin/server/dola/reference-library.js` | 新增 `ensureLibraryThumb(row)`：缩略图按 `<sha256>.jpg` 落在库根 `.thumbs/`（内容寻址 → 可长缓存）；`deleteReferenceImageFile` 里同步删缩略图 |
| `admin/server/routes/reference-images.js` | `GET /stream/:ticket/:id` 支持 `?w=`：读缩略图，**失败静默回退原图**（宁可慢，不能碎图） |

**为什么缩略图生成失败要回退原图**：没装 ImageMagick、图损坏都只会让某张图慢一点，
但绝不能让页面变成一片碎图——那比慢更难排查。

---

## 2. 飞哥两条反馈

### B1「上传后的图应该直接存到图库去」

工作台「参考图片」框里选的文件，**同时自动收进服务端参考图库**（`source='upload'`）。
新增 `stashToLibrary(files)`（`admin/web/public/test.js`），三处刻意的取舍写进了代码注释：

1. **不阻塞选图** —— 入库在后台跑，界面先照常列出来。3 MB 一张串行等上传会让「选完文件」愣好几秒。
2. **失败只提示、不撤销** —— 本地选中的图仍能正常提交（提交走 multipart，与图库无关）。
3. **从列表移除 ≠ 从图库删除** —— 删列表项是「这次不用了」，图库是资产库；提示语里写清这一条。

主工作台与批量弹窗（`#batchImages`）两条选文件路径都接了。
服务端 `storeReferenceImage` 按 sha256 **幂等**，同一张图重复选不会多出记录（返回 `duplicated`）。

> 顺带修掉一个既有小 bug：批量弹窗原本「先 `setError` 再 `clearError`」，
> 「参考图片最多 9 张，超出的未加入」这句提示**刚显示就被抹掉**，用户从来没看见过。已调换顺序。

### B2「那个图片不要挡住文字」

`web/public/test.html` 里 `.ref-thumb` 被**定义了两次**：

- line 291 `.ref-thumb{width:56px}` —— 工作台行缩略图
- line 408 `.ref-thumb{width:76px}` —— 任务详情面板缩略图

**同权重、后定义者胜** → 工作台行缩略图实际渲染 76px，
撑破 `.file-list li.ref-item{grid-template-columns:56px 1fr auto}` 的第一列，压住「图N」与体积文字。

修法：任务面板那条改名为 `.ref-panel-thumb`（同步 dark 变体与 `test.js` 里创建它的地方）。
实测重叠量从正数变成 **−9px**（有 9px 间隙），两条规则各归其位（56px / 76px）。

---

## 3. 部署要点（这个仓库的老坑，别再踩）

1. **`vite build` 的 `emptyOutDir: true` 会重写整个 `server/public/`** ——
   远端那个目录是**不断累积的墓地**（本次解包前 1109 个文件，本地只有 44 个）。
   所以部署策略是**只覆盖、绝不 `rm` 目录**。
2. **`COPYFILE_DISABLE=1` 打包**，否则 macOS 的 `._*` AppleDouble 文件会混进去。
   Linux 解包会刷屏 `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'` —— 只是噪音。
3. **逐个文件 sha256 双向校验**，不信「上传成功」：本次 `44/44` 全中（用精确路径匹配，
   别用 `grep -F -f` 按前缀匹配 —— 它会把远端遗留的 `test.html.bak-*` 一起算进来，虚增到 56）。
4. **服务端代码必须单独部署**：本轮发现远端 `ensureLibraryThumb` / `renderThumbJpeg` / `query.w`
   **全为 0 处** —— 也就是缩略图逻辑从来没上过线。若只发前端，`?w=256` 会被服务端**静默忽略**、
   照旧返回原图，看起来「改了没生效」。部署前先做**反向比对**（拉远端文件回本地 diff），
   确认改动是**纯新增**（没有远端独有的内容被覆盖）。
5. **`pm2` 不在 PATH**：实际在 `/usr/local/node22/bin/pm2`。

---

## 4. 验收（19/19）

| # | 判据 | 实测 |
|---|---|---|
| P1 | 图库页封面全部走 `?w=` | 14/14 |
| P2 | 封面全部真的渲染出来（无空框/碎图） | 14/14 |
| P3 | 缩略图尺寸是 256 级别 | 256px / 205px / 256px |
| P4 | 首屏参考图流量 < 2 MB（原 57 MB） | **219 KB**，且**原图流量 0 B** |
| B2-1 | `.ref-thumb` 只剩一条 width 规则 | 只剩 `width:56px` |
| B2-4/5 | 每行缩略图 56px、与「图N」零重叠 | 56/56/56，重叠量 −9/−9/−9 |
| B2-3 | 任务面板缩略图 76px（改名后未回归） | 76px |
| B1-1 | 选图后图库自动多出 3 张 | 14 → **17**（0.5s 内完成） |
| B1-2/3 | 新记录 name = 真实文件名、`source=upload` | ✅ / ✅ |
| P6/P7 | 选择器卡片走 `?w=`、全部渲染成功 | 17/17 |
| P8 | 「加入参考图」耗时 < 3 秒 | **0.2s**（修复前 10.8s） |

**验收不花钱**：全程只读接口 + 选文件 + 读 DOM，没有提交任何生成任务。
唯一写操作是「上传 3 张验收样张进图库」——这正是 B1 的被测行为；
验收后已通过 `DELETE /api/reference-images/{15,16,17}` 清理，图库恢复 14 张 / 57.0 MB，
`.thumbs` 里的缩略图也随删除同步清掉（14 个 = 现存 14 张，无孤儿）。

---

## 5. 遗留（未处理，等飞哥定）

1. **远端 `server/public/` 里有 14 个公网可访问的 `test.html.bak-*` / `test.js.bak-*`** ——
   历代手工备份，`https://admin.fei85.cn/test.js.bak-20260928-054033` 这类 URL 能直接下载到源码。
   建议清掉（未获确认前未动，因为远端删除不可逆）。
   注意本地 `web/public/test.html.bak-20260928-darkmode` 会被 `vite build` **再拷一份上去**，要一并在源头移出并加 `.gitignore`。
2. 本轮改动尚未 push（只做了本地 commit 的话见下）。
