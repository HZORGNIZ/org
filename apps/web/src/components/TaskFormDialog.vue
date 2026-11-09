<template>
  <el-dialog
    :model-value="modelValue"
    :title="task ? '编辑任务' : '新建任务'"
    width="min(94vw, 580px)"
    @update:model-value="$emit('update:modelValue', $event)"
    @closed="reset"
  >
    <el-form :model="form" label-position="top" @submit.prevent>
      <el-form-item label="标题" required>
        <el-input v-model="form.title" maxlength="120" placeholder="任务标题" />
      </el-form-item>
      <el-form-item label="项目" required>
        <el-select v-model="form.projectId" style="width: 100%" @change="onProjectChange">
          <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="columns.length" label="看板列">
        <el-select v-model="form.columnId" style="width: 100%" clearable placeholder="选择列（新建默认待办）">
          <el-option v-for="c in columns" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </el-form-item>
      <div class="row">
        <el-form-item label="优先级" class="half">
          <el-radio-group v-model="form.priority">
            <el-radio-button value="LOW">低</el-radio-button>
            <el-radio-button value="MEDIUM">中</el-radio-button>
            <el-radio-button value="HIGH">高</el-radio-button>
            <el-radio-button value="URGENT">紧急</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="预估工时（小时）" class="half">
          <el-input-number v-model="form.estimateHours" :min="0" :precision="1" style="width: 100%" />
        </el-form-item>
      </div>
      <el-form-item label="负责人">
        <el-select
          v-model="form.assigneeId"
          style="width: 100%"
          clearable
          filterable
          placeholder="选择负责人"
        >
          <el-option v-for="u in memberOptions" :key="u.id" :label="u.name" :value="u.id" />
        </el-select>
      </el-form-item>
      <div class="row">
        <el-form-item label="起始时间" class="half">
          <el-date-picker
            v-model="form.startDate"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss"
            style="width: 100%"
            placeholder="选择起始时间"
          />
        </el-form-item>
        <el-form-item label="截止时间" class="half">
          <el-date-picker
            v-model="form.dueDate"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss"
            style="width: 100%"
            placeholder="选择截止时间"
          />
        </el-form-item>
      </div>
      <el-form-item v-if="props.task" label="完成进度">
        <el-slider v-model="form.progress" :min="0" :max="100" :step="5" show-input />
      </el-form-item>
      <el-form-item
        v-if="props.task && form.progress !== (props.task.progress ?? 0)"
        label="进展说明（调整进度必填）"
        required
      >
        <el-input
          v-model="form.progressNote"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          placeholder="必填：说明本次调整具体做了什么，不能只调进度"
        />
      </el-form-item>
      <el-form-item label="标签">
        <el-select
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          style="width: 100%"
          placeholder="输入后回车创建标签"
        />
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="form.description" type="textarea" :rows="4" placeholder="任务描述（支持 Markdown）" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="$emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { projectsApi, tasksApi } from '../api';

const props = defineProps<{
  modelValue: boolean;
  /** 编辑时传入任务对象；新建时传入默认 projectId */
  task?: any;
  defaultProjectId?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved'): void;
}>();

const projects = ref<any[]>([]);
const memberOptions = ref<any[]>([]); // 负责人候选：当前所选项目成员（负责人 + 成员），任务只对项目成员可见
const columns = ref<any[]>([]);
const saving = ref(false);

const form = reactive({
  title: '',
  projectId: '',
  columnId: null as string | null,
  priority: 'MEDIUM',
  assigneeId: null as string | null,
  startDate: null as string | null,
  dueDate: null as string | null,
  estimateHours: null as number | null,
  progress: 0 as number,
  progressNote: '',
  tags: [] as string[],
  description: '',
});

