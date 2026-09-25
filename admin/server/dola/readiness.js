/**
 * 就绪度合成分级 —— 把散落的 `ok` / `ready` / `degraded` 收敛成**一个**可判断的结论。
 *
 * ── 为什么需要"合成" ──────────────────────────────────────────────────────
 * 改造前，判断"现在到底能不能用"需要自己把四个布尔与几个计数拼起来：
 *
 *     expert_seconds_ready / fixed_seconds_ready / reference_images_ready
 *     + 号池 valid 数 - 冷却数 + 队列余量 + 网关开关
 *
 * 每个调用方（用户端工作台、监控、运维）都会自己拼一套，然后**拼出不同的结论**。
 * 更糟的是没有人告诉它"哪些档位其实不能选"。合成分级就是把这份判断
 * 收成一处，并明确说出**为什么是这个级别**。
 *
 * ── 三级的定义（刻意保守）────────────────────────────────────────────────
 *   down      现在**提交也白提交**：网关实际未生效，或一个可用账号都没有。
 *   degraded  能用，但有已知的缺口：某些档位不能选、有账号在冷却、号池偏少、队列吃紧。
 *   ok        没有已知缺口，且号池不低于补号阈值。
 *
 * ── 两个刻意的设计决定 ────────────────────────────────────────────────────
 * ① **`ok` 不等于"任意档位可用"**。`degraded` 才是常态（原生 15s/30s 需要
 *    页面级探针确认，本来就不常见）。把常态判成 ok 等于这个分级没有信息量；
 *    把它判成 down 又会天天误报。所以中间那一级必须存在，而且要有用。
 *
 * ② **细节绝不进公开接口**。`/v1/healthz` 必须保持 2 字节 `ok`
 *    （对标参考站），因为它是**无鉴权**的 —— 里面写着"原生 30 秒能力未确认"
 *    等于把一个 697 KB 的号池明细换成了一句号池情报，性质是一样的。
 *    所以本模块提供 `publicReadiness()` 只回 `{grade}`，
 *    完整理由只出现在**需要令牌/会话**的接口里。
 *
 * ③ ★ **"有缺口"和"该告警"是两件事**（本模块最容易接错的一根线）。
 *    `grade` 是给**仪表盘/调用方**看的诚实结论；告警只对**异常**负责。
 *
 *    理由分两类（见下文的 `chronic`）：
 *      - **chronic（常态缺口）**：账号在原生能力探针确认之前一直是 `unknown`，
 *        所以"原生 15/30 不可用"在生产里**长期成立**。它是**能力基线**，不是事件。
 *        它必须出现在 `grade`/`reasons` 里（否则仪表盘撒谎），但看板看即可，**不告警**。
 *      - **acute（异常缺口）**：账号在冷却、号池低于阈值、队列满 —— 这些是**新出现的、
 *        可处理的**，才是告警该响的东西。
 *
 *    ⚠️ 实测踩到的坑，代价是"永久误报"：把告警直接绑在 `grade !== 'ok'` 上。
 *    生产只读探测：`valid=7 / cooling=0`（号够用），但 `native_15s_state` 与
 *    `native_30s_state` **全部是 `unknown`**（原生能力从未被确认过），
 *    于是 `ready` 恒为 `[10,20]`、`grade` 恒为 `degraded`、告警**恒 active**。
 *    一个永远 active 的告警等于没有告警，而且它把一条能力基线伪装成了一场事故 ——
 *    真正的事故（号池空了、队列堵了）会被这条噪音淹掉。
 *
 *    所以对外只提供两个**不同**的判断，别混用：
 *      `isDegraded(view)`  → 有没有缺口（给仪表盘/调用方）
 *      `isAlertable(view)` → 有没有异常（给告警规则）
 */
import { db as appDb, getSetting } from '../db.js';
import { SUPPORTED_VIDEO_SECONDS } from './generation-policy.js';

/** 分级取值，从好到坏。顺序有意义：`worstOf` 依赖它。 */
export const READINESS_GRADES = Object.freeze(['ok', 'degraded', 'down']);

