<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-input v-model="keyword" placeholder="搜索名称或标签" clearable style="width: 240px" @keyup.enter="load(1)" @clear="load(1)">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="source" style="width: 150px" @change="load(1)">
          <el-option label="全部来源" value="" />
          <el-option label="后台上传" value="upload" />
          <el-option label="粘贴直链" value="url" />
          <el-option label="分镜图收录" value="shot" />
          <el-option label="素材转存" value="material" />
        </el-select>
        <el-button :icon="Search" @click="load(1)">搜索</el-button>
        <el-button :icon="Refresh" @click="reload">刷新</el-button>
        <div class="spacer" />
        <span class="muted">共 {{ total }} 张 · 占用 {{ mb(diskBytes) }}</span>
        <el-button v-if="can('refimage:create')" @click="openUrlDlg">从直链收图</el-button>
        <el-upload
          v-if="can('refimage:create')"
          :show-file-list="false"
          :before-upload="onUpload"
          accept="image/png,image/jpeg,image/gif"
          multiple
        >
          <el-button type="primary" :icon="Upload">上传图片</el-button>
        </el-upload>
      </div>

      <el-alert type="info" :closable="false" class="tip">
        <template #title>这个图库是「主工作台」和「脚本分镜页」共用的参考图来源</template>
        <div class="notice-body">
          分镜页每出一次图，<b>那 4 张会自动收进这里</b>（标签 <code>自动收录</code>）——
          因为分镜图出在上游 CDN 的临时签名直链上，不趁热抓下来，过几天链接就失效了。<br>
          同样的图只留一条记录（按内容 sha256 去重）。单张上限 8 MB，仅支持 JPG / PNG / GIF（GIF 会自动取首帧）。
        </div>
      </el-alert>

      <div v-loading="loading" class="ref-wall">
        <el-empty v-if="!loading && !items.length" description="图库里还没有图" :image-size="80" />
        <div v-for="r in items" :key="r.id" class="ref-card">
          <div class="cover">
            <el-image :src="thumbSrc(r)" fit="contain" :preview-src-list="[imgSrc(r)]" preview-teleported lazy />
            <el-tag size="small" class="src-tag" :type="sourceTone(r.source)">{{ sourceLabel(r.source) }}</el-tag>
          </div>
          <div class="body">
            <div class="name" :title="r.name">{{ r.name || `参考图 #${r.id}` }}</div>
            <div class="meta muted">
              {{ r.width }}×{{ r.height }} · {{ kb(r.bytes) }}
              <template v-if="r.useCount"> · 用过 {{ r.useCount }} 次</template>
            </div>
            <div v-if="r.tags" class="tags">
              <el-tag v-for="t in tagList(r)" :key="t" size="small" type="info" effect="plain">{{ t }}</el-tag>
            </div>
            <div class="meta muted">#{{ r.id }} · {{ fmt(r.createdAt) }}</div>
          </div>
          <div class="actions">
            <el-button v-if="can('refimage:update')" size="small" text type="primary" @click="openRename(r)">改名/标签</el-button>
            <el-button size="small" text type="primary" @click="copyUrl(r)">复制地址</el-button>
            <el-button size="small" text type="primary" @click="download(r)">下载</el-button>
            <el-button v-if="can('refimage:delete')" size="small" text type="danger" @click="remove(r)">删除</el-button>
          </div>
        </div>
      </div>

      <el-pagination
        v-if="total > pageSize"
        class="pager"
        layout="prev, pager, next, total"
        :total="total"
        :page-size="pageSize"
        :current-page="page"
        @current-change="load"
      />
    </el-card>

    <!-- ============ 从直链收图 ============ -->
    <el-dialog v-model="urlDlg" title="从直链收进参考图库" width="620px" :close-on-click-modal="false">
      <el-alert type="warning" :closable="false" show-icon class="tip">
        <template #title>为什么必须「收进来」而不是直接引用直链</template>
        <div class="notice-body">
          分镜图、成片封面这类直链**带签名会过期**（几小时到几天）。收进图库 = 字节存到本机，
          从此不再依赖上游。每行一个地址，单张上限 8 MB。
        </div>
      </el-alert>
      <el-input v-model="urlRaw" type="textarea" :rows="6" class="mono-box"
        placeholder="https://.../image.png&#10;https://.../another.jpg" />
      <el-input v-model="urlName" placeholder="名称前缀（可选，例如：角色定妆）" class="mt" />
      <el-alert v-if="urlResult" :type="urlResult.failed ? 'warning' : 'success'" :closable="false" class="mt">
        <template #title>成功 {{ urlResult.ok }} 张，失败 {{ urlResult.failed }} 张</template>
        <div v-if="urlResult.problems?.length" class="notice-body">
          <div v-for="(p, i) in urlResult.problems" :key="i">· {{ p }}</div>
        </div>
      </el-alert>
      <template #footer>
        <el-button @click="urlDlg = false">关闭</el-button>
        <el-button type="primary" :loading="saving" @click="doUrlImport">开始收图</el-button>
      </template>
    </el-dialog>

    <!-- ============ 改名 / 标签 ============ -->
    <el-dialog v-model="renameDlg" title="修改参考图信息" width="480px">
      <el-form label-width="70px">
        <el-form-item label="名称">
          <el-input v-model="renameForm.name" maxlength="120" placeholder="例如：女主定妆" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="renameForm.tags" maxlength="300" placeholder="逗号分隔，例如：角色,定妆" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="renameDlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doRename">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'ReferenceImages' });
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, Search, Upload } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const total = ref(0);
const diskBytes = ref(0);
const page = ref(1);
const pageSize = ref(24);
const keyword = ref('');
const source = ref('');
const loading = ref(false);
const saving = ref(false);

