<template>
  <!-- 部门工作看板：成员完成度/PBC标注 + 三视角任务看板 + 部门工时排行（进部门即看全部工作情况） -->
  <div class="dwb" v-loading="loading">
    <div class="dwb-top">
      <div class="dwb-stats">
        <div class="dwb-stat">
          <span class="lbl">本月 PBC</span>
          <b>{{ pbcApproved }}<i class="sub">/{{ memberCount }} 已通过</i></b>
        </div>
        <div class="dwb-stat">
          <span class="lbl">任务完成率</span>
          <b :class="completionRate >= 70 ? 'c-ok' : completionRate >= 40 ? 'c-mid' : 'c-low'">{{ completionRate }}%</b>
        </div>
        <div class="dwb-stat">
          <span class="lbl">逾期任务</span>
          <b :class="stats?.overdue ? 'c-over' : ''">{{ stats?.overdue ?? 0 }}</b>
        </div>
        <div class="dwb-stat">
          <span class="lbl">本周工时</span>
          <b>{{ stats?.weekHours ?? 0 }}h</b>
        </div>
      </div>
      <el-radio-group v-model="view" size="small">
        <el-radio-button value="person">按人</el-radio-button>
        <el-radio-button value="status">按状态</el-radio-button>
        <el-radio-button value="project">按项目</el-radio-button>
      </el-radio-group>
    </div>

    <div class="dwb-main">
      <div class="dwb-left">
        <!-- 成员任务完成度（横条 + 本周工时 + PBC 行内标注） -->
        <div class="dwb-card">
          <div class="card-title">成员任务完成度</div>
          <div v-for="m in members" :key="m.id" class="mem-row" @click="$router.push('/members/' + m.id)">
            <span class="mem-name">{{ m.name }}</span>
            <div class="mem-bar"><i :class="fillCls(m)" :style="{ width: rateOf(m) + '%' }"></i></div>
            <span class="mem-txt" :class="{ 'c-over': m.overdueCount > 0 }">完成 {{ m.doneCount }}/{{ m.doneCount + m.openCount }}<template v-if="m.overdueCount"> · {{ m.overdueCount }} 逾期</template> · {{ m.weekHours }}h</span>
            <el-tag size="small" :type="pbcTagType(m.pbcStatus)" effect="light" class="mem-pbc">{{ pbcCn(m.pbcStatus) }}</el-tag>
          </div>
          <div v-if="!members.length" class="muted" style="padding: 10px 0;">该部门暂无在职成员</div>
        </div>

        <!-- 部门工时排行（右侧位：本周全公司各部门对比） -->
        <div class="dwb-card">
          <div class="card-title">各部门本周工时排行</div>
          <div v-for="r in ranking" :key="r.id" class="rank-row" :class="{ 'rank-cur': r.id === deptId }">
            <span class="rank-name">{{ r.name }}</span>
            <div class="rank-bar"><i :style="{ width: rankW(r) + '%' }"></i></div>
            <span class="rank-num">{{ r.weekHours }}h · {{ r.memberCount }}人</span>
          </div>
          <div class="rank-tip">口径：成员日报工时按主部门归集，本周一起算</div>
        </div>
      </div>

      <!-- 三视角任务看板 -->
      <div class="dwb-card dwb-board">
        <div class="card-title">
          部门任务看板
          <span class="muted board-sub">{{ viewCn }}视角 · 点卡片看任务详情</span>
        </div>
        <div class="board-grid">
          <div v-for="col in boardCols" :key="col.key" class="board-col">
            <div class="col-head" :class="'col-' + col.key">{{ col.label }} · {{ col.items.length }}</div>
            <div v-for="t in col.items.slice(0, 12)" :key="t.id" class="task-card" :class="'edge-' + cardEdge(t)" @click="$emit('open-task', t.id)">
              <div class="tc-title">{{ t.title }}</div>
              <div class="tc-sub">
                {{ t.assigneeName || '未指派' }}
                <template v-if="t.projectName"> · {{ t.projectName }}</template>
                <template v-if="t.status !== 'DONE' && t.dueDate"> · {{ fmt(t.dueDate, 'MM-DD') }} 到期</template>
                <template v-if="t.overdue"> · <b class="c-over">已逾期</b></template>
                <template v-else-if="t.status === 'IN_PROGRESS'"> · {{ t.progress }}%</template>
              </div>
            </div>
            <div v-if="col.items.length > 12" class="col-more">还有 {{ col.items.length - 12 }} 个…</div>
            <div v-if="!col.items.length" class="col-empty">无</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { departmentsApi } from '../api';
