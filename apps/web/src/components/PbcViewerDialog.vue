<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(96vw, 560px)"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="row" class="pbc-view">
      <div class="pv-meta muted">
        <span v-if="row.department">部门：{{ row.department }}</span>
        <span>合计 {{ row.total }} 分 · {{ row.itemCount }} 项</span>
        <span v-if="row.updatedAt">更新 {{ fmt(row.updatedAt, 'MM-DD HH:mm') }}</span>
      </div>

      <!-- 状态标签居左，审批操作按钮靠右上角 -->
      <div class="pv-status">
        <el-tag :type="STATUS_TYPE[row.status] || 'info'" effect="plain">{{ STATUS_LABEL[row.status] || row.status }}</el-tag>
        <span v-if="row.status === 'APPROVED' && row.approverName" class="muted">
          审批人：{{ row.approverName }}{{ row.approvedAt ? ` · ${fmt(row.approvedAt, 'YYYY-MM-DD HH:mm')}` : '' }}
        </span>
        <span v-if="row.canApprove && row.hasPbc" class="pv-status-actions">
          <el-button
            v-if="row.status === 'SUBMITTED' && !showReject"
            type="danger"
            size="small"
            plain
            @click="openReject"
          >退回修改</el-button>
          <el-button
            v-if="row.status === 'SUBMITTED'"
            type="primary"
            size="small"
            :loading="busy"
            @click="emit('approve', row)"
          >审批通过</el-button>
          <el-button
            v-if="row.status === 'APPROVED'"
            type="warning"
            size="small"
            :loading="busy"
            @click="emit('revoke', row)"
          >允许修改</el-button>
        </span>
      </div>

      <el-alert
        v-if="row.status === 'REJECTED' && row.reviewComment"
        class="pv-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="row.isSelf ? '你的 PBC 已被退回，请根据以下修改意见调整并重新提交' : '该 PBC 已退回，附修改意见'"
      >
        <div class="pv-review">{{ row.reviewComment }}</div>
      </el-alert>

      <el-alert
        v-if="row.status === 'APPROVED' && row.isSelf"
        class="pv-alert"
        type="success"
        :closable="false"
        show-icon
        title="该月 PBC 已审批通过并锁定"
        description="如需修改，请联系你的审批人点击「允许修改」后重新编辑。"
      />

      <div v-if="!row.hasPbc" class="muted empty">该成员本月尚未填写 PBC。</div>
      <div v-else class="pv-items">
        <div v-for="(it, i) in row.items" :key="i" class="pv-item">
          <span class="pv-idx">{{ i + 1 }}</span>
          <span class="pv-content">
            {{ it.content }}
            <span v-if="it.selfReason" class="pv-self-reason">自评理由：{{ it.selfReason }}</span>
          </span>
          <span class="pv-score">
            {{ it.score }} 分
            <template v-if="row.reviewStatus !== 'NOT_STARTED'">
              <span class="pv-selftag">自评 {{ it.selfScore ?? 0 }}</span>
              <span v-if="row.reviewStatus === 'LEADER_DONE'" class="pv-leadertag">上级 {{ it.leaderScore ?? 0 }}</span>
            </template>
          </span>
        </div>
      </div>

      <!-- 自评总述（进入考核后展示） -->
      <div v-if="row.reviewStatus !== 'NOT_STARTED' && row.selfSummary" class="pv-self-summary">
        <span class="muted">自评总述：</span>{{ row.selfSummary }}
      </div>

      <!-- 上级评分：我是打分上级/管理员且成员已自评 -->
      <div v-if="row.canLeaderReview" class="pv-leader-review">
        <el-divider content-position="left">上级评分（逐条不高于分值）</el-divider>
        <div v-for="r in reviewRows" :key="r.index" class="pv-lr-item">
          <div class="pv-lr-top">
            <span class="pv-idx">{{ r.index + 1 }}</span>
            <span class="pv-content">{{ r.content }}</span>
            <span class="muted pv-lr-score">分值 {{ r.score }} · 自评 {{ r.selfScore ?? 0 }}</span>
          </div>
          <div v-if="r.selfReason" class="pv-lr-selfreason">自评理由：{{ r.selfReason }}</div>
          <div class="pv-lr-inputs">
            <el-input-number v-model="r.leaderScore" :min="0" :max="r.score" :step="1" controls-position="right" size="small" class="pv-lr-num" placeholder="0" />
            <el-input v-model="r.leaderComment" type="textarea" :autosize="{ minRows: 1, maxRows: 2 }" placeholder="该条评语（可选）" class="pv-lr-cmt" />
          </div>
        </div>
        <div class="pv-lr-monthly">
          <div class="pv-lr-monthly-label">整月总评</div>
          <el-input v-model="leaderCommentMonthly" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="对该成员本月的整体评价…" />
        </div>
        <div class="pv-lr-foot">
          <span class="muted">上级合计：{{ leaderTotalNow }} / {{ row.total }}</span>
          <el-button type="primary" :loading="leaderBusy" @click="submitLeaderReview">提交评分并定稿</el-button>
        </div>
      </div>

      <!-- 已定稿只读结果 -->
      <div v-else-if="row.reviewStatus === 'LEADER_DONE'" class="pv-review-result">
        <el-divider content-position="left">考核结果·{{ REVIEW_LABEL[row.reviewStatus] }}</el-divider>
        <div class="pv-result-kpis">
          <div class="pv-result-kpi">
            <span class="pv-result-num">{{ row.selfTotal ?? selfTotalNow }}</span>
            <span class="pv-result-label">自评合计</span>
          </div>
          <div class="pv-result-kpi final">
            <span class="pv-result-num">{{ row.leaderTotal ?? leaderTotalNow }}</span>
            <span class="pv-result-label">最终得分（领导复核）</span>
          </div>
          <div class="pv-result-kpi">
            <span class="pv-result-num">{{ deltaText }}</span>
            <span class="pv-result-label">领导调整</span>
          </div>
        </div>
        <div class="pv-result-meta muted">
          <span v-if="row.pbcLeaderName">复核人：{{ row.pbcLeaderName }}</span>
          <span v-if="row.selfAt">自评提交：{{ fmt(row.selfAt, 'MM-DD HH:mm') }}</span>
          <span v-if="row.leaderAt">定稿时间：{{ fmt(row.leaderAt, 'MM-DD HH:mm') }}</span>
        </div>
        <div v-if="row.selfSummary" class="pv-review-result-cmt">自评总述：{{ row.selfSummary }}</div>
        <div v-if="row.leaderComment" class="pv-review-result-cmt">整月总评：{{ row.leaderComment }}</div>
        <div v-if="isAdmin" class="pv-result-actions">
          <el-button size="small" type="warning" plain :loading="busy" @click="emit('revoke-review', row)">
            撤销定稿（仅管理员）
          </el-button>
          <span class="muted">撤销后回到「已自评·待复核」，分数保留、留痕并通知本人</span>
        </div>
      </div>

      <!-- 已自评但还没定稿：给成员/查看者一个「等上级复核」的明确提示 -->
      <div v-else-if="row.reviewStatus === 'SELF_DONE'" class="pv-waiting muted">
        该成员已提交自评（{{ row.selfTotal ?? selfTotalNow }} 分），等待{{ row.pbcLeaderName ? `「${row.pbcLeaderName}」` : '打分上级' }}复核定稿。
      </div>

      <div v-if="showReject" class="pv-reject">
        <div class="pv-reject-label">修改意见（退回后钉钉私聊通知成员）</div>
        <el-input v-model="rejectText" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="请说明需要成员修改的内容…" />
        <div class="pv-reject-actions">
          <el-button size="small" @click="cancelReject">取消</el-button>
          <el-button size="small" type="danger" :loading="busy" @click="confirmReject">确认退回</el-button>
        </div>
      </div>

      <!-- 任务分解：仅审批人（管理员/部门负责人）在「审批通过」后可用（操作顺序：先审批 → 再分解） -->
      <div v-if="row.canApprove && row.hasPbc && row.status !== 'APPROVED'" class="decompose-gate muted">
        任务分解需在「审批通过」后进行，请先点击上方「审批通过」。
      </div>
      <!-- 已分解：只读提示，不允许再次分解 -->
      <div v-if="row.canApprove && row.status === 'APPROVED' && row.decomposed" class="pv-decompose">
        <el-divider content-position="left">任务分解</el-divider>
        <el-alert type="success" :closable="false" show-icon title="该月 PBC 已分解为任务，不可再次分解" description="任务已创建到各自关联的项目，可在「任务」页或项目主页查看；如需调整请直接编辑那些任务。" />
      </div>
      <div v-if="row.canApprove && row.status === 'APPROVED' && !row.decomposed" class="pv-decompose">
        <el-divider content-position="left">任务分解</el-divider>
        <div v-if="!tasks.length" class="decompose-start">
          <el-button type="primary" plain :loading="decomposing" @click="doDecompose">
            <el-icon><MagicStick /></el-icon>&nbsp;AI 分解为任务
          </el-button>
          <div class="muted decompose-tip">将整月 PBC 交给 AI 拆分为多条带建议截止日的任务，确认（可编辑）后，每条任务可分别选择关联的项目，负责人=该成员、截止日=建议日期。</div>
        </div>
        <div v-else class="decompose-list">
          <div v-if="degraded" class="muted decompose-tip">AI 暂不可用，已按事项自动排期，请手动调整标题/日期。</div>
          <div class="decompose-head">
            <span class="decompose-title">共 {{ tasks.length }} 条任务（可编辑）</span>
            <el-button text size="small" :loading="decomposing" @click="doDecompose">重新分解</el-button>
          </div>
          <div v-for="(t, i) in tasks" :key="i" class="decompose-item">
            <div class="decompose-item-top">
              <span class="pv-idx">{{ i + 1 }}</span>
              <el-input v-model="t.title" placeholder="任务标题" class="decompose-title-input" />
              <el-button text type="danger" size="small" @click="removeTask(i)">删除</el-button>
            </div>
            <el-input v-model="t.description" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" placeholder="任务说明与验收标准" class="decompose-desc" />
            <div class="decompose-due">
              <span class="muted">建议截止时间</span>
              <el-date-picker v-model="t.dueDate" type="date" value-format="YYYY-MM-DD" size="small" :clearable="false" class="decompose-due-picker" />
              <span class="muted">关联项目</span>
              <el-select v-model="t.projectId" size="small" placeholder="选择项目" class="decompose-proj" :disabled="!projects.length">
                <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
            </div>
          </div>
          <!-- 右下角大号主按钮，与左侧取消拉开间距 -->
          <div class="decompose-foot">
            <el-button text size="small" @click="resetDecompose">取消</el-button>
            <el-button type="primary" :loading="creating" :disabled="!tasks.length || !projects.length" @click="doCreateTasks">确认创建任务</el-button>
          </div>
          <div v-if="projects.length === 0" class="muted decompose-warn">该成员尚未加入任何未归档项目，无法把任务指派给 TA；请先在相应项目里添加该成员为项目成员。</div>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { pbcApi, type PbcRow, type PbcTaskPreview } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';

