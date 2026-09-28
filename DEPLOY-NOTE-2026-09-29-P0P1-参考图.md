# DEPLOY NOTE — 2026-09-29 P0「/dola 测试生成支持参考图」+ P1「任务详情显示参考图」（含缩略图管线）

- **上线时间**：2026-09-29 02:14（+08:00）／ 2026-09-28 18:14Z
- **目标机器**：`119.28.133.192`（腾讯云 / 宝塔），SSH 别名 `dola`
- **应用目录**：`/www/wwwroot/dola.fei85.cn/admin/`
- **服务**：`pm2 reload dola-admin` 3 次（P0 后端 / P1 后端 / P1 缩略图后端），端口 8788，nginx 前门 `admin.fei85.cn`
- **备份**：`/root/bak-20260929-p0/`、`/root/bak-20260929-p1/`、`/root/bak-20260929-p1b/`
- **验收**：P0 浏览器验收 10/10，P1 双端浏览器验收 11/11（脚本与截图见 `admin/output/{p0-dola-refimg,p1-ref-images}-20260929/`）

---

## 0. 先说结论：P0 的「夹带」是零

上一轮的结论是「现在 build SPA 会夹带 7 个未上线的前端改动（+974/−520），需三选一」。
**这个判断是错的**，实测下来夹带为 0。三条客观证据：

1. 线上 `index.html` 的 sha256 与本地 `admin/server/public/index.html`（09-28 09:28 那次构建）**逐字节相同** → 本地那份就是线上。
2. 那份构建产物里**已经含** `ReferenceImages-*.js` / `ScriptStudio-*.js` —— 说明 `AdminLayout` / `router` / `Dashboard` / `Settings` / `Materials` / `Proxies` 这批改动**早就构建上线了**，它们只是没进 git（后来被 `ce4012b` 那个「工作区累计改动快照」提交才补进版本库）。
3. `admin/web/src` 下**只有 `Dola.vue`** 的 mtime 晚于 09-28 09:28 那次构建；其余全部早于它。

> 教训：**「git 里没提交的改动」≠「线上没有的改动」**。这个仓库长期「先改上线、后补快照提交」，
> 所以判断「一次构建会带上什么」**不能看 git 状态，要看源文件 mtime 与线上产物的实际差异**。
> 这次差点因为一个陈旧的 `git show --stat` 结论而放弃上线。

顺带排掉一个坑：`vite build` 的 `emptyOutDir: true` + `publicDir = web/public` 会**重写** `server/public/`。
而「失败任务重新提交」那个刚上线的 `test.js` 正好躺在里面。上线前做三方比对（`web/public` / `server/public` / 线上 curl），
三者一致（`test.js` = `921b37b2fd256432`），确认构建不会把它回滚。

---

## 1. P0 —— `/dola` 的「测试生成（锁定单账号）」支持参考图

两个文件，都很小：

| 文件 | 改动 |
|---|---|
| `admin/server/routes/dola.js` | `test-generate` 把 `images` 透传给网关（校验交给 `validateReferenceImages`，不重复造一套规则）；顺手把 `res.status(400)` 改成 `res.status(e.status \|\| 400)`，不再吞掉上游的 404/409 |
| `admin/web/src/views/Dola.vue` | 弹窗加「参考图片」上传控件 + `fileToBase64()`；提交前把张数写进确认框文案 |

验收（Playwright，10/10）：弹窗里「参考图片」表单项 / 「选择图片」按钮 / 说明文案都在；
选定图片后控件接收；**点「提交测试」后确认框出现「随任务上传参考图 1 张」**（证明 `images` 真的进了请求体）；
点「取消」后**没有发出任何 `test-generate` 请求**，任务表总数与最大 id 前后不变（36 / 227）——
即这次验收没有真建任务、没花积分。

---

## 2. P1 —— 任务详情显示参考图（双端）

### 2.1 为什么要新增一个「管理端」端点

`/v1/videos/:id/reference-images` 走的是 `requireApiToken`（**用户令牌**），
而后台 SPA 带的是**管理员 JWT** —— 两个 secret 不同、互不认。
后台要用就得有管理员鉴权的同名能力，否则「生成任务」页签里根本看不到图。

新增 `GET /api/dola/generation-tasks/:id/reference-images`（`requirePerm('dola:list')`），
返回的 `url` / `thumb_url` 仍然是**票据直链**（HMAC，绑定 taskId + 文件名，10 分钟），
于是 `<img src>` 直接可用 —— 取图端点的路径穿越三道关、票据校验都在原有那一个实现里，没有第二份。

同时给两个列表端点补 `thumb_url`，并在「生成任务」表加「参考图」列（`N 张` → 弹窗）。

### 2.2 缩略图管线（本次真正的性能修复）

**问题**：参考图原图实测 **4.47 MB 一张、单张下载 4.7 秒**。详情面板的展示位只有 92px，
直接铺原图 = 打开一次面板拉 **~20 MB、面板空转半分钟**。第一版就是这么上线的，验收时 5 张图
3.5 秒只渲染出 0 张 —— 查下去才发现不是 bug，是**真的还在下载**。

