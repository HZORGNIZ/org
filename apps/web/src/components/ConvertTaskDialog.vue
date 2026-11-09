<template>
  <!-- 从进展创建/关联任务：首页项目进展要点与项目详情进展通用 -->
  <el-dialog v-model="visible" title="从进展创建任务" width="min(94vw, 560px)">
    <div v-if="update" class="convert-src">
      <div class="convert-src-text">{{ sourceText || update.content }}</div>
      <div class="muted convert-src-meta">
        进展时间：{{ fmt(update.createdAt, 'YYYY-MM-DD HH:mm') }}
        <span v-if="update.groupName"> · 来源群：{{ update.groupName }}</span>
      </div>
    </div>
    <el-radio-group v-model="mode" class="convert-mode">
      <el-radio-button value="new">新建任务</el-radio-button>
      <el-radio-button value="link">关联已有任务</el-radio-button>
    </el-radio-group>

    <template v-if="mode === 'new'">
      <el-form label-position="top" size="small" class="convert-form">
        <el-form-item label="任务标题" required>
          <el-input v-model="newForm.title" maxlength="120" placeholder="请输入任务标题" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="newForm.description" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item label="起止日期">
          <div class="time-row">
            <el-date-picker
              v-model="newForm.startDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="起始日期（默认今天）"
              class="time-picker"
              :disabled-date="(d: Date) => !!newForm.dueDate && d.getTime() > new Date(newForm.dueDate + 'T00:00:00').getTime()"
              @change="onStartDateChange"
            />
            <el-date-picker
              v-model="newForm.dueDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="截止日期（默认次日）"
              class="time-picker"
              :disabled-date="(d: Date) => d.getTime() < new Date(newForm.startDate + 'T00:00:00').getTime()"
              @change="dueDateTouched = true"
            />
          </div>
          <div class="muted time-hint">起始日期默认当天，截止日期默认次日；均可调整</div>
        </el-form-item>
        <el-form-item label="目标看板列（可选）">
          <el-select v-model="newForm.columnId" clearable placeholder="不选则作为普通任务（可在看板中拖入）" style="width: 100%">
            <el-option v-for="c in flatColumns" :key="c.id" :label="c.label" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="指派给（可选）">
          <el-select v-model="newForm.assigneeId" clearable filterable placeholder="不指派" style="width: 100%">
            <el-option
              v-if="project.owner"
              :key="project.owner.id"
              :label="project.owner.name + '（负责人）'"
              :value="project.owner.id"
            />
            <el-option v-for="m in project.members || []" :key="m.userId" :label="m.user?.name" :value="m.userId" />
          </el-select>
        </el-form-item>
      </el-form>
    </template>

    <template v-else>
      <el-form label-position="top" size="small" class="convert-form">
        <el-form-item label="选择已有任务" required>
          <el-select
            v-model="linkTaskId"
            filterable
            placeholder="搜索并选择任务"
            style="width: 100%"
            :no-data-text="linkPool.length ? '无匹配任务' : '该项目暂无任务，请先新建任务'"
            @change="onPickTask"
          >
            <el-option v-for="t in linkPool" :key="t.id" :label="t.label" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="推进状态">
          <el-select v-model="linkStatus" style="width: 100%">
            <el-option label="保持不变" value="KEEP" />
            <el-option label="标记为进行中" value="IN_PROGRESS" />
            <el-option label="标记为已完成" value="DONE" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="linkTask" label="完成百分比">
          <el-slider v-model="linkProgress" :min="0" :max="100" :step="5" />
        </el-form-item>
      </el-form>
      <div class="muted convert-tip">提交后会把该进展作为评论记录到任务上，便于追溯来源</div>
    </template>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ mode === 'new' ? '创建任务' : '关联并记录' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { projectsApi, tasksApi } from '../api';
import { fmt } from '../utils/format';

const props = defineProps<{
  modelValue: boolean;
  /** 完整项目对象（需含 owner/members/boards） */
  project: any;
  /** 进展记录 */
  update?: any;
  /** 点击的要点文本（空则取进展正文） */
  sourceText?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'saved'): void }>();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