const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const props = defineProps<{
  modelValue: boolean;
  row: PbcRow | null;
  month: string;
  busy?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'approve', row: PbcRow): void;
  (e: 'revoke', row: PbcRow): void;
  (e: 'reject', payload: { row: PbcRow; comment: string }): void;
  /** 确认创建分解任务成功（父视图据此刷新列表「已分解」状态） */
  (e: 'decomposed', row: PbcRow): void;
  /** 上级评分定稿成功（父视图据此刷新列表考核状态） */
  (e: 'reviewed', row: PbcRow): void;
  /** 撤销定稿（仅 ADMIN，在弹窗内二次确认后由父视图调接口） */
  (e: 'revoke-review', row: PbcRow): void;
}>();

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '未填写',
  SUBMITTED: '待审批',
  APPROVED: '已通过',
  REJECTED: '已退回',
};
const STATUS_TYPE: Record<string, string> = {
  DRAFT: 'info',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
};

// ---- 考核（上级评分） ----
const REVIEW_LABEL: Record<string, string> = { NOT_STARTED: '未自评', SELF_DONE: '已自评·待评分', LEADER_DONE: '已评分定稿' };
interface ReviewRow { index: number; content: string; score: number; selfScore: number | null; selfReason: string; leaderScore: number | null; leaderComment: string; }
const reviewRows = ref<ReviewRow[]>([]);
const leaderCommentMonthly = ref('');
const leaderBusy = ref(false);
const leaderTotalNow = computed(() => reviewRows.value.reduce((s, it) => s + (Number(it.leaderScore) || 0), 0));
const selfTotalNow = computed(() => reviewRows.value.reduce((s, it) => s + (Number(it.selfScore) || 0), 0));
/** 领导调整 = 最终得分 - 自评合计（正数=调高） */
const deltaText = computed(() => {
  const d = Number(props.row?.leaderTotal ?? 0) - Number(props.row?.selfTotal ?? 0);
  return d > 0 ? `+${d}` : String(d);
});

