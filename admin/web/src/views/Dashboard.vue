<template>
  <div v-loading="loading">
    <el-row :gutter="14">
      <el-col v-for="c in cards" :key="c.key" :xs="12" :sm="12" :md="6">
        <div class="stat">
          <div class="stat-icon" :style="{ background: c.bg, color: c.color }">
            <el-icon :size="20"><component :is="c.icon" /></el-icon>
          </div>
          <div>
            <div class="stat-num">{{ c.value }}</div>
            <div class="stat-label">{{ c.label }}</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="14" class="mt">
      <el-col :md="12" :sm="24">
        <el-card shadow="never">
          <template #header><span class="card-title">内容状态分布</span></template>
          <div v-if="byStatus.length" class="bars">
            <div v-for="s in byStatus" :key="s.status" class="bar-row">
              <span class="bar-label">{{ statusLabel(s.status) }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: pct(s.c) + '%', background: statusColor(s.status) }" />
              </div>
              <span class="bar-num">{{ s.c }}</span>
            </div>
          </div>
          <el-empty v-else description="暂无内容" :image-size="70" />
        </el-card>
      </el-col>

      <el-col :md="12" :sm="24">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span class="card-title">最近操作</span>
              <el-link type="primary" :underline="false" @click="$router.push('/logs')">全部</el-link>
            </div>
          </template>
          <el-timeline v-if="recentLogs.length" class="tl">
            <el-timeline-item
              v-for="l in recentLogs"
              :key="l.id"
              :timestamp="fmt(l.created_at)"
              size="small"
              :type="l.action.includes('delete') || l.action.includes('failed') ? 'danger' : 'primary'"
            >
              <b>{{ l.username }}</b>
              <span class="muted"> · {{ actionLabel(l.action) }}</span>
              <el-tag v-if="l.target_type" size="small" effect="plain" class="ml">{{ l.target_type }}</el-tag>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="暂无记录" :image-size="70" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="mt">
      <template #header><span class="card-title">近 7 天新增内容</span></template>
      <div v-if="trend.length" class="trend">
        <div v-for="d in trend" :key="d.d" class="trend-col">
          <div class="trend-bar" :style="{ height: trendHeight(d.c) }" :title="`${d.d}：${d.c} 条`" />
          <span class="trend-label">{{ d.d.slice(5) }}</span>
        </div>
      </div>
      <el-empty v-else description="近 7 天没有新增" :image-size="70" />
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const loading = ref(true);
const data = ref({ counts: {}, contentByStatus: [], recentLogs: [], contentTrend: [] });

const cards = computed(() => [
  { key: 'users', label: '用户数', value: data.value.counts.users ?? 0, icon: 'User', bg: 'rgba(64,158,255,.15)', color: '#409eff' },
  { key: 'tokens', label: `访问令牌（启用 ${data.value.counts.tokensActive ?? 0}）`, value: data.value.counts.tokens ?? 0, icon: 'Postcard', bg: 'rgba(155,110,255,.15)', color: '#9b6eff' },
  { key: 'cards', label: `充值卡（未用 ${data.value.counts.cardsUnused ?? 0}）`, value: data.value.counts.cards ?? 0, icon: 'Tickets', bg: 'rgba(230,162,60,.15)', color: '#e6a23c' },
  { key: 'cardPoints', label: '待兑积分（未用卡面额）', value: data.value.counts.cardsUnusedPoints ?? 0, icon: 'Coin', bg: 'rgba(103,194,58,.15)', color: '#67c23a' },
  { key: 'tokenPoints', label: '令牌积分总量', value: data.value.counts.tokenPoints ?? 0, icon: 'Wallet', bg: 'rgba(64,158,255,.12)', color: '#409eff' },
  { key: 'dola', label: `dola 账号（有效 ${data.value.counts.dolaValid ?? 0}）`, value: data.value.counts.dolaAccounts ?? 0, icon: 'Cloudy', bg: 'rgba(155,110,255,.12)', color: '#9b6eff' },
  { key: 'dolaCredits', label: 'dola 额度合计', value: data.value.counts.dolaCredits ?? 0, icon: 'Money', bg: 'rgba(230,162,60,.12)', color: '#e6a23c' },
  { key: 'contents', label: '内容数', value: data.value.counts.contents ?? 0, icon: 'Document', bg: 'rgba(144,147,153,.18)', color: '#909399' },
  { key: 'roles', label: '角色数', value: data.value.counts.roles ?? 0, icon: 'Key', bg: 'rgba(103,194,58,.12)', color: '#67c23a' },
  { key: 'logs', label: '日志条数', value: data.value.counts.logs ?? 0, icon: 'List', bg: 'rgba(144,147,153,.14)', color: '#909399' },
]);

const byStatus = computed(() => data.value.contentByStatus || []);
const recentLogs = computed(() => data.value.recentLogs || []);
const trend = computed(() => data.value.contentTrend || []);
const maxTrend = computed(() => Math.max(1, ...trend.value.map((t) => t.c)));

const STATUS = {
  draft: '草稿', published: '已发布', archived: '已归档',
  active: '启用', disabled: '停用',
};
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
};

function statusLabel(s) { return STATUS[s] || s; }
function statusColor(s) {
  return { draft: '#909399', published: '#67c23a', archived: '#e6a23c' }[s] || '#409eff';
}
function actionLabel(a) { return ACTION[a] || a; }
function pct(n) {
  const total = byStatus.value.reduce((s, x) => s + x.c, 0) || 1;
  return Math.round((n / total) * 100);
}
function trendHeight(n) { return Math.max(6, Math.round((n / maxTrend.value) * 100)) + '%'; }
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

onMounted(async () => {
  try {
    const res = await api.get('/api/stats');
    data.value = res;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.mt { margin-top: 14px; }
.stat {
  display: flex; align-items: center; gap: 14px; padding: 16px;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color-light);
  border-radius: 10px; margin-bottom: 14px;
}
.stat-icon { width: 42px; height: 42px; border-radius: 10px; display: grid; place-items: center; }
.stat-num { font-size: 22px; font-weight: 700; line-height: 1.2; }
.stat-label { font-size: 12px; color: var(--el-text-color-secondary); }
.card-title { font-weight: 600; font-size: 14px; }
.card-head { display: flex; align-items: center; justify-content: space-between; }
.bars { display: flex; flex-direction: column; gap: 14px; padding: 6px 0; }
.bar-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.bar-label { width: 60px; color: var(--el-text-color-secondary); }
.bar-track { flex: 1; height: 8px; background: var(--el-fill-color); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width .3s; }
.bar-num { width: 32px; text-align: right; }
.tl { padding-left: 2px; max-height: 290px; overflow: auto; }
.muted { color: var(--el-text-color-secondary); }
.ml { margin-left: 6px; }
.trend { display: flex; align-items: flex-end; gap: 12px; height: 130px; padding: 8px 4px 0; }
.trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 6px; }
.trend-bar { width: 100%; max-width: 46px; background: var(--el-color-primary); border-radius: 4px 4px 0 0; transition: height .3s; }
.trend-label { font-size: 11px; color: var(--el-text-color-secondary); }
</style>
