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
  /** 批量创建的单次上限：20 行。别让一次误粘贴打出上百条真实任务。 */
  const BATCH_MAX_LINES = 20;
  /** 本机素材里参考图的 base64 总字节上限：localStorage 一般只有 5MB，超了会写失败。 */
  const MATERIAL_IMAGE_BUDGET = 1_500_000;
  const FILE_PREVIEW = window.location.protocol === 'file:';

  const state = {
    token: '', status: null, models: [], files: [], jobs: [], currentId: '',
    pollTimer: null, objectUrl: '', epoch: 0, tab: 'run', autoStart: true, loaded: {},
    materials: [], jobFilter: '', jobLimit: 20,
  };

  /** 还在自己往终态走的四个状态。 */
  const ACTIVE = new Set(['queued', 'submitting', 'generating', 'resolving']);
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

  function fillSeconds(preserve = true) {
    const select = $('seconds');
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
    if (values.includes(selected)) select.value = String(selected);
    else if (values.includes(10)) select.value = '10';
    select.disabled = values.length === 0;
    fillBatchOptions();
    renderCapability();
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
    if (seconds === 15) checks.push(`15 秒原生能力：${status.expert_seconds_ready ? '池内有已确认能力' : '当前未确认'}`);
    if (seconds === 30) checks.push(`30 秒能力：${status.fixed_seconds_ready ? '池内有已确认能力' : '当前未确认'}`);
    if (state.files.length) checks.push(`参考图能力：${status.reference_images_ready ? '池内有已确认能力' : '当前未确认'}`);
    checks.push(`本服务暂不支持参考音频；图片最多 ${status.reference_images_max || 9} 张。`);
    const uncertain = (seconds === 15 && !status.expert_seconds_ready)
      || (seconds === 30 && !status.fixed_seconds_ready)
      || (state.files.length > 0 && !status.reference_images_ready);
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

  function renderFiles() {
    if (state.files.length > 9) state.files = state.files.slice(0, 9);
    const list = $('fileList');
    list.replaceChildren();
    state.files.forEach((file, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除';
      remove.setAttribute('aria-label', `移除 ${file.name}`);
      remove.addEventListener('click', () => {
        state.files.splice(index, 1);
        renderFiles();
        renderCapability();
      });
      item.append(name, remove);
      list.append(item);
    });
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

  function renderJob(job) {
    if (!job) { renderEmptyJob(); return; }
    state.currentId = String(job.id || state.currentId || '');
    $('taskId').textContent = state.currentId ? `任务 #${state.currentId}` : '暂无任务';
    $('taskStatus').textContent = displayStatus(job.status);
    $('taskStage').textContent = job.stage || '';
    renderProgress(job);
    renderMeta(job);
    if (job.status === 'ready' && !state.loaded[state.currentId]) {
      state.loaded[state.currentId] = true;
      loadContent(job).catch(() => { /* 播放/下载失败不阻塞状态展示，错误已进 error box */ });
    }
    if (job.error) setError(job.error);
    else clearError();
    $('rawJson').textContent = JSON.stringify(job, null, 2);
    if (ACTIVE.has(job.status)) startPolling();
    else stopPolling();
    syncButtons();
  }

  function renderEmptyJob(message = '暂无任务') {
    state.currentId = '';
    $('taskId').textContent = message;
    $('taskStatus').textContent = '输入用户令牌并连接后即可使用';
    $('taskStage').textContent = '';
    renderProgress(null);
    renderMeta(null);
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
  function syncButtons() {
    const job = state.jobs.find((item) => String(item.id) === state.currentId) || null;
    const status = job?.status || '';
    const connected = Boolean(state.token && state.status);
    $('pullModels').disabled = !state.token || state.models.length === 0;
    $('create').disabled = !connected;
    $('batchCreate').disabled = !connected;
    $('refreshJobs').disabled = !state.token;
    $('refreshCurrent').disabled = !state.currentId;
    $('clearCurrent').disabled = !state.currentId;
    $('cancelCurrent').classList.toggle('hidden', !ACTIVE.has(status));
    $('download').classList.toggle('hidden', status !== 'ready');
    const queued = state.jobs.filter((item) => item.status === 'queued').length;
    $('startQueued').disabled = !state.token || queued === 0;
    $('clearJobs').disabled = !state.token || state.jobs.length === 0;
    // 兑换只需要「有令牌」——余额为 0 恰恰是最该能兑换的状态，不能拿余额当门槛。
    $('redeemBtn').disabled = !state.token;
    $('logoutBtn').classList.toggle('hidden', !state.token);
    $('jobsCount').textContent = state.jobs.length ? `${state.jobs.length} 条 · ${queued} 条待提交` : '尚未加载';
  }

  // ─────────────────────────────────────────────────────────── 任务列表

  /** 服务端只接受 queued（见文件头）。 */
  function canStart(job) {
    return job.status === 'queued';
  }

  function rowActions(job) {
    const cells = [];
    if (canStart(job)) cells.push(['start', '提交上游', 'primary', '把这个已冻结积分的排队任务提交到上游']);
    if (ACTIVE.has(job.status)) cells.push(['cancel', '取消', '', '取消任务。已提交到上游的不退款']);
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
    const needle = state.jobFilter.trim().toLowerCase();
    if (!needle) return state.jobs;
    return state.jobs.filter((job) => [
      job.id, displayStatus(job.status), job.status, job.stage, job.prompt, job.error,
      job.seconds ? `${job.seconds}秒` : '',
    ].some((field) => String(field ?? '').toLowerCase().includes(needle)));
  }

  function renderJobs() {
    const body = $('jobRows');
    const rows = filteredJobs();
    body.replaceChildren();
    if (!rows.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 7;
      cell.className = 'empty';
      cell.textContent = !state.token ? '连接令牌后加载任务。'
        : state.jobs.length ? `没有匹配「${state.jobFilter}」的任务（本页共 ${state.jobs.length} 条）。`
          : '当前令牌下没有任务。';
      syncButtons();
      return;
    }
    for (const job of rows) {
      const row = body.insertRow();
      row.dataset.id = String(job.id);
      if (String(job.id) === state.currentId) row.style.fontWeight = '650';
      const idCell = row.insertCell();
      idCell.className = 'job-id';
      idCell.textContent = `#${job.id}`;
      const statusCell = row.insertCell();
      const tag = document.createElement('span');
      tag.className = `tag ${job.status === 'ready' ? 'ready' : job.status === 'failed' ? 'failed' : ACTIVE.has(job.status) ? 'running' : ''}`;
      tag.textContent = displayStatus(job.status);
      statusCell.append(tag);
      const stageCell = row.insertCell();
      stageCell.className = 'stage-cell';
      stageCell.title = job.stage || '';
      stageCell.textContent = job.stage || '—';
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
        note.title = '本服务只允许启动「排队中」的任务；失败/已取消是终态，需要重新建一条。';
        note.textContent = '（终态不可重启）';
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
    if (state.tab === 'jobs') renderJobs();
    else syncButtons();
  }

  // ─────────────────────────────────────────────────────────── 会话生命周期

  function clearSessionData() {
    state.epoch++;
    stopPolling();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = '';
    state.status = null;
    state.models = [];
    state.files = [];
    state.jobs = [];
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
    state.jobs = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
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

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    if (!state.currentId) return;
    state.pollTimer = setInterval(async () => {
      const job = await loadJob(state.currentId).catch(() => null);
      if (state.tab === 'jobs') syncButtons();
      if (job && !ACTIVE.has(job.status)) stopPolling();
    }, 15000);
  }

  // ─────────────────────────────────────────────────────────── 连接

  async function connect() {
    if (FILE_PREVIEW) {
      showConnection('请从本地服务地址打开工作台', 'bad');
      return;
    }
    const nextToken = $('apiKey').value.trim();
    if (state.token !== nextToken) clearSessionData();
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
      await refreshJobs();
      if (epoch !== state.epoch) return;
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

  async function createTask() {
    const epoch = state.epoch;
    const prompt = $('prompt').value.trim();
    if (!prompt) { setError('请填写提示词'); return; }
    if (state.files.length > 9) { setError('参考图片最多 9 张'); return; }
    const seconds = Number($('seconds').value);
    const model = $('model').value;
    const autoStart = $('autoStart').checked;
    const cost = Number(state.status?.points_per_task || 1);
    const balance = Number(state.status?.token?.points || 0);
    const text = autoStart
      ? `将创建一条真实 ${seconds} 秒任务，扣 ${cost} 积分（令牌余额 ${balance}），并立即提交上游。任务会消耗上游账号额度。确认提交？`
      : `将创建一条 ${seconds} 秒任务并冻结 ${cost} 积分（令牌余额 ${balance}），暂不提交上游。之后可在「任务列表」里手动提交。确认？`;
    if (!window.confirm(text)) return;
    state.autoStart = autoStart;
    clearError();
    await withBusy($('create'), '提交中…', async () => {
      try {
        let body;
        if (state.files.length) {
          body = new FormData();
          body.append('model', model);
          body.append('prompt', prompt);
          body.append('seconds', String(seconds));
          body.append('size', $('ratio').value);
          body.append('auto_start', String(autoStart));
          for (const file of state.files) body.append('input_reference', file, file.name);
        } else {
          body = { model, prompt, seconds, size: $('ratio').value, auto_start: autoStart };
        }
        const job = await requestJson('/v1/videos', { method: 'POST', body, timeoutMs: 150000 });
        if (epoch !== state.epoch) return;
        if (!job?.id) throw new Error('接口已返回，但响应中没有任务 id');
        upsertJob(job);
        renderJob(job);
        renderTab('run');
        showConnection(autoStart ? `已创建并提交 #${job.id}` : `已创建 #${job.id}（待提交）`, 'good');
        await refreshJobs();
        if (epoch !== state.epoch) return;
        await refreshStatus(epoch);
      } catch (error) {
        if (epoch !== state.epoch) return;
        setError(error.message, error);
        showConnection(error.code ? `提交失败 · ${error.code}` : '提交失败', 'bad');
      } finally {
        if (epoch === state.epoch) $('create').disabled = !state.status;
      }
    });
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
    if (!window.confirm(`把 ${ids.length} 条排队中的任务一次性提交上游？这些任务的积分在创建时已冻结。`)) return;
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
    if (confirmText && !window.confirm(confirmText)) return null;
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
    if (confirmText && !window.confirm(confirmText)) return null;
    const epoch = state.epoch;
    const result = await requestJson(`/v1/videos/${encodeURIComponent(id)}`, {
      method: 'DELETE', timeoutMs: 120000,
    });
    if (epoch !== state.epoch) return null;
    state.jobs = state.jobs.filter((item) => String(item.id) !== String(id));
    if (String(state.currentId) === String(id)) {
      stopPolling();
      renderEmptyJob('任务已清除');
    }
    if (state.tab === 'jobs') renderJobs();
    else syncButtons();
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
    if (!window.confirm('清空当前令牌下全部任务记录？排队中的会取消并退款；已在生成的不退款。\n（清除 = 取消 + 从列表隐藏；计费/退款凭据仍保留在服务端，按 id 可查。）')) return;
    const epoch = state.epoch;
    await withBusy($('clearJobs'), '清空中…', async () => {
      try {
        const result = await requestJson('/v1/videos', { method: 'DELETE', body: { all: true }, timeoutMs: 120000 });
        if (epoch !== state.epoch) return;
        stopPolling();
        state.jobs = [];
        state.currentId = '';
        renderEmptyJob('任务记录已清空');
        renderJobs();
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
      const value = line.trim();
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
    const confirmed = window.confirm(
      `将逐条创建 ${prompts.length} 条真实 ${seconds} 秒任务，每条扣 ${cost} 积分（共 ${prompts.length * cost}，当前余额 ${balance}）。\n`
      + `${autoStart ? '每条创建后会立即提交上游，会消耗上游账号额度。' : '先只冻结积分，状态停在「排队中」。'}\n`
      + '单条失败不会中断后续提交。确认开始？',
    );
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
          const job = await requestJson('/v1/videos', {
            method: 'POST',
            body: {
              model: modelForDuration(seconds) || $('model').value,
              prompt: prompts[i], seconds, size: ratio, auto_start: autoStart,
            },
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
        renderTab('run');
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
    state.files = [];
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
  $('logoutBtn').addEventListener('click', () => {
    if (!window.confirm('退出当前令牌？\n\n这只清除本页（以及本机记住的令牌）；服务端的任务、积分和扣费记录都不受影响，用同一把令牌重新登录即可看到。')) return;
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
  $('materialList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.act === 'material-use') {
      applyMaterial(id).catch((error) => setError(error.message || '套用素材失败'));
      return;
    }
    const material = state.materials.find((item) => item.id === id);
    if (!window.confirm(`删除素材「${material?.title || '未命名'}」？只删本机这一份，服务端没有任何副本。`)) return;
    if (!saveMaterials(state.materials.filter((item) => item.id !== id))) return;
    renderMaterials();
  });
  // 关闭按钮走统一入口，避免每个 dialog 各自写一遍
  for (const button of document.querySelectorAll('[data-dlg-close]')) {
    button.addEventListener('click', () => closeDialog(button.dataset.dlgClose));
  }
  $('jobSearch').addEventListener('input', () => {
    state.jobFilter = $('jobSearch').value;
    renderJobs();
  });
  $('jobLimit').addEventListener('change', () => {
    state.jobLimit = Number($('jobLimit').value) || 20;
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
    const exceeded = state.files.length + unique.length > 9;
    state.files = [...state.files, ...unique].slice(0, 9);
    event.target.value = '';
    renderFiles();
    renderCapability();
    if (exceeded) setError('参考图片最多 9 张，超出的文件未加入。');
  });
  $('create').addEventListener('click', createTask);
  $('tabRun').addEventListener('click', () => renderTab('run'));
  $('tabJobs').addEventListener('click', () => renderTab('jobs'));
  $('refreshCurrent').addEventListener('click', () => {
    const epoch = state.epoch;
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
        if (!window.confirm(`把 #${id} 提交到上游？该任务的积分在创建时已冻结。`)) return;
        await startJob(id);
      } else if (act === 'cancel') {
        await cancelJob(id, { confirmText: `确认取消 #${id}？已提交到上游的任务无法退款。` });
      } else if (act === 'clear') {
        await clearJob(id, { confirmText: `确认清除 #${id}？排队中的会取消并退款，已在生成的不退款。` });
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
