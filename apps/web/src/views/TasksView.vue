<template>
  <div class="page">
    <div class="page-title">
      任务
      <el-button type="primary" @click="showForm = true">
        <el-icon><Plus /></el-icon>&nbsp;新建任务
      </el-button>
    </div>

    <!-- 大 tab：任务列表（按归属分段的明细清单）/ 任务看板（按项目聚合三种状态的统计与明细） -->
    <el-tabs v-model="tab" class="task-tabs" @tab-change="onTabChange">
      <el-tab-pane label="任务列表" name="list">
    <!-- 筛选栏 -->
    <div class="page-card filters">
      <!-- 范围筛选：从首页“待办/逾期”统计跳转时自动选中，也可手动切换 -->
      <div class="scope-tabs">
        <button
          v-for="s in SCOPES"
          :key="s.value"
          type="button"
          class="scope-tab"
          :class="{ active: scope === s.value }"
          @click="setScope(s.value)"
        >
          {{ s.label }}
        </button>
        <!-- 口径说明：列表只看自己的任务，别人的任务走「任务看板」按项目看 -->
        <span class="muted scope-hint">这里只列指派给你的任务；要看所在项目里所有人的任务，切到右边「任务看板」</span>
      </div>
      <el-input v-model="filters.keyword" placeholder="搜索标题/描述" clearable class="kw" @input="debounceLoad" />
      <el-select v-model="filters.projectId" placeholder="项目" clearable class="sel" @change="load">
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-select v-model="filters.status" placeholder="状态" clearable class="sel" @change="load">
        <el-option v-for="(v, k) in TASK_STATUS" :key="k" :label="v.label" :value="k" />
      </el-select>
      <!-- 负责人只有管理员可切换（默认仍是自己）；普通成员固定看自己的任务 -->
      <el-select
        v-model="filters.assigneeId"
        :placeholder="auth.isAdmin ? '负责人（默认我自己）' : '负责人（我自己）'"
        clearable
        filterable
        class="sel"
        :disabled="!auth.isAdmin || scope !== 'all'"
        @change="load"
      >
        <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
      </el-select>
    </div>

    <!-- 列表：只列指派给我的任务（所在项目里别人的任务不铺进来了），按健康度深浅配色（深=延期/紧迫） -->
    <div class="page-card">
      <div v-loading="loading" class="list">
        <div v-for="sec in sections" :key="sec.key" class="section">
          <div v-if="sec.tasks.length" class="section-head">
            <span class="section-bar" :style="{ background: sec.bar }"></span>
            <span class="section-title">{{ sec.title }}</span>
            <span class="section-count">{{ sec.tasks.length }}</span>
          </div>
          <!-- 桌面表格 -->
          <el-table
            v-if="isDesktop && sec.tasks.length"
            :data="sec.tasks"
            :row-class-name="rowClass"
            style="width: 100%"
            @row-click="(row: any) => openTask(row.id)"
          >
            <el-table-column label="标题" min-width="260">
              <template #default="{ row }">
                <el-tag
                  v-if="row.assigneeId === auth.user?.id"
                  size="small"
                  type="primary"
                  effect="dark"
                  class="mine-tag"
                >我的</el-tag>
                <el-tag :type="TASK_STATUS[row.status]?.type" size="small">{{ TASK_STATUS[row.status]?.label }}</el-tag>
                <el-tag :type="TASK_PRIORITY[row.priority]?.type" size="small" effect="plain">
                  {{ TASK_PRIORITY[row.priority]?.label }}
                </el-tag>
                <span class="task-title ellipsis">{{ row.title }}</span>
              </template>
            </el-table-column>
            <el-table-column label="项目" width="140" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.project?.name">{{ row.project.name }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="负责人" width="110">
              <template #default="{ row }">
                <span :class="{ muted: !row.assignee }">{{ row.assignee?.name || '未指派' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="截止" width="120">
              <template #default="{ row }">
                <span
                  v-if="row.dueDate"
                  class="due-cell"
                  :style="{ color: healthOf(row) >= 0 ? healthStyle(healthOf(row)).text : undefined }"
                  :class="{ overdue: isOverdue(row.dueDate) }"
                >{{ fmt(row.dueDate, 'MM-DD HH:mm') }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="进度" width="170">
              <template #default="{ row }">
                <div class="cell-prog" @click.stop>
                  <TaskUpdatePopover :task="row" @open="openTask(row.id)">
                    <el-progress class="progress" :percentage="row.progress ?? 0" :stroke-width="6" :show-text="false" />
                  </TaskUpdatePopover>
                  <span class="muted pct">{{ row.progress ?? 0 }}%</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="更新于" width="130">
              <template #default="{ row }">
                <span v-if="row.updatedAt" class="muted">{{ fmt(row.updatedAt, 'MM-DD HH:mm') }}</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <!-- 行内快捷操作：未完成的任务可一键标记完成（等同状态改为已完成，进度自动置 100%） -->
            <el-table-column label="操作" width="96" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.status !== 'DONE'"
                  text
                  type="success"
                  size="small"
                  :loading="completing === row.id"
                  @click.stop="completeTask(row)"
                >一键完成</el-button>
                <span v-else class="muted">已完成</span>
              </template>
            </el-table-column>
          </el-table>

          <!-- 移动端卡片 -->
          <template v-else>
            <TaskUpdatePopover
              v-for="t in sec.tasks"
              :key="t.id"
              :task="t"
              @open="openTask(t.id)"
            >
              <div class="task" :style="cardStyle(t)" @click="openTask(t.id)">
                <div class="task-main">
                  <el-tag v-if="t.assigneeId === auth.user?.id" size="small" type="primary" effect="dark" class="mine-tag">我的</el-tag>
                  <el-tag :type="TASK_STATUS[t.status]?.type" size="small">{{ TASK_STATUS[t.status]?.label }}</el-tag>
                  <el-tag :type="TASK_PRIORITY[t.priority]?.type" size="small" effect="plain">{{ TASK_PRIORITY[t.priority]?.label }}</el-tag>
                  <span class="task-title ellipsis">{{ t.title }}</span>
                </div>
                <div class="task-meta">
                  <el-tag v-if="t.project?.name" size="small" effect="plain" type="primary" class="proj-tag">{{ t.project.name }}</el-tag>
                  <span v-if="t.tags?.length" class="tag-row">
                    <el-tag v-for="tag in t.tags.slice(0, 3)" :key="tag.id" size="small" type="info" effect="plain">{{ tag.name }}</el-tag>
                  </span>
                  <span class="assignee">
                    <el-icon :size="13" class="muted"><User /></el-icon>
                    <span :class="{ muted: !t.assignee }">{{ t.assignee?.name || '未指派' }}</span>
                  </span>
                  <span v-if="t.dueDate" class="due" :class="{ overdue: isOverdue(t.dueDate) }">{{ fmt(t.dueDate, 'MM-DD HH:mm') }}</span>
                  <el-progress class="progress" :percentage="t.progress ?? 0" :stroke-width="4" :show-text="false" />
                  <span class="muted pct">{{ t.progress ?? 0 }}%</span>
                  <span v-if="t.updatedAt" class="muted upd">更新于 {{ fmt(t.updatedAt, 'MM-DD HH:mm') }}</span>
                  <el-button
                    v-if="t.status !== 'DONE'"
                    size="small"
                    type="success"
                    plain
                    class="done-btn"
                    :loading="completing === t.id"
                    @click.stop="completeTask(t)"
                  >完成</el-button>
                </div>
              </div>
            </TaskUpdatePopover>
          </template>
        </div>
        <div v-if="!hasAnyTask && !loading" class="muted empty">{{ emptyText }}</div>
      </div>
    </div>
      </el-tab-pane>

      <!-- 看板：顶部按项目给出 总数/待办/进行中/已完成 统计，点卡片在下方展开该项目明细 -->
      <el-tab-pane label="任务看板" name="board">
        <TaskBoardPanel ref="boardRef" @open-task="openTask" />
      </el-tab-pane>
    </el-tabs>

    <TaskFormDialog v-model="showForm" @saved="onTaskChanged" />
    <TaskDetailDrawer v-model="drawer" :task-id="currentId" @changed="onTaskChanged" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { projectsApi, tasksApi, usersApi } from '../api';
import { TASK_PRIORITY, TASK_STATUS, fmt } from '../utils/format';
import { taskHealth, healthStyle, healthClass } from '../utils/task-health';
import { useAuthStore } from '../stores/auth';
import TaskFormDialog from '../components/TaskFormDialog.vue';
import TaskDetailDrawer from '../components/TaskDetailDrawer.vue';
import TaskBoardPanel from '../components/TaskBoardPanel.vue';
import TaskUpdatePopover from '../components/TaskUpdatePopover.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 大 tab：任务列表 / 任务看板；与地址栏 ?tab=board 同步（首页「去看板」等入口直达看板） */
type TabKey = 'list' | 'board';
const tab = ref<TabKey>(route.query.tab === 'board' ? 'board' : 'list');
const boardRef = ref<InstanceType<typeof TaskBoardPanel> | null>(null);

function onTabChange(name: any) {
  tab.value = name === 'board' ? 'board' : 'list';
  const q = { ...route.query };
  if (tab.value === 'board') q.tab = 'board';
  else delete q.tab;
  router.replace({ query: q });
  // 从看板切回列表时重新拉一次，避免在看板里改过状态后列表是旧的
  if (tab.value === 'list') load();
}
watch(
  () => route.query.tab,
  (v) => {
    const t: TabKey = v === 'board' ? 'board' : 'list';
    if (t !== tab.value) tab.value = t;
  },
);

/** 新建/编辑任务后：按当前 tab 刷新对应视图 */
function onTaskChanged() {
  if (tab.value === 'board') boardRef.value?.reload();
  else load();
}

/** 范围筛选：我的全部 / 我的待办 / 我的逾期；三个口径都只看“指派给我”的任务，与首页统计卡跳转参数 scope 对应 */
type Scope = 'all' | 'mine' | 'overdue';
const SCOPES: { value: Scope; label: string }[] = [
  { value: 'all', label: '我的全部' },
  { value: 'mine', label: '我的待办' },
  { value: 'overdue', label: '我的逾期' },
];
function normalizeScope(v: unknown): Scope {
  return v === 'mine' || v === 'overdue' ? v : 'all';
}
const scope = ref<Scope>(normalizeScope(route.query.scope));

const tasks = ref<any[]>([]);
const projects = ref<any[]>([]);
const users = ref<any[]>([]);
const loading = ref(false);
const showForm = ref(false);
const drawer = ref(false);
const currentId = ref<string | null>(null);
const isDesktop = ref(window.innerWidth >= 768);

const filters = reactive({
  keyword: '',
  projectId: '' as string,
  status: '' as string,
  assigneeId: '' as string,
});

let timer: any = null;
function debounceLoad() {
  clearTimeout(timer);
  timer = setTimeout(load, 300);
}

/** 切换范围：同步地址栏 query（刷新/前进后退保持）；待办/逾期强制看自己的，【我的全部】下管理员可切换到他人 */
function setScope(s: Scope) {
  scope.value = s;
  if (s !== 'all' || !auth.isAdmin) filters.assigneeId = '';
  router.replace({ query: s === 'all' ? {} : { scope: s } });
  load();
}
// 从首页或浏览器前进后退切换 scope 时同步列表
watch(
  () => route.query.scope,
  (v) => {
    const s = normalizeScope(v);
    if (s === scope.value) return;
    scope.value = s;
    if (s !== 'all' || !auth.isAdmin) filters.assigneeId = '';
    load();
  },
);

function isOverdue(d: string) {
  return dayjs(d).isBefore(dayjs(), 'day');
}

/** 任务健康度等级与配色（基于 status/dueDate/priority） */
function healthOf(t: any) {
  return taskHealth(t);
}
/** 移动端卡片：左侧健康度色条 + 浅色背景（已完成弱化） */
function cardStyle(t: any) {
  const s = healthStyle(healthOf(t));
  return { borderLeft: `4px solid ${s.bar}`, background: s.bg };
}
/** 桌面表格行：健康度深浅类 + 我的任务标记 */
function rowClass({ row }: any) {
  const hc = healthClass(healthOf(row));
  return row.assigneeId === auth.user?.id ? `mine-row ${hc}` : hc;
}

/** 当前列表归属的人：管理员可选别人，其余情况固定是自己（后端按 assigneeId 取数） */
const viewUser = computed(() => {
  const id = filters.assigneeId || auth.user?.id;
  return users.value.find((u: any) => u.id === id) || auth.user || null;
});
const isMe = computed(() => !filters.assigneeId || filters.assigneeId === auth.user?.id);

/** 按范围过滤：待办=未完成；逾期=未完成且已过截止时间（与首页统计口径一致）；负责人由后端 assigneeId 限定 */
const scopedTasks = computed(() => {
  if (scope.value === 'all') return tasks.value;
  const now = dayjs();
  return tasks.value.filter((t: any) => {
    if (t.status === 'DONE') return false;
    if (scope.value === 'overdue') return !!t.dueDate && dayjs(t.dueDate).isBefore(now);
    return true;
  });
});

/** 单段清单（只装我自己的任务）：按健康度降序、再按截止升序，已完成的沉底 */
const sections = computed(() => {
  const byHealth = (a: any, b: any) => {
    const ha = healthOf(a);
    const hb = healthOf(b);
    if (hb !== ha) return hb - ha; // 健度深（数字大）在前；已完成 -1 在后
    const da = a.dueDate ? dayjs(a.dueDate).valueOf() : Number.MAX_SAFE_INTEGER;
    const db = b.dueDate ? dayjs(b.dueDate).valueOf() : Number.MAX_SAFE_INTEGER;
    return da - db;
  };
  const title =
    scope.value === 'overdue'
      ? '我逾期未完成的任务'
      : scope.value === 'mine'
        ? '我的待办任务'
        : isMe.value
          ? '我的全部任务'
          : `${viewUser.value?.name || '该成员'}的任务`;
  return [{ key: 'mine', title, bar: '#1b4fa8', tasks: [...scopedTasks.value].sort(byHealth) }];
});

/** 只要有一段有任务就不算空（旧写法 every(!length) 名字与语义相反，会在有任务时也把空态文案拼在下面） */
const hasAnyTask = computed(() => sections.value.some((s) => s.tasks.length));

/** 空列表时的引导文案：免得用户以为“项目任务被藏起来了” */
const emptyText = computed(() => {
  if (scope.value === 'overdue') return isMe.value ? '没有逾期未完成的任务' : `${viewUser.value?.name || '该成员'}没有逾期未完成的任务`;
  if (scope.value === 'mine') return isMe.value ? '没有待办任务，休息一下' : `${viewUser.value?.name || '该成员'}没有待办任务`;
  return isMe.value
    ? '暂时没有指派给你的任务；想看所在项目里所有人的任务，请切到「任务看板」'
    : `${viewUser.value?.name || '该成员'}暂时没有任务`;
});

function onResize() {
  isDesktop.value = window.innerWidth >= 768;
}

function openTask(id: string) {
  currentId.value = id;
  drawer.value = true;
}

/** 行内一键完成：二次确认后把状态改为已完成（后端自动置进度 100% 并记录自动活动） */
const completing = ref('');
async function completeTask(row: any) {
  if (!row?.id || row.status === 'DONE' || completing.value) return;
  try {
    await ElMessageBox.confirm(`确认把「${row.title}」标记为已完成？`, '一键完成', {
      type: 'warning',
      confirmButtonText: '确认完成',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  completing.value = row.id;
  try {
    await tasksApi.update(row.id, { status: 'DONE' });
    ElMessage.success('已标记完成');
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '操作失败');
  } finally {
    completing.value = '';
  }
}

async function load() {
  loading.value = true;
  try {
    const params: any = {};
    if (filters.keyword.trim()) params.keyword = filters.keyword.trim();
    if (filters.projectId) params.projectId = filters.projectId;
    if (filters.status) params.status = filters.status;
    // 负责人缺省为自己：任务列表只看本人的任务（管理员在“我的全部”下可切换到别人）
    const assigneeId = filters.assigneeId || auth.user?.id || '';
    if (assigneeId) params.assigneeId = assigneeId;
    tasks.value = await tasksApi.list(params);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('resize', onResize);
  projects.value = await projectsApi.list();
  users.value = await usersApi.list();
  load();
  // 小助手回答里的「打开这条任务」深链：带 open=<id> 进来就直接开抽屉（抽屉自己拉数据，不依赖当前列表）
  const openId = String(route.query.open ?? '');
  if (openId) openTask(openId);
});
// 已在本页时再点助手里的另一条任务链接：组件复用不会重跑 onMounted，靠 watch 拉新抽屉
watch(
  () => route.query.open,
  (v) => {
    const id = String(v ?? '');
    if (id) openTask(id);
  },
);
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<style scoped>
/* 顶部大 tab 与卡内小标题都用全局统一档（styles.css：胶囊页签 + --sp-3 间距），
   这里不再各自覆盖 margin/字号，否则每页差 2px 越久越不齐 */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}
.filters .kw {
  flex: 1;
  min-width: 160px;
}
.filters .sel {
  width: 140px;
}
/* 范围筛选胶囊：与页签 / 切换器同一套胶囊语言（token 见 styles.css :root） */
.scope-tabs {
  flex: 0 0 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.scope-tab {
  border: 1px solid var(--chip-line);
  background: #fff;
  color: var(--chip-ink);
  border-radius: var(--r-md);
  padding: 5px 14px;
  font-size: var(--fs-sm);
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.scope-tab:hover {
  border-color: var(--app-brand-ink);
  color: var(--app-brand-ink);
  background: var(--app-band);
}
.scope-tab.active {
  border-color: transparent;
  background: linear-gradient(135deg, var(--app-brand-ink) 0%, var(--app-heading-2) 100%);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(27, 79, 168, 0.26);
}
/* 口径说明：桌面贴右侧，窄屏自然换行到胶囊下方 */
.scope-hint {
  margin-left: auto;
  font-size: var(--fs-xs);
  line-height: 1.6;
}
.list {
  min-height: 60px;
}
.task {
  padding: 10px 8px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: background 0.15s;
}
.task.mine {
  background: #f0f7ff;
}
.task.mine:hover {
  background: #e6f1fc;
}
.task:last-child {
  border-bottom: none;
}
.task:hover {
  background: #f8fafc;
}
.task-main {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.task-title {
  flex: 1;
  font-size: var(--fs-md);
  font-weight: 500;
}
.task-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
  font-size: var(--fs-xs);
  flex-wrap: wrap;
}
.assignee {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #606266;
}
.proj-tag {
  max-width: 140px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.upd {
  margin-left: auto;
}
.done-btn {
  margin-left: 8px;
}
.tag-row {
  display: flex;
  gap: 4px;
}
.due {
  color: #606266;
  background: #f0f2f5;
  border-radius: 4px;
  padding: 1px 6px;
}
.due.overdue {
  color: #f56c6c;
  background: #fef0f0;
}
.progress {
  width: 80px;
}
.pct {
  min-width: 28px;
}
.empty {
  padding: 20px 0;
  text-align: center;
}
/* 桌面表格：我的任务行高亮 + 单元格样式 */
:deep(.mine-row) {
  background: #f0f7ff;
}
:deep(.mine-row:hover > td) {
  background: #e6f1fc !important;
}
.cell-prog {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.cell-prog .progress {
  flex: 1;
}
.due-cell {
  color: #606266;
}
.due-cell.overdue {
  color: #f56c6c;
}
/* 分段标题：字号 / 徽章均取全局档（卡片内小标题 = 15px/600） */
.section {
  margin-bottom: var(--sp-1);
}
.section + .section {
  margin-top: var(--sp-4);
}
.section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0 var(--sp-3);
}
.section-bar {
  width: 4px;
  height: 15px;
  border-radius: 2px;
}
.section-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: #303133;
}
/* 健康度行配色（蓝色系由浅到深，深=延期/紧迫；已完成弱化） */
:deep(.el-table__row.th-0) > td { background: #f2f8ff; }
:deep(.el-table__row.th-1) > td { background: #e6f1ff; }
:deep(.el-table__row.th-2) > td { background: #d3e6ff; }
:deep(.el-table__row.th-3) > td { background: #c2d7f5; }
:deep(.el-table__row.th-done) > td { background: #f5f6f8; color: #9aa0a6; }
:deep(.el-table__row.th-0) > td:first-child { box-shadow: inset 4px 0 0 #b3d8ff; }
:deep(.el-table__row.th-1) > td:first-child { box-shadow: inset 4px 0 0 #7fb2f0; }
:deep(.el-table__row.th-2) > td:first-child { box-shadow: inset 4px 0 0 #428bff; }
:deep(.el-table__row.th-3) > td:first-child { box-shadow: inset 4px 0 0 #1b4fa8; }
:deep(.el-table__row.th-done) > td:first-child { box-shadow: inset 4px 0 0 #c9ccd1; }
:deep(.el-table__row:hover) > td { background: #ecf3fe !important; }
</style>
