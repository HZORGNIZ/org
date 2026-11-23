<template>
  <div class="myday-wrap">
    <!-- 顶部：视图切换（月历默认）+ 日期/月份导航 + 添加日程 -->
    <div class="page-card myday-head">
      <div class="myday-nav">
        <el-radio-group v-model="view" size="small" @change="onViewChange">
          <el-radio-button value="month">月历</el-radio-button>
          <el-radio-button value="day">单日</el-radio-button>
        </el-radio-group>
        <template v-if="view === 'month'">
          <el-button size="small" @click="shiftMonth(-1)">‹</el-button>
          <b class="myday-month-label">{{ monthStr }}</b>
          <el-button size="small" @click="shiftMonth(1)">›</el-button>
          <el-button v-if="monthStr !== today.slice(0, 7)" size="small" text type="primary" @click="goThisMonth">回到本月</el-button>
        </template>
        <template v-else>
          <el-button size="small" @click="shiftDay(-1)">前一天</el-button>
          <el-date-picker v-model="dateStr" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width: 150px" @change="load" />
          <el-button size="small" @click="shiftDay(1)">后一天</el-button>
          <el-button v-if="dateStr !== today" size="small" text type="primary" @click="goToday">回到今天</el-button>
          <span class="myday-weekday">{{ tl?.weekday }}</span>
        </template>
      </div>
      <div v-if="view === 'day'" class="myday-stats">
        <button
          v-for="f in filters"
          :key="f.key"
          class="stat-chip"
          :class="[f.cls, { active: filter === f.key }]"
          @click="filter = f.key"
        >{{ f.label }} {{ f.n }}</button>
        <el-button type="primary" size="small" @click="openAdd()">＋ 添加安排</el-button>
      </div>
      <!-- 未设置排班：可约时段按默认 9:00-18:00 计算，提示去设置 -->
      <div v-if="view === 'day' && tl?.scheduleBasis === 'default'" class="myday-sched-tip">
        你还没有设置工作排班，「可约时段」按默认 <b>工作日 9:00-18:00</b> 计算。
        打开智能体里的「我的日程」小助理，说「设置排班」即可自定义。
      </div>
    </div>

    <!-- 月历视图：整月摊开（过去 + 未来都在同一屏），点日期进入该日时间轴 -->
    <div v-if="view === 'month'" class="page-card" v-loading="monthLoading">
      <div class="month-grid">
        <div v-for="w in DOW" :key="w" class="month-dow" :class="{ sun: w === '日' }">{{ w }}</div>
        <div
          v-for="c in monthCells"
          :key="c.key"
          class="month-cell"
          :class="{ out: !c.inMonth, today: c.key === today, has: c.day?.total }"
          @click="c.inMonth && goDay(c.key)"
        >
          <div class="month-date" :class="{ sun: isSunday(c.key) }">{{ Number(c.key.slice(8)) }}</div>
          <template v-if="c.day">
            <div v-for="it in c.day.items.slice(0, 3)" :key="it.type + it.refId" class="month-chip" :class="'mc-' + it.type.toLowerCase()">
              <span v-if="it.time" class="mc-time">{{ it.time }}</span><span class="mc-title">{{ it.title }}</span>
            </div>
            <div v-if="c.day.total > 3" class="month-more">还有 {{ c.day.total - 3 }} 项</div>
          </template>
        </div>
      </div>
      <div class="month-stats">
        <span v-for="(v, k) in monthData?.stats ?? {}" :key="k" class="month-stat"><i class="lg" :class="statDot(k)"></i>{{ statLabel(k) }} {{ v }}</span>
        <span class="muted month-stat-tip">点任意日期查看当天完整安排；点「单日」回到时间轴视图</span>
      </div>
    </div>

    <!-- 主视图：一天的时间轴（四类条目分层，按开始时间排序）；月历模式下隐藏 -->
    <div class="page-card" v-if="view === 'day'" v-loading="loading">
      <div v-if="!tl?.items?.length && !tl?.free?.length" class="myday-empty">
        这天还没有任何安排，点右上角「添加安排」把要做的事记进来。
      </div>
      <div class="myday-timeline">
        <div v-for="(it, i) in mergedRows" :key="i" class="myday-row" :class="'row-' + it.type">
          <span class="myday-time">{{ it.time }}</span>
          <div class="myday-item" :class="'item-' + it.type" @click="it.type === 'MEETING' && goMeeting(it)">
            <span class="myday-label">{{ it.label }}</span>
            <span v-if="it.statusCn" class="myday-status" :class="'st-' + it.status?.toLowerCase()">{{ it.statusCn }}</span>
            <span v-if="it.note" class="myday-note">{{ it.note }}</span>
            <span v-if="it.type === 'MEETING'" class="myday-link">详情 →</span>
            <!-- 空余时段：一键设为可约（开放给同事约会议）／快捷记安排 -->
            <template v-if="it.type === 'FREE'">
              <el-button v-if="!it.openForBooking" size="small" text type="success" @click.stop="openAddFree(it)">设为可约</el-button>
              <el-tag v-else size="small" type="success" effect="light">可约</el-tag>
              <el-button size="small" text type="primary" @click.stop="openAddAt(it)">＋安排</el-button>
            </template>
            <!-- 个人日程：编辑/删除 -->
            <template v-if="it.type === 'EVENT'">
              <el-button size="small" text @click.stop="openEdit(it)">编辑</el-button>
              <el-button size="small" text type="danger" @click.stop="removeEvent(it)">删除</el-button>
            </template>
          </div>
        </div>
        <div v-if="!mergedRows.length" class="myday-empty">这天没有具体安排。</div>
      </div>
      <div class="myday-legend">
        <span><i class="lg lg-meeting"></i>会议</span>
        <span><i class="lg lg-booking"></i>沟通预约</span>
        <span><i class="lg lg-event"></i>我的安排</span>
        <span><i class="lg lg-outing"></i>外出</span>
        <span><i class="lg lg-task"></i>任务截止</span>
        <span><i class="lg lg-free"></i>空余/可约</span>
      </div>
    </div>

    <!-- 周网格：未来 7 天空档一览（哪天空、哪天满），点「开放」直接上架可约 -->
    <div class="page-card">
      <div class="myday-week-hd">
        <span class="myday-sec-title">未来 7 天空档一览</span>
        <span class="muted">点空余时段的「开放」，同事就能在「约你」时段里约到这个时间</span>
      </div>
      <div class="myday-week" v-loading="weekLoading">
        <div v-for="d in weekDays" :key="d.date" class="week-col" :class="{ today: d.date === today }">
          <div class="week-date">{{ d.date.slice(5) }}<small>{{ d.weekday.slice(0, 3) }}</small></div>
          <div v-if="d.free.length" class="week-free">
            <div v-for="(f, fi) in d.free" :key="fi" class="week-slot">
              <span>{{ f.time }}</span>
              <el-button v-if="!f.openForBooking" size="small" text type="success" @click="quickOpen(d, f)">开放</el-button>
              <el-tag v-else size="small" type="success" effect="light">可约</el-tag>
            </div>
          </div>
          <div v-else class="week-none">已排满</div>
          <div class="week-busy">
            <div v-for="(it, bi) in d.items.filter((x: any) => x.type !== 'WORK')" :key="bi" class="week-busy-item" :title="it.label">
              {{ it.time }} {{ it.label }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 添加/编辑日程弹窗 -->
    <el-dialog v-model="dlg" :title="editId ? '编辑安排' : '添加安排'" width="420px">
      <el-form label-width="76px">
        <el-form-item label="类型">
          <el-radio-group v-model="form.kind" :disabled="!!editId">
            <el-radio value="EVENT">日程安排</el-radio>
            <el-radio value="OUTING">外出</el-radio>
            <el-radio value="FREE">开放可约</el-radio>
            <el-radio value="BUSY">占用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="事项">
          <el-input v-model="form.title" :placeholder="form.kind === 'EVENT' ? '如：写季度总结 / 部门周会准备' : '可留空'" maxlength="80" />
        </el-form-item>
        <el-form-item label="时间">
          <el-time-picker v-model="form.start" format="HH:mm" value-format="HH:mm" placeholder="开始" style="width: 120px" />
          <span class="myday-dash">–</span>
          <el-time-picker v-model="form.end" format="HH:mm" value-format="HH:mm" placeholder="结束" style="width: 120px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="300" placeholder="可选" />
        </el-form-item>
        <div v-if="formWarning" class="myday-warn">{{ formWarning }}</div>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">{{ editId ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { agentApi } from '../api';

const router = useRouter();
const today = dayjs().format('YYYY-MM-DD');
const dateStr = ref(today);
const tl = ref<any>(null);
const weekDays = ref<any[]>([]);
const loading = ref(false);
const weekLoading = ref(false);
const dlg = ref(false);
const saving = ref(false);
const editId = ref('');
const formWarning = ref('');
const form = ref({ kind: 'EVENT', title: '', note: '', start: '', end: '' });

/** 行的标签归类：日程里 EVENT 按 kind 细分（安排/外出/可约），其余按 type */
function rowKey(x: any) {
  if (x.type === 'EVENT') return x.kind === 'FREE' ? 'FREE' : x.kind === 'OUTING' ? 'OUTING' : 'EVENT';
  return x.type;
}

/** ---- 视图切换与月历 ---- */
const view = ref<'month' | 'day'>('month');
const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const monthStr = ref(dayjs().format('YYYY-MM'));
const monthData = ref<any>(null);
const monthLoading = ref(false);
const monthDayMap = computed(() => {
  const m = new Map<string, any>();
  for (const d of monthData.value?.days ?? []) m.set(d.date, d);
  return m;
});
/** 6×7 网格：从当月 1 日所在周的周一开始（跨月日期弱化显示） */
const monthCells = computed(() => {
  const first = dayjs(monthStr.value + '-01');
  const start = first.subtract((first.day() + 6) % 7, 'day');
  const cells: { key: string; inMonth: boolean; day?: any }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = start.add(i, 'day');
    const key = d.format('YYYY-MM-DD');
    cells.push({ key, inMonth: d.format('YYYY-MM') === monthStr.value, day: monthDayMap.value.get(key) });
  }
  return cells;
});
const STAT_META: Record<string, { label: string; dot: string }> = {
  MEETING: { label: '会议', dot: 'lg-meeting' },
  BOOKING: { label: '预约', dot: 'lg-booking' },
  EVENT: { label: '安排', dot: 'lg-event' },
  OUTING: { label: '外出', dot: 'lg-outing' },
  TASK: { label: '任务截止', dot: 'lg-task' },
  FREE: { label: '可约', dot: 'lg-free' },
};
const statLabel = (k: string) => STAT_META[k]?.label ?? k;
const statDot = (k: string) => STAT_META[k]?.dot ?? 'lg-event';
function isSunday(key: string) {
  return dayjs(key).day() === 0;
}
async function loadMonth() {
  monthLoading.value = true;
  try {
    monthData.value = await agentApi.monthSchedule(monthStr.value);
  } catch {
    /* 月历失败不打扰主视图 */
  } finally {
    monthLoading.value = false;
  }
}
function shiftMonth(n: number) {
  monthStr.value = dayjs(monthStr.value + '-01').add(n, 'month').format('YYYY-MM');
  loadMonth();
}
function goThisMonth() {
  monthStr.value = dayjs().format('YYYY-MM');
  loadMonth();
}
function onViewChange(v: any) {
  if (v === 'month') loadMonth();
  else if (!tl.value) load();
}
/** 月历格点击 → 切到该日时间轴 */
function goDay(key: string) {
  dateStr.value = key;
  view.value = 'day';
  load();
}

