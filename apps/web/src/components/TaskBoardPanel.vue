<template>
  <div v-loading="loading" class="tb-wrap">
    <!-- 全量统计：所有可见任务按状态汇总（口径与任务列表一致：REVIEW 待评审算在「进行中」里） -->
    <div class="page-card tb-sum">
      <div class="tb-sum-item">
        <span class="tb-sum-n">{{ summary.total }}</span>
        <span class="tb-sum-k">全部任务</span>
      </div>
      <div class="tb-sum-item todo">
        <span class="tb-sum-n">{{ summary.todo }}</span>
        <span class="tb-sum-k">待办</span>
      </div>
      <div class="tb-sum-item doing">
        <span class="tb-sum-n">{{ summary.doing }}</span>
        <span class="tb-sum-k">进行中</span>
      </div>
      <div class="tb-sum-item done">
        <span class="tb-sum-n">{{ summary.done }}</span>
        <span class="tb-sum-k">已完成</span>
      </div>
      <div v-if="summary.overdue" class="tb-sum-item over">
        <span class="tb-sum-n">{{ summary.overdue }}</span>
        <span class="tb-sum-k">已逾期（未完成）</span>
      </div>
      <span class="tb-sum-spacer"></span>
      <el-button size="small" :loading="loading" @click="reload">
        <el-icon><Refresh /></el-icon>&nbsp;刷新
      </el-button>
    </div>

    <!-- 项目分布：每个项目一条卡片，直接给出 总数 / 待办 / 进行中 / 已完成 -->
    <div class="page-card">
      <div class="tb-sec-head">
        <span class="tb-sec-title">按项目统计</span>
        <span class="muted tb-sec-sub">共 {{ groups.length }} 个项目 · 点卡片在下方展开任务明细，再点一次收起</span>
      </div>
      <div v-if="!groups.length && !loading" class="muted tb-empty">还没有任何任务</div>
      <div class="tb-cards">
        <button
          v-for="g in groups"
          :key="g.key"
          type="button"
          class="tb-card"
          :class="{ active: g.key === selectedKey }"
          @click="toggle(g.key)"
        >
          <div class="tb-card-top">
            <span class="tb-name" :title="g.name">{{ g.name }}</span>
            <span class="tb-total">{{ g.total }}</span>
          </div>
          <div class="tb-pills">
            <span class="tb-pill todo">待办 <b>{{ g.todo }}</b></span>
            <span class="tb-pill doing">进行中 <b>{{ g.doing }}</b></span>
            <span class="tb-pill done">已完成 <b>{{ g.done }}</b></span>
          </div>
          <div class="tb-bar">
            <i class="s-todo" :style="{ width: pct(g.todo, g.total) }"></i>
            <i class="s-doing" :style="{ width: pct(g.doing, g.total) }"></i>
            <i class="s-done" :style="{ width: pct(g.done, g.total) }"></i>
          </div>
          <div class="tb-card-foot muted">
            <span>完成率 {{ rate(g) }}%</span>
            <span v-if="g.overdue" class="over">逾期 {{ g.overdue }}</span>
          </div>
        </button>
      </div>
    </div>

    <!-- 选中项目：任务明细（按状态分段，不再横向铺三大列） -->
    <div v-if="current" class="page-card tb-detail">
      <div class="tb-detail-head">
        <div class="tb-detail-title">
          <span class="tb-dot"></span>
          <b>{{ current.name }}</b>
          <span class="muted">共 {{ current.total }} 条 · 完成率 {{ rate(current) }}%</span>
          <el-button v-if="current.id" text type="primary" size="small" @click="gotoProject">打开项目 →</el-button>
        </div>
        <div class="tb-chips">
          <button
            v-for="c in chips"
            :key="c.key"
            type="button"
            class="tb-chip"
            :class="[c.key.toLowerCase(), { active: filter === c.key }]"
            @click="filter = c.key"
          >{{ c.label }} {{ c.n }}</button>
        </div>
      </div>

      <div v-for="b in shownBuckets" :key="b.key" class="tb-group">
        <div class="tb-group-head">
          <span class="tb-group-bar" :style="{ background: b.bar }"></span>
          <span class="tb-group-name">{{ b.label }}</span>
          <span class="tb-group-count">{{ b.count }}</span>
          <span v-if="b.key === 'DONE' && b.count > DONE_LIMIT" class="muted tb-group-more">
            <el-button text type="primary" size="small" @click="showAllDone = !showAllDone">
              {{ showAllDone ? '只看最近 20 条' : `展开全部 ${b.count} 条` }}
            </el-button>
          </span>
        </div>

        <template v-if="b.items.length">
          <div class="tb-row head">
            <span class="tb-c-task">任务</span>
            <span class="tb-c-user">负责人</span>
            <span class="tb-c-due">截止</span>
            <span class="tb-c-prog">进度</span>
            <span class="tb-c-upd">更新于</span>
            <span class="tb-c-act">操作</span>
          </div>
          <div
            v-for="t in b.items"
            :key="t.id"
            class="tb-row item"
            :class="{ done: t.status === 'DONE' }"
            @click="emit('open-task', t.id)"
          >
            <div class="tb-c-task">
              <el-tag v-if="t.assigneeId === auth.user?.id" size="small" type="primary" effect="dark" class="mine">我的</el-tag>
              <el-tag size="small" :type="TASK_PRIORITY[t.priority]?.type" effect="plain">{{ TASK_PRIORITY[t.priority]?.label }}</el-tag>
              <span v-if="t.status === 'REVIEW'" class="tb-review">待评审</span>
              <span class="tb-title ellipsis" :title="t.title">{{ t.title }}</span>
              <el-tag v-for="tag in (t.tags || []).slice(0, 2)" :key="tag.id" size="small" type="info" effect="plain">{{ tag.name }}</el-tag>
            </div>
            <span class="tb-c-user" :class="{ muted: !t.assignee }">{{ t.assignee?.name || '未指派' }}</span>
            <span class="tb-c-due">
              <span v-if="t.dueDate" :class="{ over: isOverdue(t) }">{{ fmt(t.dueDate, 'MM-DD HH:mm') }}</span>
              <span v-else class="muted">—</span>
            </span>
            <span class="tb-c-prog" @click.stop>
              <TaskUpdatePopover :task="t" @open="emit('open-task', t.id)">
                <el-progress class="tb-progress" :percentage="t.progress ?? 0" :stroke-width="5" :show-text="false" />
              </TaskUpdatePopover>
              <span class="muted tb-pct">{{ t.progress ?? 0 }}%</span>
            </span>
            <span class="tb-c-upd muted">{{ t.updatedAt ? fmt(t.updatedAt, 'MM-DD HH:mm') : '—' }}</span>
            <span class="tb-c-act" @click.stop>
              <el-button
                v-if="t.status !== 'DONE'"
                text
                type="success"
                size="small"
                :loading="completing === t.id"
                @click="completeTask(t)"
              >完成</el-button>
              <span v-else class="muted tb-done-txt">已完成</span>
            </span>
          </div>
        </template>
        <div v-else class="muted tb-group-empty">该状态暂无任务</div>
      </div>
    </div>
    <div v-else-if="groups.length" class="page-card muted tb-hint">点上面任意项目卡片，在下方展开该项目的任务明细</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { projectsApi, tasksApi } from '../api';
