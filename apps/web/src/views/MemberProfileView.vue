<template>
  <div class="page">
    <div class="page-title">
      <span>成员画像</span>
      <div class="pf-head-ops">
        <!-- 页内切换成员：只在我有权查看的范围内搜（后端裁剪），点人名进画像后进不出别人的部门 -->
        <el-select
          v-model="pickId"
          filterable
          remote
          reserve-keyword
          placeholder="搜索成员"
          :remote-method="searchPeople"
          :loading="searching"
          style="width: 180px"
          @change="goPerson"
        >
          <el-option v-for="u in people" :key="u.id" :label="u.name" :value="u.id">
            <span>{{ u.name }}</span>
            <span class="muted" style="float: right">{{ u.department?.name || '' }}</span>
          </el-option>
        </el-select>
        <el-button text @click="$router.back()">返回</el-button>
      </div>
    </div>

    <div v-if="denied" class="page-card">
      <el-empty description="无权查看该成员画像" />
      <div class="muted pf-denied-tip">只能查看本人、同部门（含额外部门）、以及你负责/共管部门的成员画像。</div>
    </div>

    <div v-else-if="loading" class="page-card">
      <div v-loading="true" class="muted empty">加载中…</div>
    </div>

    <template v-else-if="p">
      <div class="pf-grid">
        <!-- 左：身份与关系 -->
        <div class="pf-col">
          <div class="page-card">
            <div class="pf-id">
              <el-avatar :size="56" :src="p.avatar || undefined" class="pf-avatar">{{ p.name?.slice(0, 1) }}</el-avatar>
              <div class="pf-id-main">
                <div class="pf-name">
                  {{ p.name }}
                  <el-tag v-if="!p.active" size="small" type="info" effect="plain">已离职</el-tag>
                </div>
                <div class="muted">{{ ROLE_LABEL[p.role] || p.role }}{{ p.username ? ` · ${p.username}` : '' }}</div>
                <div class="muted">加入于 {{ fmt(p.joinedAt, 'YYYY-MM-DD') }}</div>
              </div>
            </div>

            <div class="pf-block">
              <div class="pf-k">部门</div>
              <div v-if="!p.identity.departments.length" class="muted">尚未归属部门</div>
              <el-tag
                v-for="d in p.identity.departments"
                :key="d.id"
                size="small"
                :type="d.primary ? 'primary' : 'info'"
                effect="plain"
                class="pf-tag"
                @click="$router.push('/departments?id=' + d.id)"
              >
                {{ d.primary ? '主 · ' : '兼 · ' }}{{ d.name }}
              </el-tag>
            </div>

            <div v-if="p.identity.ledDepartments.length || p.identity.managedDepartments.length" class="pf-block">
              <div class="pf-k">管理职责</div>
              <el-tag v-for="d in p.identity.ledDepartments" :key="'l' + d.id" size="small" type="warning" effect="plain" class="pf-tag" @click="$router.push('/departments?id=' + d.id)">
                {{ d.name }} · 负责人
              </el-tag>
              <el-tag v-for="d in p.identity.managedDepartments" :key="'m' + d.id" size="small" type="warning" effect="plain" class="pf-tag" @click="$router.push('/departments?id=' + d.id)">
                {{ d.name }} · 共管人
              </el-tag>
            </div>

            <div class="pf-block">
              <div class="pf-k">汇报关系</div>
              <div class="pf-line">
                <span class="muted">上级：</span>
                <a v-if="p.identity.manager" class="pf-link" @click="goPerson(p.identity.manager.id)">{{ p.identity.manager.name }}</a>
                <template v-else-if="p.identity.defaultManager">
                  <a class="pf-link" @click="goPerson(p.identity.defaultManager.id)">{{ p.identity.defaultManager.name }}</a>
                  <el-tag size="small" type="info" effect="plain" style="margin-left: 6px">默认</el-tag>
                </template>
                <span v-else class="muted">无（根节点）</span>
              </div>
              <div class="pf-line">
                <span class="muted">直属下属：</span>
                <span v-if="!p.identity.subordinates.length" class="muted">无</span>
                <a v-for="s in p.identity.subordinates" :key="s.id" class="pf-link pf-link-gap" @click="goPerson(s.id)">{{ s.name }}</a>
              </div>
            </div>
          </div>

          <!-- 贡献（随手挂在左栏，右栏留给按时间走的进展） -->
          <div class="page-card">
            <div class="card-title">贡献</div>
            <div class="pf-stats">
              <div class="pf-stat"><b>{{ p.contribution.ideas }}</b><span class="muted">提案</span></div>
              <div class="pf-stat"><b>{{ p.contribution.docs }}</b><span class="muted">文档</span></div>
              <div class="pf-stat"><b>{{ p.contribution.files }}</b><span class="muted">文件</span></div>
            </div>
          </div>

          <div v-if="p.canSeePrivate && p.notes && p.notes.length" class="page-card">
            <div class="card-title">部门备注</div>
            <div v-for="(n, i) in p.notes" :key="i" class="pf-note">
              <div class="muted">{{ n.department?.name }} · {{ n.author?.name }} · {{ fmt(n.updatedAt, 'YYYY-MM-DD') }}</div>
              <div>{{ n.note }}</div>
            </div>
          </div>
        </div>

        <!-- 右：各维度 -->
        <div class="pf-col">
          <div class="page-card">
            <div class="card-title">工时</div>
            <div class="pf-stats">
              <div class="pf-stat"><b>{{ p.hours.total }}</b><span class="muted">累计小时</span></div>
              <div class="pf-stat"><b>{{ p.hours.month }}</b><span class="muted">本月</span></div>
              <div class="pf-stat"><b>{{ p.hours.week }}</b><span class="muted">本周</span></div>
            </div>
            <div class="pf-bars">
              <div v-for="m in p.hours.monthly" :key="m.month" class="pf-bar-col">
                <div class="pf-bar-track">
                  <div class="pf-bar" :style="{ height: barHeight(m.hours) }"></div>
                </div>
                <div class="pf-bar-num">{{ m.hours || '' }}</div>
                <div class="muted pf-bar-month">{{ m.month.slice(5) }}月</div>
              </div>
            </div>
          </div>

          <div class="page-card">
            <div class="card-title">报告</div>
            <div class="pf-stats">
              <div class="pf-stat"><b>{{ p.reports.total }}</b><span class="muted">累计篇数</span></div>
              <div class="pf-stat"><b>{{ p.reports.monthDays }}</b><span class="muted">本月天数</span></div>
              <div class="pf-stat"><b>{{ p.reports.weekCount }}<template v-if="p.reports.expectedWeek">/{{ p.reports.expectedWeek }}</template></b><span class="muted">本周</span></div>
            </div>
            <div v-if="p.reports.compliance !== null" class="pf-compliance">
              <span class="muted">本周达成率</span>
              <el-progress :percentage="Math.round(p.reports.compliance * 100)" :stroke-width="10" :status="p.reports.compliance >= 1 ? 'success' : 'warning'" />
            </div>
            <div class="muted pf-freq">部门要求：{{ FREQ_LABEL[p.reports.frequency] || '未设置' }}</div>
            <div class="pf-cal">
              <div v-for="c in p.reports.calendar" :key="c.date" class="pf-cal-cell" :title="`${c.date} ${c.written ? '已写 ' + (c.hours ?? 0) + 'h' : c.planned ? '应写未写' : '未勾选时段'}`">
                <div class="pf-cal-dot" :class="c.written ? 'on' : c.planned ? 'due' : 'off'"></div>
                <div class="muted pf-cal-d">{{ c.date.slice(8) }}</div>
              </div>
            </div>
            <div class="muted pf-legend">
              <span><i class="pf-cal-dot on"></i>已写</span>
              <span><i class="pf-cal-dot due"></i>应写未写</span>
              <span><i class="pf-cal-dot off"></i>未勾选时段</span>
            </div>
            <!-- 逐月报告清单：日报/周报各几篇、哪几天写的（正文看下方时间轴卡） -->
            <div class="pf-rm">
              <div v-for="mo in p.reports.months || []" :key="mo.month" class="pf-rm-month">
                <div class="pf-rm-head" @click="toggleMonth(mo.month)">
                  <span class="pf-rm-caret">{{ openMonth === mo.month ? '▾' : '▸' }}</span>
                  <span class="pf-rm-title">{{ Number(mo.month.slice(5)) }}月</span>
                  <span class="muted">
                    日报 {{ mo.daily }} 篇 · 周报 {{ mo.weekly }} 篇<template v-if="mo.hours"> · {{ mo.hours }}h</template>
                  </span>
                </div>
                <div v-if="openMonth === mo.month" class="pf-rm-days">
                  <span v-if="!mo.days.length" class="muted">当月没写报告</span>
                  <span
                    v-for="(d, i) in mo.days"
                    :key="d.date + d.type + i"
                    class="pf-rm-chip"
                    :class="{ 'pf-rm-weekly': d.type === 'WEEKLY' }"
                    :title="d.type === 'WEEKLY' ? '周报' : '日报 · ' + (d.hours === null ? '未填工时' : d.hours + 'h')"
                  >
                    {{ Number(d.date.slice(8)) }}日<template v-if="d.type === 'WEEKLY'">·周</template><template v-else-if="d.hours !== null"> {{ d.hours }}h</template>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="page-card">
            <div class="card-title">项目（{{ p.projects.count }}）</div>
            <div v-if="!p.projects.owned.length && !p.projects.joined.length" class="muted empty">暂无参与项目</div>
            <div v-for="pr in p.projects.owned" :key="'o' + pr.id" class="pf-proj" @click="$router.push('/projects/' + pr.id)">
              <span class="dot" :style="{ background: pr.color || '#428bff' }"></span>
              <span class="pf-proj-name ellipsis">{{ pr.name }}</span>
              <el-tag size="small" type="primary" effect="plain">负责</el-tag>
              <el-tag size="small" :type="PRJ_TYPE[pr.status] || 'info'" effect="plain">{{ PRJ_LABEL[pr.status] || pr.status }}</el-tag>
            </div>
            <div v-for="pr in p.projects.joined" :key="'j' + pr.id" class="pf-proj" @click="$router.push('/projects/' + pr.id)">
              <span class="dot" :style="{ background: pr.color || '#428bff' }"></span>
              <span class="pf-proj-name ellipsis">{{ pr.name }}</span>
              <span v-if="pr.position" class="muted">{{ pr.position }}</span>
              <el-tag v-if="!pr.isOwner" size="small" type="info" effect="plain">成员</el-tag>
            </div>
          </div>

          <div class="page-card">
            <div class="card-title">任务</div>
            <div class="pf-stats">
              <div v-for="(cnt, st) in p.tasks.byStatus" :key="st" class="pf-stat">
                <b>{{ cnt }}</b><span class="muted">{{ TASK_STATUS[st]?.label || st }}</span>
              </div>
              <div class="pf-stat"><b>{{ p.tasks.monthDone }}</b><span class="muted">本月完成</span></div>
              <div class="pf-stat"><b :class="{ 'pf-bad': p.tasks.overdue > 0 }">{{ p.tasks.overdue }}</b><span class="muted">逾期</span></div>
            </div>
            <div v-if="p.tasks.recentDone.length" class="pf-tasks">
              <div v-for="t in p.tasks.recentDone" :key="t.id" class="pf-task ellipsis">
                {{ t.title }}
                <span class="muted">（{{ t.project?.name }} · {{ fmt(t.completedAt, 'MM-DD') }}）</span>
              </div>
            </div>
          </div>

          <div class="page-card">
            <div class="card-title">会议与活动</div>
            <div class="pf-stats">
              <div class="pf-stat"><b>{{ p.meetings.attended }}</b><span class="muted">签到</span></div>
              <div class="pf-stat"><b>{{ p.meetings.activityCount }}</b><span class="muted">活动</span></div>
              <div class="pf-stat"><b>{{ p.meetings.meetingCount }}</b><span class="muted">会议</span></div>
              <div class="pf-stat"><b>{{ p.meetings.score }}</b><span class="muted">活跃度分</span></div>
              <div class="pf-stat"><b>{{ p.meetings.hosted }}</b><span class="muted">主持</span></div>
              <div class="pf-stat"><b>{{ p.meetings.praiseCount }}</b><span class="muted">获赞</span></div>
            </div>
            <div class="muted pf-sub">
              自主签到 {{ p.meetings.selfCount }} 次 · 补签 {{ p.meetings.makeupCount }} 次 · 被邀请 {{ p.meetings.invited }} 场 · 负责会议条目 {{ p.meetings.itemCount }} 项
            </div>
            <!-- 参加过的会议活动明细：点标题跳到那场会议详情（/meetings?meeting= 是现有深链） -->
            <div v-if="p.meetings.items && p.meetings.items.length" class="pf-mk">
              <div v-for="it in p.meetings.items" :key="it.meetingId" class="pf-mk-row">
                <span class="pf-mk-date muted">{{ fmt(it.startAt, 'MM-DD') }}</span>
                <el-tag size="small" :type="it.type === 'ACTIVITY' ? 'warning' : 'info'" effect="plain">
                  {{ it.type === 'ACTIVITY' ? '活动' : '会议' }}
                </el-tag>
                <a class="pf-mk-title ellipsis" @click="$router.push('/meetings?meeting=' + it.meetingId)">{{ it.title }}</a>
                <el-tag size="small" :type="it.method === 'MAKEUP' ? 'warning' : 'success'" effect="plain">
                  {{ it.method === 'MAKEUP' ? '补签' : '已签到' }}<template v-if="it.operatorName">·{{ it.operatorName }}</template>
                </el-tag>
                <span class="pf-mk-score muted">+{{ it.score }}</span>
              </div>
              <div class="muted pf-mk-more">共 {{ p.meetings.attended }} 场，仅显示最近 {{ p.meetings.items.length }} 场</div>
            </div>
          </div>

          <div v-if="p.canSeePrivate && p.pbc" class="page-card">
            <div class="card-title">PBC 考核</div>
            <div v-if="!p.pbc.length" class="muted empty">暂无 PBC 记录</div>
            <div v-for="row in p.pbc" :key="row.month" class="pf-pbc">
              <span>{{ row.month }}</span>
              <span>{{ row.total }} 分</span>
              <el-tag size="small" :type="PBSTATUS_TYPE[row.status] || 'info'" effect="plain">{{ PBSTATUS_LABEL[row.status] || row.status }}</el-tag>
              <el-tag v-if="row.reviewStatus && row.reviewStatus !== 'NOT_STARTED'" size="small" :type="PBREVIEW_TYPE[row.reviewStatus]" effect="plain">
                {{ PBREVIEW_LABEL[row.reviewStatus] }}{{ row.leaderTotal !== null && row.leaderTotal !== undefined ? ` · ${row.leaderTotal} 分` : '' }}
              </el-tag>
            </div>
          </div>

          <div class="page-card">
            <div class="card-title">最近 {{ p.timeline.days.length || 0 }} 篇日报</div>
            <div v-if="!p.timeline.days.length" class="muted empty">近 30 天没有日报</div>
            <div v-for="d in p.timeline.days.slice(0, 15)" :key="d.id" class="pf-day">
              <div class="pf-day-head">
                <span class="pf-day-date">{{ d.date }}</span>
                <span v-if="d.hours" class="muted">{{ d.hours }}h</span>
                <span v-if="d.projectName" class="muted">· {{ d.projectName }}</span>
              </div>
              <div class="pf-day-body">{{ d.content || '（无正文）' }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { membersApi } from '../api';
import { TASK_STATUS, fmt } from '../utils/format';

const route = useRoute();
const router = useRouter();

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '系统管理员',
  DEPT_LEADER: '部门负责人',
  PROJECT_LEADER: '项目负责人',
  MEMBER: '成员',
};
const FREQ_LABEL: Record<string, string> = { NONE: '不要求', DAILY: '每天', WORKDAY: '每个工作日', WEEKLY_COUNT: '每周若干篇' };
const PRJ_LABEL: Record<string, string> = { PENDING: '待审批', ACTIVE: '进行中', REJECTED: '已驳回' };
const PRJ_TYPE: Record<string, string> = { PENDING: 'warning', ACTIVE: 'success', REJECTED: 'danger' };
const PBSTATUS_LABEL: Record<string, string> = { DRAFT: '未填写', SUBMITTED: '待审批', APPROVED: '已通过', REJECTED: '已退回' };
const PBSTATUS_TYPE: Record<string, string> = { DRAFT: 'info', SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'danger' };
const PBREVIEW_LABEL: Record<string, string> = { NOT_STARTED: '未自评', SELF_DONE: '已自评·待评分', LEADER_DONE: '已定稿' };
const PBREVIEW_TYPE: Record<string, string> = { NOT_STARTED: 'info', SELF_DONE: 'warning', LEADER_DONE: 'success' };

