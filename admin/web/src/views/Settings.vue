<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="head">
        <span class="title">系统设置</span>
        <el-button v-if="can('setting:update')" type="primary" :loading="saving" :disabled="loading" @click="save">保存全部</el-button>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="这些值存在 settings 表里，改完立即生效（登录有效期对下次登录生效）。"
      class="tip"
    />

    <div v-for="g in groups" :key="g.name" class="group">
      <h3>{{ g.name }}</h3>
      <el-form label-width="150px" label-position="left">
        <el-form-item v-for="it in g.items" :key="it.key" :label="MAINTENANCE_LABELS[it.key] || it.label"
          :error="it.key === MAINTENANCE_INTERVAL && !validMaintenanceInterval(it.value) ? INTERVAL_ERROR : undefined">
          <el-switch
            v-if="isBool(it.key)"
            v-model="it.value"
            active-value="true"
            inactive-value="false"
            :disabled="!can('setting:update')"
          />
          <el-select
            v-else-if="isEnum(it.key)"
            v-model="it.value"
            :disabled="!can('setting:update')"
            style="width: 220px"
          >
            <el-option v-for="o in enumOptions(it.key)" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-input-number
            v-else-if="it.key === MAINTENANCE_INTERVAL"
            :model-value="it.value === '' ? undefined : Number(it.value)"
            @update:model-value="(value) => { it.value = value == null ? '' : String(value); }"
            :min="15" :max="1440" :step="1" :precision="0"
            :disabled="!can('setting:update')"
            aria-label="自动巡检间隔（分钟）"
          />
          <el-input-number
            v-else-if="it.key === GENERATION_CONCURRENCY"
            :model-value="it.value === '' ? undefined : Number(it.value)"
            @update:model-value="(value) => { it.value = value == null ? '' : String(value); }"
            :min="1" :max="20" :step="1" :precision="0"
            :disabled="!can('setting:update')"
            aria-label="视频生成并发数"
          />
          <el-input-number
            v-else-if="it.key === GENERATION_QUEUE_LIMIT"
            :model-value="it.value === '' ? undefined : Number(it.value)"
            @update:model-value="(value) => { it.value = value == null ? '' : String(value); }"
            :min="1" :max="6000" :step="1" :precision="0"
            :disabled="!can('setting:update')"
            aria-label="视频生成队列容量"
          />
          <el-input
            v-else
            v-model="it.value"
            :disabled="!can('setting:update')"
            :style="{ maxWidth: isNumber(it.key) ? '180px' : '420px' }"
          >
            <template v-if="isNumber(it.key)" #append>{{ unit(it.key) }}</template>
          </el-input>
          <span v-if="it.key === MAINTENANCE_INTERVAL" class="unit">分钟</span>
          <div v-if="MAINTENANCE_HELP[it.key]" class="setting-help">{{ MAINTENANCE_HELP[it.key] }}</div>
        </el-form-item>
      </el-form>
    </div>
  </el-card>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const loading = ref(true);
const saving = ref(false);

const MAINTENANCE_INTERVAL = 'dola_auto_maintenance_interval_minutes';
const GENERATION_CONCURRENCY = 'dola_gen_concurrency';
const GENERATION_QUEUE_LIMIT = 'dola_gen_queue_limit';
const INTERVAL_ERROR = '自动巡检间隔须为 15～1440 分钟的整数';
const MAINTENANCE_LABELS = {
  dola_auto_maintenance_enabled: '自动维护',
  dola_auto_cleanup_invalid: '隔离失效账号',
  dola_auto_quota_probe: '探测可查询额度',
  [MAINTENANCE_INTERVAL]: '自动巡检间隔',
  [GENERATION_CONCURRENCY]: '视频生成并发数',
  [GENERATION_QUEUE_LIMIT]: '视频生成队列容量',
};
const MAINTENANCE_HELP = {
  dola_auto_maintenance_enabled: '定期校验账号。关闭后仍可在账号池手动执行一次维护；当前任务状态和下次巡检时间请查看账号池。',
  dola_auto_cleanup_invalid: '维护时隔离明确失效的账号，保留 cookie，不删除账号。',
  dola_auto_quota_probe: '维护时读取接口能返回的额度。免费日额度仍需当日生成回执确认，未知或历史值不会自动补满。',
  [MAINTENANCE_INTERVAL]: '可设置 15～1440 分钟，保存后按新间隔调度。',
  [GENERATION_CONCURRENCY]: '不同账号可并行生成；同一账号自动排队。这里控制实际浏览器工作进程，单机上限 20，默认保持 1；不要把它当成排队容量。',
  [GENERATION_QUEUE_LIMIT]: '允许同时存在的排队+运行任务数，最多 6000；不会同时启动 6000 个浏览器，实际执行数量仍由“视频生成并发数”控制。',
  dola_gen_min_submit_interval_sec: '同一出口 IP 两次浏览器提交之间的保护间隔；遇到 710022002 时可适当拉长。',
  dola_ratelimit_cooldown_min: '真实命中上游限流后，账号进入冷却的分钟数；不会把账号误判成失效。',
  dola_autorotate_max_attempts: '上游限流后自动换号重试的最大账号数（含首次提交）；设为 1 等于不换号。',
  dola_replenish_min_accounts: '号池有效账号低于此数时，账号池顶部显示补号提示。',
  dola_replenish_min_quota: '号池已确认剩余额度低于此数时，账号池顶部显示补号提示；设为 0 则只按账号数判断。',
  gateway_prompt_cooldown_seconds: '同一用户令牌重复提交相同提示词的保护时间；设为 0 可关闭。',
};
function validMaintenanceInterval(value) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440;
}

