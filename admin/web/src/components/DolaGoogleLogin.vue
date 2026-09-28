<template>
  <el-button type="primary" plain :disabled="!!busy" @click="openDialog">账号登录入池</el-button>

  <el-dialog
    v-model="visible" title="账号导入与独立登录" width="min(860px, 94vw)"
    append-to-body destroy-on-close :close-on-click-modal="false"
  >
    <el-alert type="info" :closable="false" show-icon>
      <template #title>强制 IP 代理 · 独立登录窗口 · 每批最多 20 个账号</template>
      <div class="help">
        已有账号沿用已绑定代理；没有代理的账号从现有 IPWeb 配置分配固定独立会话。先检查代理，再逐字输入邮箱和密码。
        代理缺失或不可用会停止，绝不退回直连。每个账号使用独立窗口，窗口会在后台所在电脑弹出。
        <details class="login-notes"><summary>会话保存、验证码与超时说明</summary>
        新会话加密保存于本机 DolaLogin/encrypted-sessions，旧会话目录只兼容读取、不自动迁移；不保存密码，最多复用 7 天，复用前仍核验原代理与身份。
        加密范围是新会话备份，号池数据库仍沿用现有 Cookie 存储格式。
        邮件验证码与 Google Authenticator 动态码分别识别，仅在账号和输入框均确认后取码填写。
        动态码最多取码 3 次、提交 2 个不同码，刷新至少间隔 15 秒，总等待不超过 90 秒；同一个码不会重复提交。
        遇到图形验证码、安全限制或取码失败会停止自动填写并暂停后续账号，当前窗口最多保留 10 分钟；超时清除剩余凭据，不自动换号重试。
        完成当前步骤后点击「我已完成，检查登录」，结束当前账号后才可明确继续剩余账号。
        系统不会绕过验证，也不保证免验证。只有后端验证成功的账号才会入池。
        </details>
      </div>
    </el-alert>

    <el-form v-if="!activeBatch" label-position="top" class="credentials" @submit.prevent="createBatch">
      <el-form-item label="登录方式">
        <el-radio-group v-model="loginMode" :disabled="!!busy" @change="clearPreview">
          <el-radio-button value="auto">自动识别账号格式</el-radio-button>
          <el-radio-button value="manual">独立窗口手动登录</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <div v-if="loginMode === 'auto'" class="help formats">
        每行一条，第一段始终作为账号显示；导入后分配稳定编号 [A01]、[A02]…，重复导入不会换号。
        <div><code>主邮箱|密码</code> 或 <code>主邮箱----密码----恢复邮箱</code></div>
        <div><code>主邮箱----密码----no----谷歌已登录链接</code></div>
        <div><code>主邮箱----密码----恢复邮箱----验证码接口</code></div>
        谷歌链接仅接受 https://gapi.mailsapi.com/google/login?uid=…；验证码接口默认只接受公网域名 HTTPS。
        HTTP、公网 IP、非标准端口必须匹配管理员配置的取码服务路径白名单；不会开放任意地址。
        HTTP 会明文传输取码链接中的秘密及验证码，仅在信任服务并接受该风险时使用，推荐 HTTPS。
        Google 链接会在独立代理窗口访问该第三方服务，不向它填写账号密码；如不信任服务提供方，请选择手动登录。
      </div>
      <div v-else class="help formats">每行填写一个用于标注的主邮箱，无需密码。系统会打开普通 Chrome 独立窗口；请你本人在其中选择手机号或邮箱完成登录。后台不自动填写、不点击 Google 登录步骤，只核验 Dola 回调后的真实会话身份。手动标签不代表上游邮箱绑定已核实。</div>
      <el-form-item :label="loginMode === 'manual' ? '账号标注邮箱（每行一个）' : '账号列表（支持两段、三段、四段格式）'">
        <el-input
          v-model="raw" type="textarea" :rows="6" :disabled="!!busy || !restored"
          :class="{ 'secret-input': !showInput }" @input="previewItems = []"
          autocomplete="off" autocapitalize="off" :spellcheck="false"
          :placeholder="loginMode === 'manual' ? 'alice@example.com' : 'alice@example.com|示例密码'"
          aria-label="账号列表，包含敏感凭据，请勿共享截图"
        />
      </el-form-item>
      <el-checkbox v-model="showInput">显示输入内容（含敏感信息）</el-checkbox>
      <el-button size="small" :loading="busy === 'preview-format'" :disabled="!!busy || !restored || !accountCount" @click="previewFormat">检查格式，不启动登录</el-button>
      <el-table v-if="previewItems.length" :data="previewItems" size="small" border class="format-preview">
        <el-table-column prop="email" label="主邮箱" min-width="190" />
        <el-table-column label="识别方式" min-width="150"><template #default="{ row }">{{ methodLabels[row.loginMethod] }}</template></el-table-column>
        <el-table-column label="附加信息" min-width="150"><template #default="{ row }">{{ row.hasVerificationUrl ? '邮件 / 验证器取码接口' : row.hasRecoveryEmail ? '恢复邮箱' : '—' }}</template></el-table-column>
      </el-table>
      <div class="help">
        已填写 {{ accountCount }} / 20 个账号，空行忽略。输入仅保存在当前页面内存中，不写入浏览器本地存储；
        提交成功、关闭弹窗或离开页面时会清空。
      </div>
    </el-form>

    <div class="status-toolbar">
      <span class="help" role="status">
        {{ busy === 'restore' ? '正在恢复当前批次…' : (activeBatch ? '弹窗打开期间每 3 秒更新进度' : '可恢复当前批次后继续操作') }}
      </span>
      <el-button size="small" :loading="busy === 'restore'" :disabled="!!busy" @click="refreshCurrent()">刷新当前批次</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="error" />

    <section v-if="batch" class="batch" aria-label="账号登录批次进度">
      <div class="batch-head">
        <el-tag :type="['waiting_user', 'paused'].includes(batch.status) ? 'warning' : 'info'">{{ batchLabels[batch.status] }}</el-tag>
        <span>批次 {{ batch.id }}</span>
        <span class="help">创建于 {{ createdAtLabel }}</span>
      </div>
      <p class="help">已处理 {{ finishedCount }} / {{ batch.items.length }} · 成功入池 {{ succeededCount }} · 失败 {{ failedCount }}</p>
      <el-progress :percentage="progress" />
      <p v-if="activeBatch && currentItem" class="help">当前账号：{{ currentItem.email }}</p>
      <p v-if="activeBatch && currentItem && !waitingForUser && !terminalItems.has(currentItem.status)" class="help" role="status">{{ currentItem.message }}</p>
      <el-alert
        v-if="waitingForUser" type="warning" :closable="false" show-icon class="waiting"
        :title="currentItem?.message || '请查看登录窗口的当前步骤，再点击下方检查登录。'"
      />
      <el-alert v-if="batch.status === 'paused'" type="warning" :closable="false" show-icon class="waiting"
        title="本批曾遇到安全验证，当前窗口已结束，剩余账号仍暂停。确认后才会继续；从首次验证起满 10 分钟仍未继续，将清除剩余密码。" />
      <el-table :data="batch.items" border class="items">
        <el-table-column type="index" label="#" width="48" />
        <el-table-column label="稳定编号" width="90"><template #default="{ row }">{{ row.accountCode ? `[${row.accountCode}]` : '—' }}</template></el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="190" show-overflow-tooltip />
        <el-table-column label="状态" width="125">
          <template #default="{ row }">
            <el-tag size="small" :type="itemStatusType(row.status)">{{ itemLabels[row.status] || '未知状态' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="进度说明" min-width="230" show-overflow-tooltip />
        <el-table-column label="入池账号 ID" width="110">
          <template #default="{ row }">{{ row.accountId ?? '—' }}</template>
        </el-table-column>
      </el-table>
      <div v-if="surfaceOpen && activeBatch" class="login-surface">
        <p class="help">
          服务器上的真实登录窗口（画面按需自动刷新）。在画面上点一下输入框，再用下面这行输入文字并发送 —— 和坐在本机操作一样。
          密码框已被遮挡，不会渲染成图片；输入内容只在本页内存里转交，不保存、不记录、不回显。
        </p>
        <div class="surface-frame">
          <img :src="surfaceImage" alt="服务器上的登录窗口画面" @click="surfaceClick" @wheel.prevent="surfaceWheel">
        </div>
        <div class="surface-tools">
          <el-input v-model="surfaceText" size="small" class="surface-text"
            placeholder="要输入到窗口的文字（邮箱 / 密码 / 验证码）" @keyup.enter="surfaceSendText" />
          <el-button size="small" :disabled="!surfaceText || !!surfaceBusy" @click="surfaceSendText">发送到窗口</el-button>
          <el-button size="small" :disabled="!!surfaceBusy" @click="surfaceKey('Enter')">回车</el-button>
          <el-button size="small" :disabled="!!surfaceBusy" @click="surfaceKey('Tab')">Tab</el-button>
          <el-button size="small" :disabled="!!surfaceBusy" @click="surfaceKey('Backspace')">退格</el-button>
        </div>
        <p class="help surface-status">
          <el-switch v-model="surfaceAuto" size="small" active-text="自动刷新画面" />
          <span v-if="surfaceError" class="surface-error">{{ surfaceError }}</span>
        </p>
      </div>
    </section>

    <p v-if="activeBatch" class="help">关闭弹窗只停止页面轮询，不会解除安全暂停，也不会重置等待时限；再次打开可恢复进度。若需停止，请点击「取消整批」。</p>
    <template #footer>
      <div class="footer">
        <el-button @click="visible = false">关闭</el-button>
        <template v-if="activeBatch">
          <el-button :loading="busy === 'surface'" :disabled="!!busy || !restored" @click="loadSurface">查看/操作登录窗口</el-button>
          <el-button type="danger" plain :loading="busy === 'cancel'" :disabled="!!busy || !restored" @click="runAction('cancel')">取消整批</el-button>
          <el-button :loading="busy === 'skip'" :disabled="!!busy || !restored || !canSkip" @click="runAction('skip')">跳过当前</el-button>
          <el-button v-if="batch.status === 'paused'" type="primary" :loading="busy === 'resume'" :disabled="!!busy || !restored" @click="runAction('resume')">确认继续剩余账号</el-button>
          <el-button v-else type="primary" :loading="busy === 'check'" :disabled="!!busy || !restored || !waitingForUser" @click="runAction('check')">我已完成，检查登录</el-button>
        </template>
        <el-button
          v-else type="primary" :loading="busy === 'create'"
          :disabled="!!busy || !restored || accountCount === 0 || accountCount > 20" @click="createBatch"
        >开始登录入池</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['completed']);
const endpoint = '/api/dola/google-login/batches';
const visible = ref(false);
const raw = ref('');
const loginMode = ref('auto');
const showInput = ref(false);
const previewItems = ref([]);
const methodLabels = { password: 'Google 密码登录', google_link: 'Google 已登录链接', manual: '独立窗口手动登录' };
function clearPreview() { raw.value = ''; previewItems.value = []; showInput.value = false; error.value = ''; }
const batch = ref(null);
const busy = ref('');
const restored = ref(false);
const error = ref('');
// 可交互的服务器窗口画面。`surfaceViewport` 是页面 viewport 的 CSS 尺寸，
// 用来把「画面上点到的位置」换算成页面坐标 —— 换算错了就会点偏。
const surfaceOpen = ref(false);
const surfaceAuto = ref(true);
const surfaceImage = ref('');
const surfaceViewport = ref({ width: 0, height: 0 });
const surfaceText = ref('');
const surfaceBusy = ref(false);
const surfaceError = ref('');
let pollTimer = null;
let surfaceTimer = null;
let disposed = false;
const notifiedBatches = new Set();
const terminalItems = new Set(['succeeded', 'failed', 'cancelled']);
const batchLabels = { running: '登录进行中', waiting_user: '等待人工处理', paused: '后续账号已暂停', done: '批次已结束', cancelled: '批次已取消' };
const itemLabels = {
  queued: '排队中', opening: '打开浏览器', signing_in: '登录中', waiting_user: '等待人工处理',
  verifying: '验证登录结果', succeeded: '成功入池', failed: '失败', cancelled: '已取消',
};
const activeBatch = computed(() => batch.value && ['running', 'waiting_user', 'paused'].includes(batch.value.status));
const currentItem = computed(() => batch.value?.items[batch.value.currentIndex] || null);
const waitingForUser = computed(() => activeBatch.value && (batch.value.status === 'waiting_user' || currentItem.value?.status === 'waiting_user'));
const canSkip = computed(() => activeBatch.value && currentItem.value && !terminalItems.has(currentItem.value.status));
const accountCount = computed(() => raw.value.split(/\r?\n/).filter((line) => line.trim()).length);
const finishedCount = computed(() => batch.value?.items.filter((item) => terminalItems.has(item.status)).length || 0);
const succeededCount = computed(() => batch.value?.items.filter((item) => item.status === 'succeeded').length || 0);
const failedCount = computed(() => batch.value?.items.filter((item) => item.status === 'failed').length || 0);
const progress = computed(() => batch.value?.items.length ? Math.round(finishedCount.value / batch.value.items.length * 100) : 0);
const createdAtLabel = computed(() => {
  const date = new Date(batch.value?.createdAt);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
});

function itemStatusType(status) {
  return { succeeded: 'success', failed: 'danger', waiting_user: 'warning' }[status] || 'info';
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  stopPolling();
  if (disposed || !visible.value || !activeBatch.value || busy.value) return;
  // 请求结束后再计时，慢请求和人工操作都不会与轮询重叠。
  pollTimer = setTimeout(() => {
    pollTimer = null;
    refreshCurrent(true);
  }, 3000);
}

function readBatch(response, allowEmpty = false) {
  const next = response?.batch;
  if (response?.ok !== true || (next === null ? !allowEmpty : (
    !next?.id || !Object.hasOwn(batchLabels, next.status) || !Array.isArray(next.items)
  ))) throw new Error('批次响应无效');
  return next;
}

function acceptBatch(next) {
  if (disposed) return;
  if (!next || next.id !== batch.value?.id || next.currentIndex !== batch.value?.currentIndex
      || ['done', 'cancelled', 'paused'].includes(next.status)) stopSurface();
  // 只保留约定的进度字段，不缓存接口可能附带的原始账号输入。
  batch.value = next === null ? null : {
    id: next.id, status: next.status, currentIndex: next.currentIndex, createdAt: next.createdAt,
    items: next.items.map(({ email, status, message, accountId, accountCode, loginMethod }) => ({ email, status, message, accountId, accountCode, loginMethod })),
  };
  if (activeBatch.value) { raw.value = ''; previewItems.value = []; showInput.value = false; }
  if (next && ['done', 'cancelled'].includes(next.status) && !notifiedBatches.has(next.id)) {
    notifiedBatches.add(next.id);
    emit('completed');
  }
}

async function withRequest(kind, operation, failureMessage) {
  if (disposed || !visible.value || busy.value) return;
  stopPolling();
  busy.value = kind;
  error.value = '';
  try {
    await operation();
  } catch {
    // 写操作响应丢失时可能已生效，先恢复状态，避免重复创建或误跳过下一个账号。
    if (['create', 'check', 'skip', 'cancel', 'resume'].includes(kind)) restored.value = false;
    if (!disposed && visible.value) error.value = failureMessage;
  } finally {
    if (!disposed) {
      busy.value = '';
      schedulePoll();
    }
  }
}

function refreshCurrent(poll = false) {
  return withRequest(poll ? 'poll' : 'restore', async () => {
    const response = await api.get(`${endpoint}/current`, { silent: true });
    if (disposed || !visible.value) return;
    acceptBatch(readBatch(response, true));
    restored.value = true;
  }, '读取当前批次失败，请点击「刷新当前批次」重试。');
}

function openDialog() {
  if (disposed || busy.value || visible.value) return;
  restored.value = false;
  visible.value = true;
  refreshCurrent();
}

function validateRaw() {
  const lines = raw.value.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > 20) return '每批请输入 1–20 个账号，空行不计入数量。';
  return '';
}

