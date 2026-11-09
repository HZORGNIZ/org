<template>
  <div v-for="r in rows" :key="r.rank + '-' + r.name" class="rank-row" :class="rowClass(r.rank)">
    <span class="rk-no">
      <template v-if="r.rank <= 3">{{ medal(r.rank) }}</template>
      <template v-else>{{ r.rank }}</template>
    </span>
    <span class="rk-name ellipsis">{{ r.name }}</span>
    <span class="rk-dept ellipsis">{{ r.sub }}</span>
    <span class="rk-val">{{ r.value }}</span>
  </div>
</template>

<script setup lang="ts">
import type { RankRow } from './rank-row';

/** 榜单行列表（首页各榜单卡共用）：只负责渲染，展开/收起与弹窗由外层决定 */
defineProps<{ rows: RankRow[] }>();

function medal(rank: number): string {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
}
function rowClass(rank: number): string {
  return rank <= 3 ? `rk-top rk-top-${rank}` : '';
}
</script>

<style scoped>
.rank-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 4px;
  border-bottom: 1px dashed var(--app-border, #e6eefc);
  font-size: 14px;
}
.rank-row:last-of-type {
  border-bottom: none;
}
.rank-row.rk-top {
  background: linear-gradient(90deg, rgba(66, 139, 255, 0.08), transparent);
  border-radius: 8px;
}
.rk-no {
  flex: 0 0 30px;
  text-align: center;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #6b7c99;
}
.rk-top .rk-no {
  font-size: var(--fs-lg);
}
.rk-name {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  color: var(--app-ink, #1f2d3d);
}
.rk-dept {
  flex: 0 1 34%;
  min-width: 0;
  text-align: right;
  font-size: 12px;
  color: #8a99b3;
}
.rk-val {
  flex: 0 0 auto;
  min-width: 56px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--app-brand, #2f6fed);
}
</style>
