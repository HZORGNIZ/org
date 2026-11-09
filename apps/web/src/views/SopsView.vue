<template>
  <div class="page" :class="{ embedded }">
    <div class="page-title" :class="{ 'title-embedded': embedded }">
      <span v-if="!embedded">SOP 经验库</span>
      <el-button v-if="canCreate" @click="openTeamExtract">
        <el-icon><ChatLineSquare /></el-icon>&nbsp;从团队记录提取
      </el-button>
      <el-button v-if="canCreate" type="primary" @click="openForm(null)">
        <el-icon><Plus /></el-icon>&nbsp;人工新增 SOP
      </el-button>
    </div>

    <!-- 状态 tabs + 标签筛选 + 搜索 -->
    <div class="page-card filter-card">
      <el-radio-group v-model="statusTab" @change="load">
        <el-radio-button value="APPROVED">已生效</el-radio-button>
        <el-radio-button value="CANDIDATE">待确认</el-radio-button>
        <el-radio-button value="ALL">待确认 + 已生效</el-radio-button>
      </el-radio-group>
      <div v-if="allTags.length" class="tag-bar">
        <el-check-tag :checked="!activeTag" @change="activeTag = ''; load()">全部标签</el-check-tag>
        <el-check-tag
          v-for="t in allTags"
          :key="t.name"
          :checked="activeTag === t.name"
          @change="activeTag = activeTag === t.name ? '' : t.name; load()"
        >
          {{ t.name }}（{{ t.count }}）
        </el-check-tag>
      </div>
      <el-input
        v-model="keyword"
        placeholder="搜索 SOP 标题/内容关键词…"
        clearable
        class="kw"
        @input="debounceLoad"
      />
    </div>

    <!-- SOP 列表 -->
    <div v-loading="loading" class="sop-list">
      <div v-if="!loading && !items.length" class="muted empty">
        暂无 SOP
        <div class="empty-tip">
          复盘完成「AI 汇总」后会自动从汇总报告提取 SOP；也可在 SOP 页从最近群聊/日报/周报记录一键提取。提取结果均为「待确认」，人工确认后才生效；也可直接「人工新增」
        </div>
      </div>
      <div v-for="s in items" :key="s.id" class="page-card sop-card">
        <div class="sop-head">
          <el-tag
            :type="s.status === 'APPROVED' ? 'success' : 'warning'"
            size="small"
            effect="dark"
            class="sop-status"
          >
            {{ s.status === 'APPROVED' ? '已生效' : '待确认' }}
          </el-tag>
          <b class="sop-title">{{ s.title }}</b>
          <span v-if="s.sourceType === 'RETRO_EXTRACT'" class="muted src-chip">AI 提取自复盘</span>
          <span v-else-if="s.sourceType === 'TEAM_EXTRACT'" class="muted src-chip">AI 提取自团队记录</span>
          <span v-else class="muted src-chip">人工新增</span>
        </div>
        <div class="sop-meta muted">
          <template v-if="s.project">
            <span class="meta-chip">
              <el-icon><FolderOpened /></el-icon>{{ s.project.name }}
            </span>
            <span v-if="s.retro" class="meta-chip">
              <el-icon><RefreshLeft /></el-icon>{{ s.retro.title }}
            </span>
          </template>
          <span class="meta-chip">提出人：{{ s.proposer?.name || '—' }}</span>
          <span v-if="s.status === 'APPROVED' && s.confirmedBy" class="meta-chip">
            确认人：{{ s.confirmedBy.name }}
          </span>
        </div>
        <div class="sop-content" :class="{ expanded: expandIds.has(s.id) }">
          <div class="sop-text">{{ s.content }}</div>
        </div>
        <div class="sop-foot">
          <div class="sop-tags">
            <el-tag v-for="t in s.tags || []" :key="t" size="small" type="info" effect="plain">{{ t }}</el-tag>
            <span v-if="!(s.tags || []).length" class="muted">无标签</span>
          </div>
          <div class="sop-actions">
            <el-button size="small" text @click="toggleExpand(s.id)">
              {{ expandIds.has(s.id) ? '收起' : '展开全文' }}
            </el-button>
            <template v-if="canManage(s)">
              <el-button
                v-if="s.status === 'CANDIDATE'"
                size="small"
                text
                type="success"
                @click="approve(s)"
              >
                确认生效
              </el-button>
              <el-button
                v-if="s.status === 'CANDIDATE'"
                size="small"
                text
                type="warning"
                @click="reject(s)"
              >
                拒绝
              </el-button>
              <el-button size="small" text type="primary" @click="openForm(s)">编辑</el-button>
              <el-button size="small" text type="danger" @click="removeSop(s)">删除</el-button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增 / 编辑 SOP -->
    <el-dialog
      v-model="formVisible"
      :title="editing ? '编辑 SOP' : '人工新增 SOP（保存即生效）'"
      width="min(94vw, 620px)"
    >
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="sopForm.title" maxlength="120" placeholder="一句话经验/规律标题，如：验收前先跑冒烟用例" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input
            v-model="sopForm.content"
            type="textarea"
            :rows="6"
            placeholder="可执行的 SOP 描述（行动化、非鸡汤），支持 Markdown"
          />
        </el-form-item>
        <el-form-item label="标签（逗号分隔，最多 10 个）">
          <el-input v-model="sopForm.tagsText" placeholder="如：质量管理, 流程, 沟通" />
        </el-form-item>
        <el-form-item v-if="!editing" label="关联项目（可选，便于按项目追溯）">
          <el-select v-model="sopForm.projectId" clearable filterable style="width: 100%" placeholder="选择项目">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveForm">{{ editing ? '保存' : '新增' }}</el-button>
      </template>
    </el-dialog>

    <!-- 从团队记录（群聊/日报/周报）AI 提取 SOP -->
    <el-dialog v-model="extractVisible" title="从团队记录提取 SOP" width="min(94vw, 540px)">
      <div class="muted extract-tip">
        AI 将从所选时间范围内团队成员的<b>群聊记录、日报、周报</b>文字中，提炼可复用的经验/流程/避坑规律；
        提取结果进入「待确认」，由人工确认后生效。
      </div>
      <el-form label-position="top" style="margin-top: 14px">
        <el-form-item label="时间范围">
          <el-radio-group v-model="extractForm.days">
            <el-radio-button v-for="d in [7, 14, 30, 60, 90]" :key="d" :value="d">近 {{ d }} 天</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="来源项目">
          <el-select
            v-model="extractForm.projectId"
            clearable
            filterable
            style="width: 100%"
            :placeholder="auth.isAdmin ? '不选 = 全团队（管理员）' : '请选择你负责的项目'"
          >
            <el-option v-for="p in projectOptions" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="extractVisible = false">取消</el-button>
        <el-button type="primary" :loading="extracting" @click="runTeamExtract">开始提取</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { projectsApi, sopsApi } from '../api';
