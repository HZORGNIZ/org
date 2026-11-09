<template>
  <div class="page-card rank-card-home">
    <div class="page-title rank-hd">
      <span class="rk-title">{{ title }}</span>
      <span v-if="subtitle" class="rk-subtitle">{{ subtitle }}</span>
    </div>

    <div v-if="!rows.length" class="muted empty">{{ emptyText || '暂无数据' }}</div>
    <template v-else>
      <RankRows :rows="shown" />
      <button v-if="rows.length > TOP_N" type="button" class="rank-more" @click="expand = !expand">
        {{ expand ? '收起' : `展开全部（共 ${rows.length} 人）` }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import RankRows from './RankRows.vue';
import type { RankRow } from './rank-row';

const props = withDefaults(
  defineProps<{ title: string; subtitle?: string; rows: RankRow[]; emptyText?: string }>(),
  { subtitle: '', emptyText: '' },
);

const TOP_N = 10;
const expand = ref(false);
const shown = computed(() => (expand.value ? props.rows : props.rows.slice(0, TOP_N)));
</script>

<style scoped>
/* 页头里 ::before 竖条也是 flex item，标题靠左紧贴竖条，副标题用 margin-left:auto 顶到右边 */
.rank-hd {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  gap: var(--sp-2);
}
.rk-subtitle {
  margin-left: auto;
  font-size: var(--fs-xs);
  font-weight: 500;
  opacity: 0.85;
}
/* 「展开全部 / 只看前 5」：与 styles.css 里的 .rank-more 同一套胶囊描边 */
.rank-more {
  width: 100%;
  margin-top: var(--sp-2);
  padding: 6px 0;
  border: 1px dashed var(--chip-line);
  border-radius: var(--r-sm);
  background: #fff;
  color: var(--chip-ink);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.rank-more:hover {
  border-color: var(--app-brand-ink);
  color: var(--app-brand-ink);
  background: var(--app-band);
}
</style>
