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
      <el-form class="settings-form" label-width="190px" label-position="left">
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
            v-else-if="isTextarea(it.key)"
            v-model="it.value"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :disabled="!can('setting:update')"
            style="max-width: 560px"
          />
          <el-input
            v-else
            v-model="it.value"
            :type="it.key === 'llm_api_key' ? 'password' : 'text'"
            :show-password="it.key === 'llm_api_key' && can('setting:update')"
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
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'Settings' });
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
  // 账号池的数据库 label 包含完整说明；左侧只显示短名称，说明放到帮助行。
  dola_credits_per_point: '额度兑换比例',
  dola_points_per_account: '账号计价积分',
  dola_convert_basis: '默认计价方式',
  dola_check_concurrency: '批量校验并发',
  dola_http_timeout: '接口超时',
  dola_use_browser: '额度查询通道',
  dola_browser_concurrency: '浏览器通道并发',
  dola_auto_maintenance_enabled: '自动维护',
  dola_auto_cleanup_invalid: '隔离失效账号',
  dola_auto_quota_probe: '探测可查询额度',
  [MAINTENANCE_INTERVAL]: '自动巡检间隔',
  [GENERATION_CONCURRENCY]: '视频生成并发数',
  [GENERATION_QUEUE_LIMIT]: '视频生成队列容量',
  dola_gen_min_submit_interval_sec: '提交间隔',
  dola_ratelimit_cooldown_min: '限流冷却',
  dola_autorotate_max_attempts: '自动换号次数',
  dola_replenish_min_accounts: '补号提示账号阈值',
  dola_replenish_min_quota: '补号提示额度阈值',
  dola_quota_reset_tz: '额度重置时区',
  dola_quota_reset_hour: '额度重置时刻',
  dola_submit_mode: '视频提交通道',
  dola_hello_probe_mode: '「你好」探测通道',
  dola_upstream_concat: '上游合成档位',
  dola_allow_30s_rewrite: '30 秒载体改写',
  dola_duration_carrier_map: '时长载体映射',
  dola_convert_auto_zero: '换算后清零额度',
  dola_account_probe_limit: '单次体检账号数',
  dola_proxy_rotation_risk_sec: '代理轮换预警',
  dola_proxy_assumed_minutes: '代理窗口兜底',
  gateway_prompt_wrap_enabled: '提示词包装',
  gateway_prompt_prefix: '提示词前缀',
  gateway_prompt_middle: '提示词中缀',
  gateway_prompt_suffix: '提示词后缀',
};
const MAINTENANCE_HELP = {
  dola_credits_per_point: '多少 dola 额度兑换 1 积分。',
  dola_points_per_account: '按账号数计价时，每个有效账号对应的积分。',
  dola_convert_basis: '默认按账号数或额度计价；换算弹窗可按任务另选。',
  dola_check_concurrency: '批量校验账号时同时运行的任务数。',
  dola_http_timeout: 'dola 接口单次请求的超时时间（秒）。',
  dola_use_browser: '查额度时使用浏览器通道；开启需安装 Playwright。',
  dola_browser_concurrency: '浏览器通道同时运行的任务数，会占用较多内存。',
  llm_base_url: '填写兼容接口的基础地址，如 https://服务地址/v1。系统会追加 /chat/completions。',
  llm_timeout_ms: '默认 120000 毫秒。反向代理超时需大于此值；超时的上游请求可能已计费，请查看脚本记录后再重试。',
  llm_enabled: '配置地址、API Key 和模型后开启；脚本生成目前不扣本站积分，上游服务仍可能计费。',
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
  dola_quota_reset_tz: 'dola 每日额度重置使用的 IANA 时区，例如 Asia/Tokyo。',
  dola_quota_reset_hour: '额度重置时区当地的重置时刻（0～23 点）。',
  dola_submit_mode: 'browser 为浏览器模拟提交；scheme-a 和 pure-http 为实验通道，切换前先完成只读验证。',
  dola_hello_probe_mode: 'pure-http 为纯协议直发（默认，不开浏览器、不占浏览器并发）；'
    + '只有纯协议被上游针对时才切 browser 回退（旧实现，需等创作输入框，慢 20~30 秒）。',
  dola_upstream_concat: '允许把上游合成档位（例如 15 秒×2）作为目标时长证据；本服务不在本地拼接。',
  dola_allow_30s_rewrite: '允许 30 秒任务使用短档位载体并改写请求时长；开启前请确认对应能力探测已通过。',
  dola_duration_carrier_map: 'JSON 形式的目标时长到页面载体映射，例如 {"30":10}；留空使用默认映射。',
  dola_convert_auto_zero: '额度换算完成后将账号的本地额度记录清零，仅用于记账，不会真的扣除上游额度。',
  gateway_prompt_cooldown_seconds: '同一用户令牌重复提交相同提示词的保护时间；设为 0 可关闭。',
  gateway_prompt_wrap_enabled: '开启后，提交给上游的提示词会被拼上下面几段运营话术。'
    + '注意：接口里存的和返回的都仍是你提交的原文，只有发给上游那一刻才拼接。',
  gateway_prompt_prefix: '拼在用户提示词之前。留空表示不加这一段。',
  gateway_prompt_middle: '拼在用户提示词之后、后缀之前。留空表示不加这一段。',
  gateway_prompt_suffix: '拼在最后（用户提示词与中缀之后）。留空表示不加这一段。',
  gateway_prompt_wrap_enabled_scope: '包装只对选中的入口生效。“开了但没生效”最常见的原因就是范围选错，'
    + '或者三段文案都留空 —— 接口里的 prompt_wrapped 会显示**实际**有没有生效。',
  gateway_enabled_scope: '网关开关只对选中的入口生效。选“只后台”时对外接口会被 503 拦住，'
    + '用于“只让自己在后台调试、先不对外”的场景。',
  gateway_model_costs: '按模型/秒数定价的价目表，JSON。命中顺序：模型|秒数 → 模型 → default → 上面的一口价。'
    + '例：{"default":1,"seedance_v2.0":2,"seedance_v2.5":1,"seedance_v2.5|30":3}。'
    + '⚠️ JSON 写坏了会**整份不生效**（回落到一口价），不会“能读几条算几条”。',
  gateway_daily_points_limit: '每个令牌每天最多扣多少积分，按服务器本地日结算。0 = 不限。'
    + '在令牌上单独设置 daily_points_limit 可以覆盖这里（设 0 就是该令牌不限）。',
  dola_account_probe_limit: '一次生成最多给几个账号做会话体检（体检有延迟，所以有上限）。'
    + '池里候选更多时，失败信息会告诉你还有几个**尚未体检**，调大这个值可以少漏号。',
  dola_proxy_rotation_risk_sec: '代理出口剩余时间低于此值即标记“即将轮换”（秒）。0 = 不判定。'
    + '⚠️ 剩余时间是**上界估计**（IPWeb 的窗口锚在它自己的时钟上），只用来提前预警，不要拿它做精确调度。',
  dola_proxy_assumed_minutes: 'URL 里读不出粘性窗口时用的兜底窗口（分钟）。0 = 不知道就不算。'
    + 'IPWeb 的代理不需要填（窗口就在用户名里）。',
};
function validMaintenanceInterval(value) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440;
}

