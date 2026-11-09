<template>
  <div
    class="page-card rank-card-home rank-rotator"
    @mouseenter="paused = true"
    @mouseleave="paused = false"
    @focusin="paused = true"
    @focusout="paused = false"
  >
    <div class="page-title rank-hd">
      <div class="rr-tabs" role="tablist" aria-label="公司排行">
        <button
          v-for="(t, i) in tabs"
          :key="t.key"
          type="button"
          role="tab"
          class="rr-tab"
          :class="{ on: i === active }"
          :aria-selected="i === active"
          @click="pick(i)"
        >
          {{ t.label }}
        </button>
      </div>
      <span class="rk-subtitle">{{ cur.subtitle || '' }}</span>
    </div>

    <div v-if="!cur.rows.length" class="muted empty">{{ cur.emptyText || '暂无数据' }}</div>
    <template v-else>
      <RankRows :rows="shownRows" />
      <button v-if="cur.rows.length > topN" type="button" class="rank-more" @click="toggleExpand">
        {{ expanded ? '收起' : `展开全部（共 ${cur.rows.length} 人）` }}
      </button>
    </template>

    <!-- 数据量大时展开走弹窗：右栏很窄，几十行铺开会把首页拉得很长 -->
    <el-dialog v-model="dialogOpen" :title="dialogTitle" width="520px" append-to-body class="rank-dialog">
      <div class="rank-dialog-body"><RankRows :rows="dialogRows" /></div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import RankRows from './RankRows.vue';
import type { RankRow, RankTab } from './rank-row';

/**
 * 首页「公司排行」轮播卡：多个小 tab 自动轮流切换（默认 6 秒），
 * 鼠标悬浮 / 键盘聚焦 / 弹窗打开时暂停，移开后继续；支持手动点 tab。
 * 每页默认只显示前 10 名，展开时：行数不超过 inlineLimit 就地在卡片内展开，
 * 超过则改用弹窗展示全部（右栏窄，几十行会拉长首页）。
 */
const props = withDefaults(
  defineProps<{ tabs: RankTab[]; interval?: number; topN?: number; inlineLimit?: number }>(),
  { interval: 6000, topN: 10, inlineLimit: 20 },
);

const active = ref(0);
const paused = ref(false);
const expanded = ref(false);
const dialogKey = ref('');
const cur = computed<RankTab>(
  () => props.tabs[active.value] ?? props.tabs[0] ?? { key: '', label: '', rows: [] as RankRow[] },
);
const shownRows = computed(() => (expanded.value ? cur.value.rows : cur.value.rows.slice(0, props.topN)));
const dialogTab = computed(() => props.tabs.find((t) => t.key === dialogKey.value) || null);
const dialogOpen = computed({
  get: () => !!dialogTab.value,
  set: (v: boolean) => {
    if (!v) dialogKey.value = '';
  },
});
const dialogRows = computed(() => dialogTab.value?.rows ?? []);
const dialogTitle = computed(() =>
  dialogTab.value ? `${dialogTab.value.label} · 共 ${dialogTab.value.rows.length} 人` : '',
);

function pick(i: number) {
  active.value = i;
  expanded.value = false;
  restart();
}

function toggleExpand() {
  if (expanded.value) {
    expanded.value = false;
    return;
  }
  if (cur.value.rows.length > props.inlineLimit) {
    dialogKey.value = cur.value.key;
    return;
  }
  expanded.value = true;
}

let timer: number | undefined;
function stop() {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}
function restart() {
  stop();
  if (props.tabs.length < 2) return;
  timer = window.setInterval(() => {
    // 悬浮/聚焦/弹窗打开/页面切到后台时都不切，避免"正在看的时候自己翻页"
    if (paused.value || dialogOpen.value || document.hidden) return;
    active.value = (active.value + 1) % props.tabs.length;
    expanded.value = false;
  }, props.interval);
}

onMounted(restart);
onBeforeUnmount(stop);
watch(
  () => props.tabs.length,
  (n) => {
    if (active.value >= n) active.value = 0;
    restart();
  },
);
</script>

<style scoped>
/* 页头：左侧小 tab，右侧当前页的副标题（口径/区间） */
.rank-hd {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.rr-tabs {
  display: inline-flex;
  gap: 6px;
  /* 四页时（工时/日报 × 本周/本月）右栏很窄，允许换行避免把卡片撑出横向滚动 */
  flex-wrap: wrap;
}
/* 基底样式（描边/字色/选中渐变）已在 styles.css 的 .rr-tab 全局统一定义，这里只留尺寸 */
.rr-tab {
  padding: 2px 9px;
  line-height: 18px;
  white-space: nowrap;
}
.rk-subtitle {
  margin-left: auto;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--row-head-ink);
}
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
.rank-dialog-body {
  max-height: 60vh;
  overflow-y: auto;
}
</style>