import { useAuthStore } from '../stores/auth';
/** 内嵌于「资料中心」大 tab 时：隐藏自身页头标题、降格为紧凑工具条 */
defineProps<{ embedded?: boolean }>();

const auth = useAuthStore();

const items = ref<any[]>([]);
const allTags = ref<{ name: string; count: number }[]>([]);
const loading = ref(false);
const statusTab = ref('APPROVED'); // 默认展示已生效的 SOP
const activeTag = ref('');
const keyword = ref('');
const expandIds = ref<Set<string>>(new Set());

const projects = ref<any[]>([]);
const myOwnedIds = ref<Set<string>>(new Set());

const canCreate = computed(() => auth.isAdmin || myOwnedIds.value.size > 0);

/** 可提取的项目选项：管理员全部项目；负责人仅自己负责的项目 */
const projectOptions = computed(() =>
  auth.isAdmin ? projects.value : projects.value.filter((p) => myOwnedIds.value.has(p.id)),
);

// ---- 从团队记录（群聊/日报/周报）AI 提取 ----
const extractVisible = ref(false);
const extracting = ref(false);
const extractForm = reactive({ days: 30, projectId: '' });

async function openTeamExtract() {
  await loadProjects();
  extractForm.days = 30;
  extractForm.projectId = auth.isAdmin ? '' : projectOptions.value[0]?.id ?? '';
  extractVisible.value = true;
}

async function runTeamExtract() {
  if (!auth.isAdmin && !extractForm.projectId) {
    ElMessage.warning('请选择要提取的项目（全团队提取仅管理员可用）');
    return;
  }
  extracting.value = true;
  try {
    const res: any = await sopsApi.extractTeam({
      days: extractForm.days,
      ...(extractForm.projectId ? { projectId: extractForm.projectId } : {}),
    });
    extractVisible.value = false;
    const src = res?.sources;
    const scope = src ? `（群聊 ${src.messages} 条 / 日报周报 ${src.reports} 份）` : '';
    if (res?.created?.length) {
      ElMessage.success(`已提取 ${res.created.length} 条 SOP 候选${scope}，待人工确认${res.skipped ? `，跳过重复 ${res.skipped} 条` : ''}`);
    } else {
      ElMessage.info(res?.note || '未提取到新的 SOP' + scope);
    }
    load();
  } catch {
    /* 拦截器已提示 */
  } finally {
    extracting.value = false;
  }
}

