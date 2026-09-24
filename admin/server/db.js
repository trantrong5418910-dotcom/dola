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

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, 'data');
export const DB_PATH = process.env.ADMIN_DB || path.join(DATA_DIR, 'admin.db');

async function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    return wrap(new Database(DB_PATH));
  } catch (e) {
    const { DatabaseSync } = await import('node:sqlite');
    console.warn(`[db] better-sqlite3 不可用（${e.message}），改用内置 node:sqlite（实验特性）`);
    return wrap(new DatabaseSync(DB_PATH));
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
    ['dola_accounts', 'native_15s_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'native_15s_at', 'TEXT'],
    ['dola_accounts', 'native_15s_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'native_30s_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'native_30s_at', 'TEXT'],
    ['dola_accounts', 'native_30s_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_accounts', 'reference_image_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dola_accounts', 'reference_image_at', 'TEXT'],
    ['dola_accounts', 'reference_image_note', "TEXT NOT NULL DEFAULT ''"],
    ['dola_videos', 'local_path', 'TEXT'],
    ['dola_videos', 'local_bytes', 'INTEGER'],
    ['dola_videos', 'is_unwatermarked', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_videos', 'has_reference_images', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_videos', 'reference_image_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['dola_videos', 'strict_account', 'INTEGER NOT NULL DEFAULT 0'],
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
    ['dola_submit_mode', 'browser', '视频提交通道：browser=浏览器模拟提交（默认）/ scheme-a=Abort取签名+页内重放提交（实验）', 'dola'],
    ['dola_convert_auto_zero', 'false', '转换后把账号额度清零（仅记账，不代表真的扣了 dola）', 'dola'],
    ['dola_auto_maintenance_enabled', 'true', '自动巡检账号和可查额度', 'dola'],
    ['dola_auto_cleanup_invalid', 'true', '自动隔离明确失效账号（保留 cookie，不硬删除）', 'dola'],
    ['dola_auto_quota_probe', 'true', '自动探测接口可返回的额度（免费日额度仍以生成回执为准）', 'dola'],
    ['dola_auto_maintenance_interval_minutes', '180', '自动巡检间隔（15～1440 分钟）', 'dola'],
    // 用户端网关（给 8787 工作台调）
    ['gateway_enabled', 'true', '允许用户端调用网关接口（校验令牌/扣积分）', 'gateway'],
    ['gateway_points_per_task', '1', '每个视频任务扣多少积分', 'gateway'],
    ['gateway_prompt_cooldown_seconds', '120', '同一令牌相同提示词冷却时间（秒）', 'gateway'],
    ['gateway_key', '7d4aaa02d7ce44a0e99ebebd7e8f34abe7e28c5ae49b1424', '网关共享密钥（用户端要用它调后台）', 'gateway'],
    // 前台入口
    ['frontend_name', '前台', '前台入口名称', 'frontend'],
    ['frontend_url', 'http://127.0.0.1:8787/', '前台地址（含 http:// 或 https://）', 'frontend'],
    ['frontend_open_mode', 'tab', '打开方式：tab=新标签页 / browser=服务器上开真实浏览器', 'frontend'],
    ['frontend_browser_visible', 'true', '真实浏览器是否显示窗口（关闭=后台静默打开）', 'frontend'],
  ];
  for (const [k, v, label, g] of defs) {
    const exist = db.prepare('SELECT key FROM settings WHERE key=?').get(k);
    if (!exist) db.prepare('INSERT INTO settings (key,value,label,group_name,updated_at) VALUES (?,?,?,?,?)').run(k, v, label, g, now());
  }
  // 2026-09-24：前台默认地址改为 http://127.0.0.1:8787/（mvp 用户面）。
  // 只补空值，不覆盖用户已填的自定义地址；服务每次启动都会执行，幂等。
  db.prepare(`UPDATE settings SET value=?, updated_at=?
    WHERE key='frontend_url' AND (value IS NULL OR value='')`)
    .run('http://127.0.0.1:8787/', now());

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
