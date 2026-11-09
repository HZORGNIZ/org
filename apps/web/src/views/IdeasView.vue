<template>
  <div class="page">
    <div class="page-title">
      灵感 · 需求
      <el-button type="primary" @click="composerVisible = true">
        <el-icon><Plus /></el-icon>&nbsp;记一条灵感
      </el-button>
    </div>

    <!-- 记灵感（文字 + 语音） -->
    <div v-if="composerVisible" class="page-card composer">
      <el-input
        ref="ideaInputRef"
        v-model="newIdea"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        placeholder="记下一个想法 / 需求 / 待办点，稍后可与团队一起规划为项目或任务…"
      />
      <div class="composer-tools">
        <el-button
          :type="listening ? 'danger' : 'default'"
          :class="{ 'voice-pulse': listening }"
          :disabled="!srSupported"
          circle
          title="按住说话，松开结束"
          @mousedown.prevent="startVoice"
          @mouseup.prevent="stopVoice"
          @mouseleave.prevent="stopVoice"
          @touchstart.prevent="startVoice"
          @touchend.prevent="stopVoice"
          @touchcancel.prevent="stopVoice"
        >
          <el-icon :size="18"><Microphone /></el-icon>
        </el-button>
        <span v-if="listening" class="voice-tip listening">正在聆听…松开结束</span>
        <span v-else-if="!srSupported" class="muted voice-tip">当前浏览器不支持语音，请用 Chrome/Edge</span>
        <span v-else class="voice-tip"></span>
        <el-button text @click="composerVisible = false">收起</el-button>
        <el-button type="primary" :loading="savingIdea" @click="addIdea">保存</el-button>
      </div>
    </div>

    <!-- 灵感分组：普通成员看三组，管理员多一组全组织 -->
    <div v-loading="loading">
      <div v-for="sec in sections" :key="sec.key" class="page-card section">
        <div class="section-head">
          <span class="section-title">{{ sec.title }}</span>
          <span class="section-count">{{ sec.items.length }}</span>
          <el-checkbox
            v-if="sec.items.length"
            :model-value="allChecked(sec)"
            :indeterminate="someChecked(sec)"
            class="sel-all"
            @change="(v: any) => toggleSection(sec, !!v)"
          >全选</el-checkbox>
        </div>
        <div v-if="!sec.items.length" class="muted empty">{{ sec.emptyText }}</div>
        <div
          v-for="idea in sec.items"
          :key="idea.id"
          class="idea"
          :class="{ picked: selected.has(idea.id) }"
        >
          <el-checkbox :model-value="selected.has(idea.id)" @change="() => toggleIdea(idea.id)" />
          <div class="idea-body" @click="() => toggleIdea(idea.id)">
            <div class="idea-content">{{ idea.content }}</div>
            <div class="idea-meta">
              <el-tag size="small" effect="plain" :type="idea.status === 'CONVERTED' ? 'success' : 'info'">
                {{ idea.status === 'CONVERTED' ? '已转项目/任务' : 'NEW' }}
              </el-tag>
              <span class="muted">{{ idea.author?.name }}</span>
              <span class="muted">{{ timeAgo(idea.createdAt) }}</span>
              <el-tag v-if="idea.project?.name" size="small" type="primary" effect="plain">{{ idea.project.name }}</el-tag>
            </div>
          </div>
          <el-button
            v-if="idea.authorId === auth.user?.id || auth.isAdmin"
            text
            type="danger"
            size="small"
            @click.stop="removeIdea(idea.id)"
          >删除</el-button>
        </div>
      </div>
    </div>

    <!-- 底部操作栏：选中后可 AI 规划 -->
    <div v-if="selected.size" class="action-bar">
      <span class="muted">已选 {{ selected.size }} 条灵感</span>
      <el-button text @click="selected.clear()">取消选择</el-button>
      <el-button type="primary" :loading="planning" @click="openPlan">AI 规划项目 / 任务</el-button>
    </div>

    <!-- 规划预览 -->
    <el-dialog v-model="planVisible" title="AI 规划预览" width="min(94vw, 720px)" :close-on-click-modal="false">
      <div v-if="!proposal.projects.length && !proposal.tasks.length" class="muted">
        {{ planMessage || '暂无可创建的提议' }}
      </div>

      <div v-if="canCreateProject && proposal.projects.length" class="plan-block">
        <div class="plan-block-title">建议新建的项目（仅部门负责人 / 管理员可创建）</div>
        <div v-for="(p, i) in proposal.projects" :key="'p' + i" class="plan-project">
          <el-checkbox v-model="p.include">创建该项目</el-checkbox>
          <el-input v-model="p.name" size="small" placeholder="项目名" class="plan-name" />
          <el-input v-model="p.description" size="small" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" placeholder="项目说明" />
          <div v-if="p.ideaIds?.length" class="plan-ideas">来源灵感 {{ p.ideaIds.length }} 条</div>
        </div>
      </div>

      <div v-if="proposal.tasks.length" class="plan-block">
        <div class="plan-block-title">建议新建的任务</div>
        <div v-for="(t, i) in proposal.tasks" :key="'t' + i" class="plan-task">
          <el-checkbox v-model="t.include" />
          <div class="plan-task-main">
            <el-input v-model="t.title" size="small" placeholder="任务标题" />
            <div class="plan-task-row">
              <el-select v-model="t.projectKey" size="small" placeholder="归属项目" class="plan-proj-sel">
                <el-option v-for="opt in projectOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
              <el-date-picker
                v-model="t.dueDate"
                type="date"
                size="small"
                value-format="YYYY-MM-DD"
                placeholder="截止"
                class="plan-date"
              />
              <el-select v-model="t.priority" size="small" placeholder="优先级" class="plan-pri">
                <el-option label="低" value="LOW" />
                <el-option label="中" value="MEDIUM" />
                <el-option label="高" value="HIGH" />
                <el-option label="紧急" value="URGENT" />
              </el-select>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="planVisible = false">取消</el-button>
        <el-button type="primary" :loading="committing" :disabled="!hasIncludable" @click="doCommit">确认创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ideasApi, projectsApi } from '../api';
