<template>
  <div class="rv-wrap" v-loading="loading">
    <!-- 顶部：KPI + 月份筛选 -->
    <div class="rv-head">
      <div class="rv-kpis">
        <div class="rv-kpi">
          <span class="rv-kpi-num">{{ pendingCount }}</span>
          <span class="rv-kpi-label">待我审核</span>
        </div>
        <div class="rv-kpi">
          <span class="rv-kpi-num">{{ doneCount }}</span>
          <span class="rv-kpi-label">已定稿</span>
        </div>
      </div>
      <div class="rv-filters">
        <el-select v-model="month" size="small" class="rv-month" placeholder="全部月份">
          <el-option label="全部月份" value="all" />
          <el-option v-for="m in queue.months" :key="m" :label="m" :value="m" />
        </el-select>
        <el-radio-group v-model="statusFilter" size="small">
          <el-radio-button value="pending">待审核</el-radio-button>
          <el-radio-button value="done">已定稿</el-radio-button>
          <el-radio-button value="all">全部</el-radio-button>
        </el-radio-group>
        <el-button text type="primary" size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div v-if="!filtered.length && !loading" class="rv-empty muted">
      {{ statusFilter === 'done' ? '还没有已定稿的考核' : '当前没有待你审核的 PBC。成员提交自评后会出现在这里，补录的历史月份也会进来。' }}
    </div>

    <div v-else class="rv-body">
      <!-- 左：待审核名单 -->
      <div class="rv-list">
        <div
          v-for="(r, i) in paged"
          :key="key(r)"
          class="rv-item"
          :class="{ active: key(r) === selectedKey }"
          @click="select(r)"
        >
          <div class="rv-item-top">
            <span class="rv-item-name">{{ r.name }}</span>
            <el-tag size="small" :type="r.reviewStatus === 'SELF_DONE' ? 'warning' : 'success'" effect="plain">
              {{ r.reviewStatus === 'SELF_DONE' ? '待审核' : '已定稿' }}
            </el-tag>
          </div>
          <div class="rv-item-meta muted">
            {{ r.month }} · {{ r.department || '未归属' }}
          </div>
          <div class="rv-item-scores">
            <span class="rv-self">自评 {{ r.selfTotal ?? 0 }}</span>
            <span v-if="r.reviewStatus === 'LEADER_DONE'" class="rv-leader">最终 {{ r.leaderTotal ?? 0 }}</span>
            <span v-else-if="isOverdue(r)" class="rv-overdue">逾期 {{ overdueDays(r) }} 天</span>
          </div>
        </div>
        <el-pagination
          v-if="filtered.length > PAGE"
          v-model:current-page="page"
          :page-size="PAGE"
          :total="filtered.length"
          layout="prev, pager, next"
          small
          class="rv-page"
        />
      </div>

      <!-- 右：明细与复核打分 -->
      <div v-if="current" class="rv-detail">
        <div class="rv-detail-head">
          <div>
            <span class="rv-detail-name">{{ current.name }}</span>
            <span class="muted">{{ current.month }} · {{ current.department || '未归属' }}</span>
          </div>
          <div class="rv-nav">
            <el-button size="small" text :disabled="navIdx <= 0" @click="go(-1)">上一条</el-button>
            <span class="muted">{{ navIdx + 1 }} / {{ filtered.length }}</span>
            <el-button size="small" text :disabled="navIdx >= filtered.length - 1" @click="go(1)">下一条</el-button>
          </div>
        </div>

        <div class="rv-summary">
          <el-tag size="small" type="warning" effect="plain">自评合计 {{ current.selfTotal ?? 0 }}</el-tag>
          <span v-if="current.selfAt" class="muted">提交于 {{ fmt(current.selfAt, 'MM-DD HH:mm') }}</span>
          <span v-if="current.pbcLeaderName" class="muted">打分上级：{{ current.pbcLeaderName }}</span>
          <span v-if="current.reviewStatus === 'LEADER_DONE' && current.leaderAt" class="muted">
            定稿于 {{ fmt(current.leaderAt, 'MM-DD HH:mm') }}
          </span>
        </div>

        <div v-if="current.selfSummary" class="rv-self-summary">
          <span class="muted">自评总述：</span>{{ current.selfSummary }}
        </div>

        <div class="rv-items">
          <div v-for="d in draft" :key="d.index" class="rv-row">
            <div class="rv-row-top">
              <span class="rv-idx">{{ d.index + 1 }}</span>
              <span class="rv-content">{{ d.content }}</span>
              <span class="muted rv-row-score">分值 {{ d.score }} · 自评 {{ d.selfScore ?? 0 }}</span>
            </div>
            <div v-if="d.selfReason" class="rv-reason">自评理由：{{ d.selfReason }}</div>
            <div class="rv-row-input">
              <el-input-number
                v-model="d.leaderScore"
                :min="0"
                :max="d.score"
                :step="1"
                :disabled="!editable"
                controls-position="right"
                size="small"
                class="rv-num"
                placeholder="0"
              />
              <el-input
                v-model="d.leaderComment"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 2 }"
                :disabled="!editable"
                placeholder="该条复核评语（可选）"
                class="rv-cmt"
              />
            </div>
          </div>
        </div>

        <div class="rv-monthly">
          <div class="rv-monthly-label">整月总评</div>
          <el-input
            v-model="leaderComment"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            :disabled="!editable"
            placeholder="对该成员本月的整体评价…"
          />
        </div>

        <div class="rv-foot">
          <span class="muted">复核合计：<b class="rv-total">{{ leaderTotalNow }}</b> / {{ current.total }}（自评 {{ current.selfTotal ?? 0 }}）</span>
          <div class="rv-foot-actions">
            <el-button v-if="current.reviewStatus === 'LEADER_DONE' && isAdmin" size="small" type="warning" plain :loading="busy" @click="revoke">
              撤销定稿
            </el-button>
            <el-button v-if="editable" type="primary" :loading="busy" @click="submit">提交复核并定稿</el-button>
          </div>
        </div>
        <div v-if="!editable" class="muted rv-lock-tip">
          该月已定稿，分数即成员当月 PBC 最终得分。如需更正，请管理员点「撤销定稿」后重新复核。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { pbcApi, type PbcRow } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';

