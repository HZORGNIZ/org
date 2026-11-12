<template>
  <div class="page-card psc-card" v-loading="loading">
    <div class="block-title-row">
      <span class="block-title">项目排期计划</span>
      <div class="psc-actions">
        <template v-if="!editing">
          <el-button v-if="editable && !items.length" size="small" type="primary" @click="fillTemplate">一键生成标准阶段</el-button>
          <el-button v-if="editable" size="small" :type="items.length ? 'primary' : 'default'" plain @click="startEdit">
            {{ items.length ? '编辑排期' : '手动添加' }}
          </el-button>
        </template>
        <template v-else>
          <el-button size="small" @click="addRow">＋ 添加阶段</el-button>
          <el-button size="small" @click="cancelEdit">取消</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
        </template>
      </div>
    </div>

    <!-- 项目计划期 + 状态统计（与项目设置的起止日期同口径） -->
    <div class="psc-meta">
      <span v-if="data.startDate" class="psc-period">
        项目计划期 <b>{{ data.startDate }} ~ {{ data.endDate }}</b>
        <span class="muted">（共 {{ projectDays }} 天）</span>
      </span>
      <span v-else class="muted">项目还没设定计划起止日期，排期可先按阶段填写</span>
      <span v-if="items.length" class="psc-stat">
        <i class="psc-dot is-done"></i>已完成 {{ summary.done }}
        <i class="psc-dot is-doing"></i>进行中 {{ summary.doing }}
        <i class="psc-dot is-planned"></i>未开始 {{ summary.planned }}
        <em v-if="summary.overdue" class="psc-overdue">逾期 {{ summary.overdue }}</em>
      </span>
    </div>

    <!-- 空态 -->
    <div v-if="!editing && !items.length" class="muted empty">
      还没有排期计划。点右上角「一键生成标准阶段」按项目计划期自动铺开
      需求评审 / 开发 / 测试 / 联调 / 上线 / 验收，再按实际情况调整。
    </div>

    <!-- 只读视图：每个阶段一行，下面是相对项目计划期的进度条（含今天标记）；可编辑者可拖动行调整顺序，松手即保存 -->
    <div v-else-if="!editing" class="psc-list">
      <div
        v-for="(it, i) in items"
        :key="it.id"
        class="psc-row"
        :class="[`is-${it.status.toLowerCase()}`, { 'is-dragging': dragFrom === i }]"
        :draggable="editable && !reorderSaving"
        @dragstart="onRowDragStart(i)"
        @dragover.prevent
        @drop.prevent="onRowDrop(i)"
        @dragend="dragFrom = -1"
      >
        <div class="psc-line">
          <span v-if="editable" class="psc-drag" title="拖动调整顺序"><el-icon><Rank /></el-icon></span>
          <span class="psc-no">{{ i + 1 }}</span>
          <span class="psc-name" :title="it.name">{{ it.name }}</span>
          <el-tag size="small" :type="tagType(it)" effect="plain" class="psc-tag">{{ statusText(it) }}</el-tag>
          <span class="psc-range">{{ it.startDate }} ~ {{ it.endDate }}</span>
          <span class="psc-days">{{ it.days }} 天</span>
        </div>
        <div class="psc-track">
          <div class="psc-bar" :style="barStyle(it)"></div>
          <span v-if="todayPercent !== null" class="psc-today" :style="{ left: todayPercent + '%' }" title="今天"></span>
        </div>
        <div v-if="it.note" class="psc-note">{{ it.note }}</div>
      </div>
      <div class="psc-legend muted">
        进度条按项目计划期铺开，蓝色竖线是今天；逾期指已过结束日但状态还不是「已完成」。{{ editable ? '按住行首图标拖动可调整阶段顺序。' : '' }}
      </div>
    </div>

    <!-- 编辑视图：整表替换，保存后即为正式排期；行首手柄可拖动调整草稿顺序 -->
    <div v-else class="psc-edit">
      <div
        v-for="(row, i) in draft"
        :key="i"
        class="psc-edit-row"
        :class="{ 'is-dragging': dragFrom === i }"
        @dragover.prevent
        @drop.prevent="onDraftDrop(i)"
        @dragend="dragFrom = -1"
      >
        <span class="psc-drag" draggable="true" title="拖动调整顺序" @dragstart="onDraftDragStart(i)"><el-icon><Rank /></el-icon></span>
        <span class="psc-no">{{ i + 1 }}</span>
        <el-input v-model="row.name" size="small" placeholder="阶段名（如 需求评审）" class="pe-name" maxlength="40" />
        <el-date-picker
          v-model="row.startDate"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          placeholder="开始"
          class="pe-date"
          :disabled-date="(d: Date) => !!row.endDate && d.getTime() > new Date(row.endDate + 'T00:00:00').getTime()"
        />
        <span class="pe-sep">~</span>
        <el-date-picker
          v-model="row.endDate"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          placeholder="结束"
          class="pe-date"
          :disabled-date="(d: Date) => !!row.startDate && d.getTime() < new Date(row.startDate + 'T00:00:00').getTime()"
        />
        <el-select v-model="row.status" size="small" class="pe-status">
          <el-option label="未开始" value="PLANNED" />
          <el-option label="进行中" value="DOING" />
          <el-option label="已完成" value="DONE" />
        </el-select>
        <el-input v-model="row.note" size="small" placeholder="交付物/备注（可选）" class="pe-note" maxlength="200" />
        <el-button text type="danger" size="small" @click="draft.splice(i, 1)">删除</el-button>
      </div>
      <div v-if="!draft.length" class="muted empty">还没有阶段，点上方「＋ 添加阶段」或右上角「一键生成标准阶段」</div>
      <div class="muted psc-tip">结束日不能早于开始日；保存会整表替换现有排期（最多 30 个阶段）。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Rank } from '@element-plus/icons-vue';