const GROUP_NAME = { general: '通用', security: '安全', dola: 'dola 账号池', gateway: '用户端网关', frontend: '前台入口', script: '脚本工作台' };
const BOOL_KEYS = [
  'allow_register', 'dola_use_browser', 'dola_convert_auto_zero', 'frontend_browser_visible',
  'dola_auto_maintenance_enabled', 'dola_auto_cleanup_invalid', 'dola_auto_quota_probe',
  'gateway_prompt_wrap_enabled', 'llm_enabled',
];
// 前缀/中缀/后缀是成段的话术，用单行输入框（420px）编辑会很痛苦，给它们多行输入。
// 价目表也是同一类：一份 JSON 在单行里改起来容易漏字符，而漏一个字符就会**整份作废**。
const TEXTAREA_KEYS = [
  'gateway_prompt_prefix', 'gateway_prompt_middle', 'gateway_prompt_suffix',
  'gateway_model_costs',
];
const NUMBER_KEYS = ['llm_timeout_ms', 'page_size', 'session_hours', 'dola_credits_per_point', 'dola_points_per_account',
  'dola_check_concurrency', 'dola_http_timeout', 'dola_browser_concurrency',
  'dola_gen_concurrency', 'dola_gen_queue_limit', 'dola_gen_min_submit_interval_sec',
  'dola_ratelimit_cooldown_min', 'dola_autorotate_max_attempts',
  'dola_replenish_min_accounts', 'dola_replenish_min_quota',
  'gateway_prompt_cooldown_seconds', 'dola_auto_maintenance_interval_minutes',
  // 本轮新增：定价/额度与代理轮换
  'gateway_daily_points_limit', 'dola_account_probe_limit',
  'dola_proxy_rotation_risk_sec', 'dola_proxy_assumed_minutes'];
