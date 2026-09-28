/**
 * SQLite 初始化 / 迁移 / 种子数据。
 *
 * 双引擎：优先 better-sqlite3，装不上（原生编译失败）时自动退回 Node 内置的 node:sqlite。
 * 只用位置参数 `?`，保证两套引擎行为一致。
 *
 * 直接跑：node server/db.js --reset    （删库重建 + 灌种子）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { generateTokenValue, generateCardCode, insertMany, makeBatchNo } from './generate.js';
import { GENERATION_GUARD_SCHEMA } from './dola/generation-guards.js';
import { SUBMISSION_JOURNAL_SCHEMA } from './dola/submission-journal.js';
import { LOGIN_REGISTRY_SCHEMA } from './dola/account-login-registry.js';
import { applySqlitePragmas } from './sqlite-pragmas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, 'data');
export const DB_PATH = process.env.ADMIN_DB || path.join(DATA_DIR, 'admin.db');

/**
 * 开连接后立刻打连接级 PRAGMA（busy_timeout / WAL / synchronous）。
 *
 * 2026-09-28：生产实测 busy_timeout=0（每连接，默认 0），并发写直接抛
 * `database is locked`。WAL 已经开着（持久属性），但它不解决写-写竞争 ——
 * 补 busy_timeout 才是那个真正生效的一刀。详见 ./sqlite-pragmas.js 顶部注释。
 *
 * 这里必须**先打 PRAGMA 再 wrap**，因为 wrap 只暴露 exec/prepare，
 * 而 PRAGMA 要在任何业务语句之前生效。
 */
function openWithPragmas(db) {
  const r = applySqlitePragmas(db);
  if (r.failed.length) {
    console.warn(`[db] 部分 PRAGMA 未生效（不影响启动）：${r.failed.join(' | ')}`);
  }
  return db;
}

async function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    return wrap(openWithPragmas(new Database(DB_PATH)));
  } catch (e) {
    const { DatabaseSync } = await import('node:sqlite');
    console.warn(`[db] better-sqlite3 不可用（${e.message}），改用内置 node:sqlite（实验特性）`);
    return wrap(openWithPragmas(new DatabaseSync(DB_PATH)));
  }
}

/** 统一成 { exec, prepare(sql) -> {run,get,all} } */
function wrap(db) {
  return {
    raw: db,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        run: (...a) => st.run(...a),
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a),
      };
    },
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description TEXT DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  builtin      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  role_id       INTEGER REFERENCES roles(id),
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS contents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'default',
  status     TEXT NOT NULL DEFAULT 'draft',
  body       TEXT NOT NULL DEFAULT '',
  author_id  INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  label      TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT 'general',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  username    TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contents_cat ON contents(category);

-- 访问令牌：给外部用户/应用登录用，自带积分余额
CREATE TABLE IF NOT EXISTS tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  value      TEXT NOT NULL UNIQUE,                 -- 完整令牌，只在生成响应和 reveal 接口返回
  prefix     TEXT NOT NULL,                        -- 展示用前缀，如 dv_a1b2c3
  points     INTEGER NOT NULL DEFAULT 0,           -- 积分余额
  status     TEXT NOT NULL DEFAULT 'active',       -- active / disabled / revoked
  expires_at TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_prefix ON tokens(prefix);

-- 充值卡：卡密兑换成积分
CREATE TABLE IF NOT EXISTS cards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL UNIQUE,
  prefix             TEXT NOT NULL,
  points             INTEGER NOT NULL DEFAULT 0,   -- 面额
  status             TEXT NOT NULL DEFAULT 'unused', -- unused / redeemed / revoked
  batch_no           TEXT NOT NULL DEFAULT '',     -- 批次号，便于整批管理
  note               TEXT NOT NULL DEFAULT '',
  redeemed_by_token  INTEGER REFERENCES tokens(id),
  redeemed_at        TEXT,
  expires_at         TEXT,
  created_by         INTEGER,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_batch ON cards(batch_no);