import { TASK_PRIORITY, fmt } from '../utils/format';
import { useAuthStore } from '../stores/auth';
import TaskUpdatePopover from './TaskUpdatePopover.vue';

const emit = defineEmits<{ (e: 'open-task', id: string): void }>();

const auth = useAuthStore();
const router = useRouter();

/** 已完成段默认只渲染最近 20 条，避免历史任务把页面拉太长 */
const DONE_LIMIT = 20;

type BucketKey = 'TODO' | 'DOING' | 'DONE';
const BUCKETS: { key: BucketKey; label: string; bar: string }[] = [
  { key: 'TODO', label: '待办', bar: '#9db7d8' },
  { key: 'DOING', label: '进行中', bar: '#428bff' },
  { key: 'DONE', label: '已完成', bar: '#67c23a' },
];

type Group = {
  key: string;
  id: string;
  name: string;
  total: number;
  todo: number;
  doing: number;
  done: number;
  overdue: number;
  items: any[];
};

const tasks = ref<any[]>([]);
const projects = ref<any[]>([]);
const loading = ref(false);
const selectedKey = ref('');
const showAllDone = ref(false);
/** 明细区状态筛选：ALL=三段全展开（默认），其余只看某一段 */
const filter = ref<'ALL' | BucketKey>('ALL');
const completing = ref('');

