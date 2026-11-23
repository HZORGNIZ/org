<template>
  <!-- 成员任务总览：按部门手风琴分组，全员任务/完成度/本周工时/本月PBC（管理员看全部；负责人/共管人限本部门） -->
  <div class="mto" v-loading="loading">
    <div class="mto-totals">
      <div class="mto-total"><span class="lbl">在职成员</span><b>{{ ov?.totals?.members ?? 0 }}</b></div>
      <div class="mto-total"><span class="lbl">进行中任务</span><b class="c-open">{{ ov?.totals?.open ?? 0 }}</b></div>
      <div class="mto-total"><span class="lbl">已逾期</span><b class="c-over">{{ ov?.totals?.overdue ?? 0 }}</b></div>
      <div class="mto-total"><span class="lbl">本周工时</span><b>{{ ov?.totals?.weekHours ?? 0 }}h</b></div>
      <div class="mto-ops">
        <el-button size="small" text type="primary" @click="expandAll(true)">全部展开</el-button>
        <el-button size="small" text @click="expandAll(false)">全部收起</el-button>
      </div>
    </div>

    <el-empty v-if="!loading && !ov?.depts?.length" description="暂无可管辖的部门数据" />

    <div v-for="(d, di) in ov?.depts ?? []" :key="d.id" class="mto-dept">
      <div class="mto-dept-head" @click="toggle(d.id)">
        <span class="tri">{{ expanded.has(d.id) ? '▾' : '▸' }}</span>
        <span class="dept-name">{{ d.name }}</span>
        <span class="dept-sum">
          {{ d.memberCount }}人 · <b class="c-open">{{ d.stats.open }}</b> 进行中
          <template v-if="d.stats.overdue"> · <b class="c-over">{{ d.stats.overdue }} 个逾期</b></template>
          · 本周 {{ d.stats.weekHours }}h
        </span>
        <span class="dept-rate">完成率 {{ d.completionRate }}%</span>
      </div>

      <div v-if="expanded.has(d.id)" class="mto-body">
        <div v-for="m in d.members" :key="m.id" class="mto-row" :class="{ 'row-over': m.overdueCount > 0 }">
          <div class="mto-user" @click="goMember(m.id)">
            <span class="avatar">{{ (m.name || '?').slice(-2).slice(0, 1) }}</span>
            <span class="uname">{{ m.name }}</span>
            <el-tag v-if="m.pbcStatus === 'APPROVED'" size="small" type="success" effect="light" class="pbc-tag">PBC 已通过</el-tag>
            <el-tag v-else-if="m.pbcStatus === 'SUBMITTED'" size="small" type="warning" effect="light" class="pbc-tag">PBC 待审批</el-tag>
            <el-tag v-else-if="m.pbcStatus === 'REJECTED'" size="small" type="danger" effect="light" class="pbc-tag">PBC 已退回</el-tag>
            <el-tag v-else size="small" type="info" effect="plain" class="pbc-tag">PBC 未提交</el-tag>
          </div>

          <div class="mto-tasks">
            <div v-for="t in m.tasks.slice(0, taskLimit)" :key="t.id" class="task-line" @click="emit('open-task', t.id)">
              <span class="st" :class="'st-' + (t.overdue ? 'over' : t.status.toLowerCase())">{{ t.overdue ? '逾期' : stCn(t.status) }}</span>
              <span class="t-title" :class="{ 't-done': t.status === 'DONE' }">{{ t.title }}</span>
              <span v-if="t.project?.name" class="t-proj">{{ t.project.name }}</span>
              <span v-if="t.dueDate && t.status !== 'DONE'" class="t-due" :class="{ 't-due-over': t.overdue }">{{ fmt(t.dueDate, 'MM-DD') }} 到期</span>
            </div>
            <div v-if="m.tasks.length > taskLimit" class="task-more" @click.stop="emit('open-member', m.id)">
              还有 {{ m.tasks.length - taskLimit }} 个任务（含已完成）
            </div>
            <div v-if="!m.tasks.length" class="task-none">暂无任务</div>
          </div>

          <div class="mto-progress">
            <div class="bar"><i :class="rateCls(m)" :style="{ width: rateOf(m) + '%' }"></i></div>
            <span class="bar-txt">完成 {{ m.doneCount }}/{{ m.doneCount + m.openCount }}</span>
          </div>
          <span class="mto-hours">本周 {{ m.weekHours }}h</span>
        </div>
        <div v-if="!d.members.length" class="task-none" style="padding: 10px 14px;">本部门暂无在职成员</div>
      </div>
    </div>

    <div v-if="ov?.ranking?.length" class="mto-rank">
      <span class="rank-title">各部门本周工时排行</span>
      <div v-for="r in ov.ranking" :key="r.id" class="rank-row">
        <span class="rank-name">{{ r.name }}</span>
        <div class="rank-bar"><i :style="{ width: rankW(r) + '%' }"></i></div>
        <span class="rank-num">{{ r.weekHours }}h · {{ r.memberCount }}人</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { departmentsApi } from '../api';
import { fmt } from '../utils/format';

const emit = defineEmits<{ (e: 'open-task', id: string): void; (e: 'open-member', id: string): void }>();

const router = useRouter();
const loading = ref(false);
const ov = ref<any>(null);
const taskLimit = 3;
const expanded = reactive(new Set<string>());

const ST_CN: Record<string, string> = { TODO: '待办', IN_PROGRESS: '进行', DONE: '完成' };
function stCn(s: string) { return ST_CN[s] ?? s; }

