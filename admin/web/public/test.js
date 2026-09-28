/**
 * 视频 API 工作台 —— 按上游 API 契约逐项对齐。
 *
 * ── 对齐清单（能力 → 本页按钮 → 实际请求）────────────────────────────
 *   测连通     → 测连通         → GET  /v1/status          （*见下方差异①）
 *   拉模型     → 拉模型         → GET  /v1/models
 *   加入任务   → 加入任务       → POST /v1/videos          （auto_start 可关）
 *   立即刷新   → 立即刷新       → GET  /v1/videos/{id}
 *   取消任务   → 取消任务       → POST /v1/videos/{id}/cancel
 *   清除任务   → 清除任务       → DELETE /v1/videos/{id}
 *   刷新列表   → 刷新列表       → GET  /v1/videos?limit=20
 *   全部提交上游→ 全部提交上游  → POST /v1/videos/start    {ids}
 *   清空任务记录→ 清空任务记录  → DELETE /v1/videos         {all:true}
 *   行内：提交上游/取消/获取状态/清除 → 同名单行按钮
 *   双 Tab：当前任务 / 任务列表 → 同左
 *
 * ── 两处刻意不同（都是有理由的）────────────────────────────────
 * ① 「测连通」不走未鉴权的 `GET /health`（那类接口会连带吐出账号明细），
 *    改打需要令牌的 `/v1/status`（见 server/v1-routes.js 的 /status 注释），
 *    统计卡内容换成本服务真实可得的四项。
 * ② 「清除」不做物理删除：dola_videos 行同时是扣费凭据、退款凭据和审计证据，
 *    物理删除会让「扣过积分的任务凭空消失」，事后对不上账。
 *    所以 DELETE 在服务端 = **取消 + 打 cleared_at 软删除**：列表里不再出现（刷新也不会回来），
 *    按 id 仍然查得到。
 *    注意这与 POST /:id/cancel 是两件事：cancel 只是停掉，任务仍在列表里。
 *
 * ── 一处能力差异：不能重启失败任务 ────────────────────────────────────────
 * 服务端的 startOwnedVideoTask 只接受 `queued`（其余一律 409 TASK_NOT_STARTABLE）。
 * 所以本页的「提交上游」
 * 只对排队中的任务开放，失败/已取消的任务会显示为不可提交并给出原因，
 * 而不是给一个点了必然报错的按钮。
 *
 * ── 没有数据源、因此明确不做的 ────────────────────────────────────────────
 * 任务行不保存上游的逐条对话事件（`metadata.upstream_text_events`）与真实进度百分比
 * （`progress`），所以这里只给「阶段进度（按状态估算）」和一条说明 ——
 * 不伪造一条看起来像上游对话的日志。
 *
 * ── 2026-09-25：承接旧用户工作台的全部能力，并到本页 ─────────────────────
 * 逐项对应：
 *   登录/退出       → 令牌 + 可选「记住令牌」(localStorage) + 顶栏「退出」
 *   顶栏余额        → GET /v1/status 的 token.points（不是本地记账）
 *   积分兑换        → POST /v1/redeem           （新增端点，与 /api/gateway/redeem 共用 redeemCard）
 *   批量创建        → 逐条 POST /v1/videos      （不做批量端点）
 *   素材库          → localStorage 本地素材，不上传、不跟令牌漫游
 *   任务搜索/分页    → 客户端筛选 + GET /v1/videos?limit=
 *   专家模式下拉     → **不迁**：v1 由 seconds 反推 mode（15 秒 = 专家），
 *                     多一个下拉只会造出「选了专家 + 10 秒」这种自相矛盾的状态。
 *   15秒×2 档位      → **不迁**：那是上游拼接档，本服务默认关闭（dola_upstream_concat=false），
 *                     页面给一个点了必然被拦的按钮不如不给。
 * 两套工作台的数据本就在同一个后台库里（dola_videos.owner_token_id / tokens.points），
 * 所以下线 8787 不需要搬数据 —— 令牌还是那个令牌，任务与积分照旧。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /**
   * 令牌是否落盘由用户显式勾选决定（默认不勾）——
   * 本页原来的立场是「令牌只在内存里」，加持久化时没有把默认值改成「记住」，
   * 因为「默认记住」意味着任何在这台机器上打开页面的人都能直接用别人的令牌。
   */
  const TOKEN_KEY = 'video-api-workbench-token';
  const THEME_KEY = 'video-api-workbench-theme';
  const MATERIAL_KEY = 'video-api-workbench-materials';
  /**
   * 「提交中」占位行的落盘位置。
   *
   * ⚠️ 用 **sessionStorage** 而不是 localStorage，这是刻意的：
   *   · 刷新（F5 / Cmd+R）和同标签页内切走再回来 → **保留**（用户要的就是这个）；
   *   · 关掉标签页 → 自动清掉（没有「三天前的提交中」这种幽灵行）；
   *   · 天然按标签页隔离，不会两个标签页互相认领对方的任务；
   *   · 不需要把令牌原文再写一份到 localStorage。
   * 详见 restorePendingJobs / persistPendingJobs。
   */
  const PENDING_KEY = 'video-api-workbench-pending';
  /**
   * 占位行的「孤儿」时限：超过这么久还没被服务端任务认领，就判定这次提交
   * 已经断了（最典型的原因：刷新时浏览器把在途的 POST 中止了）。
   * 单次 POST 自己的超时是 150 秒，所以 3 分钟足够覆盖任何「还在正常跑」的情况。
   */
  const PENDING_ORPHAN_MS = 180_000;
  /**
   * 「我的任务」的**浏览状态**落盘位置（2026-09-28 用户要求「历史记录也要持久化」）。
   *
   * 只存「你在看哪儿」，**不存任务内容** —— 文件头那条立场不变：
   * 任务数据一律回源，不做本地缓存（缓存余额/状态是最容易骗到人的一种错）。
   *   · job-limit   → 每页条数（纯偏好，与令牌无关）
   *   · job-filter  → 筛选词（列表里的空态会明说「没有匹配「X」的任务」，不会静默藏数据）
   *   · current-id  → 「当前任务」停在哪一条
   */
  const JOB_LIMIT_KEY = 'video-api-workbench-job-limit';
  const JOB_FILTER_KEY = 'video-api-workbench-job-filter';
  const CURRENT_ID_KEY = 'video-api-workbench-current-id';
  /** 每页条数的合法值。盘上的值可能被手改过，必须校验后再用。 */
  const JOB_LIMITS = [20, 50, 100];
  /**
   * 「当前任务」id 的落盘开关。
   * `clearSessionData()` 会把 currentId 置空 —— 而它在页面加载的 auto-reconnect 路径上
   * 也会被调到，那一刻置空会把「刷新前停在哪条」当场抹掉。所以那段期间挂起落盘。
   * ⚠️ 这只保住了**盘上**那一份；内存里那一份由 connect() 自己捞回来（见那里的
   *    carriedCurrentId）—— 否则 verifyRestoredCurrentId() 读到空值会直接 return。
   */
  let suspendCurrentIdPersist = false;
  /** 批量创建的单次上限：20 行。别让一次误粘贴打出上百条真实任务。 */
  const BATCH_MAX_LINES = 20;
  /** 本机素材里参考图的 base64 总字节上限：localStorage 一般只有 5MB，超了会写失败。 */
  const MATERIAL_IMAGE_BUDGET = 1_500_000;
  const FILE_PREVIEW = window.location.protocol === 'file:';

  const state = {
    token: '', status: null, models: [], files: [], jobs: [],
    /**
     * 批量创建专用的参考图（与主工作台 state.files **互相独立**）。
     * 为什么不共用一份：批量弹窗是「这一批用同一组图」的独立语境，
     * 主工作台的图是给单条任务准备的 —— 共用会让用户为了批量而误改单条的图，
     * 反过来也一样。上限同样是 9 张（上游单次上限，见 server/dola/reference-images.js 的 IMAGE_MAX_COUNT）。
     */
    batchFiles: [],
    pollTimer: null, objectUrl: '', epoch: 0, tab: 'run', autoStart: true, loaded: {},
    materials: [],
    /**
     * 「当前任务」最近一次**详情**渲染用的那条 job。
     *
     * ⚠️ 为什么不能像别处那样去 `state.jobs` 里 find 一条：列表轮询走的是
     *    GET /v1/videos（publicTask 不带 detail），**返回项里根本没有
     *    unwatermarked_url**；而 refreshJobs() 是整表替换 state.jobs。
     *    所以详情加载完 4 秒后就被列表刷掉了 —— 拿 state.jobs 算「有没有无水印」
     *    会算成「永远没有」。这里单独留一份详情，只在 renderJob() 里写。
     */
    currentJob: null,
    /** 无水印预览专用的 object URL（**不复用** state.objectUrl：那是主播放器的源）。 */
    uwObjectUrl: '',
    /** 预览这一版是从哪来的：'archive' | 'upstream' | ''。决定播放失败时提示怎么写。 */
    uwKind: '',
    // ── 浏览状态：从盘上接回来（见文件头 JOB_*_KEY 注释）──────────────
    jobFilter: storageGet(JOB_FILTER_KEY) || '',
    jobLimit: JOB_LIMITS.includes(Number(storageGet(JOB_LIMIT_KEY)))
      ? Number(storageGet(JOB_LIMIT_KEY)) : 20,
    /**
     * 「当前任务」停在哪一条。做成存取器是为了**只有一处**需要记得落盘 ——
     * 全文件有 9 处给 `state.currentId` 赋值（选中行、提交后、开始任务、清空…），
     * 挨个补 persist 调用迟早会漏一个。
     */
    _currentId: storageGet(CURRENT_ID_KEY) || '',
    get currentId() { return this._currentId; },
    set currentId(value) {
      const next = String(value ?? '');
      if (next === this._currentId) return;   // 没变就不写盘：轮询每 4 秒会重渲染一次
      this._currentId = next;
      if (suspendCurrentIdPersist) return;
      if (next) storageSet(CURRENT_ID_KEY, next);
      else storageRemove(CURRENT_ID_KEY);
    },
    /**
     * 乐观占位（2026-09-27「任务列表实时化」重构）。
     *
     * 点「加入任务」到 POST 返回之间，任务在服务端已经建好但前端还没有 id。
     * 以前这段时间用户只能盯着按钮上的「提交中…」——占位行让「我的任务」里
     * 立刻就能看见它，回包后再换成真实行（同一次渲染里换完，不闪）。
     *
     * ⚠️ 占位**不放进 state.jobs**：那些数据会被 startAll / clearAllJobs /
     *    syncButtons 当成真任务去算（比如"排队中"计数、批量提交上游的 id 列表）。
     *    单独一个数组、只在渲染时并到最前面，就不用挨个函数补判断。
     */
    pendingJobs: [], pendingSeq: 0,
    /**
     * 占位行的「秒表」定时器。占位行必须看起来是活的 ——
     * 提交一次要等几十秒，一行不动的灰字用户会以为页面卡死了。
     * 见 ensurePendingTicker()。
     */
    pendingTicker: null,
    /** 列表指纹：内容没变就不重绘，避免 4 秒一次的无谓 DOM 抖动。 */
    jobsFingerprint: '',
  };

  /** 还在自己往终态走的四个状态。 */
  const ACTIVE = new Set(['queued', 'submitting', 'generating', 'resolving']);

  /**
   * 列表轮询的两档间隔。为什么是「列表轮询」而不是「单条轮询」：
   * 一次 GET /v1/videos 就把**所有**任务的最新状态都带回来了，
   * 而原来的实现只轮询「当前选中」那一条（15 秒一次），
   * 列表里其它任务的状态永远不会变 —— 用户只能手动点「刷新列表」。
   */
  const POLL_BUSY_MS = 4000;
  const POLL_IDLE_MS = 20000;
  const LABELS = {
    queued: '排队中', submitting: '提交中', generating: '生成中', resolving: '整理成片',
    ready: '已完成', failed: '失败', cancelled: '已取消',
  };
  /** 阶段进度：按状态估算，不是上游回报的百分比。见文件头注释。 */
  const STAGE_PROGRESS = { queued: 10, submitting: 35, generating: 65, resolving: 92, ready: 100, failed: 100, cancelled: 100 };

  $('originLabel').textContent = FILE_PREVIEW ? '本地文件预览' : window.location.origin;
  $('adminLink').href = '/dola';
  if (FILE_PREVIEW) $('adminLink').classList.add('hidden');
  if (FILE_PREVIEW) {
    $('fileModeNotice').classList.remove('hidden');
    $('apiKey').disabled = true;
    $('connect').disabled = true;
    $('connectionState').textContent = '请从本地服务打开';
  }

  // ─────────────────────────────────────────────────────────── 主题

  function setTheme(theme, persist = false) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    $('themeToggle').setAttribute('aria-pressed', String(value === 'dark'));
    if (persist) {
      try { localStorage.setItem(THEME_KEY, value); }
      catch { /* 浏览器禁用存储时仍可在当前页面切换 */ }
    }
  }

  setTheme(document.documentElement.dataset.theme);
  $('themeToggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });

  // ─────────────────────────────────────────────────────────── 本机存储
  // 只有这三样东西会落盘：主题、用户显式勾选记住的令牌、本机素材。
  // 任务数据、余额、状态一律回源，不做本地缓存 —— 缓存余额是最容易骗到人的一种错。

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch { return false; }
  }

  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* 无所谓 */ }
  }

  /** 落盘 / 擦除令牌。空值等于擦除，避免留下一把已经登出的令牌。 */
  function persistToken(value) {
    if (value) storageSet(TOKEN_KEY, value);
    else storageRemove(TOKEN_KEY);
  }

  // ── 「提交中」占位行的持久化（sessionStorage，见 PENDING_KEY 注释）──────────

  /**
   * 令牌指纹：只用来回答「这条待确认是不是当前令牌提的」。
   *
   * 为什么不直接存令牌原文：占位行的落盘**不该**把令牌又写一份 ——
   * 用户可能压根没勾「记住令牌」，我们不能借这个功能偷偷替他记住。
   * FNV-1a 32 位足够做「等不等」的判据，而令牌本身是高熵随机串，反推不出来。
   */
  function tokenHint(token) {
    const s = String(token || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function readPendingRaw() {
    try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; }
  }

  function clearPendingStore() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 隐私模式写不了，忽略 */ }
  }

  /**
   * 把当前占位行写进 sessionStorage。
   * 每次增删都要调 —— 只在提交时写一次的话，回包后撤掉的那条会留在盘上，
   * 下次刷新又冒出来，比不持久化还糟。
   */
  function persistPendingJobs() {
    try {
      if (!state.pendingJobs.length) { sessionStorage.removeItem(PENDING_KEY); return; }
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        hint: tokenHint(state.token),
        seq: state.pendingSeq,
        items: state.pendingJobs.map((job) => ({
          id: job.id, prompt: job.prompt, seconds: job.seconds,
          startedAt: job.startedAt, stage: job.stage, error: job.error || '',
        })),
      }));
    } catch { /* 写不进去（隐私模式 / 配额）不影响本次提交，只是刷新后会丢 */ }
  }

  /**
   * 页面加载后把占位行接回来。
   *
   * ⚠️ 必须在**第一次 refreshJobs() 之前**调用：refreshJobs 的「认领」逻辑是
   *    「本次轮询里新冒出来的任务」才认（previousIds 之外）。刷新后 state.jobs 是空的，
   *    所以第一次轮询看到的任何任务都算「新」→ 能立刻把占位换成真实行。
   *    放到第一次轮询之后，已经落库的任务就不在 previousIds 之外了，永远认领不到。
   *
   * 超时（PENDING_ORPHAN_MS）的条目不恢复：那说明这次提交在刷新时被中止了，
   * 与其留一行永远不动的「提交中」骗人，不如明确告诉用户去核对。
   */
  function restorePendingJobs() {
    let data = null;
    try { data = JSON.parse(readPendingRaw() || 'null'); } catch { data = null; }
    if (!data || !Array.isArray(data.items) || !data.items.length) return;
    if (data.hint !== tokenHint(state.token)) return;   // 换过令牌 → 不是它的待确认

    const now = Date.now();
    const fresh = [];
    let orphan = 0;
    for (const item of data.items) {
      if (!item || !item.prompt) continue;
      if (now - Number(item.startedAt || 0) > PENDING_ORPHAN_MS) { orphan += 1; continue; }
      fresh.push({
        id: item.id, __pending: true, status: 'submitting',
        stage: item.stage || '正在创建任务…', prompt: item.prompt,
        seconds: item.seconds, error: item.error || '',
        startedAt: Number(item.startedAt) || now,
      });
    }
    const maxId = fresh.reduce((m, job) => Math.max(m, Number(String(job.id).replace(/^pending-/, '')) || 0), 0);
    state.pendingJobs = fresh;
    state.pendingSeq = Math.max(Number(data.seq) || 0, maxId);
    persistPendingJobs();
    // 刷新后默认停在「当前任务」页签，接回来的占位行在「任务列表」里 —— 不切过去
    // 用户第一眼还是看不到它，等于白接。和 createTask() 提交时那一句是同一个理由。
    if (fresh.length) renderTab('jobs');
    if (orphan) {
      setError(`有 ${orphan} 条提交在上次刷新时被中断，且已超过 ${Math.round(PENDING_ORPHAN_MS / 60000)} 分钟`
        + `没有对应任务落地。请点「刷新列表」核对该任务是否其实已经创建。`);
    }
  }

  /**
   * 校验从盘上接回来的「当前任务」。
   *
   * 只负责「停在哪一条」，**不缓存任务内容**（任务数据一律回源，见文件头）。
   * 所以必须真的回读一次：那条任务可能已经被清除、或根本不属于当前令牌 ——
   * 那种情况下要把当前任务清空（存取器会顺手把盘上的值也擦掉），
   * 而不是留一个「当前任务 #123」却永远读不出内容的假状态。
   */
  async function verifyRestoredCurrentId() {
    const id = state.currentId;
    if (!id) return;
    try {
      await loadJob(id, { select: false });
    } catch {
      state.currentId = '';
      renderEmptyJob();
    }
  }

  // ─────────────────────────────────────────────────────────── 请求层

  function bearerHeaders(extra = {}) {
    return { Authorization: `Bearer ${state.token}`, ...extra };
  }

  async function fetchResponse(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
    if (FILE_PREVIEW) throw new Error('当前是文件预览，无法连接后台；请通过正式网址打开工作台');
    if (!state.token) throw new Error('请先输入自己的用户令牌并连接');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const options = { method, headers: bearerHeaders(), signal: controller.signal, credentials: 'same-origin' };
    if (body instanceof FormData) options.body = body;
    else if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    try {
      return await fetch(`${window.location.origin}${path}`, options);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('请求超时。请先刷新任务状态，再决定是否重试，避免重复提交。');
      throw new Error('网络请求失败：' + (error?.message || '未知错误'));
    } finally {
      clearTimeout(timer);
    }
  }

  function unwrap(payload) {
    return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  }

  /**
   * /v1 的错误文案沿用上游 API 契约的原文，所以有一小批是英文的 ——
   * 最典型的就是 `invalid api key`（契约原文，在 /v1 里必须一字不改，
   * 否则照它契约写的客户端会解析失败）。契约层保持原文，翻译只发生在**显示层**。
   *
   * 两条硬约束（都是怕「翻错」）：
   *   ① 服务端已经给中文的，**一律原样显示**（判据：含非 ASCII 字符）——
   *      本地化不能反过来把服务端给的中文盖掉；
   *   ② 只在**认得这个 code** 时才翻，认不得就原样返回 ——
   *      翻错的代价比不翻高得多：用户会照着错的意思去排查。
   */
  const ERROR_CODE_ZH = new Map([
    ['MISSING_API_KEY', '请求没有带上令牌'],
    ['INVALID_API_KEY', '令牌无效：不存在、已被停用，或已过期'],
    ['NOT_FOUND', '接口不存在'],
  ]);

  function localizeErrorText(message, code) {
    const text = String(message || '');
    if (!text) return text;
    // 含非 ASCII = 服务端已经给中文了，别动
    if (/[^\x00-\x7F]/.test(text)) return text;
    return ERROR_CODE_ZH.get(String(code || '')) || text;
  }

  /** 把响应里的 error 结构翻成一个带 code/diagnostic 的 Error，业务代码只看 error.message。 */
  function toError(payload, response) {
    const detail = payload?.error || payload;
    const code = detail?.code || payload?.code || '';
    const raw = detail?.message || payload?.message || `请求失败（HTTP ${response.status}）`;
    const error = new Error(localizeErrorText(raw, code));
    error.code = code;
    error.rawMessage = raw;            // 契约原文留着，排障时对照用
    error.diagnostic = detail?.diagnostic || payload?.diagnostic || null;
    return error;
  }

  async function requestJson(path, options) {
    const response = await fetchResponse(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) throw toError(payload, response);
    return unwrap(payload);
  }

  /**
   * 按钮忙碌态：防重复点击（清除/提交这类会花钱的操作尤其需要）。
   *
   * ⚠️ 收尾**不能**无条件 `button.disabled = false`：那样会让「加入任务」「刷新列表」
   *    在未连接/令牌失效时也变成可点（点了必然报「请先输入令牌」）。
   *    受管按钮一律交回 syncButtons() 按当前状态重算；行内按钮不在受管集合里，
   *    单独解禁。
   *
   * ⚠️⚠️ 因此给某个弹窗按钮套 withBusy 前先问一句：「syncButtons() 管它吗？」
   *    不管的话，**必须**在 HTML 上给它加 data-act（随便什么值，只当标记用），
   *    否则第一次用完就永久禁用 —— 用户第二次点「加入参考图」「存为素材」
   *    会毫无反应（2026-09-29 验证批量参考图时实测踩到：图库选择器只能用一次）。
   *    目前由 syncButtons 管的：pullModels/create/batchCreate/refreshJobs/
   *    refreshCurrent/clearCurrent/startQueued/clearJobs/redeemBtn/ping +
   *    syncUnwatermarkedButton(previewUnwatermarked)。
   */
  async function withBusy(button, text, fn) {
    if (!button || button.dataset.busy === '1') return undefined;
    const previous = button.textContent;
    button.dataset.busy = '1';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (text) button.textContent = text;
    try { return await fn(); }
    finally {
      button.textContent = previous;
      button.removeAttribute('aria-busy');
      delete button.dataset.busy;
      if (button.dataset.act) button.disabled = false;
      else syncButtons();
    }
  }

  // ─────────────────────────────────────────────────────────── 通用小件

  function showConnection(text, tone = '') {
    $('connectionState').textContent = text;
    $('statusDot').className = `dot ${tone}`.trim();
  }

  function setError(message, { code = '', diagnostic = null } = {}) {
    const box = $('taskError');
    const parts = [message || '操作失败'];
    if (code) parts.push(`错误码：${code}`);
    if (diagnostic) parts.push(`预检诊断：\n${JSON.stringify(diagnostic, null, 2)}`);
    box.textContent = parts.join('\n');
    box.classList.add('show');
  }

  function clearError() {
    $('taskError').textContent = '';
    $('taskError').classList.remove('show');
  }

  function displayStatus(status) {
    return LABELS[status] || status || '未知';
  }

  const fmtInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
  };

  /**
   * 顶栏常驻余额。数据源只有一个：`/v1/status` 的 `token.points`（回源，不本地记账）。
   * 没连接时显示「—」而不是 0 —— 0 是「余额为零」这个具体事实，不能拿来表示「还不知道」。
   */
  function renderTopBalance() {
    const points = state.status?.token?.points;
    const box = $('topBalance');
    if (points == null) {
      box.textContent = '积分 —';
      box.title = '连接令牌后显示余额（读 /v1/status）';
      return;
    }
    box.textContent = `积分 ${fmtInt(points)}`;
    box.title = `当前令牌余额 ${points} 积分（读 /v1/status，不是本地记账）`;
  }

  // ─────────────────────────────────────────────────────────── Tab

  function renderTab(name) {
    state.tab = name === 'jobs' ? 'jobs' : 'run';
    $('tabRun').classList.toggle('active', state.tab === 'run');
    $('tabJobs').classList.toggle('active', state.tab === 'jobs');
    $('pane-run').classList.toggle('active', state.tab === 'run');
    $('pane-jobs').classList.toggle('active', state.tab === 'jobs');
    if (state.tab === 'jobs') {
      const epoch = state.epoch;
      refreshJobs().catch((error) => { if (epoch === state.epoch) setError(error.message, error); });
    }
  }

  // ─────────────────────────────────────────────────────────── 模型 / 时长

  function currentModel() {
    return state.models.find((item) => item.id === $('model').value) || null;
  }

  function fillModels(preserve = true) {
    const select = $('model');
    const previous = preserve ? select.value : '';
    // 过滤掉 seedance_v2.0_std（这条是给内部页面用的瘦身版）。
    // 我们目录里没有这条，保留这个过滤是为了「同一份目录下发也不出意外」。
    const items = state.models.filter((item) => item.id !== 'seedance_v2.0_std');
    select.replaceChildren();
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name || item.id;
      select.append(option);
    }
    if (previous && items.some((item) => item.id === previous)) select.value = previous;
    else if (items.some((item) => item.id === 'seedance_v2.5')) select.value = 'seedance_v2.5';
    select.disabled = items.length === 0;
    $('pullModels').disabled = items.length === 0;
    fillSeconds();
  }

  /**
   * 填时长档位下拉框。
   *
   * ★ 默认档位 = 15 秒（专家模式），原因：
   *   · 上游 15 秒 = seedance_v2.0 的专家档（见 `modelForDuration`），效果上限更高。
   *   · 与后端"档位同步"的产品决策一致（30 秒是普通档、15 秒是专家档）。
   *   · 历史实现 fallback 到 `values.includes(10) → '10'`，但生产环境
   *     `supported_seconds` 一般是 `[15, 30]`，这条 fallback 永远走不到，
   *     select.value 留空 → 浏览器显示第一个 option（恰好是 15 秒）。
   *     看起来"能工作"，但语义是错的：依赖浏览器自动行为、且会把"用户上次选 30"
   *     误当成"用户没选过"重置回 15。
   *
   * ★ 不持久化到 localStorage：与文件头"任务数据、余额、状态一律回源"
   *   一致（缓存余额最容易骗人，时长同理 —— 跨设备/跨浏览器出现"明明选过 30
   *   却变 15"会让用户怀疑程序坏了）。
   *
   * ★ 本次会话保留：用户主动选过的档位（且仍可用）刷新/重连时不丢。
   *   **关键 bug 修复**：原 `select.value` 是在 `replaceChildren()` 之后
   *   才读，那时 select 已经被清空、Number('') = 0、`values.includes(0) = false`，
   *   所以"preserve=true"其实是**没生效的**。必须**先取再替换**。
   *
   * @param {boolean} preserve  默认 true：保留用户已选；false：强制重置为默认（专家 15）
   */
  function fillSeconds(preserve = true) {
    const select = $('seconds');
    // ★ 必须先取：replaceChildren() 之后 select.value 会被清成 ""
    const selected = preserve ? Number(select.value) : NaN;
    const modelDurations = new Set(state.models.flatMap((item) => (item.supported_seconds || []).map(Number)));
    const values = (state.status?.supported_seconds || [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && modelDurations.has(value));
    select.replaceChildren();
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value} 秒`;
      select.append(option);
    }
    if (values.includes(selected) && selected > 0) {
      select.value = String(selected);              // 用户上次主动选过的（且仍可用）→ 保留
    } else if (values.includes(15)) {
      select.value = '15';                         // 默认专家模式
    } else if (values.length) {
      select.value = String(values[0]);            // 15 不可用时，至少落到一个可用档位（避免 select.value=''）
    }
    // 否则 select.value 保持空（values 为空，select 会一并被 disabled）
    select.disabled = values.length === 0;
    fillBatchOptions();
    syncDurationModel();
  }

  function modelForDuration(seconds) {
    if (seconds === 15) return 'seedance_v2.0';
    if (seconds === 20 || seconds === 30) return 'seedance_v2.5';
    return '';
  }

  function syncDurationModel(announce = false) {
    const seconds = Number($('seconds').value);
    const preferred = modelForDuration(seconds);
    if (preferred && state.models.some((item) => item.id === preferred) && $('model').value !== preferred) {
      $('model').value = preferred;
      if (announce) showConnection(`${seconds} 秒已切换到 ${preferred}`, 'good');
    }
    renderCapability();
  }

  function syncModelChoice() {
    const seconds = Number($('seconds').value);
    const preferred = modelForDuration(seconds);
    if (preferred && state.models.some((item) => item.id === preferred) && $('model').value !== preferred) {
      $('model').value = preferred;
      showConnection(`${seconds} 秒需要 ${preferred}，模型已自动调整`, 'good');
    }
    renderCapability();
  }

  function renderCapability() {
    const status = state.status;
    const box = $('capability');
    if (!status) {
      box.className = 'capability';
      box.textContent = '连接后显示令牌余额、时长能力与参考图就绪情况。';
      return;
    }
    const seconds = Number($('seconds').value);
    const checks = [];
    // ★ 2026-09-28：能力探测已整体下线，native_*_state 全为 unknown，
    //   "当前未确认" 变成假阴性（unknown 不拦截提交，只是没跑过探测）。
    //   改文案为"由服务端实时判断"，避免用户误以为"没确认 = 不能生成"。
    //   真正需要标黄的是参考图缺失（files.length > 0 且 reference_images_ready=false）。
    if (seconds === 15) checks.push(`15 秒原生能力：${status.expert_seconds_ready ? '池内有已确认能力' : '由服务端实时判断'}`);
    if (seconds === 30) checks.push(`30 秒能力：${status.fixed_seconds_ready ? '池内有已确认能力' : '由服务端实时判断'}`);
    if (state.files.length) checks.push(`参考图能力：${status.reference_images_ready ? '池内有已确认能力' : '当前未确认'}`);
    checks.push(`本服务暂不支持参考音频；图片最多 ${status.reference_images_max || 9} 张。`);
    const uncertain = (state.files.length > 0 && !status.reference_images_ready);
    box.className = `capability ${uncertain ? 'warn' : 'good'}`;
    box.textContent = checks.join(' · ');
  }

  // ─────────────────────────────────────────────────────────── 统计条（测连通）

  function renderStats() {
    const box = $('summary');
    box.replaceChildren();
    const status = state.status;
    const generation = status?.generation || {};
    const cards = status ? [
      {
        value: fmtInt(status.token?.points ?? 0),
        label: '令牌余额',
        tone: Number(status.token?.points || 0) > 0 ? 'ok' : 'bad',
      },
      {
        value: `${fmtInt(status.points_per_task || 1)} 积分`,
        label: '每任务消耗',
        tone: '',
      },
      {
        value: `${fmtInt(generation.running || 0)} / ${fmtInt(generation.concurrency || 0)}`,
        label: '运行 / 并发',
        tone: '',
      },
      {
        value: fmtInt(generation.queued || 0),
        label: '排队',
        tone: '',
      },
    ] : [
      { value: '—', label: '令牌余额', tone: '' },
      { value: '—', label: '每任务消耗', tone: '' },
      { value: '—', label: '运行 / 并发', tone: '' },
      { value: '—', label: '排队', tone: '' },
    ];
    for (const card of cards) {
      const node = document.createElement('div');
      node.className = `stat ${card.tone}`.trim();
      const big = document.createElement('b');
      big.textContent = card.value;
      const small = document.createElement('span');
      small.textContent = card.label;
      node.append(big, small);
      box.append(node);
    }
  }

  function renderCostNote() {
    const status = state.status;
    const cost = Number(status?.points_per_task || 1);
    $('costNote').textContent = state.autoStart
      ? `加入任务会立即提交上游并扣 ${cost} 积分。服务先做只读账号预检；未通过预检时不创建任务、不扣积分。`
      : `取消勾选后只建任务：先冻结 ${cost} 积分、状态停在「排队中」，之后用「提交上游」再发车。`;
  }

  // ─────────────────────────────────────────────────────────── 参考图

  /**
   * 缩略图用的 object URL：挂在 File 上**懒建**（同一张图反复渲染只建一次），
   * 删图/清空时必须 revoke —— 否则 blob 会一直占着内存到刷新为止。
   */
  function thumbUrlOf(file) {
    if (!file._thumbUrl) file._thumbUrl = URL.createObjectURL(file);
    return file._thumbUrl;
  }
  function dropThumb(file) {
    if (file._thumbUrl) { URL.revokeObjectURL(file._thumbUrl); delete file._thumbUrl; }
  }

  /**
   * 「参考图片」框里的一行：缩略图 + 名字 + 体积 + 移除。
   * ★ 缩略图用 `object-fit: contain` —— 完整比例、**不裁切**（2026-09-29 工单 P2）。
   *   原来是纯文件名堆叠，6 张图分不清谁是谁；改成缩略图后一眼能认。
   *
   * ★ 展示名用「图N」而不是真实文件名（2026-09-29 飞哥反馈）：图库取回的图名是
   *   64 位 sha256（`2664ea54…930f.png`），一列排下来既占地方又完全认不出是哪张。
   *   真实文件名**不丢**，挪到悬停提示与 aria-label 里 —— 要看「这到底是哪个文件」
   *   仍然拿得到，只是不再占版面。
   *
   * ⚠️ 序号只是**展示用**，不要拿它当身份：删掉第 2 张后第 3 张会变成「图2」。
   *   提示词里的 `@[…]` 标记因此仍按**文件名**派生（见 mentionLabel / mentionLinks），
   *   那是稳定标识，改成序号会让「删标记同步删图」删错图。
   *
   * @param {File} file
   * @param {Function} onRemove
   * @param {string} label 展示名，由调用方按当前列表顺序给出（如「图1」）
   */
  function refItemNode(file, onRemove, label) {
    const title = label || file.name;
    const item = document.createElement('li');
    item.className = 'ref-item';
    const link = document.createElement('a');
    link.className = 'ref-thumb-link';
    link.href = thumbUrlOf(file);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = `点击查看大图：${title}（${file.name}）`;
    const img = document.createElement('img');
    img.className = 'ref-thumb';
    img.src = thumbUrlOf(file);
    img.alt = title;
    link.appendChild(img);
    const meta = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'ref-item-name';
    name.textContent = title;
    name.title = file.name;      // 真实文件名：悬停可见，不占版面
    const size = document.createElement('span');
    size.className = 'ref-item-size';
    size.textContent = `${(file.size / 1024).toFixed(0)} KB`;
    meta.append(name, size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ref-item-remove';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除 ${title}（${file.name}）`);
    remove.addEventListener('click', onRemove);
    item.append(link, meta, remove);
    return item;
  }

  function renderFiles() {
    if (state.files.length > 9) {
      for (const file of state.files.slice(9)) dropThumb(file);
      state.files = state.files.slice(0, 9);
    }
    const list = $('fileList');
    list.replaceChildren();
    state.files.forEach((file, index) => {
      list.append(refItemNode(file, () => {
        dropThumb(file);
        state.files.splice(index, 1);
        renderFiles();
        renderCapability();
      }, `图${index + 1}`));
    });
  }

  /**
   * 把刚在工作台选中的参考图**顺手收进服务端参考图库**。
   *
   * 为什么要有这一步（2026-09-29 飞哥要求「上传后的图应该直接存到图库去」）：
   * 图库原本只有「手动上传 / 收直链 / 收分镜图」三条入口。运营在工作台选完文件、
   * 提交任务之后，这几张图就随任务走了 —— 下次还想复用，得重新翻本地磁盘找。
   * 自动入库后，图库页与「从参考图库选」立刻能看到同一张图（服务端按 sha256 去重，
   * 同一张图不会因为重复选择而多出记录）。
   *
   * ⚠️ 三条刻意的取舍：
   *   ① **不阻塞选图**：入库在后台跑，界面先照常把图列出来。原图 3MB 一张，
   *      串行等上传会让「选完文件」这个动作愣好几秒 —— 那正是用户抱怨的体感。
   *   ② **失败只提示、不撤销**：本地选中的图仍能正常提交（提交走 multipart，
   *      跟图库无关）。图库只是「顺手存一份资产」，存不进去不该拦住主流程。
   *   ③ **从列表移除 ≠ 从图库删除**：删列表项是「这次不用了」，图库是资产库。
   *      两种语义不能混，提示里要写清楚，否则用户会以为删列表就清了库。
   *
   * @param {File[]} files 真正进入列表的那些（已被 9 张上限裁剪过）
   */
  function stashToLibrary(files) {
    const lib = window.DolaRefLib;
    if (!lib || !files.length) return;
    let pending = files.length;
    let added = 0;
    let reused = 0;
    let failed = 0;
    // 9 张一起失败时逐条报错会刷屏，这里只汇总一句。
    const finish = () => {
      if (--pending > 0) return;
      const parts = [];
      if (added) parts.push(`新收 ${added} 张`);
      if (reused) parts.push(`${reused} 张已在库中`);
      if (failed) parts.push(`${failed} 张失败`);
      if (!parts.length) return;
      if (failed) setError(`参考图同步到图库：${parts.join('，')}。失败的图不影响本次提交。`);
      else showConnection(`已同步到参考图库：${parts.join('，')}（移除列表里的图不会删图库）`, 'good');
    };
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataBase64 = String(reader.result || '').split(',')[1] || '';
        if (!dataBase64) { failed += 1; finish(); return; }
        // 单张上限 8MB（base64 后约 11MB）：默认 30 秒对慢上行不够稳，放宽到 90 秒。
        lib.adminFetch('/api/reference-images', {
          method: 'POST',
          body: { name: file.name, dataBase64 },
          timeoutMs: 90000,
        }).then((res) => { if (res?.duplicated) reused += 1; else added += 1; })
          .catch(() => { failed += 1; })
          .finally(finish);
      };
      reader.onerror = () => { failed += 1; finish(); };
      reader.readAsDataURL(file);
    }
  }

  /** 与 renderFiles 同款，只是作用于批量弹窗自己的 batchFiles / batchFileList。 */
  function renderBatchFiles() {
    if (state.batchFiles.length > 9) {
      for (const file of state.batchFiles.slice(9)) dropThumb(file);
      state.batchFiles = state.batchFiles.slice(0, 9);
    }
    const list = $('batchFileList');
    list.replaceChildren();
    state.batchFiles.forEach((file, index) => {
      list.append(refItemNode(file, () => {
        dropThumb(file);
        state.batchFiles.splice(index, 1);
        renderBatchFiles();
      }, `图${index + 1}`));
    });
  }

  // ─────────────────────────────────────────────── 参考图来源②：服务端参考图库
  /**
   * 除了本机选文件，参考图还能来自**服务端的参考图库**。
   *
   * 为什么要有这条来源：分镜页每出一次图，那 4 张会自动收进图库
   * （见 server/routes/scripts.js 的 ingestBatchToLibrary）。运营真正会复用的
   * 恰恰是这些「已经验证过效果」的图，而它们原来在视频任务页完全够不着。
   *
   * 取回后**还原成 File** 再进 state.files：提交走的是 /v1/videos 的 multipart
   * （input_reference 文件字段），服务端不接受「图库 id」。这样提交路径一行都不用改。
   */
  const libPick = {
    rows: [], total: 0, page: 1, pageSize: 24, keyword: '', selected: new Map(),
    /**
     * 勾选结果落到哪一份参考图列表：'main' = 主工作台 state.files，
     * 'batch' = 批量弹窗 state.batchFiles。由打开它的按钮决定（见两处 click 绑定）。
     * 不做成参数一路传下去，是因为 confirmLibPick 是独立的 click 处理器，拿不到上下文。
     */
    target: 'main',
  };
  /** 图库上限按「目标列表里已有的 + 本次勾的」一起算，避免加入时才被服务端拒绝。 */
  function libPickTargetFiles() {
    return isBatchTarget(libPick.target) ? state.batchFiles : state.files;
  }
  /**
   * 落点是不是「批量弹窗那一份」。
   * 'batch' = 弹窗里的「从参考图库选」；'mention-batch' = 在**批量提示词框**里打 @ 触发。
   * 两者最终都落在 state.batchFiles，区别只在于要不要往提示词里插 @ 标记。
   */
  function isBatchTarget(target = libPick.target) {
    return target === 'batch' || target === 'mention-batch';
  }
  /** 落点是不是「要插 @ 标记的 @ 引用」。 */
  function isMentionTarget(target = libPick.target) {
    return target === 'mention' || target === 'mention-batch';
  }

  function renderLibPickSelected() {
    const box = $('libPickSelected');
    box.replaceChildren();
    const head = document.createElement('span');
    head.textContent = `已选 ${libPick.selected.size} 张（提交时会一并带上）`;
    box.appendChild(head);
    for (const [id, row] of libPick.selected) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const text = document.createElement('span');
      text.textContent = row.name || `图库 #${id}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.setAttribute('aria-label', `移除 ${row.name || id}`);
      del.addEventListener('click', () => {
        libPick.selected.delete(id);
        renderLibPickGrid();
        renderLibPickSelected();
      });
      chip.append(text, del);
      box.appendChild(chip);
    }
  }

  function renderLibPickGrid() {
    const box = $('libPickBody');
    box.replaceChildren();
    $('libPickCount').textContent = libPick.total ? `共 ${libPick.total} 张` : '';
    if (!libPick.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '图库里没有匹配的图。分镜页出的图会自动收进图库，也可以到后台「参考图库」页上传。';
      box.appendChild(empty);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'ref-grid';
    for (const row of libPick.rows) {
      const label = document.createElement('label');
      label.className = `ref-pick${libPick.selected.has(row.id) ? ' on' : ''}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = libPick.selected.has(row.id);
      cb.addEventListener('change', () => {
        if (libPick.selected.has(row.id)) {
          libPick.selected.delete(row.id);
        } else {
          // 上限按「目标列表里已有的 + 本次勾的」一起算 —— 批量弹窗打开时看 batchFiles，不是主工作台的 files
          if (libPickTargetFiles().length + libPick.selected.size >= 9) {
            cb.checked = false;
            setError('参考图片最多 9 张，超出的未加入。');
            return;
          }
          libPick.selected.set(row.id, row);
        }
        label.classList.toggle('on', libPick.selected.has(row.id));
        renderLibPickSelected();
      });
      const img = document.createElement('img');
      img.src = DolaRefLib.src(row);
      img.alt = row.name || `参考图 #${row.id}`;
      img.loading = 'lazy';
      const name = document.createElement('span');
      name.className = 'ref-name';
      name.textContent = `${row.name || `#${row.id}`}${row.width ? ` · ${row.width}×${row.height}` : ''}`;
      label.append(cb, img, name);
      grid.appendChild(label);
    }
    box.appendChild(grid);
  }

  async function loadLibPick(page = libPick.page) {
    libPick.page = page;
    $('libPickError').textContent = '';
    try {
      const res = await DolaRefLib.list({ keyword: libPick.keyword, page, pageSize: libPick.pageSize });
      libPick.rows = res.items || [];
      libPick.total = Number(res.total) || 0;
      renderLibPickGrid();
      renderLibPickSelected();
    } catch (error) {
      $('libPickError').textContent = error.status === 403
        ? '没有查看参考图库的权限（refimage:list）。请让管理员到「角色权限」里勾选。'
        : error.message;
      libPick.rows = [];
      libPick.total = 0;
      renderLibPickGrid();
    }
  }

  async function openLibPick(target = 'main') {
    libPick.target = target;
    // @ 触发的位置只对本次 mention 会话有效；走普通入口时必须清掉，
    // 否则残留的位置会把标记插到无关的旧光标处。
    if (!isMentionTarget(target)) mentionCaret = -1;
    libPick.selected = new Map();
    libPick.keyword = '';
    libPick.page = 1;
    $('libPickSearch').value = '';
    $('libPickNote').textContent = isMentionTarget(libPick.target)
      ? `勾选的图会加入${isBatchTarget() ? '批量弹窗' : '下方'}参考图列表（与「从参考图库选」同一份、自动去重），并在${isBatchTarget() ? '批量提示词' : '提示词'}里插入 @[图片名] 标记。标记只在本地展示，提交时会被剥掉、不会发给上游。当前 ${libPickTargetFiles().length} 张，合计上限 9 张。`
      : isBatchTarget(libPick.target)
        ? `图库里的图存在服务端（不是这台浏览器）。勾选的图会加进「批量创建」的参考图，本批每条任务都带同一组。当前已选 ${state.batchFiles.length} 张，合计上限 9 张。`
        : `图库里的图存在服务端（不是这台浏览器），分镜页出的图会自动收进去。当前已选 ${state.files.length} 张本机参考图，合计上限 9 张。`;
    renderLibPickSelected();
    openDialog('libPickDlg');
    await loadLibPick(1);
  }

  /** 把勾选的图取回本地并加进待提交的参考图列表。逐张独立成败，一张失败不影响其余。 */
  async function confirmLibPick() {
    const picks = [...libPick.selected.values()];
    if (!picks.length) { $('libPickError').textContent = '还没有勾选任何图。'; return; }
    $('libPickError').textContent = '';
    // 落点由打开选择器的按钮决定：主工作台的 files，或批量弹窗的 batchFiles。
    const targetFiles = libPickTargetFiles();
    const isBatch = isBatchTarget();
    // @ 引用落点：主提示词框写 mentionLinks + state.files，
    // 批量提示词框写 batchMentionLinks + state.batchFiles。两套互不干扰。
    const isMention = isMentionTarget();
    const links = isBatch ? batchMentionLinks : mentionLinks;
    const area = isBatch ? $('batchPrompts') : $('prompt');
    let added = 0;
    const problems = [];
    /**
     * 本次真正落到列表里的图：`{ row, file }`。
     * ⚠️ 必须收集**实际那个 file**，不能用 picks 反推 —— 重复选同一张时走的是
     * 「已存在就跳过」分支，列表里留着的是**旧的那个** File 对象；@ 引用要靠它
     * 把标记绑到正确的图上（见下面 mentionLinks，P3：删标记要能删对图）。
     */
    const picked = [];
    for (const row of picks) {
      try {
        const blob = await DolaRefLib.fetchBlob(row);
        const ext = row.mime === 'image/jpeg' ? 'jpg' : 'png';
        const name = `${(row.name || `ref-${row.id}`).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60)}.${ext}`;
        const file = new File([blob], name, { type: row.mime || 'image/png' });
        const existing = targetFiles.find((f) => f.name === file.name && f.size === file.size);
        if (existing) { picked.push({ row, file: existing }); continue; }
        if (targetFiles.length >= 9) { problems.push(`已满 9 张，${name} 未加入`); break; }
        targetFiles.push(file);
        picked.push({ row, file });
        added += 1;
      } catch (error) {
        problems.push(`${row.name || `#${row.id}`}：${error.message}`);
      }
    }
    if (isBatch) renderBatchFiles();
    else { renderFiles(); renderCapability(); }
    if (isMention && mentionCaret >= 0) {
      // @ 引用：把触发选择器的那个裸 @ 换成 @[名称]。重复选同一张（去重跳过、没真加）
      // 也要插标记 —— 用户看到标记才知道「这图已经在列表里了」，不然像没点上。
      const text = area.value;
      const insert = picked.map(({ row }) => `@[${mentionLabel(row.name)}]`).join(' ');
      area.value = text.slice(0, mentionCaret) + insert + text.slice(mentionCaret + 1);
      const caret = mentionCaret + insert.length;
      area.focus();
      area.setSelectionRange(caret, caret);
      mentionCaret = -1;
      // ★ 标记 ↔ 图片 绑定（工单 P3）：之后用户把标记删掉，图要跟着走，
      //   不能留成「提示词里没了、提交时图还在」的幽灵图。
      for (const { row, file } of picked) links.set(`@[${mentionLabel(row.name)}]`, file);
    }
    closeDialog('libPickDlg');
    if (problems.length) setError(`从图库加入 ${added} 张，${problems.length} 张失败：${problems.join('；')}`);
    else showConnection(`已从参考图库加入 ${added} 张${isMention ? '（@ 引用）' : isBatch ? '（批量创建用）' : ''}`, 'good');
  }

  // ─────────────────────────────────────────────────────────── 当前任务面板

  function renderProgress(job) {
    const percent = job ? (STAGE_PROGRESS[job.status] ?? 0) : 0;
    $('progressBar').style.width = `${percent}%`;
    const note = !job ? '阶段进度按状态估算，不是上游回报的百分比 —— 本服务不保留上游的逐条进度事件。'
      : job.status === 'ready' ? '已完成。上游逐条进度事件本服务不保留，这里的百分比是按状态估算的。'
        : job.status === 'failed' ? '任务已失败并进入终态。'
          : job.status === 'cancelled' ? '任务已取消并进入终态。'
            : `阶段进度 ${percent}%（按状态估算，不是上游回报的百分比）。`;
    $('progressNote').textContent = note;
  }

  function renderMeta(job) {
    const dl = $('taskMeta');
    dl.replaceChildren();
    if (!job) {
      for (const [key, value] of [['提示词', '—'], ['模型与时长', '—'], ['画幅', '—'], ['成片', '—']]) {
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dl.append(dt, dd);
      }
      return;
    }
    const seconds = Number(job.seconds || 0);
    const inferredModel = job.model
      || (seconds === 15 ? 'seedance_v2.0' : (seconds === 20 || seconds === 30) ? 'seedance_v2.5' : '未记录');
    let output = '尚未产出';
    if (job.status === 'ready') {
      output = job.archived
        ? `已归档到本机（${job.bytes ? `${(job.bytes / 1048576).toFixed(1)} MB` : '大小未知'}）`
        : '仅上游临时直链，会过期';
      if (job.duration_sec) output += ` · 成片 ${job.duration_sec} 秒`;
    } else if (job.status === 'failed') output = '失败，无成片';
    else if (job.status === 'cancelled') output = '已取消，无成片';
    const rows = [
      ['提示词', job.prompt || '—'],
      ['模型与时长', `${inferredModel} · ${job.seconds || '—'} 秒`],
      ['画幅', job.ratio || '—'],
      ['成片', output],
      ['流水', `创建 ${job.created_at || '—'}${job.finished_at ? ` · 完成 ${job.finished_at}` : ''}`],
    ];
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
  }

  // ─────────────────────────────────────────────────────── 参考图（任务详情）

  /**
   * 上一次为哪条任务拉过「参考图」。图在任务创建时就定下了，中途不会变多，
   * 所以同一条任务只拉一次 —— 否则常驻轮询会每几秒就重打一次接口。
   * 换任务、或用户点「立即刷新」时才重拉。
   */
  let refImagesTaskId = '';

  function hideReferenceImages() {
    const box = $('refImages');
    if (!box) return;
    box.classList.add('hidden');
    $('refGrid').replaceChildren();
    $('refNote').textContent = '';
  }

  function fileSizeText(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '大小未知';
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  /**
   * 渲染「这条任务带了哪些参考图」。
   *
   * 三种状态要分清，别混成一句「暂无」：
   *   · 有图      → 缩略图网格（点开看原图）
   *   · 已清理    → 明确写「暂存文件已清理」，并说明保留规则（失败留 24 小时，成功/取消即时清）
   *   · 本来没带图 → 整块隐藏，不占地方
   */
  async function renderReferenceImages(job) {
    if (!job || !job.id || !state.token) { hideReferenceImages(); return; }
    const id = String(job.id);
    if (refImagesTaskId === id) return;
    refImagesTaskId = id;
    hideReferenceImages();
    let data;
    try {
      data = await requestJson(`/v1/videos/${id}/reference-images`);
    } catch {
      // 附加信息读不到不该打扰用户：保持隐藏，下次刷新再试。
      refImagesTaskId = '';
      return;
    }
    // 期间用户切到了别的任务 → 丢弃这次结果，别把 A 的图贴到 B 上。
    if (String(state.currentId) !== id) return;
    const items = Array.isArray(data?.items) ? data.items : [];
    const recorded = Number(data?.recorded_count || 0);
    if (!items.length && !data?.cleared) { hideReferenceImages(); return; }

    $('refImages').classList.remove('hidden');
    $('refGrid').replaceChildren();
    for (const item of items) {
      const a = document.createElement('a');
      a.className = 'ref-panel-thumb';   // 与工作台行的 `.ref-thumb`(56px) 区分，勿合并
      a.href = item.url;              // 点开看**原图**（带票据的直链，10 分钟内有效）
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = `${item.name}（${fileSizeText(item.size)}）`;
      const img = document.createElement('img');
      // 缩略图（服务端按 ?w= 现生成并缓存）：原图 4MB 一张，5 张直接铺 = 打开面板拉 20MB。
      // 老版本服务端没有 thumb_url，回退到原图地址，功能不至于整个空掉。
      img.src = item.thumb_url || item.url;
      img.alt = item.name;
      img.loading = 'lazy';
      a.append(img);
      $('refGrid').append(a);
    }
    if (items.length) {
      $('refNote').textContent = `${items.length} 张 · 点缩略图看原图（图片地址 10 分钟内有效）`;
    } else {
      const p = document.createElement('p');
      p.className = 'ref-missing';
      p.textContent = `提交时带了 ${recorded || '若干'} 张参考图，但暂存文件已清理。`
        + '参考图是暂存的：失败任务保留 24 小时，已完成/已取消的任务会即时清掉。';
      $('refGrid').append(p);
      $('refNote').textContent = '已清理';
    }
  }

  function renderJob(job) {
    if (!job) { renderEmptyJob(); return; }
    // 「无水印预览」的可见性靠这一份详情（列表项不带 unwatermarked_url，见 state.currentJob）。
    state.currentJob = job;
    state.currentId = String(job.id || state.currentId || '');
    $('taskId').textContent = state.currentId ? `任务 #${state.currentId}` : '暂无任务';
    $('taskStatus').textContent = displayStatus(job.status);
    $('taskStage').textContent = job.stage || '';
    renderProgress(job);
    renderMeta(job);
    void renderReferenceImages(job);
    if (job.status === 'ready' && !state.loaded[state.currentId]) {
      state.loaded[state.currentId] = true;
      loadContent(job).catch(() => { /* 播放/下载失败不阻塞状态展示，错误已进 error box */ });
    }
    if (job.error) setError(job.error);
    else clearError();
    $('rawJson').textContent = JSON.stringify(job, null, 2);
    // 轮询不再由「这一条是不是活跃」来开关（那样列表里其它任务就永远不更新了）。
    // 列表轮询是一个常驻循环，自己按「有没有活干」决定 4 秒还是 20 秒。这里只保证它还活着。
    ensurePolling();
    syncButtons();
  }

  function renderEmptyJob(message = '暂无任务') {
    state.currentJob = null;
    state.currentId = '';
    $('taskId').textContent = message;
    $('taskStatus').textContent = '输入用户令牌并连接后即可使用';
    $('taskStage').textContent = '';
    renderProgress(null);
    renderMeta(null);
    refImagesTaskId = '';
    hideReferenceImages();
    $('rawJson').textContent = '连接后可读取你自己的任务数据。';
    $('player').hidden = true;
    $('player').removeAttribute('src');
    $('download').classList.add('hidden');
    clearError();
    syncButtons();
  }

  /**
   * 按钮的可用性集中算一处，避免散落在各个 handler 里各说各话。
   * 所有「受管按钮」都必须在这里出现 —— 否则 withBusy 收尾把 disabled 交回这里时，
   * 漏掉的按钮会停在「上一次被谁改过」的状态上。
   */
  /**
   * 受管按钮是否正被 withBusy 占着（忙碌中）。
   *
   * ⚠️⚠️ 为什么 syncButtons() 必须看这个标记：
   *   withBusy() 的工作方式是「先把按钮置忙（disabled=true + 文案改『提交中…』），
   *   干完再交回 syncButtons() 重算」。但忙碌期间只要有任何一次
   *   renderJobs() / renderStatus() / refreshJobs()，都会走到本函数 ——
   *   而本函数原本是**无条件** `disabled = !connected`，等于把忙碌态当场抹掉。
   *
   *   实测后果（2026-09-28 复现）：点「加入任务」后 POST 还没回来，
   *   按钮已经恢复可点，只是文案还写着「提交中…」。用户以为卡住了就会再点一次，
   *   于是**建两条任务、扣两次积分，而且两条都会真的发上游**。
   *
   *   触发链路很短：createTask() → addPendingJob() → renderJobs() → syncButtons()。
   *   所以这不是理论风险，是「只要点一次提交就必然发生」。
   *
   * ── 2026-09-28 修订：`create` 是**唯一豁免**这个忙碌态按钮 ──────────────────
   *   产品要求（用户原话）：「右边提交中就行了，左边可以继续提交」。
   *   也就是说，提交中的反馈由「我的任务」里的占位行承担，左侧按钮不该被锁住 ——
   *   用户可以连着建下一条，不必等上一条回包。所以 `create` 在 syncButtons()
   *   里**不**参与 isBusy 判断，createTask() 也不用 withBusy（见那里的注释）。
   *   重复提交同一条提示词不会双扣：网关有 PROMPT_COOLDOWN 排重，第二次被 409
   *   挡下且「未创建任务，也未扣积分」（见 routes/gateway.js 的 reservePrompt）。
   */
  const isBusy = (id) => $(id)?.dataset.busy === '1';

  function syncButtons() {
    const job = state.jobs.find((item) => String(item.id) === state.currentId) || null;
    const status = job?.status || '';
    const connected = Boolean(state.token && state.status);
    $('pullModels').disabled = isBusy('pullModels') || !state.token || state.models.length === 0;
    // ⚠️ create 故意**不看** isBusy：提交中也要保持可点，让用户能连着建下一条。
    //    进度反馈在「我的任务」的占位行里（见 addPendingJob / ensurePendingTicker）。
    $('create').disabled = !connected;
    $('batchCreate').disabled = isBusy('batchCreate') || !connected;
    $('refreshJobs').disabled = isBusy('refreshJobs') || !state.token;
    $('refreshCurrent').disabled = isBusy('refreshCurrent') || !state.currentId;
    $('clearCurrent').disabled = isBusy('clearCurrent') || !state.currentId;
    $('cancelCurrent').classList.toggle('hidden', !ACTIVE.has(status));
    $('download').classList.toggle('hidden', status !== 'ready');
    // 无水印预览：可见性不看 status，看后端到底给没给「无水印」这一版（见该函数注释）。
    syncUnwatermarkedButton();
    const queued = state.jobs.filter((item) => item.status === 'queued').length;
    $('startQueued').disabled = isBusy('startQueued') || !state.token || queued === 0;
    $('clearJobs').disabled = isBusy('clearJobs') || !state.token || state.jobs.length === 0;
    // 兑换只需要「有令牌」——余额为 0 恰恰是最该能兑换的状态，不能拿余额当门槛。
    $('redeemBtn').disabled = isBusy('redeemBtn') || !state.token;
    // 测连通同档：打的是需要令牌的 /v1/status，未连令牌时点了必然报错，不该让它可点。
    // 必须在这里收口 —— withBusy 结束时把 disabled 交回本函数重算，漏掉就会停在「上一次被谁改过」的状态。
    $('ping').disabled = isBusy('ping') || !state.token;
    $('logoutBtn').classList.toggle('hidden', !state.token);
    $('jobsCount').textContent = (state.jobs.length + state.pendingJobs.length)
      ? `${state.jobs.length} 条 · ${queued} 条待提交`
        + (state.pendingJobs.length ? ` · ${state.pendingJobs.length} 条创建中` : '')
      : '尚未加载';
  }

  // ─────────────────────────────────────────────────────────── 任务列表

  /** 服务端只接受 queued（见文件头）。 */
  function canStart(job) {
    return job.status === 'queued';
  }

  // ── 乐观占位（2026-09-27 任务列表实时化）─────────────────────────────

  /** 还没落库的占位行：status 固定 'submitting'，没有真实任务号。 */
  const isPendingJob = (job) => Boolean(job && job.__pending);

  /** 渲染用：占位排最前（它们最新），后面才是服务端返回的任务。 */
  function visibleJobs() {
    return state.pendingJobs.length ? [...state.pendingJobs, ...state.jobs] : state.jobs;
  }

  /**
   * 插一条占位，返回它的临时 id（回包后靠这个 id 撤掉它）。
   * prompt / seconds 也存下来：万一轮询比 POST 回包更早看到真实任务，
   * 可以按这两个字段把占位认领掉（见 refreshJobs）。
   */
  function addPendingJob({ prompt, seconds }) {
    const id = `pending-${++state.pendingSeq}`;
    state.pendingJobs = [{
      id, __pending: true, status: 'submitting', stage: '正在创建任务…',
      prompt, seconds, error: '', startedAt: Date.now(),
    }, ...state.pendingJobs];
    persistPendingJobs();   // ★ 落盘**先于**发请求：刷新发生在 POST 在途时也能接回来
    renderJobs();
    ensurePolling();
    return id;
  }

  /** 撤占位。render:false 用于「紧接着要插真实行」的场合 —— 让两次变更合成一次渲染。 */
  function dropPendingJob(id, { render = true } = {}) {
    const next = state.pendingJobs.filter((job) => job.id !== id);
    if (next.length === state.pendingJobs.length) return;
    state.pendingJobs = next;
    persistPendingJobs();   // ★ 撤掉就要同步擦盘，否则下次刷新会「复活」这条幽灵行
    if (render) renderJobs();
  }

  // ── 占位行的「还活着」反馈 ──────────────────────────────────────────────
  //
  // 提交到上游可能要几十秒。如果这一行从头到尾都是同一句静止的灰字，
  // 用户的判断只能是「卡死了」—— 这正是用户反馈的原话。
  // 所以占位行要有两件事：① 秒数每秒在跳（证明进程在跑）；② 有呼吸动效（CSS）。
  //
  // 秒数**故意不进 jobsFingerprint**：进了指纹就会每秒触发一次 tbody 重建，
  // 用户悬停行内按钮时会一直闪（见 renderJobs 的指纹注释）。
  // 这里改为定点改那一个单元格的文本，不动 DOM 结构。

  /** 占位行的阶段文案，带已经等了多少秒。 */
  function pendingStageText(job) {
    const secs = Math.max(0, Math.round((Date.now() - (job.startedAt || Date.now())) / 1000));
    return `${job.stage}（已等待 ${secs} 秒）`;
  }

  function stopPendingTicker() {
    if (state.pendingTicker) clearInterval(state.pendingTicker);
    state.pendingTicker = null;
  }

  /** 幂等：有占位就跑 1 秒一跳的秒表，没有就停掉。 */
  function ensurePendingTicker() {
    if (!state.pendingJobs.length) { stopPendingTicker(); return; }
    if (state.pendingTicker) return;
    state.pendingTicker = setInterval(() => {
      if (!state.pendingJobs.length) { stopPendingTicker(); return; }

      // 孤儿判定：等太久了说明这次提交在刷新时被浏览器中止了（POST 在途被 cancel），
      // 服务端根本没建任务。继续挂着「提交中」就是在骗人 —— 撤掉并让用户去核对。
      const now = Date.now();
      const expired = state.pendingJobs.filter((job) => now - (job.startedAt || now) > PENDING_ORPHAN_MS);
      if (expired.length) {
        for (const job of expired) dropPendingJob(job.id, { render: false });
        renderJobs();
        setError(`有 ${expired.length} 条提交长时间未被确认（多半是刷新时把请求中断了）。`
          + '请点「刷新列表」核对这几条任务是否其实已经创建。');
        return;
      }

      for (const pending of state.pendingJobs) {
        // 只改文本，不重建行 —— 重建会打断用户的悬停/点击。
        const cell = document.querySelector(`#jobRows tr[data-id="${pending.id}"] .stage-cell`);
        if (cell) cell.textContent = pendingStageText(pending);
      }
    }, 1000);
  }

  function rowActions(job) {
    // 占位行没有真实任务号，任何操作都无从下手（点下去必然 404）。
    if (isPendingJob(job)) return [];
    const cells = [];
    if (canStart(job)) cells.push(['start', '提交上游', 'primary', '把这个已冻结积分的排队任务提交到上游']);
    if (ACTIVE.has(job.status)) cells.push(['cancel', '取消', '', '取消任务。已提交到上游的不退款']);
    // ★ 2026-09-29：失败任务给一条「重新提交」。失败是终态、不能原地重启，用户唯一的
    //   出路是重填一遍表单 —— 而#214/#215/#217 那批失败任务每次都要重打提示词 + 重选 6 张图。
    //   这个按钮把参数（含服务端暂存的参考图）回填进新建表单，用户改完再走正常确认框。
    //   只对 failed 显示：成功的不需要重提，进行中的更不该让用户重复下单。
    if (job.status === 'failed') {
      cells.push(['resubmit', '重新提交', '', '把这条失败任务的提示词/时长/画幅和参考图回填到上方新建表单，可改参数后再提交（会新建一单）']);
    }
    cells.push(['status', '获取状态', '', '读取这条任务的最新状态并切到「当前任务」']);
    cells.push(['clear', '清除', '', '取消这条任务并打软删除标记（列表里不再出现，计费/退款凭据保留在服务端）']);
    return cells;
  }

  /**
   * 客户端筛选：只筛「已经拉到本页」的那些任务，不假装是全量搜索。
   * 服务端 /v1/videos 没有 q 参数，加一个服务端搜索等于给接口开一个新的分页维度，
   * 而这里要解决的只是「20 条里找那一条」。
   */
  function filteredJobs() {
    const jobs = visibleJobs();
    const needle = state.jobFilter.trim().toLowerCase();
    if (!needle) return jobs;
    return jobs.filter((job) => [
      job.id, displayStatus(job.status), job.status, job.stage, job.prompt, job.error,
      job.seconds ? `${job.seconds}秒` : '',
    ].some((field) => String(field ?? '').toLowerCase().includes(needle)));
  }

  /**
   * 列表内容指纹。轮询现在是 4 秒一次，如果每次都把 tbody 清空重建，
   * 用户悬停/点击行内按钮时会持续闪——内容没变就别重绘。
   * currentId 与筛选词都算进去：它们变了要高亮行/换行集合，但字段本身不会变。
   */
  function jobsFingerprint() {
    return [
      state.currentId,
      state.jobFilter,
      ...visibleJobs().map((job) => [
        job.id, job.status, job.stage || '', job.error || '',
        job.seconds || '', job.prompt || '',
      ].join('\u0001')),
    ].join('\u0002');
  }

  function renderJobs() {
    const body = $('jobRows');
    // 占位行在不在，决定秒表要不要跑。放在指纹判断之前 ——
    // 指纹没变就 early-return，不能让秒表因此漏启/漏停。
    ensurePendingTicker();
    const fingerprint = jobsFingerprint();
    if (fingerprint === state.jobsFingerprint) { syncButtons(); return; }
    state.jobsFingerprint = fingerprint;

    const all = visibleJobs();
    const rows = filteredJobs();
    body.replaceChildren();
    if (!rows.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 7;
      cell.className = 'empty';
      cell.textContent = !state.token ? '连接令牌后加载任务。'
        : all.length ? `没有匹配「${state.jobFilter}」的任务（本页共 ${all.length} 条）。`
          : '当前令牌下没有任务。';
      syncButtons();
      return;
    }
    for (const job of rows) {
      const pending = isPendingJob(job);
      const row = body.insertRow();
      row.dataset.id = String(job.id);
      // 占位行不给 data-act 按钮，所以行内点击委托天然忽略它；这里只加个视觉标记。
      if (pending) row.className = 'pending-row';
      if (!pending && String(job.id) === state.currentId) row.style.fontWeight = '650';
      const idCell = row.insertCell();
      idCell.className = 'job-id';
      idCell.textContent = pending ? '—' : `#${job.id}`;
      const statusCell = row.insertCell();
      const tag = document.createElement('span');
      tag.className = `tag ${job.status === 'ready' ? 'ready' : job.status === 'failed' ? 'failed' : ACTIVE.has(job.status) ? 'running' : ''}`;
      tag.textContent = displayStatus(job.status);
      statusCell.append(tag);
      const stageCell = row.insertCell();
      stageCell.className = 'stage-cell';
      stageCell.title = job.stage || '';
      // 占位行带上「已等待 N 秒」，并由秒表持续刷新 —— 静止的一行会让用户以为卡死。
      stageCell.textContent = pending ? pendingStageText(job) : (job.stage || '—');
      row.insertCell().textContent = job.seconds ? `${job.seconds} 秒` : '—';
      const promptCell = row.insertCell();
      promptCell.className = 'prompt-cell';
      promptCell.title = job.prompt || '';
      promptCell.textContent = job.prompt || '—';
      const errCell = row.insertCell();
      errCell.className = 'err';
      errCell.title = job.error || '';
      errCell.textContent = job.error || '';
      const ops = row.insertCell();
      ops.className = 'ops';
      if (pending) {
        const note = document.createElement('span');
        note.className = 'hint';
        note.textContent = '提交中…';
        ops.append(note);
        continue;
      }
      for (const [act, label, extra, hint] of rowActions(job)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `row-btn ${extra}`.trim();
        button.dataset.act = act;
        button.dataset.id = String(job.id);
        button.textContent = label;
        button.title = hint;
        ops.append(button);
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        const note = document.createElement('span');
        note.className = 'hint';
        // 失败行现在另有「重新提交」按钮，提示要跟着改 —— 否则同一行上
        // 「（终态不可重启）」和「重新提交」会互相打架，用户不知道该信哪个。
        if (job.status === 'failed') {
          note.title = '本服务只允许启动「排队中」的任务；失败是终态，不能原地重启。「重新提交」会带着这条任务的参数新建一单。';
          note.textContent = '（终态不可重启，可重新提交）';
        } else {
          note.title = '本服务只允许启动「排队中」的任务；已取消是终态，需要重新建一条。';
          note.textContent = '（终态不可重启）';
        }
        ops.append(note);
      }
    }
    syncButtons();
  }

  function upsertJob(job) {
    const jobs = state.jobs.slice();
    const index = jobs.findIndex((item) => String(item.id) === String(job.id));
    if (index >= 0) jobs[index] = { ...jobs[index], ...job };
    else jobs.unshift(job);
    state.jobs = jobs;
    // 始终重绘（原来只在「任务列表」页签才画）：占位换成真实行必须在同一次渲染里完成，
    // 否则会闪出「占位行 + 真实行」并排的一帧。有指纹兜底，内容没变时这里是空操作。
    renderJobs();
    ensurePolling();
  }

  // ─────────────────────────────────────────────────────────── 会话生命周期

  function clearSessionData() {
    // 「当前任务」置空期间挂起落盘 —— 本函数在 auto-reconnect 路径上也会被调到，
    // 那一刻置空会把「刷新前停在哪条」抹掉。见 suspendCurrentIdPersist 的注释。
    suspendCurrentIdPersist = true;
    state.epoch++;
    stopPolling();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = '';
    // 无水印预览的弹窗也要收：换令牌/退出时它还开着的话，里面播的是上一个人的成片。
    closeDialog('uwDlg');   // 关掉会走 close 事件里的 teardown，把 <video> 的源也断掉
    if (state.uwObjectUrl) URL.revokeObjectURL(state.uwObjectUrl);
    state.uwObjectUrl = '';
    state.uwKind = '';
    state.currentJob = null;
    state.status = null;
    state.models = [];
    state.files = [];
    state.jobs = [];
    state.pendingJobs = [];
    stopPendingTicker();          // 占位没了，秒表也要停，否则会空转
    // ⚠️ 这里**故意不动** sessionStorage 里的占位记录：本函数在页面加载时的
    //    auto-reconnect 路径上也会被调到（那时 state.token 还是空的），
    //    顺手擦盘会把「刷新前那一份」在 restorePendingJobs() 读到之前就抹掉。
    //    真正该擦的地方只有两处：logout()、以及 connect() 里「确实换过令牌」时。
    state.jobsFingerprint = '';   // 列表被清空，缓存指纹也要作废，否则清空后不会重绘
    state.currentId = '';
    state.loaded = {};
    $('images').value = '';
    renderFiles();
    $('model').replaceChildren(new Option('连接令牌后加载', ''));
    $('model').disabled = true;
    $('pullModels').disabled = true;
    $('seconds').replaceChildren();
    $('seconds').disabled = true;
    $('batchSeconds').replaceChildren();
    $('batchSeconds').disabled = true;
    $('batchResults').replaceChildren();
    $('batchBar').style.width = '0%';
    setBatchError('');
    setRedeemResult('');
    $('create').disabled = true;
    $('batchCreate').disabled = true;
    $('refreshJobs').disabled = true;
    $('refreshCurrent').disabled = true;
    $('clearCurrent').disabled = true;
    // 这里必须显式禁掉 ping：本函数末尾的 renderEmptyJob() 会调 syncButtons()，
    // 而 logout() 是先 clearSessionData() 再清 state.token —— 那一刻令牌还是旧的，
    // syncButtons() 会把它算成「可点」。create/batchCreate/refreshJobs 也是因为同一个
    // 原因才在上面逐个写死，别以为 syncButtons() 兜得住。
    $('ping').disabled = true;
    $('cancelCurrent').classList.add('hidden');
    $('download').classList.add('hidden');
    renderStats();
    $('capability').className = 'capability';
    $('capability').textContent = '连接后显示令牌余额、时长能力与参考图就绪情况。';
    $('jobsCount').textContent = '尚未加载';
    renderTopBalance();
    renderEmptyJob();
    renderJobs();
    renderCostNote();
    suspendCurrentIdPersist = false;   // 收尾必须复位，否则后面所有选中都不落盘
  }

  /**
   * 退出：断开当前令牌并清空页面上的数据。
   *
   * ⚠️ 这只是**本页**的退出，不是服务端会话失效 —— /v1 是无状态 Bearer 鉴权，
   *    没有「登出接口」这种东西。所以按钮的提示语必须说清楚「服务端任务与积分不受影响」，
   *    否则用户会以为退出等于注销。
   */
  function logout() {
    persistToken('');
    clearPendingStore();   // 退出就把「提交中」待确认一起擦掉，别让下一个人接回来
    storageRemove(CURRENT_ID_KEY);   // 「当前任务」同理：这是上一个人看的位置
    clearSessionData();
    state.token = '';
    $('apiKey').value = '';
    $('rememberToken').checked = false;
    showConnection('已退出。令牌已从本页清除', '');
    closeDialog('redeemDlg');
    closeDialog('batchDlg');
    syncButtons();
  }

  // ─────────────────────────────────────────────────────────── 读

  async function refreshStatus(epoch = state.epoch) {
    const status = await requestJson('/v1/status');
    if (epoch !== state.epoch) return null;
    state.status = status;
    renderStats();
    renderCapability();
    renderCostNote();
    renderTopBalance();
    renderBatchCost();
    return status;
  }

  /** 测连通：打的是需要令牌的 /v1/status（见文件头差异①）。 */
  async function ping() {
    const status = await refreshStatus();
    if (!status) return null;
    const generation = status.generation || {};
    showConnection(
      `服务在线 · 余额 ${fmtInt(status.token?.points ?? 0)} · 运行 ${generation.running || 0}/${generation.concurrency || 0} · 排队 ${generation.queued || 0}`,
      Number(status.token?.points || 0) > 0 ? 'good' : '',
    );
    return status;
  }

  async function refreshJobs() {
    const epoch = state.epoch;
    const limit = Math.min(Math.max(Number(state.jobLimit) || 20, 1), 100);
    const result = await requestJson(`/v1/videos?limit=${limit}`);
    if (epoch !== state.epoch) return [];
    const previousIds = new Set(state.jobs.map((job) => String(job.id)));
    state.jobs = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
    // 占位认领：轮询有可能比 POST 回包更早看到这条真实任务（两个请求是并发的）。
    // 这时按「提示词 + 时长」把占位撤掉，免得列表里占位行和真实行并排出现。
    // 只认本次新冒出来的任务，避免和历史同提示词的任务撞车。
    if (state.pendingJobs.length) {
      const fresh = state.jobs.filter((job) => !previousIds.has(String(job.id)));
      const claimed = new Set();
      for (const pending of state.pendingJobs) {
        const hit = fresh.some((job) => job.prompt === pending.prompt
          && String(job.seconds ?? '') === String(pending.seconds ?? ''));
        if (hit) claimed.add(pending.id);
      }
      if (claimed.size) {
        state.pendingJobs = state.pendingJobs.filter((job) => !claimed.has(job.id));
        persistPendingJobs();   // ★ 认领掉了就要擦盘，否则下次刷新会「复活」这条幽灵行
      }
    }
    renderJobs();
    return state.jobs;
  }

  async function loadJob(id, { select = false } = {}) {
    if (!id) return null;
    const epoch = state.epoch;
    const job = await requestJson(`/v1/videos/${encodeURIComponent(id)}`, { timeoutMs: 120000 });
    if (epoch !== state.epoch) return null;
    if (select || !state.currentId) state.currentId = String(job?.id || id);
    if (job?.id) upsertJob(job);
    if (String(job?.id) === state.currentId) renderJob(job);
    return job;
  }

  async function loadContent(job) {
    const id = String(job?.id || '');
    if (!id) return;
    // /content 是 302 到现签票据地址；fetch 默认跟随重定向，最终拿到视频字节。
    const response = await fetchResponse(`/v1/videos/${encodeURIComponent(id)}/content`, { timeoutMs: 300000 });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw toError(payload, response);
    }
    const blob = await response.blob();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    const objectUrl = URL.createObjectURL(blob);
    state.objectUrl = objectUrl;
    const player = $('player');
    player.src = objectUrl;
    player.hidden = false;
    const link = $('download');
    link.href = objectUrl;
    link.download = `video-${id}.mp4`;
    link.classList.remove('hidden');
  }

  // ─────────────────────────────────────────────────────────── 轮询

  /** 「有没有活干」——决定轮询跑 4 秒档还是 20 秒档。本地占位也算：那几秒服务端正在建任务。 */
  function hasLiveWork() {
    return state.pendingJobs.length > 0 || state.jobs.some((job) => ACTIVE.has(job.status));
  }

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  /** 幂等启动：已经在排队就不动它，免得每次渲染都重置计时。 */
  function ensurePolling() {
    if (!state.token || state.pollTimer) return;
    state.pollTimer = setTimeout(pollOnce, hasLiveWork() ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  /**
   * 一次列表轮询 = 拉一遍 /v1/videos（一次覆盖**全部**任务）+ 必要时补一次当前任务详情。
   *
   * 为什么不只轮询当前那一条（旧实现）：列表里其它任务的状态永远不会变，
   * 用户切到「任务列表」看到的是一张静态快照，只能反复点「刷新列表」——
   * 「提交完只能傻等」的根源就在这里。
   *
   * 为什么还要单独补一次详情：列表项不带模型 / 画幅 / 流水这些字段，
   * 而「当前任务」卡片要用；活跃期间和列表状态尚未同步到详情时补查。
   * 以已渲染的详情为准，终态首次读取失败后下一轮仍会重试。
   *
   * 用 setTimeout 链而不是 setInterval：慢网络下不会把请求叠起来打后端。
   * 全部终态时降到 20 秒而不是停掉 —— 任务在服务端仍可能被 worker 推进，
   * 页面不该假装它已经死了。
   */
  async function pollOnce() {
    state.pollTimer = null;
    if (!state.token) return;
    await refreshJobs().catch(() => { /* 轮询失败静默；下一轮再试，不弹错打扰用户 */ });
    const current = state.jobs.find((job) => String(job.id) === state.currentId);
    const displayed = state.currentJob;
    const needsDetail = ACTIVE.has(current?.status) || ACTIVE.has(displayed?.status)
      || String(displayed?.id ?? '') !== state.currentId
      || (current && current.status !== displayed?.status);
    if (state.token && state.currentId && needsDetail) {
      await loadJob(state.currentId).catch(() => {});
    }
    ensurePolling();
  }

  // ─────────────────────────────────────────────────────────── 连接

  async function connect() {
    if (FILE_PREVIEW) {
      showConnection('请从本地服务地址打开工作台', 'bad');
      return;
    }
    const nextToken = $('apiKey').value.trim();
    if (state.token !== nextToken) {
      // ⚠️ 首次加载（state.token 还是空的）**不是**换令牌，是 auto-reconnect ——
      //    盘上那份「提交中」和「当前任务」正是刷新后要接回来的，不能擦。
      const isTokenSwitch = Boolean(state.token);
      // clearSessionData() 会把**内存里**的 currentId 置空（落盘值被 suspendCurrentIdPersist
      // 保住了），而 verifyRestoredCurrentId() 读的就是内存 —— 不先捞回来，它看到空值就
      // 直接 return，「当前任务」刷新后必丢。换令牌则相反：旧令牌的任务不该带过来。
      const carriedCurrentId = isTokenSwitch ? '' : state.currentId;
      if (isTokenSwitch) {
        clearPendingStore();
        storageRemove(CURRENT_ID_KEY);   // 旧令牌的浏览位置作废，别留到下次加载
      }
      clearSessionData();
      if (carriedCurrentId) state.currentId = carriedCurrentId;
    }
    state.token = nextToken;
    if (!state.token) {
      persistToken('');
      showConnection('请先输入用户令牌', 'bad');
      syncButtons();
      return;
    }
    const epoch = state.epoch;
    $('apiKey').disabled = true;
    $('connect').textContent = '连接中…';
    showConnection('正在校验令牌…');
    try {
      await refreshStatus(epoch);
      if (epoch !== state.epoch) return;
      const models = await requestJson('/v1/models');
      if (epoch !== state.epoch) return;
      state.models = Array.isArray(models?.data) ? models.data : Array.isArray(models) ? models : [];
      fillModels(false);
      renderCapability();
      await ping();
      if (epoch !== state.epoch) return;
      // ★ 必须在第一次 refreshJobs() **之前**接回占位行：refreshJobs 的「认领」只认
      //   本次轮询里新冒出来的任务，而刷新后 state.jobs 是空的 —— 先接回占位，
      //   第一次轮询看到的任务就都算「新」，能立刻把「提交中」换成真实行。
      restorePendingJobs();
      await refreshJobs();
      if (epoch !== state.epoch) return;
      // 浏览状态：把「当前任务」停回刷新前那一条（读不到就清掉，见函数注释）。
      await verifyRestoredCurrentId();
      if (epoch !== state.epoch) return;
      ensurePolling();   // 连上就开始实时轮询：有活干 4 秒一档，全终态 20 秒一档
      $('create').disabled = false;
      $('batchCreate').disabled = false;
      $('refreshJobs').disabled = false;
      $('taskStatus').textContent = '令牌有效，可以创建任务';
      // 只有校验通过之后才落盘：把一把错的令牌记住，下次打开页面会先自动重连再失败，
      // 用户看到的是「莫名其妙报了个错」，比直接让他重新输入难懂得多。
      persistToken($('rememberToken').checked ? state.token : '');
      showConnection('已连接', 'good');
      syncButtons();
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.status = null;
      state.models = [];
      renderStats();
      renderTopBalance();
      $('create').disabled = true;
      $('batchCreate').disabled = true;
      showConnection(error.message || '连接失败', 'bad');
      setError(error.message || '连接失败', error);
      syncButtons();
    } finally {
      $('apiKey').disabled = false;
      $('connect').textContent = '连接';
    }
  }

  // ─────────────────────────────────────────────────────────── 写：加入任务

  /**
   * 提示词里的 @引用标记：用户在输入框打 @ 可以直接从图库挑图，选中后
   * 往提示词里插一个 `@[名称]` 占位 —— 图本体当场就进了 state.files（与
   * 「从参考图库选」同一份列表、同一套去重），标记只是给人看的。
   *
   * ★ 标记**绝不能**发给上游：上游只该收到干净的提示词，一串 `@[92664ea5…]`
   *   对模型是纯噪声。所以提交前统一 stripMentions —— 只要有 @[…] 形态就剥掉，
   *   不依赖「当时选了哪张」的记录（用户可能手改过标记，靠记录还原必挂）。
   */
  const MENTION_RE = /@\[[^\]\n]{1,80}\]/g;
  function stripMentions(text) {
    return String(text || '').replace(MENTION_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  /** 图库名可能是 64 位哈希，标记里塞全名会把输入框撑爆 —— 展示层截断，剥除按形态不按内容。 */
  function mentionLabel(name) {
    const n = String(name || '').trim();
    return n.length > 16 ? `${n.slice(0, 16)}…` : n;
  }
  /** 触发 @ 选择器时记下 @ 的位置：confirmLibPick 要把标记插回这里（把裸 @ 换成 @[名称]）。 */
  let mentionCaret = -1;

  /**
   * @ 标记 → 图片的绑定表：`'@[名称]' -> File`。
   * 存在的唯一理由（工单 P3）：把提示词里的标记删掉时，得知道该删哪张图。
   * 没有它，「提示词里没了、图还在列表里」的幽灵图就会被悄悄提交上去。
   */
  const mentionLinks = new Map();
  /** 批量弹窗那一套：@ 标记 → state.batchFiles 里的 File。 */
  const batchMentionLinks = new Map();

  /**
   * 提示词 ↔ 参考图列表对齐：凡是绑过、但提示词里已经没有了的标记，
   * 对应图片一并从列表移除。
   *
   * 为什么按「提示词当前内容」而不是「删除事件」来判定：用户删标记的方式很多
   * （退格、整段选中删除、粘贴覆盖、套用素材整体替换 prompt）—— 监听删除动作
   * 必然漏，而每次输入后按内容对账只有一条路径，不会漏。
   *
   * 抽成通用函数是因为有**两套**落点（主工作台 / 批量弹窗）：
   * 输入框、图片数组、绑定表、重渲染函数都不一样，但规则完全一致。
   */
  function syncMentionsOf({ area, files, links, render }) {
    const present = new Set((area.value.match(MENTION_RE) || []));
    let changed = false;
    for (const [token, file] of links) {
      if (present.has(token)) continue;
      links.delete(token);
      // 同一张图可能被多个标记引用（用户 @ 了两次）：还有标记指着它就别删
      if ([...links.values()].includes(file)) continue;
      const at = files.indexOf(file);
      if (at >= 0) { dropThumb(file); files.splice(at, 1); changed = true; }
    }
    if (changed) render();
  }
  function syncMentionsFromPrompt() {
    syncMentionsOf({
      area: $('prompt'), files: state.files, links: mentionLinks,
      render: () => { renderFiles(); renderCapability(); },
    });
  }
  function syncBatchMentions() {
    syncMentionsOf({
      area: $('batchPrompts'), files: state.batchFiles, links: batchMentionLinks,
      render: renderBatchFiles,
    });
  }

  // ────────────────────────────────────────────── 「重新提交」参数回填

  /** 清空参考图区（含缩略图 object URL 回收与 @ 绑定清理）。回填前必须先走一遍。 */
  function clearRefFilesForRefill() {
    for (const file of state.files) dropThumb(file);
    state.files = [];
    mentionLinks.clear();
    renderFiles();
    renderCapability();
  }

  /**
   * 把一条**终态失败**任务的参数回填到上方的新建表单（2026-09-29 工单）。
   *
   * 做与不做的分界，这是这个功能的核心设计：
   *   · 提示词 / 时长 / 画幅 —— 从任务行**逐字**回填。落库的提示词已经是剥掉 @ 标记的
   *     干净文本（见 stripMentions），原样写回 textarea 即可，不需要再解析一遍。
   *   · 参考图 —— **不复用浏览器里的 File，也不重传**。图本来就暂存在服务端
   *     `data/reference-uploads/<原taskId>/`，这里只把字节取回来做缩略图；提交时只报
   *     「复用哪条任务的哪几张」，真正的拷贝发生在服务端（见 gateway.js 的
   *     referenceSourceTaskId）。省掉的是把好几 MiB 再传一遍这件事。
   *   · 令牌 —— 不回填。任务列表本来就是按当前连接的令牌查的，能点到这个按钮，
   *     说明令牌已经在用了。
   *
   * ⚠️ 原图已被清理是**正常路径**（保留期 24 小时；成功/取消的任务即时回收）。这时要
   *    明确提示「请重新上传」，绝不能悄悄建一条没有参考图的任务。
   */
  async function refillFromJob(id) {
    const epoch = state.epoch;
    const job = state.jobs.find((item) => String(item.id) === String(id));
    if (!job) throw new Error(`本地列表里没有 #${id}，请先点「刷新列表」再试`);

    clearRefFilesForRefill();
    $('prompt').value = job.prompt || '';
    if (job.seconds && [...$('seconds').options].some((o) => o.value === String(job.seconds))) {
      $('seconds').value = String(job.seconds);
      // ★ 设完时长**必须**走一次联动：seconds ↔ model 是绑死的
      //   （15 秒→seedance_v2.0、30 秒→seedance_v2.5，服务端 assertModelSeconds 硬校验）。
      //   直接写 select.value 不触发联动，就会留下「时长 30 秒 + 模型还是 2.0」这种非法组合，
      //   点提交必被 400 拒掉 —— 2026-09-29 实测踩到：nginx 日志
      //   `01:36:41 POST /v1/videos → 400`，页面却看不出哪里不对。
      //   联动的结果与"回填原任务参数"是一致的：原任务能跑，说明它的 时长→模型 本来就配对。
      syncDurationModel();
    }
    if (job.ratio && [...$('ratio').options].some((o) => o.value === String(job.ratio))) {
      $('ratio').value = String(job.ratio);
    }

    // 接口本身失败（网络 / 令牌失效）要如实抛出 —— 不能伪装成「图已清理」，
    // 否则用户白白去重选一遍图，其实只是链接不通。
    const info = await requestJson(`/v1/videos/${encodeURIComponent(id)}/reference-images`);
    if (epoch !== state.epoch) return null;
    const items = Array.isArray(info?.items) ? info.items : [];
    const recorded = Number(info?.recorded_count || 0);

    if (!items.length) {
      // 两种「没有图」要分开说：本来就没带图（不需要上传）/ 带过但已被清理（必须重传）。
      const hadImages = Boolean(info?.cleared) || recorded > 0;
      showConnection(
        hadImages
          ? `已回填 #${id} 的提示词/时长/画幅；⚠️ 原参考图已清理（暂存只保留 24 小时），请重新上传后再提交`
          : `已回填 #${id} 的提示词/时长/画幅（这条任务本来就没有参考图）`,
        hadImages ? '' : 'good',
      );
      renderTab('run');
      $('prompt').focus();
      return { reused: 0, cleared: hadImages };
    }

    const loaded = [];
    for (const item of items) {
      // 票据地址（10 分钟有效）带不上 Authorization，所以这里走裸 fetch。
      const response = await fetch(item.url, { credentials: 'same-origin' });
      if (!response.ok) break;
      const blob = await response.blob();
      const file = new File([blob], item.name, { type: blob.type || 'image/png' });
      // ★ 复用标记：提交时靠它区分「服务端内部拷贝的图」和「本次新选的图」。
      file._reuse = { sourceTaskId: Number(id), name: item.name };
      loaded.push(file);
    }
    if (epoch !== state.epoch) { for (const file of loaded) dropThumb(file); return null; }
    if (loaded.length !== items.length) {
      // 少一张就整批作废：宁可让用户重选，也不能提交一组「少了一张」的参考图 ——
      // 那种错误要等成片出来才看得出来。
      for (const file of loaded) dropThumb(file);
      clearRefFilesForRefill();
      throw new Error(`原任务的参考图只取回 ${loaded.length}/${items.length} 张；为避免提交出错，参考图区已清空，请刷新后重试或手动重新上传`);
    }

    state.files = loaded;      // 复用图在前，用户之后新选的会追加在后面（顺序与服务端一致）
    mentionLinks.clear();      // 上一条任务留下的 @ 绑定关系不能带到这批图上
    renderFiles();
    renderCapability();
    renderTab('run');
    $('prompt').focus();
    showConnection(`已回填 #${id} 的参数（含 ${loaded.length} 张参考图，提交时不重传）—— 可改参数后点「加入任务」`, 'good');
    return { reused: loaded.length, cleared: false };
  }

  async function createTask() {
    const epoch = state.epoch;
    // 提交前再对齐一次（P3 兜底）：粘贴、套用素材等非键盘路径不经过 input 事件，
    // 靠这一枪保证「提示词里没有的标记，图也一定不会被提交」。
    syncMentionsFromPrompt();
    const prompt = stripMentions($('prompt').value);
    if (!prompt) { setError('请填写提示词（只有 @ 引用标记、没有正文时，标记会被剥掉，等于没有提示词）'); return; }
    if (state.files.length > 9) { setError('参考图片最多 9 张'); return; }
    const seconds = Number($('seconds').value);
    const model = $('model').value;
    const autoStart = $('autoStart').checked;
    const cost = Number(state.status?.points_per_task || 1);
    const balance = Number(state.status?.token?.points || 0);
    // 参考图分成两类（「重新提交」回填来的图带 `_reuse` 标记）：
    //   · 复用图：只把「哪条任务的哪几张」报给服务端，图由服务端从暂存目录内部拷贝；
    //   · 新选图：照旧走 multipart 上传。
    // 两者在界面上是同一个列表、可以混排，用户感觉不到区别。
    const reuseFiles = state.files.filter((file) => file._reuse);
    const freshFiles = state.files.filter((file) => !file._reuse);
    const reuseSource = reuseFiles.length ? reuseFiles[0]._reuse.sourceTaskId : null;
    // ★ 用页面内确认框，不用 window.confirm：原生弹窗被浏览器静默拦掉时直接返回 false，
    //   按钮就成了"点了没反应、还不报错" —— 2026-09-28「加入任务」就是这个事故
    //   （约 10 次点击全部静默失败，任务没建、积分没动、界面零提示）。详见 askConfirm 注释。
    const okToCreate = await askConfirm({
      title: reuseFiles.length
        ? (autoStart ? `确认重新提交（新建一单并立即提交上游）` : `确认重新提交（新建一单）`)
        : (autoStart ? '确认创建并立即提交上游' : '确认创建任务'),
      body: [
        `时长：${seconds} 秒`,
        `积分：${autoStart ? '扣' : '冻结'} ${cost} 积分（令牌余额 ${balance}）`,
        autoStart
          ? '创建后立即提交上游，会消耗上游账号额度。'
          : '暂不提交上游，之后可在「任务列表」里手动提交。',
        reuseFiles.length
          ? `参考图：复用 #${reuseSource} 的 ${reuseFiles.length} 张`
            + `${freshFiles.length ? ` + 本次新选 ${freshFiles.length} 张` : ''}（复用图由服务端拷贝，不重传）`
          : (state.files.length ? `参考图：${state.files.length} 张，会随任务一起提交。` : ''),
        reuseFiles.length ? `这是一次新的提交：会新建一单并扣 ${cost} 积分，原任务 #${reuseSource} 原样保留。` : '',
      ].filter(Boolean).join('\n'),
      confirmText: autoStart ? '确认并提交上游' : '确认创建',
    });
    if (!okToCreate) return;
    state.autoStart = autoStart;
    clearError();

    // ★ 乐观占位：确认之后立刻在「我的任务」里出现，不等 POST 回包。
    //   这一枪走的是网关链路（排重 → 参考图校验 → 账号体检 → 扣积分 → 入队），
    //   账号体检会发真实网络请求，几秒钟很正常 —— 不能让它变成「盯着按钮转圈」。
    const pendingId = addPendingJob({ prompt, seconds });
    // 立刻停在「任务列表」：第一眼要看到的是「它已经进来了」，而不是一个转圈的按钮。
    // ⚠️ 这一句必须放在 POST **之前** —— 放到回包之后等于还是先让用户干等。
    renderTab('jobs');

    // ★ 故意**不用 withBusy**（不改文案、不禁用按钮）。
    //   产品要求：「右边提交中就行了，左边可以继续提交」—— 进度反馈由「我的任务」
    //   里的占位行承担，左侧按钮保持可用，用户可以连着建下一条，不必等上一条回包。
    //   ⚠️ 也因此这里**不能**走 withBusy：它开头就有 `dataset.busy === '1'` 的重入保护，
    //      会把第二次点击直接 return 掉，正好和「可以继续提交」相反。
    await (async () => {
      try {
        let body;
        // 只有**新选的**图走 multipart；复用的图只报「哪条任务的哪几张」，服务端自己拷。
        // 复用的图若也塞进 FormData，等于又把几 MiB 传了一遍 —— 那正是这个功能要省掉的事。
        if (freshFiles.length) {
          body = new FormData();
          body.append('model', model);
          body.append('prompt', prompt);
          body.append('seconds', String(seconds));
          body.append('size', $('ratio').value);
          body.append('auto_start', String(autoStart));
          for (const file of freshFiles) body.append('input_reference', file, file.name);
          if (reuseSource) {
            body.append('reference_source_task', String(reuseSource));
            body.append('reference_source_keep', JSON.stringify(reuseFiles.map((file) => file._reuse.name)));
          }
        } else {
          body = { model, prompt, seconds, size: $('ratio').value, auto_start: autoStart };
          if (reuseSource) {
            body.reference_source_task = reuseSource;
            body.reference_source_keep = JSON.stringify(reuseFiles.map((file) => file._reuse.name));
          }
        }
        const job = await requestJson('/v1/videos', { method: 'POST', body, timeoutMs: 150000 });
        if (epoch !== state.epoch) return;
        if (!job?.id) throw new Error('接口已返回，但响应中没有任务 id');
        // 先撤占位、再插真实行 —— 两次变更合成一次渲染，不会闪出「占位 + 真实」两行。
        dropPendingJob(pendingId, { render: false });
        upsertJob(job);
        renderJob(job);
        showConnection(autoStart ? `已创建并提交 #${job.id}` : `已创建 #${job.id}（待提交）`, 'good');
        await refreshJobs();
        if (epoch !== state.epoch) return;
        await refreshStatus(epoch);
      } catch (error) {
        if (epoch !== state.epoch) return;
        dropPendingJob(pendingId);   // 没建成 → 不留一条点不动的幽灵行
        setError(error.message, error);
        showConnection(error.code ? `提交失败 · ${error.code}` : '提交失败', 'bad');
      } finally {
        if (epoch === state.epoch) $('create').disabled = !state.status;
      }
    })();
  }

  // ─────────────────────────────────────────────────────────── 写：启动

  /** 单条：POST /v1/videos/{id}/start。响应不是完整任务，所以启动后回读一次。 */
  async function startJob(id) {
    const epoch = state.epoch;
    const result = await requestJson(`/v1/videos/${encodeURIComponent(id)}/start`, {
      method: 'POST', body: {}, timeoutMs: 120000,
    });
    if (epoch !== state.epoch) return null;
    const got = String(result?.id || id);
    state.currentId = got;
    renderTab('run');
    const job = await loadJob(got, { select: true });
    await refreshJobs();
    if (epoch !== state.epoch) return null;
    showConnection(result?.note ? `#${got}：${result.note}` : `已提交上游 #${got}`, 'good');
    return job || result;
  }

  /** 批量：POST /v1/videos/start {ids} —— 「全部提交上游」。 */
  async function startAll() {
    const epoch = state.epoch;
    const ids = state.jobs.filter(canStart).map((item) => item.id).filter(Boolean);
    if (!ids.length) { setError('当前没有「排队中」的任务可以提交。失败/已取消是终态，需要重新建一条。'); return; }
    if (!(await askConfirm({
      title: '批量提交上游',
      body: `把 ${ids.length} 条排队中的任务一次性提交上游？\n这些任务的积分在创建时已冻结。`,
      confirmText: `提交这 ${ids.length} 条`,
    }))) return;
    await withBusy($('startQueued'), '提交中…', async () => {
      try {
        const result = await requestJson('/v1/videos/start', { method: 'POST', body: { ids }, timeoutMs: 120000 });
        if (epoch !== state.epoch) return;
        const started = Array.isArray(result?.started) ? result.started : [];
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        clearError();
        if (errors.length) setError(errors.map((item) => `#${item.id} ${item.error}（${item.code}）`).join('\n'));
        showConnection(`已提交上游 ${started.length} 条${errors.length ? `，${errors.length} 条未提交` : ''}`, errors.length ? '' : 'good');
        if (started[0]?.id) { state.currentId = String(started[0].id); renderTab('run'); }
        await refreshJobs();
        if (epoch !== state.epoch) return;
        const first = started[0]?.id;
        if (first) await loadJob(first, { select: true });
      } catch (error) {
        if (epoch === state.epoch) setError(error.message, error);
      }
    });
  }

  // ─────────────────────────────────────────────────────────── 写：取消

  /** 单条取消。POST 与 DELETE 在服务端是同一个 handler，这里用 POST。 */
  async function cancelJob(id, { confirmText } = {}) {
    if (confirmText && !(await askConfirm({
      title: '取消任务', body: confirmText, confirmText: '取消任务', danger: true,
    }))) return null;
    const epoch = state.epoch;
    const result = await requestJson(`/v1/videos/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', body: {}, timeoutMs: 120000,
    });
    if (epoch !== state.epoch) return null;
    if (String(state.currentId) === String(id)) await loadJob(id);
    await refreshJobs();
    if (epoch !== state.epoch) return null;
    const refund = Number(result?.refunded_points || 0);
    showConnection(result?.message
      ? `#${id} 已取消：${result.message}`
      : `#${id} 已取消${refund ? `，退款 ${refund} 积分` : '，不退款'}`, refund ? 'good' : '');
    return result;
  }

  // ─────────────────────────────────────────────────────────── 写：清除

  /** 清除单条：DELETE /v1/videos/{id}。服务端 = 取消 + cleared_at 软删除，
   *  刷新列表也不会再出现（计费凭据仍在服务端，按 id 可查）。 */
  async function clearJob(id, { confirmText } = {}) {
    if (confirmText && !(await askConfirm({
      title: '清除任务', body: confirmText, confirmText: '清除', danger: true,
    }))) return null;
    const epoch = state.epoch;
    const result = await requestJson(`/v1/videos/${encodeURIComponent(id)}`, {
      method: 'DELETE', timeoutMs: 120000,
    });
    if (epoch !== state.epoch) return null;
    state.jobs = state.jobs.filter((item) => String(item.id) !== String(id));
    if (String(state.currentId) === String(id)) {
      // 只清「当前任务」卡片，不停轮询 —— 列表里可能还有别的任务在跑（2026-09-27 重构）。
      renderEmptyJob('任务已清除');
    }
    renderJobs();
    ensurePolling();
    const refund = Number(result?.refunded_points || 0);
    // refunded_already：这条任务在失败/取消时已经自动退过款，本次清除只是**复用**了那笔退款。
    // 不能再说一次「退款 N 积分」，否则用户以为清除又退了钱、对不上账。
    const already = Boolean(result?.refunded_already);
    const note = refund ? `，退款 ${refund} 积分` : (already ? '，此前已自动退款（未重复退）' : '');
    showConnection(`已清除 #${id}${note}`, 'good');
    return result;
  }

  /** 清空：DELETE /v1/videos {all:true} —— 「清空任务记录」。 */
  async function clearAllJobs() {
    if (!(await askConfirm({
      title: '清空任务记录',
      body: '清空当前令牌下全部任务记录？\n排队中的会取消并退款；已在生成的不退款。\n（清除 = 取消 + 从列表隐藏；计费/退款凭据仍保留在服务端，按 id 可查。）',
      confirmText: '全部清空',
      danger: true,
    }))) return;
    const epoch = state.epoch;
    await withBusy($('clearJobs'), '清空中…', async () => {
      try {
        const result = await requestJson('/v1/videos', { method: 'DELETE', body: { all: true }, timeoutMs: 120000 });
        if (epoch !== state.epoch) return;
        stopPolling();
        state.jobs = [];
        state.jobsFingerprint = '';   // 清空后必须作废指纹，否则「空 → 空」时不会重绘
        state.currentId = '';
        renderEmptyJob('任务记录已清空');
        renderJobs();
        ensurePolling();   // 清空的是列表内容，轮询本身该继续活着
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        const refund = Number(result?.refunded_points || 0);
        const already = Number(result?.refunded_already_count || 0);
        if (errors.length) setError(errors.map((item) => `#${item.id} ${item.error}（${item.code}）`).join('\n'));
        else clearError();
        showConnection(`已清空 ${Number(result?.cleared_count || 0)} 条${refund ? `，退款 ${refund} 积分` : ''}${already && !refund ? `（${already} 条此前已退款）` : ''}${errors.length ? `，${errors.length} 条失败` : ''}`, errors.length ? '' : 'good');
        await refreshStatus(epoch);
      } catch (error) {
        if (epoch === state.epoch) setError(error.message, error);
      }
    });
  }

  // ─────────────────────────────────────────────────────────── 写：下载

  /** 读成片。忙碌态由调用方（点击处）负责 —— 这里不要再包一层 withBusy，
   *  同一个按钮嵌套两次会撞上 dataset.busy 直接返回，内层永远不执行。 */
  async function downloadCurrent() {
    if (!state.currentId) return;
    const job = await loadJob(state.currentId);
    if (!job || job.status !== 'ready') { setError('成片尚未通过验收，暂不可下载'); return; }
    await loadContent(job);
  }

  // ─────────────────────────────────────────────────────────── 弹窗

  function openDialog(id) {
    const dlg = $(id);
    if (!dlg) return null;
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
    return dlg;
  }

  function closeDialog(id) {
    const dlg = $(id);
    if (!dlg || !dlg.open) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  /**
   * 页面内确认框 —— **替代 window.confirm**，返回 Promise<boolean>。
   *
   * ★ 为什么必须换掉原生弹窗（2026-09-28 真实事故）：
   *   浏览器会把 `window.confirm` **静默拦掉**，两种常见情形 ——
   *     ① 用户在某次弹窗里勾过「不再弹出对话框」（按站点持久保存，之后每次都静默返回 false）；
   *     ② 页面被嵌进没给 `allow-modals` 的沙箱 iframe。
   *   拦掉时它**直接返回 false**，于是调用方的 `if (!confirm(...)) return;` 静默退出：
   *   不建任务、不报错、不提示 —— 用户看到的就是「点了按钮什么都没发生」。
   *   工作台「加入任务」按钮就是这样被堵死的（约 10 次尝试全部静默失败）。
   *   `<dialog>` 是纯 DOM，不受这两条限制。
   *
   * @param {{title?:string, body?:string, confirmText?:string, danger?:boolean}} [opts]
   *   body 里的 `\n` 会拆成多段 —— 原生弹窗做不到这点，而「扣多少积分 / 余额多少」
   *   正是最该分行摆清楚的内容。danger=true 时确认按钮走红色（用于删除/清空类操作）。
   * @returns {Promise<boolean>} 确认 true；取消 / ESC / 关闭 false。
   */
  function askConfirm({ title = '请确认', body = '', confirmText = '确认', danger = false } = {}) {
    return new Promise((resolve) => {
      const dlg = openDialog('confirmDlg');
      // 兜底：万一弹窗 DOM 不在（旧版本页面/被裁剪），退回原生，至少不会卡死流程。
      if (!dlg) { resolve(window.confirm(String(body).replace(/\n/g, ' '))); return; }
      $('confirmTitle').textContent = title;
      const box = $('confirmBody');
      box.replaceChildren();
      for (const line of String(body).split('\n')) {
        const p = document.createElement('p');
        p.textContent = line || '\u00a0';   // 空行用不换行空格撑住高度，别塌掉
        box.appendChild(p);
      }
      const ok = $('confirmOk');
      const cancel = $('confirmCancel');
      ok.textContent = confirmText;
      ok.classList.toggle('danger', Boolean(danger));
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        closeDialog('confirmDlg');
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      // ESC、右上角关闭、以及任何 data-dlg-close 都走 'close' 事件 ⇒ 一律当"取消"。
      // ⚠️ 少了这一行，用户按 ESC 会让 Promise 永远不 resolve，按钮从此点不动。
      const onClose = () => finish(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
    });
  }

  // ─────────────────────────────────────────────────────────── 无水印预览
  //
  // 后端 GET /v1/videos/:id（detail）一直带着 is_unwatermarked / unwatermarked_url /
  // url_source，前端此前**完全没用** —— 用户拿到成片后没法确认手里这份到底是不是
  // 无水印那一版，只能去管理后台的成片库看。这里把它接上。
  //
  // 为什么单独开一个弹窗、不直接换主播放器的 src：
  //   主播放器的源由 loadContent() 按「归档优先」决定，旁边的「下载成片」也指向同一份。
  //   把它临时改指上游直链，会让播放器（无水印）和下载（归档，可能是带水印）指向两版
  //   不同的成片，用户根本分不清在存哪一版。所以预览单独一个 <video>，关掉就断源。

  /**
   * 当前任务里「无水印那一版」的取法。取不到返回 null（按钮就不显示）。
   *
   * 优先级是**有讲究的**，不是随便挑一个：
   *   ① 归档 + is_unwatermarked=1 → 本地归档字节就是无水印那一版，而且不会过期。
   *   ② 否则才用上游 unwatermarked_url。
   *   ⚠️ ② 里**绝不能**退回 /content：归档是在「解析出无水印直链」之前做的场合，
   *      /content 给的是**带水印**那一版（v1-routes 里 src = unwatermarked_url ||
   *      watermarked_url 只在没有本地归档时才生效）。那样按钮写着「无水印」、
   *      播出来却带水印，比没有这个按钮更糟。
   */
  function unwatermarkedSource(job) {
    if (!job || job.status !== 'ready') return null;
    const id = String(job.id || '');
    if (!id) return null;
    if (job.archived && job.is_unwatermarked) {
      return { kind: 'archive', url: `/v1/videos/${encodeURIComponent(id)}/content` };
    }
    if (job.unwatermarked_url) return { kind: 'upstream', url: String(job.unwatermarked_url) };
    return null;
  }

  /** 受管按钮的可见性/可用性。并入 syncButtons()，withBusy 收尾时也会走回来重算。 */
  function syncUnwatermarkedButton() {
    const button = $('previewUnwatermarked');
    if (!button) return;
    const source = unwatermarkedSource(state.currentJob);
    button.classList.toggle('hidden', !source);
    button.disabled = isBusy('previewUnwatermarked') || !source;
  }

  function setUwError(message) {
    const box = $('uwError');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('show', Boolean(message));
  }

  /**
   * 把「无水印那一版」变成一个能直接塞进 <video src> 的地址。
   *
   * 上游直链可以直接塞（跨域媒体元素不需要 CORS，也不该给 <video> 加 crossorigin，
   * 加了反而会被上游的 CORS 策略拦下）；归档那条走的是 /v1/videos/:id/content，
   * 需要 Authorization 头，而媒体元素带不上自定义头 —— 所以必须先 fetch 成 blob。
   * （/content 的 302 落地点 /v1/files/:ticket 不需要头，这正是它能给 <a href> 直接用的原因；
   *   但我们要的是「当前这一条的无水印归档」，走带头的 /content 最直接。）
   */
  async function resolveUnwatermarkedUrl(job, source) {
    if (source.kind === 'upstream') return source.url;
    const response = await fetchResponse(source.url, { timeoutMs: 300000 });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw toError(payload, response);
    }
    const blob = await response.blob();
    if (state.uwObjectUrl) URL.revokeObjectURL(state.uwObjectUrl);
    state.uwObjectUrl = URL.createObjectURL(blob);
    return state.uwObjectUrl;
  }

  async function openUnwatermarkedPreview() {
    const job = state.currentJob;
    const source = unwatermarkedSource(job);
    if (!source) throw new Error('当前任务没有可预览的无水印成片');
    const id = String(job.id);
    setUwError('');
    $('uwTitle').textContent = `无水印预览 · 任务 #${id}`;
    $('uwNote').textContent = source.kind === 'upstream'
      ? '来源：上游无水印直链。这是上游签发的临时地址，会过期；要长期留存请用左侧「下载成片」（服务端归档优先存无水印那一版）。'
      : '来源：本服务已归档的无水印成片（不会过期）。';
    const player = $('uwPlayer');
    player.pause();
    player.removeAttribute('src');   // 换源前先断掉上一版，免得弹出时闪一帧旧画面
    const url = await resolveUnwatermarkedUrl(job, source);
    state.uwKind = source.kind;
    player.src = url;
    player.load();
    openDialog('uwDlg');
    // 自动播放可能被浏览器策略拦掉（尤其是带声音的）。拦了就拦了 —— 弹窗里手动点播放，
    // 不能因为这一下把整段预览判成失败。
    try { await player.play(); } catch { /* 交给用户手动播放 */ }
  }

  /** 关弹窗就断源。不断的话关掉之后后台还在把整段视频下完。 */
  function teardownUnwatermarkedPreview() {
    const player = $('uwPlayer');
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
    if (state.uwObjectUrl) URL.revokeObjectURL(state.uwObjectUrl);
    state.uwObjectUrl = '';
    state.uwKind = '';
    setUwError('');
  }

  // ─────────────────────────────────────────────────────────── 写：兑换积分

  function setRedeemResult(message, tone = 'bad') {
    const box = $('redeemResult');
    box.textContent = message || '';
    box.classList.toggle('show', Boolean(message));
    box.classList.toggle('good', Boolean(message) && tone === 'good');
  }

  /**
   * 兑换卡密：POST /v1/redeem { card }。
   *
   * 服务端把卡充给**令牌自己**（不接受任何身份入参），所以这里不需要、也不该传 tokenId。
   * 成功后必须回读 /v1/status 刷新余额 —— 直接拿响应里的 balance 改本地数字，
   * 一旦同时还有别的计费流水（并发生成扣费、另一个标签页在跑），页面就会显示一个偏高的余额。
   */
  async function redeemCard() {
    const card = $('cardInput').value.trim();
    if (!card) { setRedeemResult('请输入卡密'); return; }
    const epoch = state.epoch;
    await withBusy($('redeemSubmit'), '兑换中…', async () => {
      try {
        const result = await requestJson('/v1/redeem', { method: 'POST', body: { card }, timeoutMs: 60000 });
        if (epoch !== state.epoch) return;
        $('cardInput').value = '';
        setRedeemResult(
          `兑换成功：+${fmtInt(result?.points ?? 0)} 积分，当前余额 ${fmtInt(result?.balance ?? 0)}。`,
          'good',
        );
        await refreshStatus(epoch);
        if (epoch !== state.epoch) return;
        await refreshJobs();
        showConnection(`兑换成功，+${fmtInt(result?.points ?? 0)} 积分`, 'good');
      } catch (error) {
        if (epoch === state.epoch) setRedeemResult(error.message || '兑换失败');
      }
    });
  }

  // ─────────────────────────────────────────────────────────── 写：批量创建

  /** 弹窗里的时长/画幅跟单条创建用同一份来源，避免两个地方各列一套、慢慢走偏。 */
  function fillBatchOptions() {
    const source = $('seconds');
    const target = $('batchSeconds');
    const previous = target.value;
    target.replaceChildren();
    for (const option of source.options) target.append(new Option(option.textContent, option.value));
    const values = [...target.options].map((option) => option.value);
    if (values.includes(previous)) target.value = previous;
    else if (values.includes(source.value)) target.value = source.value;
    else if (values.length) target.value = values[0];
    target.disabled = values.length === 0;

    const ratioTarget = $('batchRatio');
    if (!ratioTarget.options.length) {
      for (const option of $('ratio').options) ratioTarget.append(new Option(option.textContent, option.value));
    }
    ratioTarget.value = $('ratio').value;
  }

  /**
   * 把文本域拆成提示词列表。
   *
   * 去掉重复行是有实际作用的：服务端有重复提交保护（同一令牌 + 同一提示词，默认 120 秒内
   * 第二次会被挡下），不去重的话「不小心粘了两遍」会变成一半成功一半 409，
   * 用户还得自己数哪些失败了。
   */
  function batchLines() {
    const seen = new Set();
    const unique = [];
    for (const line of $('batchPrompts').value.split('\n')) {
      // 逐行剥掉 @[…] 标记（与单条一致）：标记只是本地的可读占位，不能发给上游。
      // ⚠️ 先剥再去重：同一句带/不带标记应算同一行，剥完自然就相同了。
      const value = stripMentions(line);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      unique.push(value);
    }
    return unique;
  }

  function setBatchError(message) {
    const box = $('batchError');
    box.textContent = message || '';
    box.classList.toggle('show', Boolean(message));
  }

  function renderBatchCost() {
    const cost = Number(state.status?.points_per_task || 1);
    const balance = Number(state.status?.token?.points || 0);
    const count = batchLines().length;
    const autoStart = $('batchAutoStart').checked;
    const box = $('batchCost');
    if (!state.status) { box.textContent = '连接令牌后才能批量创建。'; return; }
    if (!count) {
      box.textContent = `每行一个提示词，最多 ${BATCH_MAX_LINES} 行。每条消耗 ${cost} 积分，当前余额 ${balance}。`;
      return;
    }
    const parts = [
      `将创建 ${count} 条任务，共 ${count * cost} 积分（当前余额 ${balance}）`
      + `${autoStart ? '，并逐条立即提交上游。' : '，先冻结积分、之后手动提交。'}`,
      '按顺序逐条提交，单条失败不中断后续；批量创建不带参考图。',
    ];
    // 余额不够时后半段会 402 失败，而前面成功的那些积分已经扣掉、不会自动回滚 ——
    // 这是真实后果，必须在点按钮之前说清楚。
    if (count * cost > balance) {
      parts.push(`⚠️ 余额不足：大约第 ${Math.floor(balance / cost) + 1} 条开始会失败，前面已扣的积分不会自动退回。`);
    }
    box.textContent = parts.join('\n');
  }

  async function runBatchCreate() {
    // 提交前对账一次（P3 兜底）：粘贴整段提示词这类非键盘改动不经过 input 事件，
    // 靠这一枪保证「提示词里没有的标记，图也一定不会被提交」。
    syncBatchMentions();
    const prompts = batchLines();
    if (!prompts.length) { setBatchError('请至少写一行提示词'); return; }
    if (prompts.length > BATCH_MAX_LINES) {
      setBatchError(`最多 ${BATCH_MAX_LINES} 行，当前 ${prompts.length} 行`);
      return;
    }
    const seconds = Number($('batchSeconds').value);
    if (!Number.isFinite(seconds)) { setBatchError('请先选择时长（连接令牌后才有可选档位）'); return; }
    const ratio = $('batchRatio').value;
    const autoStart = $('batchAutoStart').checked;
    const cost = Number(state.status?.points_per_task || 1);
    const balance = Number(state.status?.token?.points || 0);
    // 同样走页面内确认框（理由同 createTask：原生弹窗会被静默拦掉 ⇒ 点了没反应）。
    const confirmed = await askConfirm({
      title: autoStart ? '批量创建并立即提交上游' : '批量创建任务',
      body: [
        `将逐条创建 ${prompts.length} 条真实 ${seconds} 秒任务。`,
        `积分：${autoStart ? '扣' : '冻结'} ${prompts.length} × ${cost} = ${prompts.length * cost} 积分（当前余额 ${balance}）`,
        autoStart
          ? '每条创建后会立即提交上游，会消耗上游账号额度。'
          : '先只冻结积分，状态停在「排队中」。',
        state.batchFiles.length
          ? `参考图：${state.batchFiles.length} 张（每条任务都带同一组）。`
          : '',
        '单条失败不会中断后续提交。',
        // 余额不够时后半段会 402 失败，而前面已经扣掉的部分不会自动回滚 —— 真实后果，先说清。
        prompts.length * cost > balance
          ? `⚠️ 余额不足：大约第 ${Math.floor(balance / cost) + 1} 条开始会失败，前面已扣的积分不会自动退回。`
          : '',
      ].filter(Boolean).join('\n'),
      confirmText: autoStart ? '确认并开始提交' : '确认并创建',
    });
    if (!confirmed) return;

    const epoch = state.epoch;
    const list = $('batchResults');
    list.replaceChildren();
    setBatchError('');
    $('batchBar').style.width = '0%';
    const summary = { created: 0, failed: 0, firstId: '' };

    await withBusy($('batchSubmit'), '创建中…', async () => {
      for (let i = 0; i < prompts.length; i += 1) {
        if (epoch !== state.epoch) return;
        const item = document.createElement('li');
        const index = document.createElement('span');
        index.className = 'idx';
        index.textContent = `${i + 1}.`;
        const text = document.createElement('span');
        const label = prompts[i].slice(0, 60);
        text.textContent = `${label} — 提交中…`;
        item.append(index, text);
        list.append(item);
        list.scrollTop = list.scrollHeight;
        try {
          // 带参考图时必须走 multipart（input_reference 文件字段），服务端不接受图库 id/URL ——
          // 与单条 createTask 同一条约定；批量是「每条都带同一组图」。
          let batchBody;
          if (state.batchFiles.length) {
            batchBody = new FormData();
            batchBody.append('model', modelForDuration(seconds) || $('model').value);
            batchBody.append('prompt', prompts[i]);
            batchBody.append('seconds', String(seconds));
            batchBody.append('size', ratio);
            batchBody.append('auto_start', String(autoStart));
            for (const file of state.batchFiles) batchBody.append('input_reference', file, file.name);
          } else {
            batchBody = {
              model: modelForDuration(seconds) || $('model').value,
              prompt: prompts[i], seconds, size: ratio, auto_start: autoStart,
            };
          }
          const job = await requestJson('/v1/videos', {
            method: 'POST',
            body: batchBody,
            timeoutMs: 150000,
          });
          if (!job?.id) throw new Error('接口已返回，但响应中没有任务 id');
          summary.created += 1;
          if (!summary.firstId) summary.firstId = String(job.id);
          text.className = 'ok';
          text.textContent = `${label} — 已创建 #${job.id}${autoStart ? '（已提交上游）' : '（待提交）'}`;
          upsertJob(job);
        } catch (error) {
          if (epoch !== state.epoch) return;
          summary.failed += 1;
          text.className = 'bad';
          text.textContent = `${label} — 失败：${error.message}${error.code ? `（${error.code}）` : ''}`;
        }
        $('batchBar').style.width = `${Math.round(((i + 1) / prompts.length) * 100)}%`;
      }
      if (epoch !== state.epoch) return;
      await refreshJobs();
      if (epoch !== state.epoch) return;
      await refreshStatus(epoch);
      if (epoch !== state.epoch) return;
      showConnection(
        `批量创建完成：成功 ${summary.created} 条${summary.failed ? `，失败 ${summary.failed} 条` : ''}`,
        summary.failed ? '' : 'good',
      );
      if (summary.firstId) {
        state.currentId = summary.firstId;
        // 批量建完直接停在「任务列表」：这一批是刚建的，用户要看到的就是它们。
        renderTab('jobs');
        await loadJob(summary.firstId, { select: true });
      }
    });
  }

  // ─────────────────────────────────────────────────────────── 素材库（本机）

  function loadMaterials() {
    state.materials = [];
    try {
      const parsed = JSON.parse(storageGet(MATERIAL_KEY) || '[]');
      state.materials = Array.isArray(parsed) ? parsed : [];
    } catch {
      // 坏数据只影响素材库，不牵连任务与令牌；清掉它比每次打开都抛错好。
      storageRemove(MATERIAL_KEY);
      state.materials = [];
    }
  }

  function saveMaterials(next) {
    if (!storageSet(MATERIAL_KEY, JSON.stringify(next))) {
      setError('素材保存失败：浏览器本地存储已满或被禁用。参考图按 base64 存很占空间，删掉几条旧素材再试。');
      return false;
    }
    state.materials = next;
    return true;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
      reader.readAsDataURL(file);
    });
  }

  async function saveCurrentAsMaterial() {
    const prompt = $('prompt').value.trim();
    if (!prompt) { setError('先填写提示词，再存为素材。'); return; }
    const images = [];
    let bytes = 0;
    for (const file of state.files) {
      const dataUrl = await fileToDataUrl(file);
      bytes += dataUrl.length;
      if (bytes > MATERIAL_IMAGE_BUDGET) {
        setError(`参考图 base64 超过 ${(MATERIAL_IMAGE_BUDGET / 1048576).toFixed(1)} MB，超出浏览器本地存储的合理范围；本次只保存提示词与画幅，参考图未存进素材。`);
        break;
      }
      images.push({ name: file.name, dataUrl });
    }
    const material = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: prompt.slice(0, 18),
      prompt,
      ratio: $('ratio').value,
      images,
      createdAt: new Date().toISOString(),
    };
    if (!saveMaterials([material, ...state.materials])) return;
    renderMaterials();
    showConnection(`已存为素材「${material.title}」`, 'good');
  }

  async function applyMaterial(id) {
    const material = state.materials.find((item) => item.id === id);
    if (!material) return;
    $('prompt').value = material.prompt || '';
    if (material.ratio && [...$('ratio').options].some((option) => option.value === material.ratio)) {
      $('ratio').value = material.ratio;
    }
    // 套用素材是**整体替换**（提示词 + 参考图），旧的 @ 绑定全部作废；
    // 顺手把上一批图的 object URL 释放掉（否则 blob 一直挂着到刷新）。
    for (const file of state.files) dropThumb(file);
    state.files = [];
    mentionLinks.clear();
    for (const image of material.images || []) {
      try {
        // dataURL → Blob → File：参考图在提交时是按 File 进 FormData 的，必须还原成同一形状。
        const blob = await (await fetch(image.dataUrl)).blob();
        state.files.push(new File([blob], image.name || 'reference.png', { type: blob.type || 'image/png' }));
      } catch { /* 单张参考图还原失败不影响提示词与画幅 */ }
    }
    renderFiles();
    renderCapability();
    closeDialog('materialDlg');
    showConnection(`已套用素材「${material.title || '未命名'}」`, 'good');
  }

  function renderMaterials() {
    const list = $('materialList');
    list.replaceChildren();
    $('materialEmpty').classList.toggle('hidden', state.materials.length > 0);
    for (const material of state.materials) {
      const item = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'm-title';
      title.textContent = material.title || '未命名素材';
      const prompt = document.createElement('span');
      prompt.className = 'm-prompt';
      prompt.textContent = material.prompt || '';
      const meta = document.createElement('span');
      meta.className = 'm-meta';
      meta.textContent = `${material.ratio || '16:9'} · ${(material.images || []).length} 张参考图 · ${material.createdAt || ''}`;
      const ops = document.createElement('div');
      ops.className = 'm-ops';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn ghost small';
      use.textContent = '选用';
      use.dataset.act = 'material-use';
      use.dataset.id = material.id;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn danger small';
      remove.textContent = '删除';
      remove.dataset.act = 'material-delete';
      remove.dataset.id = material.id;
      ops.append(use, remove);
      item.append(title, prompt, meta, ops);
      list.append(item);
    }
  }

  // ─────────────────────────────────────────────────────────── 事件绑定

  $('connect').addEventListener('click', connect);
  $('apiKey').addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
  $('apiKey').addEventListener('input', () => {
    if (state.token && $('apiKey').value.trim() !== state.token) {
      clearSessionData();
      state.token = '';
      // 用户在改令牌 = 之前记住的那把已经作废，别让它下次又自动重连回来。
      persistToken('');
      showConnection('令牌已更改，请重新连接');
    }
  });
  $('rememberToken').addEventListener('change', () => {
    // 勾上时若已经连好了，立刻落盘，不用等下一次连接；取消勾选则马上擦掉。
    if ($('rememberToken').checked && state.status) persistToken(state.token);
    else if (!$('rememberToken').checked) persistToken('');
  });
  $('logoutBtn').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: '退出当前令牌',
      body: [
        '这只清除本页（以及本机记住的令牌）。',
        '服务端的任务、积分和扣费记录都不受影响 —— 用同一把令牌重新登录即可看到。',
      ].join('\n'),
      confirmText: '退出',
    });
    if (!ok) return;
    logout();
  });
  $('redeemBtn').addEventListener('click', () => {
    setRedeemResult('');
    openDialog('redeemDlg');
    $('cardInput').focus();
  });
  $('redeemSubmit').addEventListener('click', redeemCard);
  $('cardInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') redeemCard(); });
  $('batchCreate').addEventListener('click', () => {
    setBatchError('');
    $('batchResults').replaceChildren();
    $('batchBar').style.width = '0%';
    fillBatchOptions();
    renderBatchCost();
    renderBatchFiles();   // 上次没提交的图还留在 batchFiles 里，打开时回显出来（用户可能就是想接着用）
    openDialog('batchDlg');
    $('batchPrompts').focus();
  });
  $('batchPrompts').addEventListener('input', renderBatchCost);
  $('batchAutoStart').addEventListener('change', renderBatchCost);
  $('batchSubmit').addEventListener('click', runBatchCreate);
  $('saveMaterial').addEventListener('click', () => {
    withBusy($('saveMaterial'), '保存中…', saveCurrentAsMaterial)
      .catch((error) => setError(error.message || '存为素材失败'));
  });
  $('openMaterials').addEventListener('click', () => {
    renderMaterials();
    openDialog('materialDlg');
  });
  $('pickFromLibrary').addEventListener('click', () => {
    // 落点标成主工作台：confirmLibPick 靠 libPick.target 决定把图加到哪一份列表
    openLibPick('main').catch((error) => setError(error.message || '参考图库加载失败'));
  });
  // 批量弹窗里的「从参考图库选」：同一个选择器，落点换成 batchFiles
  $('batchPickFromLibrary').addEventListener('click', () => {
    openLibPick('batch').catch((error) => setError(error.message || '参考图库加载失败'));
  });
  // 批量弹窗的本机选文件：追加进 batchFiles（上限 9 张，与主工作台互相独立）
  $('batchImages').addEventListener('change', () => {
    const added = [];
    let exceeded = false;
    for (const file of $('batchImages').files) {
      if (state.batchFiles.length >= 9) { exceeded = true; break; }
      state.batchFiles.push(file);
      added.push(file);
    }
    $('batchImages').value = '';   // 清掉 input：同一张图删掉后还能再选回来
    renderBatchFiles();
    // ⚠️ 顺序不能反：原先「先 setError 再 clearError」＝ 提示刚显示就被抹掉，
    //    「超出的未加入」这句用户从来没看见过（2026-09-29 顺带修正）。
    clearError();
    if (exceeded) setError('参考图片最多 9 张，超出的未加入');
    stashToLibrary(added);   // 与主工作台同口径：顺手收进服务端参考图库
  });
  // ★ 「@ 引用参考图」：在提示词里打 @ 直接弹出图库选择器。
  //    触发条件收窄为「行首或空白符后的裸 @」—— 邮箱（a@b.com）这类中间的 @ 不该抢。
  //    只监听 input（拿得到插入语义），不监听 keydown：粘贴/输入法/右键菜单都能触发。
  /**
   * 挂 @ 触发到任意提示词输入框。主工作台与批量弹窗共用同一条规则；
   * 差别只在落点（'mention' → state.files / 'mention-batch' → state.batchFiles）。
   */
  function bindMentionTrigger(id, target, sync) {
    $(id).addEventListener('input', () => {
      sync();   // ★ P3：先按提示词的当前内容对齐参考图列表
      const area = $(id);
      const caret = area.selectionStart ?? -1;
      if (caret < 1 || area.value[caret - 1] !== '@') return;
      const before = caret >= 2 ? area.value[caret - 2] : '\n';
      if (!/[\s\n]/.test(before)) return;   // 前一个字符不是空白 ⇒ 是词中间的 @，不触发
      mentionCaret = caret - 1;
      openLibPick(target).catch((error) => setError(error.message || '参考图库加载失败'));
    });
  }
  bindMentionTrigger('prompt', 'mention', syncMentionsFromPrompt);
  // 批量弹窗的提示词框也要能 @（工单 v2：批量一起修）。
  // 批量语义是「本批每条任务都带同一组图」，所以 @ 选的图同样进 batchFiles，
  // 标记插在当前行；删标记会让它从整批里撤掉（由 syncBatchMentions 对账）。
  bindMentionTrigger('batchPrompts', 'mention-batch', syncBatchMentions);
  $('libPickSearchBtn').addEventListener('click', () => {
    libPick.keyword = $('libPickSearch').value.trim();
    loadLibPick(1).catch((error) => setError(error.message));
  });
  $('libPickSearch').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    libPick.keyword = $('libPickSearch').value.trim();
    loadLibPick(1).catch((error) => setError(error.message));
  });
  $('libPickConfirm').addEventListener('click', () => {
    withBusy($('libPickConfirm'), '加入中…', confirmLibPick)
      .catch((error) => setError(error.message || '加入参考图失败'));
  });
  $('materialList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.act === 'material-use') {
      applyMaterial(id).catch((error) => setError(error.message || '套用素材失败'));
      return;
    }
    const material = state.materials.find((item) => item.id === id);
    const ok = await askConfirm({
      title: '删除素材',
      body: [
        `删除素材「${material?.title || '未命名'}」？`,
        '只删本机这一份，服务端没有任何副本 —— 删掉就找不回来了。',
      ].join('\n'),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    if (!saveMaterials(state.materials.filter((item) => item.id !== id))) return;
    renderMaterials();
  });
  // 关闭按钮走统一入口，避免每个 dialog 各自写一遍
  for (const button of document.querySelectorAll('[data-dlg-close]')) {
    button.addEventListener('click', () => closeDialog(button.dataset.dlgClose));
  }
  $('jobSearch').addEventListener('input', () => {
    state.jobFilter = $('jobSearch').value;
    storageSet(JOB_FILTER_KEY, state.jobFilter);   // 浏览状态：刷新后筛选词还在
    renderJobs();
  });
  $('jobLimit').addEventListener('change', () => {
    state.jobLimit = Number($('jobLimit').value) || 20;
    storageSet(JOB_LIMIT_KEY, String(state.jobLimit));   // 浏览状态：刷新后每页条数还在
    const epoch = state.epoch;
    withBusy($('refreshJobs'), '刷新中…', () => refreshJobs()).catch((error) => {
      if (epoch === state.epoch) setError(error.message, error);
    });
  });
  $('pullModels').addEventListener('click', () => {
    const epoch = state.epoch;
    withBusy($('pullModels'), '加载中…', async () => {
      const models = await requestJson('/v1/models');
      if (epoch !== state.epoch) return;
      state.models = Array.isArray(models?.data) ? models.data : Array.isArray(models) ? models : [];
      fillModels();
      const names = state.models.map((item) => item.name || item.id).join(' / ');
      showConnection(`模型可用：${names || 'ok'}`, 'good');
    }).catch((error) => { if (epoch === state.epoch) { setError(error.message, error); showConnection('拉模型失败', 'bad'); } });
  });
  $('ping').addEventListener('click', () => {
    const epoch = state.epoch;
    withBusy($('ping'), '连接中…', () => ping()).catch((error) => {
      if (epoch === state.epoch) { setError(error.message, error); showConnection(error.message || '测连通失败', 'bad'); }
    });
  });
  $('model').addEventListener('change', syncModelChoice);
  $('seconds').addEventListener('change', () => syncDurationModel(true));
  $('autoStart').addEventListener('change', () => { state.autoStart = $('autoStart').checked; renderCostNote(); });
  $('images').addEventListener('change', (event) => {
    const incoming = Array.from(event.target.files || []);
    const unique = incoming.filter((file) => !state.files.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified));
    // 真正能进列表的那些（剩下的被 9 张上限挡掉，不入库 —— 免得用户看着列表里没这张、图库里却多出来）。
    const kept = unique.slice(0, Math.max(0, 9 - state.files.length));
    const exceeded = unique.length > kept.length;
    state.files = [...state.files, ...kept];
    event.target.value = '';
    renderFiles();
    renderCapability();
    stashToLibrary(kept);   // 顺手收进服务端参考图库（后台跑，不阻塞选图）
    if (exceeded) setError('参考图片最多 9 张，超出的文件未加入。');
  });
  $('create').addEventListener('click', createTask);
  $('tabRun').addEventListener('click', () => renderTab('run'));
  $('tabJobs').addEventListener('click', () => renderTab('jobs'));
  $('refreshCurrent').addEventListener('click', () => {
    const epoch = state.epoch;
    // 手动刷新时把参考图缓存也失效掉 —— 否则「图已经被清理了」这种变化要等下次切换任务才看得到。
    refImagesTaskId = '';
    withBusy($('refreshCurrent'), '刷新中…', () => loadJob(state.currentId)).catch((error) => {
      if (epoch === state.epoch) { setError(error.message, error); showConnection('读取任务失败', 'bad'); }
    });
  });
  $('cancelCurrent').addEventListener('click', () => {
    const epoch = state.epoch;
    withBusy($('cancelCurrent'), '取消中…', () => cancelJob(state.currentId, {
      confirmText: '确认取消当前任务？已提交到上游的任务无法退款。',
    })).catch((error) => { if (epoch === state.epoch) setError(error.message, error); });
  });
  $('clearCurrent').addEventListener('click', () => {
    const epoch = state.epoch;
    withBusy($('clearCurrent'), '清除中…', () => clearJob(state.currentId, {
      confirmText: '确认清除当前任务？排队中的会取消并退款，已在生成的不退款。\n（清除 = 取消 + 打软删除标记；计费凭据仍保留在服务端，按 id 可查。）',
    })).catch((error) => { if (epoch === state.epoch) setError(error.message, error); });
  });
  $('download').addEventListener('click', (event) => {
    // <a download> 已经有 object URL，直接让浏览器下载；没有就先去取。
    if ($('download').getAttribute('href')) return;
    event.preventDefault();
    downloadCurrent();
  });
  $('previewUnwatermarked').addEventListener('click', () => {
    const epoch = state.epoch;
    withBusy($('previewUnwatermarked'), '加载中…', () => openUnwatermarkedPreview()).catch((error) => {
      if (epoch === state.epoch) setError(error.message, error);
    });
  });
  // 关弹窗（点「关闭」/按 Esc 都会触发 <dialog> 的 close）就断源，否则后台还在下整段视频。
  $('uwDlg').addEventListener('close', teardownUnwatermarkedPreview);
  // 播放失败多半是上游直链过期 —— 这一版是临时地址，说过期要说清楚该改用什么。
  $('uwPlayer').addEventListener('error', () => {
    if (!$('uwDlg').open) return;
    setUwError(state.uwKind === 'upstream'
      ? '这一版播放失败：上游直链是临时地址，可能已经过期。请用左侧「下载成片」取服务端归档版（归档优先存无水印那一版）。'
      : '这一版播放失败：归档文件读取中断，稍后重试或点左侧「下载成片」。');
  });
  $('refreshJobs').addEventListener('click', () => {
    const epoch = state.epoch;
    withBusy($('refreshJobs'), '刷新中…', () => refreshJobs()).catch((error) => {
      if (epoch === state.epoch) setError(error.message, error);
    });
  });
  $('startQueued').addEventListener('click', startAll);
  $('clearJobs').addEventListener('click', clearAllJobs);
  $('jobRows').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.dataset.id;
    const act = button.dataset.act;
    const epoch = state.epoch;
    const run = async () => {
      if (act === 'start') {
        const ok = await askConfirm({
          title: `把 #${id} 提交到上游`,
          body: [
            '提交后开始消耗上游账号额度。',
            '该任务的积分在创建时已冻结 —— 提交不会再扣一次。',
          ].join('\n'),
          confirmText: '提交上游',
        });
        if (!ok) return;
        await startJob(id);
      } else if (act === 'cancel') {
        await cancelJob(id, { confirmText: `确认取消 #${id}？已提交到上游的任务无法退款。` });
      } else if (act === 'clear') {
        await clearJob(id, { confirmText: `确认清除 #${id}？排队中的会取消并退款，已在生成的不退款。` });
      } else if (act === 'resubmit') {
        // 回填动作本身**不花钱、不建任务**：只把原任务参数（和暂存的参考图）搬进新建表单。
        // 真正的提交仍然要用户点「加入任务」并过确认框 —— 这是工单选的「稳」方案，
        // 不做「一键直建」（那种点错一次就白扣积分）。
        await refillFromJob(id);
      } else if (act === 'status') {
        state.currentId = String(id);
        renderTab('run');
        await loadJob(id, { select: true });
        showConnection(`已读取 #${id}`, 'good');
      }
    };
    withBusy(button, '处理中…', run).catch((error) => { if (epoch === state.epoch) setError(error.message, error); });
  });

  window.addEventListener('beforeunload', () => {
    stopPolling();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    if (state.uwObjectUrl) URL.revokeObjectURL(state.uwObjectUrl);
    // 只清内存。落盘的令牌归「记住令牌」开关管，这里顺手擦掉的话勾了也永远重连不上。
    state.token = '';
  });

  // ─────────────────────────────────────────────────────────── 首屏

  loadMaterials();
  renderMaterials();
  fillBatchOptions();
  renderStats();
  renderTopBalance();
  renderCostNote();
  renderBatchCost();
  renderTab('run');
  // 首屏必须过一遍 syncButtons()：受管按钮的初始可用性只在 HTML 里写了 create，
  // 其余（兑换/批量创建/刷新列表…）默认是「可点」的，不在这里收一次就会在未连接时
  // 给出一个点了必然报错的按钮。
  syncButtons();

  // 浏览状态回填到控件上。state 是从盘上读的，但控件还停在 HTML 里的默认值 ——
  // 不回填就会出现「每页 100 条但下拉显示 20 条」这种自相矛盾的界面。
  if (state.jobFilter) $('jobSearch').value = state.jobFilter;
  $('jobLimit').value = String(state.jobLimit);

  /**
   * 自动重连：只有用户此前显式勾过「记住令牌」才会有落盘的值。
   * 令牌可能已经失效 / 被停用 / 过期，所以失败是**正常路径** —— 走 connect() 自己的错误分支，
   * 不要再叠一个「自动登录失败」的弹窗（用户没主动做任何事，弹窗只会莫名其妙）。
   */
  (() => {
    if (FILE_PREVIEW) return;
    const saved = storageGet(TOKEN_KEY);
    if (!saved) return;
    $('apiKey').value = saved;
    $('rememberToken').checked = true;
    connect();
  })();
})();

