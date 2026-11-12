<template>
  <div
    ref="rootEl"
    class="page-card pms-card"
    v-loading="loading"
    @mouseenter="pauseByHover"
    @mouseleave="resumeFromHover"
  >
    <div class="pms-head">
      <div class="pms-title">
        <span class="block-title">成员实践/培训时间安排</span>
        <span class="muted pms-sub">
          本项目成员的每周固定项目实践/培训时段（周一~周日 × 上午 / 下午 / 晚上）；
          只有当天勾选了时段，系统才会把他算作「应发日报人员」发提醒。
        </span>
      </div>
      <div class="pms-tools">
        <span class="muted pms-count">共 {{ memberList.length }} 人</span>
        <el-button size="small" :type="autoPlay ? 'primary' : 'default'" :plain="!autoPlay" @click="toggleAutoPlay">
          {{ autoPlay ? '自动轮播中' : '已暂停轮播' }}
        </el-button>
      </div>
    </div>

    <div v-if="!memberList.length" class="muted pms-empty">项目还没有成员，暂无工作时间可展示。</div>

    <template v-else>
      <!-- 二级 TAB：一个成员一个页签，左右箭头切换，默认每 8 秒自动轮播 -->
      <div class="pms-nav">
        <button
          type="button"
          class="pms-arrow"
          title="上一个成员"
          :disabled="memberList.length < 2"
          @click="go(-1)"
        >
          ‹
        </button>
        <div ref="tabsEl" class="pms-tabs">
          <button
            v-for="m in memberList"
            :key="m.id"
            type="button"
            class="pms-tab"
            :class="{ on: m.id === activeId }"
            @click="pick(m.id)"
          >
            <el-avatar :size="20" :src="m.avatar || undefined">{{ (m.name || '?').slice(0, 1) }}</el-avatar>
            <span class="pms-tab-name">{{ m.name }}</span>
            <i v-if="m.isOwner" class="pms-owner">负责人</i>
          </button>
        </div>
        <button
          type="button"
          class="pms-arrow"
          title="下一个成员"
          :disabled="memberList.length < 2"
          @click="go(1)"
        >
          ›
        </button>
      </div>
      <div v-if="autoPlay && memberList.length > 1" class="pms-progress" :class="{ paused: hovered }">
        <i :key="progressKey" :style="{ animationDuration: AUTO_MS + 'ms' }"></i>
      </div>

      <div class="pms-body">
        <div class="pms-meta">
          <span class="pms-who">
            {{ curMember?.name || '—' }}
            <template v-if="curMember?.position"><em class="muted">{{ curMember.position }}</em></template>
            <template v-else-if="curMember?.isOwner"><em class="muted">项目负责人</em></template>
          </span>
          <el-tag size="small" type="success" effect="plain">
            本周 {{ cur.totalSlots || 0 }} 段 · {{ cur.totalHours || 0 }} 小时
          </el-tag>
          <el-tag size="small" :type="(cur.todaySlots || []).length ? 'primary' : 'info'" effect="plain">
            今天（{{ todayLabel || '—' }}）
            {{ (cur.todaySlots || []).length ? `${cur.todaySlots.length} 段 · ${cur.todayHours} 小时` : '未勾选，今天不会收到日报提醒' }}
          </el-tag>
        </div>

        <div class="pms-scroll">
          <div class="pms-grid">
            <div class="pms-corner muted">时间段</div>
            <div
              v-for="(label, w) in WEEKDAYS"
              :key="'pms-day-' + w"
              class="pms-day"
              :class="{ today: w === todayWeekday }"
            >
              {{ label }}
              <span v-if="w === todayWeekday" class="pms-day-today">今天</span>
            </div>
            <template v-for="p in presets" :key="p.key">
              <div class="pms-slot">
                <b>{{ p.label }}</b>
                <span class="muted pms-slot-range">{{ p.range }}</span>
              </div>
              <div
                v-for="(dayLabel, w) in WEEKDAYS"
                :key="p.key + '-pms-' + w"
                class="pms-cell"
                :class="{ on: isOn(w, p), today: w === todayWeekday }"
                :title="`${dayLabel} ${p.label} ${p.range}：${isOn(w, p) ? '已勾选' : '未勾选'}`"
              >
                <el-icon v-if="isOn(w, p)" class="pms-check"><Check /></el-icon>
                <span v-else>休</span>
              </div>
            </template>
          </div>
        </div>
        <div class="muted pms-tip">
          这里只读展示，成员本人可在「工作管理 → 我的工作时间」或首页卡片自行调整；
          左右箭头或上方页签可切换成员，鼠标移入会暂停自动轮播。
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Check } from '@element-plus/icons-vue';
import { reportsApi } from '../api';

