<template>
  <div>
    <el-card shadow="never">
      <div class="toolbar">
        <el-input v-model="keyword" placeholder="搜索名称或提示词" clearable style="width: 260px" @keyup.enter="load(1)" @clear="load(1)">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button :icon="Search" @click="load(1)">搜索</el-button>
        <div class="spacer" />
        <span class="muted">共 {{ total }} 条</span>
        <el-button v-if="can('material:create')" @click="openImport">批量导入</el-button>
        <el-button v-if="can('material:create')" type="primary" @click="openEditor()">新建素材</el-button>
      </div>

      <div v-loading="loading" class="material-wall">
        <el-empty v-if="!loading && !items.length" description="还没有素材" :image-size="80" />
        <div v-for="m in items" :key="m.id" class="material-card">
          <div v-if="m.images?.length" class="cover">
            <el-image :src="imgSrc(m.images[0])" fit="cover" :preview-src-list="m.images.map(imgSrc)" preview-teleported />
            <el-tag v-if="m.images.length > 1" size="small" class="img-count">{{ m.images.length }} 图</el-tag>
          </div>
          <div class="body">
            <div class="name">{{ m.name || '未命名素材' }}</div>
            <div class="prompt" :title="m.prompt">{{ m.prompt }}</div>
            <div class="meta muted">#{{ m.id }} · 更新于 {{ fmt(m.updatedAt) }}</div>
          </div>
          <div class="actions">
            <el-button size="small" text type="primary" @click="copyPrompt(m)">复制提示词</el-button>
            <el-button v-if="can('material:update')" size="small" text type="primary" @click="openEditor(m)">编辑</el-button>
            <el-button v-if="can('material:delete')" size="small" text type="danger" @click="remove(m)">删除</el-button>
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

    <!-- ============ 新建 / 编辑 ============ -->
    <el-dialog v-model="editDlg" :title="editing ? '编辑素材' : '新建素材'" width="640px" :close-on-click-modal="false">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" maxlength="80" placeholder="例如：雨夜街头" />
        </el-form-item>
        <el-form-item label="提示词" required>
          <el-input v-model="editForm.prompt" type="textarea" :rows="6" maxlength="12000" show-word-limit
            placeholder="描述场景、人物、动作与镜头语言" />
        </el-form-item>
        <el-form-item label="参考图">
          <div class="img-editor">
            <div v-for="(img, i) in editForm.images" :key="i" class="img-thumb">
              <el-image :src="imgSrc(img)" fit="cover" :preview-src-list="editForm.images.map(imgSrc)" preview-teleported />
              <el-button size="small" circle class="img-del" @click="editForm.images.splice(i, 1)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <el-upload
              v-if="editForm.images.length < 9"
              :show-file-list="false"
              :before-upload="onPickImage"
              accept="image/png,image/jpeg,image/gif"
            >
              <div class="img-add"><el-icon><Plus /></el-icon><span>添加</span></div>
            </el-upload>
          </div>
          <div class="hint">最多 9 张，单张 8MB 以内；仅 png / jpeg / gif（gif 自动取首帧）。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEditor">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 批量导入 ============ -->
    <el-dialog v-model="importDlg" title="批量导入素材" width="640px">
      <el-alert type="info" :closable="false" show-icon class="tip">
        <template #title>每行一条：名称 | 提示词</template>
        <div class="notice-body">
          用 <code>|</code> 分隔名称和提示词；没有 <code>|</code> 的行整行当提示词，名称自动生成。
          导入不支持图片，如需配图请导入后逐条编辑添加。
        </div>
      </el-alert>
      <el-input v-model="importRaw" type="textarea" :rows="10" class="mono-box"
        placeholder="雨夜街头 | 霓虹灯下的雨夜街道，倒影，电影感&#10;海边日落，镜头缓慢横移" />
      <el-alert v-if="importResult" :type="importResult.failed ? 'warning' : 'success'" :closable="false" class="mt">
        <template #title>导入 {{ importResult.inserted }} 条，失败 {{ importResult.failed }} 条</template>
        <div v-if="importResult.problems?.length" class="notice-body">
          <div v-for="(p, i) in importResult.problems" :key="i">· {{ p }}</div>
        </div>
      </el-alert>
      <template #footer>
        <el-button @click="importDlg = false">关闭</el-button>
        <el-button type="primary" :loading="saving" @click="doImport">开始导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
// keep-alive 靠组件名匹配 include，<script setup> 默认没有 name，
// 少了这一行缓存会**静默失效**（不报错、也不生效）。
defineOptions({ name: 'Materials' });
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Plus, Search } from '@element-plus/icons-vue';
import { api, qs } from '../api.js';
import { can } from '../store.js';

const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const keyword = ref('');
const loading = ref(false);
const saving = ref(false);

const editDlg = ref(false);
const editing = ref(null);
const editForm = reactive({ name: '', prompt: '', images: [] });

const importDlg = ref(false);
const importRaw = ref('');
const importResult = ref(null);

function fmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
}
function imgSrc(img) {
  return `data:${img?.mime || 'image/png'};base64,${img?.dataBase64 || ''}`;
}

