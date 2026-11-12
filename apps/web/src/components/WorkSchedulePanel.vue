<template>
  <div class="wp-panel" :class="{ 'page-card': card }">
    <div class="wp-head">
      <div class="wp-title">
        {{ title }}
        <span class="muted wp-sub">
          勾选每周固定项目实践的时间段；只有当天勾选了时段，系统才会在提醒时间把你当「应发日报人员」催日报。
        </span>
      </div>
      <div class="wp-actions">
        <el-button v-if="showManageLink" size="small" text type="primary" @click="goReports">去工作管理 →</el-button>
        <el-button v-if="hasDefaultWeekend" size="small" type="warning" plain :disabled="saving || loading" @click="clearWeekendDefaults">
          取消周末默认时段
        </el-button>
        <el-button size="small" :disabled="!dirty || saving || loading" @click="reset">还原</el-button>
        <el-button size="small" type="primary" :loading="saving" :disabled="!dirty || loading" @click="save">
          保存安排
        </el-button>
      </div>
    </div>

    <div class="wp-meta">
      <el-tag size="small" type="success" effect="plain">
        本周 {{ summary.weekSlots }} 段 · {{ summary.weekHours }} 小时
      </el-tag>
      <el-tag size="small" :type="summary.todaySlots ? 'primary' : 'info'" effect="plain">
        今天（{{ todayLabel || '—' }}）
        {{ summary.todaySlots ? `${summary.todaySlots} 段 · ${summary.todayHours} 小时` : '未勾选，今天不会收到日报提醒' }}
      </el-tag>
      <el-tag v-if="dirty" size="small" type="warning" effect="plain">有未保存的修改</el-tag>
    </div>

    <div v-loading="loading" class="wp-scroll">
      <div class="wp-grid">
        <div class="wp-corner muted">时间段</div>
        <div
          v-for="(label, w) in WEEKDAYS"
          :key="'wp-day-' + w"
          class="wp-day"
          :class="{ today: w === todayWeekday }"
        >
          {{ label }}
          <span v-if="w === todayWeekday" class="wp-day-today">今天</span>
        </div>
        <template v-for="p in presets" :key="p.key">
          <div class="wp-slot">
            <b>{{ p.label }}</b>
            <span class="muted wp-slot-range">{{ p.range }}</span>
          </div>
          <button
            v-for="(dayLabel, w) in WEEKDAYS"
            :key="p.key + '-' + w"
            type="button"
            class="wp-cell"
            :class="{ on: isSlotOn(w, p), today: w === todayWeekday }"
            :aria-pressed="isSlotOn(w, p)"
            :title="slotTitle(dayLabel, p, isSlotOn(w, p))"
            @click="toggleSlot(w, p)"
          >
            <el-icon v-if="isSlotOn(w, p)" class="wp-check"><Check /></el-icon>
            <span v-else>休</span>
          </button>
        </template>
      </div>
    </div>
    <div class="muted wp-tip">
      固定三档项目实践时段（上午 10:00-12:00 / 下午 14:00-18:00 / 晚上 18:00-20:00），按周循环；改完点「保存安排」长期生效。
      <template v-if="hasDefaultWeekend">
        系统此前为你默认安排了周六/周日的下午与晚上，如不需要可点右上角
        <b>「取消周末默认时段」</b>一键取消（其余勾选不受影响）。
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Check } from '@element-plus/icons-vue';
import { reportsApi } from '../api';

withDefaults(
  defineProps<{
    /** 是否自带 page-card 外观（首页/独立 TAB 内通常为 true） */
    card?: boolean;
    /** 标题（首页卡片、工作管理 TAB 可传不同文案） */
    title?: string;
    /** 是否显示「去工作管理」入口（首页用） */
    showManageLink?: boolean;
  }>(),
  { card: true, title: '我的工作时间安排', showManageLink: false },
);

const router = useRouter();

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
type WorkPreset = { key: string; label: string; range: string; startMin: number; endMin: number };
const PRESETS_FALLBACK: WorkPreset[] = [
  { key: 'AM', label: '上午', range: '10:00-12:00', startMin: 10 * 60, endMin: 12 * 60 },
  { key: 'PM', label: '下午', range: '14:00-18:00', startMin: 14 * 60, endMin: 18 * 60 },
  { key: 'EVE', label: '晚上', range: '18:00-20:00', startMin: 18 * 60, endMin: 20 * 60 },
];

const presets = ref<WorkPreset[]>(PRESETS_FALLBACK);
const slots = ref<Record<string, boolean>>({});
const savedMap = ref<Record<string, boolean>>({});
const todayWeekday = ref(-1);
const todayLabel = ref('');
const loading = ref(false);
const saving = ref(false);

const slotKey = (w: number, p: WorkPreset) => `${w}-${p.startMin}`;
const isSlotOn = (w: number, p: WorkPreset) => !!slots.value[slotKey(w, p)];
const slotTitle = (dayLabel: string, p: WorkPreset, on: boolean) =>
  `${dayLabel} ${p.label} ${p.range}：${on ? '已勾选，点击取消' : '未勾选，点击安排'}`;

function toggleSlot(w: number, p: WorkPreset) {
  const k = slotKey(w, p);
  slots.value = { ...slots.value, [k]: !slots.value[k] };
}

const dirty = computed(() => {
  const pick = (m: Record<string, boolean>) => Object.keys(m).filter((k) => m[k]).sort().join(',');
  return pick(slots.value) !== pick(savedMap.value);
});