/**
 * 图片地址必须走**短期凭证通道**（`<img>` 没法带 Authorization 头）。
 * 凭证 10 分钟有效、覆盖整个图库，所以一次 load 换一张就够。
 * 与成片库 `/api/media/stream/:ticket` 同一套做法（理由见 server/media-routes.js 的文件头）。
 */
const streamBase = ref('');

const urlDlg = ref(false);
const urlRaw = ref('');
const urlName = ref('');
const urlResult = ref(null);

const renameDlg = ref(false);
const renaming = ref(null);
const renameForm = reactive({ name: '', tags: '' });

const SOURCE_LABEL = { upload: '上传', url: '直链', shot: '分镜图', material: '素材' };
const SOURCE_TONE = { upload: 'primary', url: 'warning', shot: 'success', material: 'info' };
const sourceLabel = (s) => SOURCE_LABEL[s] || s || '上传';
const sourceTone = (s) => SOURCE_TONE[s] || 'info';

function fmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
}
const kb = (n) => (Number(n) ? `${(Number(n) / 1024).toFixed(0)} KB` : '—');
const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;
const tagList = (r) => String(r.tags || '').split(/[,，\s]+/).filter(Boolean);
const imgSrc = (r) => (streamBase.value ? `${streamBase.value}/${r.id}` : '');

/**
 * 卡片封面用**缩略图**（`?w=` 让服务端现生成并落盘缓存）。
 *
 * ⚠️ 别改回原图：库图原图 1.8–5.2MB，而这排卡片的展示位只有几十像素。直铺原图时
 * 首屏是「十四个卡片里十三个是空框」（原图还在下载），看起来像图库是空的
 * —— 2026-09-29 拿到用户反馈「怎么还是空的」，实测就是这么来的（整页 57MB）。
 * 点开看大图（preview-src-list）仍然用原图：那一步要的是清晰度。
 */
const thumbSrc = (r) => (streamBase.value ? `${streamBase.value}/${r.id}?w=256` : '');

async function ensureTicket() {
  const res = await api.post('/api/reference-images/ticket', {}, { silent: true });
  streamBase.value = res.streamBase || '';
}

async function load(p = 1) {
  page.value = p;
  loading.value = true;
  try {
    // 凭证和图列表一起刷：凭证过期会让整页缩略图变成碎图，重发一次即可。
    await ensureTicket();
    const res = await api.get('/api/reference-images' + qs({
      keyword: keyword.value.trim(), source: source.value, page: p, pageSize: pageSize.value,
    }), { silent: true });
    items.value = res.items || [];
    total.value = res.total || 0;
    diskBytes.value = res.diskBytes || 0;
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function reload() {
  await load(page.value);
  ElMessage.success('已刷新（含读取凭证）');
}

async function onUpload(file) {
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.error(`${file.name}：单张不能超过 8 MB`);
    return false;
  }
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const res = await api.post('/api/reference-images', {
      name: file.name.replace(/\.[^.]+$/, ''),
      filename: file.name,
      dataBase64,
    });
    ElMessage.success(res.message || '已收进图库');
    await load(1);
  } catch (e) {
    ElMessage.error(e.message || '上传失败');
  }
  return false; // 阻止 el-upload 自动上传，纯本地处理
}

function openUrlDlg() {
  urlRaw.value = '';
  urlName.value = '';
  urlResult.value = null;
  urlDlg.value = true;
}