/** 状态归并：待评审(REVIEW) 属于「进行中」这一档，与统计口径保持一致 */
function bucketOf(t: any): BucketKey {
  if (t.status === 'DONE') return 'DONE';
  if (t.status === 'IN_PROGRESS' || t.status === 'REVIEW') return 'DOING';
  return 'TODO';
}

function isOverdue(t: any) {
  return !!t.dueDate && t.status !== 'DONE' && dayjs(t.dueDate).isBefore(dayjs());
}

/** 段内排序：未完成按优先级高→低、再按截止近→远；已完成按完成时间新→旧 */
const PRIO_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
function sortItems(list: any[], bucket: BucketKey) {
  if (bucket === 'DONE') {
    return list.sort((a, b) => new Date(b.completedAt || b.updatedAt || 0).getTime() - new Date(a.completedAt || a.updatedAt || 0).getTime());
  }
  return list.sort((a, b) => {
    const pa = PRIO_RANK[a.priority] ?? 9;
    const pb = PRIO_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    const da = a.dueDate ? dayjs(a.dueDate).valueOf() : Number.MAX_SAFE_INTEGER;
    const db = b.dueDate ? dayjs(b.dueDate).valueOf() : Number.MAX_SAFE_INTEGER;
    return da - db;
  });
}

/** 按项目聚合：一个项目一条统计，项目内部保留全部任务（明细点开才渲染） */
const groups = computed<Group[]>(() => {
  const map = new Map<string, Group>();
  for (const t of tasks.value) {
    const key = t.projectId || '__none__';
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        id: t.projectId || '',
        name: t.project?.name || '未归属项目',
        total: 0,
        todo: 0,
        doing: 0,
        done: 0,
        overdue: 0,
        items: [],
      };
      map.set(key, g);
    }
    const b = bucketOf(t);
    g.total += 1;
    if (b === 'TODO') g.todo += 1;
    else if (b === 'DOING') g.doing += 1;
    else g.done += 1;
    if (isOverdue(t)) g.overdue += 1;
    g.items.push(t);
  }
  // 项目顺序：先按「项目」页的既有顺序，未在列表里的（含未归属）排后面
  const order = new Map(projects.value.map((p: any, i: number) => [p.id, i]));
  return [...map.values()].sort((a, b) => {
    const oa = order.has(a.id) ? (order.get(a.id) as number) : 9999;
    const ob = order.has(b.id) ? (order.get(b.id) as number) : 9999;
    if (oa !== ob) return oa - ob;
    return b.total - a.total;
  });
});

const summary = computed(() => {
  const s = { total: 0, todo: 0, doing: 0, done: 0, overdue: 0 };
  for (const g of groups.value) {
    s.total += g.total;
    s.todo += g.todo;
    s.doing += g.doing;
    s.done += g.done;
    s.overdue += g.overdue;
  }
  return s;
});

const current = computed(() => groups.value.find((g) => g.key === selectedKey.value) || null);

const chips = computed(() => {
  const g = current.value;
  if (!g) return [];
  return [
    { key: 'ALL' as const, label: '全部', n: g.total },
    { key: 'TODO' as const, label: '待办', n: g.todo },
    { key: 'DOING' as const, label: '进行中', n: g.doing },
    { key: 'DONE' as const, label: '已完成', n: g.done },
  ];
});