/** 从当前行初始化逐条评分草稿（上级预填历史评分，若有） */
function initReview() {
  const items = props.row?.items ?? [];
  reviewRows.value = items.map((it, i) => ({
    index: i,
    content: it.content,
    score: Number(it.score) || 0,
    selfScore: it.selfScore ?? null,
    selfReason: it.selfReason ?? '',
    leaderScore: it.leaderScore ?? null,
    leaderComment: it.leaderComment ?? '',
  }));
  leaderCommentMonthly.value = props.row?.leaderComment ?? '';
}
watch(() => [props.modelValue, props.row?.userId, props.row?.reviewStatus], initReview, { immediate: true });

/** 提交上级评分定稿 */
async function submitLeaderReview() {
  if (!props.row) return;
  for (const r of reviewRows.value) {
    const v = Number(r.leaderScore ?? 0);
    if (!Number.isFinite(v) || v < 0 || v > r.score) {
      ElMessage.warning(`上级评分需为 0～该条分值（${r.score}）之间的数字`);
      return;
    }
  }
  leaderBusy.value = true;
  try {
    const items = reviewRows.value.map((r) => ({ index: r.index, leaderScore: Number(r.leaderScore) || 0, leaderComment: String(r.leaderComment ?? '').trim() }));
    const res = await pbcApi.leaderReview(props.row.userId, props.month, { items, leaderComment: leaderCommentMonthly.value.trim() });
    ElMessage.success(`已定稿，最终得分 ${res.leaderTotal} 分`);
    emit('reviewed', props.row);
  } finally {
    leaderBusy.value = false;
  }
}

