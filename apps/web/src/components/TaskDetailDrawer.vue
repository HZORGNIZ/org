<template>
  <el-drawer
    :model-value="modelValue"
    :title="task?.title || '任务详情'"
    size="min(94vw, 480px)"
    @update:model-value="$emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-loading="loading">
      <template v-if="task">
        <!-- 更新记录（置顶展示变更明细；默认最近 5 条可展开；负责人/部门负责人/管理员可删单条，不可编辑） -->
        <div class="block first-block">
          <div class="block-title">更新记录</div>
          <el-timeline v-if="activities.length">
            <el-timeline-item v-for="a in visibleActivities" :key="a.id" :timestamp="fmtShort(a.createdAt)" size="small">
              <div class="act-head">
                <b>{{ a.user?.name || '某人' }}</b>
                <span class="act-action">{{ actionLabel(a) }}</span>
                <el-button
                  v-if="canDeleteActivity"
                  class="act-del"
                  text
                  type="danger"
                  size="small"
                  @click="removeActivityItem(a)"
                >删除</el-button>
              </div>
              <div v-if="activityLines(a, userMap).length" class="act-lines">
                <div v-for="(line, i) in activityLines(a, userMap)" :key="i" class="act-line" :class="{ note: line.note }">
                  {{ line.text }}
                </div>
              </div>
            </el-timeline-item>
          </el-timeline>
          <div v-else class="muted empty">暂无记录</div>
          <el-button
            v-if="activities.length > 5"
            class="acts-toggle"
            text
            type="primary"
            size="small"
            @click="showAllActs = !showAllActs"
          >
            {{ showAllActs ? '收起' : '查看全部 ' + activities.length + ' 条' }}
          </el-button>
        </div>

        <!-- 状态与核心字段 -->
        <div class="actions">
          <el-select v-model="task.status" style="width: 130px" @change="patch({ status: task.status })">
            <el-option v-for="(v, k) in TASK_STATUS" :key="k" :label="v.label" :value="k" />
          </el-select>
          <el-select v-model="task.priority" style="width: 110px" @change="patch({ priority: task.priority })">
            <el-option v-for="(v, k) in TASK_PRIORITY" :key="k" :label="v.label" :value="k" />
          </el-select>
          <el-button type="danger" plain size="small" :disabled="deleting" @click="remove">删除</el-button>
        </div>

        <el-descriptions :column="1" class="info">
          <el-descriptions-item label="项目">
            {{ task.project?.name || '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="负责人">
            <el-select
              v-model="task.assigneeId"
              size="small"
              filterable
              clearable
              placeholder="未指派"
              style="width: 100%"
              @change="patch({ assigneeId: task.assigneeId || null })"
            >
              <el-option v-for="u in assigneeOptions" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-descriptions-item>
          <el-descriptions-item label="起始">
            <el-date-picker
              v-model="startEdit"
              type="datetime"
              size="small"
              value-format="YYYY-MM-DDTHH:mm:ss"
              placeholder="未设置"
              style="width: 100%"
              @change="patchDate('startDate', startEdit)"
            />
          </el-descriptions-item>
          <el-descriptions-item label="截止">
            <el-date-picker
              v-model="dueEdit"
              type="datetime"
              size="small"
              value-format="YYYY-MM-DDTHH:mm:ss"
              placeholder="未设置"
              style="width: 100%"
              @change="patchDate('dueDate', dueEdit)"
            />
          </el-descriptions-item>
          <el-descriptions-item label="完成进度">
            <div class="progress-cell">
              <el-slider
                v-model="progressEdit"
                :min="0"
                :max="100"
                :step="5"
                :show-tooltip="true"
                @change="askProgressNote"
              />
              <el-input-number
                v-model="progressEdit"
                :min="0"
                :max="100"
                :step="1"
                size="small"
                controls-position="right"
                style="width: 110px"
                @change="askProgressNote"
              />
            </div>
            <div class="muted progress-tip">进度可上下调整；每次调整需填写进展说明</div>
          </el-descriptions-item>
          <el-descriptions-item label="预估工时">
            {{ task.estimateHours ?? '-' }} h
          </el-descriptions-item>
        </el-descriptions>

        <div v-if="task.tags?.length" class="tags">
          <el-tag v-for="t in task.tags" :key="t.id" size="small" class="tag">{{ t.name }}</el-tag>
        </div>

        <div v-if="task.description" class="block">
          <div class="block-title">描述</div>
          <MarkdownView :content="task.description" />
        </div>

        <!-- 评论 -->
        <div class="block">
          <div class="block-title">评论</div>
          <div v-for="c in task.comments" :key="c.id" class="comment">
            <div class="comment-head">
              <b>{{ c.author?.name }}</b>
              <span class="muted">{{ timeAgo(c.createdAt) }}</span>
            </div>
            <div class="comment-body">{{ c.content }}</div>
          </div>
          <div v-if="!task.comments?.length" class="muted empty">暂无评论</div>
          <div class="comment-add">
            <el-input v-model="newComment" size="small" type="textarea" :rows="2" placeholder="写下评论…" />
            <el-button size="small" type="primary" :disabled="!newComment.trim()" @click="addComment">发送</el-button>
          </div>
        </div>

        <!-- 调整进度必填进展说明 -->
        <el-dialog
          v-model="progressNoteVisible"
          title="调整完成进度"
          width="min(92vw, 440px)"
          append-to-body
          :close-on-click-modal="false"
          :close-on-press-escape="false"
        >
          <div class="note-range">
            进度将从 <b>{{ task?.progress ?? 0 }}%</b> 调整为 <b>{{ progressEdit }}%</b>
          </div>
          <el-input
            v-model="progressNote"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="必填：说明本次调整具体做了什么，不能只调进度"
          />
          <template #footer>
            <el-button @click="cancelProgressNote">取消</el-button>
            <el-button type="primary" :loading="progressSaving" @click="submitProgressNote">确认调整</el-button>
          </template>
        </el-dialog>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { tasksApi, usersApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { TASK_PRIORITY, TASK_STATUS, fmtShort, timeAgo } from '../utils/format';
import { actionLabel, activityLines } from '../utils/taskActivity';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ modelValue: boolean; taskId: string | null }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'changed'): void }>();

