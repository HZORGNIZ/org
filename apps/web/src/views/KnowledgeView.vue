<template>
  <div class="page" :class="{ embedded }">
    <div class="page-title" :class="{ 'title-embedded': embedded }">
      <span v-if="!embedded">知识库</span>
      <el-button type="primary" @click="openEdit(null)">
        <el-icon><Plus /></el-icon>&nbsp;新建文档
      </el-button>
    </div>

    <div class="kb-layout">
      <!-- 分类栏 -->
      <div class="page-card cat-card">
        <div class="cat-item" :class="{ active: !categoryId }" @click="selectCat('')">全部</div>
        <div v-for="c in categories" :key="c.id" class="cat-item" :class="{ active: categoryId === c.id }" @click="selectCat(c.id)">
          <span class="ellipsis">{{ c.name }}</span>
          <el-icon v-if="auth.isAdmin" class="cat-del" @click.stop="removeCategory(c)"><Close /></el-icon>
        </div>
        <el-button v-if="auth.isAdmin" size="small" class="cat-add" @click="addCategory">
          + 新建分类
        </el-button>
      </div>

      <!-- 文档列表 -->
      <div class="page-card doc-card">
        <el-input v-model="keyword" placeholder="搜索文档…" clearable class="kw" @input="debounceLoad" />
        <div v-loading="loading" class="doc-list">
          <div v-if="!docs.length && !loading" class="muted empty">暂无文档</div>
          <div v-for="d in docs" :key="d.id" class="doc-row" @click="openDetail(d)">
            <div class="doc-icon"><el-icon><Document /></el-icon></div>
            <div class="doc-info">
              <div class="doc-title">{{ d.title }}</div>
              <div class="muted">
                {{ d.category?.name || '未分类' }} · {{ d.author?.name }} · {{ timeAgo(d.updatedAt) }}
              </div>
            </div>
            <el-tag size="small" :type="VIS_TYPE[d.visibility] || 'info'" effect="plain">
              {{ VIS_LABEL[d.visibility] || d.visibility }}
            </el-tag>
          </div>
        </div>
      </div>
    </div>

    <!-- 文档详情 -->
    <el-drawer v-model="detailVisible" :title="current?.title" size="min(94vw, 640px)">
      <template v-if="current">
        <div class="doc-meta muted">
          {{ current.category?.name || '未分类' }} · {{ current.author?.name }} · 更新于 {{ fmt(current.updatedAt) }} · {{ VIS_LABEL[current.visibility] || current.visibility }}
          <div class="doc-actions">
            <el-button v-if="current.canEdit" size="small" @click="openEdit(current)">编辑</el-button>
            <el-button v-if="current.canEdit" size="small" type="danger" plain @click="removeDoc">删除</el-button>
          </div>
        </div>
        <MarkdownView :content="current.content" />
        <div v-if="(current.attachments || []).length" class="doc-att">
          <div class="ver-title">附件（{{ current.attachments.length }}）</div>
          <div v-for="a in current.attachments" :key="a.id" class="doc-att-row">
            <span>📎</span>
            <el-link type="primary" @click="downloadAttachment(a)">{{ a.fileName }}</el-link>
            <span class="muted">{{ fmtSize(a.size) }}</span>
          </div>
        </div>
        <el-divider />
        <div class="ver-title">版本历史（{{ versions.length }}）</div>
        <el-timeline v-if="versions.length">
          <el-timeline-item v-for="v in versions" :key="v.version" :timestamp="fmt(v.createdAt)" size="small">
            v{{ v.version }} · {{ v.editor?.name || '—' }}
            <el-button text size="small" type="primary" @click="previewVersion(v)">查看</el-button>
          </el-timeline-item>
        </el-timeline>
      </template>
    </el-drawer>

    <!-- 版本预览 -->
    <el-dialog v-model="versionVisible" :title="`v${versionPreview?.version} 历史版本`" width="min(94vw, 640px)">
      <MarkdownView :content="versionPreview?.content || ''" />
    </el-dialog>

    <!-- 新建/编辑文档 -->
    <el-dialog
      v-model="editVisible"
      :title="editing ? '编辑文档' : '新建文档'"
      width="min(96vw, 720px)"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="editForm.title" maxlength="100" placeholder="文档标题" />
        </el-form-item>
        <el-form-item label="内容（支持 Markdown）">
          <el-input v-model="editForm.content" type="textarea" :rows="12" class="content-area" placeholder="# 标题&#10;&#10;正文…" />
        </el-form-item>
        <div class="edit-row">
          <el-form-item label="分类">
            <el-select v-model="editForm.categoryId" clearable style="width: 100%">
              <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="可见范围">
            <el-select v-model="editForm.visibility" style="width: 100%">
              <el-option label="团队文档（全员可见）" value="PUBLIC" />
              <el-option label="部门文档（部门内可见）" value="DEPARTMENT" />
              <el-option label="项目文档（项目内及关联部门负责人可见）" value="PROJECT" />
              <el-option label="个人文档（仅自己可见）" value="PRIVATE" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item v-if="editForm.visibility === 'DEPARTMENT'" label="所属部门">
          <el-select v-model="editForm.departmentId" style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editForm.visibility === 'PROJECT'" label="所属项目">
          <el-select v-model="editForm.projectId" style="width: 100%">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editForm.visibility === 'PRIVATE'" label="授权他人查看/编辑">
          <div class="share-row">
            <el-select v-model="shareViewIds" multiple filterable placeholder="授权查看（可多选）" style="flex: 1">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
            <el-select v-model="shareEditIds" multiple filterable placeholder="授权编辑（可多选）" style="flex: 1">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveDoc">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { departmentsApi, knowledgeApi, projectsApi, usersApi, filesApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt, timeAgo } from '../utils/format';