import { projectsApi } from '../api';

const props = withDefaults(defineProps<{ projectId: string; canEdit?: boolean }>(), { canEdit: false });

/** 标准阶段（一键生成用）：正常研发交付链路 */
const STD_STAGES = ['需求评审', '开发', '测试', '联调', '上线', '验收'];

const loading = ref(false);
const saving = ref(false);
const editing = ref(false);
const data = ref<any>({ items: [], summary: {} });
const draft = ref<{ name: string; startDate: string; endDate: string; status: string; note: string }[]>([]);

const items = computed<any[]>(() => data.value.items || []);
const summary = computed(() => data.value.summary || { total: 0, done: 0, doing: 0, planned: 0, overdue: 0 });
/** 能不能改：以服务端口径为准（管理员/项目负责人），父组件传的 canEdit 作为补充 */
const editable = computed(() => !!props.canEdit || data.value.canEdit === true);

const projectDays = computed(() => {
  const s = data.value.startDate;
  const e = data.value.endDate;
  if (!s || !e) return 0;
  return Math.max(1, diffDays(s, e) + 1);
});

/** 进度条的时间域：优先项目计划期，没设时退回全部阶段的最小开始~最大结束 */
const domain = computed<[string, string] | null>(() => {
  if (data.value.startDate && data.value.endDate) return [data.value.startDate, data.value.endDate];
  const list = items.value;
  if (!list.length) return null;
  const starts = list.map((x) => x.startDate).sort();
  const ends = list.map((x) => x.endDate).sort();
  return [starts[0], ends[ends.length - 1]];
});

const todayPercent = computed<number | null>(() => {
  const d = domain.value;
  const today = data.value.today;
  if (!d || !today) return null;
  const span = diffDays(d[0], d[1]) + 1;
  const off = diffDays(d[0], today);
  if (off < 0 || off > span) return null;
  // 归一到 0~100 的百分数（模板里拼 %, 与甘特条同基准）
  return Math.min(100, Math.max(0, Number(((off / span) * 100).toFixed(2))));
});

function barStyle(it: any) {
  const d = domain.value;
  if (!d) return { left: '0%', width: '100%' };
  const span = diffDays(d[0], d[1]) + 1;
  const off = Math.min(Math.max(diffDays(d[0], it.startDate), 0), span - 1);
  const len = Math.min(Math.max(diffDays(it.startDate, it.endDate) + 1, 1), span - off);
  return { left: pct(off / span), width: pct(Math.max(len / span, 0.02)) };
}

