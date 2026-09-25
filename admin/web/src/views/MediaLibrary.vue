<template>
  <div class="page">
    <!-- ═══════════ 顶部概况 ═══════════ -->
    <el-card shadow="never" class="mb">
      <div class="kpis">
        <div class="kpi"><b>{{ s.total }}</b><span>任务总数</span></div>
        <div class="kpi ok"><b>{{ s.ready }}</b><span>已完成成片</span></div>
        <div class="kpi uw"><b>{{ s.unwatermarked }}</b><span>无水印</span></div>
        <div class="kpi"><b>{{ s.archived }}</b><span>已归档到本地</span></div>
        <div class="kpi" :class="s.withUrlOnly ? 'warn' : 'mute'">
          <b>{{ s.withUrlOnly }}</b><span>只有直链、待抢存</span>
        </div>
        <el-divider direction="vertical" class="tall" />
        <div class="kpi"><b>{{ fmtBytes(s.bytes) }}</b><span>归档体积（库内合计）</span></div>
        <div class="kpi mute"><b>{{ fmtBytes(s.diskBytes) }}</b><span>磁盘实际占用</span></div>
      </div>

      <!-- 两个真正需要人处理的状态，直接顶到最上面，不要藏在表格里 -->
      <div v-if="s.withUrlOnly" class="callout warn">
        <el-icon><Warning /></el-icon>
        <span>
          有 <b>{{ s.withUrlOnly }}</b> 条成片只存了直链、没归档到本地。
          <b>上游直链是带签名的临时链接，几小时到几天后就会 403</b> —— 现在不抢存，过几天就永久拿不回来了。
          <el-button
            v-if="can('dola:check')"
            size="small"
            type="warning"
            plain
            :loading="archivingAll"
            @click="archiveAllPending"
          >
            一键抢存这 {{ s.withUrlOnly }} 条
          </el-button>
        </span>
      </div>
      <div v-if="lostOnPage" class="callout bad">
        <el-icon><Warning /></el-icon>
        <span>
          本页有 <b>{{ lostOnPage }}</b> 条记录标着「已归档」，但<b>文件在磁盘上已经不在了</b>。
          这是需要立刻查的事（别是磁盘满了或被清理任务误删）。它们可以点「重新抢存」救回来 —— 前提是直链还没过期。
        </span>
      </div>
    </el-card>

    <el-tabs v-model="tab" class="mb">
      <!-- ═══════════ 成片库 ═══════════ -->
      <el-tab-pane label="成片库" name="library">
        <el-card shadow="never">
          <div class="toolbar">
            <el-select v-model="q.status" placeholder="全部状态" clearable style="width: 130px" @change="reload">
              <el-option label="已完成" value="ready" />
              <el-option label="生成中" value="generating" />
              <el-option label="失败" value="failed" />
              <el-option label="已取消" value="cancelled" />
            </el-select>
            <el-select v-model="q.archived" placeholder="归档情况" clearable style="width: 140px" @change="reload">
              <el-option label="已归档" value="1" />
              <el-option label="仅直链（待抢存）" value="0" />
            </el-select>
            <el-checkbox v-model="q.unwatermarked" label="只看无水印" border @change="reload" />
            <el-input
              v-model="q.q"
              placeholder="搜提示词"
              clearable
              style="width: 200px"
              @keyup.enter="reload"
              @clear="reload"
            />
            <el-button :icon="Search" @click="reload">查询</el-button>
            <div class="spacer" />
            <span class="muted">共 {{ total }} 条</span>
            <el-button :icon="Refresh" :loading="loading" @click="reload">刷新</el-button>
          </div>

          <el-table :data="rows" v-loading="loading" border stripe>
            <el-table-column prop="id" label="ID" width="66" />
            <el-table-column label="水印" width="86">
              <template #default="{ row }">
                <el-tag v-if="row.isUnwatermarked" size="small" type="success" effect="dark">无水印</el-tag>
                <el-tag v-else size="small" type="info" effect="plain">带水印</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="提示词" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <span>{{ row.prompt || '—' }}{{ row.promptTruncated ? '…' : '' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="accountLabel" label="账号" width="110" show-overflow-tooltip />
            <el-table-column label="时长" width="70">
              <template #default="{ row }">{{ row.seconds ?? '—' }}s</template>
            </el-table-column>
            <el-table-column label="体积" width="86">
              <template #default="{ row }">{{ fmtBytes(row.bytes) }}</template>
            </el-table-column>
            <el-table-column label="归档" width="120">
              <template #default="{ row }">
                <el-tag v-if="row.lost" size="small" type="danger">⚠️ 文件丢失</el-tag>
                <el-tag v-else-if="row.onDisk" size="small" type="success" effect="plain">已归档</el-tag>
                <el-tag v-else-if="row.recoverable" size="small" type="warning" effect="plain">仅直链</el-tag>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="直链" width="86">
              <template #default="{ row }">
                <el-button
                  v-if="row.unwatermarkedUrl || row.watermarkedUrl"
                  size="small"
                  text
                  :icon="CopyDocument"
                  @click="copy(row.unwatermarkedUrl || row.watermarkedUrl)"
                >
                  {{ row.unwatermarkedUrl ? '无水印' : '带水印' }}
                </el-button>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="94">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="196" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.onDisk" size="small" text type="primary" :icon="VideoPlay" @click="preview(row)">
                  预览
                </el-button>
                <el-button
                  v-if="row.onDisk"
                  size="small"
                  text
                  type="primary"
                  :icon="Download"
                  @click="startDownload(row, 'download')"
                >下载</el-button>
                <el-button
                  v-else-if="row.recoverable"
                  size="small"
                  text
                  type="warning"
                  :loading="busy === 'save-' + row.id"
                  :icon="Download"
                  @click="startDownload(row, 'refresh')"
                >抢存并下载</el-button>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="还没有成片。可以到「会话成片」把已有的会话补录进来" :image-size="80" />
            </template>
          </el-table>

          <div class="pager">
            <el-pagination
              layout="prev, pager, next, total"
              :total="total"
              :page-size="q.limit"
              :current-page="page"
              @current-change="onPage"
            />
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ═══════════ 会话成片 ═══════════ -->
      <el-tab-pane label="会话成片" name="conversation">
        <el-card shadow="never" class="mb">
          <div class="toolbar">
            <el-select v-model="scan.accountId" placeholder="选择账号" filterable style="width: 220px">
              <el-option
                v-for="a in accounts"
                :key="a.id"
                :label="`#${a.id} ${a.label}${a.cooling ? '（冷却中）' : ''}`"
                :value="a.id"
              >
                <span>#{{ a.id }} {{ a.label }}</span>
                <span class="opt-note">
                  {{ a.status }}
                  <em v-if="!a.hasProxy" class="warn-text"> · 无代理</em>
                  <em v-else> · 代理</em>
                </span>
              </el-option>
            </el-select>
            <el-input
              v-model="scan.conversationId"
              placeholder="会话 id，例如 3841784424698385"
              clearable
              style="width: 300px"
              @keyup.enter="doScan"
            />
            <el-button
              v-if="can('dola:check')"
              type="primary"
              :icon="Search"
              :loading="scanning"
              @click="doScan"
            >扫描</el-button>
            <span v-else class="muted">需要「批量校验账号」权限才能扫描会话</span>
            <div class="spacer" />
            <span class="muted">只读：不写库、不消耗生成额度</span>
          </div>
          <div class="cell-sub">
            会话 id 就是 dola 地址栏里 <code>/chat/</code> 后面那一串。
            <b>扫描只是把会话里已有的成片列出来</b>，不会重新生成 —— 所以账号额度烧完了也能用，
            这也是「不花额度验证整条链路」的手段。
          </div>
        </el-card>

        <el-card v-if="scanResult" shadow="never">
          <el-alert
            v-if="scanResult.note"
            type="warning"
            :closable="false"
            show-icon
            :title="scanResult.note"
            class="mb"
          />

          <div class="kpis mb">
            <div class="kpi"><b>{{ scanResult.count }}</b><span>会话内成片</span></div>
            <div class="kpi uw"><b>{{ scanResult.unwatermarkedCount }}</b><span>解析出无水印</span></div>
            <div class="kpi" :class="scanResult.usedProxy ? 'ok' : 'warn'">
              <b>{{ scanResult.usedProxy ? '是' : '否' }}</b><span>经账号自己的代理读取</span>
            </div>
            <div class="kpi" :class="ticketLeftSec > 30 ? 'mute' : 'warn'">
              <b>{{ ticketLeftSec }}s</b><span>扫描凭证有效期</span>
            </div>
          </div>

          <el-table ref="scanTableRef" :data="scanResult.items" border stripe @selection-change="onSelect">
            <el-table-column type="selection" width="46" :selectable="(row) => !row.alreadyImported" />
            <el-table-column prop="label" label="成片" width="82" />
            <el-table-column label="无水印" width="94">
              <template #default="{ row }">
                <el-tag v-if="row.unwatermarkedPreview" size="small" type="success" effect="dark">有</el-tag>
                <el-tag v-else size="small" type="warning" effect="plain">只有带水印</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="无水印直链" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <template v-if="row.unwatermarkedUrl">
                  <el-button size="small" text type="primary" :icon="CopyDocument" @click="copy(row.unwatermarkedUrl)">
                    复制
                  </el-button>
                  <span class="mono cell-sub">{{ row.unwatermarkedPreview }}</span>
                </template>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="带水印直链" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <template v-if="row.watermarkedUrl">
                  <el-button size="small" text :icon="CopyDocument" @click="copy(row.watermarkedUrl)">复制</el-button>
                  <span class="mono cell-sub">{{ row.watermarkedPreview }}</span>
                </template>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="tokenForm" label="取回方式" width="100" />
            <el-table-column label="是否已补录" width="120">
              <template #default="{ row }">
                <el-tag v-if="row.alreadyImported" size="small" type="info" effect="plain">已存在</el-tag>
                <span v-else class="muted">未录入</span>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="这个会话里没找到成片" :image-size="70" />
            </template>
          </el-table>

          <div class="callout info mt">
            <span>
              直链<b>明文给出</b>（后台是运营侧，本来就允许绕开用户面的计费 —— 计费边界在网关那边）。
              但有个必须记住的事：<b>这些链接带签名，几小时到几天就会过期</b>（URL 里的 <code>dy_q</code> 就是这个时间）。
              要长期可用，一定要勾选下面的「同时归档到本地」再补录。
            </span>
          </div>

          <div v-if="scanResult.attempts && scanResult.attempts.length" class="mt">
            <div class="cell-main">无水印解析明细</div>
            <div v-for="(a, i) in scanResult.attempts" :key="i" class="attempt">
              <el-tag size="small" :type="a.ok ? 'success' : 'danger'">{{ a.ok ? '成功' : '失败' }}</el-tag>
              <span class="mono cell-sub">{{ a.api }}</span>
              <span v-if="!a.ok" class="cell-sub">→ {{ a.reason || '未知原因' }}{{ a.http ? ` (HTTP ${a.http})` : '' }}</span>
            </div>
          </div>

          <el-divider />

          <div class="toolbar">
            <el-input v-model="imp.prompt" placeholder="提示词（可选，便于日后检索）" clearable style="width: 260px" />
            <el-select v-model="imp.seconds" style="width: 116px">
              <el-option v-for="n in [5, 10, 15, 30, 60]" :key="n" :label="`${n} 秒`" :value="n" />
            </el-select>
            <el-select v-model="imp.ratio" style="width: 110px">
              <el-option label="16:9" value="16:9" />
              <el-option label="9:16" value="9:16" />
              <el-option label="1:1" value="1:1" />
            </el-select>
            <el-select v-model="imp.ownerTokenId" placeholder="归属令牌（可选）" clearable style="width: 200px">
              <el-option v-for="t in tokens" :key="t.id" :label="`${t.prefix} ${t.name || ''}`.trim()" :value="t.id" />
            </el-select>
            <el-checkbox v-model="imp.archive" label="同时归档到本地" border />
            <div class="spacer" />
            <span class="muted">已选 {{ selected.length }} 条</span>
            <el-button
              v-if="can('dola:create')"
              type="primary"
              :disabled="!selected.length"
              :loading="importing"
              @click="doImport"
            >补录入库</el-button>
            <span v-else class="muted">需要「创建生成任务」权限才能补录</span>
          </div>
          <div class="cell-sub">
            「同时归档到本地」默认勾上 —— <b>不归档就等于只留了个会过期的死链</b>。
            归好档之后，用户工作台的下载接口也能直接取到这条成片。
          </div>

          <div v-if="importResult" class="mt">
            <el-divider />
            <div class="cell-main mb">补录结果</div>
            <div v-for="(r, i) in importResult.results" :key="i" class="attempt">
              <el-tag size="small" :type="r.status === 'imported' ? 'success' : (r.status === 'duplicate' ? 'info' : 'danger')">
                {{ r.status === 'imported' ? '已补录' : (r.status === 'duplicate' ? '已存在' : '跳过') }}
              </el-tag>
              <span>{{ r.message }}</span>
            </div>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- ═══════════ 预览 ═══════════ -->
    <el-dialog v-model="dlgPreview" :title="previewTitle" width="760px" destroy-on-close @close="previewUrl = ''">
      <video
        v-if="previewUrl"
        :src="previewUrl"
        controls
        autoplay
        style="width: 100%; max-height: 62vh; background: #000; border-radius: 8px"
        @error="previewFailed = true"
      />
      <el-alert
        v-if="previewFailed"
        type="error"
        :closable="false"
        class="mt"
        title="视频加载失败。多半是播放凭证过期了（只有 2 分钟有效），关掉重开一次即可。"
      />
      <template #footer>
        <span class="cell-sub">凭证 2 分钟有效；过期后重新打开本弹窗会自动换新的。</span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name
defineOptions({ name: 'MediaLibrary' });

import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue';
import { CopyDocument, Download, Refresh, Search, VideoPlay, Warning } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api, qs } from '../api.js';
import { can } from '../store.js';

const tab = ref('library');
const loading = ref(false);
const busy = ref('');

const s = ref({ total: 0, ready: 0, unwatermarked: 0, archived: 0, withUrlOnly: 0, bytes: 0, diskBytes: 0 });
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const q = reactive({ status: '', archived: '', unwatermarked: false, q: '', limit: 50 });

/** 「库里记着有归档、磁盘上没了」——这个维度只能逐行看文件系统，所以只统计当前页并明确标注 */
const lostOnPage = computed(() => rows.value.filter((r) => r.lost).length);

// ── 会话成片 ──
const accounts = ref([]);
const tokens = ref([]);
const scan = reactive({ accountId: null, conversationId: '' });
const scanning = ref(false);
const scanResult = ref(null);
const scanTableRef = ref(null);
const selected = ref([]);
const importing = ref(false);
const importResult = ref(null);
const imp = reactive({ prompt: '', seconds: 10, ratio: '16:9', ownerTokenId: null, archive: true });

/**
 * 扫描凭证倒计时。
 *
 * ⚠️ 用**截止时刻**算剩余秒数，不要用「每秒减一」的累计变量。两个原因：
 *   ① 这个页面在 keep-alive 白名单里，切走再切回**不会重新挂载** ——
 *      累计变量在页面被隐藏时如果停了定时器就会停在旧值，
 *      回来时显示「还有 400 秒」而实际凭证早过期了，点补录才莫名报错。
 *   ② 系统休眠/后台标签页节流会让 setInterval 少跑很多次，累计值必然偏大。
 * 死线是服务端说了算，客户端只负责显示 —— 这样两边口径永远一致。
 */
const ticketDeadlineMs = ref(0);
const ticketLeftSec = ref(0);
let ticketTimer = null;

function tickTicket() {
  const left = Math.max(0, Math.ceil((ticketDeadlineMs.value - Date.now()) / 1000));
  ticketLeftSec.value = left;
  // 倒到 0 就停掉定时器，别让它在后台白跑
  if (left <= 0) stopTicketTimer();
}

function stopTicketTimer() {
  if (ticketTimer) { clearInterval(ticketTimer); ticketTimer = null; }
}

/** 只在**页面可见**时跑定时器：keep-alive 缓存期间没必要每秒醒一次。 */
function syncTicketTimer() {
  stopTicketTimer();
  if (ticketDeadlineMs.value > Date.now()) {
    tickTicket();
    ticketTimer = setInterval(tickTicket, 1000);
  } else {
    ticketLeftSec.value = 0;
  }
}

// ── 预览 ──
const dlgPreview = ref(false);
const previewUrl = ref('');
const previewTitle = ref('');
const previewFailed = ref(false);

const archivingAll = ref(false);

const STATUS_MAP = {
  ready: ['已完成', 'success'],
  generating: ['生成中', 'primary'],
  submitting: ['提交中', 'primary'],
  resolving: ['解析中', 'primary'],
  queued: ['排队中', 'info'],
  failed: ['失败', 'danger'],
  cancelled: ['已取消', 'info'],
};
const statusLabel = (v) => STATUS_MAP[v]?.[0] || v || '—';
const statusType = (v) => STATUS_MAP[v]?.[1] || 'info';

function fmt(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('zh-CN', { hour12: false });
  } catch { return String(v); }
}

function fmtBytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/**
 * 复制直链。
 *
 * `navigator.clipboard` 只在 https / localhost 下可用 —— 后台常常是
 * `http://<内网IP>:8788` 直连，那时它是 undefined，**而且失败是静默的**
 * （不抛错、也不报错，用户以为复制成功了）。所以必须留 textarea 兜底。
 */
async function copy(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return ElMessage.success('直链已复制');
    }
    throw new Error('clipboard unavailable');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return ElMessage.success('直链已复制');
      ElMessage.warning('浏览器不允许自动复制，已把链接打出来，请手动选。');
      window.prompt('复制这个直链：', text);
    } catch {
      window.prompt('复制这个直链：', text);
    }
  }
}

// ─────────────────────────── 数据加载 ───────────────────────────

async function loadStats() {
  try {
    s.value = await api.get('/api/media/stats');
  } catch { /* api 层已经弹过错误了 */ }
}

async function loadLibrary() {
  loading.value = true;
  try {
    const data = await api.get(`/api/media/library${qs({
      status: q.status,
      archived: q.archived,
      unwatermarked: q.unwatermarked ? '1' : '',
      q: q.q,
      limit: q.limit,
      offset: (page.value - 1) * q.limit,
    })}`);
    rows.value = data.items || [];
    total.value = data.total || 0;
  } catch { rows.value = []; } finally { loading.value = false; }
}