import { fmt } from '../utils/format';

const props = defineProps<{ deptId: string }>();
defineEmits<{ (e: 'open-task', id: string): void }>();

const loading = ref(false);
const board = ref<any>(null);
const view = ref<'person' | 'status' | 'project'>('person');

const members = computed(() => board.value?.members ?? []);
const ranking = computed(() => board.value?.ranking ?? []);
const stats = computed(() => board.value?.stats);
const memberCount = computed(() => members.value.length);
const completionRate = computed(() => board.value?.completionRate ?? 0);
const pbcApproved = computed(() => members.value.filter((m: any) => m.pbcStatus === 'APPROVED').length);
const viewCn = computed(() => ({ person: '按人', status: '按状态', project: '按项目' }[view.value]));

/** 全部门任务池（按人聚合行展开），三视角共用 */
const allTasks = computed(() =>
  members.value.flatMap((m: any) => (m.tasks ?? []).map((t: any) => ({ ...t, assigneeName: m.name }))),
);

const boardCols = computed(() => {
  if (view.value === 'status') {
    return [
      { key: 'over', label: '已逾期', items: allTasks.value.filter((t: any) => t.overdue) },
      { key: 'doing', label: '进行中', items: allTasks.value.filter((t: any) => !t.overdue && t.status === 'IN_PROGRESS') },
      { key: 'todo', label: '待办', items: allTasks.value.filter((t: any) => !t.overdue && t.status === 'TODO') },
      { key: 'done', label: '已完成', items: allTasks.value.filter((t: any) => t.status === 'DONE') },
    ];
  }
  if (view.value === 'project') {
    const byProj = new Map<string, any[]>();
    for (const t of allTasks.value) {
      const k = t.projectName || '未归属项目';
      if (!byProj.has(k)) byProj.set(k, []);
      byProj.get(k)!.push(t);
    }
    return [...byProj.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, items]) => ({ key: name, label: name, items }));
  }
  return members.value
    .filter((m: any) => (m.tasks ?? []).length)
    .map((m: any) => ({ key: m.id, label: m.name, items: m.tasks.map((t: any) => ({ ...t, assigneeName: m.name })) }));
});

function cardEdge(t: any) {
  if (t.overdue) return 'over';
  if (t.status === 'DONE') return 'done';
  if (t.status === 'IN_PROGRESS') return 'doing';
  return 'todo';
}

function rateOf(m: any) {
  const total = (m.doneCount ?? 0) + (m.openCount ?? 0);
  return total ? Math.round(((m.doneCount ?? 0) / total) * 100) : 0;
}
function fillCls(m: any) {
  if ((m.overdueCount ?? 0) > 0) return 'fill-over';
  const r = rateOf(m);
  return r >= 70 ? 'fill-ok' : r >= 40 ? 'fill-mid' : 'fill-low';
}
function pbcCn(s: string | null) {
  return s === 'APPROVED' ? 'PBC 已通过' : s === 'SUBMITTED' ? '待审批' : s === 'REJECTED' ? '已退回' : '未提交';
}
function pbcTagType(s: string | null) {
  return s === 'APPROVED' ? 'success' : s === 'SUBMITTED' ? 'warning' : s === 'REJECTED' ? 'danger' : 'info';
}
function rankW(r: any) {
  const max = Math.max(1, ...ranking.value.map((x: any) => x.weekHours || 0));
  return Math.max(4, Math.round(((r.weekHours || 0) / max) * 100));
}

