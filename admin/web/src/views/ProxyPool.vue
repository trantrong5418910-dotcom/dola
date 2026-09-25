<template>
  <div class="page">
    <!-- 顶部：互斥口径 + 覆盖情况 -->
    <el-card shadow="never" class="mb">
      <div class="kpis">
        <div class="kpi">
          <b>{{ s.total }}</b><span>池内总数</span>
        </div>
        <div class="kpi ok">
          <b>{{ s.alive }}</b><span>健康</span>
        </div>
        <div class="kpi bad">
          <b>{{ s.dead }}</b><span>失效</span>
        </div>
        <div class="kpi warn">
          <b>{{ s.quarantined }}</b><span>隔离中</span>
        </div>
        <div class="kpi mute">
          <b>{{ s.unknown }}</b><span>待巡检</span>
        </div>
        <el-divider direction="vertical" class="tall" />
        <div class="kpi">
          <b>{{ s.distinctExitIps }}</b><span>独立出口 IP</span>
        </div>
        <div class="kpi" :class="s.sharedExitIpGroups ? 'warn' : 'ok'">
          <b>{{ s.sharedExitIpGroups }}</b><span>撞同一出口的组</span>
        </div>
      </div>

      <!-- 覆盖条：一眼看出还有多少号没走池内代理 -->
      <div class="cover">
        <div class="cover-head">
          <span>账号池代理覆盖</span>
          <span class="mono">
            {{ s.accountsInPool }} / {{ s.accountsTotal }}
            <em v-if="s.accountsWithoutPoolProxy">（{{ s.accountsWithoutPoolProxy }} 个仍在走非池出口）</em>
          </span>
        </div>
        <el-progress
          :percentage="coverPct"
          :stroke-width="10"
          :status="coverPct === 100 ? 'success' : (coverPct < 50 ? 'exception' : undefined)"
          :show-text="false"
        />
      </div>

      <el-alert
        v-if="s.accountsWithoutPoolProxy"
        type="warning" :closable="false" show-icon class="mt"
        :title="`有 ${s.accountsWithoutPoolProxy} 个账号没用池内代理。上游按出口 IP 限流，这些号很容易互相撞墙。点「重均衡」可以把它们搬到池里的独立出口上。`"
      />
    </el-card>

    <el-card shadow="never">
      <div class="toolbar">
        <el-button type="primary" :icon="Upload" @click="dlgImport = true">导入代理</el-button>
        <el-button :icon="Search" :loading="busy === 'sweep'" @click="doSweep">巡检</el-button>
        <el-button
          :icon="Unlock" :loading="busy === 'release'"
          :disabled="!s.quarantined" @click="doRelease"
        >释放隔离<template v-if="s.quarantined">（{{ s.quarantined }}）</template></el-button>
        <el-button type="warning" plain :icon="Sort" :loading="busy === 'rebalance'" @click="openRebalance">
          重均衡
        </el-button>
        <div class="spacer" />
        <el-select v-model="filter.state" clearable placeholder="全部状态" style="width:130px" @change="load">
          <el-option label="健康" value="alive" />
          <el-option label="失效" value="dead" />
          <el-option label="隔离中" value="quarantined" />
          <el-option label="待巡检" value="unknown" />
        </el-select>
        <el-input v-model="filter.q" clearable placeholder="搜标签 / 出口 IP" style="width:190px" @keyup.enter="load" />
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>

      <el-table :data="rows" v-loading="loading" border stripe row-key="id">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="代理" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="cell-main">{{ row.label || '—' }}</div>
            <div class="cell-sub mono">{{ row.masked }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag size="small" :type="stateType(row.state)">{{ stateLabel(row.state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="出口" width="185">
          <template #default="{ row }">
            <template v-if="row.exit_ip">
              <div class="mono">{{ row.exit_ip }}</div>
              <div class="cell-sub">{{ row.exit_country || '—' }}{{ row.exit_org ? ' · ' + shortOrg(row.exit_org) : '' }}</div>
            </template>
            <span v-else class="cell-sub">未核验</span>
          </template>
        </el-table-column>
        <el-table-column label="承载" width="86" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.accountCount > 1 ? 'danger' : (row.accountCount === 1 ? 'success' : 'info')">
              {{ row.accountCount }} 号
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="延迟" width="80" align="right">
          <template #default="{ row }">
            <span class="mono">{{ row.latency_ms != null ? row.latency_ms + 'ms' : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="连续失败" width="90" align="center">
          <template #default="{ row }">
            <span :class="{ 'danger-text': row.fail_streak >= 2 }">{{ row.fail_streak }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近探测" width="160">
          <template #default="{ row }">
            <div>{{ fmt(row.last_probe_at) }}</div>
            <div v-if="row.quarantined" class="cell-sub danger-text">隔离至 {{ fmt(row.quarantine_until) }}</div>
            <div v-else-if="row.last_error" class="cell-sub danger-text" :title="row.last_error">{{ short(row.last_error) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openBind(row)">绑定</el-button>
            <el-button size="small" text type="primary" @click="toggleEnabled(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="70">
            <template #description>
              <div>池子是空的。</div>
              <div class="cell-sub">点「导入代理」把 IPWeb 导出的行直接粘进来即可，一行一条。</div>
            </template>
          </el-empty>
        </template>
      </el-table>
    </el-card>

    <!-- ── 导入 ────────────────────────────────────────────── -->
    <el-dialog v-model="dlgImport" title="导入代理" width="640px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon class="mb"
        title="支持两种格式，混着贴也行；重复的会自动跳过（按代理地址去重，不会产生第二条）。" />
      <el-input
        v-model="importText" type="textarea" :rows="8" class="mono"
        placeholder="# 每行一条，以 # 开头的行会被忽略
gate2.ipweb.cc:7778:B_36307_JP___30_Ab000001:你的密码
socks5://user:pass@host:port"
      />
      <el-form label-width="70px" class="mt">
        <el-form-item label="分组">
          <el-input v-model="importGroup" placeholder="可选，比如 jp-residential" style="width:260px" />
        </el-form-item>
      </el-form>
      <el-alert v-if="importResult" :type="importResult.failed ? 'warning' : 'success'" :closable="false" class="mt">
        <template #title>
          导入 {{ importResult.total }} 行：新增 {{ importResult.added }}、重复 {{ importResult.duplicates }}、失败 {{ importResult.failed }}
        </template>
        <div v-if="importResult.failed" class="mono cell-sub">
          <div v-for="(r, i) in importResult.results.filter((x) => !x.ok)" :key="i">{{ r.line }} → {{ r.message }}</div>
        </div>
      </el-alert>
      <template #footer>
        <el-button @click="dlgImport = false">关闭</el-button>
        <el-button type="primary" :loading="busy === 'import'" @click="doImport">开始导入</el-button>
      </template>
    </el-dialog>

    <!-- ── 绑定 ────────────────────────────────────────────── -->
    <el-dialog v-model="dlgBind" :title="`绑定代理 —— ${bindTarget?.label || ''}`" width="560px" :close-on-click-modal="false">
      <el-alert type="warning" :closable="false" show-icon class="mb"
        title="上游按出口 IP 限流，一个 IP 承载多个账号必然撞墙。这条代理的出口会被独占绑给下面这些账号。" />
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="代理">{{ bindTarget?.masked }}</el-descriptions-item>
        <el-descriptions-item label="出口">{{ bindTarget?.exit_ip || '未核验（绑定后会清空账号原有的出口核验，需要重新核验）' }}</el-descriptions-item>
      </el-descriptions>
      <el-checkbox v-model="bindOnlyUnbound" class="mt">只绑定「还没有配代理」的账号（推荐）</el-checkbox>
      <el-alert v-if="bindResult" :type="bindResult.failed ? 'warning' : 'success'" :closable="false" class="mt">
        <template #title>
          绑定 {{ bindResult.bound }} 个，跳过 {{ bindResult.skipped }} 个，失败 {{ bindResult.failed }} 个
        </template>
      </el-alert>
      <template #footer>
        <el-button @click="dlgBind = false">关闭</el-button>
        <el-button type="primary" :loading="busy === 'bind'" @click="doBind">确认绑定</el-button>
      </template>
    </el-dialog>

    <!-- ── 重均衡 ──────────────────────────────────────────── -->
    <el-dialog v-model="dlgRebalance" title="池内重均衡" width="720px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon class="mb"
        title="只处理四类账号：没配代理的、代理不在池里的、代理已失效或隔离中的、与其他账号共用出口 IP 的。已经有独占健康出口的号一律不动。" />

      <template v-if="plan">
        <div class="plan-head">
          需处理 <b>{{ plan.needFix }}</b> 个 ·
          能分配 <b class="ok-text">{{ plan.plan?.length || 0 }}</b> 个 ·
          池内可用代理不足 <b class="danger-text">{{ plan.unassigned }}</b> 个
        </div>
        <div class="plan-reasons">
          <el-tag v-for="(n, k) in plan.reasonBreakdown" :key="k" size="small" type="info" class="mr">{{ reasonLabel(k) }} × {{ n }}</el-tag>
        </div>
        <el-table :data="plan.plan || []" size="small" border max-height="260" class="mt">
          <el-table-column prop="accountId" label="账号" width="70" />
          <el-table-column prop="label" label="备注名" min-width="110" show-overflow-tooltip />
          <el-table-column label="问题" width="130">
            <template #default="{ row }"><el-tag size="small" type="warning">{{ reasonLabel(row.reason) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="将分配到" min-width="150">
            <template #default="{ row }">#{{ row.proxyId }} → <span class="mono">{{ row.exitIp }}</span></template>
          </el-table-column>
        </el-table>
        <el-alert v-if="plan.unassigned" type="warning" :closable="false" show-icon class="mt"
          :title="`池内独立出口不够，${plan.unassigned} 个账号这次分不到。系统不会让两个号共用一个出口 —— 先补代理再重均衡。`" />
      </template>
      <el-skeleton v-else :rows="4" animated />
      <template #footer>
        <el-button @click="dlgRebalance = false">关闭</el-button>
        <el-button
          type="primary" :loading="busy === 'rebalance'"
          :disabled="!plan || !(plan.plan?.length)"
          @click="applyRebalance"
        >确认执行（{{ plan?.plan?.length || 0 }} 个）</el-button>
      </template>
    </el-dialog>

    <!-- ── 巡检结果 ────────────────────────────────────────── -->
    <el-dialog v-model="dlgSweep" title="巡检结果" width="720px">
      <div v-if="sweepResult" class="plan-head">
        巡检 <b>{{ sweepResult.total }}</b> 条 ·
        通过 <b class="ok-text">{{ sweepResult.okCount }}</b> ·
        失败 <b class="danger-text">{{ sweepResult.failCount }}</b> ·
        新隔离 <b class="warn-text">{{ sweepResult.quarantined }}</b> ·
        恢复 <b class="ok-text">{{ sweepResult.released }}</b> ·
        账号出口同步 <b>{{ sweepResult.accountsSynced }}</b>
      </div>
      <el-alert v-if="sweepResult?.inconclusive" type="warning" :closable="false" show-icon class="mb"
        :title="`有 ${sweepResult.inconclusive} 条没能判定：出口检测服务自己限流/故障。这些没有被记成失败，状态保持不变。`" />
      <el-table :data="sweepResult?.details || []" size="small" border stripe max-height="360">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column prop="label" label="代理" min-width="150" show-overflow-tooltip />
        <el-table-column label="结果" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.ok ? 'success' : (row.inconclusive ? 'warning' : 'danger')">
              {{ row.ok ? '通过' : (row.inconclusive ? '无法判定' : '失败') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="出口 / 原因" min-width="230">
          <template #default="{ row }">
            <span v-if="row.ok" class="mono">{{ row.exitIp }} <em class="cell-sub">{{ row.exitCountry }}</em></span>
            <span v-else class="cell-sub danger-text" :title="row.error">{{ short(row.error) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name。
defineOptions({ name: 'ProxyPool' });

import { computed, onMounted, reactive, ref } from 'vue';
import { Refresh, Search, Sort, Unlock, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs } from '../api.js';

const loading = ref(false);
const busy = ref('');
const rows = ref([]);
const s = ref({
  total: 0, enabled: 0, disabled: 0, alive: 0, dead: 0, unknown: 0, quarantined: 0,
  distinctExitIps: 0, sharedExitIpGroups: 0,
  accountsInPool: 0, accountsTotal: 0, accountsWithoutPoolProxy: 0,
});
const filter = reactive({ state: '', q: '' });

const dlgImport = ref(false);
const importText = ref('');
const importGroup = ref('');
const importResult = ref(null);

const dlgBind = ref(false);
const bindTarget = ref(null);
const bindOnlyUnbound = ref(true);
const bindResult = ref(null);

const dlgRebalance = ref(false);
const plan = ref(null);

const dlgSweep = ref(false);
const sweepResult = ref(null);

const coverPct = computed(() => {
  const t = s.value.accountsTotal || 0;
  return t ? Math.round(((s.value.accountsInPool || 0) / t) * 100) : 0;
});

function fmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
}
const short = (v) => (String(v || '').length > 34 ? String(v).slice(0, 34) + '…' : String(v || ''));
const shortOrg = (v) => String(v || '').replace(/^AS\d+\s*/i, '').slice(0, 18);

const STATE = { alive: ['健康', 'success'], dead: ['失效', 'danger'], quarantined: ['隔离中', 'warning'], unknown: ['待巡检', 'info'] };
const stateLabel = (x) => (STATE[x] || [x || '未知'])[0];
const stateType = (x) => (STATE[x] || ['', 'info'])[1];

const REASON = {
  'no-proxy': '没配代理',
  'proxy-not-in-pool': '代理不在池里',
  'proxy-dead': '代理已失效',
  'proxy-quarantined': '代理被隔离',
  'shared-exit-ip': '共用出口 IP',
};
const reasonLabel = (k) => REASON[k] || k;

async function load() {
  loading.value = true;
  try {
    const r = await api.get('/api/proxy-pool' + qs({ state: filter.state, q: filter.q, pageSize: 300 }));
    rows.value = r.items || [];
    s.value = r.summary || s.value;
  } finally { loading.value = false; }
}

async function doImport() {
  if (!importText.value.trim()) return ElMessage.warning('先粘贴要导入的代理');
  busy.value = 'import';
  try {
    importResult.value = await api.post('/api/proxy-pool/import', {
      text: importText.value, group: importGroup.value.trim(),
    });
    ElMessage.success(`新增 ${importResult.value.added} 条，重复 ${importResult.value.duplicates} 条`);
    importText.value = '';
    load();
  } finally { busy.value = ''; }
}

async function doSweep() {
  busy.value = 'sweep';
  try {
    sweepResult.value = await api.post('/api/proxy-pool/sweep', { limit: 100 });
    dlgSweep.value = true;
    load();
  } finally { busy.value = ''; }
}

async function doRelease() {
  try {
    await ElMessageBox.confirm(
      `把 ${s.value.quarantined} 条隔离中的代理放回池子。它们会被置为「待巡检」而不是「健康」—— 下次巡检确认真的通了才算恢复。`,
      '释放隔离', { type: 'warning', confirmButtonText: '释放' },
    );
  } catch { return; }
  busy.value = 'release';
  try {
    const r = await api.post('/api/proxy-pool/release-isolated', { all: true, probe: true });
    ElMessage.success(`已释放 ${r.released} 条`);
    load();
  } finally { busy.value = ''; }
}

async function openRebalance() {
  dlgRebalance.value = true;
  plan.value = null;
  try {
    plan.value = await api.post('/api/proxy-pool/rebalance', { dryRun: true });
  } finally { /* 预览失败也把弹窗留着，显示骨架 */ }
}

async function applyRebalance() {
  busy.value = 'rebalance';
  try {
    const r = await api.post('/api/proxy-pool/rebalance', { verify: true });
    ElMessage.success(`已分配 ${r.assigned} 个账号${r.unassigned ? `，还有 ${r.unassigned} 个因池内出口不足未分配` : ''}`);
    dlgRebalance.value = false;
    load();
  } finally { busy.value = ''; }
}

function openBind(row) {
  bindTarget.value = row;
  bindResult.value = null;
  bindOnlyUnbound.value = true;
  dlgBind.value = true;
}

async function doBind() {
  busy.value = 'bind';
  try {
    bindResult.value = await api.post('/api/proxy-pool/bind', {
      proxyId: bindTarget.value.id,
      onlyUnbound: bindOnlyUnbound.value,
      verify: true,
    });
    load();
  } finally { busy.value = ''; }
}

async function toggleEnabled(row) {
  await api.patch(`/api/proxy-pool/${row.id}`, { enabled: !row.enabled });
  ElMessage.success(row.enabled ? '已停用' : '已启用');
  load();
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `删除代理 #${row.id}（${row.label}）。如果还有账号在用它，会被拒绝 —— 那种情况应该先重均衡。`,
      '删除代理', { type: 'warning', confirmButtonText: '删除' },
    );
  } catch { return; }
  try {
    await api.del(`/api/proxy-pool/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    // 被拒的场景（还有账号在用）走到这里，提示已经由 api 层弹过，补一个更明确的
    if (e.status === 409) ElMessage.warning('这条代理还有账号在用，先重均衡或先解绑');
  }
}

onMounted(load);
</script>

<style scoped>
.page { padding: 0; }
.mb { margin-bottom: 12px; }
.mt { margin-top: 12px; }
.mr { margin-right: 6px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.spacer { flex: 1; }
.tall { height: 34px; }

.kpis { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.kpi { display: flex; flex-direction: column; line-height: 1.25; }
.kpi b { font-size: 22px; font-weight: 650; }
.kpi span { font-size: 12px; opacity: 0.62; }
.kpi.ok b { color: var(--el-color-success); }
.kpi.bad b { color: var(--el-color-danger); }
.kpi.warn b { color: var(--el-color-warning); }
.kpi.mute b { opacity: 0.55; }

.ok-text { color: var(--el-color-success); }
.danger-text { color: var(--el-color-danger); }
.warn-text { color: var(--el-color-warning); }

.cover { margin-top: 16px; }
.cover-head { display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 5px; opacity: 0.8; }
.cover-head em { font-style: normal; color: var(--el-color-warning); }

.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }

.cell-main { font-weight: 550; }
.cell-sub { font-size: 11.5px; opacity: 0.6; }

.plan-head { font-size: 13px; margin-bottom: 10px; }
.plan-reasons { display: flex; flex-wrap: wrap; gap: 2px; }
</style>