function reload() {
  page.value = 1;
  loadLibrary();
}

function onPage(p) {
  page.value = p;
  loadLibrary();
}

async function loadAccounts() {
  try {
    const d = await api.get('/api/media/accounts');
    accounts.value = d.items || [];
  } catch { accounts.value = []; }
}

async function loadTokens() {
  try {
    const d = await api.get('/api/media/tokens');
    tokens.value = d.items || [];
  } catch { tokens.value = []; }
}

// ─────────────────────────── 播放 / 下载 ───────────────────────────

/**
 * 换一张播放凭证。
 *
 * 为什么不让浏览器直接带 JWT 去取：`<video src>` / `<a href>` **没法自定义请求头**，
 * 而后台 JWT 是 12 小时的全权限凭据，塞进 URL 会落进访问日志和浏览器历史。
 * 所以走「先换 2 分钟凭证、再用凭证流」这条路。
 */
async function ticketFor(id) {
  return api.post(`/api/media/library/${id}/ticket`, {});
}

async function startDownload(row, mode) {
  busy.value = `${mode === 'refresh' ? 'save' : 'dl'}-${row.id}`;
  try {
    const t = await ticketFor(row.id);
    const url = mode === 'refresh' ? t.refreshUrl : t.downloadUrl;
    // 服务端会带 Content-Disposition，浏览器直接存盘，不需要 a.download
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    ElMessage.success(mode === 'refresh' ? '已开始抢存并下载，归档完成后就能秒下' : '已开始下载');
    if (mode === 'refresh') {
      // 抢存是服务端同步做的，给它一点时间再刷新，否则状态还是旧的
      setTimeout(() => { loadLibrary(); loadStats(); }, 2500);
    }
  } catch (e) {
    if (e?.status !== 0) ElMessage.error(e.message || '下载失败');
  } finally { busy.value = ''; }
}

