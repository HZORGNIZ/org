<template>
  <div class="pbc-rank" v-loading="loading">
    <div class="rank-head">
      <span class="rank-title">🏆 {{ selMonth }} 月度 PBC 排行</span>
      <el-select v-model="selMonth" size="small" class="rank-month" placeholder="选择月份" :teleported="false">
        <el-option v-for="m in monthOptions" :key="m" :label="`${m}${m === prevMonth ? '（上月）' : ''}`" :value="m" />
      </el-select>
      <span class="muted rank-sub">按上级复核的最终得分排序；未定稿的月份不上榜</span>
      <el-button text type="primary" size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <template v-if="hasData">
      <el-radio-group v-model="scope" size="small" class="rank-scope">
        <el-radio-button value="__overall">总排行</el-radio-button>
        <el-radio-button v-for="d in data.byDepartment" :key="d.department" :value="d.department">{{ d.department }}</el-radio-button>
      </el-radio-group>

      <el-table :data="activeRows" size="small" class="rank-table" :row-class-name="rankRowClass">
        <el-table-column label="名次" width="72" align="center">
          <template #default="{ row }">
            <span class="rank-no" :class="'rank-' + row.rank">{{ medal(row.rank) || row.rank }}</span>
          </template>
        </el-table-column>
        <el-table-column label="成员" min-width="120" prop="name" />
        <el-table-column v-if="scope === '__overall'" label="部门" min-width="120" prop="department" />
        <el-table-column label="最终得分" width="104" align="center">
          <template #default="{ row }"><span class="rank-score">{{ row.leaderTotal }}</span> 分</template>
        </el-table-column>
        <el-table-column label="自评分" width="92" align="center">
          <template #default="{ row }"><span class="muted">{{ row.selfTotal ?? '—' }}</span></template>
        </el-table-column>
        <el-table-column label="领导调整" width="100" align="center">
          <template #default="{ row }">
            <span v-if="row.selfTotal === null || row.selfTotal === undefined" class="muted">—</span>
            <span v-else :class="deltaClass(row.leaderTotal - row.selfTotal)">{{ signed(row.leaderTotal - row.selfTotal) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </template>
    <div v-else-if="!loading" class="muted empty">
      {{ monthOptions.length ? `${selMonth} 还没有定稿的 PBC 评分（上级复核定稿后自动上榜）` : '全站还没有任何定稿的 PBC 评分，上级复核定稿后自动生成排行' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { pbcApi, type PbcRankingResult } from '../api';

const props = withDefaults(defineProps<{ month?: string }>(), { month: '' });

const loading = ref(false);
const data = ref<PbcRankingResult>({ month: props.month, overall: [], byDepartment: [] });
const scope = ref<string>('__overall');
const months = ref<string[]>([]);
/** 上月（11 月 → 10 月）：默认展示上个月的排行 */
const prevMonth = dayjs().subtract(1, 'month').format('YYYY-MM');
const selMonth = ref(props.month || prevMonth);

const monthOptions = computed(() => {
  const set = new Set<string>(months.value);
  if (selMonth.value) set.add(selMonth.value);
  return [...set].filter(Boolean).sort((a, b) => b.localeCompare(a));
});
const hasData = computed(() => data.value.overall.length > 0);
const activeRows = computed(() =>
  scope.value === '__overall'
    ? data.value.overall
    : data.value.byDepartment.find((d) => d.department === scope.value)?.list ?? [],
);

function medal(rank: number): string {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
}
function rankRowClass({ rowIndex }: { rowIndex: number }): string {
  return rowIndex < 3 ? 'rank-top' : '';
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
function deltaClass(n: number): string {
  return n > 0 ? 'delta up' : n < 0 ? 'delta down' : 'delta';
}

async function load() {
  loading.value = true;
  try {
    if (!months.value.length) {
      months.value = await pbcApi.rankingMonths().catch(() => []);
      // 默认月：传入的月（若有定稿）→ 上月（若有定稿）→ 最近有定稿的月 → 上月（空态）
      const preferred = props.month && months.value.includes(props.month) ? props.month : '';
      if (preferred) selMonth.value = preferred;
      else if (months.value.includes(prevMonth)) selMonth.value = prevMonth;
      else if (months.value.length) selMonth.value = months.value[0];
      else selMonth.value = prevMonth;
    }
    data.value = await pbcApi.ranking(selMonth.value);
    if (scope.value !== '__overall' && !data.value.byDepartment.some((d) => d.department === scope.value)) {
      scope.value = '__overall';
    }
  } catch {
    data.value = { month: selMonth.value, overall: [], byDepartment: [] };
  } finally {
    loading.value = false;
  }
}

watch(selMonth, () => {
  if (loading.value) return; // 初始化时 load() 内部会改默认月，避免重复请求
  load();
});
watch(
  () => props.month,
  (v) => {
    // 父级切月：只有该月确实有定稿时才跟随，否则保持当前（避免跳到空白月）
    if (v && v !== selMonth.value && months.value.includes(v)) selMonth.value = v;
  },
);
load();
defineExpose({ load });
</script>

<style scoped>
.pbc-rank {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
}
.rank-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.rank-title {
  font-weight: 600;
  font-size: var(--fs-lg);
}
.rank-month {
  width: 132px;
}
.rank-sub {
  font-size: 12px;
}
.rank-scope {
  margin-bottom: var(--sp-3);
}
.rank-score {
  font-weight: 600;
  color: var(--el-color-primary);
}
.rank-no {
  display: inline-block;
  min-width: 22px;
  font-weight: 600;
}
.rank-top {
  background: var(--el-color-primary-light-9);
}
.delta {
  font-weight: 600;
  color: #909399;
}
.delta.up {
  color: var(--el-color-danger);
}
.delta.down {
  color: var(--el-color-success);
}
.empty {
  padding: 8px 0;
}
</style>