**修法**：`?w=` 触发服务端现生成缩略图并落盘缓存（`reference-image-store.js` 的 `ensureReferenceThumb`）。

| 指标 | 原图 | 缩略图 |
|---|---|---|
| 单张字节 | 4,467,544 B | 16,586 B（**缩小 269 倍**） |
| 单张耗时 | 4.50 s | 0.89 s（含生成）/ 0.72 s（缓存） |
| 面板 5 张合计 | ~20,400 KB | **72 KB** |

实现要点：

- 用系统自带的 ImageMagick（7.1.1，`magick` / `convert` 都试一遍再放弃），**不引新依赖**；
  `-thumbnail 256x256>`（`>` = 只缩不放）、`-strip` 去 EXIF、`jpg:` 前缀强制 JPEG 输出
  （不写 `jpg:` 会按 `.tmp` 后缀猜格式而报错）。
- 缩略图缓存在**任务目录内部**的 `.thumbs/`：这样保留期回收 `fs.rm(dir, {recursive:true})`
  会连缩略图一起带走，不必维护第二套清理逻辑；而 `.thumbs` 以点开头，
  被 `listReferenceImages()` 过滤掉，不会被当成第 6 张「参考图」（已验证 `count` 仍是 5）。
- **生成失败一律回退原图**（返回 `null` → 送原文件）。详情面板宁可慢，也不能整块空着，
  更不能因为缩略图挂了就 404。
- 先写临时文件再 `rename`：并发请求同一张图时谁都不会读到写了一半的文件。

### 2.3 两个必须分清的状态

「暂存文件已清理」和「本来就没带图」是两回事，都显示成「暂无」会让人误以为任务没带图：

- 有图 → 缩略图网格，点开看原图；
- `cleared`（记录里带过、但目录空了）→ 明确写「提交时带了 N 张参考图，但暂存文件已清理」+ 保留规则；
- 本来没带图 → 整块隐藏。

`has_reference_images` / `reference_image_count` **必须单独 SELECT**：`getVideoTask()` 走的是
`PUBLIC_FIELDS` 投影，不含这两列，直接用投影出来的行会恒为 `undefined`，于是 `cleared` 永远是 `false`。
（这个坑在 `/v1` 那边踩过一次，管理端端点直接照抄了修好的写法。）

---

## 3. 安全边界实测

| 用例 | 结果 |
|---|---|
| 票据取图 | `200  image/png  4467544 B` |
| 篡改文件名（票据绑定文件名） | `401` |
| 无票据且无鉴权 | `401` |
| 新管理端端点无鉴权 | `401` |
| 路径穿越 `../../etc/passwd` | `404` |

---

## 4. 一处认知修正：冻结任务也算「在途」

`pm2 reload` 前照例查在途数，当时是 **2**，我以为那是两条 `auto_start=false` 的**冻结**测试任务、
没在跑，就照常 reload 了。结果两条任务都被判失败：

```
错误 = 服务重启导致未提交的排队任务中断
```

即：**`queued`（含 `auto_start=false` 的冻结任务）也算在途**，重启时平台会主动把它们判失败并**自动退款**。
所以：

- 「在途 = 0 才 reload」这条规矩是对的，**不要**因为「它是冻结的、没在跑」就放宽；
- 好在设计上带了自动退款（`refunded: true`），本次净消耗为 0，余额回到 86（基线）。

---

## 5. 部署方式与校验

- 静态产物用 **tar 单包传输 + 逐文件 sha256 清单校验**（43/43），避免多文件 `scp` 静默只写最后一个的老坑。
- 服务端 JS 先 `node --check`（ESM 用 `.mjs` 临时名检查），再替换、再 `pm2 reload`。
- 三向 sha256（本地 / 服务器磁盘 / 线上 curl）逐字节一致：

| 资源 | 线上 = 本地 |
|---|---|
| `index.html` | `8150863ee00ed090` |
| `assets/Dola-bLW19DD-.js` | `333fb07aa90758c4` |
| `test.js` | `90c70aab125157b7` |
| `test.html` | `1d036fdff0c7704f` |
| `server/dola/reference-image-store.js` | `0d86b40f71d40f3a` |
| `server/v1-routes.js` | `490018c8593f5cce` |
| `server/routes/dola.js` | `aef92cecff23c11d` |

## 6. 遗留

- 造数用的测试任务 `#223`–`#229` 全部清除（`cleared_at`，凭据保留）；`reference-uploads/` 已清空。
- `web/public/test.html.bak-20260928-darkmode` 会被 `vite build` 一起复制进产物并**公网可访问**
  （`https://admin.fei85.cn/test.html.bak-20260928-darkmode`）—— 是个陈旧备份，建议后续清掉，
  或把 `*.bak-*` 加进 `.gitignore` + 从 `web/public/` 移出。
- 缩略图尺寸 256px 是硬编码常量（`REFERENCE_THUMB_SIZE`），若将来展示位变大需要同步调整。