async function preview(row) {
  previewFailed.value = false;
  previewTitle.value = `预览 · 任务 #${row.id}${row.isUnwatermarked ? '（无水印）' : ''}`;
  try {
    const t = await ticketFor(row.id);
    previewUrl.value = t.streamUrl;
    dlgPreview.value = true;
  } catch { /* api 已提示 */ }
}

/** 一键抢存所有「只有直链」的成片。逐条来，别并发 —— 每条几十 MB，并发会把出口打满。 */
async function archiveAllPending() {
  archivingAll.value = true;
  let ok = 0; let gone = 0; let fail = 0;
  try {
    const list = await api.get(`/api/media/library${qs({ archived: '0', limit: 200 })}`);
    const targets = (list.items || []).filter((r) => r.recoverable);
    if (!targets.length) { ElMessage.info('没有需要抢存的成片'); return; }
    for (const r of targets) {
      try {
        await api.post(`/api/media/library/${r.id}/archive`, {});
        ok++;
      } catch (e) {
        // 「直链过期」和「网络抖动」要分开报 —— 前者重试没用，后者值得再点一次
        if (e?.message && e.message.includes('已过期')) gone++; else fail++;
      }
    }
    ElMessage.success(`抢存完成：成功 ${ok} 条${gone ? `，直链已过期 ${gone} 条` : ''}${fail ? `，失败 ${fail} 条` : ''}`);
    loadLibrary();
    loadStats();
  } catch (e) {
    ElMessage.error(e.message || '抢存失败');
  } finally { archivingAll.value = false; }
}

