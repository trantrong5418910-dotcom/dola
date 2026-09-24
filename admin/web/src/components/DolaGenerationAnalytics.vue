<template>
  <el-card shadow="never" class="generation-analytics" v-loading="loading">
    <template #header>
      <div class="analytics-toolbar">
        <strong>生成统计与复核</strong>
        <el-select v-model="hours" aria-label="统计范围" style="width:150px" @change="refresh()">
          <el-option :value="24" label="最近 24 小时" />
          <el-option :value="72" label="最近 3 天" />
          <el-option :value="168" label="最近 7 天" />
        </el-select>
        <el-select v-model="timezone" aria-label="统计时区" style="width:185px" @change="refresh()">
          <el-option value="America/Chicago" label="芝加哥（含夏令时）" />
          <el-option value="Asia/Shanghai" label="北京时间" />
          <el-option value="UTC" label="UTC" />
        </el-select>
        <el-button :loading="loading" @click="refresh()">刷新统计</el-button>
        <span class="muted" v-if="data">更新于 {{ new Date(data.until).toLocaleTimeString('zh-CN', { timeZone: timezone }) }} · 30 秒自动刷新</span>
      </div>
    </template>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
    <template v-if="data">
      <div class="analytics-cards">
        <div v-for="item in metrics" :key="item.key" class="metric">
          <span>{{ item.label }}</span><b :class="item.key">{{ data.totals[item.key] }}</b>
        </div>
        <div class="metric"><span>已结案成功率</span><b>{{ data.successRate === null ? '—' : `${data.successRate}%` }}</b></div>
      </div>
      <p class="muted explanation">
        按创建小时归组，成功 / 失败是该批任务的当前结果，不是该小时完成量。范围含当前未结束的小时；空小时补零。成功率 = 成功 ÷（成功 + 失败），取消和进行中不计入。
        仅统计 8788 留存记录（全部令牌），不含已删除任务、落库前拒绝及外部直提任务。
      </p>
      <p class="muted">全部留存：{{ data.allTime.created }} 创建 · {{ data.allTime.succeeded }} 成功 · {{ data.allTime.failed }} 失败 · {{ data.allTime.cancelled }} 取消 · {{ data.allTime.pending }} 进行中</p>
      <el-table :data="data.hourly" border stripe max-height="350" size="small" empty-text="该范围暂无任务">
        <el-table-column prop="label" label="创建小时（所选时区）" min-width="210" />
        <el-table-column prop="created" label="创建" min-width="75" />
        <el-table-column prop="succeeded" label="成功" min-width="75" />
        <el-table-column prop="failed" label="失败" min-width="75" />
        <el-table-column prop="cancelled" label="取消" min-width="75" />
        <el-table-column prop="pending" label="进行中" min-width="85" />
        <el-table-column v-if="data.totals.other" prop="other" label="其他状态" min-width="85" />
      </el-table>
      <h3>失败原因（所选范围）</h3>
      <p class="muted">依据错误回执分类，属于排查线索，不替代上游核验；不会自动重试、换号或补扣费。</p>
      <el-table :data="data.reasons" border stripe size="small" empty-text="该范围没有失败记录">
        <el-table-column prop="label" label="已观察到的原因" min-width="210" />
        <el-table-column prop="count" label="条数" width="75" />
        <el-table-column label="最近任务" width="100"><template #default="{ row }">#{{ row.latestTaskId }}</template></el-table-column>
        <el-table-column prop="action" label="处理建议" min-width="340" />
      </el-table>
      <h3>重复失败保护 · {{ data.guards.length }} 项待复核</h3>
      <p class="muted">能力失败后暂停同账号同能力的提交，并撤销过时可用标记。下表为全部当前保护项，不受上方时间范围影响。只读复核仅打开页面控件，不填提示词、不生成视频；通过也不代表有额度或能保证成片。限流另沿用账号冷却机制。</p>
      <el-table :data="data.guards" border stripe size="small" max-height="300" empty-text="暂无待复核保护项">
        <el-table-column prop="account_id" label="账号 ID" width="100" />
        <el-table-column prop="label" label="暂停能力" width="110" />
        <el-table-column label="触发任务" width="100"><template #default="{ row }">#{{ row.source_task_id }}</template></el-table-column>
        <el-table-column label="触发时间" min-width="175"><template #default="{ row }">{{ new Date(row.blocked_at).toLocaleString('zh-CN', { timeZone: timezone }) }}</template></el-table-column>
        <el-table-column label="操作" min-width="160">
          <template #default="{ row }">
            <el-button v-if="can('dola:check')" size="small" :disabled="Boolean(probing)" :loading="probing === `${row.account_id}/${row.scope}`" @click="probe(row)">只读复核后恢复</el-button>
            <span v-else class="muted">需账号校验权限</span>
          </template>
        </el-table-column>
      </el-table>
    </template>
    <el-empty v-else-if="!loading && !error" description="暂无统计数据" />
  </el-card>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, qs } from '../api.js';
import { can } from '../store.js';
const hours = ref(24), timezone = ref('America/Chicago');
const data = ref(null), loading = ref(false), error = ref(''), probing = ref('');
const metrics = [
  { key: 'created', label: '创建' }, { key: 'succeeded', label: '成功' },
  { key: 'failed', label: '失败' }, { key: 'cancelled', label: '取消' }, { key: 'pending', label: '进行中' },
];
let timer, disposed = false, requestId = 0;
async function refresh(silent = false) {
  const id = ++requestId;
  if (!silent) { loading.value = true; data.value = null; }
  try {
    const response = await api.get(`/api/dola/generation-analytics${qs({ hours: hours.value, timezone: timezone.value })}`, { silent: true });
    if (disposed || id !== requestId) return;
    data.value = response; error.value = '';
  } catch {
    if (!disposed && id === requestId) error.value = '统计读取失败，请刷新；已有数字可能已过期。';
  } finally { if (!disposed && id === requestId) loading.value = false; }
}
async function poll() {
  if (!loading.value) await refresh(true);
  if (!disposed) timer = setTimeout(poll, 30000);
}
async function probe(row) {
  try {
    await ElMessageBox.confirm(`通过账号 #${row.account_id} 已绑定代理复核 ${row.label} 控件；不提交视频、不消耗生成额度。复核成功才解除此项保护，是否继续？`, '只读能力复核', { type: 'info' });
  } catch { return; }
  probing.value = `${row.account_id}/${row.scope}`;
  try {
    const result = await api.post(`/api/dola/accounts/${row.account_id}/generation-guard-probe`, { scope: row.scope });
    ElMessage[result.cleared ? 'success' : 'warning'](result.message);
    await refresh(true);
  } catch { /* API wrapper displays the error. */ }
  finally { probing.value = ''; }
}
onMounted(() => { refresh(); timer = setTimeout(poll, 30000); });
onUnmounted(() => { disposed = true; clearTimeout(timer); });
</script>

<style scoped>
.analytics-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.analytics-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:12px; margin:4px 0 14px; }
.metric { display:flex; flex-direction:column; gap:8px; padding:14px; background:var(--el-fill-color-light); border-radius:8px; }
.metric span,.muted { color:var(--el-text-color-secondary); font-size:12px; }
.metric b { font-size:25px; }
.succeeded { color:var(--el-color-success); }.failed { color:var(--el-color-danger); }
.explanation { line-height:1.8; } h3 { font-size:14px; margin-top:24px; }
</style>