async function inspectFormat() {
  try {
    const response = await api.post('/api/dola/google-login/preview', { raw: raw.value, manual: loginMode.value === 'manual' }, { silent: true });
    if (disposed || !visible.value) return false;
    if (response?.ok !== true || !Array.isArray(response.items)) throw new Error('invalid preview');
    previewItems.value = response.items.map(({ email, loginMethod, hasRecoveryEmail, hasVerificationUrl }) => ({ email, loginMethod, hasRecoveryEmail, hasVerificationUrl }));
    return true;
  } catch (e) {
    if (disposed || !visible.value) return false;
    previewItems.value = [];
    if (e.status === 400) { error.value = e.message; return false; }
    throw e;
  }
}
function previewFormat() {
  const problem = validateRaw();
  if (problem) { error.value = problem; return; }
  return withRequest('preview-format', inspectFormat, '格式检查失败，未启动登录；请稍后再试。');
}

function createBatch() {
  if (disposed || !visible.value || busy.value || activeBatch.value || !restored.value) return;
  const problem = validateRaw();
  if (problem) { error.value = problem; return; }
  return withRequest('create', async () => {
    if (!await inspectFormat() || disposed || !visible.value) return;
    // 同一页面串行提交；提交前恢复其他页面可能创建的批次。跨页面的原子互斥由后端保证。
    const current = await api.get(`${endpoint}/current`, { silent: true });
    if (disposed || !visible.value) return;
    acceptBatch(readBatch(current, true));
    if (activeBatch.value) {
      error.value = '已有批次正在进行，已恢复其进度，请先完成或取消该批次。';
      return;
    }
    const response = await api.post(endpoint, { raw: raw.value, manual: loginMode.value === 'manual' }, { silent: true });
    if (response?.ok === true) { raw.value = ''; previewItems.value = []; showInput.value = false; }
    if (disposed) return;
    acceptBatch(readBatch(response));
  }, '提交结果未确认。请先点击「刷新当前批次」恢复后台状态，再决定是否重新提交。');
}