function pct(v: number) {
  return `${Math.max(0, Math.min(100, v * 100)).toFixed(2)}%`;
}

/** 'YYYY-MM-DD' 相差天数（b - a）；都用 UTC 零点算，避免时区/夏令时误差 */
function diffDays(a: string, b: string) {
  const t1 = Date.parse(a + 'T00:00:00Z');
  const t2 = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.round((t2 - t1) / 86400000);
}
function addDays(a: string, n: number) {
  const t = Date.parse(a + 'T00:00:00Z');
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

function statusText(it: any) {
  if (it.overdue) return '已逾期';
  return it.status === 'DONE' ? '已完成' : it.status === 'DOING' ? '进行中' : '未开始';
}
function tagType(it: any) {
  if (it.overdue) return 'danger';
  return it.status === 'DONE' ? 'success' : it.status === 'DOING' ? 'primary' : 'info';
}

async function load() {
  if (!props.projectId) return;
  loading.value = true;
  try {
    data.value = await projectsApi.schedule(props.projectId);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '排期加载失败');
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  draft.value = items.value.map((it: any) => ({
    name: it.name,
    startDate: it.startDate,
    endDate: it.endDate,
    status: it.status,
    note: it.note || '',
  }));
  editing.value = true;
}

/** 一键生成标准阶段：按项目计划期均分 6 段（没设计划期时从今天起 6 周），先生成草稿再让人确认 */
function fillTemplate() {
  const start = data.value.startDate || data.value.today || new Date().toISOString().slice(0, 10);
  const end = data.value.endDate || addDays(start, 41);
  const total = Math.max(diffDays(start, end) + 1, STD_STAGES.length);
  const n = STD_STAGES.length;
  draft.value = STD_STAGES.map((name, i) => {
    const s = addDays(start, Math.floor((i * total) / n));
    const e = i === n - 1 ? addDays(start, total - 1) : addDays(start, Math.floor(((i + 1) * total) / n) - 1);
    return { name, startDate: s, endDate: e < s ? s : e, status: 'PLANNED', note: '' };
  });
  editing.value = true;
}

function addRow() {
  const last = draft.value[draft.value.length - 1];
  const s = last?.endDate || data.value.startDate || data.value.today || new Date().toISOString().slice(0, 10);
  draft.value.push({ name: '', startDate: s, endDate: last?.endDate || s, status: 'PLANNED', note: '' });
}

function cancelEdit() {
  editing.value = false;
  draft.value = [];
}

// ---- 拖拽排序：只读视图（可编辑者拖完即保存）与编辑视图（只调草稿顺序）共用 dragFrom ----
const dragFrom = ref(-1);
const reorderSaving = ref(false);

function onRowDragStart(i: number) {
  dragFrom.value = i;
}

async function onRowDrop(target: number) {
  const from = dragFrom.value;
  dragFrom.value = -1;
  if (from < 0 || from === target) return;
  const list = [...items.value];
  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);
  reorderSaving.value = true;
  try {
    // 保存接口按传入顺序落 sortOrder，整表替换但内容不变，只改顺序
    data.value = await projectsApi.saveSchedule(
      props.projectId,
      list.map((r) => ({ name: r.name, startDate: r.startDate, endDate: r.endDate, status: r.status, note: r.note || null })),
    );
    ElMessage.success('阶段顺序已保存');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '顺序保存失败');
  } finally {
    reorderSaving.value = false;
  }
}

function onDraftDragStart(i: number) {
  dragFrom.value = i;
}

function onDraftDrop(target: number) {
  const from = dragFrom.value;
  dragFrom.value = -1;
  if (from < 0 || from === target) return;
  const list = [...draft.value];
  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);
  draft.value = list;
}