const auth = useAuthStore();
const task = ref<any>(null);
const loading = ref(false);
const deleting = ref(false);
const activities = ref<any[]>([]);
const newComment = ref('');
const users = ref<any[]>([]);
// 更新记录默认收起只展示最近 5 条，可展开全部
const showAllActs = ref(false);
const userMap = computed(() => new Map(users.value.map((u: any) => [u.id, u.name])));
/** 负责人候选：仅限项目成员（任务只对项目成员可见）；当前负责人异常不在成员列表时兜底保留展示 */
const assigneeOptions = computed(() => {
  const p = task.value?.project;
  if (!p) return [];
  const opts: { id: string; name: string }[] = [];
  if (p.owner) opts.push({ id: p.owner.id, name: `${p.owner.name}（负责人）` });
  for (const m of p.members ?? []) {
    if (m.userId !== p.ownerId) {
      opts.push({ id: m.userId, name: m.user?.name || userMap.value.get(m.userId) || '成员' });
    }
  }
  const cur = task.value?.assignee;
  if (cur && !opts.some((o) => o.id === cur.id)) opts.push({ id: cur.id, name: cur.name });
  return opts;
});
const visibleActivities = computed(() => (showAllActs.value ? activities.value : activities.value.slice(0, 5)));
// 调整进度时必填的进展说明
const progressNoteVisible = ref(false);
const progressNote = ref('');
const progressSaving = ref(false);

// 行内编辑模型：后端存 UTC ISO，编辑用本地无时区格式
const startEdit = ref<string | null>(null);
const dueEdit = ref<string | null>(null);
const progressEdit = ref(0);

/** 可删除活动记录：项目负责人 / 主要关联部门负责人 / 系统管理员（记录不可编辑） */
const canDeleteActivity = computed(() => {
  if (!auth.user) return false;
  const p = task.value?.project;
  if (!p) return false;
  if (auth.isAdmin || p.ownerId === auth.user.id) return true;
  return (p.departments || []).some((link: any) => link.department?.leaderId === auth.user?.id);
});