import MarkdownView from '../components/MarkdownView.vue';

const auth = useAuthStore();
const route = useRoute();
/** 内嵌于「资料中心」大 tab 时：隐藏自身页头标题、降格为紧凑工具条 */
defineProps<{ embedded?: boolean }>();

// 可见范围展示（与后端 DocVisibility 枚举一致）
const VIS_LABEL: Record<string, string> = { PUBLIC: '团队', DEPARTMENT: '部门', PROJECT: '项目', PRIVATE: '个人' };
const VIS_TYPE: Record<string, string> = { PUBLIC: 'info', DEPARTMENT: 'success', PROJECT: 'primary', PRIVATE: 'warning' };

const categories = ref<any[]>([]);
const docs = ref<any[]>([]);
const projects = ref<any[]>([]);
const departments = ref<any[]>([]);
const users = ref<any[]>([]);
const shareViewIds = ref<string[]>([]);
const shareEditIds = ref<string[]>([]);
const categoryId = ref('');
const keyword = ref('');
const loading = ref(false);

const detailVisible = ref(false);
const current = ref<any>(null);
const versions = ref<any[]>([]);

const versionVisible = ref(false);
const versionPreview = ref<any>(null);

const editVisible = ref(false);
const editing = ref<any>(null);
const saving = ref(false);
const editForm = reactive({
  title: '',
  content: '',
  categoryId: null as string | null,
  visibility: 'PUBLIC',
  projectId: null as string | null,
  departmentId: null as string | null,
});

let timer: any = null;
function debounceLoad() {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
}

function selectCat(id: string) {
  categoryId.value = id;
  load();
}

async function load() {
  loading.value = true;
  try {
    const params: any = {};
    if (categoryId.value) params.categoryId = categoryId.value;
    if (keyword.value.trim()) params.keyword = keyword.value.trim();
    docs.value = await knowledgeApi.list(params);
  } finally {
    loading.value = false;
  }
}