/** 管理权限：ADMIN 或 SOP 来源项目负责人（无来源项目仅管理员） */
function canManage(s: any) {
  if (auth.isAdmin) return true;
  return !!s.projectId && myOwnedIds.value.has(s.projectId);
}

const formVisible = ref(false);
const saving = ref(false);
const editing = ref<any>(null);
const sopForm = reactive({ title: '', content: '', tagsText: '', projectId: '' });

let timer: any = null;
function debounceLoad() {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
}

async function load() {
  loading.value = true;
  try {
    const params: any = {};
    if (statusTab.value !== 'ALL') params.status = statusTab.value;
    if (activeTag.value) params.tag = activeTag.value;
    if (keyword.value.trim()) params.keyword = keyword.value.trim();
    const res: any = await sopsApi.list(params);
    items.value = res.items || [];
    allTags.value = res.allTags || [];
  } finally {
    loading.value = false;
  }
}

async function loadProjects() {
  try {
    projects.value = await projectsApi.list();
    myOwnedIds.value = new Set(
      projects.value.filter((p) => p.owner?.id === auth.user?.id).map((p) => p.id),
    );
  } catch {
    projects.value = [];
  }
}

function toggleExpand(id: string) {
  const next = new Set(expandIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandIds.value = next;
}

function openForm(s: any | null) {
  editing.value = s;
  sopForm.title = s?.title || '';
  sopForm.content = s?.content || '';
  sopForm.tagsText = (s?.tags || []).join(', ');
  sopForm.projectId = s?.projectId || '';
  formVisible.value = true;
}

async function saveForm() {
  if (!sopForm.title.trim() || !sopForm.content.trim()) {
    ElMessage.warning('请填写标题和内容');
    return;
  }
  const tags = sopForm.tagsText
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
  saving.value = true;
  try {
    if (editing.value) {
      await sopsApi.patch(editing.value.id, { title: sopForm.title.trim(), content: sopForm.content.trim(), tags });
      ElMessage.success('已保存');
    } else {
      await sopsApi.create({
        title: sopForm.title.trim(),
        content: sopForm.content.trim(),
        tags,
        ...(sopForm.projectId ? { projectId: sopForm.projectId } : {}),
      });
      ElMessage.success('SOP 已新增并生效');
    }
    formVisible.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

async function approve(s: any) {
  try {
    await sopsApi.patch(s.id, { status: 'APPROVED' });
    ElMessage.success('已确认生效');
    load();
  } catch {
    /* 拦截器已提示 */
  }
}

async function reject(s: any) {
  try {
    await sopsApi.patch(s.id, { status: 'REJECTED' });
    ElMessage.success('已拒绝（保留审计记录）');
    load();
  } catch {
    /* 拦截器已提示 */
  }
}

async function removeSop(s: any) {
  try {
    await ElMessageBox.confirm(`确定删除 SOP「${s.title}」？`, '删除', { type: 'warning' });
    await sopsApi.remove(s.id);
    ElMessage.success('已删除');
    load();
  } catch {
    /* 取消或失败 */
  }
}

onMounted(() => {
  load();
  loadProjects();
});
</script>

<style scoped>
.filter-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.kw {
  max-width: 320px;
}
.sop-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sop-card {
  padding: 14px 16px;
}
.sop-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sop-title {
  font-size: 15px;
}
.src-chip {
  font-size: 12px;
}
.sop-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 8px;
  font-size: 12px;
  flex-wrap: wrap;
}
.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sop-content {
  margin-top: 10px;
  position: relative;
}
.sop-text {
  font-size: 13px;
  line-height: 1.8;
  color: #303133;
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sop-content.expanded .sop-text {
  display: block;
}
.sop-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.sop-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sop-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.sop-status {
  flex-shrink: 0;
}
.empty {
  text-align: center;
  padding: 30px 0;
}
.empty-tip {
  font-size: 12px;
  color: #909399;
  margin-top: 8px;
  line-height: 1.6;
}
.extract-tip {
  font-size: 13px;
  line-height: 1.7;
}
</style>