const summary = computed(() => {
  const hoursByStart = new Map<number, number>();
  for (const p of presets.value) hoursByStart.set(p.startMin, (p.endMin - p.startMin) / 60);
  let weekSlots = 0;
  let weekHours = 0;
  let todaySlots = 0;
  let todayHours = 0;
  for (const [k, on] of Object.entries(slots.value)) {
    if (!on) continue;
    const [wStr, startStr] = k.split('-');
    const hours = hoursByStart.get(Number(startStr)) ?? 0;
    weekSlots += 1;
    weekHours += hours;
    if (Number(wStr) === todayWeekday.value) {
      todaySlots += 1;
      todayHours += hours;
    }
  }
  return {
    weekSlots,
    weekHours: Math.round(weekHours * 10) / 10,
    todaySlots,
    todayHours: Math.round(todayHours * 10) / 10,
  };
});

function mapOf(rows: { weekday: number; startMin: number }[] | undefined) {
  const out: Record<string, boolean> = {};
  for (const r of rows ?? []) out[`${r.weekday}-${r.startMin}`] = true;
  return out;
}

function apply(r: any) {
  if (Array.isArray(r?.presets) && r.presets.length) presets.value = r.presets;
  if (Number.isInteger(r?.todayWeekday)) todayWeekday.value = r.todayWeekday;
  if (typeof r?.todayLabel === 'string') todayLabel.value = r.todayLabel;
  const map = mapOf(r?.slots);
  slots.value = { ...map };
  savedMap.value = { ...map };
}

async function load() {
  loading.value = true;
  try {
    apply(await reportsApi.workSlots());
  } catch {
    ElMessage.error('工作时间安排加载失败，请刷新重试');
  } finally {
    loading.value = false;
  }
}

function reset() {
  slots.value = { ...savedMap.value };
}

// ---- 一键取消周末默认时段：系统此前批量默认的 周六(5)/周日(6) × 下午(840)/晚上(1080) ----
const DEFAULT_WEEKEND_KEYS = ['5-840', '5-1080', '6-840', '6-1080'];
const hasDefaultWeekend = computed(() => DEFAULT_WEEKEND_KEYS.some((k) => savedMap.value[k]));

async function clearWeekendDefaults() {
  try {
    await ElMessageBox.confirm(
      '将取消周六、周日的「下午 14:00-18:00」与「晚上 18:00-20:00」共 4 个默认时段，其余勾选保持不变，保存后立即生效。',
      '取消周末默认时段',
      { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '先不改' },
    );
  } catch {
    return; // 用户点了「先不改」
  }
  const next = { ...slots.value };
  for (const k of DEFAULT_WEEKEND_KEYS) next[k] = false;
  slots.value = next;
  await save();
}

async function save() {
  const rows: { weekday: number; startMin: number; endMin: number }[] = [];
  for (const p of presets.value) {
    for (let w = 0; w < WEEKDAYS.length; w++) {
      if (slots.value[slotKey(w, p)]) rows.push({ weekday: w, startMin: p.startMin, endMin: p.endMin });
    }
  }
  saving.value = true;
  try {
    const r = await reportsApi.saveWorkSlots(rows);
    apply(r ?? { slots: rows });
    ElMessage.success(
      rows.length
        ? `已保存 ${rows.length} 个时间段（每周 ${summary.value.weekHours} 小时）`
        : '已清空工作时间安排：之后不会再收到日报提醒',
    );
  } catch {
    ElMessage.error('保存失败，请稍后重试');
  } finally {
    saving.value = false;
  }
}

function goReports() {
  router.push('/reports?tab=schedule');
}

defineExpose({ reload: load });
onMounted(load);
</script>

<style scoped>
.wp-panel {
  min-width: 0;
}
.wp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.wp-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}
.wp-sub {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
}
.wp-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.wp-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 10px 0;
}
/* 窄屏横向滚动：格子最窄 62px，7 天 + 时间段列不会挤压变形 */
.wp-scroll {
  overflow-x: auto;
  padding-bottom: 2px;
}
.wp-grid {
  display: grid;
  grid-template-columns: 96px repeat(7, minmax(62px, 1fr));
  gap: 6px;
  min-width: 540px;
}
.wp-corner {
  display: flex;
  align-items: center;
  font-size: 12px;
}
.wp-day {
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
.wp-day.today {
  background: #eaf2ff;
  color: #1b4fa8;
}
.wp-day-today {
  font-size: var(--fs-2xs);
  font-weight: 400;
  color: #1b4fa8;
}
.wp-slot {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px 8px;
  border-radius: 8px;
  background: #f7f9fc;
}
.wp-slot b {
  font-size: 12px;
  font-weight: 600;
  color: #303133;
}
.wp-slot-range {
  font-size: var(--fs-2xs);
  line-height: 1.4;
}
.wp-cell {
  height: 36px;
  border: 1px dashed #d9e2f0;
  border-radius: 8px;
  background: #fff;
  color: #a8b4c4;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s;
}
.wp-cell:hover {
  border-color: #9dbdf0;
  color: #3a6bb5;
}
.wp-cell.today {
  border-color: #c7dbfa;
}
.wp-cell.on {
  border-style: solid;
  border-color: #1b4fa8;
  background: #1b4fa8;
  color: #fff;
  font-weight: 600;
}
.wp-check {
  font-size: 16px;
  font-weight: 700;
}
.wp-tip {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
}
</style>