type QueueRow = PbcRow & { month: string };
interface DraftRow {
  index: number;
  content: string;
  score: number;
  selfScore: number | null;
  selfReason: string;
  leaderScore: number | null;
  leaderComment: string;
}
const emit = defineEmits<{ (e: 'reviewed', payload: { userId: string; month: string }): void }>();

const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);
const PAGE = 20;

const loading = ref(false);
const busy = ref(false);
const queue = ref<{ months: string[]; pending: number; rows: QueueRow[] }>({ months: [], pending: 0, rows: [] });
const month = ref('all');
const statusFilter = ref<'pending' | 'done' | 'all'>('pending');
const page = ref(1);
const selectedKey = ref('');
const draft = ref<DraftRow[]>([]);
const leaderComment = ref('');

function key(r: { userId: string; month: string }) {
  return `${r.userId}|${r.month}`;
}
const filtered = computed(() =>
  queue.value.rows.filter((r) => {
    if (month.value !== 'all' && r.month !== month.value) return false;
    if (statusFilter.value === 'pending') return r.reviewStatus === 'SELF_DONE';
    if (statusFilter.value === 'done') return r.reviewStatus === 'LEADER_DONE';
    return true;
  }),
);
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE, page.value * PAGE));
const pendingCount = computed(() => queue.value.rows.filter((r) => r.reviewStatus === 'SELF_DONE').length);
const doneCount = computed(() => queue.value.rows.filter((r) => r.reviewStatus === 'LEADER_DONE').length);
const current = computed<QueueRow | null>(() => queue.value.rows.find((r) => key(r) === selectedKey.value) ?? null);
const navIdx = computed(() => filtered.value.findIndex((r) => key(r) === selectedKey.value));
const editable = computed(() => current.value?.reviewStatus === 'SELF_DONE');
const leaderTotalNow = computed(() => draft.value.reduce((s, it) => s + (Number(it.leaderScore) || 0), 0));

/** 逾期天数：定稿日晚于「次月 5 日」即算逾期（自评提交后 5 天以上未复核） */
function overdueDays(r: QueueRow): number {
  if (!r.selfAt) return 0;
  const due = dayjs(r.selfAt).add(5, 'day').startOf('day');
  return Math.max(0, dayjs().startOf('day').diff(due, 'day'));
}
function isOverdue(r: QueueRow): boolean {
  return r.reviewStatus === 'SELF_DONE' && overdueDays(r) > 0;
}

function initDraft(r: QueueRow | null) {
  if (!r) {
    draft.value = [];
    leaderComment.value = '';
    return;
  }
  draft.value = (r.items ?? []).map((it, i) => ({
    index: i,
    content: it.content,
    score: Number(it.score) || 0,
    selfScore: it.selfScore ?? null,
    selfReason: it.selfReason ?? '',
    leaderScore: it.leaderScore ?? it.selfScore ?? null,
    leaderComment: it.leaderComment ?? '',
  }));
  leaderComment.value = r.leaderComment ?? '';
}
watch(() => selectedKey.value, () => initDraft(current.value));

function select(r: QueueRow) {
  selectedKey.value = key(r);
}
function go(step: number) {
  const next = filtered.value[navIdx.value + step];
  if (next) select(next);
}