/**
 * 取若干分级里**最差**的那个（合并多个分级的唯一正确方式）。
 *
 * ⚠️ 认不出来的取值按 `down` 处理，**不是**按 `ok`。
 *    实测踩过：写成 `Math.max(0, indexOf(g))` 时，`indexOf` 返回 -1 会被夹成 0，
 *    于是 `worstOf('ok', '未来新增的某个级别')` 返回 **'ok'** ——
 *    合并结果把"不认识"当成了"健康"，方向正好是反的。
 *    没有参数时同理：没有结论 ≠ 健康。
 */
export const worstOf = (...grades) => {
  if (!grades.length) return 'down';
  let worst = 0;
  for (const g of grades) {
    const i = READINESS_GRADES.indexOf(g);
    const idx = i < 0 ? READINESS_GRADES.indexOf('down') : i;
    if (idx > worst) worst = idx;
  }
  return READINESS_GRADES[worst];
};

const numSetting = (readSetting, key, fallback) => {
  const v = Number(readSetting(key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};

/**
 * 算出分级。
 *
 * @param {object} p
 * @param {boolean} [p.gatewayEnabled=true] 网关开关**实际生效**的结果（不是"总开关写着 true"）
 * @param {object} [p.generation={}] `generationStatus()` 的返回
 * @param {object} [p.pools={}] `{ expertSecondsReady, fixedSecondsReady, referenceImagesReady }`
 *        —— 即各档位的原生能力就绪布尔
 * @param {object} [p.counts] 号池计数；不传则自己查库
 * @returns {{grade:'ok'|'degraded'|'down', reasons:string[], seconds:{supported:number[], ready:number[]},
 *            accounts:{valid:number, cooling:number, available:number}, queue:{activeTasks, queueLimit, queueAvailable},
 *            at:string}}
 */
export function readinessSummary({
  gatewayEnabled = true,
  generation = {},
  pools = {},
  counts = null,
  readSetting = getSetting,
  database = appDb,
  at = new Date(),
} = {}) {
  // 理由收集器。每一项都带 `chronic` 标记（见文件头 ③）：
  //   chronic=true  常态缺口 → 进 grade/reasons，但**不触发告警**
  //   chronic=false 异常缺口 → 进 grade/reasons，且**触发告警**
  const why = [];
  const reason = (text, { chronic = false } = {}) => { why.push({ text, chronic }); };

  // 号池计数：`available` = 有效且不在冷却里。这是"现在真的能派号"的数量。
  let pool = counts;
  if (!pool) {
    const nowIso = at.toISOString();
    let row = null;
    try {
      row = database.prepare(`SELECT
        SUM(CASE WHEN status='valid' THEN 1 ELSE 0 END) AS valid,
        SUM(CASE WHEN status='valid' AND cooldown_until IS NOT NULL AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooling
        FROM dola_accounts`).get(nowIso);
    } catch {
      row = null;   // 表还没建：当 0 处理，不因为健康检查把主流程搞挂
    }
    pool = { valid: Number(row?.valid || 0), cooling: Number(row?.cooling || 0) };
  }
  const available = Math.max(0, Number(pool.valid || 0) - Number(pool.cooling || 0));

  // 各档位的就绪情况。10/20 秒走的是页面默认路径，不需要原生能力探针，
  // 只要求"有可用账号"；15/30 秒需要账号级原生能力已确认。
  const readySeconds = SUPPORTED_VIDEO_SECONDS.filter((s) => {
    if (available <= 0) return false;
    if (s === 15) return Boolean(pools.expertSecondsReady ?? pools.native15Ready);
    if (s === 30) return Boolean(pools.fixedSecondsReady ?? pools.native30Ready);
    return true;
  });

  // ⚠️ 这两个必须在任何 `finish()` 调用**之前**求值：`finish` 是函数声明（会提升），
  //    但它闭包里引用的 `const` 仍在 TDZ 里 —— 在 down 分支提前调用会直接抛
  //    "Cannot access 'queueLimit' before initialization"，而且是在健康检查里抛。
  const queueLimit = Number(generation.queueLimit ?? 0);
  const queueAvailable = Number(generation.queueAvailable ?? 0);

  // ── down：提交也白提交 ────────────────────────────────────────────────
  if (!gatewayEnabled) {
    reason('网关当前未实际生效（总开关或范围没通过）');
    return finish('down');
  }
  if (available <= 0) {
    reason(Number(pool.valid || 0) > 0
      ? `号池里 ${pool.valid} 个有效账号全部在冷却中`
      : '号池里没有有效账号');
    return finish('down');
  }

  // ── degraded：能用，但有缺口 ──────────────────────────────────────────
  const replenishMin = numSetting(readSetting, 'dola_replenish_min_accounts', 5);
  // ★ 原生 15/30 是 **chronic**：账号在被页面级探针确认之前一直是 `unknown`，
  //   所以这条在生产里长期成立。进 grade 让仪表盘诚实，但**不告警**（见文件头 ③）。
  if (!readySeconds.includes(30)) reason('原生 30 秒档位当前不可用', { chronic: true });
  if (!readySeconds.includes(15)) reason('原生 15 秒档位当前不可用', { chronic: true });
  // 以下都是 acute：新出现的、可处理的缺口，告警该响的就是这些。
  if (Number(pool.cooling || 0) > 0) reason(`${pool.cooling} 个账号在限流冷却中`);
  if (replenishMin > 0 && available < replenishMin) {
    reason(`可用账号 ${available} 个，低于补号阈值 ${replenishMin}`);
  }
  if (queueLimit > 0 && queueAvailable <= 0) reason('生成队列已满');

  return finish(why.length ? 'degraded' : 'ok');

  function finish(grade) {
    return {
      grade,
      // `reasons` = 全部缺口（给人和接口看，保持诚实）
      reasons: why.map((r) => r.text),
      // `acute` = 其中的异常缺口（唯一该驱动告警的集合）；只有常态缺口时是空数组
      acute: why.filter((r) => !r.chronic).map((r) => r.text),
      seconds: { supported: [...SUPPORTED_VIDEO_SECONDS], ready: readySeconds },
      accounts: { valid: Number(pool.valid || 0), cooling: Number(pool.cooling || 0), available },
      queue: {
        activeTasks: Number(generation.activeTasks ?? 0),
        queueLimit,
        queueAvailable,
      },
      at: at.toISOString(),
    };
  }
}

/**
 * 对外的**精简**投影：只回分级。
 *
 * ⚠️ 这是硬约束，不是为了好看：这个投影会进到带令牌的接口里，
 *    而 `reasons`（"号池里没有有效账号""原生 30 秒不可用"）属于**内部资源情报**。
 *    调用方真正需要的判断是"我现在该不该提交"，一个分级足够。
 */
export const publicReadiness = (view) => ({ grade: view?.grade || 'down' });

/**
 * `degraded` 或 `down`（即"非全好"）—— 给**仪表盘/调用方**判断"有没有缺口"用。
 *
 * ⚠️ **不要**拿它当告警判据（`metrics.js` 曾经就是这么接的，代价是永久误报）。
 *    它只回答"有没有缺口"，不回答"是不是异常"。告警请用 `isAlertable()`。
 *    生产实测：原生能力从未确认 → `grade` 恒 `degraded` → 绑在它上面的告警恒 active。
 */
export const isDegraded = (view) => (view?.grade || 'down') !== 'ok';

/**
 * 该不该**告警** —— 和 `isDegraded` **不是同一个判断**，这是本模块最容易接错的一根线。
 *
 * 判据：
 *   `down`        → 一定告警（提交也白提交，是真事故）
 *   `degraded`    → **只在有 acute（异常）理由时**告警；只有 chronic 常态缺口时不告警
 *   `ok`          → 不告警
 *   缺字段/未知    → 按**可告警**处理（没有结论 ≠ 健康，与 `worstOf` 同一取向）
 *
 * 为什么 `degraded` 不能一律告警：见文件头 ③ 里那段生产实测。
 * 一句话 —— **常态不是事件**。chronic 缺口看 `dola_admin_seconds_ready` 这类仪表盘指标，
 * 不要占用告警通道，否则真事故会被噪音淹掉。
 */
export const isAlertable = (view) => {
  const g = view?.grade || 'down';
  if (g === 'down') return true;
  if (g === 'ok') return false;
  // degraded：认不出的形状（没有 acute 字段）按可告警处理，宁可误报也不静默漏报
  return Array.isArray(view?.acute) ? view.acute.length > 0 : true;
};