// ─────────────────────────── 扫描会话 ───────────────────────────

async function doScan() {
  if (!scan.accountId) return ElMessage.warning('先选一个账号');
  if (!scan.conversationId.trim()) return ElMessage.warning('填一下会话 id');
  scanning.value = true;
  scanResult.value = null;
  importResult.value = null;
  selected.value = [];
  try {
    const d = await api.post('/api/media/conversation/scan', {
      accountId: scan.accountId,
      conversationId: scan.conversationId.trim(),
    });
    scanResult.value = d;
    // 死线由服务端给（expirySec），不硬编码 —— 服务端改 TTL 时前端自动跟上
    ticketDeadlineMs.value = Date.now() + (Number(d.expirySec) || 0) * 1000;
    syncTicketTimer();
    // 默认勾上「还没补录过」的，已存在的自动排除 —— 避免手滑重复录
    setTimeout(() => {
      const t = scanTableRef.value;
      if (!t) return;
      for (const row of d.items || []) {
        if (!row.alreadyImported) t.toggleRowSelection(row, true);
      }
    }, 80);
  } catch (e) {
    if (e?.status !== 0) ElMessage.error(e.message || '扫描失败');
  } finally { scanning.value = false; }
}

function onSelect(v) {
  selected.value = v || [];
}