/** 标签筛选（含各类型数量） */
const filter = ref('ALL');
const filters = computed(() => {
  const items = tl.value?.items ?? [];
  return [
    { key: 'ALL', label: '全部', n: items.length, cls: '' },
    { key: 'MEETING', label: '会议', n: items.filter((x: any) => x.type === 'MEETING').length, cls: 'c-meeting' },
    { key: 'BOOKING', label: '预约', n: items.filter((x: any) => x.type === 'BOOKING').length, cls: 'c-booking' },
    { key: 'EVENT', label: '安排', n: items.filter((x: any) => x.type === 'EVENT' && x.kind === 'EVENT').length, cls: 'c-event' },
    { key: 'OUTING', label: '外出', n: items.filter((x: any) => x.type === 'EVENT' && x.kind === 'OUTING').length, cls: 'c-outing' },
    { key: 'TASK', label: '任务', n: items.filter((x: any) => x.type === 'TASK').length, cls: 'c-task' },
    { key: 'FREE', label: '可约', n: tl.value?.free?.length ?? 0, cls: 'c-free' },
  ];
});

/** 时间轴合并视图：具体条目 + 空余段，按开始分钟排序；空余段补全展示字段；按标签筛选 */
const mergedRows = computed(() => {
  let items: any[] = (tl.value?.items ?? []).map((x: any) => ({ ...x }));
  for (const f of tl.value?.free ?? []) {
    items.push({ type: 'FREE', startMin: f.startMin, endMin: f.endMin, time: f.time, label: f.openForBooking ? '空余 · 已开放可约' : '空余', openForBooking: f.openForBooking });
  }
  if (filter.value !== 'ALL') items = items.filter((x: any) => rowKey(x) === filter.value);
  return items.sort((a: any, b: any) => a.startMin - b.startMin || a.endMin - b.endMin);
});