const mode = ref<'new' | 'link'>('new');
const submitting = ref(false);
const newForm = reactive({
  title: '',
  description: '',
  columnId: null as string | null,
  assigneeId: null as string | null,
  startDate: '',
  dueDate: '',
});
const linkTaskId = ref('');
const linkStatus = ref<string>('KEEP'); // KEEP / IN_PROGRESS / DONE
const linkProgress = ref(0);
/** 截止日期是否被用户手动调整过：未调整时跟随起始日期自动顺延 */
const dueDateTouched = ref(false);
const linkPool = ref<{ id: string; label: string; progress: number }[]>([]);
const linkTask = computed(() => linkPool.value.find((t) => t.id === linkTaskId.value));

/** 项目全部看板列（平铺） */
const flatColumns = computed(() =>
  (props.project?.boards ?? []).flatMap((b: any) =>
    (b.columns ?? []).map((c: any) => ({ id: c.id, label: `${b.name} / ${c.name}` })),
  ),
);

/** 打开时（弹窗显示）初始化表单 */
watch(visible, (v) => {
  if (!v) return;
  const content = String(props.update?.content ?? '').trim();
  const text = (props.sourceText ?? content).trim();
  mode.value = 'new';
  // 标题取要点/正文首行，截断 40 字；描述附进展全文与来源
  newForm.title = (text.split('\n')[0] || '').slice(0, 40) || '跟进群聊进展';
  newForm.description = buildDescription(text);
  newForm.columnId = null;
  newForm.assigneeId = null;
  // 起始日期默认当天（精确到天，不含时分）；截止日期默认起始日期次日
  const now = new Date();
  newForm.startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  newForm.dueDate = addDays(newForm.startDate, 1);
  dueDateTouched.value = false;
  linkTaskId.value = '';
  linkStatus.value = 'KEEP';
  linkProgress.value = 0;
  refreshLinkPool();
});

/** 日期字符串 + n 天（YYYY-MM-DD） */
function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 调整起始日期时，截止日期若未被手动改过则跟随为「起始日期 + 1 天」 */
function onStartDateChange(v: string) {
  if (!dueDateTouched.value && v) newForm.dueDate = addDays(v, 1);
}

function close() {
  visible.value = false;
}

/** 组装任务描述：进展全文 + 来源与要点 */
function buildDescription(text: string) {
  const u = props.update;
  if (!u) return text;
  const meta = `转自「${props.project?.name ?? ''}」进展总结${u.groupName ? `（钉钉群：${u.groupName}）` : ''} · ${fmt(u.createdAt, 'YYYY-MM-DD HH:mm')}`;
  const kps = u.keyPoints?.length ? `\n要点：${u.keyPoints.join('；')}` : '';
  return `${u.content || text}${kps}\n\n---\n${meta}`;
}

/** 当前项目全部任务候选（看板列内 + 接口补全无列任务） */
async function refreshLinkPool() {
  const colNames = new Map<string, string>();
  for (const b of props.project?.boards ?? []) {
    for (const c of b.columns ?? []) colNames.set(c.id, c.name);
  }
  const rows: { id: string; label: string; progress: number }[] = [];
  const seen = new Set<string>();
  for (const b of props.project?.boards ?? []) {
    for (const c of b.columns ?? []) {
      for (const t of c.tasks ?? []) {
        rows.push({ id: t.id, label: `[${c.name}] ${t.title}`, progress: t.progress ?? 0 });
        seen.add(t.id);
      }
    }
  }
  try {
    const all: any[] = await tasksApi.list({ projectId: props.project?.id });
    for (const t of all) {
      if (seen.has(t.id)) continue;
      const colName = t.columnId ? colNames.get(t.columnId) : undefined;
      rows.push({ id: t.id, label: `[${colName ?? '无列'}] ${t.title}`, progress: t.progress ?? 0 });
    }
  } catch {
    /* 拉取失败时保留看板列内任务候选 */
  }
  linkPool.value = rows;
}

