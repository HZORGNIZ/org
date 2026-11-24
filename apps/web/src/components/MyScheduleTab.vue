<template>
  <div class="myday-wrap">
    <!-- 顶部：视图切换（月历默认）+ 日期/月份导航 + 添加日程 -->
    <div class="page-card myday-head">
      <div class="myday-nav">
        <el-radio-group v-model="view" size="small" @change="onViewChange">
          <el-radio-button value="month">月历</el-radio-button>
          <el-radio-button value="week">周历</el-radio-button>
          <el-radio-button value="day">单日</el-radio-button>
        </el-radio-group>
        <template v-if="view === 'month'">
          <el-button size="small" @click="shiftMonth(-1)">‹</el-button>
          <b class="myday-month-label">{{ monthStr }}</b>
          <el-button size="small" @click="shiftMonth(1)">›</el-button>
          <el-button v-if="monthStr !== today.slice(0, 7)" size="small" text type="primary" @click="goThisMonth">回到本月</el-button>
        </template>
        <template v-else-if="view === 'week'">
          <el-button size="small" @click="shiftWeek(-1)">‹</el-button>
          <b class="myday-month-label">{{ weekLabel }}</b>
          <el-button size="small" @click="shiftWeek(1)">›</el-button>
          <el-button v-if="!weekIsCurrent" size="small" text type="primary" @click="goThisWeek">回到本周</el-button>
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
      <!-- 未登记可约时间：成员约不到，引导先登记 -->
      <div v-if="view === 'day' && tl?.scheduleBasis === 'default'" class="myday-sched-tip">
        你还没有登记可约时间（周排班或「开放可约」时段），<b>成员约不到你</b>。
        去周历里拖一段空余点「开放可约」，或打开智能体的「我的日程」小助理说「设置排班」。
      </div>
    </div>

    <!-- 月历视图：整月摊开（过去 + 未来都在同一屏），点日期进入该日时间网格 -->
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
          <div class="month-date" :class="{ sun: isSunday(c.key) }">
            {{ Number(c.key.slice(8)) }}
            <button v-if="c.inMonth" class="mc-add" title="快捷添加安排" @click.stop="goDay(c.key)">＋</button>
          </div>
          <template v-if="c.day">
            <div v-for="it in c.day.items.slice(0, 3)" :key="it.type + it.refId" class="month-chip" :class="'mc-' + it.type.toLowerCase()">
              <span v-if="it.time" class="mc-time">{{ it.time }}</span><span class="mc-title">{{ it.title }}</span>
            </div>
            <div v-if="c.day.total > 3" class="month-more">还有 {{ c.day.total - 3 }} 项</div>
          </template>
        </div>
      </div>
      <div class="month-stats">
        <span v-for="(v, k) in monthData?.stats ?? {}" :key="k" class="month-stat"><i class="lg" :class="statDot(String(k))"></i>{{ statLabel(String(k)) }} {{ v }}</span>
        <span class="muted month-stat-tip">点任意日期查看当天完整安排；点「单日」回到时间轴视图</span>
      </div>
    </div>

    <!-- 主视图：月历同款的时间网格（点月历某天 = 当天放大突出）；空白处按住拖一拽选时段直接添加 -->
    <div class="page-card" v-if="view === 'day'" v-loading="loading">
      <div v-if="!tl?.items?.length && !tl?.free?.length" class="myday-empty">
        这天还没有任何安排：在下方时间网格空白处<b>按住拖一拽</b>选个时段就能添加，或点右上角「＋ 添加安排」。
      </div>
      <div ref="wrapEl" class="dg-wrap">
        <div class="dg-grid">
          <div class="dg-gutter">
            <div v-for="h in gridHours" :key="h" class="dg-hour" :style="{ height: HOUR_PX + 'px' }">{{ String(h).padStart(2, '0') }}:00</div>
          </div>
          <div
            class="dg-track"
            :style="{ height: trackHeight + 'px', backgroundSize: `100% ${HOUR_PX}px, 100% ${HOUR_PX / 2}px` }"
            @pointerdown="onTrackDown"
            @pointermove="onTrackMove"
            @pointerup="onTrackUp"
            @pointercancel="onTrackCancel"
            @click="onTrackClick"
          >
            <!-- 当前时刻红线（仅今天） -->
            <div v-if="nowTop !== null" class="dg-now" :style="{ top: nowTop + 'px' }"></div>
            <!-- 拖拽选中的时段高亮 -->
            <div v-if="sel" class="dg-sel" :style="selStyle">{{ selText }}</div>
            <!-- 安排块：按起止时间铺格，重叠时左右并排 -->
            <div
              v-for="b in gridBlocks"
              :key="b.key"
              class="dg-block"
              :class="['blk-' + b.row.toLowerCase(), { clickable: b.clickable }]"
              :style="{ top: b.top + 'px', left: b.left + '%', width: b.width + '%', height: b.height + 'px' }"
              :title="b.title"
              @click.stop="onBlockClick(b)"
            >
              <span class="dg-b-time">{{ b.time }}</span>
              <span class="dg-b-title">{{ b.title }}</span>
              <span v-if="b.statusCn" class="myday-status" :class="'st-' + (b.status || '').toLowerCase()">{{ b.statusCn }}</span>
              <span v-if="b.note" class="dg-b-note">{{ b.note }}</span>
            </div>
          </div>
        </div>
        <!-- 拖拽选时段后快捷 chip：点一下即建（事项可不填），「详细…」展开完整填写卡 -->
        <div v-if="dgChip.open" class="wk-chipbar dg-chipbar" :style="{ top: dgChip.top + 'px', left: dgChip.left + 'px' }" @pointerdown.stop @click.stop>
          <span class="wk-chip-note">{{ minToHHmm(dgChip.a) }}–{{ minToHHmm(dgChip.b) }}</span>
          <button class="wk-chip wc-free" @click="dgQuickCreate('FREE')">开放可约</button>
          <button class="wk-chip wc-event" @click="dgQuickCreate('EVENT')">安排</button>
          <button class="wk-chip wc-outing" @click="dgQuickCreate('OUTING')">外出</button>
          <button class="wk-chip wc-busy" @click="dgQuickCreate('BUSY')">占用</button>
          <button class="wk-chip wc-more" @click="dgOpenDetail">详细…</button>
          <button class="wk-chip wc-x" @click="closeDgChip">✕</button>
        </div>
        <!-- 就地填写卡（非弹窗遮罩）：拖拽选时段后出现在网格上 -->
        <div v-if="card.open" class="dg-card" :style="{ top: card.top + 'px', left: card.left + 'px' }" @pointerdown.stop @click.stop>
          <div class="dg-card-hd">
            <b>{{ card.editId ? '编辑安排' : '添加安排' }}</b>
            <span class="dg-card-time">{{ card.start }} – {{ card.end }}</span>
            <span style="flex: 1"></span>
            <el-button text size="small" @click="closeCard">✕</el-button>
          </div>
          <el-radio-group v-model="card.kind" size="small" :disabled="!!card.editId">
            <el-radio-button value="EVENT">安排</el-radio-button>
            <el-radio-button value="OUTING">外出</el-radio-button>
            <el-radio-button value="FREE">开放可约</el-radio-button>
            <el-radio-button value="BUSY">占用</el-radio-button>
          </el-radio-group>
          <el-input v-model="card.title" :placeholder="card.kind === 'EVENT' ? '事项（必填，至少 2 字）' : '可留空'" maxlength="80" @keyup.enter="saveCard" />
          <div class="dg-card-row">
            <el-time-picker v-model="card.start" size="small" format="HH:mm" value-format="HH:mm" placeholder="开始" style="width: 100px" />
            <span class="myday-dash">–</span>
            <el-time-picker v-model="card.end" size="small" format="HH:mm" value-format="HH:mm" placeholder="结束" style="width: 100px" />
          </div>
          <el-input v-model="card.note" placeholder="备注（可选）" maxlength="300" />
          <div v-if="card.warn" class="myday-warn dg-card-warn">{{ card.warn }}</div>
          <div class="dg-card-foot">
            <el-button v-if="card.editId" size="small" text type="danger" @click="removeCardEvent">删除</el-button>
            <span style="flex: 1"></span>
            <el-button size="small" @click="closeCard">取消</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="saveCard">{{ card.editId ? '保存' : '添加' }}</el-button>
          </div>
        </div>
      </div>
      <div class="myday-legend">
        <span><i class="lg lg-meeting"></i>会议</span>
        <span><i class="lg lg-booking"></i>沟通预约</span>
        <span><i class="lg lg-event"></i>我的安排</span>
        <span><i class="lg lg-outing"></i>外出</span>
        <span><i class="lg lg-task"></i>任务截止</span>
        <span><i class="lg lg-free"></i>空余/可约</span>
        <span class="muted legend-tip">空白时段按住拖一拽即可添加安排；点自己的安排可编辑</span>
      </div>
    </div>

    <!-- 周历视图：本周一~周日 7 列 × 小时网格放大显示，四色块；拖空白格快捷添加（事项可不填），点色块编辑/取消开放 -->
    <div class="page-card" v-if="view === 'week'" v-loading="weekLoading">
      <div class="wk-head">
        <span class="myday-sec-title">周历</span>
        <span class="wk-lg"><i class="lg lg-free"></i>开放可约</span>
        <span class="wk-lg"><i class="lg lg-event"></i>安排/会议/预约</span>
        <span class="wk-lg"><i class="lg lg-outing"></i>外出/占用</span>
        <span class="muted wk-tip">绿色时段 = 成员约你时看到的时间；在空白格<b>按住拖一拽</b>选时段，点一下即可添加（事项可不填）</span>
      </div>
      <div v-if="!weekLoading && wkAllEmpty" class="myday-empty">
        本周还没有任何登记：在空白格拖一段时间，点「开放可约」，成员就能约你了。
      </div>
      <div class="wk-grid" v-loading="weekLoading">
        <div class="wk-gutter">
          <div class="wk-corner">时间</div>
          <div v-for="h in wkHours" :key="h" class="wk-hour" :style="{ height: WK_PX + 'px' }">{{ String(h).padStart(2, '0') }}:00</div>
        </div>
        <div v-for="(d, di) in wkCols" :key="d.date" class="wk-col" :class="{ today: d.date === today }">
          <div class="wk-day-hd">
            <span class="wk-day-date">{{ Number(d.date.slice(8)) }}<small>{{ d.weekday?.slice(0, 3) ?? '' }}</small></span>
            <span class="wk-day-free" :class="{ none: !d.freeHours }">可约 {{ d.freeHours || '0h' }}</span>
          </div>
          <div
            class="wk-track"
            :style="{ height: wkTrackHeight + 'px', backgroundSize: `100% ${WK_PX}px, 100% ${WK_PX / 2}px` }"
            @pointerdown="onWkDown($event, di)"
            @pointermove="onWkMove"
            @pointerup="onWkUp"
            @pointercancel="onWkCancel"
            @click="onWkClick($event, di)"
          >
            <div v-if="wkNowTop !== null && d.date === today" class="dg-now" :style="{ top: wkNowTop + 'px' }"></div>
            <div
              v-for="b in d.blocks"
              :key="b.key"
              class="wk-block"
              :class="'wb-' + b.cls"
              :style="{ top: b.top + 'px', height: b.height + 'px' }"
              :title="`${b.time} ${b.title}`"
              @click.stop="onWkBlockClick(b, di)"
            >
              <span class="wb-time">{{ b.time }}</span>
              <span class="wb-title">{{ b.title }}</span>
            </div>
            <div v-if="wkSel && wkSel.col === di" class="dg-sel" :style="{ top: wkSelTop + 'px', height: wkSelHeight + 'px' }">{{ wkSelText }}</div>
            <!-- 拖拽选时段后的快捷操作条（事项可不填，点一下即建） -->
            <div v-if="wkChip.open && wkChip.col === di" class="wk-chipbar" :style="{ top: wkChip.top + 'px' }" @pointerdown.stop @click.stop>
              <template v-if="wkChip.mode === 'create'">
                <button class="wk-chip wc-free" @click="wkQuickCreate('FREE')">开放可约</button>
                <button class="wk-chip wc-event" @click="wkQuickCreate('EVENT')">安排</button>
                <button class="wk-chip wc-outing" @click="wkQuickCreate('OUTING')">外出</button>
                <button class="wk-chip wc-busy" @click="wkQuickCreate('BUSY')">占用</button>
                <button class="wk-chip wc-more" @click="wkOpenDetail">详细…</button>
              </template>
              <template v-else-if="wkChip.mode === 'free'">
                <button class="wk-chip wc-cancel-open" @click="wkCancelOpen">取消开放</button>
                <span class="wk-chip-note">来自排班/开放时段</span>
              </template>
              <template v-else>
                <button class="wk-chip wc-more" @click="wkEditEvent">编辑</button>
                <button class="wk-chip wc-del" @click="wkDeleteEvent">删除</button>
              </template>
              <button class="wk-chip wc-x" @click="closeWkChip">✕</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 添加/编辑日程弹窗（「＋ 添加安排」按钮兜底入口） -->
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
import { computed, onMounted, onUnmounted, ref } from 'vue';
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
const view = ref<'month' | 'week' | 'day'>('month');
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
  else if (v === 'week') loadWeek();
  else if (!tl.value || tl.value.date !== dateStr.value) load();
}
/** 月历格点击 → 切到该日时间网格；先用月历已有数据立即渲染（零等待），后台再拉权威数据无缝覆盖 */
function goDay(key: string) {
  dateStr.value = key;
  view.value = 'day';
  applyMonthCache(key);
  load(true);
  loadWeek();
}

