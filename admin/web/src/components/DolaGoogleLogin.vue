<template>
  <el-button type="primary" plain :disabled="!!busy" @click="openDialog">Google 登录入池</el-button>

  <el-dialog
    v-model="visible" title="Google 批量登录入池" width="min(860px, 94vw)"
    append-to-body destroy-on-close :close-on-click-modal="false"
  >
    <el-alert type="info" :closable="false" show-icon>
      <template #title>强制 IP 代理 · 慢速逐字输入 · 每批最多 20 个账号</template>
      <div class="help">
        已有账号沿用已绑定代理；没有代理的账号从现有 IPWeb 配置分配固定独立会话。先检查代理，再逐字输入邮箱和密码。
        代理缺失或不可用会停止，绝不退回直连。每个账号使用独立窗口，窗口会在后台所在电脑弹出。
        经你授权，核验成功的会话会按账号独立保存在本机（不保存密码），最多复用 7 天；先通过原代理核验会话，有效则不重复输入密码。
        遇到验证码或安全限制会停止自动填写并暂停后续账号，当前窗口最多保留 10 分钟；超时会清除剩余密码，不自动换号重试。
        完成当前步骤后点击「我已完成，检查登录」，结束当前账号后才可明确继续剩余账号。
        系统不会绕过验证，也不保证免验证。只有后端验证成功的账号才会入池。
      </div>
    </el-alert>

    <el-form v-if="!activeBatch" label-position="top" class="credentials" @submit.prevent="createBatch">
      <el-form-item label="Google 账号（每行：邮箱|密码）">
        <el-input
          v-model="raw" type="textarea" :rows="6" :disabled="!!busy || !restored"
          autocomplete="off" autocapitalize="off" :spellcheck="false"
          placeholder="alice@example.com|示例密码&#10;bob@example.com|示例密码"
          aria-label="Google 账号，每行邮箱竖线密码"
        />
      </el-form-item>
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

    <section v-if="batch" class="batch" aria-label="Google 登录批次进度">
      <div class="batch-head">
        <el-tag :type="['waiting_user', 'paused'].includes(batch.status) ? 'warning' : 'info'">{{ batchLabels[batch.status] }}</el-tag>
        <span>批次 {{ batch.id }}</span>
        <span class="help">创建于 {{ createdAtLabel }}</span>
      </div>
      <p class="help">已处理 {{ finishedCount }} / {{ batch.items.length }} · 成功入池 {{ succeededCount }} · 失败 {{ failedCount }}</p>
      <el-progress :percentage="progress" />
      <p v-if="activeBatch && currentItem" class="help">当前账号：{{ currentItem.email }}</p>
      <el-alert
        v-if="waitingForUser" type="warning" :closable="false" show-icon class="waiting"
        :title="currentItem?.message || '请查看登录窗口的当前步骤，再点击下方检查登录。'"
      />
      <el-alert v-if="batch.status === 'paused'" type="warning" :closable="false" show-icon class="waiting"
        title="本批曾遇到安全验证，当前窗口已结束，剩余账号仍暂停。确认后才会继续；从首次验证起满 10 分钟仍未继续，将清除剩余密码。" />
      <el-table :data="batch.items" border class="items">
        <el-table-column type="index" label="#" width="48" />
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
      <div v-if="loginPreview && activeBatch" class="login-preview">
        <p class="help">当前登录页快照（输入框已遮挡，不保存图片，点击查看可更新）</p>
        <img :src="loginPreview" alt="当前代理登录窗口，所有输入框已遮挡" style="max-width:100%;border-radius:8px" />
      </div>
    </section>

    <p v-if="activeBatch" class="help">关闭弹窗只停止页面轮询，不会解除安全暂停，也不会重置等待时限；再次打开可恢复进度。若需停止，请点击「取消整批」。</p>
    <template #footer>
      <div class="footer">
        <el-button @click="visible = false">关闭</el-button>
        <template v-if="activeBatch">
          <el-button :loading="busy === 'preview'" :disabled="!!busy || !restored || !canSkip" @click="loadPreview">查看登录窗口</el-button>
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
const batch = ref(null);
const busy = ref('');
const restored = ref(false);
const error = ref('');
const loginPreview = ref('');
let pollTimer = null;
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
      || ['done', 'cancelled', 'paused'].includes(next.status)) loginPreview.value = '';
  // 只保留约定的进度字段，不缓存接口可能附带的原始账号输入。
  batch.value = next === null ? null : {
    id: next.id, status: next.status, currentIndex: next.currentIndex, createdAt: next.createdAt,
    items: next.items.map(({ email, status, message, accountId }) => ({ email, status, message, accountId })),
  };
  if (activeBatch.value) raw.value = '';
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
  for (let i = 0; i < lines.length; i += 1) {
    const separator = lines[i].indexOf('|');
    const email = lines[i].slice(0, separator).trim();
    if (separator < 1 || !/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email) || !lines[i].slice(separator + 1).trim()) {
      return `第 ${i + 1} 个账号格式有误，请使用「邮箱|密码」，两项均不能为空。`;
    }
  }
  return '';
}

function createBatch() {
  if (disposed || !visible.value || busy.value || activeBatch.value || !restored.value) return;
  const problem = validateRaw();
  if (problem) { error.value = problem; return; }
  return withRequest('create', async () => {
    // 同一页面串行提交；提交前恢复其他页面可能创建的批次。跨页面的原子互斥由后端保证。
    const current = await api.get(`${endpoint}/current`, { silent: true });
    if (disposed || !visible.value) return;
    acceptBatch(readBatch(current, true));
    if (activeBatch.value) {
      error.value = '已有批次正在进行，已恢复其进度，请先完成或取消该批次。';
      return;
    }
    const response = await api.post(endpoint, { raw: raw.value }, { silent: true });
    if (response?.ok === true) raw.value = '';
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

function loadPreview() {
  if (!activeBatch.value || busy.value) return;
  return withRequest('preview', async () => {
    const result = await api.get(`${endpoint}/${encodeURIComponent(batch.value.id)}/preview`, { silent: true });
    if (!disposed && visible.value && result?.ok) loginPreview.value = result.image;
  }, '暂时无法查看登录窗口，请稍后重试。');
}

watch(visible, (open) => {
  if (!open) {
    raw.value = '';
    loginPreview.value = '';
    error.value = '';
    restored.value = false;
    stopPolling();
  }
}, { flush: 'sync' });

onBeforeUnmount(() => {
  disposed = true;
  raw.value = '';
  loginPreview.value = '';
  batch.value = null;
  stopPolling();
});
</script>

<style scoped>
.help { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.credentials { margin-top: 18px; }
.credentials :deep(.el-form-item) { margin-bottom: 8px; }
.credentials :deep(textarea) { font-family: monospace; }
.status-toolbar, .batch-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.status-toolbar { justify-content: space-between; margin: 16px 0; }
.batch-head { overflow-wrap: anywhere; }
.batch, .error, .waiting, .items { margin-top: 14px; }
.footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.footer :deep(.el-button + .el-button) { margin-left: 0; }
</style>