async function load() {
  loading.value = true;
  try {
    board.value = await departmentsApi.deptBoard(props.deptId);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载部门工作看板失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.dwb { display: flex; flex-direction: column; gap: 12px; }
.dwb-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dwb-stats { display: flex; gap: 12px; flex-wrap: wrap; }
.dwb-stat { background: var(--el-fill-color-light); border-radius: 8px; padding: 8px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 110px; }
.dwb-stat .lbl { font-size: 12px; color: var(--el-text-color-secondary); }
.dwb-stat b { font-size: 20px; font-weight: 500; }
.dwb-stat b .sub { font-size: 12px; font-style: normal; color: var(--el-text-color-secondary); font-weight: 400; }
.dwb-stat b.c-ok { color: var(--el-color-success); }
.dwb-stat b.c-mid { color: var(--el-color-primary); }
.dwb-stat b.c-low { color: var(--el-color-warning); }
.dwb-stat b.c-over { color: var(--el-color-danger); }
.dwb-top .el-radio-group { margin-left: auto; }
.dwb-main { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 12px; align-items: start; }
.dwb-left { display: flex; flex-direction: column; gap: 12px; }
.dwb-card { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 12px 14px; }
.card-title { font-size: 13px; font-weight: 500; color: var(--el-text-color-primary); margin-bottom: 10px; }
.board-sub { font-weight: 400; font-size: 12px; margin-left: 6px; }
.mem-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer; }
.mem-row:hover .mem-name { color: var(--el-color-primary); }
.mem-name { width: 60px; font-size: 13px; color: var(--el-text-color-primary); flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mem-bar { flex: 1; height: 8px; background: var(--el-fill-color); border-radius: 4px; overflow: hidden; }
.mem-bar i { display: block; height: 100%; border-radius: 4px; }
.fill-ok { background: var(--el-color-success); }
.fill-mid { background: var(--el-color-primary); }
.fill-low { background: var(--el-color-warning); }
.fill-over { background: var(--el-color-danger); }
.mem-txt { flex-shrink: 0; font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.mem-pbc { flex-shrink: 0; }
.rank-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.rank-row.rank-cur .rank-name { color: var(--el-color-primary); font-weight: 500; }
.rank-name { width: 96px; font-size: 12px; color: var(--el-text-color-regular); flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rank-bar { flex: 1; height: 10px; background: var(--el-fill-color); border-radius: 5px; overflow: hidden; }
.rank-bar i { display: block; height: 100%; background: var(--el-color-primary-light-5); border-radius: 5px; }
.rank-num { flex-shrink: 0; width: 96px; text-align: right; font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.rank-tip { font-size: 11px; color: var(--el-text-color-tertiary); margin-top: 8px; }
.board-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.board-col { min-width: 0; }
.col-head { font-size: 12px; color: var(--el-text-color-secondary); padding: 4px 8px; border-radius: 6px; background: var(--el-fill-color-light); margin-bottom: 8px; }
.col-over { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.col-doing { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.col-todo { background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
.col-done { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.task-card { border: 1px solid var(--el-border-color-lighter); border-left-width: 3px; border-radius: 8px; padding: 7px 10px; margin-bottom: 6px; cursor: pointer; }
.task-card:hover { background: var(--el-fill-color-lighter); }
.edge-over { border-left-color: var(--el-color-danger); }
.edge-doing { border-left-color: var(--el-color-primary); }
.edge-todo { border-left-color: var(--el-border-color-darker); }
.edge-done { border-left-color: var(--el-color-success); opacity: 0.72; }
.tc-title { font-size: 12px; color: var(--el-text-color-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-sub { font-size: 11px; color: var(--el-text-color-secondary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-more { font-size: 12px; color: var(--el-text-color-tertiary); padding: 2px 0; }
.col-empty { font-size: 12px; color: var(--el-text-color-tertiary); }
.c-over { color: var(--el-color-danger); }
</style>
