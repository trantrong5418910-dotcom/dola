<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input v-model="query.keyword" placeholder="搜索用户名 / 详情" clearable style="width: 240px" @keyup.enter="reload" @clear="reload" />
      <el-select v-model="query.action" placeholder="全部动作" clearable filterable style="width: 190px" @change="reload">
        <el-option v-for="a in actions" :key="a" :label="actionLabel(a)" :value="a" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
      <div class="spacer" />
      <el-button :icon="Download" :loading="exporting" @click="exportDiagnostics">导出脱敏诊断包</el-button>
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <el-table :data="items" v-loading="loading" border stripe>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="created_at" label="时间" width="150">
        <template #default="{ row }">{{ fmt(row.created_at) }}</template>
      </el-table-column>
      <el-table-column prop="username" label="操作人" width="110" />
      <el-table-column label="动作" width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="actionType(row.action)" effect="plain">{{ actionLabel(row.action) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="target_type" label="对象" width="90" />
      <el-table-column prop="target_id" label="对象 ID" width="80" show-overflow-tooltip />
      <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
      <el-table-column prop="ip" label="IP" width="140" show-overflow-tooltip />
      <template #empty><el-empty description="暂无日志" :image-size="80" /></template>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :current-page="query.page"
      :page-size="query.pageSize"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="(p) => { query.page = p; load(); }"
      @size-change="(s) => { query.pageSize = s; query.page = 1; load(); }"
    />
  </el-card>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Download, Refresh, Search } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';

const items = ref([]);
const actions = ref([]);
const total = ref(0);
const loading = ref(false);
const exporting = ref(false);
const query = reactive({ page: 1, pageSize: 20, keyword: '', action: '' });

const ACTION = {
  login: '登录', logout: '退出', login_failed: '登录失败',
  'user.create': '新建用户', 'user.update': '修改用户', 'user.delete': '删除用户',
  'user.reset_password': '重置密码', change_password: '修改密码',
  'content.create': '新建内容', 'content.update': '修改内容', 'content.delete': '删除内容',
  'content.bulk_delete': '批量删除内容',
  'role.create': '新建角色', 'role.delete': '删除角色', 'role.update_permissions': '配置权限',
  'setting.update': '修改设置',
  'token.generate': '生成令牌', 'token.reveal': '查看令牌', 'token.points': '调整令牌积分',
  'token.disable': '停用令牌', 'token.enable': '启用令牌', 'token.revoke': '撤销令牌',
  'token.delete': '删除令牌', 'token.expire': '设置令牌过期', 'token.export': '导出令牌',
  'card.generate': '生成卡密', 'card.redeem': '兑换卡密', 'card.revoke': '撤销卡密',
  'card.restore': '恢复卡密', 'card.delete': '删除卡密', 'card.bulk_delete': '批量删除卡密',
  'card.reveal': '查看卡密', 'card.export': '导出卡密',
  'dola.import': '导入 dola 账号', 'dola.reveal': '查看账号 cookie', 'dola.probe': '探测额度接口',
  'dola.check': '校验账号', 'dola.disable': '停用账号', 'dola.enable': '启用账号',
  'dola.set_credits': '手动录入额度', 'dola.convert': '额度转积分',
  'dola.delete': '删除账号', 'dola.force_delete': '强制删除账号', 'dola.bulk_delete': '批量删除账号',
  'dola.job_create': '提交批量任务', 'dola.job_cancel': '取消批量任务',
  'gateway.gen.preflight_rejected': '生成预检未通过',
};
const actionLabel = (a) => ACTION[a] || a;
function actionType(a) {
  if (a.includes('failed') || a.includes('preflight_rejected')) return 'danger';
  if (a.includes('delete')) return 'warning';
  if (a === 'login' || a === 'logout') return 'info';
  return 'primary';
}
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

async function load() {
  loading.value = true;
  try {
    const res = await api.get(`/api/logs${qs(query)}`);
    items.value = res.items;
    total.value = res.total;
  } finally { loading.value = false; }
}
function reload() { query.page = 1; load(); }

async function exportDiagnostics() {
  exporting.value = true;
  try {
    const result = await api.get('/api/logs/diagnostics');
    const blob = new Blob([JSON.stringify(result.bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.fileName || 'workbench-diagnostics.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally {
    exporting.value = false;
  }
}

onMounted(async () => {
  load();
  try { actions.value = (await api.get('/api/logs/actions')).items; } catch { /* ignore */ }
});
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.spacer { flex: 1; }
.pager { margin-top: 14px; justify-content: flex-end; }
</style>
