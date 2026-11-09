<template>
  <div class="page">
    <div class="page-title">
      项目复盘
      <el-button v-if="canCreate" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>&nbsp;新建复盘
      </el-button>
    </div>

    <!-- 复盘轮次列表 -->
    <div class="page-card">
      <div v-loading="loading" class="retro-list">
        <div v-if="!loading && !list.length" class="muted empty">
          暂无复盘轮次
          <template v-if="!canCreate">（仅项目负责人可发起复盘）</template>
        </div>
        <div v-for="r in list" :key="r.id" class="retro-card" @click="openDetail(r)">
          <div class="retro-main">
            <div class="retro-head">
              <b class="retro-title">{{ r.title }}</b>
              <el-tag v-if="r.kind === 'STRUCTURED'" size="small" type="primary" effect="plain">结构化问答</el-tag>
              <el-tag v-else size="small" type="warning" effect="plain">一般复盘</el-tag>
              <el-tag
                :type="r.status === 'SUMMARIZED' ? 'success' : 'info'"
                size="small"
                effect="dark"
              >
                {{ r.status === 'SUMMARIZED' ? '已汇总' : '进行中' }}
              </el-tag>
            </div>
            <div class="retro-meta muted">
              <span class="proj-chip">
                <el-icon><FolderOpened /></el-icon>{{ r.project?.name }}
              </span>
              <span v-if="r.deadline" :class="{ 'deadline-over': r.overdue }">
                <el-icon><Clock /></el-icon>
                截止 {{ fmt(r.deadline, 'YYYY-MM-DD') }}<template v-if="r.overdue">（已逾期）</template>
              </span>
              <span>进度 {{ r.submittedCount }}/{{ r.membersTotal }}</span>
              <span v-if="r.mySubmitted" class="ok">我已提交</span>
              <span v-else class="todo">未提交</span>
            </div>
          </div>
          <div class="retro-actions">
            <el-button
              v-if="canManage(r) && r.canSummarize && r.status !== 'SUMMARIZED'"
              size="small"
              type="success"
              :loading="summarizingId === r.id"
              @click.stop="summarize(r)"
            >
              AI 汇总
            </el-button>
            <el-button size="small" @click.stop="openDetail(r)">查看 / 提交</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建复盘 -->
    <el-dialog v-model="createVisible" title="新建复盘轮次" width="min(94vw, 520px)">
      <el-form label-position="top">
        <el-form-item label="项目（我负责的项目）" required>
          <el-select v-model="createForm.projectId" filterable style="width: 100%">
            <el-option
              v-for="p in creatableProjects"
              :key="p.id"
              :label="p.name"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="复盘类型">
          <el-radio-group v-model="createForm.kind">
            <el-radio-button value="STRUCTURED">结构化问答（5 问）</el-radio-button>
            <el-radio-button value="GENERAL">一般复盘（导入总结）</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="createForm.title" placeholder="如：项目一期复盘（留空自动生成）" maxlength="100" />
        </el-form-item>
        <el-form-item label="截止日期（成员须在此前提交）">
          <el-date-picker
            v-model="createForm.deadline"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
            placeholder="选择截止日期"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <!-- 复盘详情 -->
    <el-dialog
      v-model="detailVisible"
      :title="detail?.title"
      width="min(96vw, 760px)"
      top="6vh"
    >
      <template v-if="detail">
        <!-- 元信息 -->
        <div class="detail-meta muted">
          <el-tag v-if="detail.kind === 'STRUCTURED'" size="small" type="primary" effect="plain">结构化问答</el-tag>
          <el-tag v-else size="small" type="warning" effect="plain">一般复盘</el-tag>
          <span>{{ detail.project?.name }}</span>
          <span v-if="detail.deadline" :class="{ 'deadline-over': overdue }">
            截止 {{ fmt(detail.deadline, 'YYYY-MM-DD') }}
          </span>
          <span>成员 {{ (detail.submissions || []).length }}/{{ detail.members?.length }} 已提交</span>
        </div>

        <!-- 汇总报告 -->
        <div v-if="detail.summary" class="summary-box">
          <div class="block-title">
            复盘汇总报告
            <span class="muted summary-by">
              <template v-if="detail.summaryBy">
                由 {{ summaryByName }} 汇总
                <template v-if="detail.summarizedAt">· {{ fmt(detail.summarizedAt, 'YYYY-MM-DD HH:mm') }}</template>
              </template>
            </span>
            <el-button
              v-if="detail.canManage"
              size="small"
              type="warning"
              plain
              :loading="extracting"
              style="float: right; margin-right: 8px"
              @click="extractSops"
            >
              提取 SOP
            </el-button>
            <el-button
              v-if="detail.canManage"
              size="small"
              type="success"
              :loading="summarizing"
              style="float: right"
              @click="summarize(detail)"
            >
              重新汇总
            </el-button>
          </div>
          <div class="markdown-box"><MarkdownView :content="detail.summary" /></div>
        </div>
        <div v-else-if="detail.canManage" class="empty-summary">
          尚未生成汇总报告。成员提交后点击「AI 汇总」生成项目复盘报告。
        </div>

        <!-- 我的提交 -->
        <template v-if="detail.status === 'OPEN'">
          <el-divider />
          <div class="block-title">
            我的复盘提交
            <span class="muted" style="font-weight: 400">（{{ mySubmission ? '已提交，可修改后覆盖' : '未提交' }}）</span>
          </div>

          <!-- 结构化：5 问 -->
          <template v-if="detail.kind === 'STRUCTURED'">
            <div v-for="q in questions" :key="q.key" class="q-item">
              <div class="q-title">{{ q.key.toUpperCase() }}. {{ q.question }}</div>
              <el-input v-model="answers[q.key]" type="textarea" :rows="3" :placeholder="'回答 ' + q.key.toUpperCase()" />
            </div>
          </template>

          <!-- 一般复盘：粘贴文本 + 可选附件 -->
          <template v-else>
            <el-input
              v-model="generalText"
              type="textarea"
              :rows="5"
              placeholder="粘贴你的复盘总结（也可上传 Word 文档，二选一或都填）"
            />
            <div class="attach-row">
              <input ref="fileInput" type="file" accept=".docx,.doc,.pdf,.txt" hidden @change="onPickFile" />
              <el-button size="small" :loading="uploading" @click="pickFile">
                <el-icon><Upload /></el-icon>&nbsp;上传文档（Word/PDF/TXT）
              </el-button>
              <span v-if="generalFile" class="attach-chip">
                <el-icon><Document /></el-icon>{{ generalFile.name }}
                <el-icon class="attach-remove" @click="generalFile = null"><Close /></el-icon>
              </span>
              <span v-else class="muted attach-tip">上传需要 MinIO 文件服务运行；否则请粘贴文本</span>
            </div>
          </template>

          <div class="submit-row">
            <el-button type="primary" :loading="submitting" @click="submitMine">
              提交{{ mySubmission ? '并覆盖' : '' }}
            </el-button>
            <span v-if="mySubmission" class="muted">已提交于 {{ fmt(mySubmission.submittedAt, 'YYYY-MM-DD HH:mm') }}</span>
          </div>
        </template>
        <div v-else-if="detail.status === 'SUMMARIZED'" class="muted closed-tip">
          本轮复盘已汇总，提交已关闭；如需补充可联系负责人重新汇总。
        </div>

        <!-- 成员提交进度 -->
        <el-divider />
        <div class="block-title">成员提交进度</div>
        <div class="member-grid">
          <div v-for="m in detail.members || []" :key="m.userId" class="member-chip">
            <el-avatar :size="22" :src="m.avatar || undefined">{{ m.name?.slice(0, 1) }}</el-avatar>
            <span class="member-name">{{ m.name }}</span>
            <el-tag
              v-if="submittedUserIds.has(m.userId)"
              size="small"
              type="success"
              effect="plain"
            >
              已提交
            </el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未提交</el-tag>
          </div>
        </div>

        <!-- 各成员提交内容（负责人查看） -->
        <div v-if="detail.canManage && detail.submissions?.length" class="submissions">
          <div class="block-title">成员提交内容（仅供负责人）</div>
          <div v-for="s in detail.submissions" :key="s.id" class="submission-box">
            <div class="submission-head">
              <b>{{ s.user?.name }}</b>
              <span class="muted">{{ fmt(s.submittedAt, 'MM-DD HH:mm') }}</span>
              <span v-if="s.attachmentName" class="muted">
                <el-icon><Paperclip /></el-icon>{{ s.attachmentName }}
              </span>
            </div>
            <template v-if="s.answers">
              <div v-for="q in questions" :key="q.key" class="submission-qa">
                <div class="q-title">{{ q.key.toUpperCase() }}. {{ q.question }}</div>
                <div class="qa-answer">{{ s.answers[q.key] || '（未作答）' }}</div>
              </div>
            </template>
            <div v-else class="qa-answer">{{ s.content || '（仅附件，未粘贴文本）' }}</div>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { filesApi, projectsApi, retrospectivesApi, sopsApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';
import MarkdownView from '../components/MarkdownView.vue';

/** 结构化 5 问默认值（后端预置；详情 questions 为空时兜底展示） */
const STRUCTURED_DEFAULT_QUESTIONS = [
  { key: 'q1', question: '项目的预期目标是什么，达到了预期目标吗？' },
  { key: 'q2', question: '如果没达到预期目标，原因是什么？' },
  { key: 'q3', question: '有哪些成功的经验？' },
  { key: 'q4', question: '碰到了什么挑战，是如何解决的？' },
  { key: 'q5', question: '未来的工作中如何避坑？' },
];

const auth = useAuthStore();

const list = ref<any[]>([]);
const projects = ref<any[]>([]);
const loading = ref(false);
const summarizingId = ref('');

// ---- 新建 ----
const createVisible = ref(false);
const creating = ref(false);
const createForm = reactive({
  projectId: '',
  kind: 'STRUCTURED' as 'STRUCTURED' | 'GENERAL',
  title: '',
  deadline: null as string | null,
});

/** 可创建复盘的项目：管理员=全部；负责人=自己负责的项目 */
const creatableProjects = computed(() =>
  auth.isAdmin ? projects.value : projects.value.filter((p) => p.owner?.id === auth.user?.id),
);
const canCreate = computed(() => auth.isAdmin || creatableProjects.value.length > 0);

// ---- 详情 ----
const detailVisible = ref(false);
const detail = ref<any>(null);
const mySubmission = ref<any>(null);
const submittedUserIds = ref<Set<string>>(new Set());
const questions = ref<{ key: string; question: string }[]>([]);
const answers = reactive<Record<string, string>>({});
const generalText = ref('');
const generalFile = ref<{ name: string; key: string } | null>(null);
const submitting = ref(false);
const summarizing = ref(false);
const extracting = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const overdue = computed(() => {
  const d = detail.value?.deadline;
  return detail.value?.status === 'OPEN' && !!d && dayjs(d).isBefore(dayjs(), 'day');
});
const summaryByName = computed(
  () => detail.value?.project?.members?.find((m: any) => m.userId === detail.value?.summaryBy)?.user?.name
    || detail.value?.submissions?.find((s: any) => s.userId === detail.value?.summaryBy)?.user?.name
    || '负责人',
);

function canManage(r: any) {
  return auth.isAdmin || r.project?.ownerId === auth.user?.id || r.canManage === true;
}

async function loadProjects() {
  try {
    projects.value = await projectsApi.list();
  } catch {
    projects.value = [];
  }
}

async function load() {
  loading.value = true;
  try {
    list.value = await retrospectivesApi.list();
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createForm.projectId = creatableProjects.value[0]?.id || '';
  createForm.kind = 'STRUCTURED';
  createForm.title = '';
  createForm.deadline = null;
  createVisible.value = true;
}

async function create() {
  if (!createForm.projectId) {
    ElMessage.warning('请选择项目');
    return;
  }
  creating.value = true;
  try {
    await retrospectivesApi.create({
      projectId: createForm.projectId,
      kind: createForm.kind,
      title: createForm.title.trim() || undefined,
      deadline: createForm.deadline,
    });
    ElMessage.success(createForm.kind === 'STRUCTURED' ? '结构化复盘已创建，成员可开始回答 5 问' : '复盘已创建，成员可提交总结');
    createVisible.value = false;
    load();
  } finally {
    creating.value = false;
  }
}

async function openDetail(r: any) {
  detail.value = await retrospectivesApi.get(r.id);
  const my = detail.value?.submissions?.find((s: any) => s.userId === auth.user?.id);
  mySubmission.value = my || null;
  submittedUserIds.value = new Set(
    (detail.value?.submissions || []).map((s: any) => s.userId),
  );
  const qs: { key: string; question: string }[] =
    (detail.value?.questions as any[])?.length
      ? (detail.value?.questions as any[])
      : STRUCTURED_DEFAULT_QUESTIONS;
  questions.value = qs;
  qs.forEach((q) => {
    answers[q.key] = my?.answers?.[q.key] || '';
  });
  generalText.value = my?.content || '';
  generalFile.value = my?.attachmentKey && my?.attachmentName
    ? { name: my.attachmentName, key: my.attachmentKey }
    : null;
  detailVisible.value = true;
}

async function submitMine() {
  if (!detail.value) return;
  if (detail.value.kind === 'STRUCTURED') {
    const missing = questions.value.filter((q) => !answers[q.key]?.trim());
    if (missing.length) {
      ElMessage.warning(`请回答全部问题，未作答：${missing.map((q) => q.key.toUpperCase()).join('、')}`);
      return;
    }
  } else if (!generalText.value.trim() && !generalFile.value) {
    ElMessage.warning('请粘贴总结文本或上传文档（二选一或都填）');
    return;
  }
  submitting.value = true;
  try {
    await retrospectivesApi.submit(detail.value.id, {
      ...(detail.value.kind === 'STRUCTURED'
        ? { answers: Object.fromEntries(questions.value.map((q) => [q.key, answers[q.key].trim()])) }
        : {
            ...(generalText.value.trim() ? { content: generalText.value.trim() } : {}),
            ...(generalFile.value ? { attachment: generalFile.value } : {}),
          }),
    });
    ElMessage.success('复盘已提交');
    detailVisible.value = false;
    load();
  } finally {
    submitting.value = false;
  }
}

async function summarize(r: any) {
  const target = detailVisible.value && detail.value?.id === r.id ? detail.value : r;
  if (detailVisible.value && detail.value?.id === r.id) summarizing.value = true;
  else summarizingId.value = r.id;
  try {
    const updated: any = await retrospectivesApi.summarize(target.id);
    ElMessage.success('AI 汇总报告已生成');
    // 同步列表与详情
    if (detailVisible.value && detail.value?.id === r.id) {
      detail.value = { ...(detail.value ?? {}), ...updated, status: 'SUMMARIZED' };
    }
    load();
  } finally {
    summarizing.value = false;
    summarizingId.value = '';
  }
}

function pickFile() {
  fileInput.value?.click();
}

/** 从本轮回汇报告 AI 提取 SOP 候选（仅负责人/管理员；与已有 SOP 语义去重） */
async function extractSops() {
  if (!detail.value) return;
  extracting.value = true;
  try {
    const r: any = await sopsApi.extract(detail.value.id);
    // 后端返回 { created, skipped }；兼容旧数组形态
    const created: any[] = Array.isArray(r) ? r : (r?.created ?? []);
    const skipped: number = Array.isArray(r) ? 0 : (r?.skipped ?? 0);
    if (created.length) {
      ElMessage.success(`已提取 ${created.length} 条 SOP 候选，请到「SOP」页面确认${skipped ? `（${skipped} 条重复已跳过）` : ''}`);
    } else {
      ElMessage.info('未提取到新的 SOP（提炼项可能与已有 SOP 重复）');
    }
  } catch {
    /* 拦截器已提示 */
  } finally {
    extracting.value = false;
  }
}

async function onPickFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploading.value = true;
  try {
    const up: any = await filesApi.upload(file);
    generalFile.value = { name: up.fileName || file.name, key: up.fileKey };
    ElMessage.success('附件已上传');
  } catch (err) {
    console.warn('上传复盘附件失败', err);
    ElMessage.warning('附件上传失败：需要 MinIO 文件服务运行；否则请直接粘贴文本内容');
  } finally {
    uploading.value = false;
  }
}

onMounted(() => {
  load();
  loadProjects();
});
</script>

<style scoped>
.retro-list {
  min-height: 100px;
}
.retro-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 6px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
}
.retro-card:last-child {
  border-bottom: none;
}
.retro-card:hover {
  background: #f8fafc;
}
.retro-main {
  flex: 1;
  min-width: 0;
}
.retro-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.retro-title {
  font-size: 15px;
}
.retro-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  flex-wrap: wrap;
}
.proj-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ok {
  color: var(--el-color-success);
}
.todo {
  color: var(--el-color-warning);
}
.deadline-over {
  color: var(--el-color-danger);
  font-weight: 600;
}
.retro-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.detail-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  font-size: 13px;
  flex-wrap: wrap;
}
.block-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.summary-box {
  background: #fafbfc;
  border: 1px solid #eef0f3;
  border-radius: 8px;
  padding: 12px 14px;
}
.summary-by {
  font-size: 12px;
  font-weight: 400;
}
.markdown-box {
  font-size: 13px;
  line-height: 1.7;
}
.markdown-box :deep(p) {
  margin: 6px 0;
}
.empty-summary {
  background: #f6f8fa;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  color: #909399;
}
.closed-tip {
  margin-top: 14px;
  font-size: 13px;
}
.q-item {
  margin-bottom: 12px;
}
.q-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  line-height: 1.5;
}
.attach-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--el-color-primary);
  background: #ecf3ff;
  border-radius: 4px;
  padding: 3px 8px;
}
.attach-remove {
  cursor: pointer;
  color: #909399;
}
.attach-remove:hover {
  color: #f56c6c;
}
.attach-tip {
  font-size: 12px;
}
.submit-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.member-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.member-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f8fafc;
  border-radius: 16px;
  padding: 3px 8px 3px 3px;
  font-size: 13px;
}
.member-name {
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.submissions {
  margin-top: 16px;
}
.submission-box {
  border: 1px solid #eef0f3;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fdfdfd;
}
.submission-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 13px;
}
.submission-qa {
  margin-bottom: 8px;
}
.qa-answer {
  font-size: 13px;
  color: #606266;
  line-height: 1.7;
  white-space: pre-wrap;
}
.empty {
  text-align: center;
  padding: 30px 0;
}
</style>