function shiftDay(n: number) {
  dateStr.value = dayjs(dateStr.value).add(n, 'day').format('YYYY-MM-DD');
  load();
}
function goToday() {
  dateStr.value = today;
  load();
}

async function load() {
  loading.value = true;
  try {
    tl.value = await agentApi.timeline(dateStr.value);
  } catch (e: any) {
    ElMessage.error(e?.message ?? '日程加载失败');
  } finally {
    loading.value = false;
  }
  loadWeek();
}
async function loadWeek() {
  weekLoading.value = true;
  try {
    weekDays.value = (await agentApi.week(dateStr.value)).days;
  } catch {
    /* 周网格失败不打扰主视图 */
  } finally {
    weekLoading.value = false;
  }
}

function minToHHmm(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function openAdd() {
  editId.value = '';
  formWarning.value = '';
  form.value = { kind: 'EVENT', title: '', note: '', start: '', end: '' };
  dlg.value = true;
}
function openAddFree(f: any) {
  editId.value = '';
  formWarning.value = '';
  form.value = { kind: 'FREE', title: '', note: '', start: minToHHmm(f.startMin), end: minToHHmm(f.endMin) };
  dlg.value = true;
}
/** 点空余时段的「＋安排」：时段预填，直接记个人安排 */
function openAddAt(f: any) {
  editId.value = '';
  formWarning.value = '';
  form.value = { kind: 'EVENT', title: '', note: '', start: minToHHmm(f.startMin), end: minToHHmm(f.endMin) };
  dlg.value = true;
}
function openEdit(it: any) {
  editId.value = it.refId;
  formWarning.value = '';
  form.value = { kind: it.kind, title: it.title === '日程安排' ? '' : it.title || '', note: it.note ?? '', start: minToHHmm(it.startMin), end: minToHHmm(it.endMin) };
  dlg.value = true;
}

async function save() {
  const s = String(form.value.start ?? '');
  const e = String(form.value.end ?? '');
  if (!s || !e) {
    formWarning.value = '请选开始与结束时间';
    return;
  }
  if (form.value.kind === 'EVENT' && form.value.title.trim().length < 2) {
    formWarning.value = '请写清楚这个时间要做什么';
    return;
  }
  saving.value = true;
  try {
    const payload = { date: dateStr.value, startMin: s, endMin: e, kind: form.value.kind, title: form.value.title.trim(), note: form.value.note.trim() };
    const r = editId.value ? await agentApi.updateEvent(editId.value, payload) : await agentApi.createEvent(payload);
    if (r?.warning) ElMessage.warning(r.warning);
    else ElMessage.success(editId.value ? '已保存' : '已添加');
    dlg.value = false;
    load();
    loadMonth();
  } catch (err: any) {
    formWarning.value = err?.response?.data?.message ?? err?.message ?? '保存失败';
  } finally {
    saving.value = false;
  }
}

async function removeEvent(it: any) {
  try {
    await ElMessageBox.confirm(`删除「${it.time} ${it.label}」？`, '删除日程', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await agentApi.deleteEvent(it.refId);
    ElMessage.success('已删除');
    load();
    loadMonth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '删除失败');
  }
}

/** 周网格快捷开放：直接以 FREE 落库 */
async function quickOpen(d: any, f: any) {
  try {
    const r = await agentApi.createEvent({ date: d.date, startMin: minToHHmm(f.startMin), endMin: minToHHmm(f.endMin), kind: 'FREE', title: '', source: 'manual' });
    if (r?.warning) ElMessage.warning(r.warning);
    else ElMessage.success(`${d.date.slice(5)} ${f.time} 已开放可约`);
    load();
    loadMonth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '开放失败');
  }
}