function runAction(action) {
  if (!restored.value || !activeBatch.value || !['check', 'skip', 'cancel', 'resume'].includes(action)) return;
  if (action === 'resume' && batch.value.status !== 'paused') return;
  if ((action === 'check' && !waitingForUser.value) || (action === 'skip' && !canSkip.value)) return;
  return withRequest(action, async () => {
    const response = await api.post(`${endpoint}/${encodeURIComponent(batch.value.id)}/action`, { action }, { silent: true });
    if (disposed) return;
    acceptBatch(readBatch(response));
  }, '操作结果未确认，请刷新当前批次查看最新进度后再操作。');
}

// ---- 服务器窗口的交互式画面 --------------------------------------------------
// 背景：后台部署在服务器上，「窗口在后台所在电脑弹出」这句话就失效了 ——
// 窗口只渲染在服务器的虚拟屏上，运营屏幕上什么都没有。
// 所以这里把画面拉进后台页面，并把点击 / 按键 / 文本转回去。
function surfaceUrl(suffix = '') {
  return `${endpoint}/${encodeURIComponent(batch.value?.id || '')}${suffix}`;
}

async function refreshSurface() {
  if (disposed || !visible.value || !surfaceOpen.value || !activeBatch.value) return;
  try {
    const result = await api.get(surfaceUrl('/surface'), { silent: true });
    if (disposed || !surfaceOpen.value || !activeBatch.value) return;
    if (result?.ok && result.image) {
      surfaceImage.value = result.image;
      if (result.viewport?.width) surfaceViewport.value = result.viewport;
      surfaceError.value = '';
    }
  } catch { /* 页面正在跳转时取不到画面，是正常的，静默重试即可。 */ }
}