async function doUrlImport() {
  const urls = urlRaw.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!urls.length) {
    ElMessage.error('请先粘贴图片直链，每行一个');
    return;
  }
  saving.value = true;
  const result = { ok: 0, failed: 0, problems: [] };
  try {
    // 逐条串行：一条失败不影响后面的，且要让用户看到**具体哪条**失败、为什么。
    for (const [i, url] of urls.entries()) {
      try {
        const res = await api.post('/api/reference-images/from-url', {
          url,
          name: urls.length > 1 ? `${urlName.value || '直链图'} ${i + 1}` : (urlName.value || ''),
        }, { silent: true });
        result.ok += 1;
        if (res.duplicated) result.problems.push(`第 ${i + 1} 条：已在图库中，直接复用`);
      } catch (e) {
        result.failed += 1;
        result.problems.push(`第 ${i + 1} 条：${e.message}`);
      }
    }
    urlResult.value = result;
    if (result.failed) ElMessage.warning(`收图完成：成功 ${result.ok}，失败 ${result.failed}`);
    else ElMessage.success(`成功收进 ${result.ok} 张`);
    await load(1);
  } finally {
    saving.value = false;
  }
}

function openRename(r) {
  renaming.value = r;
  renameForm.name = r.name || '';
  renameForm.tags = r.tags || '';
  renameDlg.value = true;
}

async function doRename() {
  saving.value = true;
  try {
    await api.patch(`/api/reference-images/${renaming.value.id}`, {
      name: renameForm.name.trim(), tags: renameForm.tags.trim(),
    });
    ElMessage.success('已保存');
    renameDlg.value = false;
    await load(page.value);
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(r) {
  try {
    await ElMessageBox.confirm(
      `确定删除「${r.name || `参考图 #${r.id}`}」吗？文件会一并从磁盘删掉。`
      + (r.useCount ? `\n这张图被引用过 ${r.useCount} 次，删掉后相关分镜需要重新选参考图。` : ''),
      '删除确认', { type: 'warning' },
    );
  } catch { return; }
  try {
    const res = await api.del(`/api/reference-images/${r.id}`);
    ElMessage.success(res.message || '已删除');
    await load(page.value);
  } catch (e) {
    ElMessage.error(e.message || '删除失败');
  }
}

/**
 * 复制给**别处用**的地址：带 Authorization 头的接口地址（脚本 / curl 能用）。
 * 不给凭证通道地址 —— 那个 10 分钟就过期，复制出去只会变成死链。
 */
async function copyUrl(r) {
  const abs = `${window.location.origin}/api/reference-images/${r.id}/file`;
  try {
    await navigator.clipboard.writeText(abs);
    ElMessage.success('已复制（需带后台 Authorization 头访问）');
  } catch {
    ElMessage.warning(abs);
  }
}

/**
 * 下载：**必须走带 Authorization 头的 fetch → blob**，不能 window.open。
 * `/file` 端点挂了 requirePerm，而浏览器直接打开链接不会带后台 JWT ——
 * 那只会打开一个 401 的 JSON 页面（看起来像"下载坏了"）。
 * 图片只有几 MB，读进内存没问题（成片库那几十 MB 才必须走凭证通道）。
 */
async function download(r) {
  try {
    const token = localStorage.getItem('admin_token') || '';
    const res = await fetch(`/api/reference-images/${r.id}/file?download=1`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.name || `reference-${r.id}`}${r.mime === 'image/jpeg' ? '.jpg' : '.png'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器的下载中断，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    ElMessage.error(`下载失败：${e.message}`);
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.spacer { flex: 1; min-width: 0; }
.muted { color: var(--el-text-color-secondary); }
.tip { margin-bottom: 16px; }
.mt { margin-top: 10px; }
.notice-body { font-size: 12px; line-height: 1.9; margin-top: 6px; }
.notice-body code { background: rgba(127, 127, 127, .18); padding: 1px 5px; border-radius: 4px; }
.mono-box :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

.ref-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
  min-height: 200px;
}
.ref-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}
.ref-card .cover { position: relative; height: 150px; background: var(--el-fill-color-light); }
.ref-card .cover .el-image { width: 100%; height: 100%; display: block; cursor: zoom-in; }
.ref-card .src-tag { position: absolute; left: 8px; top: 8px; }
.ref-card .body { padding: 10px 12px 4px; flex: 1; min-width: 0; }
.ref-card .name { font-weight: 600; font-size: 13.5px; margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-card .meta { font-size: 11.5px; }
.ref-card .tags { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0; }
.ref-card .actions { display: flex; flex-wrap: wrap; padding: 4px 6px 8px; }

.pager { margin-top: 16px; display: flex; justify-content: flex-end; }
</style>
