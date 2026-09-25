<template>
  <div>
    <!--
      这段说明很重要但很长，全铺开会把首屏吃掉一半。
      折成「一行摘要 + 展开看详情」，需要的人点开，不需要的人不被打扰。
    -->
    <el-alert type="info" :closable="false" show-icon class="notice">
      <template #title>
        <span class="notice-title">
          dola 账号支持 <b>Google 登录入池</b>或导入已登录的 cookie；额度换算是<b>内部记账</b>，不会真的消耗 dola 额度。
          <el-link type="primary" :underline="false" class="notice-toggle" @click="noticeOpen = !noticeOpen">
            {{ noticeOpen ? '收起' : '详情' }}
            <el-icon><component :is="noticeOpen ? 'ArrowUp' : 'ArrowDown'" /></el-icon>
          </el-link>
        </span>
      </template>
      <div v-show="noticeOpen" class="notice-body">
        <div>· Google 账号可批量登录入池，每批最多 20 个；登录浏览器在后台服务所在电脑弹出，每个账号使用独立上下文。验证码或安全限制需人工处理，入池以后端验证结果为准。</div>
        <div>· 其他登录方式可先完成登录，再通过「批量导入 Cookie」入池。</div>
        <div>· 额度换算按查到的额度折算成后台积分（可充到令牌），<b>不会消费掉 dola 的额度</b> —— 那边的额度只在真实生成内容时才扣。</div>
        <div>· 免费号的日内视频额度生成前通常读不到；系统会在真实生成回执里自动识别「今日剩余 N 个」，并标记为「生成回执」。查不到不等于 0。</div>
        <div>· 浏览器会带 <code>region</code>/<code>web_id</code>/<code>a_bogus</code> 一整套上下文参数，纯 HTTP 未必 100% 对齐，必要时开浏览器通道复现页面真实请求。</div>
      </div>
    </el-alert>

    <div v-if="provider.maintenance" class="maintenance-bar">
      <div class="maintenance-copy">
        <div class="maintenance-title">
          <span class="dot" :class="provider.maintenance.enabled ? 'dot-on' : 'dot-off'" />
          自动维护：{{ provider.maintenance.enabled ? '已开启' : '已关闭' }}
          <el-tag v-if="maintenanceJob" size="small" :type="jobStatusType(maintenanceJob.status)">
            任务 #{{ maintenanceJob.id }} {{ jobStatusLabel(maintenanceJob.status) }} · {{ maintenanceJob.done ?? 0 }}/{{ maintenanceJob.total ?? 0 }}
          </el-tag>
          <span v-else class="sub">当前无维护任务</span>
        </div>
        <div class="sub">
          {{ provider.maintenance.enabled ? `每 ${provider.maintenance.intervalMinutes} 分钟巡检一次` : '可在系统设置中开启，也可手动维护' }}
          · 失效隔离：{{ provider.maintenance.cleanupInvalid ? '开启（保留 cookie）' : '关闭' }}
          · 额度探测：{{ provider.maintenance.quotaProbe ? '开启' : '关闭' }}
        </div>
        <div class="sub">
          下次巡检：{{ provider.maintenance.enabled ? (provider.maintenance.nextRunAt ? fmt(provider.maintenance.nextRunAt) : '待调度') : '未安排' }}
          <template v-if="provider.maintenance.lastJob && !isJobRunning(provider.maintenance.lastJob)">
            · 最近任务 #{{ provider.maintenance.lastJob.id }} {{ jobStatusLabel(provider.maintenance.lastJob.status) }}（{{ fmt(provider.maintenance.lastJob.updated_at) }}）
          </template>
          · 免费日额度以当日生成回执为准
        </div>
        <div v-if="provider.generation" class="sub">
          生成队列：运行中 {{ provider.generation.running ?? 0 }} · 排队 {{ provider.generation.queued ?? 0 }} ·
          可用并发 {{ provider.generation.available ?? 0 }}/{{ provider.generation.concurrency ?? provider.settings?.generationConcurrency ?? 1 }}
          · 队列占用 {{ provider.generation.activeTasks ?? 0 }}/{{ provider.generation.queueLimit ?? 6000 }}
          <template v-if="provider.generation.reservedAccounts">
            · 选号占用 {{ provider.generation.reservedAccounts }}
          </template>
        </div>
      </div>
      <div class="maintenance-actions">
        <router-link v-if="can('setting:view')" to="/settings" class="maintenance-settings">维护设置</router-link>
        <el-button v-if="maintenanceJob" size="small" text @click="openJob(maintenanceJob)">查看任务</el-button>
        <el-button v-if="can('dola:check')" size="small" type="primary" plain :loading="maintenanceLoading" :disabled="maintenanceBusy" @click="runMaintenance">
          {{ maintenanceBusy && !maintenanceLoading ? '任务进行中' : '立即维护' }}
        </el-button>
        <el-button size="small" text :loading="providerLoading" @click="refreshProvider()">刷新状态</el-button>
      </div>
    </div>

    <el-row :gutter="14" class="stats">
      <el-col v-for="s in statCards" :key="s.label" :xs="12" :sm="8" :md="4">
        <div class="stat" :style="{ '--accent': s.color }" :title="s.title">
          <div class="label">{{ s.label }}</div>
          <div class="num" :style="{ color: s.color }">{{ s.value }}</div>
          <div class="sub">{{ s.sub }}</div>
        </div>
      </el-col>
    </el-row>

    <el-alert
      v-if="summary.missingExitIp || summary.sharedExitIpRows || summary.validNoProxy"
      type="warning" :closable="false" show-icon class="proxy-isolation-alert"
      :title="`生成前已拦截：未配置代理 ${summary.validNoProxy || 0} 个，未完成出口核验 ${summary.missingExitIp || 0} 个，共享出口 ${summary.sharedExitIpRows || 0} 个`"
    >
      <div class="proxy-alert-row">
        <span>未确认“一个有效账号对应一个出口 IP”前，不会提交新的 30 秒任务，也不会扣额度。</span>
        <el-button v-if="can('dola:update')" size="small" type="warning" plain @click="openProxyRepair">打开代理修复</el-button>
      </div>
    </el-alert>

    <el-tabs v-model="tab" class="tabs" @tab-change="onTab">
      <!-- ============ 运营总览（合并 8790 Dashboard） ============ -->
      <el-tab-pane label="运营总览" name="operations">
        <template v-if="operationSummary">
          <el-row :gutter="14" class="ops-stats">
            <el-col v-for="card in operationCards" :key="card.label" :xs="12" :sm="8" :md="4">
              <div class="stat ops-stat" :style="{ '--accent': card.color }">
                <div class="label">{{ card.label }}</div>
                <div class="num" :style="{ color: card.color }">{{ card.value }}</div>
                <div class="sub">{{ card.sub }}</div>
              </div>
            </el-col>
          </el-row>
          <el-card shadow="never" class="ops-panel">
            <div class="toolbar">
              <div>
                <b>统一运营数据</b>
                <span class="muted ops-source">数据源：8788 dola_accounts / dola_videos / settings</span>
              </div>
              <div class="spacer" />
              <el-button :icon="Refresh" :loading="operationsLoading" @click="loadOperations">刷新</el-button>
              <el-button text @click="tab = 'proxies'">代理与出口</el-button>
              <el-button text @click="tab = 'ratelimit'">限流与冷却</el-button>
            </div>
            <el-alert
              v-if="operationSummary.proxy?.missingExitIp || operationSummary.proxy?.sharedExitIpRows || operationSummary.proxy?.withoutProxy"
              type="warning" :closable="false" show-icon class="mb"
              :title="`代理隔离待处理：未配置 ${operationSummary.proxy?.withoutProxy || 0} 个，未核验出口 ${operationSummary.proxy?.missingExitIp || 0} 个，共享出口 ${operationSummary.proxy?.sharedExitIpRows || 0} 个`"
            >
              <template #default>
                生成只会选择已确认独立出口的有效账号；请从“代理与出口”处理待核验项。
              </template>
            </el-alert>
            <el-row :gutter="14">
              <el-col :xs="24" :md="12">
                <div class="ops-box">
                  <div class="ops-box-title">任务队列</div>
                  <div class="ops-line"><span>运行中 / 排队</span><b>{{ operationSummary.queue?.running ?? 0 }} / {{ operationSummary.queue?.queued ?? 0 }}</b></div>
                  <div class="ops-line"><span>并发</span><b>{{ operationSummary.queue?.running ?? 0 }} / {{ operationSummary.queue?.concurrency ?? 1 }}</b></div>
                  <div class="ops-line"><span>容量</span><b>{{ operationSummary.queue?.activeTasks ?? 0 }} / {{ operationSummary.queue?.queueLimit ?? 6000 }}</b></div>
                  <div class="ops-line"><span>选号占用</span><b>{{ operationSummary.queue?.reservedAccounts ?? 0 }}</b></div>
                </div>
              </el-col>
              <el-col :xs="24" :md="12">
                <div class="ops-box">
                  <div class="ops-box-title">当前保护参数</div>
                  <div class="ops-line"><span>同出口提交间隔</span><b>{{ operationSummary.settings?.minSubmitIntervalSec ?? 60 }} 秒</b></div>
                  <div class="ops-line"><span>限流冷却</span><b>{{ operationSummary.settings?.rateLimitCooldownMin ?? 30 }} 分钟</b></div>
                  <div class="ops-line"><span>相同提示词冷却</span><b>{{ operationSummary.settings?.promptCooldownSec ?? 120 }} 秒</b></div>
                  <div class="ops-line"><span>队列容量</span><b>{{ operationSummary.settings?.generationQueueLimit ?? 6000 }}</b></div>
                </div>
              </el-col>
            </el-row>
            <div class="ops-section-title">最近限流事件</div>
            <el-table :data="(operationSummary.recentRateLimitEvents || []).slice(0, 8)" border stripe size="small">
              <el-table-column prop="created_at" label="时间" width="170"><template #default="{ row }">{{ fmt(row.created_at) }}</template></el-table-column>
              <el-table-column prop="code" label="上游码" width="110" />
              <el-table-column prop="account_label" label="账号" width="150" show-overflow-tooltip />
              <el-table-column prop="video_id" label="任务" width="80" />
              <el-table-column prop="cooldown_until" label="冷却至" width="170"><template #default="{ row }">{{ fmt(row.cooldown_until) }}</template></el-table-column>
              <el-table-column prop="detail" label="说明" min-width="220" show-overflow-tooltip />
              <template #empty><el-empty description="暂无限流事件" :image-size="60" /></template>
            </el-table>
          </el-card>
        </template>
        <el-empty v-else-if="!operationsLoading" description="运营数据加载失败，请刷新" />
      </el-tab-pane>

      <!-- ============ 代理与出口（合并 8790 Proxies，使用 8788 真实 IPWeb） ============ -->
      <el-tab-pane label="代理与出口" name="proxies">
        <el-card shadow="never">
          <div class="toolbar">
            <div class="stats-inline">
              <span>已配置 <b>{{ proxySummary.withProxy ?? 0 }}</b></span>
              <el-divider direction="vertical" />
              <span>已核验出口 <b class="points">{{ proxySummary.withExitIp ?? 0 }}</b></span>
              <el-divider direction="vertical" />
              <span>共享出口 <b class="danger-text">{{ proxySummary.sharedExitIpRows ?? 0 }}</b></span>
            </div>
            <div class="spacer" />
            <el-button v-if="can('dola:update')" type="primary" plain @click="openProxyRepair">分配 / 修复 IPWeb</el-button>
            <el-button :icon="Refresh" :loading="proxyListLoading" @click="loadProxyAccounts">刷新</el-button>
          </div>
          <el-alert type="info" :closable="false" show-icon class="mb"
            title="只保留 8788 的真实代理绑定；验证会真实访问出口检测服务，不写入 stub.* 假 IP。生成前仍会拦截未核验或共享出口。" />
          <el-table :data="proxyAccounts" v-loading="proxyListLoading" border stripe>
            <el-table-column prop="id" label="ID" width="62" />
            <el-table-column label="账号" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ primaryName(row) }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="代理" width="120"><template #default="{ row }"><el-tag size="small" :type="row.proxy ? 'success' : 'danger'">{{ row.proxy ? proxyRegion(row.proxy) : '未配置' }}</el-tag></template></el-table-column>
            <el-table-column label="出口隔离" width="125"><template #default="{ row }"><el-tag size="small" :type="row.exitIpShared ? 'danger' : (row.exitIpKnown ? 'success' : 'warning')">{{ row.exitIpShared ? '共享出口' : (row.exitIpKnown ? '已核验' : '待核验') }}</el-tag></template></el-table-column>
            <el-table-column label="能力" width="150"><template #default="{ row }">30 秒 {{ row.native_30s_state === 'available' ? '✓' : '—' }} · 参考图 {{ row.reference_image_state === 'available' ? '✓' : '—' }}</template></el-table-column>
            <el-table-column label="冷却" width="170"><template #default="{ row }">{{ row.cooldown_until && new Date(row.cooldown_until) > new Date() ? fmt(row.cooldown_until) : '—' }}</template></el-table-column>
            <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button v-if="can('dola:update') && (!row.exitIpKnown || row.exitIpShared || !row.proxy)" size="small" text type="primary" @click="openProxyRepairFor(row)">处理</el-button><span v-else class="muted">正常</span></template></el-table-column>
            <template #empty><el-empty description="暂无账号" :image-size="70" /></template>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 限流与冷却（合并 8790 RateLimit，接入 8788 真实状态） ============ -->
      <el-tab-pane label="限流与冷却" name="ratelimit">
        <el-card shadow="never">
          <div class="toolbar"><div><b>限流与冷却</b><span class="muted ops-source">上游码 710022002 · 只对真实命中记录冷却</span></div><div class="spacer" /><el-button :icon="Refresh" :loading="operationsLoading" @click="loadOperations">刷新</el-button></div>
          <el-alert type="info" :closable="false" show-icon class="mb" title="这些设置直接作用于 8788 的生成编排器和用户端网关；不会创建另一套号池或 worker。" />
          <el-form :inline="true" class="limit-form">
            <el-form-item label="同出口提交间隔（秒）"><el-input-number v-model="limitForm.minSubmitIntervalSec" :min="0" :max="600" /></el-form-item>
            <el-form-item label="限流冷却（分钟）"><el-input-number v-model="limitForm.rateLimitCooldownMin" :min="1" :max="1440" /></el-form-item>
            <el-form-item label="相同提示词冷却（秒）"><el-input-number v-model="limitForm.promptCooldownSec" :min="0" :max="3600" /></el-form-item>
            <el-form-item label="视频并发"><el-input-number v-model="limitForm.generationConcurrency" :min="1" :max="20" /></el-form-item>
            <el-form-item label="队列容量"><el-input-number v-model="limitForm.generationQueueLimit" :min="1" :max="6000" /></el-form-item>
            <el-form-item label="限流自动换号（个）"><el-input-number v-model="limitForm.autorotateMaxAttempts" :min="1" :max="24" /></el-form-item>
            <el-form-item><el-button v-if="can('dola:update')" type="primary" :loading="limitsSaving" @click="saveLimits">保存保护参数</el-button></el-form-item>
          </el-form>
          <div class="ops-section-title">当前冷却中的账号（{{ operationSummary?.coolingAccounts?.length || 0 }}）</div>
          <el-table :data="operationSummary?.coolingAccounts || []" border stripe size="small">
            <el-table-column prop="id" label="ID" width="70" /><el-table-column prop="label" label="账号" min-width="180" show-overflow-tooltip />
            <el-table-column prop="cooldown_until" label="冷却至" width="180"><template #default="{ row }">{{ fmt(row.cooldown_until) }}</template></el-table-column>
            <el-table-column prop="last_used_at" label="最近使用" width="180"><template #default="{ row }">{{ fmt(row.last_used_at) }}</template></el-table-column>
            <el-table-column prop="last_error" label="原因" min-width="260" show-overflow-tooltip />
            <template #empty><el-empty description="当前没有冷却账号" :image-size="60" /></template>
          </el-table>
          <div class="ops-section-title">最近限流命中</div>
          <el-table :data="operationSummary?.recentRateLimitEvents || []" border stripe size="small">
            <el-table-column prop="created_at" label="时间" width="180"><template #default="{ row }">{{ fmt(row.created_at) }}</template></el-table-column>
            <el-table-column prop="code" label="码" width="110" /><el-table-column prop="account_label" label="账号" width="180" show-overflow-tooltip /><el-table-column prop="cooldown_until" label="冷却至" width="180"><template #default="{ row }">{{ fmt(row.cooldown_until) }}</template></el-table-column><el-table-column prop="detail" label="说明" min-width="240" show-overflow-tooltip />
            <template #empty><el-empty description="暂无记录" :image-size="60" /></template>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 账号池 ============ -->
      <el-tab-pane label="账号池" name="accounts">
        <el-card shadow="never">
          <!-- 补号提示：有效账号数 / 已确认剩余额度低于阈值时出现，数据随轮询实时更新 -->
          <el-alert
            v-if="replenishBanner"
            :type="replenishBanner.level"
            :closable="false"
            show-icon
            class="replenish-banner"
          >
            <template #title>{{ replenishBanner.title }}</template>
            <template #default>
              <div class="replenish-body">
                <span>{{ replenishBanner.text }}</span>
                <span class="replenish-actions">
                  <el-button v-if="can('dola:import')" size="small" type="primary" :icon="Upload" @click="importDlg = true">去补号</el-button>
                  <el-button v-if="can('dola:check')" size="small" :icon="Money" @click="runJob('dola_credits')">批量查额度</el-button>
                </span>
              </div>
            </template>
          </el-alert>
          <div class="toolbar">
            <div class="filters">
              <el-input v-model="query.keyword" placeholder="搜索备注 / 备注名 / 用户标识" clearable style="width: 220px" @keyup.enter="reload" @clear="reload" />
              <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 130px" @change="reload">
                <el-option label="有效" value="valid" />
                <el-option label="失效" value="invalid" />
                <el-option label="未校验" value="unknown" />
                <el-option label="已停用" value="disabled" />
              </el-select>
              <el-select v-model="query.source" placeholder="全部来源" clearable style="width: 140px" @change="reload">
                <el-option v-for="s in summary.sources || []" :key="s" :label="s" :value="s" />
              </el-select>
              <el-select v-model="query.group" placeholder="全部分组" clearable style="width: 140px" @change="reload">
                <el-option v-for="g in summary.groups || []" :key="g" :label="g" :value="g" />
              </el-select>
              <el-button :icon="Search" @click="reload">查询</el-button>
            </div>
            <div class="spacer" />
            <div class="actions">
              <el-button v-if="can('dola:delete')" :disabled="!selected.length" type="danger" plain @click="bulkRemove">
                删除{{ selected.length ? `（${selected.length}）` : '' }}
              </el-button>
              <el-button v-if="can('dola:check')" :icon="CircleCheck" @click="runJob('dola_check')">批量校验</el-button>
              <el-button v-if="can('dola:create')" type="warning" plain @click="runJob('dola_hello_probe')">发送“你好”探测</el-button>
              <el-button v-if="can('dola:check')" :icon="Money" @click="runJob('dola_credits')">批量查额度</el-button>
              <el-button v-if="can('dola:check')" plain @click="runJob('dola_native_15s')">批量探测 15 秒</el-button>
              <el-button v-if="can('dola:check')" plain @click="runJob('dola_native_30s')">批量探测 30 秒</el-button>
              <el-button v-if="can('dola:check')" plain @click="runJob('dola_reference_images')">批量探测参考图</el-button>
              <el-button v-if="can('dola:update')" :disabled="!selected.length" plain @click="batchRecover">批量恢复{{ selected.length ? `（${selected.length}）` : '' }}</el-button>
              <el-button v-if="can('dola:update')" :disabled="!selected.length" plain @click="batchResetQuota">重置额度{{ selected.length ? `（${selected.length}）` : '' }}</el-button>
              <el-button v-if="can('dola:update')" :disabled="!selected.length" plain @click="groupDlg = true">批量分组</el-button>
              <el-button v-if="can('dola:create')" plain @click="openStress">压力测试</el-button>
              <el-button v-if="can('dola:convert')" :icon="Switch" @click="openConvert">计价换算</el-button>
        <el-button v-if="can('dola:update') && (summary.validNoProxy || summary.missingExitIp || summary.sharedExitIpRows)" :icon="Refresh" plain @click="openProxyRepair">修复出口</el-button>
              <DolaGoogleLogin v-if="can('dola:import')" @completed="Promise.allSettled([load(), refreshProvider()])" />
              <el-button v-if="can('dola:import')" type="primary" :icon="Upload" @click="importDlg = true">批量导入 Cookie</el-button>
            </div>
          </div>

          <!-- 号池统计（对标 dola-pool 顶栏）：满额/半额只计「有效、未冷却、额度已确认」的账号 -->
          <div class="pool-meta">
            <div class="stat-chips">
              <el-tag effect="plain">全部 {{ summary.total ?? 0 }}</el-tag>
              <el-tag type="success" effect="plain">有效 {{ summary.valid ?? 0 }}</el-tag>
              <el-tag type="success">满额 {{ summary.fullQuota ?? 0 }}</el-tag>
              <el-tag type="warning">半额 {{ summary.halfQuota ?? 0 }}</el-tag>
              <el-tag type="warning" effect="plain">冷却 {{ summary.cooling ?? 0 }}</el-tag>
              <el-tag type="danger" effect="plain">异常 {{ summary.invalid ?? 0 }}</el-tag>
              <el-tag type="info" effect="plain">剩余额度 {{ summary.quotaRemaining ?? '—' }} 点<template v-if="summary.quotaVideos?.producible != null"> ≈可出 {{ summary.quotaVideos.producible }} 条</template></el-tag>
            </div>
            <div v-if="summary.quotaReset" class="reset-line muted">
              额度重置：{{ summary.quotaReset.tz }} 每天 {{ summary.quotaReset.hour }}:00<template v-if="summary.quotaReset.nextResetAt">（下次 {{ fmt(summary.quotaReset.nextResetAt) }}）</template>
            </div>
          </div>

          <!--
            列设计（从 14 列压到 8 列，1440 宽下不用横向滚动）：
              · cookie 原文**彻底移出表格** —— 29 个字段名换行会把行高撑到 300px+，
                一屏只能看一行。现在只显示「N 字段」小标签，点开弹窗看明文。
              · 「备注名」+「账号」合并；「最后校验」并进「状态」的副行。
              · 「额度」「可换」「计价」合并成一格：主行额度，副行换算状态。
              · 「会员」并进状态列（free 不显示，付费才打标）。
          -->
          <el-table
            :data="items" v-loading="loading" border stripe
            row-key="id"
            :row-class-name="rowClass"
            @selection-change="(v) => (selected = v)"
          >
            <el-table-column type="selection" width="46" :reserve-selection="true" :selectable="(row) => row.status !== 'disabled'" />
            <el-table-column prop="id" label="ID" width="58" class-name="col-num" />

            <!-- 账号：主行备注名，副行识别到的账号标识 + 出口代理标识 -->
            <el-table-column label="账号" min-width="190">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span class="main"><template v-if="row.accountCode">[{{ row.accountCode }}] </template>{{ row.loginEmail || primaryName(row) }}</span>
                  <span class="sub mono">
                    <template v-if="secondaryName(row)">{{ secondaryName(row) }}</template>
                    <template v-else-if="!row.account_hint">未识别（校验后可回填）</template>
                    <!--
                      出口代理标识：上游按 IP 限流，这里一眼看出哪些号还在共用本机 IP。
                      「直连」是危险信号 —— 号一多必然互相拖累。
                    -->
                    <span v-if="row.proxy" class="px-tag px-ok" :title="maskProxy(row.proxy)">🌐{{ proxyRegion(row.proxy) }}</span>
                    <span v-else class="px-tag px-none" title="走本机出口 IP —— 多个号共用同一个 IP 会互相拖累（上游按 IP 限流）">直连</span>
                  </span>
                </div>
              </template>
            </el-table-column>

            <!-- 分组：运营自定，用于筛选和批量管理 -->
            <el-table-column label="组" width="96" show-overflow-tooltip>
              <template #default="{ row }"><span :class="row.group_name ? '' : 'muted'">{{ row.group_name || '未分组' }}</span></template>
            </el-table-column>

            <!-- 状态：主行状态标签，副行会员 + 最后校验时间 -->
            <el-table-column label="状态" width="132">
              <template #default="{ row }">
                <div class="cell-stack">
                  <span class="tag-row">
                    <el-tag size="small" :type="statusType(row.status)" effect="light">
                      {{ statusLabel(row.status) }}
                    </el-tag>
                    <el-tag v-if="row.membership && row.membership !== 'free'" size="small" type="success" effect="plain">
                      {{ row.membership }}
                    </el-tag>
                  </span>
                  <span class="sub">{{ relTime(row.last_check_at) }}</span>
                  <!-- 登录态是其余能力探测的**前提**：输入框都没出现时，15/30 秒的结论没有意义，
                       所以这一行排在最前面。
                       三个词刻意互不重叠，且都控制在 7 字以内 —— 列宽只有 132px，
                       写「未确认·已暂停选号」会被截断成「登录态：未确认·已…」，
                       最该看清的一行反而看不全（实测踩到）。详情交给 tooltip。 -->
                  <span class="sub" :class="row.login_state === 'unavailable' ? 'login-blocked' : ''"
                    :title="row.login_note || '尚未确认登录态（未做只读探测）'">
                    登录态：{{ row.login_state === 'available' ? '正常'
                      : (row.login_state === 'unavailable' ? '已停选' : '未探测') }}
                  </span>
                  <span class="sub native-capability" :title="row.native_15s_note || '尚未做原生 15 秒页面探测'">
                    15秒：{{ row.native_15s_state === 'available' ? '已确认' : (row.native_15s_state === 'unavailable' ? '未提供' : '待探测') }}
                  </span>
                  <span class="sub native-capability" :title="row.native_30s_note || '尚未做原生 30 秒页面探测'">
                    30秒：{{ row.native_30s_state === 'available' ? '已确认' : (row.native_30s_state === 'unavailable' ? '未提供' : '待探测') }}
                  </span>
                  <span class="sub native-capability" :title="row.reference_image_note || '尚未做参考图页面探测'">
                    参考图：{{ row.reference_image_state === 'available' ? '已确认' : (row.reference_image_state === 'unavailable' ? '未发现' : '待探测') }}
                  </span>
                </div>
              </template>
            </el-table-column>

            <!-- 日内余额只使用已确认值；来源与内部计价分别显示。 -->
            <el-table-column label="额度 / 换算" width="150" class-name="col-num">
              <template #default="{ row }">
                <div class="cell-stack align-end">
                  <el-tooltip :content="quotaTitle(row)" placement="top">
                    <span class="main" :class="quotaClass(row)">{{ quotaLabel(row) }}</span>
                  </el-tooltip>
                  <span class="sub" :title="quotaTitle(row)">{{ quotaSourceLabel(row) }}</span>
                  <span v-if="row.counted || row.countable || row.credits != null" class="sub" :title="row.credits_source ? `记账额度来源：${row.credits_source}` : '内部计价，不代表日内剩余额度'">
                    <template v-if="row.counted">已计价<template v-if="row.credits != null"> · 可换 {{ remainCredits(row) }}</template></template>
                    <template v-else-if="row.countable">{{ row.credits != null ? `可换算 ${remainCredits(row)}` : '可按账号计价' }}</template>
                    <template v-else>记账额度 {{ row.credits }}</template>
                  </span>
                </div>
              </template>
            </el-table-column>

            <!-- cookie：只给「几个字段」，不给原文 -->
            <el-table-column label="Cookie" width="98" align="center">
              <template #default="{ row }">
                <el-tooltip v-if="row.hasCookie" :content="`共 ${cookieCount(row)} 个字段，点击查看明文（会记日志）`">
                  <el-tag size="small" effect="plain" class="clickable" @click="reveal(row)">
                    <el-icon><Key /></el-icon>
                    <span>{{ cookieCount(row) }} 字段</span>
                  </el-tag>
                </el-tooltip>
                <el-tag v-else size="small" type="danger" effect="plain">缺失</el-tag>
              </template>
            </el-table-column>

            <!-- 说明：区分「真错误」和「只是提示」 -->
            <el-table-column label="说明" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="noteOf(row).cls">{{ noteOf(row).text }}</span>
              </template>
            </el-table-column>

            <!-- 操作：只留高频两个，其余收进「更多」 -->
            <el-table-column label="操作" width="176" fixed="right" align="right">
              <template #default="{ row }">
                <div class="op-row">
                  <el-button v-if="can('dola:check')" size="small" text type="primary" @click="rowAction(row, 'check')">
                    校验
                  </el-button>
                  <el-button v-if="can('dola:reveal')" size="small" text @click="reveal(row)">看 cookie</el-button>
                  <el-dropdown trigger="click" @command="(c) => rowMenu(row, c)">
                    <el-button size="small" text>更多<el-icon><ArrowDown /></el-icon></el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-if="can('dola:check')" command="credits">查额度</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:update')" command="set_credits">录入额度</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:create')" command="testGenerate">测试生成</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:update') && row.cooldown_until && new Date(row.cooldown_until) > new Date()" command="recover">解除冷却</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:update')" command="resetQuota">重置额度</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:check')" command="probe">接口探测</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:check')" command="native15">检查原生 15 秒</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:check')" command="native30">检查原生 30 秒</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:check')" command="referenceImages">检查参考图上传</el-dropdown-item>
                        <el-dropdown-item v-if="can('dola:create')" command="helloProbe">发送“你好”探测</el-dropdown-item>
                        <el-dropdown-item command="toggle" divided v-if="can('dola:update')">
                          {{ row.status === 'disabled' ? '启用' : '停用' }}
                        </el-dropdown-item>
                        <el-dropdown-item command="reset_counted" v-if="can('dola:convert') && row.counted">撤销计价标记</el-dropdown-item>
                        <el-dropdown-item command="delete" divided v-if="can('dola:delete')">删除</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="还没有账号，有导入权限时可通过右上角「Google 登录入池」或「批量导入 Cookie」添加" :image-size="80" />
            </template>
          </el-table>

          <el-pagination
            class="pager" layout="total, sizes, prev, pager, next"
            :total="total" :current-page="query.page" :page-size="query.pageSize" :page-sizes="[10, 20, 50, 100]"
            @current-change="(p) => { query.page = p; load(); }"
            @size-change="(s) => { query.pageSize = s; query.page = 1; load(); }"
          />
        </el-card>
      </el-tab-pane>

      <!-- ============ 批量任务 ============ -->
      <el-tab-pane label="批量任务" name="jobs">
        <el-card shadow="never">
          <div class="toolbar">
            <span class="muted">批量校验/查额度都跑成后台任务，几百个账号不会把页面卡死。</span>
            <div class="spacer" />
            <el-button :icon="Refresh" @click="loadJobs">刷新</el-button>
          </div>
          <el-table :data="jobs" v-loading="jobLoading" border stripe>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column label="类型" width="140">
              <template #default="{ row }">{{ jobTypeLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="jobStatusType(row.status)">{{ jobStatusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="进度" min-width="180">
              <template #default="{ row }">
                <el-progress
                  :percentage="row.total ? Math.round((row.done / row.total) * 100) : 0"
                  :status="row.status === 'failed' ? 'exception' : (row.status === 'done' ? 'success' : undefined)"
                  :stroke-width="12"
                />
                <span class="tiny muted">{{ row.done }}/{{ row.total }}　成功 {{ row.ok_count }}　失败 {{ row.fail_count }}</span>
              </template>
            </el-table-column>
            <el-table-column label="并发" width="70" prop="concurrency" />
            <el-table-column label="创建时间" width="155">
              <template #default="{ row }">{{ fmt(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click="openJob(row)">明细</el-button>
                <el-button v-if="isJobRunning(row)" size="small" text type="danger" @click="cancelJob(row)">取消</el-button>
              </template>
            </el-table-column>
            <template #empty><el-empty description="还没有任务" :image-size="80" /></template>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 生成任务 ============ -->
      <el-tab-pane label="生成统计与复核" name="analytics">
        <DolaGenerationAnalytics v-if="tab === 'analytics'" />
      </el-tab-pane>
      <el-tab-pane label="生成任务" name="generation">
        <el-card shadow="never">
          <div class="toolbar">
            <div class="filters">
              <el-select v-model="generationStatusFilter" placeholder="全部状态" clearable style="width: 140px" @change="loadGeneration">
                <el-option label="排队中" value="queued" />
                <el-option label="提交中" value="submitting" />
                <el-option label="生成中" value="generating" />
                <el-option label="解析中" value="resolving" />
                <el-option label="已完成" value="ready" />
                <el-option label="失败" value="failed" />
                <el-option label="已取消" value="cancelled" />
              </el-select>
              <span class="muted">任务列表只读监控；批量创建走网关链路扣积分</span>
            </div>
            <div class="spacer" />
            <span v-if="provider.generation" class="muted">
              运行中 {{ provider.generation.running ?? 0 }} · 排队 {{ provider.generation.queued ?? 0 }} ·
              并发 {{ provider.generation.running ?? 0 }}/{{ provider.generation.concurrency ?? 1 }} ·
              队列 {{ provider.generation.activeTasks ?? 0 }}/{{ provider.generation.queueLimit ?? 6000 }}
            </span>
            <el-button v-if="can('dola:create')" plain @click="openApiWorkbench">V1 API 工作台</el-button>
            <el-button v-if="can('dola:create')" type="primary" @click="openBatchGen">批量创建</el-button>
            <el-button :icon="Refresh" :loading="generationLoading" @click="loadGeneration">刷新</el-button>
          </div>
          <el-table :data="generationTasks" v-loading="generationLoading" border stripe>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="提示词" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">{{ row.prompt || '—' }}{{ row.promptTruncated ? '…' : '' }}</template>
            </el-table-column>
            <el-table-column prop="account_label" label="账号" width="150" show-overflow-tooltip />
            <el-table-column label="时长" width="76">
              <template #default="{ row }">{{ row.seconds ?? '—' }} 秒</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="generationStatusType(row.status)">{{ generationStatusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="stage" label="阶段" width="130" show-overflow-tooltip />
            <el-table-column label="归档" width="80">
              <template #default="{ row }">{{ row.archived ? '已归档' : '—' }}</template>
            </el-table-column>
            <el-table-column label="时间" width="165">
              <template #default="{ row }">{{ fmt(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="错误说明" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ row.error || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button v-if="can('dola:check') && ['queued','submitting','generating','resolving'].includes(row.status)" size="small" text type="danger" @click="cancelGeneration(row)">取消</el-button>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <template #empty><el-empty description="还没有生成任务" :image-size="80" /></template>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 换算流水 ============ -->
      <el-tab-pane label="换算流水" name="conversions">
        <el-card shadow="never">
          <div class="toolbar">
            <div class="stats-inline">
              <span>累计换算 <b>{{ convSummary.times || 0 }}</b> 次</span>
              <el-divider direction="vertical" />
              <span>消耗额度 <b class="credits">{{ convSummary.credits || 0 }}</b></span>
              <el-divider direction="vertical" />
              <span>产出积分 <b class="points">{{ convSummary.points || 0 }}</b></span>
            </div>
            <div class="spacer" />
            <el-button :icon="Refresh" @click="loadConversions">刷新</el-button>
          </div>
          <el-table :data="conversions" v-loading="convLoading" border stripe>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column prop="account_label" label="账号" width="140" show-overflow-tooltip />
            <el-table-column label="消耗额度" width="100">
              <template #default="{ row }"><span class="credits">{{ row.credits_used }}</span></template>
            </el-table-column>
            <el-table-column label="产出积分" width="100">
              <template #default="{ row }"><span class="points">{{ row.points_gained }}</span></template>
            </el-table-column>
            <el-table-column prop="ratio_desc" label="比例" width="150" />
            <el-table-column label="充到令牌" width="140">
              <template #default="{ row }">
                <span v-if="row.token_prefix" class="mono">{{ row.token_prefix }}</span>
                <span v-else class="muted">仅记账</span>
              </template>
            </el-table-column>
            <el-table-column prop="operator" label="操作人" width="100" />
            <el-table-column label="时间" width="160">
              <template #default="{ row }">{{ fmt(row.created_at) }}</template>
            </el-table-column>
            <template #empty><el-empty description="还没有换算记录" :image-size="80" /></template>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- ============ 批量创建生成任务 ============ -->
    <el-dialog v-model="batchGenDlg" title="批量创建生成任务" width="680px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon class="tip">
        <template #title>逐条顺序提交，单条失败不中断；每条都走用户端网关链路（排重 / 预检 / 扣积分 / 失败退款）</template>
        <div class="notice-body">
          积分从所选用户令牌扣除。<code>15 秒</code>只能走专家模式（选 15 秒会自动切专家模式）。
          参考站没有的：批量创建不支持参考图。
        </div>
      </el-alert>
      <el-form label-width="90px">
        <el-form-item label="用户令牌" required>
          <el-radio-group v-model="batchGenForm.tokenMode" size="small" style="margin-bottom: 8px">
            <el-radio-button label="select">选择现有令牌</el-radio-button>
            <el-radio-button label="paste">粘贴令牌原文</el-radio-button>
          </el-radio-group>
          <el-select v-if="batchGenForm.tokenMode === 'select'" v-model="batchGenForm.tokenId"
            placeholder="选择要扣积分的用户令牌" filterable style="width: 100%">
            <el-option v-for="t in tokenOptions" :key="t.id" :value="t.id"
              :label="`${t.name || '令牌'}（${t.prefix}…，余 ${t.points} 分）`" />
          </el-select>
          <el-input v-else v-model="batchGenForm.tokenRaw" placeholder="粘贴用户令牌原文" class="mono-box" />
        </el-form-item>
        <el-form-item label="提示词" required>
          <el-input v-model="batchGenForm.prompts" type="textarea" :rows="8" class="mono-box"
            placeholder="每行一条提示词，最多 20 条&#10;海边日落，镜头缓慢横移&#10;雨夜街头，霓虹倒影" />
          <div class="hint">共 {{ batchGenLines.length }} 条（空行自动忽略）</div>
        </el-form-item>
        <el-form-item label="模式">
          <el-select v-model="batchGenForm.mode" style="width: 160px">
            <el-option label="标准模式" value="standard" />
            <el-option label="专家模式" value="expert" />
          </el-select>
          <span class="hint">15 秒自动切专家模式</span>
        </el-form-item>
        <el-form-item label="时长">
          <el-select v-model="batchGenForm.seconds" style="width: 160px" @change="onBatchSecondsChange">
            <el-option :value="10" label="10 秒" />
            <el-option :value="15" label="15 秒" />
            <el-option :value="20" label="20 秒" />
            <el-option :value="30" label="30 秒" />
          </el-select>
        </el-form-item>
        <el-form-item label="比例">
          <el-select v-model="batchGenForm.ratio" style="width: 160px">
            <el-option label="16:9 横屏" value="16:9" />
            <el-option label="9:16 竖屏" value="9:16" />
            <el-option label="1:1 方形" value="1:1" />
          </el-select>
        </el-form-item>
        <el-form-item label="每任务积分">
          <el-input-number v-model="batchGenForm.points" :min="1" :max="100" placeholder="默认按系统设置" />
          <span class="hint">留空则按系统设置（用户端网关 → 每个视频任务扣积分）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchGenDlg = false">取消</el-button>
        <el-button type="primary" :loading="batchGenSaving" @click="submitBatchGen">开始提交</el-button>
      </template>
    </el-dialog>

    <!-- ============ 批量创建结果 ============ -->
    <el-dialog v-model="batchGenResultDlg" title="批量创建结果" width="680px">
      <el-alert :type="batchGenResult?.failCount ? 'warning' : 'success'" :closable="false" show-icon class="tip"
        :title="`成功 ${batchGenResult?.okCount ?? 0} 条，失败 ${batchGenResult?.failCount ?? 0} 条`" />
      <el-table :data="batchGenResult?.results || []" border stripe size="small" max-height="420">
        <el-table-column label="提示词" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.prompt || '（空）' }}</template>
        </el-table-column>
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="任务 / 说明" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.ok">任务 #{{ row.taskId }}</span>
            <span v-else class="muted">{{ row.error }}</span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="batchGenResultDlg = false">关闭</el-button>
        <el-button type="primary" @click="batchGenResultDlg = false; loadGeneration()">查看任务列表</el-button>
      </template>
    </el-dialog>

    <!-- ============ 批量导入 ============ -->
    <el-dialog v-model="importDlg" title="批量导入 dola 账号 Cookie" width="680px">
      <el-alert type="info" :closable="false" show-icon class="tip">
        <template #title>一行一个账号，直接粘贴 cookie 就行</template>
        <div class="notice-body">
          支持这几种格式，会自动识别：原始 Cookie 头（<code>a=1; b=2</code>）、
          <code>document.cookie</code>、浏览器插件导出的 JSON 数组（<b>整段粘贴即可，
          格式化过的多行 JSON 也认</b>）、Netscape <code>cookies.txt</code>。
          行首 <code>#</code> 视为注释，空行忽略。相同的 cookie 会自动跳过。
        </div>
      </el-alert>
      <el-form label-width="90px">
        <el-form-item label="cookie">
          <el-input v-model="importForm.raw" type="textarea" :rows="10" class="mono-box"
            placeholder="ttwid=...; odin_tt=...; s_v_web_id=...&#10;ttwid=...; odin_tt=..." />
        </el-form-item>
        <el-form-item label="命名前缀">
          <el-input v-model="importForm.labelPrefix" placeholder="如：账号 → 账号001、账号002…" />
        </el-form-item>
        <el-form-item label="账号来源"><el-input v-model="importForm.source" placeholder="可选，如：渠道A / 某批次（用于来源筛选）" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="importForm.note" placeholder="可选，如：某渠道 / 某批次" /></el-form-item>
      </el-form>
      <el-alert v-if="importResult" :type="importResult.invalid ? 'warning' : 'success'" :closable="false" class="mt">
        <template #title>
          导入 {{ importResult.inserted }} 个，跳过重复 {{ importResult.skipped }} 个，无效 {{ importResult.invalid }} 行
        </template>
        <div v-if="importResult.problems?.length" class="notice-body">
          <div v-for="(p, i) in importResult.problems" :key="i">· {{ p }}</div>
        </div>
      </el-alert>
      <template #footer>
        <el-button @click="importDlg = false">关闭</el-button>
        <el-button type="primary" :loading="saving" @click="doImport">开始导入</el-button>
      </template>
    </el-dialog>

    <!-- ============ 单账号测试生成（会消耗真实额度，走网关链路扣积分） ============ -->
    <el-dialog v-model="testGenDlg" title="测试生成" width="560px" :close-on-click-modal="false">
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="将在该账号上提交一条真实生成任务，消耗该账号额度和所选令牌积分，且不触发限流自动换号（测的就是这个号本身）。" />
      <el-form label-width="90px" class="mt">
        <el-form-item label="账号"><b>{{ testGenForm.label }}</b></el-form-item>
        <el-form-item label="用户令牌" required>
          <el-select v-model="testGenForm.tokenId" placeholder="选择要扣积分的用户令牌" filterable style="width: 100%">
            <el-option v-for="t in tokenOptions" :key="t.id" :value="t.id"
              :label="`${t.name || '令牌'}（${t.prefix}…，余 ${t.points} 分）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="时长">
          <el-radio-group v-model="testGenForm.seconds">
            <el-radio :label="10">10 秒</el-radio>
            <el-radio :label="15">15 秒</el-radio>
            <el-radio :label="20">20 秒</el-radio>
            <el-radio :label="30">30 秒</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="提示词">
          <el-input v-model="testGenForm.prompt" type="textarea" :rows="3" placeholder="可选，默认「测试生成（账号…, N 秒）」" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="testGenDlg = false">取消</el-button>
        <el-button type="primary" :loading="testGenBusy" @click="doTestGenerate">提交测试</el-button>
      </template>
    </el-dialog>

    <!-- ============ 压力测试（批量提交真实任务，测号池吞吐） ============ -->
    <el-dialog v-model="stressDlg" title="压力测试" width="560px" :close-on-click-modal="false">
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="按数量顺序提交真实生成任务进队列，由编排器按并发设置消费。不绑定账号，走正常选号与限流换号链路。" />
      <el-form label-width="90px" class="mt">
        <el-form-item label="用户令牌" required>
          <el-select v-model="stressForm.tokenId" placeholder="选择要扣积分的用户令牌" filterable style="width: 100%">
            <el-option v-for="t in tokenOptions" :key="t.id" :value="t.id"
              :label="`${t.name || '令牌'}（${t.prefix}…，余 ${t.points} 分）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="任务数量">
          <el-input-number v-model="stressForm.count" :min="1" :max="20" />
          <span class="muted ml">条（1～20）</span>
        </el-form-item>
        <el-form-item label="时长">
          <el-radio-group v-model="stressForm.seconds">
            <el-radio :label="10">10 秒</el-radio>
            <el-radio :label="15">15 秒</el-radio>
            <el-radio :label="20">20 秒</el-radio>
            <el-radio :label="30">30 秒</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="提示词前缀">
          <el-input v-model="stressForm.prompt" placeholder="可选，默认「压力测试」，每条自动加 #i/N 后缀" />
        </el-form-item>
        <el-form-item label="预估消耗">
          <span>约 <b class="points">{{ stressCost }}</b> 积分（按 2 点/条估算）+ 号池约 <b>{{ stressForm.count }}</b> 条额度</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="stressDlg = false">取消</el-button>
        <el-button type="primary" :loading="stressBusy" @click="doStressTest">开始压测</el-button>
      </template>
    </el-dialog>

    <!-- ============ 批量分组 ============ -->
    <el-dialog v-model="groupDlg" title="批量分组" width="440px">
      <el-form label-width="90px">
        <el-form-item label="分组">
          <el-input v-model="groupForm.group" placeholder="如：渠道A / 测试组（留空 = 移出分组）" maxlength="32" show-word-limit />
        </el-form-item>
        <el-form-item label="范围"><span>选中的 {{ selected.length }} 个账号</span></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDlg = false">取消</el-button>
        <el-button type="primary" :loading="groupBusy" @click="doBatchGroup">确定</el-button>
      </template>
    </el-dialog>

    <!-- ============ 出口隔离修复 ============ -->
    <el-dialog v-model="proxyDlg" title="修复 IPWeb 出口隔离" width="760px" :close-on-click-modal="false" @closed="proxyForm.password = ''">
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="只修复你勾选的账号；每条代理会先通过 ipinfo.io 核验，撞 IP 会自动换 SID，失败不会写入重复出口。">
        <div class="notice-body">默认复用账号已有的 IPWeb 配置，只在服务端更换 SID；密码不回传到页面，也不会写入日志。</div>
      </el-alert>
      <el-form label-width="120px">
        <el-form-item label="待修复账号">
          <div v-loading="proxyTargetLoading" class="proxy-targets">
            <el-checkbox-group v-model="proxyForm.ids">
              <el-checkbox v-for="row in proxyTargets" :key="row.id" :label="row.id" class="proxy-target">
                #{{ row.id }} {{ primaryName(row) }}
                <span class="muted">（{{ row.exitIpShared ? '共享出口' : '出口未核验' }}）</span>
              </el-checkbox>
            </el-checkbox-group>
            <span v-if="!proxyTargetLoading && !proxyTargets.length" class="muted">当前没有发现需要修复的账号。</span>
          </div>
        </el-form-item>
        <el-form-item label="修复方式">
          <el-radio-group v-model="proxyForm.mode">
            <el-radio label="reuse">复用已有 IPWeb（推荐）</el-radio>
            <el-radio label="manual">填写新 IPWeb 配置</el-radio>
          </el-radio-group>
          <div v-if="proxyForm.mode === 'reuse'" class="hint proxy-mode-hint">服务端读取已保存代理的 IPWeb 参数并只更换 SID；页面不会接触密码。</div>
        </el-form-item>
        <template v-if="proxyForm.mode === 'manual'">
          <el-form-item label="IPWeb 用户编号" required>
            <el-input v-model="proxyForm.account" autocomplete="off" placeholder="例如 B_36307" />
          </el-form-item>
          <el-form-item label="IPWeb 密码" required>
            <el-input v-model="proxyForm.password" type="password" show-password autocomplete="new-password" placeholder="只在本次修复中使用" />
          </el-form-item>
          <el-form-item label="出口国家代码" required>
            <el-input v-model="proxyForm.country" maxlength="3" placeholder="例如 JP 或 KR" />
          </el-form-item>
          <el-form-item label="州 / 城市代码">
            <el-input v-model="proxyForm.state" placeholder="可留空；国家切换时不要沿用旧国家代码" />
            <el-input v-model="proxyForm.city" class="proxy-inline-input" placeholder="可留空" />
          </el-form-item>
          <el-form-item label="持续分钟">
            <el-input-number v-model="proxyForm.minutes" :min="1" :max="30" />
            <span class="hint">IPWeb 自编会话最多 30 分钟</span>
          </el-form-item>
          <el-form-item label="入口网关">
            <el-input v-model="proxyForm.gateway" placeholder="默认 gate2.ipweb.cc" />
          </el-form-item>
        </template>
      </el-form>
      <el-alert v-if="proxyResult" :type="proxyResult.failed ? 'warning' : 'success'" :closable="false" class="mt">
        <template #title>已处理 {{ proxyResult.assigned || 0 }} 个，失败 {{ proxyResult.failed || 0 }} 个；撞出口 {{ proxyResult.collisions || 0 }} 次，换 SID {{ proxyResult.rerolled || 0 }} 次</template>
        <div v-if="proxyResult.results?.length" class="notice-body proxy-results">
          <div v-for="row in proxyResult.results" :key="`${row.id}-${row.sid || 'none'}`">
            #{{ row.id }}：{{ row.ok ? '已写入独立出口' : (row.message || '未写入') }}
          </div>
        </div>
      </el-alert>
      <template #footer>
        <el-button @click="proxyDlg = false">关闭</el-button>
        <el-button type="primary" :loading="proxyLoading" :disabled="proxyTargetLoading || !proxyForm.ids.length" @click="assignProxyRepair">开始逐条核验并修复</el-button>
      </template>
    </el-dialog>

    <!-- ============ 任务进度 ============ -->
    <el-dialog v-model="jobDlg" title="任务进度" width="620px">
      <template v-if="activeJob">
        <div class="job-head">
          <el-tag :type="jobStatusType(activeJob.status)">{{ jobStatusLabel(activeJob.status) }}</el-tag>
          <span class="muted">{{ jobTypeLabel(activeJob) }}<template v-if="activeJob.concurrency != null"> · 并发 {{ activeJob.concurrency }}</template></span>
        </div>
        <el-progress
          :percentage="activeJob.total ? Math.round((activeJob.done / activeJob.total) * 100) : 0"
          :status="activeJob.status === 'failed' ? 'exception' : (activeJob.status === 'done' ? 'success' : undefined)"
          :stroke-width="16" :text-inside="true"
        />
        <p class="muted mt">
          已完成 {{ activeJob.done }}/{{ activeJob.total }}　成功 <b class="ok">{{ activeJob.ok_count }}</b>　失败 <b class="err">{{ activeJob.fail_count }}</b>
          <span v-if="isJobRunning(activeJob)">　（进行中，每 1.5 秒自动刷新）</span>
        </p>
        <el-divider>明细（最多 300 条）</el-divider>
        <el-table :data="activeJob.result?.details || []" max-height="300" border size="small">
          <el-table-column prop="id" label="账号" width="70" />
          <el-table-column label="结果" width="70">
            <template #default="{ row }">
              <el-tag size="small" :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="说明" show-overflow-tooltip />
        </el-table>
      </template>
    </el-dialog>

    <!-- ============ 额度转积分 ============ -->
    <el-dialog v-model="convertDlg" title="计价换算（按账号数 / 按额度）" width="620px">
      <el-alert type="warning" :closable="false" show-icon class="tip"
        title="这是内部记账：把账号资源折算成后台积分。不会真的消费掉 dola 账号的额度。" />
      <el-form label-width="120px">
        <el-form-item label="计价方式">
          <el-radio-group v-model="convertForm.basis">
            <el-radio label="account">按账号数</el-radio>
            <el-radio label="credits">按额度</el-radio>
          </el-radio-group>
          <div class="hint block">
            免费号没有可查额度，用「按账号数」；付费号有 credits 才用「按额度」。
          </div>
        </el-form-item>
        <el-form-item v-if="convertForm.basis === 'account'" label="单账号积分">
          <el-input-number v-model="convertForm.pointsPerAccount" :min="1" :max="1000000" :step="10" />
          <span class="hint">当前设置值 {{ provider.settings?.pointsPerAccount }}；每个账号只计一次</span>
        </el-form-item>
        <el-form-item v-else label="换算比例">
          <el-input-number v-model="convertForm.ratio" :min="1" :max="100000" />
          <span class="hint">dola 额度 = 1 积分（当前设置值 {{ provider.settings?.creditsPerPoint }}）</span>
        </el-form-item>
        <el-form-item label="范围">
          <el-radio-group v-model="convertForm.scope">
            <el-radio label="all">全部有效且已查到额度的账号</el-radio>
            <el-radio label="selected">仅选中的 {{ selected.length }} 个</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="充到令牌">
          <el-select v-model="convertForm.tokenId" placeholder="不选 = 只记账，不充积分" clearable filterable style="width: 100%">
            <el-option v-for="t in tokenOptions" :key="t.id" :label="`${t.name || '未命名'} (${t.prefix}) · ${t.points} 积分`" :value="t.id" />
          </el-select>
        </el-form-item>
      </el-form>

      <el-alert v-if="convertPreview" :type="convertPreview.pointsGained ? 'success' : 'info'" :closable="false" class="mt">
        <template #title>
          试算（{{ convertPreview.ratioDesc }}）：{{ convertPreview.accounts }} 个账号 → <b>{{ convertPreview.pointsGained }}</b> 积分
        </template>
        <div class="notice-body">
          <div v-for="(d, i) in (convertPreview.details || []).slice(0, 12)" :key="i">· {{ d.message }}</div>
          <div v-if="convertPreview.details?.length > 12" class="muted">…还有 {{ convertPreview.details.length - 12 }} 条</div>
        </div>
      </el-alert>

      <template #footer>
        <el-button @click="convertDlg = false">关闭</el-button>
        <el-button :loading="saving" @click="doConvert(true)">试算</el-button>
        <el-button type="primary" :loading="saving" :disabled="!convertPreview?.pointsGained" @click="doConvert(false)">
          确认换算
        </el-button>
      </template>
    </el-dialog>

    <!-- ============ 录入额度 ============ -->
    <el-dialog v-model="creditsDlg" title="手动录入额度" width="440px">
      <p class="muted">账号「{{ current?.label }}」当前额度：{{ current?.credits ?? '未查到' }}</p>
      <el-alert type="info" :closable="false" show-icon class="mb"
        title="自动查额度依赖尚未实测确定的字段；在你确认之前可以先用这里手工填。" />
      <el-input-number v-model="creditsInput" :min="0" :max="100000000" style="width: 100%" />
      <template #footer>
        <el-button @click="creditsDlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCredits">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 探测结果 ============ -->
    <el-dialog v-model="probeDlg" title="额度接口探测" width="760px">
      <template v-if="probeResult">
        <el-descriptions :column="2" border size="small" class="mb">
          <el-descriptions-item label="会话有效">{{ probeResult.session.valid ? '是' : '否' }}</el-descriptions-item>
          <el-descriptions-item label="判定依据">{{ probeResult.session.pullKind }}</el-descriptions-item>
          <el-descriptions-item label="用户标识">{{ probeResult.session.secUid || '—' }}</el-descriptions-item>
          <el-descriptions-item label="缺少 cookie">{{ probeResult.session.missing?.join(', ') || '无' }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="probeResult.probes" border size="small">
          <el-table-column prop="path" label="接口" min-width="240" show-overflow-tooltip />
          <el-table-column prop="code" label="code" width="110" />
          <el-table-column label="判定" width="150">
            <template #default="{ row }">
              <el-tag size="small" :type="row.kind === 'ok' ? 'success' : (row.kind === 'session_expired' ? 'info' : 'warning')">
                {{ row.kind }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="曾误判需签名" width="110">
            <template #default="{ row }">{{ row.flagged ? '是' : '否' }}</template>
          </el-table-column>
          <el-table-column label="可疑额度字段" min-width="200">
            <template #default="{ row }">
              <span v-if="!row.numericHits?.length" class="muted">无</span>
              <span v-else class="tiny">
                <span v-for="(h, i) in row.numericHits.slice(0, 4)" :key="i" class="hit">{{ h.field }}={{ h.value }}</span>
              </span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>

    <!-- ============ 原生视频能力探测 ============ -->
    <el-dialog v-model="nativeProbeDlg" :title="nativeProbeResult?.referenceImages ? '参考图上传能力探测' : `原生 ${nativeProbeResult?.seconds || 30} 秒能力探测`" width="520px">
      <el-alert type="info" :closable="false" show-icon
        :title="nativeProbeResult?.referenceImages ? '只读探测：打开页面检查真实图片文件控件，不选择文件、不填写提示词、不发送任务、不消耗生成额度。' : '只读探测：打开页面检查现有模型和时长选项，不填写提示词、不发送任务、不消耗生成额度。'" />
      <el-descriptions v-if="nativeProbeResult" :column="1" border size="small" class="mt">
        <el-descriptions-item label="账号">{{ nativeProbeResult.label || '当前账号' }}</el-descriptions-item>
        <el-descriptions-item label="结果">
          <el-tag :type="nativeProbeResult.state === 'available' ? 'success' : (nativeProbeResult.state === 'unavailable' ? 'warning' : 'info')">
            {{ nativeProbeResult.referenceImages ? (nativeProbeResult.state === 'available' ? '已发现明确图片上传控件' : (nativeProbeResult.state === 'unavailable' ? '页面未发现明确图片上传控件' : '本次未完成判定')) : (nativeProbeResult.state === 'available' ? `已确认原生 ${nativeProbeResult.seconds || 30} 秒` : (nativeProbeResult.state === 'unavailable' ? `页面未提供原生 ${nativeProbeResult.seconds || 30} 秒` : '本次未完成判定')) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="说明">{{ nativeProbeResult.message || '—' }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>

    <!-- ============ cookie 明文 ============ -->
    <el-dialog v-model="revealDlg" title="账号 cookie" width="680px">
      <el-alert type="info" :closable="false" show-icon title="这次查看已写入操作日志。" class="mb" />
      <el-input v-model="revealValue" type="textarea" :rows="5" readonly class="mono-box" />
      <template #footer>
        <el-button type="primary" :icon="CopyDocument" @click="copy(revealValue)">复制</el-button>
        <el-button @click="revealDlg = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, CircleCheck, CopyDocument, Key, Money, Refresh, Search, Switch, Upload } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can } from '../store.js';
import DolaGoogleLogin from '../components/DolaGoogleLogin.vue';
import DolaGenerationAnalytics from '../components/DolaGenerationAnalytics.vue';

const tab = ref(useRoute().query.tab === 'analytics' ? 'analytics' : 'accounts');
const items = ref([]);
const summary = ref({});
const selected = ref([]);
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const query = reactive({ page: 1, pageSize: 20, keyword: '', status: '', group: '', source: '' });
let accountRequestId = 0;

const provider = ref({ settings: {} });
const tokenOptions = ref([]);
const providerLoading = ref(false);
const maintenanceLoading = ref(false);

// 8790 的运营视图已并入本页，数据全部来自 8788 的真实表和编排器。
const operationSummary = ref(null);
const operationsLoading = ref(false);
const proxySummary = ref({});
const proxyAccounts = ref([]);
const proxyListLoading = ref(false);
const limitsSaving = ref(false);
const limitForm = reactive({
  minSubmitIntervalSec: 60,
  rateLimitCooldownMin: 30,
  promptCooldownSec: 120,
  generationConcurrency: 1,
  generationQueueLimit: 6000,
  autorotateMaxAttempts: 3,
});

const importDlg = ref(false);
const importForm = reactive({ raw: '', labelPrefix: '', note: '', source: '' });
const importResult = ref(null);

const proxyDlg = ref(false);
const proxyLoading = ref(false);
const proxyTargetLoading = ref(false);
const proxyTargets = ref([]);
const proxyResult = ref(null);
const proxyForm = reactive({
  ids: [], mode: 'reuse', account: '', password: '', country: '', state: '', city: '', minutes: 30, gateway: 'gate2.ipweb.cc',
});

const jobs = ref([]);
const jobLoading = ref(false);
const jobDlg = ref(false);
const activeJob = ref(null);
const generationTasks = ref([]);
const generationLoading = ref(false);
const generationStatusFilter = ref('');
let pollTimer = null;
let jobPollVersion = 0;
let providerTimer = null;

const batchGenDlg = ref(false);
const batchGenResultDlg = ref(false);
const batchGenSaving = ref(false);
const batchGenResult = ref(null);
const batchGenForm = reactive({
  tokenMode: 'select',
  tokenId: null,
  tokenRaw: '',
  prompts: '',
  mode: 'standard',
  seconds: 10,
  ratio: '16:9',
  points: null,
});
let providerRequest = null;
let generationRequest = null;
let disposed = false;
const PROVIDER_IDLE_POLL_MS = 15_000;
const PROVIDER_BUSY_POLL_MS = 3_000;

const conversions = ref([]);
const convSummary = ref({});
const convLoading = ref(false);

const convertDlg = ref(false);
const convertForm = reactive({ basis: 'account', pointsPerAccount: 50, ratio: 10, scope: 'all', tokenId: null });
const convertPreview = ref(null);

const creditsDlg = ref(false);
const creditsInput = ref(0);
const current = ref(null);

const probeDlg = ref(false);
const probeResult = ref(null);
const nativeProbeDlg = ref(false);
const nativeProbeResult = ref(null);

const revealDlg = ref(false);
const revealValue = ref('');
const noticeOpen = ref(false);   // 顶部说明默认收起

// ---- 新增：测试生成 / 压力测试 / 批量分组 ----
const testGenDlg = ref(false);
const testGenBusy = ref(false);
const testGenForm = reactive({ id: null, label: '', tokenId: null, seconds: 10, prompt: '' });
const stressDlg = ref(false);
const stressBusy = ref(false);
const stressForm = reactive({ tokenId: null, count: 5, seconds: 10, prompt: '' });
const stressCost = computed(() => Number(stressForm.count || 0) * 2); // 按 15 秒档 2 点/条估算
const groupDlg = ref(false);
const groupBusy = ref(false);
const groupForm = reactive({ group: '' });

const STATUS = { valid: '有效', invalid: '失效', unknown: '未校验', disabled: '已停用' };
const statusLabel = (s) => STATUS[s] || s;
const statusType = (s) => ({ valid: 'success', invalid: 'danger', unknown: 'info', disabled: 'warning' }[s] || 'info');
const JOB = { queued: '排队中', running: '进行中', done: '已完成', failed: '异常', cancelled: '已取消' };
const jobStatusLabel = (s) => JOB[s] || s;
const jobStatusType = (s) => ({ queued: 'info', running: 'warning', done: 'success', failed: 'danger', cancelled: 'info' }[s] || 'info');
const GENERATION = { queued: '排队中', submitting: '提交中', generating: '生成中', resolving: '解析中', ready: '已完成', failed: '失败', cancelled: '已取消' };
const generationStatusLabel = (s) => GENERATION[s] || s || '未知';
const generationStatusType = (s) => ({ queued: 'info', submitting: 'warning', generating: 'warning', resolving: 'primary', ready: 'success', failed: 'danger', cancelled: 'info' }[s] || 'info');
const isJobRunning = (j) => j && (j.status === 'queued' || j.status === 'running');
const maintenanceJob = computed(() => {
  const job = provider.value.maintenance?.activeJob;
  return isJobRunning(job) ? job : null;
});
const maintenanceBusy = computed(() => maintenanceLoading.value || Boolean(maintenanceJob.value) || Boolean(isJobRunning(activeJob.value)));
function jobTypeLabel(job) {
  if (job.type === 'dola_hello_probe') return '发送“你好”探测';
  if (job.type === 'dola_native_15s') return '原生 15 秒探测';
  if (job.type === 'dola_native_30s') return '原生 30 秒探测';
  if (job.type === 'dola_reference_images') return '参考图上传探测';
  const maintenance = job.automatic || job.payload?.autoMaintenance
    || job.id === provider.value.maintenance?.activeJob?.id
    || job.id === provider.value.maintenance?.lastJob?.id;
  return maintenance ? '账号维护' : (job.type === 'dola_check' ? '批量校验' : '批量查额度');
}
function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'; }

/**
 * 相对时间。后台看账号状态时，「最后校验」用相对时间比绝对时间好读得多 ——
 * 「12 分钟前」一眼就知道数据新不新，「2026/9/19 11:32:35」还得心算。
 * 超过 30 天回退成日期，避免出现「45 天前」这种没信息量的说法。
 */
function relTime(iso) {
  if (!iso) return '从未校验';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d <= 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/**
 * 账号主标题。
 * 优先用人工备注名（label，导入时可填、之后可改），没有才退回自动识别的标识。
 */
function primaryName(row) {
  return String(row.loginEmail || row.label || '').trim() || String(row.account_hint || '').trim().split(/\s+/)[0] || `#${row.id}`;
}

/**
 * 账号副标题（自动识别到的标识）。
 *
 * ⚠️ 必须去重：`account_hint` 实测经常是「昵称 昵称」这种重复串
 * （dola 的 nickname 和 userName 字段值相同，拼接后就重了），
 * 原样显示会出现「umk1z0 umk1z0」这种看着像 bug 的东西。
 * 另外和主标题相同时返回空，不重复显示。
 */
function secondaryName(row) {
  const hint = String(row.account_hint || '').trim();
  if (!hint) return '';
  const uniq = [...new Set(hint.split(/\s+/).filter(Boolean))];
  const text = uniq.join(' · ');
  return text === primaryName(row) ? '' : text;
}

/** 还没换算掉的额度 */
function remainCredits(row) {
  if (row.credits == null) return 0;
  return Math.max(0, Number(row.credits) - Number(row.converted_credits || 0));
}

/** 额度来源压缩显示（原文形如 "some_field (launch)"，太长） */
function shortSource(src) {
  const s = String(src || '');
  if (!s) return '无额度数据';
  const field = s.split(' ')[0];
  const via = /浏览器/.test(s) ? '浏览器' : (/launch/.test(s) ? 'launch' : '');
  return via ? `${field} · ${via}` : field;
}

/** cookie 字段数（后端给的是逗号分隔的字段名列表） */
function cookieCount(row) {
  const names = String(row.cookie_names || '').trim();
  if (!names) return 0;
  return names.split(',').filter(Boolean).length;
}

/**
 * 出口代理的两个小工具。
 *
 * 代理 URL 形如 http://B_36307_KR____30_D0000110:密码@gate2.ipweb.cc:7778
 * 用户名各段用 `_` 连接，第 2 段就是国家代码 —— 直接切出来显示。
 */
function proxyRegion(proxy) {
  try {
    const user = decodeURIComponent(new URL(proxy).username);
    const parts = user.split('_');
    return parts[1] || '代理';
  } catch { return '代理'; }
}

/** 打码后再展示：用户名里有客户编号，密码更不能露 */
function maskProxy(proxy) {
  return String(proxy || '').replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');
}

/** 后端负责确认新鲜度；历史读数和旧版估算仅供追溯。0 是有效余额。 */
function hasConfirmedQuota(row) {
  return row.quotaKnown === true && row.quotaState === 'confirmed'
    && row.quota_source !== 'daily_reset_estimate'
    && Number.isFinite(row.quotaAvailable) && row.quotaAvailable >= 0;
}

function quotaLabel(row) {
  if (hasConfirmedQuota(row)) return `剩 ${row.quotaAvailable}`;
  return row.quotaState === 'stale' ? '待确认' : '未知';
}

function quotaClass(row) {
  if (!hasConfirmedQuota(row)) return row.quotaState === 'stale' ? 'quota-pending' : 'muted';
  return row.quotaAvailable === 0 ? 'quota-out' : 'quota-ok';
}

/** 提示中保留历史读数、来源和记录时间，不将它们用作今日余额。 */
function quotaTitle(row) {
  const value = hasConfirmedQuota(row)
    ? `已确认剩余额度：${row.quotaAvailable}`
    : (Number.isFinite(row.quota_remaining) && row.quota_remaining >= 0
      ? `历史读数：${row.quota_remaining}（非今日确认余额）`
      : '尚无已确认的剩余额度');
  return `${value}；来源：${row.quota_source || '未记录'}；记录时间：${row.quota_at ? fmt(row.quota_at) : '未记录'}`;
}

function quotaSourceLabel(row) {
  if (row.quota_source === 'generation_receipt') return '来源：生成回执';
  if (row.quota_source === 'daily_reset_estimate') return '来源：旧版估算';
  return row.quota_source ? `来源：${shortSource(row.quota_source)}` : '无来源记录';
}

/**
 * 行样式：坏号要一眼看出来。
 * 失效 = 红条；未校验 = 黄条（提示"这个还没验过"，别当成好的用）。
 */
function rowClass({ row }) {
  if (row.status === 'invalid') return 'row-danger';
  if (row.status === 'unknown') return 'row-warn';
  return '';
}

/**
 * 「说明」列的内容与严重级别。
 *
 * ⚠️ 不能把 `last_error` 一律染红 —— 那个字段其实是"最后一次操作的返回消息"，
 * 里面混着两类完全不同的东西：
 *   · **真错误**：会话半失效 / cookie 缺字段 / 校验失败  → 红，这是要处理的
 *   · **中性提示**：「未在候选接口里找到额度字段」这类   → 灰，这只是"没查到额度"，
 *     免费号本来就查不到额度，染红会让人误以为号坏了（实测踩到）。
 */
function noteOf(row) {
  const e = String(row.last_error || '').trim();
  if (!e) {
    if (!row.cookie_names) return { text: 'cookie 字段不完整', cls: 'err' };
    if (row.status === 'unknown') return { text: '还没校验过', cls: 'muted' };
    return { text: '正常', cls: 'muted' };
  }
  const isRealError = /失效|无效|expired|Session|不完整|缺少|失败|异常|封/.test(e);
  return { text: e, cls: isRealError ? 'err' : 'note' };
}

/**
 * 统计卡。刻意压到 **6 个**（原来是 7 个，md 栅格下会挤出一个孤零零的第 7 张）。
 * 每张卡补一行副信息，把原本要占一张卡的信息塞进去 —— 信息量没少，但排得整齐。
 *
 * 卡片顺序按"现在最该关心什么"排：能不能跑（有效 + 代理）→ 还剩多少弹药（额度）→ 记账。
 */
const statCards = computed(() => {
  const s = summary.value;
  const valid = s.valid ?? 0;
  const invalid = s.invalid ?? 0;
  const unknown = s.unknown ?? 0;
  const usableRate = (valid + invalid) ? Math.round((valid / (valid + invalid)) * 100) : null;
  const quotaKnown = s.quotaKnown ?? 0;
  // quotaUnknown 已包含 stale，覆盖率的分母不能重复加上 quotaStale。
  const quotaUnknown = s.quotaUnknown ?? 0;
  const quotaStale = s.quotaStale ?? 0;
  return [
    {
      label: '账号总数', value: s.total ?? 0, color: 'var(--el-color-primary)',
      sub: `${s.withProxy ?? 0} 个配了代理${s.missingExitIp ? ` · ${s.missingExitIp} 个待核验出口` : ''}`,
    },
    {
      label: '有效', value: valid, color: '#67c23a',
      sub: usableRate == null ? '还没校验过' : `可用率 ${usableRate}%${s.cooling ? ` · 冷却中 ${s.cooling}` : ''}`,
    },
    {
      label: '失效', value: invalid, color: '#f56c6c',
      sub: invalid ? '需要重新导入 cookie' : '暂时没有坏号',
    },
    {
      label: '已确认剩余额度',
      value: quotaKnown > 0 && Number.isFinite(s.quotaRemaining) ? s.quotaRemaining : '未知',
      color: '#409eff',
      sub: `已确认 ${quotaKnown}/${quotaKnown + quotaUnknown} 个 · 待确认 ${quotaStale} 个 · 未知 ${Math.max(0, quotaUnknown - quotaStale)} 个`,
      title: '仅统计有效且非冷却中的账号；失效、停用和冷却中的账号不计入额度及覆盖率。待确认的历史读数不计入余额。',
    },
    {
      label: '未校验', value: unknown, color: '#909399',
      sub: unknown ? '批量校验一次看看' : '都已校验',
    },
    {
      label: '换算进度', value: s.countable ?? 0, color: '#9b6eff',
      sub: `可计 ${s.countable ?? 0} · 已计 ${s.counted ?? 0}`,
    },
  ];
});

/**
 * 补号提示横幅：后端 summary.replenish 随每次轮询实时返回，
 * 有效账号或已确认剩余额度低于阈值时显示 warning；有号但额度未确认时显示 info。
 */
const replenishBanner = computed(() => {
  const r = summary.value?.replenish;
  if (!r) return null;
  if (r.needReplenish) {
    return {
      level: 'warning',
      title: '号池需要补号',
      text: `${(r.reasons || []).join('；')}（阈值：有效账号 ${r.minAccounts} 个 / 已确认剩余额度 ${r.minQuota}，可在「系统设置 → dola 账号池」调整）`,
    };
  }
  if (r.quotaCheckHint) {
    return {
      level: 'info',
      title: '额度尚未确认',
      text: '有可用账号，但没有任何账号确认过今日额度——先批量查额度，再判断是否需要补号。',
    };
  }
  return null;
});

const operationCards = computed(() => {
  const o = operationSummary.value || {};
  const a = o.accounts || {};
  const t = o.today || {};
  const q = o.queue || {};
  return [
    { label: '健康号', value: a.valid ?? 0, color: '#67c23a', sub: `空闲 ${a.idle ?? 0} · 冷却 ${a.cooling ?? 0}` },
    { label: '今日成功', value: t.succeeded ?? 0, color: '#409eff', sub: `任务 ${t.total ?? 0}` },
    { label: '今日失败', value: t.failed ?? 0, color: '#f56c6c', sub: `取消 ${t.cancelled ?? 0}` },
    { label: '限流命中', value: t.rateLimitHits ?? 0, color: '#e6a23c', sub: '710022002' },
    { label: '队列深度', value: q.activeTasks ?? 0, color: '#9b6eff', sub: `容量 ${q.queueLimit ?? 6000}` },
    { label: '代理隔离', value: (o.proxy?.missingExitIp || o.proxy?.sharedExitIpRows || o.proxy?.withoutProxy) ? '待处理' : '正常', color: (o.proxy?.missingExitIp || o.proxy?.sharedExitIpRows || o.proxy?.withoutProxy) ? '#e6a23c' : '#67c23a', sub: `${o.proxy?.withExitIp ?? 0}/${o.proxy?.withProxy ?? 0} 已核验` },
  ];
});

async function copy(text) {
  try { await navigator.clipboard.writeText(text); ElMessage.success('已复制'); }
  catch { ElMessage.warning('浏览器拒绝了剪贴板权限，请手动复制'); }
}

async function load({ silent = false } = {}) {
  const requestId = ++accountRequestId;
  if (!silent) loading.value = true;
  try {
    const res = await api.get(`/api/dola/accounts${qs(query)}`, { silent });
    if (disposed || requestId !== accountRequestId) return;
    items.value = res.items;
    total.value = res.total;
    summary.value = res.summary || {};
  } finally { if (requestId === accountRequestId) loading.value = false; }
}
function reload() { query.page = 1; load(); }

async function refreshProvider({ silent = false } = {}) {
  if (providerRequest) return providerRequest;
  providerLoading.value = true;
  providerRequest = (async () => {
    const previous = provider.value.maintenance;
    const res = await api.get('/api/dola/provider', { silent });
    if (disposed) return;
    provider.value = res;
    const next = res.maintenance;
    const finished = previous?.activeJob && previous.activeJob.id !== next?.activeJob?.id;
    const updated = next?.lastJob && !isJobRunning(next.lastJob)
      && (next.lastJob.id !== previous?.lastJob?.id || next.lastJob.status !== previous?.lastJob?.status
        || next.lastJob.updated_at !== previous?.lastJob?.updated_at);
    if (previous && (finished || updated)) {
      await Promise.allSettled([load({ silent }), loadJobs({ silent })]);
    }
  })();
  try { await providerRequest; }
  finally { providerRequest = null; providerLoading.value = false; }
}

async function runMaintenance() {
  if (maintenanceBusy.value) return;
  maintenanceLoading.value = true;
  try {
    const res = await api.post('/api/dola/maintenance/run');
    if (res.job) {
      if (res.created) ElMessage.success('账号维护已提交');
      else ElMessage.info('已有账号任务在运行，已打开进度');
      openJob(res.job);
    } else {
      ElMessage.info(res.skipped === 'empty' ? '当前没有可维护账号（账号池为空或全部停用）' : '本次未创建维护任务');
    }
    await Promise.allSettled([refreshProvider(), loadJobs(), load()]);
  } finally { maintenanceLoading.value = false; }
}

async function loadJobs({ silent = false } = {}) {
  if (!silent) jobLoading.value = true;
  try { jobs.value = (await api.get('/api/dola/jobs?limit=30', { silent })).items; }
  finally { if (!silent) jobLoading.value = false; }
}

async function loadGeneration({ silent = false } = {}) {
  if (generationRequest) return generationRequest;
  if (!silent) generationLoading.value = true;
  const query = generationStatusFilter.value
    ? `&status=${encodeURIComponent(generationStatusFilter.value)}`
    : '';
  generationRequest = (async () => {
    const res = await api.get(`/api/dola/generation-tasks?limit=100${query}`, { silent });
    if (disposed) return;
    generationTasks.value = res.items || [];
    if (res.generation) provider.value = { ...provider.value, generation: res.generation };
  })();
  try { await generationRequest; }
  finally {
    generationRequest = null;
    if (!silent) generationLoading.value = false;
  }
}

const batchGenLines = computed(() =>
  String(batchGenForm.prompts || '').split('\n').map((l) => l.trim()).filter(Boolean));

function onBatchSecondsChange() {
  // 15 秒只能走专家模式：与 8787 前台保持一致，自动切过去
  if (batchGenForm.seconds === 15) batchGenForm.mode = 'expert';
}

/**
 * 令牌下拉的公共加载入口。
 *
 * ⚠️ 以前只有「批量生成」和「兑换」两个弹窗会去拉 /api/tokens/options，
 * 而「测试生成」「压力测试」直接用 tokenOptions.value —— 只要没先开过那两个弹窗，
 * 下拉框就必然是空的，选不了令牌（表现为忽好忽坏的幽灵 bug）。
 * 现在凡是要点选令牌的弹窗，统一先走这里。
 */
async function loadTokenOptions() {
  try { tokenOptions.value = (await api.get('/api/tokens/options')).items; } catch { /* 无权限 */ }
}

async function openBatchGen() {
  batchGenForm.prompts = '';
  batchGenForm.tokenId = null;
  batchGenForm.tokenRaw = '';
  batchGenForm.tokenMode = 'select';
  batchGenForm.mode = 'standard';
  batchGenForm.seconds = 10;
  batchGenForm.ratio = '16:9';
  batchGenForm.points = null;
  batchGenResult.value = null;
  batchGenDlg.value = true;
  await loadTokenOptions();
}

function openApiWorkbench() {
  window.open(`${window.location.origin}/test.html`, '_blank', 'noopener,noreferrer');
}

async function submitBatchGen() {
  const lines = batchGenLines.value;
  if (!lines.length) { ElMessage.error('请至少填写一条提示词'); return; }
  if (lines.length > 20) { ElMessage.error('一次最多提交 20 条'); return; }
  if (batchGenForm.tokenMode === 'select' && !batchGenForm.tokenId) { ElMessage.error('请选择要扣积分的用户令牌'); return; }
  if (batchGenForm.tokenMode === 'paste' && !batchGenForm.tokenRaw.trim()) { ElMessage.error('请粘贴用户令牌原文'); return; }
  batchGenSaving.value = true;
  try {
    const body = {
      items: lines.map((prompt) => ({
        prompt,
        mode: batchGenForm.seconds === 15 ? 'expert' : batchGenForm.mode,
        seconds: batchGenForm.seconds,
        ratio: batchGenForm.ratio,
      })),
    };
    if (batchGenForm.tokenMode === 'select') body.tokenId = batchGenForm.tokenId;
    else body.token = batchGenForm.tokenRaw.trim();
    if (batchGenForm.points != null) body.points = batchGenForm.points;
    const res = await api.post('/api/dola/generation-tasks/batch', body);
    batchGenResult.value = res;
    batchGenDlg.value = false;
    batchGenResultDlg.value = true;
    await loadGeneration();
  } catch (e) {
    ElMessage.error(e.message || '批量提交失败');
  } finally {
    batchGenSaving.value = false;
  }
}

async function loadConversions() {
  convLoading.value = true;
  try {
    const r = await api.get('/api/dola/conversions?pageSize=50');
    conversions.value = r.items;
    convSummary.value = r.summary || {};
  } finally { convLoading.value = false; }
}

async function loadOperations({ silent = false } = {}) {
  if (!silent) operationsLoading.value = true;
  try {
    const res = await api.get('/api/dola/operations/summary', { silent });
    if (disposed) return;
    operationSummary.value = res;
    proxySummary.value = res.proxy || {};
    Object.assign(limitForm, res.settings || {});
  } finally {
    if (!silent) operationsLoading.value = false;
  }
}

async function loadProxyAccounts() {
  proxyListLoading.value = true;
  try {
    const [summary, rows] = await Promise.all([
      api.get('/api/dola/accounts/proxy/summary', { silent: true }),
      api.get('/api/dola/accounts?page=1&pageSize=500', { silent: true }),
    ]);
    proxySummary.value = summary;
    proxyAccounts.value = rows.items || [];
  } finally {
    proxyListLoading.value = false;
  }
}

async function saveLimits() {
  limitsSaving.value = true;
  try {
    await api.put('/api/dola/operations/limits', { ...limitForm });
    ElMessage.success('保护参数已保存');
    await Promise.allSettled([loadOperations(), refreshProvider()]);
  } finally {
    limitsSaving.value = false;
  }
}

function onTab(name) {
  if (name === 'operations' || name === 'ratelimit') loadOperations();
  if (name === 'proxies') loadProxyAccounts();
  if (name === 'jobs') loadJobs();
  if (name === 'generation') loadGeneration();
  if (name === 'conversions') loadConversions();
}

async function doImport() {
  if (!importForm.raw.trim()) return ElMessage.warning('先粘贴 cookie');
  saving.value = true;
  try {
    importResult.value = await api.post('/api/dola/accounts/import', { ...importForm });
    ElMessage.success(`导入 ${importResult.value.inserted} 个`);
    load();
    if (importResult.value.inserted) importForm.raw = '';
  } finally { saving.value = false; }
}

/** Load only the accounts whose proxy isolation is not proven or is duplicated. */
async function openProxyRepair({ focusId = null } = {}) {
  proxyDlg.value = true;
  proxyResult.value = null;
  proxyForm.password = '';
  proxyForm.mode = 'reuse';
  proxyTargetLoading.value = true;
  try {
    const res = await api.get('/api/dola/accounts?page=1&pageSize=500', { silent: true });
    proxyTargets.value = (res.items || []).filter((row) => row.status !== 'disabled'
      && (!row.proxy || row.exitIpShared || !row.exitIpKnown));
    proxyForm.ids = proxyTargets.value.map((row) => row.id);
    if (focusId && proxyTargets.value.some((row) => row.id === focusId)) proxyForm.ids = [focusId];
    // 包含未配置代理的账号时必须走新 IPWeb 配置，避免复用模式把空代理当成坏代理。
    if (proxyTargets.value.some((row) => !row.proxy)) proxyForm.mode = 'manual';
  } finally {
    proxyTargetLoading.value = false;
  }
}

function openProxyRepairFor(row) {
  openProxyRepair({ focusId: row.id });
}

async function assignProxyRepair() {
  if (!proxyForm.ids.length) return ElMessage.warning('先选择需要修复的账号');
  const reuseExisting = proxyForm.mode === 'reuse';
  const country = proxyForm.country.trim().toUpperCase();
  if (!reuseExisting) {
    if (!proxyForm.account.trim() || !proxyForm.password) return ElMessage.warning('请填写 IPWeb 用户编号和密码');
    if (!/^[A-Z0-9]{2,3}$/.test(country)) return ElMessage.warning('请填写正确的出口国家代码，例如 JP 或 KR');
  }
  try {
    await ElMessageBox.confirm(
      `${reuseExisting ? '将复用现有 IPWeb 配置并逐条更换 SID' : '将逐条核验并重配 IPWeb 出口'}，处理 ${proxyForm.ids.length} 个账号；失败账号不会写入重复代理。继续吗？`,
      '确认修复出口隔离', { type: 'warning', confirmButtonText: '开始修复', cancelButtonText: '取消' },
    );
  } catch { return; }

  proxyLoading.value = true;
  proxyResult.value = null;
  try {
    proxyResult.value = await api.post('/api/dola/accounts/proxy/assign', {
      reuseExisting,
      ...(reuseExisting ? {} : {
        account: proxyForm.account.trim(),
        password: proxyForm.password,
        country,
        state: proxyForm.state.trim(),
        city: proxyForm.city.trim(),
        minutes: proxyForm.minutes,
        gateway: proxyForm.gateway.trim() || 'gate2.ipweb.cc',
      }),
      ids: proxyForm.ids,
      force: true,
      verify: true,
      gapMs: 3500,
    });
    proxyForm.password = '';
    ElMessage[proxyResult.value.failed ? 'warning' : 'success'](
      `出口修复完成：成功 ${proxyResult.value.assigned || 0} 个，失败 ${proxyResult.value.failed || 0} 个`,
    );
    await load({ silent: true });
  } finally {
    proxyLoading.value = false;
  }
}

/** 提交批量任务并打开进度窗口 */
async function runJob(type) {
  const useSelected = selected.value.length > 0;
  const label = jobTypeLabel({ type });
  const capabilityProbe = type === 'dola_native_15s' || type === 'dola_native_30s' || type === 'dola_reference_images';
  const helloProbe = type === 'dola_hello_probe';
  const target = useSelected ? `选中的 ${selected.value.length} 个账号`
    : (helloProbe ? '全部未停用账号' : (capabilityProbe ? '全部有效且已绑定代理的账号' : '全部账号'));
  const detail = helloProbe
    ? '会为每个账号新建一条普通 Dola 对话并发送固定文本“你好”，会留下聊天记录且可能消耗上游文本对话额度；视频生成请求会被拦截，不会创建视频任务或扣后台积分。只在本次手动任务中发送，不进入定时巡检。'
    : (capabilityProbe
      ? '这是串行只读页面探测：不填写提示词、不发送任务、不消耗生成额度；已确认的账号会自动跳过。参考图探测只认明确的图片文件控件。'
      : '');
  try {
    await ElMessageBox.confirm(
      `${target}执行「${label}」？${detail ? `\n\n${detail}` : ''}`,
      '批量任务', { type: 'info' },
    );
  } catch { return; }
  const body = { type };
  if (useSelected) body.ids = selected.value.map((r) => r.id); else body.all = true;
  const res = await api.post('/api/dola/jobs', body);
  ElMessage.success('任务已提交');
  openJob(res.job);
  loadJobs();
}

async function rowAction(row, action) {
  const res = await api.post(`/api/dola/accounts/${row.id}/action`, { action });
  if (res.job) { openJob(res.job); return; }
  ElMessage.success('已提交');
  load();
}

async function rowMenu(row, cmd) {
  if (cmd === 'helloProbe') {
    try {
      await ElMessageBox.confirm(
        `给「${primaryName(row)}」新建一条普通对话并发送“你好”？会留下聊天记录且可能消耗上游文本对话额度；视频生成请求会被拦截。`,
        '发送你好探测', { type: 'warning', confirmButtonText: '发送并探测', cancelButtonText: '取消' },
      );
    } catch { return; }
    return rowAction(row, 'hello_probe');
  }
  if (cmd === 'credits' || cmd === 'probe') {
    // 这两个原来在操作列上是独立按钮，现在收进「更多」
    return cmd === 'probe' ? probe(row) : rowAction(row, 'credits');
  }
  if (cmd === 'native15') return probeNative(row, 15);
  if (cmd === 'native30') return probeNative(row, 30);
  if (cmd === 'referenceImages') return probeReferenceImages(row);
  if (cmd === 'set_credits') return openSetCredits(row);
  if (cmd === 'testGenerate') return openTestGenerate(row);
  if (cmd === 'recover') {
    try { await ElMessageBox.confirm(`解除「${primaryName(row)}」的限流冷却？之后可立即参与选号。`, '解除冷却', { type: 'warning' }); } catch { return; }
    await api.post(`/api/dola/accounts/${row.id}/action`, { action: 'recover' });
    ElMessage.success('已解除冷却');
    return load();
  }
  if (cmd === 'resetQuota') {
    try { await ElMessageBox.confirm(`把「${primaryName(row)}」的剩余额度重置为每日总额？`, '重置额度', { type: 'warning' }); } catch { return; }
    await api.post(`/api/dola/accounts/${row.id}/action`, { action: 'reset_quota' });
    ElMessage.success('已重置额度');
    return load();
  }
  if (cmd === 'reset_counted') {
    try { await ElMessageBox.confirm(`撤销「${row.label}」的已计价标记？之后可以重新计价（换算流水保留）。`, '撤销计价', { type: 'warning' }); } catch { return; }
    await api.post(`/api/dola/accounts/${row.id}/action`, { action: 'reset_counted' });
    ElMessage.success('已撤销计价标记');
    return load();
  }
  if (cmd === 'toggle') {
    const action = row.status === 'disabled' ? 'enable' : 'disable';
    await api.post(`/api/dola/accounts/${row.id}/action`, { action });
    ElMessage.success(action === 'enable' ? '已启用' : '已停用');
    return load();
  }
  if (cmd === 'delete') {
    try { await ElMessageBox.confirm(`确定删除账号「${row.label}」？`, '删除', { type: 'warning' }); } catch { return; }
    try {
      await api.del(`/api/dola/accounts/${row.id}`);
    } catch (e) {
      if (/换算记录/.test(e.message)) {
        try { await ElMessageBox.confirm('该账号有换算记录。仍要强制删除？', '强制删除', { type: 'warning' }); } catch { return; }
        await api.del(`/api/dola/accounts/${row.id}?force=1`);
      } else throw e;
    }
    ElMessage.success('已删除');
    load();
  }
}

async function bulkRemove() {
  const ids = selected.value.map((r) => r.id);
  try { await ElMessageBox.confirm(`确定删除选中的 ${ids.length} 个账号？`, '批量删除', { type: 'warning' }); } catch { return; }
  const r = await api.del('/api/dola/accounts', { ids });
  ElMessage.success(`已删除 ${r.deleted} 个${r.skipped ? `，跳过 ${r.skipped} 个（有换算记录）` : ''}`);
  load();
}

/** 批量恢复：解除选中账号的限流冷却（对标 dola-pool「批量恢复」） */
async function batchRecover() {
  if (!selected.value.length) return;
  try { await ElMessageBox.confirm(`解除选中的 ${selected.value.length} 个账号的限流冷却？之后可立即参与选号。`, '批量恢复', { type: 'warning' }); } catch { return; }
  const r = await api.post('/api/dola/accounts/batch-recover', { ids: selected.value.map((x) => x.id) });
  ElMessage.success(`已解除 ${r.updated} 个${r.skipped ? `，${r.skipped} 个不在冷却中` : ''}`);
  load();
}

/** 重置额度：把选中账号的剩余额度拨回每日总额（对标 dola-pool「重置额度」） */
async function batchResetQuota() {
  if (!selected.value.length) return;
  try { await ElMessageBox.confirm(`把选中的 ${selected.value.length} 个账号剩余额度重置为每日总额？`, '重置额度', { type: 'warning' }); } catch { return; }
  const r = await api.post('/api/dola/accounts/batch-reset-quota', { ids: selected.value.map((x) => x.id) });
  ElMessage.success(`已重置 ${r.updated} 个账号的额度`);
  load();
}

/** 批量分组 */
async function doBatchGroup() {
  if (!selected.value.length) return;
  groupBusy.value = true;
  try {
    const r = await api.post('/api/dola/accounts/batch-group', { ids: selected.value.map((x) => x.id), group: groupForm.group });
    ElMessage.success(`已更新 ${r.updated} 个账号的分组`);
    groupDlg.value = false;
    load();
  } finally { groupBusy.value = false; }
}

/** 单账号测试生成（对标 dola-pool「测试生成」）：打开弹窗选令牌 */
async function openTestGenerate(row) {
  testGenForm.id = row.id;
  testGenForm.label = primaryName(row);
  testGenForm.seconds = 10;
  testGenForm.prompt = '';
  testGenDlg.value = true;
  await loadTokenOptions();
  testGenForm.tokenId = tokenOptions.value?.[0]?.id ?? null;
}
async function doTestGenerate() {
  if (!testGenForm.tokenId) return ElMessage.warning('先选择用户令牌（测试生成走网关链路扣积分）');
  try {
    await ElMessageBox.confirm(
      `在账号「${testGenForm.label}」上提交一条 ${testGenForm.seconds} 秒测试生成？将消耗该账号的真实额度和令牌积分，且不触发限流自动换号。`,
      '测试生成', { type: 'warning' });
  } catch { return; }
  testGenBusy.value = true;
  try {
    const r = await api.post(`/api/dola/accounts/${testGenForm.id}/test-generate`, {
      tokenId: testGenForm.tokenId, seconds: testGenForm.seconds, prompt: testGenForm.prompt,
    });
    testGenDlg.value = false;
    ElMessage.success(`已提交测试任务 #${r.taskId}`);
    loadGeneration();
  } finally { testGenBusy.value = false; }
}

/** 压力测试（对标 dola-pool「压力测试」）：打开弹窗配数量 */
async function openStress() {
  stressForm.count = 5;
  stressForm.seconds = 10;
  stressForm.prompt = '';
  stressDlg.value = true;
  await loadTokenOptions();
  stressForm.tokenId = tokenOptions.value?.[0]?.id ?? null;
}
async function doStressTest() {
  if (!stressForm.tokenId) return ElMessage.warning('先选择用户令牌（压力测试走网关链路扣积分）');
  try {
    await ElMessageBox.confirm(
      `提交 ${stressForm.count} 条 ${stressForm.seconds} 秒压测任务？预计消耗令牌约 ${stressCost.value} 积分、号池约 ${stressForm.count} 条额度。`,
      '压力测试', { type: 'warning' });
  } catch { return; }
  stressBusy.value = true;
  try {
    const r = await api.post('/api/dola/stress-test', { ...stressForm });
    ElMessage.success(`压测提交完成：成功 ${r.okCount} / 失败 ${r.failCount}`);
    stressDlg.value = false;
    loadGeneration();
  } finally { stressBusy.value = false; }
}

/** 打开任务窗口并开始轮询 */
function openJob(job) {
  const version = ++jobPollVersion;
  activeJob.value = job;
  jobDlg.value = true;
  clearTimeout(pollTimer);
  if (isJobRunning(job)) {
    const poll = async () => {
      try {
        const r = await api.get(`/api/dola/jobs/${job.id}`, { silent: true });
        if (disposed || version !== jobPollVersion) return;
        activeJob.value = r.job;
        if (!isJobRunning(r.job)) {
          await Promise.allSettled([load({ silent: true }), loadJobs({ silent: true }), refreshProvider({ silent: true })]);
        }
      } catch { /* 临时失败后在下一轮重试 */ }
      finally {
        if (!disposed && version === jobPollVersion && isJobRunning(activeJob.value)) {
          pollTimer = setTimeout(poll, 1500);
        }
      }
    };
    poll();
  }
}

async function cancelJob(row) {
  await api.post(`/api/dola/jobs/${row.id}/cancel`);
  ElMessage.success('已取消');
  await Promise.allSettled([loadJobs(), refreshProvider(), load()]);
}

async function cancelGeneration(row) {
  try {
    await ElMessageBox.confirm(
      row.status === 'queued'
        ? '任务尚未提交到上游，取消后会按规则退回已扣积分。继续吗？'
        : '任务已经进入提交或生成阶段，取消后通常不会退款。继续吗？',
      '取消生成任务', { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '保留任务' },
    );
  } catch { return; }
  await api.post(`/api/dola/generation-tasks/${row.id}/cancel`);
  ElMessage.success('生成任务已取消');
  await Promise.allSettled([loadGeneration(), loadOperations(), refreshProvider()]);
}

function openSetCredits(row) {
  current.value = row;
  creditsInput.value = row.credits ?? 0;
  creditsDlg.value = true;
}

async function saveCredits() {
  saving.value = true;
  try {
    await api.post(`/api/dola/accounts/${current.value.id}/action`, { action: 'set_credits', credits: creditsInput.value });
    ElMessage.success('已保存');
    creditsDlg.value = false;
    load();
  } finally { saving.value = false; }
}

async function probe(row) {
  const res = await api.post(`/api/dola/accounts/${row.id}/probe`);
  probeResult.value = res;
  probeDlg.value = true;
}

async function probeNative(row, seconds) {
  nativeProbeResult.value = { label: row.label, seconds, state: 'unknown', message: '正在只读检查页面…' };
  nativeProbeDlg.value = true;
  try {
    const res = await api.post(`/api/dola/accounts/${row.id}/native-${seconds}s-probe`);
    nativeProbeResult.value = { ...res, label: row.label, seconds };
    await load({ silent: true });
  } catch (error) {
    nativeProbeResult.value = { label: row.label, seconds, state: 'unknown', message: error.message || '探测失败' };
  }
}

async function probeReferenceImages(row) {
  nativeProbeResult.value = { label: row.label, seconds: null, referenceImages: true, state: 'unknown', message: '正在只读检查页面上传控件…' };
  nativeProbeDlg.value = true;
  try {
    const res = await api.post(`/api/dola/accounts/${row.id}/reference-images-probe`);
    nativeProbeResult.value = { ...res, label: row.label, seconds: null, referenceImages: true };
    await load({ silent: true });
  } catch (error) {
    nativeProbeResult.value = { label: row.label, seconds: null, referenceImages: true, state: 'unknown', message: error.message || '探测失败' };
  }
}

async function reveal(row) {
  const res = await api.get(`/api/dola/accounts/${row.id}/reveal`);
  revealValue.value = res.cookie;
  revealDlg.value = true;
}

async function openConvert() {
  convertForm.basis = provider.value.settings?.convertBasis || 'account';
  convertForm.pointsPerAccount = provider.value.settings?.pointsPerAccount || 50;
  convertForm.ratio = provider.value.settings?.creditsPerPoint || 10;
  convertForm.scope = selected.value.length ? 'selected' : 'all';
  convertForm.tokenId = null;
  convertPreview.value = null;
  convertDlg.value = true;
  await loadTokenOptions();
}

async function doConvert(dryRun) {
  saving.value = true;
  try {
    const body = { basis: convertForm.basis, ratio: convertForm.ratio, pointsPerAccount: convertForm.pointsPerAccount, dryRun };
    if (convertForm.scope === 'selected') body.ids = selected.value.map((r) => r.id); else body.all = true;
    if (convertForm.tokenId) body.tokenId = convertForm.tokenId;
    const res = await api.post('/api/dola/convert', body);
    convertPreview.value = res;
    if (!dryRun) {
      ElMessage.success(`换算完成：${res.creditsUsed} 额度 → ${res.pointsGained} 积分`);
      load();
      loadConversions();
    }
  } finally { saving.value = false; }
}

async function pollProvider() {
  // 生成运行时需要更快看到队列变化；空闲时降低频率，避免不断刷新账号表。
  // refreshProvider 自带单飞锁，串行调度也避免慢请求堆积。
  await refreshProvider({ silent: true }).catch(() => {});
  if (tab.value === 'generation') await loadGeneration({ silent: true }).catch(() => {});
  if (tab.value === 'operations' || tab.value === 'ratelimit') await loadOperations({ silent: true }).catch(() => {});
  const generation = provider.value.generation || {};
  const busy = [generation.running, generation.queued, generation.reservedAccounts]
    .some((value) => Number(value) > 0);
  if (!busy) await load({ silent: true }).catch(() => {});
  if (!disposed) providerTimer = setTimeout(pollProvider, busy ? PROVIDER_BUSY_POLL_MS : PROVIDER_IDLE_POLL_MS);
}

onMounted(() => {
  load().catch(() => { /* 请求封装已显示错误 */ });
  refreshProvider().catch(() => { /* 请求封装已显示错误 */ });
  providerTimer = setTimeout(pollProvider, PROVIDER_IDLE_POLL_MS);
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(pollTimer);
  clearTimeout(providerTimer);
});
</script>

<style scoped>
.notice { margin-bottom: 14px; }
.notice-title { font-size: 13px; line-height: 1.7; }
.notice-toggle { margin-left: 8px; font-size: 12px; vertical-align: baseline; }
.notice-toggle :deep(.el-icon) { vertical-align: -2px; margin-left: 1px; }
.notice-body { font-size: 12px; line-height: 1.9; margin-top: 6px; }
.notice-body code { background: rgba(127, 127, 127, .18); padding: 1px 5px; border-radius: 4px; }
.maintenance-bar {
  display: flex; align-items: center; gap: 14px; justify-content: space-between;
  margin: -2px 0 14px; padding: 10px 14px;
  border: 1px solid var(--el-border-color-light); border-radius: 10px;
  background: var(--el-fill-color-blank);
}
.maintenance-copy { min-width: 0; }
.maintenance-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 13px; font-weight: 600; }
.maintenance-actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; flex-wrap: wrap; }
.maintenance-settings { margin-right: 8px; font-size: 12px; color: var(--el-color-primary); text-decoration: none; }
.maintenance-settings:hover { text-decoration: underline; }
@media (max-width: 900px) {
  .maintenance-bar { align-items: flex-start; flex-direction: column; gap: 8px; }
}
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.dot-on { background: var(--el-color-success); box-shadow: 0 0 0 3px rgba(103, 194, 58, .14); }
.dot-off { background: var(--el-color-info); }
.stats { margin-bottom: 14px; }
.proxy-alert-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.proxy-targets {
  width: 100%; max-height: 190px; overflow: auto; padding: 8px 10px;
  border: 1px solid var(--el-border-color-light); border-radius: 6px;
  background: var(--el-fill-color-lighter);
}
.proxy-target { display: block; margin: 0 0 7px; }
.proxy-target:last-child { margin-bottom: 0; }
.proxy-inline-input { margin-top: 8px; }
.proxy-mode-hint { margin-top: 6px; }
.proxy-results { max-height: 150px; overflow: auto; }
.ops-stats { margin-bottom: 14px; }
.ops-stat { min-height: 104px; }
.ops-panel { margin-bottom: 14px; }
.ops-source { margin-left: 10px; font-size: 12px; }
.ops-box { border: 1px solid var(--el-border-color-light); border-radius: 6px; padding: 12px 14px; margin-bottom: 14px; }
.ops-box-title, .ops-section-title { font-weight: 600; margin-bottom: 10px; }
.ops-section-title { margin-top: 16px; }
.ops-line { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter); font-size: 13px; }
.ops-line:last-child { border-bottom: 0; }
.limit-form { max-width: 980px; }
.danger-text { color: var(--el-color-danger); }
.stats :deep(.el-col) { display: flex; }
.stat {
  width: 100%;
  box-sizing: border-box;
  position: relative;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  padding: 12px 15px 13px;
  margin-bottom: 10px;
  overflow: hidden;
  transition: border-color .15s, transform .15s;
}
/* 顶部一条极细的色条，用统计项自己的颜色 —— 比整块染色克制，但一眼能分辨 */
.stat::before {
  content: ''; position: absolute; left: 0; top: 0; width: 100%; height: 2px;
  background: var(--accent); opacity: .75;
}
.stat:hover { border-color: var(--accent); transform: translateY(-1px); }
.label { font-size: 12px; color: var(--el-text-color-secondary); }
.num { font-size: 22px; font-weight: 700; line-height: 1.35; font-variant-numeric: tabular-nums; }
.sub { font-size: 11.5px; color: var(--el-text-color-secondary); opacity: .85; line-height: 1.5; }
/* 登录态未确认 = 该号已被排除在选号之外（不是"账号坏了"）。
   用 warning 而不是 danger：这是一种待复核的暂停态，不是终态失效。 */
.login-blocked { color: var(--el-color-warning); opacity: 1; font-weight: 600; }
.tabs :deep(.el-tabs__header) { margin-bottom: 14px; }
/* 固定操作列需要不透明底色，窄屏滚动时不能透出后面的说明文字。 */
:deep(.el-table .row-danger > td.el-table__cell) {
  background: color-mix(in srgb, var(--el-color-danger) 6%, var(--el-table-bg-color));
}
:deep(.el-table .row-warn > td.el-table__cell) {
  background: color-mix(in srgb, var(--el-color-warning) 6%, var(--el-table-bg-color));
}
:deep(.el-table .row-danger:hover > td.el-table__cell),
:deep(.el-table .row-warn:hover > td.el-table__cell) { background: var(--el-table-row-hover-bg-color); }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.filters, .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.spacer { flex: 1; min-width: 0; }
.pager { margin-top: 14px; justify-content: flex-end; }
.muted { color: var(--el-text-color-secondary); }
.tiny { font-size: 12px; }
.err { color: var(--el-color-danger); font-size: 12px; }
/* 中性提示（不是错误）：用次要色 + 小圆点，别跟真错误抢注意力 */
.note { color: var(--el-text-color-secondary); font-size: 12px; }
.note::before {
  content: ''; display: inline-block; width: 5px; height: 5px; border-radius: 50%;
  background: var(--el-color-warning); margin-right: 6px; vertical-align: 2px; opacity: .8;
}
.credits { font-weight: 600; color: #e6a23c; }
/* 颜色仅区分确认余额、确认零值和待确认。 */
.quota-ok { font-weight: 600; color: var(--el-color-success); }
.quota-pending { font-weight: 600; color: var(--el-color-warning); }
.quota-out { font-weight: 600; color: var(--el-color-danger); }
/* 补号提示横幅：紧贴工具栏上方，按钮右对齐 */
.replenish-banner { margin-bottom: 12px; }
.replenish-body { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.replenish-actions { display: inline-flex; gap: 8px; flex-shrink: 0; }
/* 号池统计行：满额/半额/可出条数 + 额度重置时区（对标 dola-pool 顶栏） */
.pool-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.stat-chips { display: inline-flex; gap: 8px; flex-wrap: wrap; }
.reset-line { font-size: 12px; }
/* 出口代理标识：小到不抢戏，但"直连"必须能一眼看见 */
.px-tag {
  display: inline-block; margin-left: 6px; padding: 0 5px;
  border-radius: 4px; font-size: 10.5px; line-height: 15px;
  font-family: inherit; vertical-align: 1px;
}
.px-ok { color: var(--el-color-success); background: rgba(103, 194, 58, .14); }
.px-none { color: var(--el-color-danger); background: rgba(245, 108, 108, .14); }
.points { font-weight: 600; color: #9b6eff; }
.ok { color: #67c23a; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.mono-box :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.hint { margin-left: 10px; font-size: 12px; color: var(--el-text-color-secondary); }
.tip { margin-bottom: 16px; }
.mt { margin-top: 10px; }
.mb { margin-bottom: 12px; }
.job-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.stats-inline { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--el-text-color-secondary); }
.hit { display: inline-block; margin-right: 8px; color: #e6a23c; }

/* ---- 表格内容排版 ---- */
.tag-row { display: inline-flex; align-items: center; gap: 5px; flex-wrap: nowrap; min-width: 0; }
/* 右对齐的单元格（额度/换算）里，主副两行也要右对齐 */
.cell-stack.align-end { align-items: flex-end; text-align: right; }
.cell-stack.align-end .main,
.cell-stack.align-end .sub { max-width: 100%; }
.clickable { cursor: pointer; }
.clickable:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.op-row { display: inline-flex; align-items: center; gap: 2px; flex-wrap: nowrap; }
/* 表格里的文字按钮：默认左右各 11px 内边距太占地方，操作列挤成两行 */
.op-row :deep(.el-button) { padding: 4px 6px; margin-left: 0; }
.op-row :deep(.el-dropdown) { line-height: 1; }
</style>