const props = withDefaults(
  defineProps<{
    /** 项目成员（排除负责人，与详情页成员卡片同源） */
    members?: any[];
    /** 项目负责人（固定排在第一位） */
    owner?: any;
  }>(),
  { members: () => [], owner: null },
);

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PRESETS_FALLBACK = [
  { key: 'AM', label: '上午', range: '10:00-12:00', startMin: 10 * 60, endMin: 12 * 60 },
  { key: 'PM', label: '下午', range: '14:00-18:00', startMin: 14 * 60, endMin: 18 * 60 },
  { key: 'EVE', label: '晚上', range: '18:00-20:00', startMin: 18 * 60, endMin: 20 * 60 },
];

const AUTO_MS = 8000;

const data = ref<any>(null);
const loading = ref(false);
const activeId = ref('');
const autoPlay = ref(true);
const hovered = ref(false);
const progressKey = ref(0);
const tabsEl = ref<HTMLElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);
let timer: number | null = null;
let io: IntersectionObserver | null = null;

/** 负责人 + 成员（去重、负责人排第一） */
const memberList = computed(() => {
  const out: { id: string; name: string; avatar?: string; isOwner: boolean; position?: string }[] = [];
  const seen = new Set<string>();
  const o = props.owner;
  if (o?.id) {
    out.push({ id: o.id, name: o.name || '负责人', avatar: o.avatar, isOwner: true });
    seen.add(o.id);
  }
  for (const m of props.members ?? []) {
    const id = m?.userId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: m?.user?.name || '未命名成员', avatar: m?.user?.avatar, isOwner: false, position: m?.position || '' });
  }
  return out;
});

const presets = computed(() =>
  Array.isArray(data.value?.presets) && data.value.presets.length ? data.value.presets : PRESETS_FALLBACK,
);
const todayWeekday = computed(() => (Number.isInteger(data.value?.todayWeekday) ? data.value.todayWeekday : -1));
const todayLabel = computed(() => data.value?.todayLabel || '');

const curMember = computed(() => memberList.value.find((m) => m.id === activeId.value) || null);
const cur = computed(() => {
  const hit = (data.value?.users || []).find((u: any) => u.userId === activeId.value);
  return hit || { userId: activeId.value, slots: [], totalSlots: 0, totalHours: 0, todaySlots: [], todayHours: 0 };
});
const onSet = computed(() => new Set((cur.value.slots || []).map((s: any) => `${s.weekday}-${s.startMin}`)));
const isOn = (w: number, p: { startMin: number }) => onSet.value.has(`${w}-${p.startMin}`);

async function load() {
  const ids = memberList.value.map((m) => m.id);
  if (!ids.length) {
    data.value = null;
    return;
  }
  loading.value = true;
  try {
    data.value = await reportsApi.workSlotsBatch(ids);
  } catch {
    ElMessage.error('成员实践/培训时间加载失败，请刷新重试');
  } finally {
    loading.value = false;
  }
  if (!ids.includes(activeId.value)) activeId.value = ids[0];
  scrollActiveIntoView();
}

// 成员变化（新增/移除/换负责人）时重新拉取，保留当前选中的人
watch(() => memberList.value.map((m) => m.id).join(','), load, { immediate: true });

function idxOf(id: string) {
  return memberList.value.findIndex((m) => m.id === id);
}

function pick(id: string) {
  activeId.value = id;
  scrollActiveIntoView();
  restartTimer();
}

/** step = -1 上一个 / 1 下一个（首尾循环） */
function go(step: number) {
  const n = memberList.value.length;
  if (n < 2) return;
  const i = idxOf(activeId.value);
  activeId.value = memberList.value[(i + step + n) % n].id;
  scrollActiveIntoView();
  restartTimer();
}

function scrollActiveIntoView() {
  nextTick(() => {
    const box = tabsEl.value;
    if (!box) return;
    const el = box.querySelector('.pms-tab.on') as HTMLElement | null;
    if (!el) return;
    box.scrollTo({ left: Math.max(0, el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2), behavior: 'smooth' });
  });
}

function stopTimer() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  if (!autoPlay.value || hovered.value || memberList.value.length < 2) return;
  progressKey.value += 1;
  timer = window.setInterval(() => {
    // 页面在后台（切走标签页）时跳过，回来继续轮播
    if (document.hidden) return;
    const n = memberList.value.length;
    const i = idxOf(activeId.value);
    activeId.value = memberList.value[(i + 1) % n].id;
    progressKey.value += 1;
    scrollActiveIntoView();
  }, AUTO_MS);
}

