<template>
  <div class="pdp-card page-card" v-loading="loading">
    <div class="block-title-row">
      <span class="block-title">项目日报（{{ day?.scopeLabel || '本项目' }}）</span>
      <el-radio-group v-model="tab" size="small" @change="onTabChange">
        <el-radio-button value="day">按日期</el-radio-button>
        <el-radio-button value="person">按人员</el-radio-button>
        <el-radio-button value="rank">工时排行</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 按日期：本项目当天所有人的日报排成一段 -->
    <template v-if="tab === 'day'">
      <div class="pdp-bar">
        <el-button-group size="small">
          <el-button @click="shiftDay(-1)">前一天</el-button>
          <el-button :type="isToday ? 'primary' : ''" @click="pickToday">今天</el-button>
          <el-button @click="shiftDay(1)">后一天</el-button>
        </el-button-group>
        <el-date-picker
          v-model="date"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          :clearable="false"
          class="pdp-date"
          @change="loadDay"
        />
        <span v-if="day" class="muted">
          已交 <b class="ok">{{ day.submittedCount }}/{{ day.rosterCount }}</b>
          · 当日总工时 <b class="hrs">{{ day.totalHours }}</b> 小时
        </span>
      </div>
      <!-- 口径说明：项目日报按「成员」统计，不是按「日报归属本项目」统计 -->
      <div class="muted pdp-tip">
        只要他是本项目成员，他当天写的日报就会全部出现在这里（一人一天只有一篇日报）；
        标签上标的是这篇日报本身归属的项目（AI 判断），没判出来的标为「未标归属」。
      </div>
      <!-- 与「历史日报」「日报看板」用同一个 ReportDoc：全站日报都是一种文档式时间轴 -->
      <ReportDoc v-if="day" :days="dayDocDays" :clickable="false" :clamp="false" empty-text="当天没有可查看的成员日报。" />
    </template>

    <!-- 按人员：单人时间轴，逐日工时 + 区间累计 -->
    <template v-else-if="tab === 'person'">
      <div class="pdp-bar">
        <el-select v-model="personId" filterable size="small" placeholder="选择成员" class="pdp-sel" @change="loadTimeline">
          <el-option v-for="p in people" :key="p.id" :label="p.label" :value="p.id" />
        </el-select>
        <!-- 画像入口：从「他这几天干了什么」跳到「他这个人一直在干什么」 -->
        <el-button size="small" text type="primary" :disabled="!personId" @click="$router.push('/members/' + personId)">画像</el-button>
        <el-date-picker
          v-model="range"
          type="daterange"
          size="small"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          class="pdp-range"
          @change="loadTimeline"
        />
        <span v-if="timeline" class="muted">
          {{ timeline.from }} ~ {{ timeline.to }}
          · 共 <b>{{ timeline.dayCount }}</b> 天
          · 累计 <b class="hrs">{{ timeline.totalHours }}</b> 小时
          · 日均 <b>{{ timeline.avgHours }}</b> 小时
        </span>
      </div>
      <!-- 成员胶囊：点一下直接看这个人的时间轴（人多时仍可用上面的下拉搜索） -->
      <div v-if="people.length > 1" class="pdp-people">
        <button
          v-for="p in people"
          :key="p.id"
          class="pdp-person"
          :class="{ active: p.id === personId }"
          @click="pickPerson(p.id)"
        >{{ p.name }}</button>
      </div>
      <!-- 按人看也是同一个文档式时间轴：每个有日报的日期一个节点，条目就是这个成员自己 -->
      <div class="muted pdp-tip">
        这里看的是他本人的全部日报（与是否归属本项目无关），每篇标出它自己的归属项目，便于对照他在多个项目里的投入。
      </div>
      <ReportDoc
        v-if="timeline"
        :days="personDocDays"
        :clickable="false"
        :clamp="false"
        body-fallback="（无正文）"
        :empty-text="`${timeline.from} ~ ${timeline.to} 区间内没有日报记录。`"
      />
    </template>

    <!-- 工时排行：本周 / 累计，本项目口径 -->
    <template v-else>
      <div class="pdp-bar">
        <el-radio-group v-model="rankScope" size="small" @change="loadRank">
          <el-radio-button value="week">本周</el-radio-button>
          <el-radio-button value="cumulative">累计</el-radio-button>
        </el-radio-group>
        <span v-if="rank" class="muted">
          {{ rank.label }} · {{ rank.memberCount }} 人参与 · 合计 <b class="hrs">{{ rank.totalHours }}</b> 小时
        </span>
      </div>
      <div class="muted pdp-tip">
        工时与上面日报同口径（按成员名册）：一篇日报只有一个「当日工时」，无法按项目拆分，
        因此同时多个项目的成员，其工会计入他所在的每个项目。
      </div>
      <el-table :data="rank?.rows || []" size="small">
        <el-table-column label="名次" width="70">
          <template #default="{ row }">
            <span class="pdp-rank" :class="{ 'is-top': row.rank <= 3 }">{{ row.rank }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="成员" min-width="110" />
        <el-table-column label="工时合计" width="120">
          <template #default="{ row }"><b class="hrs">{{ row.hours }}</b> 小时</template>
        </el-table-column>
        <el-table-column prop="days" label="填报天数" width="100" />
        <el-table-column label="占比" min-width="140">
          <template #default="{ row }">
            <el-progress :percentage="pct(row.hours)" :stroke-width="10" :show-text="false" color="#e6a23c" />
          </template>
        </el-table-column>
        <template #empty>
          <div class="muted pdp-empty">本项目本期还没有工时记录（在日报里写「今天干了 X 小时」，或提交日报时直接填「当日工时」）。</div>
        </template>
      </el-table>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { reportsApi } from '../api';
import ReportDoc from './ReportDoc.vue';
import type { DocDay, DocTag } from './report-doc';

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const props = defineProps<{
  projectId: string;
  /** 项目成员（含负责人），用于「按人员」下拉 */
  members?: { userId: string; user?: { id?: string; name?: string } | null }[];
  owner?: { id?: string; name?: string } | null;
}>();

const tab = ref<'day' | 'person' | 'rank'>('day');
const loading = ref(false);

const people = computed(() => {
  const list: { id: string; name: string; label: string }[] = [];
  const me = props.owner;
  if (me?.id) list.push({ id: me.id, name: me.name || '负责人', label: `${me.name || '负责人'}（负责人）` });
  for (const m of props.members || []) {
    const id = m?.user?.id || m?.userId;
    if (!id || list.some((x) => x.id === id)) continue;
    list.push({ id, name: m?.user?.name || '成员', label: m?.user?.name || '成员' });
  }
  return list;
});

// ---- 按日期 ----
const date = ref(dayjs().format('YYYY-MM-DD'));
const day = ref<any>(null);
const isToday = computed(() => date.value === dayjs().format('YYYY-MM-DD'));

async function loadDay() {
  loading.value = true;
  try {
    day.value = await reportsApi.dailyOverview({ date: date.value || undefined, projectId: props.projectId });
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载项目日报失败');
  } finally {
    loading.value = false;
  }
}
function shiftDay(step: number) {
  date.value = dayjs(date.value).add(step, 'day').format('YYYY-MM-DD');
  loadDay();
}
function pickToday() {
  date.value = dayjs().format('YYYY-MM-DD');
  loadDay();
}

/** 条目小标签：当日工时 + 这篇日报自己的归属项目（未提交的不打这两个标签） */
function itemTags(it: any): DocTag[] {
  const tags: DocTag[] = [];
  const submitted = it.submitted !== false;
  if (typeof it.hours === 'number') tags.push({ label: `${it.hours} 小时`, type: it.hours ? 'warning' : 'info' });
  else if (submitted) tags.push({ label: '未填工时', type: 'info' });
  if (submitted) tags.push({ label: it.projectName ? `归属：${it.projectName}` : '未标归属', type: it.projectName ? 'success' : 'info' });
  return tags;
}

/** 按日看全员 → ReportDoc 入参：一天一个日期节点，右侧按人排开（已交在前、未提交置后） */
const dayDocDays = computed<DocDay[]>(() => {
  const d = day.value;
  if (!d) return [];
  return [
    {
      key: d.date,
      label: d.date,
      sub: WEEK_CN[dayjs(d.date).day()],
      entries: (d.items ?? []).map((it: any) => ({
        key: it.userId,
        name: it.name,
        tags: itemTags(it),
        submitted: !!it.submitted,
        content: it.content,
        raw: it,
      })),
    },
  ];
});

// ---- 按人员 ----
const personId = ref('');
const range = ref<[string, string]>([
  dayjs().subtract(29, 'day').format('YYYY-MM-DD'),
  dayjs().format('YYYY-MM-DD'),
]);
const timeline = ref<any>(null);

async function loadTimeline() {
  loading.value = true;
  try {
    timeline.value = await reportsApi.personTimeline({
      userId: personId.value || undefined,
      from: range.value?.[0] || undefined,
      to: range.value?.[1] || undefined,
    });
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载时间轴失败');
  } finally {
    loading.value = false;
  }
}

/** 点成员胶囊：直接切到该成员的时间轴 */
function pickPerson(id: string) {
  if (!id || id === personId.value) return;
  personId.value = id;
  loadTimeline();
}

/** 按人看 → ReportDoc 入参：每个有日报的日期一个节点，条目就这个人自己 */
const personDocDays = computed<DocDay[]>(() =>
  (timeline.value?.days ?? []).map((d: any) => ({
    key: d.id,
    label: d.date,
    sub: WEEK_CN[dayjs(d.date).day()],
    entries: [
      {
        key: d.id,
        name: timeline.value?.user?.name || '成员',
        tags: itemTags(d),
        content: d.content,
        raw: d,
      },
    ],
  })),
);

// ---- 排行 ----
const rankScope = ref<'week' | 'cumulative'>('week');
const rank = ref<any>(null);

async function loadRank() {
  loading.value = true;
  try {
    rank.value = await reportsApi.hoursRanking({
      scope: rankScope.value,
      projectId: props.projectId,
      date: date.value || undefined,
    });
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载工时排行失败');
  } finally {
    loading.value = false;
  }
}

function onTabChange(name: any) {
  if (name === 'person') {
    if (!personId.value) personId.value = people.value[0]?.id || '';
    if (!timeline.value) loadTimeline();
  }
  if (name === 'rank' && !rank.value) loadRank();
}

/** 排行占比（占本项目合计的百分比） */
function pct(hours: number) {
  const total = Number(rank.value?.totalHours) || 0;
  if (!total) return 0;
  return Math.min(100, Math.round((Number(hours) / total) * 100));
}

onMounted(() => {
  personId.value = people.value[0]?.id || '';
  loadDay();
});
</script>

<style scoped>
.page-card {
  background: #fff;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  padding: 14px 16px;
}
.block-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.block-title {
  font-weight: 600;
  font-size: var(--fs-lg);
}
.pdp-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 12px 0 8px;
}
.pdp-date {
  width: 150px;
}
.pdp-sel {
  width: 180px;
}
.pdp-range {
  width: 250px;
}
.ok {
  color: #67c23a;
}
.hrs {
  color: #e6a23c;
}
.pdp-empty {
  padding: 8px 0;
  font-size: 13px;
}
/* 日报排版（.rp-*）用全局 styles.css + 共用的 ReportDoc 组件，这里只留口径说明的排版 */
.pdp-tip {
  margin: 6px 0 10px;
  font-size: 12px;
  line-height: 1.7;
}
.pdp-people {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 10px;
}
.pdp-person {
  border: 1px solid var(--app-border);
  background: #fff;
  color: #606266;
  border-radius: 14px;
  padding: 3px 12px;
  font-size: 13px;
  cursor: pointer;
  line-height: 1.6;
}
.pdp-person:hover {
  border-color: #a9c8ff;
  color: #428bff;
}
.pdp-person.active {
  background: #eef4ff;
  border-color: #428bff;
  color: #428bff;
  font-weight: 600;
}
.pdp-rank {
  display: inline-block;
  min-width: 22px;
  text-align: center;
  font-weight: 600;
  color: #909399;
}
.pdp-rank.is-top {
  color: #fff;
  background: #e6a23c;
  border-radius: 50%;
  width: 22px;
  height: 22px;
  line-height: 22px;
}
</style>