-- dola.com 账号池：一条 = 一个已登录账号的 cookie
CREATE TABLE IF NOT EXISTS dola_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT NOT NULL DEFAULT '',          -- 备注名，导入时自动编号
  account_hint   TEXT NOT NULL DEFAULT '',          -- 账号标识（sec_user_id 等，查到后回填）
  cookie         TEXT NOT NULL,                     -- 完整 cookie
  cookie_hash    TEXT NOT NULL DEFAULT '',          -- cookie 的 sha256，用于导入去重
  cookie_names   TEXT NOT NULL DEFAULT '',          -- cookie 字段名（逗号分隔），用于完整性检查
  status         TEXT NOT NULL DEFAULT 'unknown',   -- unknown / valid / invalid / disabled
  credits        INTEGER,                           -- 最近一次查到的额度
  credits_source TEXT,                              -- 额度取自哪个接口
  credits_at     TEXT,
  converted_credits INTEGER NOT NULL DEFAULT 0,     -- 已换算过的额度（累计，防重复换算）
  counted_at     TEXT,                              -- 按账号数计价的标记：非空 = 已计过价（一个号只算一次）
  membership     TEXT NOT NULL DEFAULT '',          -- 会员等级：free / pro（来自订阅接口 subs_status）
  sec_user_id    TEXT,
  last_check_at  TEXT,
  last_used_at   TEXT,                              -- 最近一次用于生成的时间（轮转选号用，避免可着一个号薅）
  -- 限流冷却到期时间。上游对「访问频繁」会返回 710022002，
  -- 这**不是账号坏了**（会话还好好的），只是现在别再用它 —— 所以单独一个字段，
  -- 不能混进 status（混进去会被当成死号，白白浪费一个还能用的账号）。
  cooldown_until  TEXT,
  -- 该账号的独立出口代理，形如 http://user:pass@host:port 或 socks5://host:port
  -- （注意：这里是 SQL 注释，别写反引号，会截断外层的 JS 模板字符串）
  -- 为什么必须每账号一个：上游按**出口 IP** 限流（710022002 访问频繁），
  -- 一个 IP 操作多个账号必然撞墙。方悦浏览器内置 sing-box 就是这个道理。
  proxy          TEXT NOT NULL DEFAULT '',
  -- 上次验证到的出口 IP。**必须存下来**，否则没法检测"两个账号撞同一个出口 IP" ——
  -- 撞了就等于没隔离（上游看它们还是同一个来源）。
  exit_ip        TEXT,
  -- 每日视频额度跟踪。
  -- 当前已验证的免费额度来源为生成回执，不代表只读查询路径永远不存在。
  -- 只保存明确的「今日剩余 N 个视频生成额度」读数，不按消耗量推算或跨天补满。
  -- quota_total 保留历史兼容，不作为已验证上限展示。
  quota_remaining INTEGER,
  quota_total     INTEGER NOT NULL DEFAULT 4,
  quota_at        TEXT,
  quota_source    TEXT,                              -- generation_receipt；空或历史来源需重新确认
  -- 失败分调度（对照参考站 68.64.176.15 的 fail_score 机制，实现见 dola/account-score.js）。
  -- 选号时失败分低者优先；成功即清零，失败按类型加权累加（上限 50），并随时间衰减。
  fail_score     INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TEXT,
  success_count  INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  -- 上一次**真正向上游派发**的时间（不是建任务时间）。选号时用它做「最短提交间隔」节流，
  -- 让早就配置好的 dola_gen_min_submit_interval_sec 真正生效（此前只在设置页展示、生成路径没人读）。
  last_submit_at TEXT,
  -- ★ 登录态（对照参考站 §4 的 logged_in 字段，以及它把 unsigned「未登录」列成**独立状态**）。
  --   三态而不是布尔：'unknown' 表示还没探过，**不参与排除**。
  --   为什么只做否定证据：参考站的新号先入 standby、不立即探活（懒激活，"等号池不够用了再探"），
  --   所以「没探过」绝不能等于「不可用」—— 否则一次迁移就会把整个号池清空。
  --   只有只读探针**明确**确认页面是匿名态时，才写 'unavailable' 并把它挡在选号之外。
  login_state TEXT NOT NULL DEFAULT 'unknown',  -- unknown / available / unavailable
  login_at    TEXT,
  login_note  TEXT NOT NULL DEFAULT '',
  -- 原生 15/30 秒能力只记录页面只读探测结果；unknown 不得进入对应时长选号。
  native_15s_state TEXT NOT NULL DEFAULT 'unknown',  -- unknown / available / unavailable
  native_15s_at    TEXT,
  native_15s_note  TEXT NOT NULL DEFAULT '',
  native_30s_state TEXT NOT NULL DEFAULT 'unknown',  -- unknown / available / unavailable
  native_30s_at    TEXT,
  native_30s_note  TEXT NOT NULL DEFAULT '',
  -- 参考图能力只记录真实页面 DOM 探测结果；unknown 不得放开上传。
  reference_image_state TEXT NOT NULL DEFAULT 'unknown',
  reference_image_at    TEXT,
  reference_image_note  TEXT NOT NULL DEFAULT '',
  last_error     TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  group_name     TEXT NOT NULL DEFAULT '',          -- 账号分组（运营自定，如：渠道A / 测试组），用于筛选和批量管理
  source         TEXT NOT NULL DEFAULT '',          -- 账号来源（导入时录入，如：某渠道 / 某批次），用于来源筛选
  imported_by    INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dola_status ON dola_accounts(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dola_hash ON dola_accounts(cookie_hash) WHERE cookie_hash <> '';

-- 后台任务：批量校验 / 批量查额度这类耗时活儿，跑成任务好看进度
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                        -- dola_check / dola_credits
  status      TEXT NOT NULL DEFAULT 'queued',       -- queued / running / done / failed / cancelled
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  ok_count    INTEGER NOT NULL DEFAULT 0,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 5,
  payload     TEXT NOT NULL DEFAULT '{}',
  result      TEXT NOT NULL DEFAULT '{}',           -- 明细（失败项截断保留前 200 条）
  error       TEXT NOT NULL DEFAULT '',
  created_by  INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id DESC);

-- 额度 → 积分 的换算流水
CREATE TABLE IF NOT EXISTS credit_conversions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER,
  account_label TEXT NOT NULL DEFAULT '',
  credits_used  INTEGER NOT NULL,                   -- 消耗的 dola 额度
  points_gained INTEGER NOT NULL,                   -- 得到的后台积分
  ratio_desc    TEXT NOT NULL DEFAULT '',           -- 换算比例快照，如「10 额度 = 1 积分」
  token_id      INTEGER,                            -- 充到哪个令牌（可空 = 只记账）
  job_id        INTEGER,
  created_by    INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_created ON credit_conversions(created_at DESC);

-- 积分流水：用户端网关扣费/退款的账本。kind+ref 唯一 → 天然幂等。
CREATE TABLE IF NOT EXISTS point_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id     INTEGER REFERENCES tokens(id),
  token_prefix TEXT NOT NULL DEFAULT '',
  delta        INTEGER NOT NULL,                 -- 正数=扣了多少积分
  kind         TEXT NOT NULL,                    -- consume / refund
  reason       TEXT NOT NULL DEFAULT '',
  ref          TEXT NOT NULL DEFAULT '',         -- 幂等键（一般用 task_id）
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ptx_ref ON point_transactions(kind, ref) WHERE ref <> '';
CREATE INDEX IF NOT EXISTS idx_ptx_token ON point_transactions(token_id, id DESC);