import { timeAgo } from '../utils/format';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();

const loading = ref(false);
const groups = ref<{ mine: any[]; sameProject: any[]; sameDept: any[]; others: any[] }>({
  mine: [],
  sameProject: [],
  sameDept: [],
  others: [],
});
const myProjects = ref<any[]>([]);

const composerVisible = ref(false);
const newIdea = ref('');
const savingIdea = ref(false);
const ideaInputRef = ref<any>(null);

const selected = reactive(new Set<string>());

const canCreateProject = computed(() => auth.roleRank >= 2); // DEPT_LEADER / ADMIN

/** 管理员不只看同项目 / 同部门，另给一组「全部灵感」覆盖全组织（后端 ADMIN 分支会把 others 填上） */
const sections = computed(() => {
  const mine = { key: 'mine', title: '我的灵感', items: groups.value.mine, emptyText: '还没有记录灵感，点右上角「记一条灵感」开始' };
  if (auth.isAdmin) {
    return [mine, { key: 'others', title: '全部灵感 · 其他成员', items: groups.value.others, emptyText: '其他成员还没有灵感' }];
  }
  return [
    mine,
    { key: 'sameProject', title: '同项目组', items: groups.value.sameProject, emptyText: '同项目组成员暂无灵感' },
    { key: 'sameDept', title: '同部门', items: groups.value.sameDept, emptyText: '同部门成员暂无灵感' },
  ];
});

function allChecked(sec: { items: any[] }) {
  return sec.items.length > 0 && sec.items.every((i) => selected.has(i.id));
}
function someChecked(sec: { items: any[] }) {
  return sec.items.some((i) => selected.has(i.id)) && !allChecked(sec);
}
function toggleSection(sec: { items: any[] }, checked: boolean) {
  for (const i of sec.items) (checked ? selected.add(i.id) : selected.delete(i.id));
}
function toggleIdea(id: string) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
}