const GROUP_NAME = { general: '通用', security: '安全', dola: 'dola 账号池', frontend: '前台入口' };
const BOOL_KEYS = [
  'allow_register', 'dola_use_browser', 'dola_convert_auto_zero', 'frontend_browser_visible',
  'dola_auto_maintenance_enabled', 'dola_auto_cleanup_invalid', 'dola_auto_quota_probe',
];
const NUMBER_KEYS = ['page_size', 'session_hours', 'dola_credits_per_point', 'dola_points_per_account',
  'dola_check_concurrency', 'dola_http_timeout', 'dola_browser_concurrency',
  'dola_gen_concurrency', 'dola_gen_queue_limit', 'dola_gen_min_submit_interval_sec',
  'dola_ratelimit_cooldown_min', 'dola_autorotate_max_attempts',
  'dola_replenish_min_accounts', 'dola_replenish_min_quota',
  'gateway_prompt_cooldown_seconds', 'dola_auto_maintenance_interval_minutes'];
const ENUM_KEYS = {
  dola_convert_basis: [{ value: 'account', label: '按账号数计价' }, { value: 'credits', label: '按额度计价' }],
  frontend_open_mode: [{ value: 'tab', label: '新标签页直接跳转' }, { value: 'browser', label: '服务器上开真实浏览器' }],
};
const UNIT = {
  page_size: '条', session_hours: '小时',
  dola_credits_per_point: '额度', dola_points_per_account: '积分', dola_check_concurrency: '个',
  dola_http_timeout: '秒', dola_browser_concurrency: '个', dola_gen_concurrency: '个', dola_gen_queue_limit: '个任务',
  dola_gen_min_submit_interval_sec: '秒', dola_ratelimit_cooldown_min: '分钟', dola_autorotate_max_attempts: '个', dola_replenish_min_accounts: '个', dola_replenish_min_quota: '额度',
  gateway_prompt_cooldown_seconds: '秒', dola_auto_maintenance_interval_minutes: '分钟',
};
const isEnum = (k) => Object.hasOwn(ENUM_KEYS, k);
const enumOptions = (k) => ENUM_KEYS[k];

const groups = computed(() => {
  const map = new Map();
  for (const it of items.value) {
    const name = GROUP_NAME[it.group_name] || it.group_name;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(it);
  }
  return [...map.entries()].map(([name, list]) => ({ name, items: list }));
});

const isBool = (k) => BOOL_KEYS.includes(k);
const isNumber = (k) => NUMBER_KEYS.includes(k);
const unit = (k) => UNIT[k] || '';

async function load() {
  loading.value = true;
  try {
    items.value = (await api.get('/api/settings')).items;
  } finally { loading.value = false; }
}

async function save() {
  if (saving.value || loading.value) return;
  const interval = items.value.find((it) => it.key === MAINTENANCE_INTERVAL);
  if (interval && !validMaintenanceInterval(interval.value)) return ElMessage.warning(INTERVAL_ERROR);
  saving.value = true;
  try {
    const patch = {};
    for (const it of items.value) patch[it.key] = it.value;
    const res = await api.put('/api/settings', patch);
    ElMessage.success(`已保存 ${res.changed.length} 项`);
  } finally { saving.value = false; }
}

onMounted(load);
</script>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; }
.title { font-weight: 600; }
.tip { margin-bottom: 18px; }
.group { margin-bottom: 8px; }
.group h3 { font-size: 14px; margin: 18px 0 12px; padding-left: 10px; border-left: 3px solid var(--el-color-primary); }
.setting-help { flex-basis: 100%; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; margin-top: 4px; }
.unit { margin-left: 8px; color: var(--el-text-color-secondary); }
</style>