/** 月历条目时间形如 "09:00-10:30" / "14:00"（任务截止），解析出分钟即可定位到网格 */
const STATUS_CN: Record<string, string> = { PENDING: '待确认', CONFIRMED: '已确认', CANCELLED: '已取消' };
function applyMonthCache(key: string) {
  const d = monthDayMap.value.get(key);
  if (!d) return;
  const items = (d.items ?? []).map((x: any) => {
    const it: any = { ...x, label: x.label ?? x.title ?? '' };
    const span = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(it.time ?? ''));
    if (span) {
      it.startMin = Number(span[1]) * 60 + Number(span[2]);
      it.endMin = Number(span[3]) * 60 + Number(span[4]);
    } else {
      const s = /^(\d{1,2}):(\d{2})$/.exec(String(it.time ?? ''));
      it.startMin = s ? Number(s[1]) * 60 + Number(s[2]) : 540;
      it.endMin = it.startMin + 30;
    }
    if (!it.endMin || it.endMin <= it.startMin) it.endMin = it.startMin + 30;
    if (!it.statusCn && it.status) it.statusCn = STATUS_CN[it.status] ?? '';
    return it;
  });
  tl.value = { date: key, items, free: [], scheduleBasis: tl.value?.scheduleBasis ?? 'default' };
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
    { key: 'FREE', label: '可约', n: items.filter((x: any) => rowKey(x) === 'FREE').length, cls: 'c-free' },
  ];
});