async function save() {
  if (!draft.value.length) {
    ElMessage.warning('至少保留 1 个阶段');
    return;
  }
  for (let i = 0; i < draft.value.length; i += 1) {
    const r = draft.value[i];
    if (!r.name.trim()) return ElMessage.warning(`第 ${i + 1} 个阶段缺名称`);
    if (!r.startDate || !r.endDate) return ElMessage.warning(`阶段「${r.name.trim()}」缺开始/结束日期`);
    if (diffDays(r.startDate, r.endDate) < 0) return ElMessage.warning(`阶段「${r.name.trim()}」的结束日不能早于开始日`);
  }
  saving.value = true;
  try {
    data.value = await projectsApi.saveSchedule(
      props.projectId,
      draft.value.map((r) => ({
        name: r.name.trim(),
        startDate: r.startDate,
        endDate: r.endDate,
        status: r.status,
        note: r.note.trim() || null,
      })),
    );
    editing.value = false;
    draft.value = [];
    ElMessage.success('排期已保存');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
watch(
  () => props.projectId,
  () => {
    editing.value = false;
    draft.value = [];
    load();
  },
);
</script>

<style scoped>
.psc-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 标题在左、操作按钮在右（与项目其它面板的 .block-title-row 排版一致） */
.block-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.block-title {
  font-weight: 600;
  font-size: 15px;
}
.psc-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.psc-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #606266;
}
.psc-period b {
  color: #1f2d3d;
}
.psc-stat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #606266;
}
.psc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.psc-dot.is-done {
  background: #67c23a;
}
.psc-dot.is-doing {
  background: #2f6fed;
}
.psc-dot.is-planned {
  background: #c0c4cc;
}
.psc-overdue {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: #fef0f0;
  color: #f56c6c;
  font-style: normal;
}
.psc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.psc-row {
  padding: 8px 10px;
  border: 1px solid #eef1f6;
  border-left: 3px solid #c0c4cc;
  border-radius: 8px;
  background: #fcfdff;
}
/* 可编辑者的拖拽手柄与拖动中的视觉反馈 */
.psc-drag {
  display: inline-flex;
  color: #b6c3d6;
  cursor: grab;
  flex: 0 0 auto;
}
.psc-drag:hover {
  color: #2f6fed;
}
.psc-drag:active {
  cursor: grabbing;
}
.is-dragging {
  opacity: 0.45;
}
.psc-row.is-doing {
  border-left-color: #2f6fed;
  background: #f7faff;
}
.psc-row.is-done {
  border-left-color: #67c23a;
}
.psc-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.psc-no {
  flex: 0 0 20px;
  height: 20px;
  border-radius: 50%;
  background: #eef2f9;
  color: #5b6b85;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
}
.psc-name {
  font-size: 14px;
  font-weight: 600;
  color: #1f2d3d;
  max-width: 34%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.psc-range {
  font-size: 12px;
  color: #475569;
  font-variant-numeric: tabular-nums;
}
.psc-days {
  font-size: 12px;
  color: #8a99b3;
}
.psc-line .psc-range {
  margin-left: auto;
}
/* 甘特条：相对项目计划期定位，蓝线=今天 */
.psc-track {
  position: relative;
  height: 8px;
  margin-top: 8px;
  border-radius: 999px;
  background: #f0f3f9;
  overflow: hidden;
}
.psc-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: #c0c4cc;
  min-width: 6px;
}
.psc-row.is-doing .psc-bar {
  background: linear-gradient(90deg, #5b93f7, #2f6fed);
}
.psc-row.is-done .psc-bar {
  background: #67c23a;
}
.psc-today {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: #2f6fed;
  box-shadow: 0 0 0 1px rgba(47, 111, 237, 0.25);
}
.psc-note {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
  overflow-wrap: anywhere;
}
.psc-legend {
  font-size: 12px;
  padding-top: 2px;
}
.psc-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.psc-edit-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px dashed #dbe3f0;
  border-radius: 8px;
}
.pe-name {
  width: 150px;
}
.pe-date {
  width: 140px;
}
.pe-sep {
  color: #a8b0c0;
}
.pe-status {
  width: 104px;
}
.pe-note {
  flex: 1 1 160px;
  min-width: 120px;
}
.psc-tip {
  font-size: 12px;
}
@media (max-width: 767px) {
  /* 手机端：阶段行改成两行，日期/状态换行到第二行，避免挤爆宽度 */
  .psc-line {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .psc-name {
    max-width: 60%;
  }
  .psc-line .psc-range {
    margin-left: 0;
  }
  .psc-edit-row {
    align-items: flex-start;
  }
  .pe-name,
  .pe-date,
  .pe-status,
  .pe-note {
    width: 100%;
    flex: 1 1 100%;
  }
}
</style>