const p = ref<any>(null);
const loading = ref(false);
const denied = ref(false);
const targetId = computed(() => String(route.params.id || ''));

// 页内切换成员的下拉：pickId 只作选择器，真正取数看路由参数
const pickId = ref('');
const people = ref<any[]>([]);
const searching = ref(false);

// 逐月报告清单：默认只展开当月，点段头切换（一次只展开一个，手机端不至于拉太长）
const openMonth = ref('');
function toggleMonth(m: string) {
  openMonth.value = openMonth.value === m ? '' : m;
}

async function load() {
  if (!targetId.value) return;
  loading.value = true;
  denied.value = false;
  try {
    p.value = await membersApi.profile(targetId.value);
    pickId.value = p.value.id;
    openMonth.value = localMonthKey();
    // 远端下拉在没有候选时只回显 value（一串 id），这里把当前人补成首个候选，标题栏才显示姓名
    const cur = {
      id: p.value.id,
      name: p.value.name,
      department: (p.value.identity?.departments || []).find((d: any) => d.primary) || null,
    };
    if (!people.value.some((u) => u.id === cur.id)) people.value = [cur, ...people.value];
  } catch (e: any) {
    // 403 = 越权：渲染空态而不是抛错页；其余错误照旧由拦截器提示
    denied.value = e?.response?.status === 403;
    p.value = null;
  } finally {
    loading.value = false;
  }
}