const ENUM_KEYS = {
  dola_convert_basis: [{ value: 'account', label: '按账号数计价' }, { value: 'credits', label: '按额度计价' }],
  frontend_open_mode: [{ value: 'tab', label: '新标签页直接跳转' }, { value: 'browser', label: '服务器上开真实浏览器' }],
  // 三层开关的「范围」层（见 server/dola/feature-switch.js）。
  // 默认 all —— 升级后不改变任何既有行为，所以它得是下拉里最显眼那个。
  gateway_enabled_scope: [
    { value: 'all', label: '全部入口（默认）' },
    { value: 'v1', label: '只对外接口' },
    { value: 'admin', label: '只后台工作台' },
  ],
  gateway_prompt_wrap_enabled_scope: [
    { value: 'all', label: '全部入口（默认）' },
    { value: 'v1', label: '只对外接口' },
    { value: 'admin', label: '只后台工作台' },
  ],
  // 脚本工作台的生成通道。选 dola 时**不需要**填 base_url / api_key / model ——
  // 它借的是本服务号池里 dola 网页 agent 的能力（见 server/dola/chat-bridge.js），
  // 分镜图也只有这条通道能给。
  llm_provider: [
    { value: 'openai', label: '外部 LLM（OpenAI 兼容接口）' },
    { value: 'dola', label: 'dola 网页 agent（免配置，可出分镜图）' },
  ],
};
const UNIT = {
  llm_timeout_ms: '毫秒',
  page_size: '条', session_hours: '小时',
  dola_credits_per_point: '额度', dola_points_per_account: '积分', dola_check_concurrency: '个',
  dola_http_timeout: '秒', dola_browser_concurrency: '个', dola_gen_concurrency: '个', dola_gen_queue_limit: '个任务',
  dola_gen_min_submit_interval_sec: '秒', dola_ratelimit_cooldown_min: '分钟', dola_autorotate_max_attempts: '个', dola_replenish_min_accounts: '个', dola_replenish_min_quota: '额度',
  gateway_prompt_cooldown_seconds: '秒', dola_auto_maintenance_interval_minutes: '分钟',
  gateway_daily_points_limit: '积分', dola_account_probe_limit: '个',
  dola_proxy_rotation_risk_sec: '秒', dola_proxy_assumed_minutes: '分钟',
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
const isTextarea = (k) => TEXTAREA_KEYS.includes(k);
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
/*
 * Element Plus gives the label a fixed 32px line box. That is fine for a
 * short one-line label, but long Chinese labels wrap while the form item
 * keeps the old height, so the next row paints over the previous label.
 * Let the label contribute its real height and keep the help text on its
 * own line inside the content column.
 */
.settings-form :deep(.el-form-item) {
  align-items: flex-start;
  margin-bottom: 20px;
}
.settings-form :deep(.el-form-item__label) {
  height: auto !important;
  min-height: 32px;
  padding-top: 5px;
  padding-right: 18px;
  line-height: 1.45;
  white-space: normal;
  overflow-wrap: anywhere;
  align-items: flex-start;
}
.settings-form :deep(.el-form-item__content) {
  min-width: 0;
  align-items: flex-start;
  align-content: flex-start;
  row-gap: 4px;
  line-height: 32px;
}
.setting-help {
  flex: 0 0 100%;
  width: 100%;
  max-width: 100%;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.unit { margin-left: 8px; color: var(--el-text-color-secondary); line-height: 32px; }

@media (max-width: 720px) {
  .settings-form :deep(.el-form-item) { display: block; }
  .settings-form :deep(.el-form-item__label) {
    width: auto !important;
    min-height: 0;
    padding: 0 0 5px;
    line-height: 1.5;
    display: block;
  }
  .settings-form :deep(.el-form-item__content) { width: 100%; }
}
</style>