/** 选中任务后：进度默认保持任务当前值（可上下自由调整），已完成状态回退为保持 */
function onPickTask() {
  linkProgress.value = linkTask.value?.progress ?? 0;
  if (linkStatus.value === 'DONE') linkStatus.value = 'KEEP';
}

/** 提交：新建任务（带起止时间）或 关联任务（推进状态/进度 + 评论留痕） */
async function submit() {
  if (mode.value === 'new') {
    if (!newForm.title.trim()) {
      ElMessage.warning('请填写任务标题');
      return;
    }
    submitting.value = true;
    try {
      // 本地日期字符串 → UTC ISO（按用户本地时区解析为当天 0 点），后端存绝对时刻
      const toIso = (v: string) => (v ? new Date(`${v}T00:00:00`).toISOString() : undefined);
      const created: any = await tasksApi.create({
        projectId: props.project.id,
        title: newForm.title.trim(),
        description: newForm.description.trim(),
        columnId: newForm.columnId || undefined,
        assigneeId: newForm.assigneeId || undefined,
        startDate: toIso(newForm.startDate),
        dueDate: toIso(newForm.dueDate),
      });
      // 回链：标记该进展已转为任务（已转任务的条目在列表中以蓝色区分；失败不影响任务创建）
      if (props.update?.id && created?.id) {
        try {
          await projectsApi.linkUpdateTask(props.update.id, created.id);
        } catch {
          /* 回链失败不阻断主流程 */
        }
      }
      ElMessage.success('任务已创建，可在看板/任务页查看');
      visible.value = false;
      emit('saved');
    } finally {
      submitting.value = false;
    }
    return;
  }

  // 关联模式
  if (!linkTaskId.value) {
    ElMessage.warning('请选择要关联的任务');
    return;
  }
  submitting.value = true;
  try {
    const u = props.update;
    const patch: any = {};
    if (linkStatus.value === 'DONE') {
      patch.status = 'DONE';
      patch.progress = 100;
    } else {
      if (linkStatus.value === 'IN_PROGRESS') patch.status = 'IN_PROGRESS';
      // 进度可上下自由调整：与任务当前值不同才提交
      if (linkProgress.value !== (linkTask.value?.progress ?? 0)) patch.progress = linkProgress.value;
    }
    // 进度调整必须带说明：默认取进展原文前 100 字，无则用通用说明
    if ('progress' in patch) {
      patch.note = (props.sourceText || u?.content || '').trim().slice(0, 100) || '关联项目进展，更新任务进度';
    }
    if (Object.keys(patch).length) await tasksApi.update(linkTaskId.value, patch);
    const comment = `【来自项目进展·${u?.groupName ?? '进展总结'} ${fmt(u?.createdAt ?? new Date(), 'YYYY-MM-DD HH:mm')}】${props.sourceText || u?.content || ''}`;
    await tasksApi.comment(linkTaskId.value, comment);
    // 回链：标记该进展已转为任务（已转任务的条目在列表中以蓝色区分；失败不影响主流程）
    if (u?.id) {
      try {
        await projectsApi.linkUpdateTask(u.id, linkTaskId.value);
      } catch {
        /* 回链失败不阻断主流程 */
      }
    }
    ElMessage.success('已关联任务并记录评论');
    visible.value = false;
    emit('saved');
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.convert-src {
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.convert-src-text {
  font-size: 13px;
  line-height: 1.6;
  color: #303133;
  max-height: 96px;
  overflow: auto;
}
.convert-src-meta {
  font-size: 12px;
  margin-top: 6px;
}
.convert-mode {
  margin-bottom: 4px;
}
.convert-tip {
  font-size: var(--fs-xs);
  margin-top: -2px;
}
.time-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
}
.time-picker {
  width: 100%;
}
/* 覆盖 Element Plus 日期编辑器默认固定 220px：否则手机上起止日期行撑破弹窗、截止框超出屏幕 */
.time-row :deep(.el-date-editor.el-input),
.time-row :deep(.el-date-editor.el-input__wrapper) {
  width: 100%;
  min-width: 0;
}
.time-hint {
  font-size: 12px;
  margin-top: 2px;
}
</style>