function goMeeting(it: any) {
  if (it.refId) router.push(`/meetings/${it.refId}`);
}

onMounted(() => {
  load();
  loadMonth();
});
defineExpose({ reload: load });
</script>

<style scoped>
.myday-wrap { display: flex; flex-direction: column; gap: 14px; }
.myday-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.myday-nav { display: flex; align-items: center; gap: 8px; }
.myday-weekday { color: var(--el-text-color-secondary); font-size: 13px; margin-left: 4px; }
.myday-stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.myday-sched-tip { width: 100%; margin-top: 8px; font-size: 12px; color: var(--el-color-warning-dark-2); background: var(--el-color-warning-light-9); border-radius: 6px; padding: 6px 10px; line-height: 1.6; }
.stat-chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); border: 1px solid transparent; cursor: pointer; }
.stat-chip.active { border-color: var(--el-color-primary); color: var(--el-color-primary); font-weight: 500; }
.stat-chip.c-meeting { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.stat-chip.c-booking { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.stat-chip.c-event { background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); }
.stat-chip.c-outing { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.stat-chip.c-task { background: #f3f2fc; color: #6a62c9; }
.stat-chip.c-free { background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.myday-empty { color: var(--el-text-color-secondary); font-size: 13px; padding: 18px 0; text-align: center; }
.myday-timeline { display: flex; flex-direction: column; gap: 8px; }
.myday-row { display: flex; align-items: stretch; gap: 10px; }
.myday-time { width: 88px; flex-shrink: 0; color: var(--el-text-color-secondary); font-size: 12px; padding-top: 9px; text-align: right; font-variant-numeric: tabular-nums; }
.myday-item { flex: 1; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 7px 12px; border-radius: 8px; background: var(--el-fill-color-lighter); border-left: 3px solid var(--el-border-color); cursor: default; min-height: 34px; }
.myday-item.item-MEETING { background: var(--el-color-primary-light-9); border-left-color: var(--el-color-primary); cursor: pointer; }
.myday-item.item-BOOKING { background: var(--el-color-success-light-9); border-left-color: var(--el-color-success); }
.myday-item.item-EVENT { background: var(--el-color-warning-light-9); border-left-color: var(--el-color-warning); }
.myday-item.item-OUTING { background: var(--el-color-danger-light-9); border-left-color: var(--el-color-danger); }
.myday-item.item-TASK { background: #f3f2fc; border-left-color: #7f77dd; }
.myday-item.item-FREE { background: var(--el-fill-color-light); border-left-style: dashed; border-left-color: var(--el-color-success); }
.myday-label { font-size: 13px; color: var(--el-text-color-primary); }
.myday-status { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.myday-status.st-confirmed { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.myday-status.st-pending { background: var(--el-color-warning-light-8); color: var(--el-color-warning-dark-2); }
.myday-note { font-size: 12px; color: var(--el-text-color-secondary); }
.myday-link { font-size: 12px; color: var(--el-color-primary); }
.myday-dash { margin: 0 6px; color: var(--el-text-color-secondary); }
.myday-warn { color: var(--el-color-danger); font-size: 12px; padding-left: 76px; }
.myday-legend { display: flex; gap: 16px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--el-border-color-lighter); font-size: 12px; color: var(--el-text-color-secondary); }
.myday-legend .lg { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.lg-meeting { background: var(--el-color-primary); }
.lg-booking { background: var(--el-color-success); }
.lg-event { background: var(--el-color-warning); }
.lg-outing { background: var(--el-color-danger); }
.lg-task { background: #7f77dd; }
.lg-free { background: var(--el-color-success-light-5); }

/* ---- 月历视图 ---- */
.myday-month-label { font-size: 15px; min-width: 78px; text-align: center; }
.month-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.month-dow { text-align: center; font-size: 12px; color: var(--el-text-color-secondary); padding: 4px 0; }
.month-dow.sun { color: var(--el-color-danger); }
.month-cell {
  min-height: 78px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px;
  padding: 4px 5px; cursor: pointer; overflow: hidden; transition: background 0.15s;
}
.month-cell:hover { background: var(--el-color-primary-light-9); }
.month-cell.out { opacity: 0.38; cursor: default; background: var(--el-fill-color-lighter); }
.month-cell.out:hover { background: var(--el-fill-color-lighter); }
.month-cell.today { border: 1.5px solid var(--el-color-primary); background: var(--el-color-primary-light-9); }
.month-date { font-size: 12px; font-weight: 500; color: var(--el-text-color-primary); margin-bottom: 3px; }
.month-date.sun { color: var(--el-color-danger); }
.month-cell.today .month-date { color: var(--el-color-primary); }
.month-chip {
  display: flex; align-items: center; gap: 3px; font-size: 11px; line-height: 1.5;
  border-radius: 3px; padding: 0 4px; margin-top: 2px; white-space: nowrap; overflow: hidden;
}
.mc-time { flex-shrink: 0; opacity: 0.75; }
.mc-title { overflow: hidden; text-overflow: ellipsis; }
.mc-meeting { background: var(--el-color-primary-light-8); color: var(--el-color-primary-dark-2); border-left: 2px solid var(--el-color-primary); }
.mc-booking { background: var(--el-color-success-light-8); color: var(--el-color-success-dark-2); border-left: 2px solid var(--el-color-success); }
.mc-event { background: var(--el-color-warning-light-8); color: var(--el-color-warning-dark-2); border-left: 2px solid var(--el-color-warning); }
.mc-outing { background: var(--el-color-danger-light-8); color: var(--el-color-danger-dark-2); border-left: 2px solid var(--el-color-danger); }
.mc-task { background: var(--el-color-danger-light-8); color: #a32d2d; border-left: 2px solid #7f77dd; }
.mc-free { background: var(--el-fill-color); color: var(--el-text-color-secondary); border-left: 2px solid var(--el-text-color-placeholder); }
.month-more { font-size: 11px; color: var(--el-text-color-secondary); margin-top: 2px; }
.month-stats { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--el-border-color-lighter); font-size: 12px; color: var(--el-text-color-secondary); }
.month-stat .lg { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.month-stat-tip { margin-left: auto; }
@media (max-width: 768px) {
  .month-cell { min-height: 46px; padding: 3px; }
  .month-chip { padding: 0 2px; }
  .mc-time { display: none; }
  .month-stat-tip { display: none; }
}
.myday-week-hd { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.myday-sec-title { font-weight: 500; font-size: 14px; }
.myday-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.week-col { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 8px; min-height: 90px; }
.week-col.today { border-color: var(--el-color-primary); }
.week-date { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
.week-date small { color: var(--el-text-color-secondary); font-weight: 400; margin-left: 4px; }
.week-free { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.week-slot { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--el-color-success); background: var(--el-color-success-light-9); border-radius: 4px; padding: 2px 6px; }
.week-none { font-size: 12px; color: var(--el-text-color-placeholder); margin-bottom: 6px; }
.week-busy { display: flex; flex-direction: column; gap: 3px; }
.week-busy-item { font-size: 12px; color: var(--el-text-color-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 900px) {
  .myday-week { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .myday-time { width: 72px; }
}
</style>