async function load() {
  loading.value = true;
  try {
    ov.value = await departmentsApi.taskOverview();
    // 默认展开第一个部门（已按逾期数排序，最需要关注的在最上）
    if (ov.value?.depts?.length) expanded.add(ov.value.depts[0].id);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载成员任务总览失败');
  } finally {
    loading.value = false;
  }
}

function toggle(id: string) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}
function expandAll(on: boolean) {
  expanded.clear();
  if (on) for (const d of ov.value?.depts ?? []) expanded.add(d.id);
}

function rateOf(m: any) {
  const total = (m.doneCount ?? 0) + (m.openCount ?? 0);
  return total ? Math.round(((m.doneCount ?? 0) / total) * 100) : 0;
}
function rateCls(m: any) {
  const r = rateOf(m);
  if ((m.overdueCount ?? 0) > 0) return 'fill-over';
  return r >= 70 ? 'fill-ok' : r >= 40 ? 'fill-mid' : 'fill-low';
}
function rankW(r: any) {
  const max = Math.max(1, ...(ov.value?.ranking ?? []).map((x: any) => x.weekHours || 0));
  return Math.max(4, Math.round(((r.weekHours || 0) / max) * 100));
}

function goMember(id: string) {
  router.push(`/members/${id}`);
}

onMounted(load);
</script>

<style scoped>
.mto { display: flex; flex-direction: column; gap: 12px; }
.mto-totals { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.mto-total { background: var(--el-fill-color-light); border-radius: 8px; padding: 8px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 96px; }
.mto-total .lbl { font-size: 12px; color: var(--el-text-color-secondary); }
.mto-total b { font-size: 20px; font-weight: 500; }
.mto-total b.c-open { color: var(--el-color-primary); }
.mto-total b.c-over { color: var(--el-color-danger); }
.mto-ops { margin-left: auto; }
.mto-dept { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; overflow: hidden; }
.mto-dept-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--el-fill-color-light); cursor: pointer; user-select: none; }
.mto-dept-head:hover { background: var(--el-fill-color); }
.tri { font-size: 12px; color: var(--el-text-color-secondary); }
.dept-name { font-size: 14px; color: var(--el-text-color-primary); font-weight: 500; }
.dept-sum { font-size: 12px; color: var(--el-text-color-secondary); }
.dept-sum b.c-open { color: var(--el-color-primary); font-weight: 500; }
.dept-sum b.c-over { color: var(--el-color-danger); font-weight: 500; }
.dept-rate { margin-left: auto; font-size: 12px; color: var(--el-text-color-tertiary); }
.mto-body { border-top: 1px solid var(--el-border-color-lighter); }
.mto-row { display: grid; grid-template-columns: 190px minmax(0, 1fr) 170px 76px; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px dashed var(--el-border-color-lighter); }
.mto-row:last-child { border-bottom: none; }
.mto-row.row-over { background: var(--el-color-danger-light-9); }
.mto-user { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.mto-user:hover .uname { color: var(--el-color-primary); }
.avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--el-color-primary-light-8); color: var(--el-color-primary); font-size: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.uname { font-size: 13px; color: var(--el-text-color-primary); white-space: nowrap; }
.pbc-tag { flex-shrink: 0; }
.mto-tasks { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.task-line { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; min-width: 0; }
.task-line:hover .t-title { color: var(--el-color-primary); }
.st { flex-shrink: 0; font-size: 11px; border-radius: 4px; padding: 1px 6px; background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.st-todo { background: var(--el-fill-color); color: var(--el-text-color-secondary); }
.st-in_progress { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.st-done { background: var(--el-color-success-light-9); color: var(--el-color-success); }
.st-over { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.t-title { color: var(--el-text-color-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.t-done { color: var(--el-text-color-secondary); text-decoration: line-through; }
.t-proj { flex-shrink: 0; font-size: 11px; color: var(--el-text-color-secondary); background: var(--el-fill-color-light); border-radius: 4px; padding: 1px 6px; }
.t-due { flex-shrink: 0; font-size: 11px; color: var(--el-text-color-secondary); }
.t-due-over { color: var(--el-color-danger); }
.task-more { font-size: 12px; color: var(--el-color-primary); cursor: pointer; padding-top: 2px; }
.task-none { font-size: 12px; color: var(--el-text-color-tertiary); }
.mto-progress { display: flex; flex-direction: column; gap: 3px; }
.bar { height: 6px; background: var(--el-fill-color); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 4px; }
.fill-ok { background: var(--el-color-success); }
.fill-mid { background: var(--el-color-primary); }
.fill-low { background: var(--el-color-warning); }
.fill-over { background: var(--el-color-danger); }
.bar-txt { font-size: 11px; color: var(--el-text-color-secondary); }
.mto-hours { font-size: 12px; color: var(--el-text-color-secondary); text-align: right; font-variant-numeric: tabular-nums; }
.mto-rank { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 12px 14px; }
.rank-title { font-size: 13px; font-weight: 500; color: var(--el-text-color-primary); display: block; margin-bottom: 8px; }
.rank-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.rank-name { width: 110px; font-size: 12px; color: var(--el-text-color-regular); flex-shrink: 0; }
.rank-bar { flex: 1; height: 10px; background: var(--el-fill-color); border-radius: 5px; overflow: hidden; }
.rank-bar i { display: block; height: 100%; background: var(--el-color-primary-light-5); border-radius: 5px; }
.rank-num { width: 110px; text-align: right; font-size: 12px; color: var(--el-text-color-secondary); flex-shrink: 0; font-variant-numeric: tabular-nums; }
</style>