function shiftDay(n: number) {
  dateStr.value = dayjs(dateStr.value).add(n, 'day').format('YYYY-MM-DD');
  load();
  loadWeek();
}
function goToday() {
  dateStr.value = today;
  load();
  loadWeek();
}

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    tl.value = await agentApi.timeline(dateStr.value);
  } catch (e: any) {
    if (!silent) ElMessage.error(e?.message ?? '日程加载失败');
  } finally {
    if (!silent) loading.value = false;
  }
}
async function loadWeek() {
  weekLoading.value = true;
  try {
    weekDays.value = (await agentApi.week(weekStart.value)).days;
  } catch {
    /* 周历失败不打扰主视图 */
  } finally {
    weekLoading.value = false;
  }
}

/** ---- 及时性：60 秒自动刷新 + 切回浏览器标签页时刷新 ---- */
async function refreshQuiet() {
  if (document.visibilityState !== 'visible') return;
  if (view.value === 'day') {
    try {
      tl.value = await agentApi.timeline(dateStr.value);
    } catch {
      /* 静默刷新失败不打扰 */
    }
  } else if (view.value === 'week') {
    loadWeek();
  } else {
    loadMonth();
  }
}
let refreshTimer: ReturnType<typeof setInterval> | null = null;
function onVisChange() {
  if (document.visibilityState === 'visible') refreshQuiet();
}