/** 本地月份串 YYYY-MM，与后端 reportMonths 的 month 同口径 */
function localMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

async function searchPeople(q: string) {
  if (!q?.trim()) return;
  searching.value = true;
  try {
    people.value = await membersApi.search(q.trim());
  } finally {
    searching.value = false;
  }
}

function goPerson(id: string) {
  if (!id || id === targetId.value) return;
  router.push(`/members/${id}`);
}

/** 月度柱高：以本人近 6 个月的最大值为标尺，柱子只表达相对多少，不做同比统计 */
const maxMonthHours = computed(() => Math.max(1, ...(p.value?.hours?.monthly ?? []).map((m: any) => m.hours || 0)));
function barHeight(hours: number) {
  if (!hours) return '2px';
  return `${Math.max(4, Math.round((hours / maxMonthHours.value) * 100))}%`;
}

watch(targetId, load);
onMounted(load);
</script>

<style scoped>
.pf-head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 双栏：PC 左窄右宽，手机端（<768px）塌成单列，卡片按信息优先级自上而下排 */
.pf-grid {
  display: grid;
  grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
  gap: var(--sp-3);
  align-items: start;
}
@media (max-width: 767px) {
  .pf-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.pf-col {
  min-width: 0;
}
.pf-col > .page-card:last-child {
  margin-bottom: 0;
}
.pf-id {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pf-avatar {
  background: var(--el-color-primary);
  color: #fff;
  font-size: 22px;
  flex-shrink: 0;
}
.pf-name {
  font-size: var(--fs-lg);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pf-block {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid #f5f7fa;
}
.pf-k {
  font-size: var(--fs-xs);
  color: var(--row-head-ink);
  margin-bottom: 6px;
}
.pf-tag {
  margin: 0 6px 6px 0;
  cursor: pointer;
}
.pf-line {
  font-size: var(--fs-sm);
  margin-bottom: 4px;
}
.pf-link {
  color: var(--el-color-primary);
  cursor: pointer;
}
.pf-link-gap {
  margin-right: 8px;
}
.pf-note {
  font-size: var(--fs-sm);
  padding: 6px 0;
  border-bottom: 1px solid #f5f7fa;
}
.pf-note:last-child {
  border-bottom: none;
}
.pf-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.pf-stat {
  flex: 1 1 78px;
  background: var(--app-band);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.pf-stat b {
  font-size: var(--fs-num);
  color: var(--app-heading);
  line-height: 1.2;
}
.pf-bad {
  color: var(--el-color-danger) !important;
}
.pf-bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 108px;
  margin-top: 6px;
}
.pf-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}
.pf-bar-track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.pf-bar {
  width: 60%;
  max-width: 26px;
  background: linear-gradient(180deg, var(--app-brand) 0%, var(--app-navy) 100%);
  border-radius: 4px 4px 0 0;
}
.pf-bar-num {
  font-size: var(--fs-2xs);
  color: var(--chip-ink);
  height: 14px;
}
.pf-bar-month {
  font-size: var(--fs-2xs);
}
.pf-compliance {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.pf-compliance :deep(.el-progress) {
  flex: 1;
}
.pf-freq {
  font-size: var(--fs-xs);
  margin-bottom: 6px;
}
.pf-cal {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}
.pf-cal-cell {
  flex: 1 0 auto;
  min-width: 20px;
  text-align: center;
}
.pf-cal-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  margin: 0 auto 2px;
  display: block;
}
.pf-cal-dot.on {
  background: var(--el-color-success);
}
.pf-cal-dot.due {
  background: var(--el-color-warning);
}
.pf-cal-dot.off {
  background: #e4e7ed;
}
.pf-cal-d {
  font-size: var(--fs-2xs);
}
.pf-legend {
  display: flex;
  gap: 12px;
  font-size: var(--fs-2xs);
  margin-top: 6px;
}
.pf-legend .pf-cal-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 4px 0 0;
  vertical-align: -1px;
}
.pf-proj {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
  font-size: var(--fs-sm);
  min-width: 0;
}
.pf-proj:last-child {
  border-bottom: none;
}
.pf-proj-name {
  flex: 1;
  font-weight: 500;
  min-width: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.pf-task {
  font-size: var(--fs-sm);
  padding: 4px 0;
}
.pf-sub {
  font-size: var(--fs-xs);
  margin-top: 6px;
}
/* 会议与活动明细：一行一场，标题可点跳进那场会议详情 */
.pf-mk {
  margin-top: 6px;
}
.pf-mk-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--fs-sm);
  padding: 6px 0;
  border-bottom: 1px solid #f5f7fa;
  min-width: 0;
}
.pf-mk-row:last-of-type {
  border-bottom: none;
}
.pf-mk-date {
  font-size: var(--fs-xs);
  flex-shrink: 0;
}
.pf-mk-title {
  flex: 1 1 120px;
  min-width: 0;
  color: var(--el-color-primary);
  cursor: pointer;
}
.pf-mk-score {
  font-size: var(--fs-xs);
  flex-shrink: 0;
}
.pf-mk-more {
  font-size: var(--fs-2xs);
  padding-top: 6px;
}
/* 逐月报告清单：段头可点展开，展开后一天一个 chip */
.pf-rm {
  margin-top: 8px;
  border-top: 1px solid #f5f7fa;
}
.pf-rm-month {
  border-bottom: 1px solid #f5f7fa;
}
.pf-rm-month:last-child {
  border-bottom: none;
}
.pf-rm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 0;
  cursor: pointer;
  font-size: var(--fs-sm);
}
.pf-rm-caret {
  color: var(--row-head-ink);
  width: 12px;
  flex-shrink: 0;
}
.pf-rm-title {
  font-weight: 600;
  flex-shrink: 0;
}
.pf-rm-days {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 8px 18px;
}
.pf-rm-chip {
  font-size: var(--fs-2xs);
  background: var(--app-band);
  border-radius: var(--r-sm);
  padding: 2px 7px;
  white-space: nowrap;
}
.pf-rm-weekly {
  background: transparent;
  border: 1px solid var(--el-color-warning);
  color: var(--el-color-warning);
}
.pf-pbc {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--fs-sm);
  padding: 6px 0;
  border-bottom: 1px solid #f5f7fa;
}
.pf-pbc:last-child {
  border-bottom: none;
}
.pf-day {
  padding: 8px 0;
  border-bottom: 1px solid #f5f7fa;
}
.pf-day:last-child {
  border-bottom: none;
}
.pf-day-head {
  display: flex;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--chip-ink);
}
.pf-day-date {
  font-weight: 600;
}
.pf-day-body {
  font-size: var(--fs-sm);
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.pf-denied-tip {
  text-align: center;
  font-size: var(--fs-xs);
}
.empty {
  padding: 10px 0;
}
</style>