-- dola 视频生成任务：一条记录 = 一次真实生成。
--
-- 为什么不复用 jobs 表：jobs 是「按 id 列表跑批量」的语义（每个 item 独立、结果等权），
-- 而生成任务是**单条长流程**（选账号 → 浏览器提交 → 等成片 → 解析无水印），
-- 状态机、耗时、产出字段都不一样，混在一张表里两边都别扭。
--
-- 关键设计：**同时保存带水印和无水印两个直链**。
-- 无水印是额外的网络解析（且可能失败），失败时不能让整条任务挂掉 ——
-- 有带水印版兜底，用户至少能拿到成片。前端优先用 unwatermarked_url。
CREATE TABLE IF NOT EXISTS dola_videos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER,
  account_label     TEXT NOT NULL DEFAULT '',
  conversation_id   TEXT,
  prompt            TEXT NOT NULL DEFAULT '',
  ratio             TEXT NOT NULL DEFAULT '16:9',
  mode              TEXT NOT NULL DEFAULT 'standard', -- standard / expert；记录真实提交时的页面模式
  seconds           INTEGER NOT NULL DEFAULT 10,
  force_seconds     INTEGER,                       -- 注入 patch 强改的时长（null = 不改）
  status            TEXT NOT NULL DEFAULT 'queued',-- queued/submitting/generating/ready/failed/cancelled
  stage             TEXT NOT NULL DEFAULT '',      -- 人可读的阶段描述，前端直接显示
  watermarked_url   TEXT,
  unwatermarked_url TEXT,
  unwatermark_note  TEXT NOT NULL DEFAULT '',      -- 无水印解析结果说明（成功/失败原因）
  -- 「本条成品是不是无水印的」——**必须单独一个字段**，不能靠 unwatermarked_url 有没有来推断：
  -- 归档到本地之后直链会被清掉/过期，但文件本身确实是无水印的，靠 URL 判断会误报成带水印。
  is_unwatermarked  INTEGER NOT NULL DEFAULT 0,
  -- 本地归档：TOS 直链是**带签名的临时链接**（有 dy_q 过期时间），
  -- 放几天就 403 了。所以解析成功后必须把文件抓回本地，否则用户隔天来下载就是死的。
  local_path        TEXT,                          -- 归档文件绝对路径
  local_bytes       INTEGER,                       -- 归档文件大小
  duration_sec      REAL,
  bytes             INTEGER,
  error             TEXT NOT NULL DEFAULT '',
  owner_token_id    INTEGER,                       -- 归属令牌（用户端网关模式用）
  owner_prefix      TEXT NOT NULL DEFAULT '',
  charge_ref        TEXT NOT NULL DEFAULT '',      -- 计费幂等键，和 point_transactions.ref 对应
  -- 参考图只存开关与数量；文件在 data/reference-uploads/<id>/，不进 SQLite。
  has_reference_images INTEGER NOT NULL DEFAULT 0,
  reference_image_count INTEGER NOT NULL DEFAULT 0,
  strict_account  INTEGER NOT NULL DEFAULT 0,  -- 锁定账号验收：限流/冷却时不自动换号
  created_by        INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_dv_owner ON dola_videos(owner_token_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dv_status ON dola_videos(status, id);
CREATE INDEX IF NOT EXISTS idx_dv_created ON dola_videos(created_at DESC);

-- 素材库：后台统一维护的提示词素材（可带参考图），供运营批量创建时复用。
-- images 存 JSON 数组 [{ mime, dataBase64 }]，与前台素材结构对齐。
CREATE TABLE IF NOT EXISTS dola_materials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  prompt     TEXT NOT NULL DEFAULT '',
  images     TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_updated ON dola_materials(updated_at DESC);

-- 脚本工作台：一份脚本及其可编辑的分镜。图片文件不进库，视频任务复用 dola_videos。
CREATE TABLE IF NOT EXISTS dola_scripts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  topic      TEXT NOT NULL DEFAULT '',
  tone       TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft',
  error      TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ds_updated ON dola_scripts(updated_at DESC);

CREATE TABLE IF NOT EXISTS dola_script_shots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id     INTEGER NOT NULL REFERENCES dola_scripts(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  scene         TEXT NOT NULL DEFAULT '',
  narration     TEXT NOT NULL DEFAULT '',
  seconds       INTEGER NOT NULL DEFAULT 30,
  ratio         TEXT NOT NULL DEFAULT '16:9',
  image_prompt  TEXT NOT NULL DEFAULT '',
  image_path    TEXT NOT NULL DEFAULT '',
  image_candidates TEXT NOT NULL DEFAULT '[]',
  -- 这一条分镜要喂给视频模型的**参考图**，JSON 数组。
  -- ★ 只存「指向」，不存图片字节：字节在 dola_reference_images / 上游 CDN 上。
  -- 提交视频任务时才解析成真实字节（见 routes/scripts.js 的 resolveShotReferenceImages）。
  -- 元素形状：{ kind:'shot' }（用本分镜当前分镜图）
  --          { kind:'library', id, name }（参考图库里的某张）
  --          { kind:'url', url }（任意 http(s) 直链，通常是别处的分镜图/出图历史）
  -- 为什么不落字节：参考图会跟着分镜图/图库条目变（用户换了分镜图，参考图理应跟着换），
  -- 而且同一张图被 10 个分镜引用时不该存 10 份。
  reference_images TEXT NOT NULL DEFAULT '[]',
  video_task_id INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(script_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_dss_script ON dola_script_shots(script_id, seq);

-- 分镜图**生成历史**：★ 一行 = 一次生成 = 一组图，**绝不拆成一图一行**。
--
-- 为什么必须按「批」存：dola 网页 agent 一次文生图**固定吐 4 张**（实测
-- 2732×1534 无水印原图，model=Agent-Creation）。这 4 张是同一批的候选，
-- 拆开单存就丢了「它们出自同一次生成」这个信息，也没法按批回看/回切，
-- 前端会退化成一条平铺的图片流水 —— 那正是要避免的「格式错」。
--
-- images 存 JSON 数组（一次生成的整组），image_count 冗余存张数，
-- 便于校验是否被写坏（正常恒为 4）。used_url 记录这一批里当时被选中的那张。
--
-- 注意：本库**没有开 PRAGMA foreign_keys**（SQLite 默认 OFF），
-- 所以下面的 REFERENCES 只是文档，级联删除必须由代码显式做
-- （见 routes/scripts.js 删除分镜/脚本处）。
-- 另外：这里是 SQL 模板字符串内部，注释里**不要用反引号**，会把模板截断。
CREATE TABLE IF NOT EXISTS dola_script_shot_images (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id         INTEGER NOT NULL REFERENCES dola_script_shots(id) ON DELETE CASCADE,
  script_id       INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  prompt          TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  account_id      INTEGER,
  account_label   TEXT NOT NULL DEFAULT '',
  images          TEXT NOT NULL DEFAULT '[]',
  image_count     INTEGER NOT NULL DEFAULT 0,
  used_url        TEXT NOT NULL DEFAULT '',
  -- 这一批的图被**自动收进参考图库**后得到的条目 id（JSON 数组）。
  -- 存下来是为了：① 前端能直接说「已收进图库 N 张」并跳过去看；
  -- ② 出图历史里能判断这一批是不是已经收录过，避免重复抓同一批。
  -- 收录是 best-effort（见 routes/scripts.js 的 ingestBatchToLibrary），
  -- 所以这里可能是空数组 —— 空不等于"没出图"，只等于"没收成"。
  library_ids     TEXT NOT NULL DEFAULT '[]',
  ms              INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dssi_shot ON dola_script_shot_images(shot_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_dssi_script ON dola_script_shot_images(script_id, id DESC);

-- 参考图库：一个**统一的参考图来源**，同时喂给「视频任务主工作台」和「脚本分镜页」。
--
-- 为什么要有它（而不是继续只在前端 localStorage 里存 base64）：
--   · 前端素材（test.js 的 state.materials）只活在这台浏览器里，换机器就没了，
--     也没法在分镜页引用；
--   · 分镜图出在**上游 CDN 的临时直链**上，可能过期，直接当参考图引用会隔天失效；
--     收进图库 = 立刻落盘成我们自己的文件，生命周期由我们控制。
--
-- 存储分层：**元数据在 SQLite，字节在 data/reference-library/<id>.<ext>**。
-- 绝不把 base64 塞进 SQLite（单张可到 8MB，库会被撑爆，备份也变慢）。
--
-- sha256 唯一索引 = 去重键：同一张图重复上传/重复从分镜图收进来，只留一条记录，
-- 返回已有那条。用**部分索引**（WHERE sha256 <> ''）而不是普通唯一索引：
-- 空字符串在 SQLite 唯一索引里也只允许一条，留空的行会互相打架。
--
-- 注意：本库**没有开 PRAGMA foreign_keys**，script_shot_id 只是文档性外键，
-- 不产生级联；分镜被删时图库条目**故意保留**（图还在，只是没了出处）。
-- 另外：这里是 SQL 模板字符串内部，注释里**不要用反引号**，会把模板截断。
CREATE TABLE IF NOT EXISTS dola_reference_images (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL DEFAULT '',
  -- upload = 后台上传；url = 粘贴直链；shot = 从分镜图收进来；material = 从素材库转存
  source         TEXT NOT NULL DEFAULT 'upload',
  origin_url     TEXT NOT NULL DEFAULT '',
  local_path     TEXT NOT NULL DEFAULT '',
  mime           TEXT NOT NULL DEFAULT '',
  bytes          INTEGER NOT NULL DEFAULT 0,
  width          INTEGER NOT NULL DEFAULT 0,
  height         INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '',
  script_shot_id INTEGER,
  use_count      INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dri_sha ON dola_reference_images(sha256) WHERE sha256 <> '';
CREATE INDEX IF NOT EXISTS idx_dri_updated ON dola_reference_images(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dri_source ON dola_reference_images(source, id DESC);

-- 上游限流事件：用于后台运营审计与冷却面板。
-- 只记录码、账号/任务引用和人类可读说明，不保存 cookie 或完整代理凭据。
CREATE TABLE IF NOT EXISTS dola_rate_limit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL DEFAULT '710022002',
  account_id     INTEGER,
  video_id       INTEGER,
  exit_ip        TEXT,
  cooldown_until TEXT,
  detail         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dola_rl_created ON dola_rate_limit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dola_rl_account ON dola_rate_limit_events(account_id, id DESC);
`;

export let db = null;

export async function initDb() {
  if (db) return db;
  db = await openDatabase();
  db.exec(SCHEMA);
  migrate();
  db.exec(GENERATION_GUARD_SCHEMA);
  db.exec(SUBMISSION_JOURNAL_SCHEMA);
  db.exec(LOGIN_REGISTRY_SCHEMA);
  seed();
  return db;
}

/**
 * 轻量迁移：`CREATE TABLE IF NOT EXISTS` 只会建新表，**不会给已存在的表加列**。
 * 所以要显式对比 PRAGMA table_info 再 ALTER TABLE 补列。
 * 加新列时，往下面 ALTERS 里追一行即可。
 */
function migrate() {
  const ALTERS = [
    ['dola_accounts', 'converted_credits', "INTEGER NOT NULL DEFAULT 0"],
    ['dola_accounts', 'counted_at', 'TEXT'],
    ['dola_accounts', 'membership', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'last_used_at', 'TEXT'],
    ['dola_accounts', 'cooldown_until', 'TEXT'],
    ['dola_accounts', 'proxy', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'exit_ip', 'TEXT'],
    ['dola_accounts', 'quota_remaining', 'INTEGER'],
    ['dola_accounts', 'quota_total', 'INTEGER NOT NULL DEFAULT 4'],
    ['dola_accounts', 'quota_at', 'TEXT'],
    ['dola_accounts', 'quota_source', 'TEXT'],
    ['dola_accounts', 'login_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'login_at', 'TEXT'],
    ['dola_accounts', 'login_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'native_15s_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'native_15s_at', 'TEXT'],
    ['dola_accounts', 'native_15s_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'native_30s_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'native_30s_at', 'TEXT'],
    ['dola_accounts', 'native_30s_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'reference_image_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'reference_image_at', 'TEXT'],
    ['dola_accounts', 'reference_image_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'group_name', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'source', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'fail_score', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_accounts', 'consecutive_failures', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_accounts', 'last_failure_at', 'TEXT'],
    ['dola_accounts', 'success_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_accounts', 'fail_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_accounts', 'last_submit_at', 'TEXT'],
    ['dola_videos', 'local_path', 'TEXT'],
    ['dola_videos', 'mode', "TEXT NOT NULL DEFAULT 'standard'"],
    ['dola_videos', 'local_bytes', 'INTEGER'],
    ['dola_videos', 'is_unwatermarked', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_videos', 'has_reference_images', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_videos', 'reference_image_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_videos', 'strict_account', 'INTEGER NOT NULL DEFAULT 0'],
    // 软清除（对应 /v1 的 DELETE /v1/videos）：任务行是扣费/退款/审计凭据，不能物理删除，
    // 但调用方要的「从列表消失」必须真的做到 —— 否则「清除」点了、刷新又回来。
    ['dola_videos', 'cleared_at', 'TEXT'],
    // 每令牌每日额度（见 dola/gateway-quota.js）：NULL = 用全局设置，0 = 不限，正数 = 上限。
    // 做成**可空**而不是 `NOT NULL DEFAULT 0`：0 的语义是"不限"，若默认 0 就等于
    // 所有存量令牌都变成"无限额"，把全局日上限彻底废掉 —— 那是静默失效。
    ['tokens', 'daily_points_limit', 'INTEGER'],
    // 代理出口轮换 epoch（见 dola/proxy-epoch.js）。
    // `dola_proxies` 由 proxy-pool.js 懒建表，所以这两列在那边也补了一遍
    // （新建库走 PROXY_POOL_SCHEMA，已有库走这里的 ALTER）。
    ['dola_proxies', 'exit_ip_at', 'TEXT'],
    ['dola_proxies', 'rotation_count', 'INTEGER NOT NULL DEFAULT 0'],
    // 分镜图的候选集（见 server/dola/chat-bridge.js）：一次文生图上游会吐 4 张，
    // `image_path` 只存用户最终选中的那张，候选全量留在这里让前端换图。
    // 存 JSON 数组而不是另开一张表：候选与分镜是 1:N 但**生命周期完全一致**
    // （分镜删了候选就该没），没有独立查询需求。
    ['dola_script_shots', 'image_candidates', "TEXT NOT NULL DEFAULT '[]'"],
    // 分镜要喂给视频模型的参考图（见 SCHEMA 里 dola_script_shots 的注释）。
    // 只存「指向」，提交时才解析成字节 —— 所以用户换了分镜图，参考图会跟着换。
    ['dola_script_shots', 'reference_images', "TEXT NOT NULL DEFAULT '[]'"],
    // 一批分镜图收进参考图库后得到的条目 id（见 SCHEMA 里 dola_script_shot_images 的注释）。
    ['dola_script_shot_images', 'library_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [table, column, def] of ALTERS) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.length) continue;            // 表还不存在，SCHEMA 已经建成最新结构
      if (cols.includes(column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      console.log(`[db] 迁移：${table} 新增列 ${column}`);
    } catch (e) {
      console.error(`[db] 迁移失败 ${table}.${column}:`, e.message);
    }
  }

  backfillScriptImageHistory();
}

/**
 * 一次性回填分镜出图历史。
 *
 * 在引入 dola_script_shot_images 之前出的图，其 image_candidates **本身就是一次
 * 生成的整组**（4 张），只是当时没记录。不回填的话会出现很怪的场面：分镜明明
 * 有 4 张候选图，历史里却是空的 —— 用户只会以为历史功能坏了。
 *
 * 元数据（model / 耗时 / 会话号 / 账号）当时没记，只能留空 —— **不编造**。
 * 幂等：只处理「有候选但一条历史都没有」的分镜，跑多少次结果一样。
 */
function backfillScriptImageHistory() {
  try {
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='dola_script_shot_images'",
    ).get();
    if (!hasTable) return;
    const cols = db.prepare('PRAGMA table_info(dola_script_shots)').all().map((c) => c.name);
    if (!cols.includes('image_candidates')) return;
    const orphans = db.prepare(`SELECT s.* FROM dola_script_shots s
      WHERE TRIM(COALESCE(s.image_candidates,'')) <> ''
        AND TRIM(COALESCE(s.image_candidates,'')) <> '[]'
        AND NOT EXISTS (SELECT 1 FROM dola_script_shot_images i WHERE i.shot_id = s.id)`).all();
    if (!orphans.length) return;
    const insert = db.prepare(`INSERT INTO dola_script_shot_images
      (shot_id,script_id,seq,prompt,model,conversation_id,account_id,account_label,images,image_count,used_url,ms,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let done = 0;
    for (const shot of orphans) {
      let images = [];
      try { images = JSON.parse(shot.image_candidates) || []; } catch { images = []; }
      if (!Array.isArray(images) || !images.length) continue;
      insert.run(
        shot.id, shot.script_id, shot.seq,
        String(shot.image_prompt || shot.scene || '').slice(0, 12000),
        '', null, null, '',
        JSON.stringify(images), images.length,
        String(shot.image_path || '').slice(0, 2048), 0,
        shot.updated_at || new Date().toISOString(),
      );
      done += 1;
    }
    if (done) console.log(`[db] 回填 ${done} 条分镜出图历史（历史表引入之前出的图，元数据留空）`);
  } catch (e) {
    console.error('[db] 出图历史回填失败:', e.message);
  }
}

const now = () => new Date().toISOString();

function seed() {
  // roles
  const roleCount = db.prepare('SELECT COUNT(*) AS c FROM roles').get().c;
  if (roleCount === 0) {
    // 运营角色：能管内容、能发卡密，但碰不了用户和系统设置
    const editorPerms = ['dashboard:view', 'content:list', 'content:create', 'content:update', 'log:list',
                         'token:list', 'card:list', 'card:generate'];
    const viewerPerms = ['dashboard:view', 'content:list'];
    db.prepare('INSERT INTO roles (code,name,description,permissions,builtin,created_at) VALUES (?,?,?,?,?,?)')
      .run('admin', '超级管理员', '拥有全部权限，不可删除', JSON.stringify('*'), 1, now());
    db.prepare('INSERT INTO roles (code,name,description,permissions,builtin,created_at) VALUES (?,?,?,?,?,?)')
      .run('editor', '编辑', '可管理内容，不能动用户和设置', JSON.stringify(editorPerms), 0, now());
    db.prepare('INSERT INTO roles (code,name,description,permissions,builtin,created_at) VALUES (?,?,?,?,?,?)')
      .run('viewer', '只读', '只能看，不能改', JSON.stringify(viewerPerms), 0, now());
  }

  // 默认管理员
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const adminRole = db.prepare("SELECT id FROM roles WHERE code='admin'").get();
    const pwd = process.env.ADMIN_INIT_PASSWORD || 'admin123';
    db.prepare(`INSERT INTO users (username,password_hash,nickname,email,role_id,status,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('admin', hashPassword(pwd), '超级管理员', 'admin@example.com', adminRole.id, 'active', now(), now());
    console.log(`[db] 已创建默认管理员：admin / ${pwd}（首次登录后请改密码）`);
  }

  // 系统设置默认值
  const defs = [
    ['site_name', '管理后台', '站点名称', 'general'],
    ['page_size', '20', '列表每页条数', 'general'],
    ['footer_text', '© 2026 Admin Console', '页脚文案', 'general'],
    ['allow_register', 'false', '开放注册', 'security'],
    ['session_hours', '12', '登录有效期（小时）', 'security'],
    // dola 账号池
    ['dola_credits_per_point', '10', 'dola 额度兑换比例（多少额度 = 1 积分）', 'dola'],
    ['dola_points_per_account', '50', '按账号数计价：每个有效账号值多少积分', 'dola'],
    ['dola_convert_basis', 'account', '默认计价方式：account=按账号数 / credits=按额度', 'dola'],
    ['dola_check_concurrency', '5', 'dola 批量校验并发数', 'dola'],
    ['dola_http_timeout', '20', 'dola 接口超时（秒）', 'dola'],
    ['dola_use_browser', 'false', '查额度时使用浏览器通道（需装 playwright）', 'dola'],
    ['dola_browser_concurrency', '3', '浏览器通道并发数（吃内存，别调大）', 'dola'],
    ['dola_gen_concurrency', '1', '视频生成并发数（不同账号可并行，同账号自动排队）', 'dola'],
    ['dola_gen_min_submit_interval_sec', '60', '同一出口 IP 两次浏览器提交的最小间隔（秒），缓解 710022002', 'dola'],
    ['dola_gen_queue_limit', '6000', '视频生成队列容量（排队+运行任务，不是浏览器同时并发数）', 'dola'],
    ['dola_ratelimit_cooldown_min', '30', '上游限流后的账号冷却时间（分钟）', 'dola'],
    ['dola_autorotate_max_attempts', '3', '上游限流后自动换号重试的最大账号数（含首次，1=不换号）', 'dola'],
    ['dola_replenish_min_accounts', '5', '号池补号提示：有效账号低于此数时提示补号', 'dola'],
    ['dola_replenish_min_quota', '30', '号池补号提示：已确认剩余额度低于此数时提示补号（0=关闭额度判据）', 'dola'],
    ['dola_quota_reset_tz', 'Asia/Tokyo', 'dola 每日额度重置时区（IANA，如 Asia/Tokyo；上游按此时区 0 点重置）', 'dola'],
    ['dola_quota_reset_hour', '0', 'dola 每日额度重置时刻（0～23，重置时区当地时间）', 'dola'],
    ['dola_submit_mode', 'browser', '视频提交通道：browser=浏览器模拟提交（默认）/ scheme-a=Abort取签名+页内重放提交（实验）/ pure-http=纯协议、Node 自算 a_bogus 后直发（不开浏览器）', 'dola'],
    // 「你好」探测通道（`server/dola/hello-probe.js`）。
    // ⚠️ 默认就是 pure-http —— 与视频通道（dola_submit_mode 默认 browser）**刻意不同**：
    //    探测是高频轻量动作，开浏览器要等创作输入框（慢代理 20~30 秒）还占账号浏览器锁。
    //    纯协议用的是与 chat-bridge 完全相同的已验证链路，所以默认即切换、不需要灰度。
    //    回退路径：改成 browser（旧实现仍保留在 hello-probe.js 里）。
    ['dola_hello_probe_mode', 'pure-http', '「你好」探测通道：pure-http=纯协议直发（默认，不开浏览器）/ browser=开浏览器走 UI（慢，仅回退用）', 'dola'],
    ['dola_upstream_concat', 'false', '允许把页面上游合成档位（30s = 15s ×2）算作 30 秒可用证据：拆段与首尾相接均在上游完成，本服务不做本地拼接', 'dola'],
    // ★ 30 秒改写通道（2026-09-26）。历史口径要求「页面必须先有原生 15 秒档位」才认 30 秒，
    //    但实测服务端 `video-duration` 控件只下发 5s/10s —— 15s 在配置层面不存在，
    //    于是探针永远确认不了、`native_30s_state` 恒为 unknown、三处硬门禁全部拒绝。
    //    ⚠️ 默认必须是 'false'：**上线本身不改线上行为**；要开放 30 秒必须显式打开。
    ['dola_allow_30s_rewrite', 'false', '允许 30 秒走「短档位载体 + 请求改写」通道（默认关；打开后不再要求页面有原生 15 秒档位）', 'dola'],
    // 载体映射（JSON，如 {"20":10,"30":10}）。留空 = 按上面开关取内置默认：
    // 关=30→15（历史口径），开=30→10（页面真实存在的档）。
    ['dola_duration_carrier_map', '', '时长载体映射（JSON，如 {"20":10,"30":10}；留空=按开关用内置默认）', 'dola'],
    ['dola_convert_auto_zero', 'false', '转换后把账号额度清零（仅记账，不代表真的扣了 dola）', 'dola'],
    ['dola_auto_maintenance_enabled', 'true', '自动巡检账号和可查额度', 'dola'],
    ['dola_auto_cleanup_invalid', 'true', '自动隔离明确失效账号（保留 cookie，不硬删除）', 'dola'],
    ['dola_auto_quota_probe', 'true', '自动探测接口可返回的额度（免费日额度仍以生成回执为准）', 'dola'],
    ['dola_auto_maintenance_interval_minutes', '180', '自动巡检间隔（15～1440 分钟）', 'dola'],
    // 单次生成最多体检几个账号（见 generator.js 的 pickLiveAccount）。
    // 之前这个值被**写死在代码里**（3），而换号重试路径传的是 5，两条路不一致；
    // 后果是失败信息谎称「账号池里没有可用账号」，其实池里还有没体检过的候选。
    ['dola_account_probe_limit', '3', '单次生成最多体检几个账号（池里候选更多时会在失败信息里提示还有多少未体检）', 'dola'],
    // 代理出口轮换（见 server/dola/proxy-epoch.js）。
    // ⚠️ 我们算出来的到期时刻只是**上界**（IPWeb 的窗口锚在它自己的时钟上），
    //    这两个设置只影响「什么时候提示有风险」，不改变那个诚实边界。
    ['dola_proxy_rotation_risk_sec', '120', '代理出口剩余时间低于此值即标记「即将轮换」（秒，0=不判定）', 'dola'],
    ['dola_proxy_assumed_minutes', '0', 'URL 里读不出粘性窗口时的兜底窗口（分钟，0=不知道就不算）', 'dola'],
    // 用户端网关（给 8787 工作台调）
    ['gateway_enabled', 'true', '允许用户端调用网关接口（校验令牌/扣积分）', 'gateway'],
    ['gateway_points_per_task', '1', '每个视频任务扣多少积分', 'gateway'],
    ['gateway_prompt_cooldown_seconds', '120', '同一令牌相同提示词冷却时间（秒）', 'gateway'],
    ['gateway_key', '7d4aaa02d7ce44a0e99ebebd7e8f34abe7e28c5ae49b1424', '网关共享密钥（用户端要用它调后台）', 'gateway'],
    // 脚本工作台的 OpenAI-compatible LLM 配置。api_key 由 settings 路由统一脱敏。
    // `llm_provider` 决定走哪条通道：
    //   openai → 外部 OpenAI 兼容接口（需要 base_url + api_key + model）
    //   dola   → **不配置任何 LLM**，借本服务号池里的 dola 网页 agent 出分镜与分镜图
    //            （见 server/dola/chat-bridge.js）。启用它时上面三项都不需要填。
    ['llm_provider', 'openai', '脚本工作台：生成通道（openai=外部 LLM / dola=借用号池网页 agent）', 'script'],
    ['llm_enabled', 'false', '脚本工作台：启用生成', 'script'],
    ['llm_base_url', '', '脚本工作台：LLM 接口地址（OpenAI-compatible）', 'script'],
    ['llm_api_key', '', '脚本工作台：LLM API Key', 'script'],
    ['llm_model', '', '脚本工作台：模型名', 'script'],
    ['llm_timeout_ms', '120000', '脚本工作台：LLM 超时（毫秒）', 'script'],
    // 提示词包装（发给上游前拼接，见 server/dola/prompt-wrap.js）。
    // ⚠️ 同样必须先注册（`setSetting()` 只 UPDATE 已有 key）；否则后台改了"没反应"。
    // 默认**关**：包装会改变上游看到的内容，属于运营决策，不该在升级后自动生效。
    ['gateway_prompt_wrap_enabled', 'false', '启用提示词包装（前缀/中缀/后缀，仅作用于发给上游的那一刻）', 'gateway'],
    ['gateway_prompt_prefix', '', '提示词前缀（拼在用户提示词之前）', 'gateway'],
    ['gateway_prompt_middle', '', '提示词中缀（拼在用户提示词之后、后缀之前）', 'gateway'],
    ['gateway_prompt_suffix', '', '提示词后缀（拼在最后）', 'gateway'],
    // 按模型计费（见 server/dola/gateway-quota.js）。
    // 值是一份 JSON：{"default":1,"seedance_v2.0":2,"seedance_v2.5":1,"seedance_v2.5|30":3}
    // 留空 = 全部回落到 gateway_points_per_task（升级后行为不变）。
    // ⚠️ 必须注册：`setSetting()` 只 UPDATE 已有 key，不注册就永远写不进去。
    ['gateway_model_costs', '', '按模型计费价目表（JSON，如 {"default":1,"seedance_v2.5":1,"seedance_v2.5|30":3}；留空=用上面的一口价）', 'gateway'],
    ['gateway_daily_points_limit', '0', '每个令牌每日积分上限（0=不限；在令牌上单独设置可覆盖此项）', 'gateway'],
    // 三层开关的「范围」层（见 server/dola/feature-switch.js）。
    // ⚠️ 默认必须是 all：升级之后不能改变任何既有行为。
    ['gateway_enabled_scope', 'all', '网关开关生效范围：all=全部入口 / v1=只对外接口 / admin=只后台工作台', 'gateway'],
    ['gateway_prompt_wrap_enabled_scope', 'all', '提示词包装生效范围：all / v1 / admin', 'gateway'],
    // 参考图上传前自动遮盖真人脸（见 server/dola/portrait-guard.js）。
    // ⚠️ 默认 **true**：代价不对称 ——
    //    漏处理（真人脸没盖）→ 上游肖像保护软拒绝 → 任务白等满 40 分钟 + 锁号（实例 #188）；
    //    误处理（把卡通也盖了）→ 只是参考图上多一块「此角色由AI生成」面板，任务照样出片。
    // 实测（27 样本回归）：真人脸 100% 被盖且盖后检测不出；13 张 AI 分镜图 + 平涂卡通 + 素描 一律不动。
    // 想临时关掉不用等设置生效：环境变量 DOLA_PORTRAIT_GUARD=false（它优先于本项）。
    ['gateway_portrait_guard_enabled', 'true', '参考图上传前自动遮盖真人脸（true/false；素描与卡通不处理，盖完会复检确保检测不出）', 'gateway'],
    // 可观测性（Prometheus 抓取）。
    // ⚠️ 必须先在这里注册：`setSetting()` **只 UPDATE 已有的 key**，不创建任意 key
    //    （见 db.js 的 setSetting 注释）—— 不注册的话这个设置永远写不进去、也就永远抓不到指标，
    //    而且症状是"设置接口返回成功、值却是 null"，很难查。
    ['metrics_key', '', 'Prometheus 抓取密钥（x-metrics-key）；留空则只有管理员会话能看 /metrics', 'security'],
    // 前台入口
    ['frontend_name', '视频工作台', '前台入口名称', 'frontend'],
    ['frontend_url', 'https://admin.fei85.cn/test.html', '前台地址（含 http:// 或 https://）', 'frontend'],
    ['frontend_open_mode', 'tab', '打开方式：tab=新标签页 / browser=服务器上开真实浏览器', 'frontend'],
    ['frontend_browser_visible', 'true', '真实浏览器是否显示窗口（关闭=后台静默打开）', 'frontend'],
  ];
  for (const [k, v, label, g] of defs) {
    const exist = db.prepare('SELECT key FROM settings WHERE key=?').get(k);
    if (!exist) db.prepare('INSERT INTO settings (key,value,label,group_name,updated_at) VALUES (?,?,?,?,?)').run(k, v, label, g, now());
  }
  // 2026-09-25：旧 api.fei85.cn 工作台已并入 admin.fei85.cn/test.html。
  // 只迁移精确匹配的旧根地址，保留其他自定义地址；服务每次启动执行，幂等。
  db.prepare(`UPDATE settings SET value=?, updated_at=?
    WHERE key='frontend_url' AND lower(trim(value)) IN (
      'https://api.fei85.cn', 'https://api.fei85.cn/',
      'http://api.fei85.cn', 'http://api.fei85.cn/'
    )`).run('https://admin.fei85.cn/test.html', now());
  // 只补空值，不覆盖用户已填的自定义地址。
  db.prepare(`UPDATE settings SET value=?, updated_at=?
    WHERE key='frontend_url' AND (value IS NULL OR value='')`)
    .run('https://admin.fei85.cn/test.html', now());

  // 示例内容（让用户一进来就有东西看）
  const cCount = db.prepare('SELECT COUNT(*) AS c FROM contents').get().c;
  if (cCount === 0) {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const samples = [
      ['欢迎使用管理后台', 'default', 'published', '这是一条示例内容。\n\n把它换成你自己的业务模型即可 —— 表结构在 server/db.js，接口在 server/routes/content.js。'],
      ['如何接入真实业务', 'docs', 'published', '1. 在 db.js 里加表\n2. 复制 routes/content.js 改字段名\n3. 前端复制 views/Content.vue 改列'],
      ['草稿示例', 'default', 'draft', '这条是草稿状态，用来演示状态筛选。'],
    ];
    for (const [t, c, s, b] of samples) {
      db.prepare('INSERT INTO contents (title,category,status,body,author_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(t, c, s, b, admin?.id ?? null, now(), now());
    }
  }

  // 示例令牌 + 示例卡密（同样只在空表时灌，避免覆盖你的数据）
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  if (db.prepare('SELECT COUNT(*) AS c FROM tokens').get().c === 0) {
    const rows = [
      { name: '演示令牌 · 生产', points: 1000, note: '示例数据，可直接删除', created_by: admin?.id ?? null, now: now() },
      { name: '演示令牌 · 测试', points: 100, note: '示例数据，可直接删除', created_by: admin?.id ?? null, now: now() },
    ];
    insertMany(db, 'tokens', generateTokenValue, rows);
    console.log('[db] 已生成 2 个示例令牌（完整值只在生成时可见，这里没打印；要去后台点「查看」或重置数据库重拿）');
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM cards').get().c === 0) {
    const batch_no = makeBatchNo();
    const rows = Array.from({ length: 5 }, () => ({
      points: 100, batch_no, note: '示例数据，可直接删除', created_by: admin?.id ?? null, now: now(),
    }));
    insertMany(db, 'cards', generateCardCode, rows);
    console.log(`[db] 已生成 5 张示例卡密（批次 ${batch_no}，每张 100 积分）`);
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}

/** Update one existing setting without creating arbitrary keys. */
export function setSetting(key, value) {
  const t = now();
  return db.prepare('UPDATE settings SET value=?, updated_at=? WHERE key=?').run(String(value), t, key);
}

// 直接执行时建库
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--reset') && fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
    console.log('[db] 已删除旧库', DB_PATH);
  }
  await initDb();
  console.log('[db] 就绪：', DB_PATH);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('[db] 表：', tables.map((t) => t.name).join(', '));
}
