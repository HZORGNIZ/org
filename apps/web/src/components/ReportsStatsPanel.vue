<template>
  <div class="rsp">
    <!-- 查看范围（项目负责人及以上可选项目/部门；普通成员只看本人口径，后端也会做越权校验） -->
    <div class="page-card rsp-scope">
      <div class="muted rsp-sub">
        {{ mode === 'board' ? '按日期把所有人的日报排成一份文档，谁交了、写了几小时、谁没交一眼看全。' : '按人看他自己的日报时间轴，或直接看本期工时排行。' }}
      </div>
      <div class="rsp-bar">
        <template v-if="canScope">
          <el-select
            v-model="projectId"
            clearable
            filterable
            size="small"
            placeholder="全部项目"
            class="rsp-sel"
            @change="onScopeChange('project')"
          >
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
          <el-select
            v-model="departmentId"
            clearable
            filterable
            size="small"
            placeholder="全部部门"
            class="rsp-sel"
            @change="onScopeChange('department')"
          >
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </template>
        <span class="muted rsp-tip">{{ scopeLabel }}</span>
      </div>
    </div>

    <!-- ============ 日报看板：按日期查看（聚合文档） ============ -->
    <div v-if="mode === 'board'" class="page-card">
      <div class="rsp-bar">
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
          placeholder="选择日期"
          class="rsp-date"
          @change="loadDay"
        />
        <span v-if="day" class="muted">
          已交 <b class="rsp-ok">{{ day.submittedCount }}/{{ day.rosterCount }}</b>
          · 当日总工时 <b class="rsp-hours">{{ day.totalHours }}</b> 小时
        </span>
      </div>

      <!-- 文档式时间轴：与「历史日报」「项目详情·项目日报」共用 ReportDoc，全站日报展示形态一致 -->
      <div v-loading="dayLoading" class="rsp-doc-wrap">
        <ReportDoc
          v-if="day"
          :days="dayDocDays"
          :clickable="false"
          :clamp="false"
          empty-text="当天没有可查看的成员。"
        />
      </div>
    </div>

    <!-- ============ 工时统计：按人时间轴 + 工时排行 ============ -->
    <el-tabs v-else v-model="tab" class="rsp-tabs" @tab-change="onTabChange">
      <el-tab-pane label="按人看时间轴" name="person">
        <div class="page-card">
          <div class="rsp-bar">
            <el-select
              v-model="personId"
              filterable
              size="small"
              placeholder="选择成员"
              class="rsp-person"
              @change="loadTimeline"
            >
              <el-option v-for="u in people" :key="u.id" :label="u.label" :value="u.id" />
            </el-select>
            <!-- 画像入口：从时间轴跳到成员主页（项目/任务/会议活动等全貌） -->
            <el-button size="small" text type="primary" :disabled="!personId" @click="$router.push('/members/' + personId)">画像</el-button>
            <el-date-picker
              v-model="range"
              type="daterange"
              size="small"
              value-format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              class="rsp-range"
              @change="loadTimeline"
            />
            <el-button size="small" :loading="timelineLoading" @click="loadTimeline">查询</el-button>
            <span v-if="timeline" class="muted">
              {{ timeline.from }} ~ {{ timeline.to }}
              · 共 <b>{{ timeline.dayCount }}</b> 天
              · 累计 <b class="rsp-hours">{{ timeline.totalHours }}</b> 小时
              · 日均 <b>{{ timeline.avgHours }}</b> 小时
            </span>
          </div>

          <div v-loading="timelineLoading" class="rsp-tl-wrap">
            <ReportDoc
              v-if="timeline"
              :days="personDocDays"
              :clickable="false"
              :clamp="false"
              body-fallback="（无正文）"
              empty-text="该时间区间内没有日报记录。"
            />
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="工时排行" name="rank">
        <div class="page-card">
          <div class="rsp-bar">
            <el-radio-group v-model="rankScope" size="small" @change="loadRank">
              <el-radio-button value="week">本周</el-radio-button>
              <el-radio-button value="cumulative">累计</el-radio-button>
            </el-radio-group>
            <span v-if="rank" class="muted">
              {{ rank.label }} · {{ rank.scopeLabel }}
              · {{ rank.memberCount }} 人参与
              · 合计 <b class="rsp-hours">{{ rank.totalHours }}</b> 小时
            </span>
          </div>

          <div class="muted rsp-note">
            工时来源：提交日报时填写的「当日工时」，或日报正文里的「今天干了 X 小时」（AI 自动识别）；历史日报可点开详情补填。
          </div>

          <el-table :data="rank?.rows || []" size="small" v-loading="rankLoading" class="rsp-rank">
            <el-table-column label="名次" width="72">
              <template #default="{ row }">
                <span class="rsp-rank-no" :class="{ 'is-top': row.rank <= 3 }">{{ row.rank }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="成员" min-width="120" />
            <el-table-column label="部门" width="150">
              <template #default="{ row }">{{ row.departmentName || '—' }}</template>
            </el-table-column>
            <el-table-column label="工时合计" width="130" sortable :sort-method="sortByHours">
              <template #default="{ row }"><b class="rsp-hours">{{ row.hours }}</b> 小时</template>
            </el-table-column>
            <el-table-column prop="days" label="填报天数" width="110" />
            <el-table-column label="占比" min-width="180">
              <template #default="{ row }">
                <el-progress
                  :percentage="pct(row.hours)"
                  :stroke-width="10"
                  :show-text="false"
                  color="#e6a23c"
                />
              </template>
            </el-table-column>
            <template #empty>
              <div class="muted rsp-empty">本期还没有工时记录（在日报里写「今天干了 X 小时」，或提交日报时直接填「当日工时」；历史日报可点开详情补填）。</div>
            </template>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
// 日报看板 / 工时统计面板：原独立页「日报查看 / 工时统计」，现内嵌到「工作管理」的两个大 tab 里
// mode = 'board' → 按日期看全员日报的聚合文档；mode = 'hours' → 按人时间轴 + 工时排行
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { departmentsApi, projectsApi, reportsApi, usersApi } from '../api';
import ReportDoc from './ReportDoc.vue';
import type { DocDay, DocTag } from './report-doc';
import { useAuthStore } from '../stores/auth';

const props = defineProps<{ mode: 'board' | 'hours' }>();

const auth = useAuthStore();

/** 项目负责人及以上才显示项目/部门范围选择（后端仍会做越权校验） */
const canScope = computed(() => auth.roleRank >= 1);

const tab = ref<'person' | 'rank'>('person');

// ---- 范围 ----
const projectId = ref('');
const departmentId = ref('');
const projects = ref<any[]>([]);
const departments = ref<any[]>([]);
const scopeLabel = computed(() =>
  projectId.value
    ? '当前范围：单个项目'
    : departmentId.value
      ? '当前范围：单个部门'
      : canScope.value
        ? '当前范围：我可见的全部成员'
        : '当前范围：仅本人（如需查看团队，请联系负责人）',
);

// ---- 按日期 ----
const date = ref(dayjs().format('YYYY-MM-DD'));
const day = ref<any>(null);
const dayLoading = ref(false);
const isToday = computed(() => date.value === dayjs().format('YYYY-MM-DD'));

const dayGroups = computed(() => {
  const items: any[] = day.value?.items ?? [];
  const groups: { departmentName: string; items: any[] }[] = [];
  for (const it of items) {
    const key = it.departmentName || '未归属部门';
    let g = groups.find((x) => x.departmentName === key);
    if (!g) {
      g = { departmentName: key, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  // 组内：已交在前，未交置后
  for (const g of groups) g.items.sort((a, b) => Number(b.submitted) - Number(a.submitted));
  return groups;
});

/** 工时 / 归属项目 小标签（看板条目、按人时间轴共用同一拼法） */
function reportTags(x: any, opt: { missHours?: boolean } = {}): DocTag[] {
  const tags: DocTag[] = [];
  if (typeof x?.hours === 'number') tags.push({ label: `${x.hours} 小时`, type: x.hours ? 'warning' : 'info' });
  else if (opt.missHours) tags.push({ label: '未填工时', type: 'info' });
  if (x?.projectName) tags.push({ label: x.projectName, type: 'success' });
  return tags;
}

/** 看板 → ReportDoc 入参：一天一个日期节点，条目按部门分组（组标题由 dept 承担） */
const dayDocDays = computed<DocDay[]>(() => {
  const d = day.value;
  if (!d) return [];
  return [
    {
      key: d.date,
      label: d.date,
      sub: d.scopeLabel,
      entries: dayGroups.value.flatMap((g) =>
        g.items.map((it: any) => ({
          key: it.userId,
          name: it.name,
          dept: g.departmentName,
          tags: reportTags(it),
          submitted: !!it.submitted,
          content: it.content,
          raw: it,
        })),
      ),
    },
  ];
});

// ---- 按人 ----
const people = ref<{ id: string; label: string }[]>([]);
const personId = ref('');
const range = ref<[string, string]>([
  dayjs().subtract(29, 'day').format('YYYY-MM-DD'),
  dayjs().format('YYYY-MM-DD'),
]);
const timeline = ref<any>(null);
const timelineLoading = ref(false);

/** 按人看 → ReportDoc 入参：每个有日报的日期一个节点，条目就这个人自己 */
const personDocDays = computed<DocDay[]>(() =>
  (timeline.value?.days ?? []).map((d: any) => ({
    key: d.id,
    label: d.date,
    entries: [
      {
        key: d.id,
        name: timeline.value?.user?.name || '成员',
        tags: reportTags(d, { missHours: true }),
        content: d.content,
        raw: d,
      },
    ],
  })),
);

// ---- 排行 ----
const rankScope = ref<'week' | 'cumulative'>('week');
const rank = ref<any>(null);
const rankLoading = ref(false);

function sortByHours(a: any, b: any) {
  return (a?.hours ?? 0) - (b?.hours ?? 0);
}

function pct(hours: number) {
  const top = rank.value?.rows?.[0]?.hours || 0;
  if (!top || !hours) return 0;
  return Math.max(1, Math.round((hours / top) * 100));
}

function shiftDay(step: number) {
  date.value = dayjs(date.value).add(step, 'day').format('YYYY-MM-DD');
  loadDay();
}
function pickToday() {
  date.value = dayjs().format('YYYY-MM-DD');
  loadDay();
}

function onScopeChange(kind: 'project' | 'department') {
  // 项目与部门互斥，避免口径重叠
  if (kind === 'project' && projectId.value) departmentId.value = '';
  if (kind === 'department' && departmentId.value) projectId.value = '';
  if (props.mode === 'board') loadDay();
  else loadRank();
}

async function loadDay() {
  dayLoading.value = true;
  try {
    day.value = await reportsApi.dailyOverview({
      date: date.value || undefined,
      projectId: projectId.value || undefined,
      departmentId: departmentId.value || undefined,
    });
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载日报失败');
  } finally {
    dayLoading.value = false;
  }
}

async function loadTimeline() {
  timelineLoading.value = true;
  try {
    timeline.value = await reportsApi.personTimeline({
      userId: personId.value || undefined,
      from: range.value?.[0] || undefined,
      to: range.value?.[1] || undefined,
    });
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载时间轴失败');
  } finally {
    timelineLoading.value = false;
  }
}

async function loadRank() {
  rankLoading.value = true;
  try {
    rank.value = await reportsApi.hoursRanking({
      scope: rankScope.value,
      projectId: projectId.value || undefined,
      departmentId: departmentId.value || undefined,
      date: date.value || undefined,
    });
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载工时排行失败');
  } finally {
    rankLoading.value = false;
  }
}

function onTabChange(name: any) {
  if (name === 'person' && !timeline.value) loadTimeline();
  if (name === 'rank' && !rank.value) loadRank();
}

async function loadDictionaries() {
  const [projRes, deptRes, userRes] = await Promise.allSettled([
    projectsApi.list(),
    departmentsApi.list(),
    usersApi.list(),
  ]);
  if (projRes.status === 'fulfilled' && Array.isArray(projRes.value)) {
    projects.value = (projRes.value as any[]).map((p) => ({ id: p.id, name: p.name }));
  }
  if (deptRes.status === 'fulfilled' && Array.isArray(deptRes.value)) {
    departments.value = (deptRes.value as any[]).map((d) => ({ id: d.id, name: d.name }));
  }
  if (userRes.status === 'fulfilled' && Array.isArray(userRes.value)) {
    people.value = (userRes.value as any[]).map((u) => ({
      id: u.id,
      label: `${u.name}${u.department?.name ? `（${u.department.name}）` : ''}`,
    }));
  }
  // 默认看本人时间轴
  personId.value = auth.user?.id || people.value[0]?.id || '';
}

onMounted(async () => {
  await loadDictionaries();
  // 只拉当前模式需要的数据，另一个 tab 切过去时再懒加载
  if (props.mode === 'board') await loadDay();
  else await loadTimeline();
});

defineExpose({ loadDay, loadTimeline, loadRank });
</script>

<style scoped>
.rsp {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rsp-sub {
  font-size: 13px;
}
.rsp-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.rsp-scope .rsp-bar {
  margin-top: 0;
}
.rsp-sel {
  width: 190px;
}
.rsp-tip {
  font-size: 12px;
}
.rsp-date {
  width: 150px;
}
.rsp-person {
  width: 220px;
}
.rsp-range {
  width: 260px;
}
.rsp-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}
.rsp-ok {
  color: #67c23a;
}
.rsp-hours {
  color: #e6a23c;
}
.rsp-empty {
  padding: 10px 0;
  font-size: 13px;
}
.rsp-note {
  margin: 8px 0 4px;
  font-size: 12px;
  line-height: 1.6;
}

/* ---- 文档式时间轴 ----
   条目排版（.rp-*）已上提到全局 styles.css，与「历史日报」「项目日报」共用 ReportDoc 组件；
   这里只留看板需要的行宽限制（正文太长不好读） */
.rsp-doc-wrap {
  margin-top: 12px;
  min-height: 80px;
  max-width: 960px;
}

/* ---- 时间轴（按人看）---- */
.rsp-tl-wrap {
  margin-top: 14px;
  min-height: 80px;
  max-width: 960px;
}

/* ---- 排行 ---- */
.rsp-rank {
  margin-top: 12px;
}
.rsp-rank-no {
  display: inline-block;
  min-width: 22px;
  text-align: center;
  font-weight: 600;
  color: #909399;
}
.rsp-rank-no.is-top {
  color: #fff;
  background: #e6a23c;
  border-radius: 50%;
  width: 22px;
  height: 22px;
  line-height: 22px;
}
</style>