function syncSurfaceTimer() {
  const wanted = surfaceAuto.value && surfaceOpen.value && visible.value && !disposed;
  if (wanted && !surfaceTimer) surfaceTimer = setInterval(() => { void refreshSurface(); }, 900);
  if (!wanted && surfaceTimer) { clearInterval(surfaceTimer); surfaceTimer = null; }
}

function loadSurface() {
  if (!activeBatch.value || busy.value) return;
  return withRequest('surface', async () => {
    surfaceOpen.value = true;
    await refreshSurface();
    if (!surfaceImage.value) throw new Error('surface unavailable');
    surfaceAuto.value = true;
    syncSurfaceTimer();
  }, '暂时无法查看登录窗口，请稍后重试。');
}

function stopSurface() {
  surfaceOpen.value = false;
  surfaceImage.value = '';
  surfaceText.value = '';
  surfaceError.value = '';
  surfaceBusy.value = false;
  if (surfaceTimer) { clearInterval(surfaceTimer); surfaceTimer = null; }
}

// 画面上点到哪儿 → 页面里的坐标。必须按当前显示尺寸做等比换算。
function surfacePointAt(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const view = surfaceViewport.value;
  if (!rect.width || !rect.height || !view.width || !view.height) return null;
  return {
    x: Math.round((event.clientX - rect.left) / rect.width * view.width),
    y: Math.round((event.clientY - rect.top) / rect.height * view.height),
  };
}