async function doImport() {
  if (!scanResult.value?.ticket) return ElMessage.warning('凭证已失效，请重新扫描');
  if (ticketLeftSec.value <= 0) return ElMessage.warning('扫描凭证已过期（10 分钟），请重新扫描一次');
  importing.value = true;
  try {
    const d = await api.post('/api/media/conversation/import', {
      ticket: scanResult.value.ticket,
      indexes: selected.value.map((r) => r.index),
      prompt: imp.prompt,
      seconds: imp.seconds,
      ratio: imp.ratio,
      ownerTokenId: imp.ownerTokenId || undefined,
      archive: imp.archive,
    });
    importResult.value = d;

    // 不要清掉 scanResult：清了就把结果清单一起藏了，操作员看不到「哪条成功、哪条已存在」。
    // 改成把已补录的标上，顺手清空勾选 —— 表里状态和实际库状态就一致了。
    const importedIdx = new Set((d.results || []).filter((r) => r.status === 'imported' || r.status === 'duplicate').map((r) => r.index));
    scanResult.value.items = (scanResult.value.items || []).map((it) => (
      importedIdx.has(it.index) ? { ...it, alreadyImported: true } : it
    ));
    selected.value = [];
    scanTableRef.value?.clearSelection();

    ElMessage.success(`补录完成：新增 ${d.imported} 条${d.duplicate ? `，已存在 ${d.duplicate} 条` : ''}`);
    loadLibrary();
    loadStats();
  } catch (e) {
    if (e?.status !== 0) ElMessage.error(e.message || '补录失败');
  } finally { importing.value = false; }
}