function minToHHmm(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** ---- 单日时间网格（月历同款放大版）：15 分钟一格，按起止时间铺块 ---- */
const HOUR_PX = 56; // 每小时 56px（15 分钟 = 14px）
const wrapEl = ref<HTMLElement | null>(null);
const gridStartMin = computed(() => {
  let s = 8 * 60;
  for (const it of tl.value?.items ?? []) {
    if (typeof it.startMin === 'number') s = Math.min(s, Math.floor(it.startMin / 60) * 60);
  }
  return s;
});
const gridEndMin = computed(() => {
  let e = 20 * 60;
  for (const it of tl.value?.items ?? []) {
    if (typeof it.startMin !== 'number') continue;
    const em = typeof it.endMin === 'number' && it.endMin > it.startMin ? it.endMin : it.startMin + 60;
    e = Math.max(e, Math.ceil(em / 60) * 60);
  }
  return Math.max(e, gridStartMin.value + 8 * 60);
});
const trackHeight = computed(() => ((gridEndMin.value - gridStartMin.value) / 60) * HOUR_PX);
const gridHours = computed(() => {
  const out: number[] = [];
  for (let h = gridStartMin.value / 60; h < gridEndMin.value / 60; h++) out.push(h);
  return out;
});
const nowTop = computed(() => {
  if (dateStr.value !== today) return null;
  const n = dayjs().hour() * 60 + dayjs().minute();
  if (n < gridStartMin.value || n > gridEndMin.value) return null;
  return ((n - gridStartMin.value) / 60) * HOUR_PX;
});

interface Block {
  key: string;
  row: string;
  top: number;
  left: number;
  width: number;
  height: number;
  time: string;
  title: string;
  status?: string;
  statusCn?: string;
  note?: string;
  clickable: boolean;
  raw: any;
}
/** 网格块：过滤后按开始时间排序，重叠条目分泳道左右并排（每个重叠簇内均分宽度） */
const gridBlocks = computed<Block[]>(() => {
  const items = (tl.value?.items ?? []).filter((x: any) => filter.value === 'ALL' || rowKey(x) === filter.value);
  const list: any[] = items
    .map((x: any) => {
      if (typeof x.startMin !== 'number') return null;
      const end = typeof x.endMin === 'number' && x.endMin > x.startMin ? Math.min(x.endMin, 1440) : x.startMin + 30;
      return { x, start: x.startMin, end };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.start - b.start || a.end - b.end);
  // 泳道分配：找一条「上一条已结束」的泳道塞进去，塞不下就新开一条
  const laneEnds: number[] = [];
  for (const it of list) {
    let lane = laneEnds.findIndex((le) => le <= it.start);
    if (lane === -1) {
      laneEnds.push(it.end);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = it.end;
    }
    it.lane = lane;
  }
  const out: Block[] = [];
  let cluster: any[] = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const laneCount = Math.max(...cluster.map((c: any) => c.lane)) + 1;
    for (const c of cluster) {
      const x = c.x;
      out.push({
        key: String(x.type ?? '') + String(x.refId ?? x.startMin),
        row: rowKey(x),
        top: ((c.start - gridStartMin.value) / 60) * HOUR_PX,
        left: (c.lane / laneCount) * 100,
        width: 100 / laneCount,
        height: Math.max(((c.end - c.start) / 60) * HOUR_PX, 20),
        time: x.time ?? '',
        title: x.label || x.title || '',
        status: x.status,
        statusCn: x.statusCn,
        note: x.note,
        clickable: x.type === 'MEETING' || x.type === 'EVENT',
        raw: x,
      });
    }
    cluster = [];
    clusterEnd = -1;
  };
  for (const it of list) {
    if (cluster.length && it.start >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
});

/** ---- 拖拽选时段：按住空白处拖一拽，15 分钟吸附，松手就地出填写卡 ---- */
const dragging = ref(false);
const sel = ref<{ a: number; b: number } | null>(null); // 归一化后的分钟区间（a < b）
const suppressClick = ref(false);
const selStyle = computed(() => {
  if (!sel.value) return {};
  const top = ((sel.value.a - gridStartMin.value) / 60) * HOUR_PX;
  return { top: `${top}px`, height: `${Math.max(((sel.value.b - sel.value.a) / 60) * HOUR_PX, 14)}px` };
});
const selText = computed(() => (sel.value ? `${minToHHmm(sel.value.a)}–${minToHHmm(sel.value.b)}` : ''));

function yToMin(y: number) {
  const raw = gridStartMin.value + (y / HOUR_PX) * 60;
  return Math.max(gridStartMin.value, Math.min(gridEndMin.value, Math.round(raw / 15) * 15));
}
function onBlockHit(target: EventTarget | null) {
  return !!(target as HTMLElement | null)?.closest?.('.dg-block');
}
function onTrackDown(e: PointerEvent) {
  if (onBlockHit(e.target)) return;
  if (e.pointerType !== 'mouse') return; // 触屏：点一下出卡（交给 click），不劫持滚动手势
  if (card.value.open) closeCard();
  closeDgChip();
  const el = e.currentTarget as HTMLElement;
  const m = yToMin(e.clientY - el.getBoundingClientRect().top);
  dragging.value = true;
  suppressClick.value = false;
  sel.value = { a: m, b: Math.min(gridEndMin.value, m + 15) };
  el.setPointerCapture(e.pointerId);
}
function onTrackMove(e: PointerEvent) {
  if (!dragging.value || !sel.value) return;
  const el = e.currentTarget as HTMLElement;
  const m = yToMin(e.clientY - el.getBoundingClientRect().top);
  const a = Math.min(sel.value.a, m);
  const b = Math.max(sel.value.a, m);
  sel.value = { a, b: Math.max(b, a + 15) };
}
function onTrackUp() {
  if (!dragging.value) return;
  dragging.value = false;
  suppressClick.value = true;
  setTimeout(() => (suppressClick.value = false), 60);
  // 拖拽松手 → 快捷 chip（点一下即建）；需要精确改时间/写备注再点「详细…」
  if (sel.value) openDgChip(sel.value.a, sel.value.b);
}
function onTrackCancel() {
  dragging.value = false;
  sel.value = null;
}
function onTrackClick(e: MouseEvent) {
  if (suppressClick.value || onBlockHit(e.target)) return;
  const el = e.currentTarget as HTMLElement;
  const m = yToMin(e.clientY - el.getBoundingClientRect().top);
  // 触屏/单击：预填 1 小时时段出卡
  openCard(m, Math.min(gridEndMin.value, m + 60));
}

/** ---- 就地填写卡 ---- */
const card = ref({ open: false, editId: '', kind: 'EVENT', title: '', note: '', start: '', end: '', top: 0, left: 0, warn: '' });
function closeCard() {
  card.value.open = false;
  sel.value = null;
}
function cardPos(topMin: number) {
  const w = wrapEl.value?.clientWidth ?? 600;
  const h = wrapEl.value?.clientHeight ?? 420;
  return {
    top: Math.max(4, Math.min(((topMin - gridStartMin.value) / 60) * HOUR_PX + 12, Math.max(4, h - 280))),
    left: Math.max(8, Math.min(w - 316, w / 2 - 110)),
  };
}
function openCard(aMin: number, bMin: number) {
  card.value = { open: true, editId: '', kind: 'EVENT', title: '', note: '', start: minToHHmm(aMin), end: minToHHmm(bMin), warn: '', ...cardPos(aMin) };
}
function openCardEdit(b: Block) {
  const it = b.raw;
  card.value = {
    open: true,
    editId: String(it.refId ?? ''),
    kind: it.kind || 'EVENT',
    title: it.title === '日程安排' ? '' : it.title || '',
    note: it.note ?? '',
    start: minToHHmm(it.startMin),
    end: minToHHmm(typeof it.endMin === 'number' && it.endMin > it.startMin ? it.endMin : it.startMin + 30),
    warn: '',
    ...cardPos(it.startMin),
  };
}
function onBlockClick(b: Block) {
  if (b.raw?.type === 'MEETING') goMeeting(b.raw);
  else if (b.raw?.type === 'EVENT') openCardEdit(b);
}
function cardValidate(): string {
  if (!card.value.start || !card.value.end) return '请选开始与结束时间';
  if (card.value.kind === 'EVENT' && card.value.title.trim().length < 2) return '请写清楚这个时间要做什么（至少 2 个字）';
  return '';
}
async function saveCard() {
  const w = cardValidate();
  if (w) {
    card.value.warn = w;
    return;
  }
  saving.value = true;
  try {
    const payload = { date: dateStr.value, startMin: card.value.start, endMin: card.value.end, kind: card.value.kind, title: card.value.title.trim(), note: card.value.note.trim() };
    const r = card.value.editId ? await agentApi.updateEvent(card.value.editId, payload) : await agentApi.createEvent(payload);
    if (r?.warning) ElMessage.warning(r.warning);
    else ElMessage.success(card.value.editId ? '已保存' : '已添加');
    closeCard();
    load(true); // 色块立即出现（静默拉最新）
    loadMonth();
  } catch (err: any) {
    card.value.warn = err?.response?.data?.message ?? err?.message ?? '保存失败';
  } finally {
    saving.value = false;
  }
}
async function removeCardEvent() {
  const it = gridBlocks.value.find((b) => String(b.raw?.refId ?? '') === card.value.editId)?.raw;
  const label = it ? `${it.time ?? ''} ${it.label || it.title || ''}`.trim() : '该安排';
  try {
    await ElMessageBox.confirm(`删除「${label}」？`, '删除日程', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await agentApi.deleteEvent(card.value.editId);
    ElMessage.success('已删除');
    closeCard();
    load(true);
    loadMonth();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '删除失败');
  }
}

function openAdd() {
  editId.value = '';
  formWarning.value = '';
  form.value = { kind: 'EVENT', title: '', note: '', start: '09:00', end: '10:00' };
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
    load(true);
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

/** ---- 周历视图：本周一~周日 7 列 × 小时网格（7:00-22:00），可拖拽快捷设置 ---- */
const WK_START = 7 * 60;
const WK_END = 22 * 60;
const WK_PX = 30;
const wkTrackHeight = ((WK_END - WK_START) / 60) * WK_PX;
const wkHours = computed(() => {
  const o: number[] = [];
  for (let h = WK_START / 60; h < WK_END / 60; h++) o.push(h);
  return o;
});
function mondayOf(d: string) {
  const dt = dayjs(d);
  return dt.subtract((dt.day() + 6) % 7, 'day').format('YYYY-MM-DD');
}
const weekStart = ref(mondayOf(today));
const weekIsCurrent = computed(() => weekStart.value === mondayOf(today));
const weekLabel = computed(() => `${dayjs(weekStart.value).format('M/D')} – ${dayjs(weekStart.value).add(6, 'day').format('M/D')}`);
function shiftWeek(n: number) {
  weekStart.value = dayjs(weekStart.value).add(n * 7, 'day').format('YYYY-MM-DD');
  loadWeek();
}
function goThisWeek() {
  weekStart.value = mondayOf(today);
  loadWeek();
}
const wkNowTop = computed(() => {
  const n = dayjs().hour() * 60 + dayjs().minute();
  if (n < WK_START || n > WK_END) return null;
  return ((n - WK_START) / 60) * WK_PX;
});
/** 本周完全无登记（无排班/无安排/无开放时段）时给引导 */
const wkAllEmpty = computed(() =>
  (weekDays.value ?? []).every(
    (d: any) => !(d.items ?? []).some((x: any) => x.type !== 'WORK' && typeof x.startMin === 'number') && !(d.free ?? []).length,
  ),
);
/** 每列色块：蓝=安排/会议/预约，橙=外出/占用，绿=开放可约（与约时间机器人同口径） */
const wkCols = computed(() =>
  (weekDays.value ?? []).map((d: any) => {
    const blocks: any[] = [];
    const push = (key: string, a: number, b: number, cls: string, time: string, title: string, raw: any) => {
      const top = Math.max(0, ((a - WK_START) / 60) * WK_PX);
      const bottom = Math.min(wkTrackHeight, ((b - WK_START) / 60) * WK_PX);
      if (bottom - top < 4) return;
      blocks.push({ key, cls, top, height: bottom - top, time, title, raw, a: Math.max(WK_START, a), b: Math.min(WK_END, b) });
    };
    for (const it of d.items ?? []) {
      if (typeof it.startMin !== 'number' || it.type === 'WORK') continue;
      const end = typeof it.endMin === 'number' && it.endMin > it.startMin ? it.endMin : it.startMin + 30;
      const cls = it.type === 'EVENT' ? (it.kind === 'FREE' ? 'free' : it.kind === 'OUTING' || it.kind === 'BUSY' ? 'warn' : 'info') : 'info';
      push(String(it.type) + String(it.refId ?? it.startMin), it.startMin, end, cls, it.time ?? '', it.title || it.label || '', it);
    }
    for (const f of d.free ?? []) push('F' + f.startMin, f.startMin, f.endMin, 'free', f.time, '可约', f);
    blocks.sort((x: any, y: any) => x.top - y.top);
    const freeMin = (d.free ?? []).reduce((s: number, f: any) => s + (f.endMin - f.startMin), 0);
    return { ...d, blocks, freeHours: freeMin ? `${Math.round(freeMin / 30) / 2}h` : '' };
  }),
);

/** 周历拖拽选时段：30 分钟吸附，松手出快捷 chip（事项可不填） */
const wkDragging = ref(false);
const wkSel = ref<{ col: number; a: number; b: number } | null>(null);
const wkSelTop = computed(() => (wkSel.value ? ((wkSel.value.a - WK_START) / 60) * WK_PX : 0));
const wkSelHeight = computed(() => (wkSel.value ? Math.max(((wkSel.value.b - wkSel.value.a) / 60) * WK_PX, 14) : 0));
const wkSelText = computed(() => (wkSel.value ? `${minToHHmm(wkSel.value.a)}–${minToHHmm(wkSel.value.b)}` : ''));
const wkChip = ref({ open: false, col: -1, mode: '' as '' | 'create' | 'free' | 'event', top: 0, a: 0, b: 0, date: '', target: null as any });
function closeWkChip() {
  wkChip.value = { open: false, col: -1, mode: '', top: 0, a: 0, b: 0, date: '', target: null };
  wkSel.value = null;
}
function wkYToMin(y: number) {
  return Math.max(WK_START, Math.min(WK_END, Math.round((WK_START + (y / WK_PX) * 60) / 30) * 30));
}
function wkOffY(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  return e.clientY - el.getBoundingClientRect().top;
}
function onWkDown(e: PointerEvent, col: number) {
  if (onBlockHit(e.target)) return;
  if (e.pointerType !== 'mouse') return; // 触屏：点一下出 chip（交给 click），不劫持滚动手势
  closeWkChip();
  wkDragging.value = true;
  const m = wkYToMin(wkOffY(e));
  wkSel.value = { col, a: m, b: Math.min(WK_END, m + 30) };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onWkMove(e: PointerEvent) {
  if (!wkDragging.value || !wkSel.value) return;
  const m = wkYToMin(wkOffY(e));
  const a = Math.min(wkSel.value.a, m);
  const b = Math.max(wkSel.value.a, m);
  wkSel.value = { col: wkSel.value.col, a, b: Math.max(b, a + 30) };
}
function onWkUp() {
  if (!wkDragging.value) return;
  wkDragging.value = false;
  if (wkSel.value) {
    const { col, a, b } = wkSel.value;
    wkChip.value = { open: true, col, mode: 'create', top: Math.max(4, wkSelTop.value - 6), a, b, date: weekDays.value[col]?.date ?? '', target: null };
  }
}
function onWkCancel() {
  wkDragging.value = false;
  wkSel.value = null;
}
function onWkClick(e: PointerEvent, col: number) {
  if (wkChip.value.open || suppressClick.value) return;
  if (onBlockHit(e.target)) return;
  const m = wkYToMin(wkOffY(e));
  const a = m;
  const b = Math.min(WK_END, m + 60);
  wkSel.value = { col, a, b };
  wkChip.value = { open: true, col, mode: 'create', top: Math.max(4, ((a - WK_START) / 60) * WK_PX - 6), a, b, date: weekDays.value[col]?.date ?? '', target: null };
}
function onWkBlockClick(b: any, col: number) {
  closeWkChip();
  const it = b.raw;
  const date = weekDays.value[col]?.date ?? '';
  if (b.cls === 'free') {
    wkSel.value = { col, a: b.a, b: b.b };
    wkChip.value = { open: true, col, mode: 'free', top: Math.max(4, b.top - 6), a: b.a, b: b.b, date, target: it };
  } else if (it?.type === 'EVENT') {
    wkChip.value = { open: true, col, mode: 'event', top: Math.max(4, b.top - 6), a: b.a, b: b.b, date, target: it };
  }
  // 会议/预约/任务块不弹菜单（title 悬浮看详情）
}
function kindCn(k: string) {
  return k === 'FREE' ? '已开放可约' : k === 'OUTING' ? '已标外出' : k === 'BUSY' ? '已标占用' : '已添加安排';
}
function afterScheduleChange(date?: string) {
  loadWeek();
  if (date && date === dateStr.value) load(true);
  loadMonth();
}
async function wkQuickCreate(kind: string) {
  const c = wkChip.value;
  if (!c.date) return;
  saving.value = true;
  try {
    const payload = { date: c.date, startMin: minToHHmm(c.a), endMin: minToHHmm(c.b), kind, title: kind === 'EVENT' ? '日程安排' : '' };
    const r = await agentApi.createEvent(payload);
    if (r?.warning) ElMessage.warning(r.warning);
    else ElMessage.success(`${c.date.slice(5)} ${minToHHmm(c.a)}–${minToHHmm(c.b)} ${kindCn(kind)}`);
    closeWkChip();
    afterScheduleChange(c.date);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '添加失败');
  } finally {
    saving.value = false;
  }
}
function wkOpenDetail() {
  const c = wkChip.value;
  if (!c.date) return;
  dateStr.value = c.date;
  editId.value = '';
  formWarning.value = '';
  form.value = { kind: 'EVENT', title: '', note: '', start: minToHHmm(c.a), end: minToHHmm(c.b) };
  dlg.value = true;
  closeWkChip();
}
async function wkCancelOpen() {
  const c = wkChip.value;
  const day = weekDays.value[c.col];
  const covering = (day?.items ?? []).filter((x: any) => x.type === 'EVENT' && x.kind === 'FREE' && x.startMin <= c.a && x.endMin >= c.b);
  if (!covering.length) {
    ElMessage.info('该时段来自每周固定排班：请到排班设置里调整，或先用「外出/占用」盖住这段时间');
    closeWkChip();
    return;
  }
  try {
    await ElMessageBox.confirm(`取消开放 ${c.date.slice(5)} ${minToHHmm(c.a)}–${minToHHmm(c.b)}？成员将约不到这段时间。`, '取消开放', { type: 'warning' });
  } catch {
    return;
  }
  try {
    for (const ev of covering) await agentApi.deleteEvent(ev.refId);
    ElMessage.success('已取消开放');
    closeWkChip();
    afterScheduleChange(c.date);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '操作失败');
  }
}
function wkEditEvent() {
  const c = wkChip.value;
  const it = c.target;
  if (!it || !c.date) return;
  dateStr.value = c.date;
  editId.value = String(it.refId ?? '');
  formWarning.value = '';
  form.value = {
    kind: it.kind || 'EVENT',
    title: it.title === '日程安排' ? '' : it.title || '',
    note: it.note ?? '',
    start: minToHHmm(it.startMin),
    end: minToHHmm(typeof it.endMin === 'number' && it.endMin > it.startMin ? it.endMin : it.startMin + 30),
  };
  dlg.value = true;
  closeWkChip();
}
async function wkDeleteEvent() {
  const c = wkChip.value;
  const it = c.target;
  if (!it?.refId) return;
  try {
    await ElMessageBox.confirm(`删除「${it.time} ${it.title || it.label || ''}」？`, '删除日程', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await agentApi.deleteEvent(it.refId);
    ElMessage.success('已删除');
    closeWkChip();
    afterScheduleChange(c.date);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '删除失败');
  }
}

/** ---- 单日网格拖拽后快捷 chip（点一下即建，事项可不填） ---- */
const dgChip = ref({ open: false, top: 0, left: 0, a: 0, b: 0 });
function closeDgChip() {
  dgChip.value.open = false;
  sel.value = null;
}
function openDgChip(a: number, b: number) {
  const pos = cardPos(a);
  dgChip.value = { open: true, top: pos.top, left: pos.left, a, b };
}
async function dgQuickCreate(kind: string) {
  const c = dgChip.value;
  saving.value = true;
  try {
    const payload = { date: dateStr.value, startMin: minToHHmm(c.a), endMin: minToHHmm(c.b), kind, title: kind === 'EVENT' ? '日程安排' : '' };
    const r = await agentApi.createEvent(payload);
    if (r?.warning) ElMessage.warning(r.warning);
    else ElMessage.success(kindCn(kind));
    closeDgChip();
    load(true);
    afterScheduleChange();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message ?? '添加失败');
  } finally {
    saving.value = false;
  }
}
function dgOpenDetail() {
  const { a, b } = dgChip.value;
  dgChip.value.open = false;
  openCard(a, b);
}

function goMeeting(it: any) {
  if (it.refId) router.push(`/meetings/${it.refId}`);
}

onMounted(() => {
  load();
  loadWeek();
  loadMonth();
  refreshTimer = setInterval(refreshQuiet, 60000);
  document.addEventListener('visibilitychange', onVisChange);
});
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', onVisChange);
});
defineExpose({ reload: () => load() });
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
.myday-empty { color: var(--el-text-color-secondary); font-size: 13px; padding: 14px 0 6px; text-align: center; }
.myday-warn { color: var(--el-color-danger); font-size: 12px; }
.myday-dash { margin: 0 6px; color: var(--el-text-color-secondary); }
.myday-status { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: var(--el-fill-color); color: var(--el-text-color-secondary); white-space: nowrap; }
.myday-status.st-confirmed { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.myday-status.st-pending { background: var(--el-color-warning-light-8); color: var(--el-color-warning-dark-2); }
.myday-legend { display: flex; gap: 16px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--el-border-color-lighter); font-size: 12px; color: var(--el-text-color-secondary); flex-wrap: wrap; }
.myday-legend .lg { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.legend-tip { margin-left: auto; }
.lg-meeting { background: var(--el-color-primary); }
.lg-booking { background: var(--el-color-success); }
.lg-event { background: var(--el-color-warning); }
.lg-outing { background: var(--el-color-danger); }
.lg-task { background: #7f77dd; }
.lg-free { background: var(--el-color-success-light-5); }

/* ---- 单日时间网格（月历同款放大版）---- */
.dg-wrap { position: relative; }
.dg-grid { display: flex; }
.dg-gutter { width: 52px; flex-shrink: 0; }
.dg-hour { font-size: 11px; color: var(--el-text-color-secondary); text-align: right; padding-right: 8px; transform: translateY(-6px); font-variant-numeric: tabular-nums; }
/* 整点深线 + 半点浅线（background-size 由模板按 HOUR_PX 动态设置） */
.dg-track {
  position: relative; flex: 1; min-width: 0; cursor: crosshair; user-select: none; touch-action: pan-y;
  background-image:
    linear-gradient(to bottom, var(--el-border-color-lighter) 1px, transparent 1px),
    linear-gradient(to bottom, var(--el-fill-color-light) 1px, transparent 1px);
}
.dg-now { position: absolute; left: 0; right: 0; height: 2px; background: var(--el-color-danger); z-index: 3; pointer-events: none; opacity: 0.85; }
.dg-now::before { content: ''; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-danger); }
.dg-sel {
  position: absolute; left: 1%; width: 98%; z-index: 2; pointer-events: none;
  background: rgba(64, 158, 255, 0.16); border: 1px dashed var(--el-color-primary); border-radius: 4px;
  font-size: 11px; color: var(--el-color-primary); padding-left: 6px; line-height: 1.4;
}
.dg-block {
  position: absolute; z-index: 1; border-radius: 5px; padding: 2px 6px; font-size: 12px; line-height: 1.45;
  overflow: hidden; border-left: 3px solid var(--el-border-color); background: var(--el-fill-color-lighter);
}
.dg-block.clickable { cursor: pointer; }
.dg-b-time { font-size: 11px; opacity: 0.75; margin-right: 4px; font-variant-numeric: tabular-nums; }
.dg-b-title { font-weight: 500; white-space: nowrap; }
.dg-b-note { display: block; font-size: 11px; color: var(--el-text-color-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.blk-MEETING { background: var(--el-color-primary-light-9); border-left-color: var(--el-color-primary); }
.blk-BOOKING { background: var(--el-color-success-light-9); border-left-color: var(--el-color-success); }
.blk-EVENT { background: var(--el-color-warning-light-9); border-left-color: var(--el-color-warning); }
.blk-OUTING { background: var(--el-color-danger-light-9); border-left-color: var(--el-color-danger); }
.blk-TASK { background: #f3f2fc; border-left-color: #7f77dd; }
.blk-FREE { background: var(--el-fill-color-light); border-left-style: dashed; border-left-color: var(--el-color-success); }
/* 就地填写卡 */
.dg-card {
  position: absolute; z-index: 5; width: 300px; padding: 10px;
  background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 10px;
  box-shadow: var(--el-box-shadow-light); display: flex; flex-direction: column; gap: 8px;
}
.dg-card-hd { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.dg-card-time { color: var(--el-color-primary); font-size: 12px; font-variant-numeric: tabular-nums; }
.dg-card-row { display: flex; align-items: center; }
.dg-card-warn { padding-left: 2px; }
.dg-card-foot { display: flex; align-items: center; gap: 8px; }

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
.month-date { font-size: 12px; font-weight: 500; color: var(--el-text-color-primary); margin-bottom: 3px; display: flex; align-items: center; justify-content: space-between; }
.mc-add { border: none; background: var(--el-fill-color); color: var(--el-text-color-secondary); border-radius: 50%; width: 18px; height: 18px; line-height: 16px; font-size: 13px; cursor: pointer; opacity: 0; transition: opacity 0.15s; padding: 0; }
.month-cell:hover .mc-add { opacity: 1; }
.mc-add:hover { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
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
/* ---- 周历视图（本周一~周日 7 列×小时网格）---- */
.wk-head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
.myday-sec-title { font-weight: 500; font-size: 14px; }
.wk-lg { font-size: 12px; color: var(--el-text-color-secondary); }
.wk-lg .lg { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.wk-tip { margin-left: auto; }
.wk-tip b { color: var(--el-color-primary); }
.wk-grid { display: flex; align-items: flex-start; overflow-x: auto; }
.wk-gutter { width: 52px; flex-shrink: 0; }
.wk-corner { height: 30px; font-size: 11px; color: var(--el-text-color-placeholder); text-align: right; padding-right: 8px; line-height: 30px; }
.wk-hour { font-size: 11px; color: var(--el-text-color-secondary); text-align: right; padding-right: 8px; transform: translateY(-6px); font-variant-numeric: tabular-nums; }
.wk-col {
  position: relative; flex: 1 1 0; min-width: 108px; border-left: 1px solid var(--el-border-color-lighter);
  display: flex; flex-direction: column;
}
.wk-col:first-of-type { border-left: none; }
.wk-col.today { background: var(--el-color-primary-light-9); border-radius: 0 0 6px 6px; }
.wk-day-hd { display: flex; align-items: baseline; justify-content: space-between; padding: 0 6px 4px; height: 30px; box-sizing: border-box; }
.wk-day-date { font-size: 13px; font-weight: 500; }
.wk-day-date small { color: var(--el-text-color-secondary); font-weight: 400; margin-left: 3px; }
.wk-day-free { font-size: 11px; color: var(--el-color-success); font-variant-numeric: tabular-nums; }
.wk-day-free.none { color: var(--el-text-color-placeholder); }
.wk-track {
  position: relative; cursor: crosshair; user-select: none; touch-action: pan-y;
  background-image:
    linear-gradient(to bottom, var(--el-border-color-lighter) 1px, transparent 1px),
    linear-gradient(to bottom, var(--el-fill-color-light) 1px, transparent 1px);
}
.wk-block { position: absolute; left: 2px; right: 2px; z-index: 1; border-radius: 4px; padding: 0 4px; font-size: 11px; line-height: 1.4; overflow: hidden; cursor: pointer; white-space: nowrap; }
.wb-time { opacity: 0.7; margin-right: 3px; font-variant-numeric: tabular-nums; }
.wb-title { font-weight: 500; }
.wb-info { background: var(--el-color-primary-light-8); border-left: 2px solid var(--el-color-primary); color: var(--el-color-primary-dark-2); }
.wb-warn { background: var(--el-color-danger-light-8); border-left: 2px solid var(--el-color-danger); color: var(--el-color-danger-dark-2); }
.wb-free { background: var(--el-color-success-light-7); border-left: 2px solid var(--el-color-success); color: var(--el-color-success-dark-2); }
/* 快捷 chip 条（周历 + 单日网格共用） */
.wk-chipbar {
  position: absolute; z-index: 6; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  padding: 5px 6px; background: var(--el-bg-color); border: 1px solid var(--el-border-color);
  border-radius: 8px; box-shadow: var(--el-box-shadow-light); max-width: calc(100% - 8px); left: 4px;
}
.dg-chipbar { width: max-content; }
.wk-chip { border: none; cursor: pointer; font-size: 12px; padding: 3px 9px; border-radius: 12px; white-space: nowrap; }
.wc-free { background: var(--el-color-success-light-8); color: var(--el-color-success-dark-2); }
.wc-event { background: var(--el-color-warning-light-8); color: var(--el-color-warning-dark-2); }
.wc-outing { background: var(--el-color-danger-light-8); color: var(--el-color-danger-dark-2); }
.wc-busy { background: var(--el-fill-color); color: var(--el-text-color-regular); }
.wc-more { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.wc-cancel-open { background: var(--el-color-danger-light-8); color: var(--el-color-danger-dark-2); }
.wc-del { background: var(--el-color-danger-light-8); color: var(--el-color-danger-dark-2); }
.wc-x { background: var(--el-fill-color-light); color: var(--el-text-color-secondary); padding: 3px 7px; }
.wk-chip-note { font-size: 11px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
@media (max-width: 900px) {
  .wk-gutter { width: 40px; }
  .wk-col { min-width: 84px; }
  .wk-tip { display: none; }
}
@media (max-width: 900px) {
  .dg-gutter { width: 40px; }
  .dg-card { width: min(300px, calc(100vw - 40px)); }
}
</style>