async function load() {
  if (!props.taskId) return;
  loading.value = true;
  try {
    if (!users.value.length) {
      try {
        users.value = await usersApi.list();
      } catch {
        /* 人员列表拉取失败不阻塞详情 */
      }
    }
    task.value = await tasksApi.get(props.taskId);
    startEdit.value = task.value.startDate ? dayjs(task.value.startDate).format('YYYY-MM-DDTHH:mm:ss') : null;
    dueEdit.value = task.value.dueDate ? dayjs(task.value.dueDate).format('YYYY-MM-DDTHH:mm:ss') : null;
    progressEdit.value = task.value.progress ?? 0;
    activities.value = await tasksApi.activities(props.taskId);
    showAllActs.value = false;
  } finally {
    loading.value = false;
  }
}

async function patch(data: any) {
  await tasksApi.update(props.taskId!, data);
  await load();
  emit('changed');
}

/** 起止时间本地格式 → UTC ISO 提交 */
async function patchDate(field: 'startDate' | 'dueDate', value: string | null) {
  if (!value) {
    await patch({ [field]: null });
    return;
  }
  await patch({ [field]: new Date(value).toISOString() });
}

/** 进度 0-100 自由调整：值变化时弹出必填进展说明 */
function askProgressNote() {
  const prev = task.value?.progress ?? 0;
  if (progressEdit.value === prev) return;
  if (progressEdit.value < 0) progressEdit.value = 0;
  if (progressEdit.value > 100) progressEdit.value = 100;
  progressNote.value = '';
  progressNoteVisible.value = true;
}

/** 取消：回滚到服务器当前值并关闭弹窗 */
function cancelProgressNote() {
  progressEdit.value = task.value?.progress ?? 0;
  progressNoteVisible.value = false;
}

/** 确认：带进展说明提交进度调整（说明必填，不能只调进度） */
async function submitProgressNote() {
  const note = progressNote.value.trim();
  if (!note) {
    ElMessage.warning('请填写进展说明（具体做了什么）');
    return;
  }
  progressSaving.value = true;
  try {
    await patch({ progress: progressEdit.value, note });
    progressNoteVisible.value = false;
  } finally {
    progressSaving.value = false;
  }
}

async function remove() {
  await ElMessageBox.confirm('确定删除该任务？', '删除任务', { type: 'warning' });
  deleting.value = true;
  try {
    await tasksApi.remove(props.taskId!);
    ElMessage.success('已删除');
    emit('update:modelValue', false);
    emit('changed');
  } finally {
    deleting.value = false;
  }
}

// ---- 评论 ----
async function addComment() {
  if (!newComment.value.trim()) return;
  await tasksApi.comment(props.taskId!, newComment.value.trim());
  newComment.value = '';
  await load();
}

// 活动文案逻辑已统一迁移至 utils/taskActivity（actionLabel/activityLines/prettyVal）

/** 删除单条活动记录（按钮仅负责人/部门负责人/管理员可见） */
async function removeActivityItem(a: any) {
  await ElMessageBox.confirm('删除该活动记录后不可恢复，确定删除？', '删除活动记录', { type: 'warning' });
  await tasksApi.removeActivity(props.taskId!, a.id);
  ElMessage.success('已删除');
  await load();
}
</script>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.info {
  margin-bottom: 4px;
}
.progress-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.progress-cell .el-slider {
  flex: 1;
}
.progress-tip {
  font-size: 12px;
  margin-top: 2px;
  color: #909399;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}
.tag {
  margin-right: 0;
}
.block {
  margin-top: 18px;
  border-top: 1px solid #f0f2f5;
  padding-top: 12px;
}
/* 更新记录置顶：首块去除顶部大间距与分隔线 */
.first-block {
  margin-top: 0;
  border-top: none;
  padding-top: 2px;
}
.acts-toggle {
  margin-top: 2px;
}
.block-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
}
.act-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.act-head b {
  color: #303133;
}
.act-action {
  color: #606266;
}
.act-del {
  margin-left: auto;
}
.act-lines {
  margin-top: 4px;
}
.act-line {
  font-size: 13px;
  color: #606266;
  line-height: 1.7;
  word-break: break-word;
}
.act-line.note {
  color: #909399;
  font-style: italic;
}
.note-range {
  margin-bottom: 10px;
  font-size: 13px;
  color: #606266;
}
.note-range b {
  color: #303133;
}
.comment {
  padding: 8px 0;
  border-bottom: 1px dashed #f0f2f5;
}
.comment-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.comment-body {
  font-size: 14px;
  word-break: break-word;
}
.comment-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  align-items: flex-end;
}
.empty {
  padding: 8px 0;
}
</style>