async function sendEvent(payload) {
  if (disposed || !activeBatch.value || surfaceBusy.value) return false;
  surfaceBusy.value = true;
  surfaceError.value = '';
  try {
    const result = await api.post(surfaceUrl('/interact'), { event: payload }, { silent: true });
    if (result?.ok !== true) throw new Error('interact rejected');
    return true;
  } catch {
    if (!disposed) surfaceError.value = '这一步没送到窗口，请重试。';
    return false;
  } finally {
    surfaceBusy.value = false;
  }
}

async function surfaceClick(event) {
  const point = surfacePointAt(event);
  if (!point) return;
  if (await sendEvent({ type: 'click', ...point, button: 'left' })) void refreshSurface();
}

function surfaceWheel(event) {
  const point = surfacePointAt(event);
  if (!point) return;
  void sendEvent({ type: 'scroll', ...point, deltaY: event.deltaY });
}

function surfaceKey(key) {
  void sendEvent({ type: 'key', key }).then(ok => { if (ok) void refreshSurface(); });
}

function surfaceSendText() {
  const text = surfaceText.value;
  if (!text) return;
  void sendEvent({ type: 'text', text }).then((ok) => {
    // 送出去后立刻从内存里清掉，不在页面上留痕。
    if (ok) { surfaceText.value = ''; void refreshSurface(); }
  });
}