/**
 * ── 参考图库（服务端）—— 「视频任务」页与「脚本分镜」页共用的取图层 ──────────
 *
 * 为什么单独一个 IIFE：上下两块各自是独立的 IIFE，互相看不见对方的函数，
 * 而参考图库两边都要用（主工作台要「从图库选参考图」，分镜页要「用图库里的图当参考图」）。
 * 与其复制两份，不如在这里暴露一个最小的共享面（挂在 window.DolaRefLib）。
 *
 * 三条约定：
 *   ① 图片地址必须走**短期凭证通道** —— <img> 没法带 Authorization 头，
 *      把后台 JWT 塞进 query 会让它落进访问日志、浏览器历史和 Referer
 *      （成片库那边已经论证过，见 server/media-routes.js 的文件头）。
 *      凭证 10 分钟有效，本模块缓存并在快过期时自动重领。
 *   ② 权限：所有接口都要求 refimage:list。403 时**明确报错**，
 *      不给一个空列表 —— 空列表会被误读成「图库是空的」。
 *   ③ 不做本地缓存：图库是服务端资产，缓存只会让「刚收进去的图看不到」。
 */
(() => {
  'use strict';

  const ADMIN_TOKEN_KEY = 'admin_token';
  /** 上游单次最多接受 9 张参考图（见 server/dola/reference-images.js 的 IMAGE_MAX_COUNT）。 */
  const REF_MAX = 9;
  /** 服务端凭证 10 分钟，这里留 1 分钟余量提前重领。 */
  const TICKET_TTL_MS = 9 * 60 * 1000;

  let streamBase = '';
  let ticketAt = 0;

  function token() {
    try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
  }

  async function adminFetch(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
    const t = token();
    if (!t) throw Object.assign(new Error('未登录后台：请先到 /login 登录管理后台'), { status: 401 });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      throw new Error(`网络请求失败：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON 响应：按 HTTP 码报错 */ }
    if (!response.ok || payload?.ok === false) {
      throw Object.assign(new Error(payload?.message || `请求失败（HTTP ${response.status}）`), {
        status: response.status, code: payload?.code || '',
      });
    }
    return payload || {};
  }

  async function ensureTicket(force = false) {
    if (!force && streamBase && Date.now() - ticketAt < TICKET_TTL_MS) return streamBase;
    const res = await adminFetch('/api/reference-images/ticket', { method: 'POST', body: {} });
    streamBase = res.streamBase || '';
    ticketAt = Date.now();
    return streamBase;
  }

  /** 缩略图最长边。选择器卡片 58px、图库卡片几十像素，256 在 2x 屏也够。 */
  const THUMB_SIZE = 256;

  /**
   * 库记录的**缩略图**地址（`?w=` 走服务端现生成并缓存）。**必须在 ensureTicket 之后调用**，否则返回空串。
   *
   * ⚠️ 别改回原图：卡片展示位只有 58px，而库图原图 1.8–5.2MB。选择器一打开就并发
   * 拉 14 张原图（≈57MB）——图没到之前卡片全是空框，点「加入参考图」还要等十几秒，
   * 用户会以为这个入口坏了 / 是空的（2026-09-29 实测：blob 读回来用了 10.8 秒）。
   * 走缩略图后单张 16KB 量级，同一个弹窗从 57MB 降到几百 KB。
   */
  const src = (row) => (streamBase && row ? `${streamBase}/${row.id}?w=${THUMB_SIZE}` : '');

  async function list({ keyword = '', page = 1, pageSize = 24 } = {}) {
    await ensureTicket();
    const query = new URLSearchParams({ keyword, page: String(page), pageSize: String(pageSize) });
    return adminFetch(`/api/reference-images?${query.toString()}`);
  }

  /**
   * 取图库某张图的字节。
   * 主工作台要用它把库里的图**还原成 File**：视频任务走 /v1/videos 的 multipart
   * （input_reference 文件字段），服务端不接受「图库 id」这种形状。
   * 还原成 File 后提交路径一行都不用改 —— 少一条分支就少一处会走歪的地方。
   */
  async function fetchBlob(row) {
    const t = token();
    const res = await fetch(`/api/reference-images/${row.id}/file`, {
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
    if (!res.ok) throw new Error(`读取参考图失败（HTTP ${res.status}）`);
    return res.blob();
  }

  /** 参考图「指向」的显示名。与 server/routes/scripts.js 的三种 kind 一一对应。 */
  function chipLabel(ref) {
    if (!ref) return '';
    if (ref.kind === 'shot') return '当前分镜图';
    if (ref.kind === 'library') return ref.name || `图库 #${ref.id}`;
    if (ref.kind === 'url') return ref.name || '直链图';
    return String(ref.kind || '');
  }

  window.DolaRefLib = {
    REF_MAX, adminFetch, ensureTicket, src, list, fetchBlob, chipLabel,
    resetTicket() { streamBase = ''; ticketAt = 0; },
  };
})();

/**
 * ── 脚本分镜页（独立 IIFE）──────────────────────────────────────────────
 *
 * 这一页与上面的「视频任务」页是**两套鉴权**，不要混用：
 *   视频任务 → /v1/*，用 dv_ 用户令牌（页面自己管，见 state.token）
 *   脚本分镜 → /api/scripts/*，用后台管理员 JWT（localStorage['admin_token']）
 * 两者同源（同一个 8788），所以这里可以直接读 localStorage 拿到管理员令牌，
 * 不需要后端再加任何桥接接口。
 *
 * 能力对齐 admin/web/src/views/ScriptStudio.vue（257 行），逐个接口对应：
 *   生成脚本   → POST   /api/scripts/generate                    (script:generate)
 *   脚本列表   → GET    /api/scripts                             (script:list)
 *   脚本详情   → GET    /api/scripts/:id                         (script:list)
 *   保存修改   → PATCH  /api/scripts/:id                         (script:update)
 *   删除脚本   → DELETE /api/scripts/:id                         (script:delete)
 *   创建视频   → POST   /api/scripts/:id/shots/:seq/to-video     (dola:create)
 *   扣费令牌   → GET    /api/tokens/options                      （只要求登录）
 *   档位/模型  → GET    /api/scripts/config                      (script:list)
 *
 * 刻意不做的事：
 *   - 不自己记账扣费：to-video 的服务端按定价扣积分，页面只回显 taskId。
 *   - 不传 points：服务端明确拒绝调用方指定积分（2026-09-26 起）。
 *   - 不在前端伪造权限：权限点取自 GET /api/auth/me；取不到时放行按钮，
 *     让服务端 403 给出权威答复，而不是在前端瞎猜一个「你没有权限」。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // 页面里没有脚本分镜这套 DOM（例如 test.js 被别的页面引用）就直接退出，别抛错。
  if (!$('pageTabScript') || !$('page-script')) return;

  const ADMIN_TOKEN_KEY = 'admin_token';
  const PAGE_KEY = 'video-api-workbench-page';
  /**
   * 上次打开的脚本 id（2026-09-28 用户要求「出图历史也要持久化」）。
   *
   * 出图历史本身是**服务端**存的（`dola_script_shot_images`，图字节还会自动收进
   * 参考图库落本地文件），所以数据从来没丢过 —— 真正丢的是**路径**：
   * 刷新后编辑器是空的、没选中任何脚本，那个分镜的「出图历史」根本点不到。
   * 这里只记住「你上次在看哪个脚本」，让它刷新后还能回到原处。
   */
  const SCRIPT_ID_KEY = 'video-api-workbench-script-id';
  const RATIOS = ['16:9', '9:16', '1:1'];
  const STATUS_LABEL = { ready: '可编辑', generating: '生成中', failed: '失败', draft: '草稿' };
  const STATUS_TONE = { ready: 'ok', failed: 'bad', generating: 'warn' };

  const state = {
    /** null = 还没取到权限点；数组 = 已取到。见文件头「不在前端伪造权限」。 */
    perms: null,
    /**
     * provider: 'openai' | 'dola'
     *   openai → 需要 base_url + api_key + model，configured 由服务端算好
     *   dola   → **不需要任何 LLM 配置**，借号池里的 dola 网页 agent；
     *            configured 恒等于 enabled，所以这里不用额外判空
     * supportsImages → 只有 dola 通道能给分镜图（外部 LLM 没有文生图契约）
     */
    config: {
      provider: 'openai', enabled: false, configured: false, model: '',
      timeoutMs: 120000, supportedSeconds: [15, 30], chat: null, supportsImages: false,
    },
    scripts: [],
    current: null,
    tokens: [],
    dirty: false,
    busy: false,
    /** 正在出图的分镜 seq。逐条独立，不阻塞别的行。 */
    imageBusy: new Set(),
    /** 出图历史弹层当前对应的分镜（从历史里换图时要拿它的 seq）。 */
    histShot: null,
    /** 参考图弹层当前对应的分镜，以及它的**草稿**（取消时不该改到表格里的值）。 */
    refShot: null,
    refDraft: [],
    refTab: 'shot',
    refHistory: [],
    refLib: { rows: [], total: 0, page: 1, pageSize: 24, keyword: '' },
    booted: false,
  };

  const supportedSeconds = () => (
    Array.isArray(state.config.supportedSeconds) && state.config.supportedSeconds.length
      ? state.config.supportedSeconds
      : [15, 30]
  );
  const can = (perm) => {
    if (!state.perms) return true;
    return state.perms.includes('*') || state.perms.includes(perm);
  };
  const statusLabel = (v) => STATUS_LABEL[v] || v || '草稿';
  const statusTone = (v) => STATUS_TONE[v] || '';
  const fmtDate = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
  /** 已派发且未终态的视频任务会锁住这一行的画面/时长/比例（服务端同样拒绝改，见 scripts.js）。 */
  const locked = (row) => Boolean(row?.videoTaskId && row.videoTaskStatus && !['failed', 'cancelled'].includes(row.videoTaskStatus));

  // ───────────────────────────────────────────────────────── 请求层
  function adminToken() {
    try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
  }
  async function adminRequest(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
    const token = adminToken();
    if (!token) {
      throw Object.assign(new Error('未登录后台：请先到 /login 登录管理后台'), { status: 401 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      throw new Error(`网络请求失败：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON 响应：下面统一按 HTTP 码报错 */ }
    if (!response.ok || payload?.ok === false) {
      throw Object.assign(new Error(payload?.message || `请求失败（HTTP ${response.status}）`), {
        status: response.status, code: payload?.code || '',
      });
    }
    return payload || {};
  }

  // ───────────────────────────────────────────────────────── 提示 / 忙碌
  let toastTimer = 0;
  function ssToast(message, tone = 'bad') {
    const box = $('ssMsg');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('good', tone === 'good');
    box.classList.toggle('show', Boolean(message));
    clearTimeout(toastTimer);
    if (message) toastTimer = setTimeout(() => box.classList.remove('show'), 6000);
  }
  function ssBusy(button, text, fn) {
    if (!button) return Promise.resolve().then(fn);
    const original = button.textContent;
    const wasDisabled = button.disabled;
    button.disabled = true;
    if (text) button.textContent = text;
    return Promise.resolve().then(fn).finally(() => {
      // 还原成进入时捕获的值，而不是硬编码 false —— 按钮的可用性由 syncComposer/renderCurrent 说了算。
      button.disabled = wasDisabled;
      button.textContent = original;
    });
  }
  /** 统一兜底：401 只亮「未登录后台」，其余才弹具体报错。 */
  async function guard(fn, label) {
    try { await fn(); return true; } catch (error) {
      if (error.status === 401) { $('ssAuthWarn').classList.remove('hidden'); return false; }
      ssToast(`${label}：${error.message}`);
      return false;
    }
  }

  // ───────────────────────────────────────────────────────── 渲染
  function renderScriptList() {
    const box = $('ssList');
    box.innerHTML = '';
    $('ssListEmpty').classList.toggle('hidden', state.scripts.length > 0);
    for (const item of state.scripts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ss-item${state.current?.id === item.id ? ' active' : ''}`;
      btn.dataset.id = String(item.id);
      const title = document.createElement('span');
      title.className = 'ss-title';
      title.textContent = item.title || item.topic || `脚本 #${item.id}`;
      const tag = document.createElement('span');
      tag.className = `ss-tag ${statusTone(item.status)}`.trim();
      tag.textContent = statusLabel(item.status);
      const time = document.createElement('small');
      time.textContent = fmtDate(item.updatedAt);
      btn.append(title, tag, time);
      box.appendChild(btn);
    }
  }

  function renderTokens() {
    const sel = $('ssToken');
    const keep = sel.value;
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = state.tokens.length ? '选择令牌' : '暂无可用令牌';
    sel.appendChild(ph);
    for (const t of state.tokens) {
      const opt = document.createElement('option');
      opt.value = String(t.id);
      opt.textContent = `${t.name || t.prefix}（${t.points} 分）`;
      sel.appendChild(opt);
    }
    if (keep && state.tokens.some((t) => String(t.id) === keep)) sel.value = keep;
  }

  function cellTextarea(value, index, field, disabled, rows, placeholder) {
    const el = document.createElement('textarea');
    el.value = value ?? '';
    el.rows = rows;
    el.placeholder = placeholder;
    el.disabled = disabled;
    el.dataset.idx = String(index);
    el.dataset.field = field;
    return el;
  }
  function cellSelect(value, index, field, disabled, options) {
    const el = document.createElement('select');
    let matched = false;
    for (const { value: v, label } of options) {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = label;
      if (String(v) === String(value)) matched = true;
      el.appendChild(opt);
    }
    // 服务端档位收窄后，旧分镜里可能存着不再支持的时长。
    // 补一个显式「不支持」的选项而不是静默改成别的档 —— 改档会改扣费，必须让用户自己看见并决定。
    if (!matched) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = `${value}（不支持）`;
      el.appendChild(opt);
    }
    el.value = String(value);
    el.disabled = disabled;
    el.dataset.idx = String(index);
    el.dataset.field = field;
    return el;
  }

  function renderShots() {
    const tbody = $('ssShotRows');
    tbody.innerHTML = '';
    const seconds = supportedSeconds();
    const tokenId = $('ssToken').value;
    state.current.shots.forEach((shot, index) => {
      const lock = locked(shot);
      const tr = document.createElement('tr');

      const tdSeq = document.createElement('td');
      tdSeq.textContent = String(shot.seq);

      const tdScene = document.createElement('td');
      tdScene.appendChild(cellTextarea(shot.scene, index, 'scene', lock, 3, '画面描述'));

      const tdNarr = document.createElement('td');
      tdNarr.appendChild(cellTextarea(shot.narration, index, 'narration', false, 3, '旁白 / 字幕'));

      // ── 分镜图：主图 + 候选缩略图 ──
      // 出图**不受视频任务锁定**：换图不改 scene/seconds/ratio，
      // 不影响已派发的视频任务（服务端同样只锁那三个字段）。
      const tdImage = document.createElement('td');
      if (shot.imagePath) {
        const img = document.createElement('img');
        img.className = 'ss-thumb';
        img.src = shot.imagePath;
        img.alt = `分镜 ${shot.seq} 分镜图`;
        img.title = '点击在新标签页看大图';
        img.addEventListener('click', () => window.open(shot.imagePath, '_blank', 'noopener'));
        tdImage.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'ss-thumb-empty';
        placeholder.textContent = state.config.supportsImages ? '暂无' : '通道不支持';
        tdImage.appendChild(placeholder);
      }
      if (shot.imageCandidates?.length) {
        const box = document.createElement('div');
        box.className = 'ss-cands';
        shot.imageCandidates.forEach((candidate, ci) => {
          const thumb = document.createElement('img');
          thumb.src = candidate.previewUrl || candidate.url;
          thumb.alt = `候选 ${ci + 1}`;
          thumb.title = `选这张${candidate.width ? `（${candidate.width}×${candidate.height}）` : ''}`;
          thumb.classList.toggle('on', candidate.url === shot.imagePath);
          thumb.dataset.idx = String(index);
          thumb.dataset.act = 'pick-image';
          thumb.dataset.url = candidate.url;
          box.appendChild(thumb);
        });
        tdImage.appendChild(box);
      }

      // 出图历史入口。★ 放在**分镜图格里**而不是操作列 —— 操作列的宽度是按
      // 容器算死的（见 test.html 里 .ss-shots 的注释），再塞一个按钮就会溢出，
      // 而溢出会让 sticky 的操作列盖住左边一列。这里加链接不占列宽。
      const histCount = Number(shot.imageHistoryCount) || 0;
      const hist = document.createElement('button');
      hist.type = 'button';
      hist.className = `ss-hist${histCount ? '' : ' muted'}`;
      hist.dataset.idx = String(index);
      hist.dataset.act = 'shot-history';
      hist.textContent = histCount ? `出图历史 ${histCount}` : '出图历史';
      hist.title = histCount
        ? `这个分镜出过 ${histCount} 次图，每次一组（dola 通常 4 张），可回看/回切`
        : '这个分镜还没有出过图';
      tdImage.appendChild(hist);

      // 参考图入口。和出图历史一样塞在分镜图格里 —— 操作列的宽度是按容器算死的，
      // 再塞一个按钮就会溢出，而溢出会让 sticky 的操作列盖住左边一列。
      const refs = Array.isArray(shot.referenceImages) ? shot.referenceImages : [];
      const refBtn = document.createElement('button');
      refBtn.type = 'button';
      refBtn.className = `ss-ref${refs.length ? '' : ' muted'}`;
      refBtn.dataset.idx = String(index);
      refBtn.dataset.act = 'shot-ref';
      refBtn.textContent = refs.length ? `参考图 ${refs.length} 张` : '参考图';
      refBtn.title = refs.length
        ? `创建视频任务时会带上的参考图：${refs.map((r) => DolaRefLib.chipLabel(r)).join('、')}`
        : '还没有设置参考图；创建视频任务时不会带参考图';
      tdImage.appendChild(refBtn);

      // ── 时长 / 比例 合并成一列 ──
      // 两列各自只有一个小下拉，分开占两列会把表格撑到 940px（> 容器 882px），
      // 一旦溢出，sticky 的操作列就会盖住左边一列。合并后 6 列 844px，设计
      // 宽度下不溢出，sticky 仅作窄屏兜底。
      const tdOut = document.createElement('td');
      const outBox = document.createElement('div');
      outBox.className = 'ss-out';
      outBox.appendChild(cellSelect(shot.seconds, index, 'seconds', lock,
        seconds.map((s) => ({ value: s, label: s === 15 ? '15 秒（专家）' : `${s} 秒` }))));
      outBox.appendChild(cellSelect(shot.ratio, index, 'ratio', lock,
        RATIOS.map((r) => ({ value: r, label: r }))));
      tdOut.appendChild(outBox);

      const tdOps = document.createElement('td');
      const imageBusy = state.imageBusy.has(shot.seq);
      const genImage = document.createElement('button');
      genImage.type = 'button';
      genImage.className = 'row-btn';
      genImage.dataset.idx = String(index);
      genImage.dataset.act = 'gen-image';
      genImage.textContent = imageBusy ? '出图中…' : (shot.imagePath ? '重新出图' : '生成分镜图');
      genImage.disabled = state.busy || imageBusy || !state.config.supportsImages;
      if (!state.config.supportsImages) genImage.title = '当前生成通道不支持出图：到系统设置把「脚本工作台：生成通道」改为 dola';
      tdOps.appendChild(genImage);

      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'btn small';
      submit.dataset.idx = String(index);
      submit.dataset.act = 'to-video';
      submit.textContent = lock ? `任务 #${shot.videoTaskId}` : (shot.videoTaskId ? '重试视频任务' : '创建视频任务');
      submit.disabled = state.busy || lock || !tokenId || !can('dola:create');
      tdOps.appendChild(submit);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'row-btn cancel';
      rm.dataset.idx = String(index);
      rm.dataset.act = 'remove-shot';
      rm.textContent = '移除';
      rm.disabled = state.busy || lock;
      tdOps.appendChild(rm);

      if (shot.videoTaskId) {
        const link = document.createElement('a');
        link.className = 'row-btn';
        link.href = '/media';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '成片库';
        tdOps.appendChild(link);
      }

      tr.append(tdSeq, tdScene, tdNarr, tdImage, tdOut, tdOps);
      tbody.appendChild(tr);
    });
  }

  function renderCurrent() {
    const cur = state.current;
    $('ssEditor').classList.toggle('hidden', !cur);
    $('ssEmpty').classList.toggle('hidden', Boolean(cur));
    $('ssSave').disabled = !cur || state.busy || !state.dirty || !can('script:update');
    $('ssDelete').disabled = !cur || state.busy || !can('script:delete');
    $('ssAddShot').disabled = !cur || state.busy || (cur?.shots?.length ?? 0) >= 20;

    const tag = $('ssStatusTag');
    tag.classList.toggle('hidden', !cur);
    if (cur) {
      tag.className = `ss-tag ${statusTone(cur.status)}`.trim();
      tag.textContent = statusLabel(cur.status);
    }
    $('ssHeadNote').textContent = cur
      ? `共 ${cur.shots.length} 个分镜 · 上次更新 ${fmtDate(cur.updatedAt)}`
      : '选择一个脚本，或先生成一份新脚本';
    if (!cur) { $('ssShotRows').innerHTML = ''; return; }

    $('ssTitle').value = cur.title || '';
    $('ssCurTopic').value = cur.topic || '';
    $('ssCurTone').value = cur.tone || '';
    $('ssShotMeta').textContent = `分镜 ${cur.shots.length} 个 · 时长只能使用 ${supportedSeconds().join('、')} 秒`;
    $('ssDirty').classList.toggle('hidden', !state.dirty);
    $('ssErr').textContent = cur.error ? `上次生成失败：${cur.error}` : '';
    renderShots();
  }

  function syncComposer() {
    const topic = $('ssTopic').value.trim();
    $('ssGenerate').disabled = state.busy || !can('script:generate')
      || !state.config.enabled || !state.config.configured || !topic;
  }
  function markDirty() {
    state.dirty = true;
    $('ssDirty').classList.remove('hidden');
    $('ssSave').disabled = state.busy || !can('script:update');
  }

  // ───────────────────────────────────────────────────────── 读
  async function loadMe() {
    const data = await adminRequest('/api/auth/me', { timeoutMs: 15000 });
    state.perms = Array.isArray(data.user?.permissions) ? data.user.permissions : ['*'];
    $('ssAuthWarn').classList.add('hidden');
  }
  async function loadConfig() {
    const data = await adminRequest('/api/scripts/config', { timeoutMs: 15000 });
    state.config = { ...state.config, ...data };
    const isDola = data.provider === 'dola';
    const chat = data.chat || null;
    if (isDola) {
      // dola 通道没有「模型」可填 —— 显示通道 + 可用账号数才是真正决定能不能用的东西。
      $('ssModelNote').textContent = chat?.available
        ? `通道：dola 网页 agent（${chat.accounts} 个可用账号）`
        : `通道：dola 网页 agent（号池不可用${chat?.error ? `：${String(chat.error).slice(0, 60)}` : ''}）`;
    } else {
      $('ssModelNote').textContent = data.configured ? `模型：${data.model || '已配置'}` : '未配置 LLM';
    }
    $('ssSecondsNote').textContent = `时长：${supportedSeconds().join(' / ')} 秒`;
    $('ssConfigWarn').classList.toggle('hidden', Boolean(data.enabled && data.configured));
    if (isDola) {
      $('ssConfigWarnText').textContent = chat?.available
        ? 'dola 通道已启用但号池暂时没有可用账号（需要 status=valid 且已配代理）。'
        : '请到系统设置 → 脚本工作台，把「生成通道」设为 dola 并打开「启用生成」。';
    } else {
      $('ssConfigWarnText').textContent = '请到系统设置 → 脚本工作台，启用 LLM 并填写接口地址、API Key 和模型；或把「生成通道」改为 dola 网页 agent（免配置，且能出分镜图）。';
    }
  }
  async function loadScripts() {
    const data = await adminRequest('/api/scripts?limit=100', { timeoutMs: 20000 });
    state.scripts = data.items || [];
    renderScriptList();
  }
  async function loadTokens() {
    const data = await adminRequest('/api/tokens/options', { timeoutMs: 20000 });
    state.tokens = data.items || [];
    renderTokens();
  }
  async function selectScript(id) {
    if (state.busy) return ssToast('当前操作尚未完成，请稍候');
    if (state.dirty) {
      const ok = await askConfirm({
        title: '放弃未保存的修改',
        body: [
          '当前这份脚本还有没保存的修改。',
          '切换后会丢失这些修改 —— 要先保存吗？',
        ].join('\n'),
        confirmText: '放弃修改并切换',
        danger: true,
      });
      if (!ok) return;
    }
    const data = await adminRequest(`/api/scripts/${id}`, { timeoutMs: 20000 });
    state.current = data.item;
    // 记住「上次在看哪个脚本」，刷新后好回到这里（出图历史挂在分镜上，没选中脚本就够不到）。
    try { localStorage.setItem(SCRIPT_ID_KEY, String(id)); } catch { /* 隐私模式下写不了，忽略 */ }
    // 换脚本时清空出图中的标记：那是**上一个脚本**的行，留着会让新脚本里
    // 序号相同的分镜永远显示「出图中…」。
    state.imageBusy.clear();
    $('ssTopic').value = state.current.topic || '';
    $('ssTone').value = state.current.tone || '';
    $('ssShotCount').value = state.current.shots.length || 6;
    state.dirty = false;
    renderCurrent();
    renderScriptList();
    syncComposer();
  }

  // ───────────────────────────────────────────────────────── 写
  async function generate() {
    const topic = $('ssTopic').value.trim();
    if (!topic) return;
    state.busy = true;
    renderCurrent();
    syncComposer();
    await ssBusy($('ssGenerate'), '生成中…', async () => {
      const ok = await guard(async () => {
        const data = await adminRequest('/api/scripts/generate', {
          method: 'POST',
          body: { topic, tone: $('ssTone').value.trim(), shotCount: Number($('ssShotCount').value || 6) },
          // LLM 生成是分钟级：服务端自己的超时 + 30 秒缓冲，别在客户端先砍断。
          timeoutMs: Math.max(120000, Number(state.config.timeoutMs || 120000) + 30000),
        });
        state.current = data.item;
        $('ssShotCount').value = state.current.shots.length;
        state.dirty = false;
        await loadScripts();
        renderCurrent();
        ssToast(`脚本生成完成：${state.current.shots.length} 个分镜`, 'good');
      }, '脚本生成失败');
      return ok;
    });
    state.busy = false;
    renderCurrent();
    syncComposer();
  }

  function payload() {
    const cur = state.current;
    return {
      title: cur.title, topic: cur.topic, tone: cur.tone,
      shots: cur.shots.map(({ id, scene, narration, seconds, ratio, imagePrompt, imagePath }) => ({
        id, scene, narration, seconds: Number(seconds), ratio, imagePrompt,
        // 回传 imagePath 是为了让「在候选里换一张」能被保存；
        // 服务端在缺省时会保留库里已有的值，所以不传也不会把图弄丢。
        imagePath: imagePath || '',
        // ⚠️ 参考图**故意不回传**：它有自己的专用端点（/shots/:seq/reference-images），
        // 服务端在缺省时会保留库里已有的值。回传反而会把「表格里的草稿」
        // 顺手写库，而参考图的草稿和保存是两件事。
      })),
    };
  }
  async function save({ quiet = false } = {}) {
    if (!state.current || !can('script:update')) return false;
    state.busy = true;
    renderCurrent();
    const ok = await ssBusy($('ssSave'), '保存中…', () => guard(async () => {
      const data = await adminRequest(`/api/scripts/${state.current.id}`, { method: 'PATCH', body: payload(), timeoutMs: 30000 });
      state.current = data.item;
      state.dirty = false;
      await loadScripts();
      renderCurrent();
      if (!quiet) ssToast('脚本已保存', 'good');
    }, '保存失败'));
    state.busy = false;
    renderCurrent();
    return ok;
  }
  async function removeScript() {
    if (!state.current || state.busy) return;
    const ok = await askConfirm({
      title: '删除脚本',
      body: [
        `删除「${state.current?.topic || '未命名脚本'}」及其全部分镜？`,
        '出图历史挂在分镜上，会一起删掉。此操作不可撤销。',
      ].join('\n'),
      confirmText: '删除脚本',
      danger: true,
    });
    if (!ok) return;
    state.busy = true;
    renderCurrent();
    await ssBusy($('ssDelete'), '删除中…', () => guard(async () => {
      await adminRequest(`/api/scripts/${state.current.id}`, { method: 'DELETE', timeoutMs: 30000 });
      state.current = null;
      state.dirty = false;
      renderCurrent();
      await loadScripts();
      ssToast('已删除', 'good');
    }, '删除失败'));
    state.busy = false;
    renderCurrent();
  }
  function addShot() {
    if (!state.current) return;
    const seconds = supportedSeconds();
    state.current.shots.push({
      id: null, seq: state.current.shots.length + 1, scene: '', narration: '',
      seconds: seconds.includes(30) ? 30 : seconds[0], ratio: '16:9',
      imagePrompt: '', imageCandidates: [], referenceImages: [],
      videoTaskId: null, videoTaskStatus: null,
    });
    markDirty();
    renderShots();
    $('ssShotMeta').textContent = `分镜 ${state.current.shots.length} 个 · 时长只能使用 ${supportedSeconds().join('、')} 秒`;
    $('ssAddShot').disabled = state.current.shots.length >= 20;
  }
  function removeShot(index) {
    const shot = state.current?.shots[index];
    if (!shot) return;
    if (shot.videoTaskId) return ssToast('已创建视频任务的分镜不能移除');
    state.current.shots.splice(index, 1);
    state.current.shots.forEach((s, i) => { s.seq = i + 1; });
    markDirty();
    renderShots();
  }
  async function toVideo(index) {
    const shot = state.current?.shots[index];
    if (!shot || state.busy) return;
    const tokenId = Number($('ssToken').value);
    if (!tokenId) return ssToast('请先选择扣费令牌');
    if (!can('dola:create')) return ssToast('当前账号没有创建视频任务的权限');
    // 有未保存修改时必须先落库：服务端按分镜当前值建任务，用页面上的草稿去建会对不上。
    if (state.dirty) {
      if (!can('script:update')) return ssToast('请先保存修改后再创建视频任务');
      if (!await save({ quiet: true })) return;
    }
    state.busy = true;
    renderShots();
    await guard(async () => {
      const data = await adminRequest(`/api/scripts/${state.current.id}/shots/${shot.seq}/to-video`, {
        method: 'POST', body: { tokenId }, timeoutMs: 60000,
      });
      shot.videoTaskId = data.taskId;
      shot.videoTaskStatus = data.status || 'queued';
      state.dirty = false;
      renderCurrent();
      // 带上参考图张数：不然「到底带没带参考图」只能靠翻接口日志猜。
      const refNote = data.referenceImageCount ? `，带 ${data.referenceImageCount} 张参考图` : '';
      ssToast(data.duplicated ? `已存在任务 #${data.taskId}` : `视频任务已创建：#${data.taskId}${refNote}`, 'good');
    }, '创建视频任务失败');
    state.busy = false;
    renderCurrent();
  }

  // ───────────────────────────────────────────────────────── 分镜图（只有 dola 通道能给）
  /**
   * 用 dola 网页 agent 给这一条分镜出图。
   *
   * 为什么先 save 再出图：上游按**库里的** imagePrompt 出图，页面上没保存的草稿
   * 和库里不一致时，用户会看到「图和我改过的提示词对不上」这种最难查的错。
   * 和 toVideo 用同一条规矩。
   */
  async function generateImage(index) {
    const shot = state.current?.shots[index];
    if (!shot || state.busy || state.imageBusy.has(shot.seq)) return;
    if (!state.config.supportsImages) {
      return ssToast('当前生成通道不支持出图：请到系统设置把「脚本工作台：生成通道」改为 dola 网页 agent');
    }
    if (state.dirty) {
      if (!can('script:update')) return ssToast('请先保存修改后再生成分镜图');
      if (!await save({ quiet: true })) return;
    }
    state.imageBusy.add(shot.seq);
    renderShots();
    await guard(async () => {
      const data = await adminRequest(`/api/scripts/${state.current.id}/shots/${shot.seq}/image`, {
        method: 'POST',
        body: {},
        // 实测一次文生图约 30 秒（含上游排队），给足 3 分钟再判超时。
        timeoutMs: 180000,
      });
      shot.imagePath = data.imagePath || shot.imagePath;
      shot.imageCandidates = data.imageCandidates || shot.imageCandidates || [];
      // 服务端把整组写进历史后回传批次数 —— 用返回值，别在前端 +1 猜。
      if (Number.isFinite(Number(data.imageHistoryCount))) shot.imageHistoryCount = Number(data.imageHistoryCount);
      state.dirty = false;
      renderCurrent();
      // 自动收进参考图库是 best-effort，如实报数：收了几张、几张已在库、几张没成。
      const lib = data.library || {};
      const libNote = lib.stored
        ? `，其中 ${lib.stored} 张已收进参考图库`
        : lib.duplicated ? '，图库里已有这批图' : (lib.failed ? `，${lib.failed} 张未能收进图库` : '');
      ssToast(
        `分镜 ${shot.seq} 已出 ${shot.imageCandidates.length} 张候选${data.model ? `（${data.model}）` : ''}${libNote}，点缩略图换图`,
        'good',
      );
    }, '生成分镜图失败');
    state.imageBusy.delete(shot.seq);
    renderShots();
  }

  /**
   * 在一次出图的候选里换一张。
   *
   * 立刻落库而不是只改本地：候选是 4 张，「先点再记得保存」几乎必然有人忘，
   * 刷新后图又变回第一张 —— 看起来像"点了没反应"。
   */
  async function pickImage(index, url) {
    const shot = state.current?.shots[index];
    if (!shot || !url || shot.imagePath === url) return;
    if (state.busy) return ssToast('当前操作尚未完成，请稍候');
    if (!can('script:update')) return ssToast('当前账号没有修改脚本的权限');
    shot.imagePath = url;
    state.dirty = true;
    renderShots();
    const ok = await save({ quiet: true });
    ssToast(ok ? `已把分镜 ${shot.seq} 的图换成这一张` : '换图失败，已保留原图', ok ? 'good' : 'bad');
  }

  // ───────────────────────────────────────────────────────── 出图历史
  /**
   * 出图历史是**按批**的，不是一条图片流水。
   *
   * dola 一次文生图固定给一组（实测 4 张），所以服务端**一次生成存一行**。
   * 这里也必须按批成块渲染：把各批的 images 拍平成一个列表，
   * 就丢了「这 4 张出自同一次生成」的语义 —— 那正是要避免的「格式错」。
   */
  function renderImageHistory(data) {
    const box = $('imgHistBody');
    box.innerHTML = '';
    const items = Array.isArray(data.items) ? data.items : [];
    const expected = Number(data.expectedCount) || 4;
    $('imgHistNote').textContent = items.length
      ? `共出过 ${items.length} 次图，每次一组（dola 通常给 ${expected} 张）。点任意一张即可切回，成为这个分镜当前用的图。`
      : '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '这个分镜还没有出过图。回表格点「生成分镜图」试试。';
      box.appendChild(empty);
      return;
    }
    for (const batch of items) box.appendChild(historyBatchCard(batch, expected));
  }

  function historyBatchCard(batch, expected) {
    const card = document.createElement('section');
    card.className = `ih-batch${batch.isCurrent ? ' current' : ''}`;

    const head = document.createElement('div');
    head.className = 'ih-head';
    const title = document.createElement('b');
    title.textContent = `第 ${batch.id} 批`;
    head.appendChild(title);

    const tags = [`${batch.imageCount}/${expected} 张`, fmtDate(batch.createdAt)];
    if (batch.model) tags.push(batch.model);
    if (batch.ms) tags.push(`${(batch.ms / 1000).toFixed(1)}s`);
    if (batch.accountLabel) tags.push(`号 ${batch.accountLabel}`);
    for (const text of tags) {
      const span = document.createElement('span');
      span.className = 'ih-tag';
      span.textContent = text;
      head.appendChild(span);
    }
    // 张数不是 4 就明说。宁可显示「3/4 张」，也不要假装是 4 张 —— 那才是格式错。
    if (batch.imageCount !== expected) {
      const warn = document.createElement('span');
      warn.className = 'ih-tag warn';
      warn.textContent = `上游本次只给了 ${batch.imageCount} 张`;
      head.appendChild(warn);
    }
    if (batch.isCurrent) {
      const on = document.createElement('span');
      on.className = 'ih-tag on';
      on.textContent = '使用中';
      head.appendChild(on);
    }
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'ih-grid';
    for (const img of batch.images) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ih-img${img.url === batch.usedUrl ? ' on' : ''}`;
      btn.dataset.act = 'use-history-image';
      btn.dataset.historyId = String(batch.id);
      btn.dataset.url = img.url;
      btn.title = `用这一张${img.width ? `（${img.width}×${img.height}）` : ''}`;
      const im = document.createElement('img');
      im.src = img.previewUrl || img.url;
      im.alt = `第 ${batch.id} 批的候选图`;
      im.loading = 'lazy';
      btn.appendChild(im);
      grid.appendChild(btn);
    }
    card.appendChild(grid);

    if (batch.prompt) {
      const p = document.createElement('p');
      p.className = 'ih-prompt';
      p.textContent = `提示词：${batch.prompt}`;
      card.appendChild(p);
    }
    return card;
  }

  async function loadImageHistory(shot) {
    const data = await adminRequest(`/api/scripts/${state.current.id}/shots/${shot.seq}/images`, { timeoutMs: 20000 });
    renderImageHistory(data);
    return data;
  }

  async function openImageHistory(index) {
    const shot = state.current?.shots[index];
    if (!shot) return;
    if (!can('script:list')) return ssToast('当前账号没有查看脚本的权限');
    state.histShot = shot;
    $('imgHistTitle').textContent = `分镜 ${shot.seq} · 出图历史`;
    $('imgHistNote').textContent = '加载中…';
    $('imgHistBody').innerHTML = '';
    $('imgHistError').textContent = '';
    if (!$('imgHistDlg').open) $('imgHistDlg').showModal();
    try {
      await loadImageHistory(shot);
    } catch (error) {
      $('imgHistNote').textContent = '';
      $('imgHistError').textContent = error.message;
    }
  }

  /**
   * 从历史里挑一张切回当前图。
   *
   * 走服务端端点而不是本地 PATCH：服务端会**校验这张图确实属于那一批**
   * （IMAGE_NOT_IN_BATCH），否则可以把任意 URL 写进当前值，历史与当前值就脱钩了。
   */
  async function useHistoryImage(historyId, url) {
    const shot = state.histShot;
    if (!shot || !historyId || !url) return;
    if (!can('script:update')) return ssToast('当前账号没有修改脚本的权限');
    await guard(async () => {
      const data = await adminRequest(
        `/api/scripts/${state.current.id}/shots/${shot.seq}/images/${historyId}/use`,
        { method: 'POST', body: { url }, timeoutMs: 30000 },
      );
      shot.imagePath = data.imagePath || url;
      shot.imageCandidates = data.imageCandidates || shot.imageCandidates;
      renderCurrent();
      ssToast(`已切回第 ${historyId} 批的这张图`, 'good');
      // 重新拉一次：让「使用中」标记跟着走（标记由服务端算，前端不猜）。
      await loadImageHistory(shot);
    }, '切换历史图失败');
  }

  // ───────────────────────────────────────────────────────── 分镜参考图
  /**
   * 参考图只存「指向」，不存字节（与 server/routes/scripts.js 的
   * normalizeShotReferences 一一对应）：
   *   { kind:'shot' }                用这个分镜**当前**的分镜图（跟着换图走）
   *   { kind:'library', id, name }   参考图库里的某一张
   *   { kind:'url', url }            任意 http(s) 直链（出图历史里的候选）
   *
   * 真正下载成图片发生在**提交视频任务**那一刻。所以这里可以随便试、随便换，
   * 而「选了参考图但实际没带上」这种静默降级不会发生 —— 解析失败会直接拒绝提交并报错。
   */
  function refDraftHas(kind, key) {
    return state.refDraft.some((r) => (kind === 'url'
      ? r.kind === 'url' && r.url === key
      : kind === 'library' ? r.kind === 'library' && Number(r.id) === Number(key) : r.kind === kind));
  }

  function toggleRefDraft(ref) {
    const exists = refDraftHas(ref.kind, ref.kind === 'url' ? ref.url : ref.id);
    if (exists) {
      state.refDraft = state.refDraft.filter((r) => !(r.kind === ref.kind
        && (ref.kind === 'url' ? r.url === ref.url : ref.kind === 'library' ? Number(r.id) === Number(ref.id) : true)));
    } else {
      if (state.refDraft.length >= DolaRefLib.REF_MAX) {
        ssToast(`最多 ${DolaRefLib.REF_MAX} 张参考图（上游限制），请先去掉一张`);
        return;
      }
      state.refDraft = [...state.refDraft, ref];
    }
    renderShotRef();
  }

  function renderShotRefSelected() {
    const box = $('shotRefSelected');
    box.replaceChildren();
    const head = document.createElement('span');
    head.textContent = `已选 ${state.refDraft.length} / ${DolaRefLib.REF_MAX}：`;
    box.appendChild(head);
    if (!state.refDraft.length) {
      const none = document.createElement('span');
      none.textContent = '不使用参考图';
      box.appendChild(none);
      return;
    }
    state.refDraft.forEach((ref, index) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const text = document.createElement('span');
      text.textContent = DolaRefLib.chipLabel(ref);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.addEventListener('click', () => { state.refDraft.splice(index, 1); renderShotRef(); });
      chip.append(text, del);
      box.appendChild(chip);
    });
  }

  /** 一张可勾选的图。三个页签共用同一套 DOM 结构，样式也只有一套。 */
  function refPickLabel({ isOn, onToggle, imgSrc, name }) {
    const label = document.createElement('label');
    label.className = `ref-pick${isOn ? ' on' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isOn;
    cb.addEventListener('change', onToggle);
    const img = document.createElement('img');
    img.src = imgSrc;
    img.alt = name;
    img.loading = 'lazy';
    const span = document.createElement('span');
    span.className = 'ref-name';
    span.textContent = name;
    label.append(cb, img, span);
    return label;
  }

  function renderShotRef() {
    const body = $('shotRefBody');
    body.replaceChildren();
    for (const tab of document.querySelectorAll('[data-reftab]')) {
      tab.classList.toggle('active', tab.dataset.reftab === state.refTab);
    }
    const shot = state.refShot;
    $('shotRefError').textContent = '';

    if (state.refTab === 'shot') {
      const pane = document.createElement('div');
      pane.className = 'ref-pane';
      if (!shot?.imagePath) {
        const note = document.createElement('div');
        note.className = 'empty';
        note.textContent = '这个分镜还没有出图。先用表格里的「生成分镜图」出一张，再回来把它当参考图。';
        pane.appendChild(note);
      } else {
        pane.appendChild(refPickLabel({
          isOn: refDraftHas('shot'),
          onToggle: () => toggleRefDraft({ kind: 'shot', name: '当前分镜图' }),
          imgSrc: shot.imagePath,
          name: '用当前分镜图（跟着换图走）',
        }));
      }
      body.appendChild(pane);
      renderShotRefSelected();
      return;
    }

    if (state.refTab === 'library') {
      const pane = document.createElement('div');
      pane.className = 'ref-pane';
      const bar = document.createElement('div');
      bar.className = 'ref-toolbar';
      const input = document.createElement('input');
      input.className = 'input';
      input.style.width = '200px';
      input.placeholder = '搜索名称或标签';
      input.value = state.refLib.keyword;
      const search = document.createElement('button');
      search.type = 'button';
      search.className = 'btn ghost small';
      search.textContent = '搜索';
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = state.refLib.total ? `共 ${state.refLib.total} 张` : '';
      const run = () => {
        state.refLib.keyword = input.value.trim();
        state.refLib.page = 1;
        loadShotRefLibrary().catch((error) => { $('shotRefError').textContent = error.message; });
      };
      search.addEventListener('click', run);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
      bar.append(input, search, spacer, count);
      pane.appendChild(bar);

      if (!state.refLib.rows.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '图库里没有匹配的图。分镜页出的图会自动收进图库。';
        pane.appendChild(empty);
      } else {
        const grid = document.createElement('div');
        grid.className = 'ref-grid';
        for (const row of state.refLib.rows) {
          grid.appendChild(refPickLabel({
            isOn: refDraftHas('library', row.id),
            onToggle: () => toggleRefDraft({ kind: 'library', id: row.id, name: row.name }),
            imgSrc: DolaRefLib.src(row),
            name: `${row.name || `#${row.id}`}${row.width ? ` · ${row.width}×${row.height}` : ''}`,
          }));
        }
        pane.appendChild(grid);
      }
      body.appendChild(pane);
      renderShotRefSelected();
      return;
    }

    // history：按**批**成块。一次生成 = 一组，绝不拍平成图片流水（同出图历史的口径）。
    const pane = document.createElement('div');
    pane.className = 'ref-pane';
    if (!state.refHistory.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '这个分镜还没有出过图，没有历史可选。';
      pane.appendChild(empty);
    }
    for (const batch of state.refHistory) {
      const card = document.createElement('section');
      card.className = 'ref-batch';
      const head = document.createElement('div');
      head.className = 'ref-batch-head';
      const title = document.createElement('b');
      title.textContent = `第 ${batch.id} 批`;
      const meta = document.createElement('span');
      meta.textContent = `${batch.imageCount}/${batch.expectedCount} 张 · ${fmtDate(batch.createdAt)}`;
      head.append(title, meta);
      card.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'ref-grid';
      for (const img of batch.images) {
        grid.appendChild(refPickLabel({
          isOn: refDraftHas('url', img.url),
          onToggle: () => toggleRefDraft({ kind: 'url', url: img.url, name: `第 ${batch.id} 批的图` }),
          imgSrc: img.previewUrl || img.url,
          name: `第 ${batch.id} 批`,
        }));
      }
      card.appendChild(grid);
      pane.appendChild(card);
    }
    body.appendChild(pane);
    renderShotRefSelected();
  }

  async function loadShotRefLibrary() {
    const res = await DolaRefLib.list({
      keyword: state.refLib.keyword, page: state.refLib.page, pageSize: state.refLib.pageSize,
    });
    state.refLib.rows = res.items || [];
    state.refLib.total = Number(res.total) || 0;
  }

  async function loadShotRefHistory(shot) {
    const data = await adminRequest(`/api/scripts/${state.current.id}/shots/${shot.seq}/images`, { timeoutMs: 20000 });
    state.refHistory = Array.isArray(data.items) ? data.items : [];
  }

  async function openShotRef(index) {
    const shot = state.current?.shots[index];
    if (!shot) return;
    if (!can('script:list')) return ssToast('当前账号没有查看脚本的权限');
    state.refShot = shot;
    // 深拷贝成草稿：取消时不该改到表格里的值
    state.refDraft = JSON.parse(JSON.stringify(shot.referenceImages || []));
    state.refTab = state.refDraft.length ? state.refTab : 'shot';
    state.refHistory = [];
    state.refLib = { rows: [], total: 0, page: 1, pageSize: 24, keyword: '' };
    $('shotRefTitle').textContent = `分镜 ${shot.seq} · 参考图`;
    $('shotRefNote').textContent = `最多 ${DolaRefLib.REF_MAX} 张。参考图在「创建视频任务」时才会真正下载并喂给模型；选「当前分镜图」时它会跟着你换图走。`;
    $('shotRefBody').innerHTML = '';
    $('shotRefSelected').innerHTML = '';
    $('shotRefError').textContent = '加载中…';
    if (!$('shotRefDlg').open) $('shotRefDlg').showModal();
    try {
      // 图库与出图历史并行拉：两个都要用，串行只是白等。
      await Promise.all([loadShotRefLibrary(), loadShotRefHistory(shot)]);
      renderShotRef();
    } catch (error) {
      $('shotRefError').textContent = error.status === 403
        ? '没有查看参考图库的权限（refimage:list）。请让管理员到「角色权限」里勾选。'
        : error.message;
      renderShotRef();
    }
  }

  /**
   * 保存参考图。走**专用端点**而不是 PATCH /:id：
   * PATCH 是「整份脚本一起存」，用它改一张参考图会把 20 个分镜的草稿一起写库。
   * 端点会做归一化（同一分镜只留一条 shot 指向、去重、截断到 9 张），
   * 所以要用**返回值**回写，前端不猜。
   */
  async function saveShotRefs() {
    const shot = state.refShot;
    if (!shot) return;
    if (!can('script:update')) return ssToast('当前账号没有修改脚本的权限');
    await guard(async () => {
      const data = await adminRequest(
        `/api/scripts/${state.current.id}/shots/${shot.seq}/reference-images`,
        { method: 'POST', body: { referenceImages: state.refDraft }, timeoutMs: 30000 },
      );
      shot.referenceImages = data.referenceImages || [];
      // ⚠️ 这里**不能**用 closeDialog()：那是「视频任务」页那个 IIFE 里的函数，
      // 本页（脚本分镜）是独立的 IIFE，看不见它。直接用 dialog 自己的 close()，
      // 与 openImageHistory 里用 showModal() 是同一口径。
      const dlg = $('shotRefDlg');
      if (dlg.open) dlg.close();
      renderShots();
      ssToast(shot.referenceImages.length
        ? `分镜 ${shot.seq} 已设置 ${shot.referenceImages.length} 张参考图`
        : `分镜 ${shot.seq} 已改为不使用参考图`, 'good');
    }, '参考图保存失败');
  }

  // ───────────────────────────────────────────────────────── 事件
  $('ssList').addEventListener('click', (event) => {
    const item = event.target.closest('.ss-item');
    if (!item) return;
    guard(() => selectScript(Number(item.dataset.id)), '脚本加载失败');
  });
  $('ssShotRows').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const index = Number(btn.dataset.idx);
    if (btn.dataset.act === 'to-video') toVideo(index);
    if (btn.dataset.act === 'remove-shot') removeShot(index);
    if (btn.dataset.act === 'gen-image') generateImage(index);
    if (btn.dataset.act === 'shot-history') openImageHistory(index);
    if (btn.dataset.act === 'shot-ref') openShotRef(index);
    if (btn.dataset.act === 'pick-image') pickImage(index, btn.dataset.url);
  });
  /** 表格里的改动回写到 state —— 保存 / 建任务都读 state，不现读 DOM。 */
  function onShotEdit(event) {
    const el = event.target;
    if (!el?.dataset || el.dataset.field === undefined || !state.current) return;
    const shot = state.current.shots[Number(el.dataset.idx)];
    if (!shot) return;
    shot[el.dataset.field] = el.dataset.field === 'seconds' ? Number(el.value) : el.value;
    markDirty();
  }
  $('ssShotRows').addEventListener('input', onShotEdit);
  $('ssShotRows').addEventListener('change', onShotEdit);

  // 出图历史弹层里点图 → 切回那一张
  $('imgHistBody').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-act="use-history-image"]');
    if (!btn) return;
    useHistoryImage(Number(btn.dataset.historyId), btn.dataset.url);
  });

  // 参考图弹层：页签切换 + 保存 / 清空
  $('shotRefDlg').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-reftab]');
    if (!tab) return;
    state.refTab = tab.dataset.reftab;
    renderShotRef();
  });
  $('shotRefSave').addEventListener('click', () => {
    ssBusy($('shotRefSave'), '保存中…', saveShotRefs);
  });
  $('shotRefClear').addEventListener('click', () => {
    state.refDraft = [];
    renderShotRef();
  });

  const HEADER_FIELDS = { ssTitle: 'title', ssCurTopic: 'topic', ssCurTone: 'tone' };
  Object.keys(HEADER_FIELDS).forEach((id) => {
    $(id).addEventListener('input', () => {
      if (!state.current) return;
      state.current[HEADER_FIELDS[id]] = $(id).value;
      markDirty();
    });
  });

  $('ssTopic').addEventListener('input', syncComposer);
  $('ssToken').addEventListener('change', renderShots);
  $('ssGenerate').addEventListener('click', () => { generate(); });
  $('ssSave').addEventListener('click', () => { save(); });
  $('ssDelete').addEventListener('click', () => { removeScript(); });
  $('ssAddShot').addEventListener('click', addShot);
  $('ssReload').addEventListener('click', () => {
    ssBusy($('ssReload'), '刷新中…', () => Promise.all([
      guard(loadScripts, '脚本列表加载失败'),
      guard(loadTokens, '令牌列表加载失败'),
      guard(loadConfig, '脚本配置加载失败'),
    ])).then(syncComposer);
  });

  // ───────────────────────────────────────────────────────── 顶层页签
  async function boot() {
    if (state.booted) return;
    state.booted = true;
    await guard(loadMe, '管理员会话读取失败');
    await Promise.all([
      guard(loadConfig, '脚本配置加载失败'),
      guard(loadScripts, '脚本列表加载失败'),
      guard(loadTokens, '令牌列表加载失败'),
    ]);
    renderCurrent();
    syncComposer();
    // 回到上次看的那个脚本。列表里已经没有就安静跳过（可能被删了），
    // 不弹错 —— 用户没主动做任何事，弹窗只会莫名其妙。
    let savedScriptId = '';
    try { savedScriptId = localStorage.getItem(SCRIPT_ID_KEY) || ''; } catch { /* ignore */ }
    if (savedScriptId && state.scripts.some((item) => String(item.id) === savedScriptId)) {
      await guard(() => selectScript(Number(savedScriptId)), '脚本加载失败');
    }
  }
  function setPage(name) {
    const isVideo = name === 'video';
    if (!$('page-video')) return;
    $('page-video').classList.toggle('hidden', !isVideo);
    $('page-script').classList.toggle('hidden', isVideo);
    $('pageTabVideo').classList.toggle('active', isVideo);
    $('pageTabScript').classList.toggle('active', !isVideo);
    $('pageTabVideo').setAttribute('aria-selected', String(isVideo));
    $('pageTabScript').setAttribute('aria-selected', String(!isVideo));
    try { localStorage.setItem(PAGE_KEY, name); } catch { /* 隐私模式下写不了，忽略 */ }
    if (!isVideo) boot();
  }
  $('pageTabVideo').addEventListener('click', () => setPage('video'));
  $('pageTabScript').addEventListener('click', () => setPage('script'));

  // 记住上次停留的页签。失败（localStorage 不可用 / 值非法）都落到视频任务页。
  (() => {
    let saved = '';
    try { saved = localStorage.getItem(PAGE_KEY) || ''; } catch { /* ignore */ }
    if (saved === 'script') setPage('script');
  })();
})();