/** 手动切换后重置计时，避免刚点完就被自动切走 */
function restartTimer() {
  startTimer();
}

function toggleAutoPlay() {
  autoPlay.value = !autoPlay.value;
  if (autoPlay.value) startTimer();
  else stopTimer();
}

function pauseByHover() {
  hovered.value = true;
  stopTimer();
}

function resumeFromHover() {
  hovered.value = false;
  startTimer();
}

/**
 * 只在卡片真正可见时轮播：切到别的 TAB（pane 被 display:none）或滚出视口就暂停，
 * 回到本 TAB 再继续，避免在后台空转。
 */
onMounted(() => {
  if (!rootEl.value || typeof IntersectionObserver === 'undefined') {
    startTimer();
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) startTimer();
      else stopTimer();
    },
    { threshold: 0.2 },
  );
  io.observe(rootEl.value);
});
onUnmounted(() => {
  io?.disconnect();
  io = null;
  stopTimer();
});
</script>

<style scoped>
.pms-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.pms-title {
  min-width: 0;
}
.pms-sub {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.pms-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.pms-count {
  font-size: 12px;
}
.pms-empty {
  padding: 18px 0;
  font-size: 13px;
}

/* ---- 二级 TAB（成员页签）+ 左右箭头 ---- */
.pms-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  border-bottom: 1px solid #ebeef5;
}
.pms-arrow {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: 1px solid #dcdfe6;
  border-radius: 50%;
  background: #fff;
  color: #5c6b80;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.12s;
}
.pms-arrow:hover:not(:disabled) {
  border-color: #1b4fa8;
  color: #1b4fa8;
  background: #f2f7ff;
}
.pms-arrow:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pms-tabs {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px 0 0;
}
.pms-tabs::-webkit-scrollbar {
  display: none;
}
.pms-tab {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #5c6b80;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}
.pms-tab:hover {
  color: #1b4fa8;
  background: #f6f9ff;
}
.pms-tab.on {
  color: #1b4fa8;
  font-weight: 600;
  border-bottom-color: #1b4fa8;
}
.pms-owner {
  font-style: normal;
  font-size: var(--fs-2xs);
  color: #c45656;
  border: 1px solid #f3d2d2;
  border-radius: 4px;
  padding: 0 3px;
  background: #fdf3f3;
}
.pms-progress {
  height: 2px;
  margin-top: 2px;
  background: #f0f3f8;
  border-radius: 2px;
  overflow: hidden;
}
.pms-progress i {
  display: block;
  height: 100%;
  width: 0;
  background: #1b4fa8;
  animation-name: pms-fill;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
.pms-progress.paused i {
  animation-play-state: paused;
}
@keyframes pms-fill {
  from {
    width: 0;
  }
  to {
    width: 100%;
  }
}

/* ---- 当前成员整周表格 ---- */
.pms-body {
  margin-top: 10px;
}
.pms-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.pms-who {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}
.pms-who em {
  margin-left: 6px;
  font-style: normal;
  font-size: 12px;
  font-weight: 400;
}
.pms-scroll {
  overflow-x: auto;
  padding-bottom: 2px;
}
.pms-grid {
  display: grid;
  grid-template-columns: 96px repeat(7, minmax(62px, 1fr));
  gap: 6px;
  min-width: 540px;
}
.pms-corner {
  display: flex;
  align-items: center;
  font-size: 12px;
}
.pms-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 0;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #4b6b99;
}
.pms-day.today {
  background: #eaf2ff;
  color: #1b4fa8;
}
.pms-day-today {
  font-size: var(--fs-2xs);
  font-weight: 400;
  color: #1b4fa8;
}
.pms-slot {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px 8px;
  border-radius: 8px;
  background: #f7f9fc;
}
.pms-slot b {
  font-size: 12px;
  font-weight: 600;
  color: #303133;
}
.pms-slot-range {
  font-size: var(--fs-2xs);
  line-height: 1.4;
}
.pms-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  border: 1px dashed #d9e2f0;
  border-radius: 8px;
  background: #fff;
  color: #a8b4c4;
  font-size: 12px;
}
.pms-cell.today {
  border-color: #c7dbfa;
}
.pms-cell.on {
  border-style: solid;
  border-color: #1b4fa8;
  background: #1b4fa8;
  color: #fff;
  font-weight: 600;
}
.pms-check {
  font-size: 16px;
  font-weight: 700;
}
.pms-tip {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
}
@media (max-width: 767px) {
  .pms-tools {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