const title = computed(() => (props.row ? `${props.row.name} 的 ${props.month} 月度 PBC` : 'PBC 详情'));

// 退回修改面板（弹窗开关时重置，避免上次草稿残留）
const showReject = ref(false);
const rejectText = ref('');
watch(
  () => props.modelValue,
  (v) => {
    if (!v) {
      showReject.value = false;
      rejectText.value = '';
      resetDecompose();
    }
  },
);
// 切换成员或状态变化（如撤回后重新审批）时重置分解草稿，避免残留上一次的任务列表
watch(
  () => [props.row?.userId, props.row?.status],
  () => resetDecompose(),
);
function openReject() {
  rejectText.value = '';
  showReject.value = true;
}
function cancelReject() {
  showReject.value = false;
  rejectText.value = '';
}
function confirmReject() {
  const text = rejectText.value.trim();
  if (!text) return;
  if (!props.row) return;
  emit('reject', { row: props.row, comment: text });
}

// ---- 任务分解（弹窗内自包含：直接调 pbcApi.decompose / createTasks）----
const tasks = ref<PbcTaskPreview[]>([]);
const projects = ref<{ id: string; name: string }[]>([]);
const decomposing = ref(false);
const creating = ref(false);
const degraded = ref(false);

async function doDecompose() {
  if (!props.row) return;
  decomposing.value = true;
  try {
    const r = await pbcApi.decompose(props.row.userId, props.month);
    const def = r.defaultProjectId ?? (r.projects.length ? r.projects[0].id : '');
    // 每条任务预填建议项目（默认第一个），可逐条修改
    tasks.value = r.tasks.map((t) => ({ ...t, projectId: t.projectId || def }));
    projects.value = r.projects;
    degraded.value = !!r.degraded;
    if (!tasks.value.length) ElMessage.warning('未分解出任务，请重试或手动添加');
  } finally {
    decomposing.value = false;
  }
}
function removeTask(i: number) {
  tasks.value.splice(i, 1);
}
function resetDecompose() {
  tasks.value = [];
  projects.value = [];
  degraded.value = false;
}
async function doCreateTasks() {
  if (!props.row) return;
  const valid = tasks.value.filter((t) => t.title.trim());
  if (!valid.length) {
    ElMessage.warning('请至少保留一条有标题的任务');
    return;
  }
  if (valid.some((t) => !t.projectId)) {
    ElMessage.warning('请为每条任务选择关联项目');
    return;
  }
  creating.value = true;
  try {
    const r = await pbcApi.createTasks(props.row.userId, props.month, valid);
    const projNames = (r.projects || []).map((p) => p.name).join('、');
    ElMessage.success(`已创建 ${r.created} 条任务并指派给 ${props.row.name}（项目：${projNames || '—'}）`);
    resetDecompose();
    // 通知父视图刷新列表，行数据更新后自动切换为「已分解」只读提示
    emit('decomposed', props.row);
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped>
.pv-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  margin-bottom: 8px;
}
.pv-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
}
/* 审批按钮组靠右上角，窄屏时自动换行 */
.pv-status-actions {
  margin-left: auto;
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.pv-alert {
  margin-bottom: 10px;
}
.pv-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pv-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  background: #fafbfc;
}
.pv-idx {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  line-height: 20px;
  text-align: center;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 12px;
}
.pv-content {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  word-break: break-word;
}
.pv-score {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--el-color-primary);
  font-size: 14px;
}
.pv-self-reason {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
  font-weight: 400;
}
.pv-selftag {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--el-color-warning);
}
.pv-leadertag {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--el-color-success);
}
.pv-self-summary {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fafbfc;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.pv-leader-review {
  margin-top: 12px;
}
.pv-lr-item {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  background: #fafbfc;
}
.pv-lr-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.pv-lr-score {
  flex-shrink: 0;
  font-size: 12px;
}
.pv-lr-selfreason {
  margin: 6px 0 0 28px;
  font-size: 12px;
  color: #909399;
}
.pv-lr-inputs {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 8px;
  margin-left: 28px;
}
.pv-lr-num {
  width: 120px;
  flex-shrink: 0;
}
.pv-lr-cmt {
  flex: 1;
  min-width: 0;
}
.pv-lr-monthly {
  margin-top: 12px;
}
.pv-lr-monthly-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.pv-lr-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 12px;
}
.pv-review-result {
  margin-top: 12px;
}
.pv-review-result-cmt {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.empty {
  padding: 16px 0;
  text-align: center;
}
.pv-review {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}
.pv-reject {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--el-color-danger-light-7);
  border-radius: 6px;
  background: var(--el-color-danger-light-9);
}
.pv-reject-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.pv-reject-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.pv-decompose {
  margin-top: 6px;
}
.decompose-start {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.decompose-tip {
  font-size: 12px;
  line-height: 1.6;
}
.decompose-warn {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-color-danger);
}
.decompose-gate {
  margin-top: 12px;
  padding: 8px 10px;
  border: 1px dashed var(--el-border-color);
  border-radius: 6px;
  background: #fafbfc;
  font-size: 12px;
  line-height: 1.6;
}
.decompose-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.decompose-title {
  font-size: 13px;
  font-weight: 600;
}
.decompose-item {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  background: #fafbfc;
}
.decompose-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.decompose-title-input {
  flex: 1;
  min-width: 0;
}
.decompose-desc {
  margin-bottom: 6px;
}
.decompose-due {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.decompose-due-picker {
  width: 150px;
}
.decompose-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.decompose-proj {
  width: 170px;
}
/* 已定稿考核结果 */
.pv-result-kpis {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.pv-result-kpi {
  display: flex;
  flex-direction: column;
  min-width: 100px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.pv-result-kpi.final {
  background: var(--el-color-primary-light-9);
}
.pv-result-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-color-primary);
}
.pv-result-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pv-result-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  margin-bottom: 8px;
}
.pv-result-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
  font-size: 12px;
}
.pv-waiting {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
}
</style>
