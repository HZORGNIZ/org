<template>
  <div class="ms-panel">
    <div class="ms-hd muted">
      全组织出勤、参加次数与活跃度（参加次数 × 重要性权重：高 3 / 中 2 / 低 1）
    </div>

    <!-- 筛选：时间范围 + 部门 + 姓名 -->
    <div class="page-card filter">
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :clearable="false"
        class="range"
        @change="load"
      />
      <el-select v-if="isAdmin" v-model="deptId" clearable placeholder="全部部门" class="dept-sel" @change="load">
        <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
      </el-select>
      <el-input v-model="keyword" placeholder="搜索姓名 / 部门" clearable class="kw" />
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="stat-row">
      <div class="page-card stat">
        <div class="stat-num">{{ data?.memberCount ?? 0 }}</div>
        <div class="muted">统计人数</div>
      </div>
      <div class="page-card stat">
        <div class="stat-num">{{ data?.meetings ?? 0 }}</div>
        <div class="muted">会议活动场次（活动 {{ data?.activityMeetings ?? 0 }} 场）</div>
      </div>
      <div class="page-card stat">
        <div class="stat-num">{{ data?.totalAttended ?? 0 }}/{{ data?.totalExpected ?? 0 }}</div>
        <div class="muted">总出勤 / 应出勤</div>
      </div>
      <div class="page-card stat">
        <div class="stat-num">{{ data?.avgScore ?? 0 }}</div>
        <div class="muted">人均活跃度</div>
      </div>
    </div>

    <div v-loading="loading" class="page-card">
      <el-table :data="rows" size="small" class="table" @row-click="openMember">
        <el-table-column prop="name" label="姓名" min-width="100" sortable />
        <el-table-column prop="departmentName" label="部门" min-width="110" sortable>
          <template #default="{ row }">{{ row.departmentName || '—' }}</template>
        </el-table-column>
        <el-table-column prop="expected" label="应参加" width="86" sortable />
        <el-table-column prop="attended" label="出勤" width="80" sortable />
        <el-table-column label="自主 / 补签" width="104">
          <template #default="{ row }">{{ row.selfCount }} / {{ row.makeupCount }}</template>
        </el-table-column>
        <el-table-column prop="missed" label="缺勤" width="80" sortable />
        <el-table-column label="出勤率" width="120" sortable :sort-method="sortRate">
          <template #default="{ row }">
            <div class="rate-cell">
              <el-progress :percentage="row.rate" :stroke-width="8" :show-text="false" class="rate-bar" />
              <span class="rate-num">{{ row.rate }}%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="activityCount" label="活动次数" width="92" sortable />
        <el-table-column prop="meetingCount" label="会议次数" width="92" sortable />
        <el-table-column prop="score" label="活跃度" width="86" sortable>
          <template #default="{ row }"><b class="score">{{ row.score }}</b></template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click.stop="openMember(row)">明细</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !rows.length" class="muted empty">该时间段内没有考勤数据</div>
    </div>

    <!-- 个人明细：全部参加过的会议活动 + 获赞 -->
    <el-drawer
      v-model="memberVisible"
      :title="member?.user?.name ? `${member.user.name} · 会议活动明细` : '个人明细'"
      size="min(720px, 96vw)"
    >
      <div v-if="member" v-loading="memberLoading" class="member">
        <div class="page-card member-sum">
          <div class="sum-item"><span class="sum-num">{{ member.score }}</span><span class="muted">活跃度</span></div>
          <div class="sum-item"><span class="sum-num">{{ member.attended }}</span><span class="muted">参加次数</span></div>
          <div class="sum-item"><span class="sum-num">{{ member.expected }}</span><span class="muted">应参加</span></div>
          <div class="sum-item"><span class="sum-num">{{ member.missed }}</span><span class="muted">缺勤</span></div>
          <div class="sum-item"><span class="sum-num">{{ member.selfCount }}/{{ member.makeupCount }}</span><span class="muted">自主/补签</span></div>
          <div class="sum-item"><span class="sum-num">{{ member.praiseCount }}</span><span class="muted">获赞次数</span></div>
        </div>
        <div class="muted member-meta">
          {{ member.user?.department?.name || '未归属部门' }}
          <template v-if="member.activityCount || member.meetingCount">
            ｜活动 {{ member.activityCount }} 次 · 会议 {{ member.meetingCount }} 次
          </template>
        </div>

        <div class="d-label">参加过的会议活动（{{ member.items?.length || 0 }}）</div>
        <el-table :data="member.items" size="small" class="table">
          <el-table-column label="时间" width="140">
            <template #default="{ row }">{{ fmt(row.startAt, 'YYYY-MM-DD HH:mm') }}</template>
          </el-table-column>
          <el-table-column prop="title" label="主题" min-width="180" />
          <el-table-column label="类型" width="86">
            <template #default="{ row }">{{ TYPE_LABEL[row.type] || row.type }}</template>
          </el-table-column>
          <el-table-column label="重要性" width="96">
            <template #default="{ row }">
              <el-tag size="small" :type="IMPORTANCE[row.importance]?.type || 'info'" effect="plain">
                {{ IMPORTANCE[row.importance]?.label || '中' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="签到" width="150">
            <template #default="{ row }">
              <el-tag size="small" :type="row.method === 'MAKEUP' ? 'warning' : 'success'" effect="plain">
                {{ row.method === 'MAKEUP' ? '补签' : '自主签到' }}
              </el-tag>
              <span class="muted ck-at">{{ fmt(row.checkedAt, 'MM-DD HH:mm') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="得分" width="70">
            <template #default="{ row }"><b class="score">{{ row.score }}</b></template>
          </el-table-column>
          <el-table-column label="说明" min-width="140">
            <template #default="{ row }">
              <span v-if="row.reason" class="muted">补签理由：{{ row.reason }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!member.items?.length" class="muted empty">暂无参加记录</div>

        <div class="d-label praise-hd">获赞记录（{{ member.praises?.length || 0 }}）</div>
        <div v-if="member.praises?.length" class="praise-list">
          <div v-for="p in member.praises" :key="p.id" class="praise-row">
            <span class="praise-title">{{ p.meetingTitle }}</span>
            <span class="muted">{{ p.praiserName }} 点赞</span>
            <span v-if="p.reason" class="praise-reason">{{ p.reason }}</span>
            <span class="muted">{{ fmt(p.createdAt, 'MM-DD HH:mm') }}</span>
          </div>
        </div>
        <div v-else class="muted">还没有获得点赞</div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
// 会议考勤面板：原来独立的一页（/admin/meeting-stats），现作为「会议活动」页的大 tab 内嵌展示
import { computed, onMounted, ref } from 'vue';
import { departmentsApi, meetingsApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';

const auth = useAuthStore();
const isAdmin = computed(() => String(auth.user?.role || '') === 'ADMIN');

/** 重要性：高 3 分 / 中 2 分 / 低 1 分（活跃度权重） */
const IMPORTANCE: Record<string, { label: string; type: 'danger' | 'warning' | 'info' }> = {
  HIGH: { label: '高', type: 'danger' },
  MEDIUM: { label: '中', type: 'warning' },
  LOW: { label: '低', type: 'info' },
};
const TYPE_LABEL: Record<string, string> = {
  ACTIVITY: '活动',
  WEEKLY: '周会',
  DAILY: '日会/站会',
  PROJECT: '项目会',
  REVIEW: '评审会',
  OTHER: '其他',
};

const loading = ref(false);
const data = ref<any>(null);
const deptId = ref('');
const keyword = ref('');
const departments = ref<any[]>([]);

/** 默认统计近 90 天 */
function defaultRange(): string[] {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = (x: Date) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 86400_000);
  return [d(from), d(to)];
}
const range = ref<string[]>(defaultRange());

/** 姓名 / 部门前端二次过滤（组织人数不多，不必再打一次接口） */
const rows = computed(() => {
  const list: any[] = data.value?.rows ?? [];
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return list;
  return list.filter(
    (r: any) =>
      String(r.name ?? '').toLowerCase().includes(kw) ||
      String(r.departmentName ?? '').toLowerCase().includes(kw),
  );
});

function sortRate(a: any, b: any) {
  return Number(a.rate ?? 0) - Number(b.rate ?? 0);
}

async function load() {
  loading.value = true;
  try {
    data.value = await meetingsApi.statsOverview({
      from: range.value?.[0],
      to: range.value?.[1],
      deptId: deptId.value || undefined,
    });
  } finally {
    loading.value = false;
  }
}

// ---------- 个人明细 ----------
const memberVisible = ref(false);
const memberLoading = ref(false);
const member = ref<any>(null);

async function openMember(row: any) {
  if (!row?.userId) return;
  memberVisible.value = true;
  memberLoading.value = true;
  member.value = null;
  try {
    member.value = await meetingsApi.statsMember(row.userId);
  } finally {
    memberLoading.value = false;
  }
}

onMounted(async () => {
  departments.value = await departmentsApi.list().catch(() => []);
  await load();
});

defineExpose({ load });
</script>

<style scoped>
.ms-hd {
  font-size: 12px;
  padding: 2px 2px 10px;
}
.filter {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.range {
  max-width: 260px;
}
.dept-sel {
  width: 160px;
}
.kw {
  max-width: 220px;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.stat {
  text-align: center;
}
.stat-num {
  font-size: 22px;
  font-weight: 600;
  color: #2f6fd0;
}
.table {
  width: 100%;
}
.rate-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rate-bar {
  flex: 1;
  min-width: 40px;
}
.rate-num {
  font-size: 12px;
  color: #606266;
}
.score {
  color: #2e7d32;
}
.empty {
  padding: 16px 0;
  text-align: center;
  font-size: 13px;
}
.member-sum {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 8px;
  text-align: center;
}
.sum-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.sum-num {
  font-size: 18px;
  font-weight: 600;
  color: #2f6fd0;
}
.member-meta {
  margin: 10px 0 4px;
  font-size: 12px;
}
.d-label {
  font-weight: 600;
  margin: 16px 0 8px;
}
.praise-hd {
  margin-top: 18px;
}
.ck-at {
  margin-left: 6px;
  font-size: 12px;
}
.praise-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.praise-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  border-bottom: 1px dashed var(--app-border);
  padding-bottom: 6px;
}
.praise-title {
  font-weight: 500;
}
.praise-reason {
  flex: 1;
  min-width: 0;
  color: #b26a00;
}

/* 手机浏览器：筛选竖排、表格横向滚动 */
@media (max-width: 760px) {
  .filter {
    flex-wrap: wrap;
  }
  .filter > * {
    flex: 1 1 46%;
  }
  .stat-row {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
}
</style>