// ---------- 语音（Web Speech API，复用首页录入同款逻辑） ----------
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
const srSupported =
  typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
let recognition: SpeechRecognitionLike | null = null;
let confirmedText = '';
let interimBuffer = '';
const listening = ref(false);

function startVoice() {
  if (!srSupported || listening.value) return;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR() as SpeechRecognitionLike;
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  confirmedText = newIdea.value;
  interimBuffer = '';
  recognition.onresult = (e: any) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) confirmedText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    interimBuffer = interim;
    newIdea.value = confirmedText + interim;
  };
  recognition.onerror = (e: any) => {
    listening.value = false;
    ElMessage.warning('语音识别出错：' + (e?.error || '未知'));
  };
  recognition.onend = () => {
    listening.value = false;
    if (interimBuffer) {
      confirmedText += interimBuffer;
      interimBuffer = '';
      newIdea.value = confirmedText;
    }
  };
  recognition.start();
  listening.value = true;
}
function stopVoice() {
  if (listening.value) recognition?.stop();
}

// ---------- 增删灵感 ----------
async function addIdea() {
  const text = newIdea.value.trim();
  if (!text) {
    ElMessage.warning('请先输入或说出灵感内容');
    return;
  }
  savingIdea.value = true;
  try {
    await ideasApi.create(text);
    ElMessage.success('灵感已记录');
    newIdea.value = '';
    composerVisible.value = false;
    load();
  } finally {
    savingIdea.value = false;
  }
}
async function removeIdea(id: string) {
  try {
    await ElMessageBox.confirm('确定删除这条灵感？', '删除灵感', { type: 'warning' });
  } catch {
    return;
  }
  await ideasApi.remove(id);
  selected.delete(id);
  ElMessage.success('已删除');
  load();
}

// ---------- AI 规划 ----------
interface PlanProject {
  name: string;
  description: string;
  ideaIds: string[];
  include: boolean;
}
interface PlanTask {
  title: string;
  description?: string;
  dueDate: string | null;
  priority: string;
  ideaIds: string[];
  projectKey: string; // existing:<id> | new:<origIndex>
  include: boolean;
}
const planning = ref(false);
const planVisible = ref(false);
const planMessage = ref('');
const committing = ref(false);
const proposal = reactive<{ projects: PlanProject[]; tasks: PlanTask[] }>({ projects: [], tasks: [] });

/** 任务归属项目下拉：已有项目 + 本次拟新建项目（仅负责人/管理员可见新建项） */
const projectOptions = computed(() => {
  const opts = myProjects.value.map((p) => ({ value: `existing:${p.id}`, label: p.name }));
  if (canCreateProject.value) {
    proposal.projects.forEach((p, i) => opts.push({ value: `new:${i}`, label: `（新建）${p.name || '未命名项目'}` }));
  }
  return opts;
});

const hasIncludable = computed(
  () => proposal.projects.some((p) => p.include) || proposal.tasks.some((t) => t.include),
);

async function openPlan() {
  planning.value = true;
  try {
    const res = await ideasApi.plan([...selected]);
    planMessage.value = res.message || '';
    proposal.projects = (res.projects || []).map((p: any) => ({
      name: p.name || '',
      description: p.description || '',
      ideaIds: p.ideaIds || [],
      include: true,
    }));
    proposal.tasks = (res.tasks || []).map((t: any) => ({
      title: t.title || '',
      description: t.description || '',
      dueDate: t.dueDate || null,
      priority: t.priority || 'MEDIUM',
      ideaIds: t.ideaIds || [],
      projectKey: resolveIncomingProjectKey(t.projectId),
      include: true,
    }));
    if (!res.ok) planMessage.value = res.message || 'AI 规划暂时不可用';
    planVisible.value = true;
  } finally {
    planning.value = false;
  }
}