async function load(keepSelection = true) {
  loading.value = true;
  try {
    const q = await pbcApi.reviewQueue(month.value === 'all' ? undefined : month.value);
    queue.value = q;
    // 选中项：保持原选中 → 第一条待审核 → 第一条
    if (!keepSelection || !q.rows.some((r) => key(r) === selectedKey.value)) {
      const first = q.rows.find((r) => r.reviewStatus === 'SELF_DONE') ?? q.rows[0];
      selectedKey.value = first ? key(first) : '';
    }
    initDraft(current.value);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const r = current.value;
  if (!r) return;
  for (const d of draft.value) {
    const v = Number(d.leaderScore ?? 0);
    if (!Number.isFinite(v) || v < 0 || v > d.score) {
      ElMessage.warning(`复核评分需为 0～该条分值（${d.score}）之间的数字`);
      return;
    }
  }
  try {
    await ElMessageBox.confirm(
      `定稿后该分数即 ${r.name} ${r.month} PBC 的最终得分（${leaderTotalNow.value} 分），成员不可再改；如需更正只能由管理员撤销。确认提交？`,
      '确认定稿',
      { type: 'warning', confirmButtonText: '确认定稿', cancelButtonText: '再检查一下' },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    const items = draft.value.map((d) => ({
      index: d.index,
      leaderScore: Number(d.leaderScore) || 0,
      leaderComment: String(d.leaderComment ?? '').trim(),
    }));
    await pbcApi.leaderReview(r.userId, r.month, { items, leaderComment: leaderComment.value.trim() });
    ElMessage.success(`已定稿：${r.name} ${r.month} 最终 ${leaderTotalNow.value} 分`);
    await load(true);
    emit('reviewed', { userId: r.userId, month: r.month });
  } finally {
    busy.value = false;
  }
}

async function revoke() {
  const r = current.value;
  if (!r) return;
  try {
    const { value } = await ElMessageBox.prompt(
      `撤销 ${r.name} ${r.month} 的定稿，考核回到「已自评·待复核」，会通知成员与打分上级。可填写撤销原因：`,
      '撤销定稿',
      { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消', inputPlaceholder: '选填' },
    );
    busy.value = true;
    await pbcApi.revokeLeaderReview(r.userId, r.month, String(value ?? '').trim() || undefined);
    ElMessage.success('已撤销定稿，可重新复核');
    await load(true);
    emit('reviewed', { userId: r.userId, month: r.month });
  } catch {
    /* 取消 */
  } finally {
    busy.value = false;
  }
}

watch([month, statusFilter], () => {
  page.value = 1;
  load(false);
});
load();
defineExpose({ load });
</script>

<style scoped>
.rv-wrap {
  margin-bottom: 14px;
}
.rv-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
}
.rv-kpis {
  display: flex;
  gap: 10px;
}
.rv-kpi {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
}
.rv-kpi-num {
  font-size: 20px;
  font-weight: 700;
  color: var(--el-color-primary);
}
.rv-kpi-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.rv-filters {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rv-month {
  width: 130px;
}
.rv-body {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 12px;
}
.rv-list {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 6px;
  max-height: 620px;
  overflow-y: auto;
  background: var(--el-fill-color-blank);
}
.rv-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
}
.rv-item:hover {
  background: var(--el-fill-color-light);
}
.rv-item.active {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
}
.rv-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.rv-item-name {
  font-weight: 600;
}
.rv-item-meta {
  font-size: 12px;
  margin: 2px 0 4px;
}
.rv-item-scores {
  display: flex;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}
.rv-self {
  color: var(--el-color-warning);
}
.rv-leader {
  color: var(--el-color-success);
  font-weight: 600;
}
.rv-overdue {
  color: var(--el-color-danger);
}
.rv-page {
  margin-top: 8px;
  justify-content: center;
}
.rv-detail {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 12px;
  background: var(--el-fill-color-blank);
}
.rv-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.rv-detail-name {
  font-weight: 700;
  font-size: var(--fs-lg);
  margin-right: 8px;
}
.rv-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.rv-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  margin: 8px 0;
}
.rv-self-summary {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  margin-bottom: 10px;
}
.rv-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rv-row {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 8px 10px;
}
.rv-row-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.rv-idx {
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
.rv-content {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  word-break: break-word;
}
.rv-row-score {
  flex-shrink: 0;
  font-size: 12px;
}
.rv-reason {
  margin: 4px 0 0 28px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.rv-row-input {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 8px 0 0 28px;
}
.rv-num {
  width: 110px;
  flex-shrink: 0;
}
.rv-cmt {
  flex: 1;
  min-width: 0;
}
.rv-monthly {
  margin-top: 12px;
}
.rv-monthly-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.rv-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.rv-total {
  color: var(--el-color-primary);
  font-size: 16px;
}
.rv-foot-actions {
  display: flex;
  gap: 8px;
}
.rv-lock-tip {
  margin-top: 8px;
  font-size: 12px;
}
.rv-empty {
  padding: 24px;
  text-align: center;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}
@media (max-width: 900px) {
  .rv-body {
    grid-template-columns: 1fr;
  }
  .rv-list {
    max-height: 260px;
  }
}
</style>