// ---- 附件：查看/下载（后端预签名链接，任意格式） ----
function fmtSize(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
async function downloadAttachment(a: any) {
  try {
    const r: any = await filesApi.presign(a.fileKey);
    if (r?.url) window.open(r.url, '_blank');
    else ElMessage.error('未取得下载链接');
  } catch {
    ElMessage.error('获取下载链接失败');
  }
}

async function openDetail(d: any) {
  // 拉全量详情：后端返回 canEdit（管理员/作者/被授权 EDIT）与 shares 授权名单
  current.value = await knowledgeApi.get(d.id).catch(() => d);
  detailVisible.value = true;
  versions.value = await knowledgeApi.versions(d.id);
}

/** 按 id 打开文档详情（小助手回答里的「打开《某文档》」深链）；没权限就如实提示，不静默失败 */
async function openDocById(id: string) {
  if (!id) return;
  try {
    const d = await knowledgeApi.get(id);
    current.value = d;
    detailVisible.value = true;
    versions.value = await knowledgeApi.versions(id).catch(() => []);
  } catch {
    ElMessage.warning('打不开这篇文档：可能没有权限（保密项目需先签保密协议）或已被删除');
  }
}

async function previewVersion(v: any) {
  versionPreview.value = await knowledgeApi.version(current.value.id, v.version);
  versionVisible.value = true;
}

function openEdit(d: any | null) {
  editing.value = d;
  Object.assign(editForm, {
    title: d?.title || '',
    content: d?.content || '',
    categoryId: d?.categoryId || null,
    visibility: d?.visibility || 'PUBLIC',
    projectId: d?.projectId || null,
    departmentId: d?.departmentId || auth.user?.departmentId || null,
  });
  const shares = d?.shares || [];
  shareViewIds.value = shares.filter((s: any) => s.permission === 'VIEW').map((s: any) => s.userId);
  shareEditIds.value = shares.filter((s: any) => s.permission === 'EDIT').map((s: any) => s.userId);
  editVisible.value = true;
}

async function saveDoc() {
  if (!editForm.title.trim()) {
    ElMessage.warning('请输入标题');
    return;
  }
  if (editForm.visibility === 'DEPARTMENT' && !editForm.departmentId) {
    ElMessage.warning('部门文档请选择所属部门');
    return;
  }
  if (editForm.visibility === 'PROJECT' && !editForm.projectId) {
    ElMessage.warning('项目文档请选择所属项目');
    return;
  }
  saving.value = true;
  try {
    // 授权名单：同一人同时勾选查看+编辑时取编辑
    const permMap = new Map<string, 'VIEW' | 'EDIT'>();
    for (const userId of shareViewIds.value) permMap.set(userId, 'VIEW');
    for (const userId of shareEditIds.value) permMap.set(userId, 'EDIT');
    const payload = {
      title: editForm.title.trim(),
      content: editForm.content,
      categoryId: editForm.categoryId,
      visibility: editForm.visibility,
      departmentId: editForm.visibility === 'DEPARTMENT' ? editForm.departmentId : null,
      projectId: editForm.visibility === 'PROJECT' ? editForm.projectId : null,
      shares: [...permMap.entries()].map(([userId, permission]) => ({ userId, permission })),
    };
    if (editing.value) {
      await knowledgeApi.update(editing.value.id, payload);
      ElMessage.success('已保存（生成新版本）');
    } else {
      await knowledgeApi.create(payload);
      ElMessage.success('文档已创建');
    }
    editVisible.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

async function removeDoc() {
  await ElMessageBox.confirm('确定删除该文档？', '删除文档', { type: 'warning' });
  await knowledgeApi.remove(current.value.id);
  ElMessage.success('已删除');
  detailVisible.value = false;
  load();
}

async function addCategory() {
  const { value } = await ElMessageBox.prompt('分类名称', '新建分类');
  if (value?.trim()) {
    await knowledgeApi.createCategory({ name: value.trim() });
    loadCategories();
  }
}

async function removeCategory(c: any) {
  await ElMessageBox.confirm(`确定删除分类「${c.name}」？`, '删除分类', { type: 'warning' });
  await knowledgeApi.deleteCategory(c.id);
  loadCategories();
}

async function loadCategories() {
  categories.value = await knowledgeApi.categories();
}

onMounted(async () => {
  const [ds, us] = await Promise.all([
    departmentsApi.list().catch(() => []),
    usersApi.list().catch(() => []),
  ]);
  departments.value = ds;
  users.value = (us || []).filter((u: any) => u.active !== false && u.id !== auth.user?.id);
  projects.value = await projectsApi.list();
  await loadCategories();
  load();
  // 小助手深链：/knowledge?doc=<id>
  await openDocById(String(route.query.doc ?? ''));
});
// 已在本页时再点助手里的另一篇文档链接：组件复用不重跑 onMounted，靠 watch 开抽屉
watch(
  () => route.query.doc,
  (v) => openDocById(String(v ?? '')),
);
</script>

<style scoped>
.kb-layout {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.cat-card {
  flex: 0 0 140px;
  margin-bottom: 0;
}
.doc-card {
  flex: 1;
  min-width: 0;
}
.cat-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  margin-bottom: 2px;
}
.cat-item:hover {
  background: #f5f7fa;
}
.cat-item.active {
  background: #ecf3ff;
  color: var(--el-color-primary);
  font-weight: 500;
}
.cat-del {
  color: #c0c4cc;
}
.cat-del:hover {
  color: #f56c6c;
}
.cat-add {
  width: 100%;
  margin-top: 6px;
}
.kw {
  margin-bottom: 10px;
}
.share-row {
  display: flex;
  gap: 8px;
  width: 100%;
}
.doc-list {
  min-height: 100px;
}
.doc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
}
.doc-row:last-child {
  border-bottom: none;
}
.doc-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #ecf3ff;
  color: var(--el-color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.doc-info {
  flex: 1;
  min-width: 0;
}
.doc-title {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 2px;
}
.doc-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 10px;
}
.ver-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}
/* 文档附件：详情抽屉里的附件清单（与版本历史同层级） */
.doc-att {
  margin-top: 14px;
}
.doc-att-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
}
.doc-att-row .muted {
  font-size: 12px;
}
.edit-row {
  display: flex;
  gap: 12px;
}
.edit-row .el-form-item {
  flex: 1;
}
.empty {
  text-align: center;
  padding: 30px 0;
}

@media (max-width: 767px) {
  .kb-layout {
    flex-direction: column;
  }
  .cat-card {
    flex: none;
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .cat-item {
    margin-bottom: 0;
  }
  .cat-add {
    width: auto;
  }
}
</style>