/** 明细段：按筛选裁掉其余状态；已完成段按 DONE_LIMIT 截断 */
const shownBuckets = computed(() => {
  const g = current.value;
  if (!g) return [] as { key: BucketKey; label: string; bar: string; count: number; items: any[] }[];
  return BUCKETS.filter((b) => filter.value === 'ALL' || filter.value === b.key).map((b) => {
    const all = sortItems(g.items.filter((t) => bucketOf(t) === b.key), b.key);
    const items = b.key === 'DONE' && !showAllDone.value ? all.slice(0, DONE_LIMIT) : all;
    return { ...b, count: all.length, items };
  });
});

function pct(n: number, total: number) {
  return total ? `${Math.round((n / total) * 100)}%` : '0%';
}

function rate(g: Group) {
  return g.total ? Math.round((g.done / g.total) * 100) : 0;
}

function toggle(key: string) {
  selectedKey.value = selectedKey.value === key ? '' : key;
  filter.value = 'ALL';
  showAllDone.value = false;
}

function gotoProject() {
  if (current.value?.id) router.push(`/projects/${current.value.id}`);
}

async function completeTask(t: any) {
  if (!t?.id || t.status === 'DONE' || completing.value) return;
  try {
    await ElMessageBox.confirm(`确认把「${t.title}」标记为已完成？`, '一键完成', {
      type: 'warning',
      confirmButtonText: '确认完成',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  completing.value = t.id;
  try {
    await tasksApi.update(t.id, { status: 'DONE' });
    ElMessage.success('已标记完成');
    await reload();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '操作失败');
  } finally {
    completing.value = '';
  }
}

/** 拉全量可见任务 + 项目列表；默认自动展开任务最多的项目，免得空白一片 */
async function reload() {
  loading.value = true;
  try {
    const [ts, ps] = await Promise.all([tasksApi.list(), projectsApi.list()]);
    tasks.value = ts || [];
    projects.value = ps || [];
    // 选中项失效（项目被删/任务清空）时回落到第一个有任务的项目
    if (!groups.value.some((g) => g.key === selectedKey.value)) selectedKey.value = groups.value[0]?.key || '';
  } finally {
    loading.value = false;
  }
}

defineExpose({ reload });

onMounted(reload);
</script>

<style scoped>
.tb-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 120px;
}
/* 顶部汇总条 */
.tb-sum {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 22px;
}
.tb-sum-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.tb-sum-n {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  color: #1b4fa8;
}
.tb-sum-k {
  font-size: 12px;
  color: #7a879c;
}
.tb-sum-item.todo .tb-sum-n { color: #6b7c93; }
.tb-sum-item.doing .tb-sum-n { color: #2f6fe0; }
.tb-sum-item.done .tb-sum-n { color: #4aa832; }
.tb-sum-item.over .tb-sum-n { color: #f56c6c; }
.tb-sum-spacer {
  flex: 1;
}
.tb-sec-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.tb-sec-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}
.tb-sec-sub {
  font-size: 12px;
}
.tb-empty {
  padding: 30px 0;
  text-align: center;
}
/* 项目卡片：一屏看全所有项目的任务量与状态分布 */
.tb-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
  gap: 12px;
}
.tb-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  text-align: left;
  background: #fff;
  border: 1px solid #e3eaf4;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  font: inherit;
}
.tb-card:hover {
  border-color: #9dc0f0;
  box-shadow: 0 3px 12px rgba(27, 79, 168, 0.1);
  transform: translateY(-1px);
}
.tb-card.active {
  border-color: #1b4fa8;
  background: linear-gradient(180deg, #f2f7ff 0%, #ffffff 70%);
  box-shadow: 0 3px 14px rgba(27, 79, 168, 0.16);
}
.tb-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  color: #22314a;
}
.tb-total {
  font-size: var(--fs-xl);
  font-weight: 700;
  color: #1b4fa8;
  line-height: 1;
}
.tb-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.tb-pill {
  padding: 1px 8px;
  border-radius: 999px;
  background: #f2f5fa;
  color: #5a6b82;
}
.tb-pill b {
  font-weight: 700;
}
.tb-pill.todo { background: #f0f3f8; color: #64748b; }
.tb-pill.doing { background: #e9f1ff; color: #2f6fe0; }
.tb-pill.done { background: #eef8e9; color: #4aa832; }
.tb-bar {
  display: flex;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: #f0f3f8;
}
.tb-bar i {
  display: block;
  height: 100%;
}
.tb-bar .s-todo { background: #c3cddb; }
.tb-bar .s-doing { background: #5a92f0; }
.tb-bar .s-done { background: #7ec95f; }
.tb-card-foot {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.tb-card-foot .over {
  color: #f56c6c;
}
/* 明细区 */
.tb-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid #eef2f8;
}
.tb-detail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 15px;
}
.tb-detail-title b {
  color: #22314a;
}
.tb-detail-title .muted {
  font-size: 12px;
}
.tb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #1b4fa8;
}
.tb-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tb-chip {
  padding: 3px 12px;
  font-size: var(--fs-xs);
}
.tb-chip.active {
  font-weight: 600;
}
.tb-group + .tb-group {
  margin-top: var(--sp-4);
}
.tb-group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 10px 0 var(--sp-1);
}
.tb-group-bar {
  width: 4px;
  height: 14px;
  border-radius: 2px;
}
.tb-group-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: #303133;
}
/* 计数徽章统一走 styles.css 的 .tb-group-count / .section-count 全局档 */
.tb-group-more {
  margin-left: auto;
}
.tb-group-empty {
  font-size: 12px;
  padding: 10px 0 4px 12px;
  color: #b6becc;
}
/* 任务行：桌面为六列网格，窄屏自动折成卡片 */
.tb-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 104px 118px 96px 62px;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}
/* 行头：全站轻行头一档（颜色/字号由 styles.css 的 .row-head 同源 token） */
.tb-row.head {
  padding: 5px 10px;
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--row-head-ink);
  background: var(--app-band);
  border-radius: var(--r-sm);
}
.tb-row.item {
  cursor: pointer;
  border-bottom: 1px solid #f7f9fc;
}
.tb-row.item:hover {
  background: #f4f8ff;
}
.tb-row.item.done .tb-title {
  color: #97a1b0;
  text-decoration: line-through;
}
.tb-c-task {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tb-title {
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: #22314a;
}
.tb-c-user {
  font-size: var(--fs-xs);
  color: #4a5a70;
}
.tb-c-due,
.tb-c-upd {
  font-size: 12px;
  color: #6b7c93;
}
.tb-c-due .over {
  color: #f56c6c;
  font-weight: 600;
}
.tb-c-prog {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tb-progress {
  flex: 1;
  min-width: 40px;
  cursor: pointer;
}
.tb-pct {
  min-width: 30px;
  font-size: 12px;
}
.tb-review {
  font-size: var(--fs-2xs);
  color: #e6a23c;
  background: #fdf6ec;
  border-radius: 4px;
  padding: 0 5px;
  line-height: 17px;
}
.mine {
  flex: 0 0 auto;
}
.tb-done-txt {
  font-size: 12px;
}
.tb-hint {
  text-align: center;
  font-size: 13px;
  padding: 26px 0;
}
@media (max-width: 767px) {
  .tb-cards {
    grid-template-columns: 1fr;
  }
  .tb-sum {
    gap: 14px;
  }
  .tb-sum-n {
    font-size: 19px;
  }
  .tb-row.head {
    display: none;
  }
  .tb-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 10px;
    border-bottom: 1px solid #f2f5fa;
  }
  .tb-c-task {
    flex: 0 0 100%;
  }
  .tb-c-upd {
    display: none;
  }
  .tb-c-act {
    margin-left: auto;
  }
  .tb-c-prog {
    width: 78px;
  }
}
</style>