watch([surfaceAuto, surfaceOpen, visible], syncSurfaceTimer);

watch(visible, (open) => {
  if (!open) {
    clearPreview();
    stopSurface();
    error.value = '';
    restored.value = false;
    stopPolling();
  }
}, { flush: 'sync' });

onBeforeUnmount(() => {
  disposed = true;
  clearPreview();
  stopSurface();
  batch.value = null;
  stopPolling();
});
</script>

<style scoped>
.help { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.credentials { margin-top: 18px; }
.credentials :deep(.el-form-item) { margin-bottom: 8px; }
.credentials :deep(textarea) { font-family: monospace; }
.secret-input :deep(textarea) { -webkit-text-security: disc; }
.formats { margin-bottom: 12px; }
.login-notes { margin-top: 4px; }
.login-notes summary { cursor: pointer; color: var(--el-color-primary); }
.formats code { white-space: normal; }
.format-preview { margin: 12px 0; }
.status-toolbar, .batch-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.status-toolbar { justify-content: space-between; margin: 16px 0; }
.login-surface { margin-top: 12px; }
.surface-frame { margin: 8px 0; border-radius: 8px; overflow: hidden; background: var(--el-fill-color-light); }
.surface-frame img { display: block; width: 100%; height: auto; cursor: crosshair; user-select: none; }
.surface-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.surface-tools .surface-text { max-width: 320px; }
.surface-status { display: flex; align-items: center; gap: 10px; }
.surface-error { color: var(--el-color-danger); }
.batch-head { overflow-wrap: anywhere; }
.batch, .error, .waiting, .items { margin-top: 14px; }
.footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.footer :deep(.el-button + .el-button) { margin-left: 0; }
</style>