/** 将 AI 返回的 projectId（已有 id 或 new: 前缀）归一为下拉 key */
function resolveIncomingProjectKey(raw?: string): string {
  const v = (raw || '').trim();
  if (!v) return myProjects.value[0] ? `existing:${myProjects.value[0].id}` : '';
  if (v.startsWith('new:')) {
    if (!canCreateProject.value) return myProjects.value[0] ? `existing:${myProjects.value[0].id}` : '';
    return v;
  }
  // 视为已有项目 id
  if (myProjects.value.some((p) => p.id === v)) return `existing:${v}`;
  return myProjects.value[0] ? `existing:${myProjects.value[0].id}` : '';
}

async function doCommit() {
  const includedProjects = proposal.projects.filter((p) => p.include && p.name.trim());
  // 原始 new index → 提交后 index
  const indexMap = new Map<number, number>();
  proposal.projects.forEach((p, orig) => {
    if (p.include && p.name.trim()) indexMap.set(orig, indexMap.size);
  });

  const tasksPayload = proposal.tasks
    .filter((t) => t.include && t.title.trim())
    .map((t) => {
      let projectId: string | undefined;
      if (t.projectKey.startsWith('existing:')) projectId = t.projectKey.slice('existing:'.length);
      else if (t.projectKey.startsWith('new:')) {
        const orig = Number(t.projectKey.slice('new:'.length));
        const ci = indexMap.get(orig);
        projectId = ci != null ? `__new${ci}__` : undefined;
      }
      return {
        title: t.title.trim(),
        description: t.description,
        dueDate: t.dueDate || null,
        priority: t.priority,
        ideaIds: t.ideaIds,
        projectId,
      };
    })
    .filter((t) => t.projectId);

  if (!includedProjects.length && !tasksPayload.length) {
    ElMessage.warning('请至少勾选一个可创建的项目或任务');
    return;
  }
  committing.value = true;
  try {
    const res = await ideasApi.commit({
      projects: includedProjects.map((p) => ({ name: p.name.trim(), description: p.description, ideaIds: p.ideaIds })),
      tasks: tasksPayload,
    });
    ElMessage.success(`已创建 ${res.projects.length} 个项目、${res.tasks.length} 个任务`);
    planVisible.value = false;
    selected.clear();
    load();
  } finally {
    committing.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    const [g, ps] = await Promise.all([ideasApi.list(), projectsApi.list().catch(() => [])]);
    groups.value = g;
    myProjects.value = ps as any[];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
});
</script>

<style scoped>
.composer {
  padding: 12px 14px;
}
.composer-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.voice-tip {
  font-size: 12px;
  flex: 1;
}
.voice-tip.listening {
  color: #f56c6c;
  font-weight: 600;
}
.voice-pulse {
  animation: voicePulse 1.2s ease-in-out infinite;
}
@keyframes voicePulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.5);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(245, 108, 108, 0);
  }
}
.section {
  margin-bottom: 12px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.section-title {
  font-size: var(--fs-lg);
  font-weight: 600;
}
/* 计数徽章统一走 styles.css 的 .section-count 全局档 */
.sel-all {
  margin-left: auto;
}
.idea {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 8px;
  border-bottom: 1px solid #f5f7fa;
  border-radius: 8px;
  transition: background 0.15s;
}
.idea:last-child {
  border-bottom: none;
}
.idea.picked {
  background: #f0f7ff;
}
.idea-body {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.idea-content {
  font-size: 14px;
  color: #303133;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.idea-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  flex-wrap: wrap;
}
.empty {
  padding: 16px 0;
  font-size: 13px;
}
.action-bar {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 14px;
  margin-top: 12px;
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.06);
}
.action-bar .muted {
  margin-right: auto;
}
.plan-block {
  margin-bottom: 16px;
}
.plan-block-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
}
.plan-project {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  margin-bottom: 10px;
}
.plan-name {
  max-width: 320px;
}
.plan-ideas {
  font-size: 12px;
  color: #909399;
}
.plan-task {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  margin-bottom: 10px;
}
.plan-task-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-task-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.plan-proj-sel {
  width: 200px;
}
.plan-date {
  width: 150px;
}
.plan-pri {
  width: 100px;
}
</style>
