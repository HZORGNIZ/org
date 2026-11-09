<template>
  <div class="pbc-result">
    <div class="pr-head">
      <span class="pr-title">考核结果</span>
      <el-tag :type="STATUS_TYPE[reviewStatus] || 'info'" size="small" effect="plain">{{ STATUS_LABEL[reviewStatus] || reviewStatus }}</el-tag>
      <span class="muted pr-sub">{{ month }} 月度 PBC · 最终得分以上级复核为准</span>
    </div>

    <div v-if="reviewStatus === 'NOT_STARTED'" class="muted pr-empty">
      该月还没有提交自评。到「我的自评」填写逐条自评分并提交后，这里会显示自评分与上级复核结果（历史月份也可补录）。
    </div>

    <template v-else>
      <div class="pr-kpis">
        <div class="pr-kpi">
          <span class="pr-num">{{ selfTotal }}</span>
          <span class="pr-label">自评合计</span>
        </div>
        <div class="pr-kpi final">
          <span class="pr-num">{{ reviewStatus === 'LEADER_DONE' ? leaderTotal : '—' }}</span>
          <span class="pr-label">{{ reviewStatus === 'LEADER_DONE' ? '最终得分（领导复核）' : '待上级复核' }}</span>
        </div>
        <div v-if="reviewStatus === 'LEADER_DONE'" class="pr-kpi">
          <span class="pr-num" :class="deltaClass">{{ signedDelta }}</span>
          <span class="pr-label">领导调整</span>
        </div>
      </div>

      <div class="pr-meta">
        <span v-if="pbcLeaderName">打分上级：{{ pbcLeaderName }}</span>
        <span v-if="selfAt">自评提交：{{ fmt(selfAt, 'YYYY-MM-DD HH:mm') }}</span>
        <span v-if="leaderAt">复核定稿：{{ fmt(leaderAt, 'YYYY-MM-DD HH:mm') }}</span>
      </div>

      <el-alert
        v-if="lastRevoke && reviewStatus !== 'LEADER_DONE'"
        class="pr-alert"
        type="warning"
        :closable="false"
        show-icon
        :title="`定稿已于 ${fmt(lastRevoke.at, 'YYYY-MM-DD HH:mm')} 由「${lastRevoke.byName}」撤销`"
        :description="lastRevoke.note ? `撤销说明：${lastRevoke.note}` : '自评内容保留，等待上级重新复核后出最终分。'"
      />

      <div v-if="selfSummary" class="pr-summary">
        <span class="muted">自评总述：</span>{{ selfSummary }}
      </div>

      <el-table :data="items" size="small" class="pr-table">
        <el-table-column label="事项" min-width="200">
          <template #default="{ row }">{{ row.content }}</template>
        </el-table-column>
        <el-table-column label="分值" width="70" align="center">
          <template #default="{ row }">{{ row.score }}</template>
        </el-table-column>
        <el-table-column label="自评" width="72" align="center">
          <template #default="{ row }"><span class="pr-self">{{ row.selfScore ?? 0 }}</span></template>
        </el-table-column>
        <el-table-column label="自评理由" min-width="160">
          <template #default="{ row }"><span class="pr-reason">{{ row.selfReason || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="复核分" width="78" align="center">
          <template #default="{ row }">
            <span v-if="reviewStatus === 'LEADER_DONE'" class="pr-leader">{{ row.leaderScore ?? 0 }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="复核评语" min-width="160">
          <template #default="{ row }"><span class="pr-reason">{{ row.leaderComment || '—' }}</span></template>
        </el-table-column>
      </el-table>

      <div v-if="leaderComment" class="pr-comment">
        <span class="muted">整月总评：</span>{{ leaderComment }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { PbcItemType, PbcReviewStatus } from '../api';
import { fmt } from '../utils/format';

const props = defineProps<{
  month: string;
  reviewStatus: PbcReviewStatus;
  selfTotal: number;
  leaderTotal: number;
  selfSummary: string | null;
  leaderComment: string | null;
  selfAt: string | null;
  leaderAt: string | null;
  pbcLeaderName: string | null;
  lastRevoke: { at: string; byName: string; note: string | null } | null;
  items: PbcItemType[];
}>();

const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: '未自评',
  SELF_DONE: '已自评 · 待上级复核',
  LEADER_DONE: '已复核定稿',
};
const STATUS_TYPE: Record<string, string> = { NOT_STARTED: 'info', SELF_DONE: 'warning', LEADER_DONE: 'success' };

const delta = computed(() => Number(props.leaderTotal || 0) - Number(props.selfTotal || 0));
const signedDelta = computed(() => (delta.value > 0 ? `+${delta.value}` : String(delta.value)));
const deltaClass = computed(() => (delta.value > 0 ? 'up' : delta.value < 0 ? 'down' : ''));
</script>

<style scoped>
.pbc-result {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
}
.pr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.pr-title {
  font-weight: 700;
  font-size: var(--fs-lg);
}
.pr-sub {
  font-size: 12px;
}
.pr-empty {
  padding: 12px 0;
  font-size: 13px;
  line-height: 1.7;
}
.pr-kpis {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.pr-kpi {
  display: flex;
  flex-direction: column;
  min-width: 120px;
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.pr-kpi.final {
  background: var(--el-color-primary-light-9);
}
.pr-num {
  font-size: 22px;
  font-weight: 700;
  color: var(--el-color-primary);
}
.pr-num.up {
  color: var(--el-color-danger);
}
.pr-num.down {
  color: var(--el-color-success);
}
.pr-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pr-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.pr-alert {
  margin-bottom: 10px;
}
.pr-summary,
.pr-comment {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  margin-bottom: 10px;
}
.pr-table {
  margin-bottom: 8px;
}
.pr-self {
  color: var(--el-color-warning);
  font-weight: 600;
}
.pr-leader {
  color: var(--el-color-success);
  font-weight: 700;
}
.pr-reason {
  font-size: 12px;
  color: var(--el-text-color-regular);
}
</style>