onMounted(() => {
  loadStats();
  loadLibrary();
  loadAccounts();
  loadTokens();
});

/**
 * 本页在 keep-alive 白名单里（切菜单不丢扫描结果 —— 扫描是唯一有出站成本的动作，
 * 每次切回来都重扫一遍很浪费）。代价是**必须自己管定时器**：
 * keep-alive 缓存时不会触发 onBeforeUnmount，只触发 onDeactivated。
 * 只在可见时跑 tick，隐藏时停掉；回来时立刻用死线重算一次，显示的秒数永远是真的。
 */
onActivated(syncTicketTimer);
onDeactivated(stopTicketTimer);
onBeforeUnmount(stopTicketTimer);
</script>

<style scoped>
.page { padding: 0; }
.mb { margin-bottom: 12px; }
.mt { margin-top: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.spacer { flex: 1; }
.tall { height: 34px; }
.muted { opacity: 0.6; font-size: 12.5px; }

.kpis { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.kpi { display: flex; flex-direction: column; line-height: 1.25; }
.kpi b { font-size: 22px; font-weight: 650; }
.kpi span { font-size: 12px; opacity: 0.62; }
.kpi.ok b { color: var(--el-color-success); }
.kpi.warn b { color: var(--el-color-warning); }
.kpi.mute b { opacity: 0.55; }
/* 无水印是本页的主角色，给它一个固定的强调色 —— 注意带兜底值，
   取不到变量时静默失效会变成黑字，反而看不出重点 */
.kpi.uw b { color: var(--el-color-success, #67c23a); }

.warn-text { color: var(--el-color-warning); font-style: normal; }

.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.cell-main { font-weight: 550; }
.cell-sub { font-size: 11.5px; opacity: 0.65; line-height: 1.6; }

.opt-note { float: right; font-size: 11.5px; opacity: 0.6; margin-left: 14px; }

.callout {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.7;
  border-left: 3px solid transparent; margin-top: 12px;
}
.callout.warn { background: var(--el-color-warning-light-9, #fdf6ec); border-left-color: var(--el-color-warning, #e6a23c); }
.callout.bad { background: var(--el-color-danger-light-9, #fef0f0); border-left-color: var(--el-color-danger, #f56c6c); }
.callout.info { background: var(--el-fill-color-light, #f5f7fa); border-left-color: var(--el-color-primary, #409eff); }
.callout .el-button { margin-left: 8px; }

.attempt { display: flex; align-items: center; gap: 8px; padding: 3px 0; flex-wrap: wrap; }

.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