watch(
  () => props.modelValue,
  async (v) => {
    if (!v) return;
    if (!projects.value.length) {
      projects.value = await projectsApi.list();
    }
    if (props.task) {
      // 后端存 UTC ISO，表单用本地无时区格式展示编辑
      Object.assign(form, {
        title: props.task.title || '',
        projectId: props.task.projectId || '',
        columnId: props.task.columnId || null,
        priority: props.task.priority || 'MEDIUM',
        assigneeId: props.task.assigneeId || null,
        startDate: props.task.startDate ? dayjs(props.task.startDate).format('YYYY-MM-DDTHH:mm:ss') : null,
        dueDate: props.task.dueDate ? dayjs(props.task.dueDate).format('YYYY-MM-DDTHH:mm:ss') : null,
        estimateHours: props.task.estimateHours ?? null,
        progress: props.task.progress ?? 0,
        progressNote: '',
        tags: (props.task.tags || []).map((t: any) => t.name),
        description: props.task.description || '',
      });
      await loadColumns(props.task.projectId);
      // 编辑模式：当前负责人兜底保留（正常应在成员列表中）
      ensureAssigneeOption();
    } else {
      reset();
      form.projectId = props.defaultProjectId || projects.value[0]?.id || '';
      if (form.projectId) await loadColumns(form.projectId);
    }
  },
);

async function loadColumns(projectId: string) {
  if (!projectId) {
    columns.value = [];
    memberOptions.value = [];
    return;
  }
  const p = await projectsApi.get(projectId);
  columns.value = p.boards?.[0]?.columns || [];
  // 负责人候选同步为该项目成员（负责人 + 成员列表）
  memberOptions.value = [];
  if (p.owner) memberOptions.value.push({ id: p.owner.id, name: `${p.owner.name}（负责人）` });
  for (const m of p.members ?? []) {
    if (m.userId !== p.ownerId) memberOptions.value.push({ id: m.userId, name: m.user?.name });
  }
  // 新建任务默认落入第一个列（待办），保证任务在看板可见；编辑模式保持原列不变
  if (!props.task && !form.columnId && columns.value.length) {
    form.columnId = columns.value[0].id;
  }
}

/** 编辑模式兜底：原负责人若不在新成员列表（异常存量）也保留可选，避免下拉显示空白 */
function ensureAssigneeOption() {
  const a = props.task?.assignee;
  if (a && form.assigneeId && !memberOptions.value.some((o) => o.id === form.assigneeId)) {
    memberOptions.value.push({ id: a.id, name: a.name });
  }
}

function onProjectChange(projectId: string) {
  form.columnId = null;
  loadColumns(projectId);
}

function reset() {
  Object.assign(form, {
    title: '',
    projectId: '',
    columnId: null,
    priority: 'MEDIUM',
    assigneeId: null,
    startDate: null,
    dueDate: null,
    estimateHours: null,
    progress: 0,
    progressNote: '',
    tags: [],
    description: '',
  });
}

async function save() {
  if (!form.title.trim()) {
    ElMessage.warning('请输入任务标题');
    return;
  }
  if (!form.projectId) {
    ElMessage.warning('请选择项目');
    return;
  }
  // 进度 0-100 自由调整；实际发生变化时必须填写进展说明（不能只调进度）
  if (props.task && form.progress !== (props.task.progress ?? 0) && !form.progressNote.trim()) {
    ElMessage.warning('调整进度必须填写进展说明（具体做了什么）');
    return;
  }
  saving.value = true;
  try {
    // 本地无时区时间 → UTC ISO（按用户本地时区解析），后端存绝对时刻
    const toIso = (v: string | null) => (v ? new Date(v).toISOString() : null);
    const payload = {
      ...form,
      startDate: props.task ? toIso(form.startDate) : undefined,
      dueDate: toIso(form.dueDate),
      progress: props.task ? form.progress : undefined,
      note:
        props.task && form.progress !== (props.task.progress ?? 0) ? form.progressNote.trim() : undefined,
    };
    if (props.task) {
      await tasksApi.update(props.task.id, payload);
    } else {
      await tasksApi.create({ ...payload, startDate: toIso(form.startDate) });
    }
    ElMessage.success(props.task ? '任务已更新' : '任务已创建');
    emit('update:modelValue', false);
    emit('saved');
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.row {
  display: flex;
  gap: 12px;
}
.half {
  flex: 1;
  min-width: 0;
}
</style>