async function load(p = 1) {
  page.value = p;
  loading.value = true;
  try {
    const res = await api.get('/api/materials' + qs({ keyword: keyword.value.trim(), page: p, pageSize: pageSize.value }), { silent: true });
    items.value = res.items || [];
    total.value = res.total || 0;
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function openEditor(m = null) {
  editing.value = m;
  editForm.name = m?.name || '';
  editForm.prompt = m?.prompt || '';
  editForm.images = (m?.images || []).map((img) => ({ mime: img.mime, dataBase64: img.dataBase64 }));
  editDlg.value = true;
}

async function onPickImage(file) {
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.error('单张图片不能超过 8MB');
    return false;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const match = /^data:(image\/(png|jpeg|gif));base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    ElMessage.error('只支持 png / jpeg / gif');
    return false;
  }
  editForm.images.push({ mime: match[1], dataBase64: match[3] });
  return false; // 阻止 el-upload 自动上传，纯本地处理
}

async function saveEditor() {
  if (!editForm.prompt.trim()) {
    ElMessage.error('请填写提示词');
    return;
  }
  saving.value = true;
  try {
    const body = { name: editForm.name.trim(), prompt: editForm.prompt.trim(), images: editForm.images };
    if (editing.value) await api.put(`/api/materials/${editing.value.id}`, body);
    else await api.post('/api/materials', body);
    ElMessage.success('已保存');
    editDlg.value = false;
    await load(page.value);
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(m) {
  try {
    await ElMessageBox.confirm(`确定删除素材「${m.name || '未命名素材'}」吗？`, '删除确认', { type: 'warning' });
  } catch { return; }
  try {
    await api.del(`/api/materials/${m.id}`);
    ElMessage.success('已删除');
    await load(page.value);
  } catch (e) {
    ElMessage.error(e.message || '删除失败');
  }
}

async function copyPrompt(m) {
  try {
    await navigator.clipboard.writeText(m.prompt || '');
    ElMessage.success('提示词已复制');
  } catch {
    ElMessage.error('复制失败，请手动复制');
  }
}

function openImport() {
  importRaw.value = '';
  importResult.value = null;
  importDlg.value = true;
}

async function doImport() {
  const lines = importRaw.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    ElMessage.error('请先粘贴要导入的内容');
    return;
  }
  const list = lines.map((line, i) => {
    const sep = line.indexOf('|');
    if (sep < 0) return { name: `导入素材 ${i + 1}`, prompt: line };
    return { name: line.slice(0, sep).trim() || `导入素材 ${i + 1}`, prompt: line.slice(sep + 1).trim() };
  }).filter((x) => x.prompt);
  if (!list.length) {
    ElMessage.error('没有可导入的有效行');
    return;
  }
  saving.value = true;
  try {
    const res = await api.post('/api/materials/import', { items: list });
    importResult.value = res;
    if (res.failed) ElMessage.warning(`导入完成，${res.failed} 条失败`);
    else ElMessage.success(`成功导入 ${res.inserted} 条`);
    await load(1);
  } catch (e) {
    ElMessage.error(e.message || '导入失败');
  } finally {
    saving.value = false;
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.spacer { flex: 1; min-width: 0; }
.muted { color: var(--el-text-color-secondary); }
.mono-box :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.hint { margin-top: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.tip { margin-bottom: 16px; }
.mt { margin-top: 10px; }
.notice-body { font-size: 12px; line-height: 1.9; margin-top: 6px; }
.notice-body code { background: rgba(127, 127, 127, .18); padding: 1px 5px; border-radius: 4px; }

.material-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  min-height: 200px;
}
.material-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}
.material-card .cover { position: relative; height: 132px; background: var(--el-fill-color-light); }
.material-card .cover .el-image { width: 100%; height: 100%; display: block; cursor: zoom-in; }
.material-card .img-count { position: absolute; right: 8px; bottom: 8px; }
.material-card .body { padding: 12px 14px 6px; flex: 1; min-width: 0; }
.material-card .name { font-weight: 600; font-size: 14px; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.material-card .prompt {
  font-size: 12.5px; color: var(--el-text-color-regular); line-height: 1.7;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 64px;
}
.material-card .meta { font-size: 11.5px; margin-top: 8px; }
.material-card .actions { display: flex; padding: 6px 8px 10px; }

.img-editor { display: flex; gap: 10px; flex-wrap: wrap; }
.img-thumb { position: relative; width: 84px; height: 84px; border-radius: 8px; overflow: hidden; border: 1px solid var(--el-border-color); }
.img-thumb .el-image { width: 100%; height: 100%; display: block; cursor: zoom-in; }
.img-del { position: absolute; top: 2px; right: 2px; padding: 4px; }
.img-add {
  width: 84px; height: 84px; border: 1px dashed var(--el-border-color); border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  color: var(--el-text-color-secondary); cursor: pointer; font-size: 12px;
}
.img-add:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.img-add .el-icon { font-size: 20px; }

.pager { margin-top: 16px; display: flex; justify-content: flex-end; }
</style>
