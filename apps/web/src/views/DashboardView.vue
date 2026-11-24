<template>
  <div class="page">
    <div class="page-title"><span>数据看板</span></div>

    <!-- 时间范围 + 视角切换 -->
    <div class="page-card dash-toolbar">
      <el-radio-group v-model="period" size="small" @change="load">
        <el-radio-button value="week">本周</el-radio-button>
        <el-radio-button value="month">本月</el-radio-button>
        <el-radio-button value="quarter">本季度</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="scope" size="small" @change="load">
        <el-radio-button value="dept">按部门</el-radio-button>
        <el-radio-button value="project">按项目</el-radio-button>
        <el-radio-button value="user">按人员</el-radio-button>
      </el-radio-group>
      <span class="muted dash-tip">任务完成率/逾期为全量口径；日报数与工时为{{ data?.periodLabel || '本期' }}数据</span>
      <el-button text type="primary" size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="page-card" v-loading="loading">
      <div v-if="!rows.length && !loading" class="muted empty">当前范围内暂无数据</div>

      <!-- 按部门 -->
      <el-table v-if="scope === 'dept' && rows.length" :data="sorted" size="small" :default-sort="{ prop: 'taskTotal', order: 'descending' }">
        <el-table-column type="index" label="#" width="46" :index="(i: number) => i + 1" />
        <el-table-column label="部门" prop="name" min-width="120" sortable>
          <template #default="{ row }">
            <a class="dash-link" @click="$router.push('/departments')">{{ row.name }}</a>
          </template>
        </el-table-column>
        <el-table-column label="负责人" prop="sub" width="90" show-overflow-tooltip />
        <el-table-column label="项目" prop="projectCount" width="64" sortable />
        <el-table-column label="成员" prop="memberCount" width="64" sortable />
        <el-table-column label="任务完成率" sortable :sort-by="(r: any) => r.taskTotal ? r.taskDone / r.taskTotal : -1" min-width="150">
          <template #default="{ row }">
            <div class="bar-wrap">
              <div class="bar-track"><div class="bar bar-blue" :style="{ width: pct(row) + '%' }"></div></div>
              <span class="bar-num">{{ row.taskTotal ? pct(row) + '%' : '—' }}<i class="muted">（{{ row.taskDone }}/{{ row.taskTotal }}）</i></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="逾期" prop="taskOverdue" width="70" sortable>
          <template #default="{ row }">
            <span :class="{ 'dash-danger': row.taskOverdue > 0 }">{{ row.taskOverdue }}</span>
          </template>
        </el-table-column>
        <el-table-column label="日报数" prop="reportCount" width="76" sortable />
        <el-table-column label="工时" prop="hours" width="76" sortable>
          <template #default="{ row }">{{ row.hours ? row.hours + 'h' : '—' }}</template>
        </el-table-column>
        <el-table-column label="最近活动" sortable :sort-by="(r: any) => r.lastActivityAt || ''" width="150">
          <template #default="{ row }">
            <span v-if="row.lastActivityAt" :class="{ 'dash-warn': staleDays(row.lastActivityAt) >= 7, 'dash-danger': staleDays(row.lastActivityAt) >= 14 }">
              {{ timeAgo(row.lastActivityAt) }}
            </span>
            <span v-else class="muted">无记录</span>
          </template>
        </el-table-column>
      </el-table>

      <!-- 按项目 -->
      <el-table v-if="scope === 'project' && rows.length" :data="sorted" size="small">
        <el-table-column type="index" label="#" width="46" :index="(i: number) => i + 1" />
        <el-table-column label="项目" prop="name" min-width="140" sortable>
          <template #default="{ row }">
            <span class="dot" :style="{ background: colorOf(row.id) }"></span>
            <a class="dash-link" @click="$router.push('/projects/' + row.id)">{{ row.name }}</a>
          </template>
        </el-table-column>
        <el-table-column label="负责人" prop="sub" width="90" show-overflow-tooltip />
        <el-table-column label="关联部门" prop="projectCount" min-width="110" show-overflow-tooltip />
        <el-table-column label="成员" prop="memberCount" width="64" sortable />
        <el-table-column label="任务完成率" sortable :sort-by="(r: any) => r.taskTotal ? r.taskDone / r.taskTotal : -1" min-width="150">
          <template #default="{ row }">
            <div class="bar-wrap">
              <div class="bar-track"><div class="bar bar-blue" :style="{ width: pct(row) + '%' }"></div></div>
              <span class="bar-num">{{ row.taskTotal ? pct(row) + '%' : '—' }}<i class="muted">（{{ row.taskDone }}/{{ row.taskTotal }}）</i></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="逾期" prop="taskOverdue" width="70" sortable>
          <template #default="{ row }">
            <span :class="{ 'dash-danger': row.taskOverdue > 0 }">{{ row.taskOverdue }}</span>
          </template>
        </el-table-column>
        <el-table-column label="日报数" prop="reportCount" width="76" sortable />
        <el-table-column label="工时" prop="hours" width="76" sortable>
          <template #default="{ row }">{{ row.hours ? row.hours + 'h' : '—' }}</template>
        </el-table-column>
        <el-table-column label="最近进展" sortable :sort-by="(r: any) => r.lastActivityAt || ''" width="150">
          <template #default="{ row }">
            <span v-if="row.lastActivityAt" :class="{ 'dash-warn': staleDays(row.lastActivityAt) >= 7, 'dash-danger': staleDays(row.lastActivityAt) >= 14 }">
              {{ timeAgo(row.lastActivityAt) }}
            </span>
            <span v-else class="muted">无记录</span>
          </template>
        </el-table-column>
      </el-table>

      <!-- 按人员 -->
      <el-table v-if="scope === 'user' && rows.length" :data="sorted" size="small">
        <el-table-column type="index" label="#" width="46" :index="(i: number) => i + 1" />
        <el-table-column label="成员" prop="name" min-width="120" sortable>
          <template #default="{ row }">
            <a class="dash-link" @click="$router.push('/members/' + row.id)">{{ row.name }}</a>
          </template>
        </el-table-column>
        <el-table-column label="部门" prop="sub" width="110" show-overflow-tooltip />
        <el-table-column label="任务完成" sortable :sort-by="(r: any) => r.taskTotal ? r.taskDone / r.taskTotal : -1" min-width="150">
          <template #default="{ row }">
            <div class="bar-wrap">
              <div class="bar-track"><div class="bar bar-blue" :style="{ width: pct(row) + '%' }"></div></div>
              <span class="bar-num">{{ row.taskTotal ? pct(row) + '%' : '—' }}<i class="muted">（{{ row.taskDone }}/{{ row.taskTotal }}）</i></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="逾期" prop="taskOverdue" width="70" sortable>
          <template #default="{ row }">
            <span :class="{ 'dash-danger': row.taskOverdue > 0 }">{{ row.taskOverdue }}</span>
          </template>
        </el-table-column>
        <el-table-column label="日报数" prop="reportCount" width="76" sortable>
          <template #default="{ row }">
            <span :class="{ 'dash-warn': row.reportCount === 0 }">{{ row.reportCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="工时" prop="hours" width="76" sortable>
          <template #default="{ row }">{{ row.hours ? row.hours + 'h' : '—' }}</template>
        </el-table-column>
        <el-table-column label="最近日报" sortable :sort-by="(r: any) => r.lastActivityAt || ''" width="150">
          <template #default="{ row }">
            <span v-if="row.lastActivityAt" :class="{ 'dash-warn': staleDays(row.lastActivityAt) >= 3, 'dash-danger': staleDays(row.lastActivityAt) >= 7 }">
              {{ timeAgo(row.lastActivityAt) }}
            </span>
            <span v-else class="muted">无记录</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="rows.length" class="dash-legend muted">
        预警口径：<span class="dash-warn">橙</span>= 部门/项目超 7 天无动静 · 人员超 3 天无日报；
        <span class="dash-danger">红</span>= 部门/项目超 14 天无动静 · 人员超 7 天无日报 · 逾期任务
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { statsApi } from '../api';
import { timeAgo } from '../utils/format';

const scope = ref<'dept' | 'project' | 'user'>('dept');
const period = ref<'week' | 'month' | 'quarter'>('week');
const loading = ref(false);
const data = ref<any>(null);

const rows = computed<any[]>(() => data.value?.rows ?? []);
/** 默认按任务量降序，让最活跃的排前面 */
const sorted = computed(() => [...rows.value].sort((a, b) => b.taskTotal - a.taskTotal));

const COLORS = ['#428bff', '#22b573', '#f0a020', '#e24b4a', '#7f77dd', '#1d9e75', '#d4537e', '#378add'];
const colorOf = (id: string) => COLORS[Math.abs(hash(id)) % COLORS.length];
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function pct(row: any) {
  if (!row.taskTotal) return 0;
  return Math.round((row.taskDone / row.taskTotal) * 100);
}

/** 距离最近活动过了多少天 */
function staleDays(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function load() {
  loading.value = true;
  try {
    data.value = await statsApi.dashboard(scope.value, period.value);
  } catch {
    data.value = { rows: [] };
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.dash-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.dash-tip {
  font-size: 12px;
}
.dash-link {
  cursor: pointer;
  color: inherit;
}
.dash-link:hover {
  color: var(--el-color-primary);
}
.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: 1px;
}
.bar-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--el-fill-color-light);
  min-width: 50px;
  overflow: hidden;
}
.bar {
  height: 6px;
  border-radius: 3px;
}
.bar-blue {
  background: var(--el-color-primary);
}
.bar-num {
  font-size: 12px;
  white-space: nowrap;
}
.bar-num i {
  font-style: normal;
}
.dash-warn {
  color: var(--el-color-warning);
}
.dash-danger {
  color: var(--el-color-danger);
  font-weight: 500;
}
.dash-legend {
  margin-top: 10px;
  font-size: 12px;
}
</style>
