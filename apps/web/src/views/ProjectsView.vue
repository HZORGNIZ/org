<template>
  <div class="page">
    <div class="page-title">
      项目
      <el-button type="primary" @click="openCreateDialog">
        <el-icon><Plus /></el-icon>&nbsp;新建项目
      </el-button>
    </div>

    <div class="view-tabs">
      <el-radio-group v-model="viewMode" size="small" @change="onViewChange">
        <el-radio-button value="active">进行中</el-radio-button>
        <el-radio-button v-if="pendingCount > 0" value="pending">待我审批（{{ pendingCount }}）</el-radio-button>
        <el-radio-button v-if="myAppCount > 0" value="mine">我的申请（{{ myAppCount }}）</el-radio-button>
        <el-radio-button value="archived">已存档（{{ archivedCount }}）</el-radio-button>
        <el-radio-button v-if="auth.isAdmin" value="trash">回收站</el-radio-button>
      </el-radio-group>
      <!-- 全局模糊搜索：项目名 / 描述 / 部门名 / 成员姓名（前端内存过滤） -->
      <el-input v-model="searchKw" class="proj-search" size="small" clearable :prefix-icon="Search" placeholder="搜索项目名 / 描述 / 成员姓名…" />
    </div>

    <!-- 顶部快捷导航：部门 chips + 项目迷你卡（点击定位到下方完整卡片并高亮），原卡片样式不动 -->
    <div v-if="showSide && sideItems.length > 1" class="qnav">
      <div class="qn-row">
        <span
          v-for="it in sideItems"
          :key="it.key"
          class="qn-chip"
          :class="{ on: !searching && sideFilter === it.key }"
          @click="pickSide(it.key)"
        >{{ it.name }}<b>{{ it.count }}</b></span>
      </div>
      <div v-if="quickProjects.length" class="qn-row qn-projs">
        <span
          v-for="p in quickProjects"
          :key="p.id"
          class="qn-proj"
          :title="`定位到「${p.name}」`"
          @click="locateProject(p)"
        >
          <i class="qn-dot" :style="{ background: p.color || '#428bff' }"></i>
          <span class="ellipsis">{{ p.name }}</span>
        </span>
      </div>
    </div>

    <!-- 顶部轻量统计：进行中视图展示（只统计当前成员可见的项目） -->
    <div v-if="viewMode === 'active' && projects.length" class="proj-stats">
      <span class="ps-item"><b>{{ projects.length }}</b> 个项目</span>
      <span class="ps-divider"></span>
      <span v-for="(cnt, name) in deptStats" :key="name" class="ps-item">{{ name }} <b>{{ cnt }}</b></span>
      <span class="ps-divider"></span>
      <span class="ps-item"><b>{{ totalTasks }}</b> 个任务</span>
      <span class="ps-item"><b>{{ totalMembers }}</b> 名成员</span>
    </div>

    <div v-loading="loading" class="grid">
      <!-- 项目列表统一按部门归类：每行一组（组头占满整行栅格），项目归入其「主部门」（组织架构里排最前的关联部门），
           未关联任何部门的归入「未归类」沉底；回收站为管理视图，保持平铺不再分组 -->
      <template v-for="g in displayGroups" :key="g.title || '_all'">
      <div v-if="g.title" class="dept-group-head">
        <span class="dept-group-name">{{ g.title }}</span>
        <span class="muted">{{ g.projects.length }} 个项目</span>
      </div>
      <div v-for="p in g.projects" :id="`qcard-${p.id}`" :key="p.id" class="project-card" :class="{ flash: flashId === p.id }" @click="goDetail(p)">
        <div class="proj-head">
          <div class="proj-color" :style="{ background: p.color || '#428bff' }"></div>
          <span class="proj-name ellipsis">{{ p.name }}</span>
          <!-- 保密项目：锁标记；自己未签署保密协议时额外提示待签（点进去会被协议遮罩拦住） -->
          <el-tag v-if="p.confidential" size="small" type="danger" effect="plain" class="status-tag">🔒 保密</el-tag>
          <el-tag v-if="p.confidential && p.ndaSigned === false" size="small" type="warning" effect="plain" class="status-tag">待签协议</el-tag>
          <el-tag v-if="p.status === 'PENDING'" size="small" type="warning" effect="plain" class="status-tag">待审批</el-tag>
          <el-tag v-else-if="p.status === 'REJECTED'" size="small" type="danger" effect="plain" class="status-tag">已驳回</el-tag>
        </div>
        <div v-if="p.departments?.length" class="proj-dept muted">{{ p.departments.map((d: any) => d.name).join('、') }}</div>
        <div class="proj-desc ellipsis-2">{{ p.description || '暂无描述' }}</div>
        <div class="proj-meta muted">
          <span>{{ p._count?.tasks || 0 }} 个任务</span>
          <span>{{ p.memberCount ?? (p.members?.length || 0) }} 名成员</span>
          <span>{{ p.owner?.name }}</span>
          <span v-if="viewMode === 'active' && p.lastActivityAt">· 更新于 {{ relDate(p.lastActivityAt) }}</span>
        </div>
        <!-- 搜索命中原因小标签（项目名/描述/部门/成员 张三） -->
        <div v-if="searching && searchHits.get(p.id)" class="proj-hit">{{ searchHits.get(p.id) }}</div>
        <!-- 最新一条项目纪要（点击跳详情页纪要区）；无纪要时灰显提示 -->
        <div v-if="viewMode === 'active' && p.latestNote" class="proj-note" :title="`最新纪要：${p.latestNote.title}（${noteLabel(p.latestNote.kind)}，${p.latestNote.authorName || ''} 发布）`">
          <el-tag size="small" :type="noteTag(p.latestNote.kind)" effect="light">{{ noteLabel(p.latestNote.kind) }}</el-tag>
          <span class="pn-title ellipsis">{{ p.latestNote.title }}</span>
          <span class="muted pn-time">{{ relDate(p.latestNote.publishedAt) }}</span>
        </div>
        <div v-else-if="viewMode === 'active'" class="proj-note muted">📋 暂无纪要</div>
        <div v-if="viewMode === 'trash'" class="archived-foot">
          <el-button size="small" type="primary" plain :loading="restoringId === p.id" @click.stop="restoreFromTrash(p)">恢复</el-button>
          <el-button size="small" type="danger" plain :loading="purgingId === p.id" @click.stop="purgeForever(p)">彻底删除</el-button>
          <span class="muted">已删除·在回收站{{ p.deletedAt ? ' · ' + fmtDate(p.deletedAt) : '' }}</span>
        </div>
        <div v-else-if="viewMode === 'archived'" class="archived-foot">
          <el-button size="small" type="primary" plain :loading="restoringId === p.id" @click.stop="restore(p)">
            恢复开发
          </el-button>
          <span class="muted">存档中·不显示在首页与进行中列表</span>
        </div>
        <div v-else-if="viewMode === 'pending'" class="archived-foot">
          <el-button size="small" type="primary" :loading="false" @click.stop="goDetail(p)">去审批</el-button>
          <span class="muted">提交时间：{{ fmtDate(p.approvalSubmittedAt) }} · {{ p.skipRequirementDoc ? '已确认不需要需求文档' : p.requirementDocIds?.length ? '已传需求文档' : '尚未上传需求文档' }} · {{ p.skipMilestone ? '已确认不需要里程碑' : (p.milestones?.length ? '已有里程碑' : '尚无里程碑') }}</span>
        </div>
        <div v-else-if="viewMode === 'mine'" class="archived-foot">
          <el-button size="small" type="primary" plain @click.stop="goDetail(p)">查看详情</el-button>
          <span class="muted">{{ p.status === 'REJECTED' ? '已驳回：' + (p.approvalNote || '无意见') : '等待审批：' + (p.approver?.name || '未指定') }}</span>
        </div>
        <!-- 与首页一致：每条进展以消息日简写开头、绿色逐行展示；当天高亮；已转任务的条目蓝色显示并带徽标；点击条目弹出「从进展创建任务」；同项目内可拖拽（移动端长按）到另一条进展上合并 -->
        <div v-else-if="p.updates?.length" class="upd-list">
          <div
            v-for="u in p.updates"
            :key="u.id"
            class="upd-item"
            :class="{ fresh: isUpdateToday(u), converted: !!u.taskId, dragging: merge.isDragging(u), 'drag-over': merge.isDragOver(u) }"
            :title="u.taskId ? '已转为任务 · 点击可再次创建/关联：' + u.content : '从进展创建任务：' + u.content"
            :draggable="!isTouchDevice"
            :data-merge-key="u.id"
            @click.stop="openConvertFromProgress(p, u)"
            @dragstart="merge.onDragStart($event, u)"
            @dragover="merge.onDragOver($event, u)"
            @dragleave="merge.onDragLeave(u)"
            @drop="merge.onDrop($event, u)"
            @dragend="merge.onDragEnd()"
            @touchstart="merge.onTouchStart($event, u)"
            @touchmove="merge.onTouchMove($event)"
            @touchend="merge.onTouchEnd()"
            @touchcancel="merge.onTouchCancel()"
          >
            <span class="upd-date">{{ updateDate(u) }}</span>
            <span class="upd-text">{{ u.content }}</span>
            <span v-if="u.taskId" class="upd-conv">已转任务</span>
          </div>
        </div>
        <div v-else-if="viewMode === 'active'" class="muted upd-empty">暂无进展</div>
      </div>
      </template>
      <div v-if="!projects.length && !loading" class="muted empty">{{ viewMode === 'archived' ? '没有已存档的项目' : viewMode === 'trash' ? '回收站为空' : '还没有项目，点击右上角创建' }}</div>
      <div v-else-if="loading === false && projects.length && !listTotal" class="muted empty">{{ searching ? '无匹配项目，换个关键词试试' : '该部门下暂无项目' }}</div>
    </div>

    <!-- 新建项目 -->
    <el-dialog v-model="showCreate" title="新建项目" width="min(92vw, 480px)">
      <el-form label-position="top">
        <el-form-item label="项目名称" required>
          <el-input v-model="createForm.name" maxlength="50" placeholder="如：官网改版" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="主题色">
          <el-color-picker v-model="createForm.color" />
        </el-form-item>
        <el-form-item label="主要关联部门（可多个）">
          <el-select v-model="createForm.departmentIds" multiple collapse-tags placeholder="选择部门（可选）" style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联钉钉群（可选，AI 从此群自动总结项目进展）">
          <div class="group-resolve">
            <el-input
              v-model="createForm.dingtalkGroupName"
              placeholder="填写钉钉群名称"
              clearable
              :disabled="!!createForm.dingtalkConversationId"
            >
              <template #append>
                <el-button :loading="resolvingGroup" @click="resolveGroup">验证并关联</el-button>
              </template>
            </el-input>
          </div>
          <div v-if="createForm.dingtalkConversationId" class="muted group-hint">
            已关联：{{ createForm.dingtalkGroupName }}
            <el-link type="danger" @click="unlinkGroup">取消关联</el-link>
          </div>
          <div v-else class="muted group-hint">填写群名并验证，群存在才可关联；请确认 dws 账号/机器人已在该群</div>
        </el-form-item>
        <el-form-item label="计划开始日" required>
          <el-date-picker v-model="createForm.startDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
        </el-form-item>
        <el-form-item label="计划交付日" required>
          <el-date-picker v-model="createForm.endDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
        </el-form-item>
        <el-form-item required>
          <template #label>
            <span>里程碑</span>
            <el-checkbox v-model="createForm.skipMilestone" class="skip-check">本项目确定不需要里程碑</el-checkbox>
          </template>
          <template v-if="!createForm.skipMilestone">
            <div v-if="!createForm.milestones.length" class="muted" style="margin-bottom: 6px">尚未添加里程碑（必填，至少一个）</div>
            <div v-for="(ms, i) in createForm.milestones" :key="i" class="ms-row">
              <el-input v-model="ms.name" placeholder="里程碑名称" size="small" style="flex: 2" />
              <el-date-picker v-model="ms.dueDate" type="date" value-format="YYYY-MM-DD" placeholder="到期日" size="small" style="flex: 1.4" />
              <el-button size="small" type="danger" plain @click="removeMilestone(i)">删除</el-button>
            </div>
            <el-button size="small" style="margin-top: 6px" @click="addMilestone">＋ 添加里程碑</el-button>
          </template>
          <div v-else class="muted skip-hint">已确认本项目不需要里程碑，审批人将看到该确认结果</div>
        </el-form-item>
        <el-form-item required>
          <template #label>
            <span>项目需求文档</span>
            <el-checkbox v-model="createForm.skipRequirementDoc" class="skip-check">本项目确定不需要需求文档</el-checkbox>
          </template>
          <template v-if="!createForm.skipRequirementDoc">
            <input ref="reqDocInputRef" id="req-doc-input" type="file" multiple style="display: none" @change="onPickDocs" />
            <div class="doc-picker">
              <el-button size="small" @click="pickDocs">选择文件</el-button>
              <span v-if="!reqDocFiles.length" class="muted">尚未选择（必填，至少一份）</span>
              <el-button v-else text type="danger" size="small" @click="clearDocs">清空</el-button>
            </div>
            <ul v-if="reqDocFiles.length" class="doc-list muted">
              <li v-for="(f, i) in reqDocFiles" :key="i">{{ f.name }} <span class="muted">({{ Math_ceil(f.size / 1024) }} KB)</span></li>
            </ul>
          </template>
          <div v-else class="muted skip-hint">已确认本项目不需要需求文档，审批人将看到该确认结果</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建并提交审批</el-button>
      </template>
    </el-dialog>

    <!-- 从进展创建/关联任务（与首页共用组件；点击绿色进展条目打开） -->
    <ConvertTaskDialog
      v-model="convertVisible"
      :project="convertProject"
      :update="convertUpdate"
      :source-text="convertSourceText"
      @saved="load"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { projectsApi, departmentsApi, documentsApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { isUpdateToday, updateDate } from '../utils/format';
import { isTouchDevice, useUpdateMerge } from '../utils/useUpdateMerge';
import ConvertTaskDialog from '../components/ConvertTaskDialog.vue';

const router = useRouter();
const auth = useAuthStore();
const projects = ref<any[]>([]);
const loading = ref(false);
const departments = ref<any[]>([]);
// 部门 chips 选中（按主部门名过滤，'' = 全部；搜索生效时忽略）
const sideFilter = ref('');
// 全局模糊搜索关键词：项目名 / 描述 / 部门名 / 成员姓名
const searchKw = ref('');
// 快捷定位：点顶部迷你卡后滚动到对应完整卡片并短暂高亮
const flashId = ref('');
// 视图：进行中 / 待我审批 / 我的申请 / 已存档 / 回收站（后三者均不显示在首页与进行中列表）
const viewMode = ref<'active' | 'pending' | 'mine' | 'archived' | 'trash'>('active');
const archivedCount = ref(0);
const pendingCount = ref(0);
const myAppCount = ref(0);
const restoringId = ref('');
const purgingId = ref('');

const showCreate = ref(false);
const creating = ref(false);
const resolvingGroup = ref(false);
const createForm = reactive({
  name: '',
  description: '',
  color: '#428bff',
  departmentIds: [] as string[],
  dingtalkConversationId: '',
  dingtalkGroupName: '',
  startDate: '',
  endDate: '',
  milestones: [] as { name: string; dueDate: string; description?: string }[],
  skipMilestone: false,
  skipRequirementDoc: false,
});
// 需求文档（待上传）：前端先收集 File 对象，创建后以 documentsApi.upload 逐个上传到项目空间
const reqDocFiles = ref<File[]>([]);
const reqDocInputRef = ref<HTMLInputElement | null>(null);

/** 参与筛选的底表：搜索生效时只保留命中的项目（跨部门），否则全量 */
const searching = computed(() => searchKw.value.trim().length > 0);

/** 搜索命中原因表（projectId → 命中原因文案），卡片上标注便于确认为什么被搜出 */
const searchHits = computed(() => {
  const kw = searchKw.value.trim().toLowerCase();
  const m = new Map<string, string>();
  if (!kw) return m;
  for (const p of projects.value) {
    const hits: string[] = [];
    if ((p.name || '').toLowerCase().includes(kw)) hits.push('项目名');
    if ((p.description || '').toLowerCase().includes(kw)) hits.push('描述');
    const deptNames: string[] = (p.departments || []).map((d: any) => d?.name || '');
    if (deptNames.some((n) => n.toLowerCase().includes(kw))) hits.push('部门');
    const names = (p.members || []).map((mm: any) => mm?.user?.name || '').filter(Boolean);
    const hitMembers = names.filter((n: string) => n.toLowerCase().includes(kw));
    if (hitMembers.length) hits.push(`成员 ${hitMembers.join('、')}`);
    if (hits.length) m.set(p.id, hits.join(' · '));
  }
  return m;
});

/** 视图底表：以前按部门下拉（deptFilter by id）筛，现由左侧导航/搜索接管，直接取全量 */
const shownProjects = computed(() => projects.value);

/** 顶部快捷导航显示条件：进行中 / 已存档（pending/mine 少量平铺，trash 为管理视图不分组） */
const showSide = computed(() => viewMode.value === 'active' || viewMode.value === 'archived');

// ---- 项目列表统一按部门归类（部门顺序沿用组织架构：sortOrder → createdAt） ----
/** 展示分组：按「主部门」把项目归到唯一一组（多部门项目只出现在主部门组，避免同一张卡片重复）；
 *  主部门 = 该项目关联部门里组织架构顺序最靠前的那个；未关联任何部门的归「未归类」沉底。
 *  回收站是管理视图，保持平铺（接口不返回部门，分组没有意义）。 */
/** 顶部轻量统计：按主部门分布 + 任务/成员总数（仅进行中视图） */
const deptStats = computed(() => {
  const m = new Map<string, number>();
  for (const p of projects.value) {
    const name = p.departments?.[0]?.name ?? '未归类';
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a: any, b: any) => b[1] - a[1]));
});
const totalTasks = computed(() => projects.value.reduce((s: number, p: any) => s + (p._count?.tasks ?? 0), 0));
const totalMembers = computed(() => new Set(projects.value.flatMap((p: any) => (p.members || []).map((m: any) => m.userId))).size);

/** 纪要类型 → 展示文案/颜色（与项目详情页一致） */
function noteLabel(k: string) {
  return k === 'PROGRESS' ? '进度' : k === 'REPORT' ? '汇报' : '备注';
}
function noteTag(k: string): 'primary' | 'success' | 'warning' {
  return (k === 'PROGRESS' ? 'primary' : k === 'REPORT' ? 'success' : 'warning') as 'primary' | 'success' | 'warning';
}
/** 相对日期：今天/昨天/N 天前，超 30 天显示 MM-DD */
function relDate(s?: string): string {
  if (!s) return '—';
  const d = new Date(s).getTime();
  if (Number.isNaN(d)) return '—';
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const p = (n: number) => String(n).padStart(2, '0');
  const dt = new Date(s);
  return `${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

const displayGroups = computed(() => {
  const base = searching.value ? shownProjects.value.filter((p) => searchHits.value.has(p.id)) : shownProjects.value;
  if (viewMode.value === 'trash') return [{ title: '', projects: base }];
  const order: string[] = departments.value.map((d) => d.name).filter(Boolean);
  const rank = new Map(order.map((n, i) => [n, i]));
  const buckets = new Map<string, any[]>();
  const unclassified: any[] = [];
  for (const p of base) {
    const names: string[] = (p.departments || []).map((d: any) => d.name).filter(Boolean);
    if (!names.length) {
      unclassified.push(p);
      continue;
    }
    // 主部门：组织架构顺序最靠前；不在字典里的部门（极端情况）按名字兜底排到最后
    const primary = names.reduce((best, n) => ((rank.get(n) ?? Number.MAX_SAFE_INTEGER) < (rank.get(best) ?? Number.MAX_SAFE_INTEGER) ? n : best), names[0]);
    if (!buckets.has(primary)) {
      buckets.set(primary, []);
      if (!rank.has(primary)) {
        rank.set(primary, order.length);
        order.push(primary);
      }
    }
    buckets.get(primary)!.push(p);
  }
  const groups = order.filter((n) => buckets.get(n)?.length).map((n) => ({ title: n, projects: buckets.get(n)! }));
  if (unclassified.length) groups.push({ title: '未归类', projects: unclassified });
  // 左侧导航单选部门：只保留选中组（搜索生效时忽略，跨部门展示命中项）
  if (!searching.value && sideFilter.value) return groups.filter((g) => g.title === sideFilter.value);
  return groups;
});

/** 左侧导航数据源：基于「未过滤」的完整分组（否则选中某部门后其余项计数会消失） */
const allGroups = computed(() => {
  if (viewMode.value === 'trash') return [{ title: '', projects: shownProjects.value }];
  const order: string[] = departments.value.map((d) => d.name).filter(Boolean);
  const rank = new Map(order.map((n, i) => [n, i]));
  const buckets = new Map<string, any[]>();
  const unclassified: any[] = [];
  for (const p of shownProjects.value) {
    const names: string[] = (p.departments || []).map((d: any) => d.name).filter(Boolean);
    if (!names.length) {
      unclassified.push(p);
      continue;
    }
    const primary = names.reduce((best, n) => ((rank.get(n) ?? Number.MAX_SAFE_INTEGER) < (rank.get(best) ?? Number.MAX_SAFE_INTEGER) ? n : best), names[0]);
    if (!buckets.has(primary)) {
      buckets.set(primary, []);
      if (!rank.has(primary)) {
        rank.set(primary, order.length);
        order.push(primary);
      }
    }
    buckets.get(primary)!.push(p);
  }
  const groups = order.filter((n) => buckets.get(n)?.length).map((n) => ({ title: n, projects: buckets.get(n)! }));
  if (unclassified.length) groups.push({ title: '未归类', projects: unclassified });
  return groups;
});

/** 左侧导航项：全部 + 各部门 + 未归类，带项目数徽标 */
const sideItems = computed(() => {
  const items: { key: string; name: string; count: number }[] = [{ key: '', name: '全部', count: shownProjects.value.length }];
  for (const g of allGroups.value) if (g.title) items.push({ key: g.title, name: g.title, count: g.projects.length });
  return items;
});

/** 当前可见项目总数（搜索/部门过滤后的空态判断） */
const listTotal = computed(() => displayGroups.value.reduce((s, g) => s + g.projects.length, 0));

/** 点击部门 chip：选中或取消；有搜索词时点击先清空搜索 */
function pickSide(key: string) {
  if (searching.value) searchKw.value = '';
  sideFilter.value = sideFilter.value === key ? '' : key;
}

/** 顶部快捷迷你卡：当前范围（搜索/部门过滤后）的项目列表 */
const quickProjects = computed(() => displayGroups.value.flatMap((g) => g.projects));

/** 点迷你卡滚动定位到完整卡片并高亮 1.6s（不改列表样式，只做快速检索） */
function locateProject(p: any) {
  const el = document.getElementById(`qcard-${p.id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashId.value = p.id;
  window.setTimeout(() => {
    if (flashId.value === p.id) flashId.value = '';
  }, 1600);
}

/** 切视图：重置部门选中（搜索词保留），再拉数据 */
function onViewChange() {
  sideFilter.value = '';
  load();
}

async function load() {
  loading.value = true;
  try {
    if (viewMode.value === 'trash') {
      // 回收站：仅管理员，拉取已软删除项目（含 deletedAt）
      projects.value = await projectsApi.trash().catch(() => []);
      return;
    }
    if (viewMode.value === 'pending') {
      projects.value = await projectsApi.pending().catch(() => []);
      pendingCount.value = projects.value.length;
      return;
    }
    if (viewMode.value === 'mine') {
      projects.value = await projectsApi.myApplications().catch(() => []);
      myAppCount.value = projects.value.length;
      return;
    }
    const archived = viewMode.value === 'archived';
    const list: any[] = await projectsApi.list(archived);
    // 列表接口的进展为轻量对象（无 projectId），补上所属项目 id 供同项目合并校验
    projects.value = list.map((p) => ({
      ...p,
      updates: (p.updates || []).map((u: any) => ({ ...u, projectId: p.id })),
    }));
    // 维护已存档计数（仅在进行中视图时拉取，供标签展示）
    if (!archived) {
      archivedCount.value = (await projectsApi.list(true).catch(() => [])).length;
    } else {
      archivedCount.value = projects.value.length;
    }
    // 同步拉取待审批/我的申请 计数（失败不阻断）
    pendingCount.value = (await projectsApi.pending().catch(() => [])).length;
    myAppCount.value = (await projectsApi.myApplications().catch(() => [])).length;
  } finally {
    loading.value = false;
  }
}

/** 从回收站恢复项目（清空 deletedAt） */
async function restoreFromTrash(p: any) {
  restoringId.value = p.id;
  try {
    await projectsApi.restore(p.id);
    ElMessage.success(`已恢复项目：${p.name}`);
    await load();
  } finally {
    restoringId.value = '';
  }
}

/** 彻底删除（不可恢复）：二次确认后物理删除 */
async function purgeForever(p: any) {
  try {
    await ElMessageBox.confirm(
      `确定彻底删除「${p.name}」？此操作不可恢复，将清除该项目全部看板/任务/进展/复盘/文档/SOP 等数据。`,
      '彻底删除',
      { type: 'warning', confirmButtonText: '彻底删除' },
    );
  } catch {
    return;
  }
  purgingId.value = p.id;
  try {
    await projectsApi.purge(p.id);
    ElMessage.success('项目已彻底删除');
    await load();
  } finally {
    purgingId.value = '';
  }
}

/** 回收站列表展示删除时间（仅到日） */
function fmtDate(v: any): string {
  try {
    return new Date(v).toLocaleDateString('zh-CN');
  } catch {
    return '';
  }
}

/** 恢复已存档项目：取消存档后回到进行中列表 */
async function restore(p: any) {
  restoringId.value = p.id;
  try {
    await projectsApi.update(p.id, { archived: false });
    ElMessage.success(`已恢复项目：${p.name}`);
    await load();
  } finally {
    restoringId.value = '';
  }
}

/** 点击卡片进入完整详情页（回收站项目不可进入，已软删除） */
function goDetail(p: any) {
  if (viewMode.value === 'trash') return;
  router.push(`/projects/${p.id}`);
}

/** 项目列表卡片健康徒章颜色（无缓存时不显示） */
function healthClass(level?: string | null): string {
  if (level === 'GREEN') return 'health-green';
  if (level === 'YELLOW') return 'health-yellow';
  if (level === 'RED') return 'health-red';
  return '';
}
/** 模板里展示已选文档大小（KB） */
const Math_ceil = Math.ceil;

// ---- 从进展创建/关联任务：点击绿色进展条目弹出（与首页一致） ----
const convertVisible = ref(false);
const convertUpdate = ref<any>(null);
const convertSourceText = ref('');
const convertProject = ref<any>(null);
// 转换弹窗需要完整项目（看板列/成员/负责人），列表接口返回轻量对象 → 点击时补拉一次并缓存
const fullProjectCache = new Map<string, any>();

async function openConvertFromProgress(p: any, u: any) {
  // 拖拽/长按拖拽松手后的余波点击：不打开转换弹窗
  if (merge.consumeClick()) return;
  try {
    let full = fullProjectCache.get(p.id);
    if (!full) {
      full = await projectsApi.get(p.id);
      fullProjectCache.set(p.id, full);
    }
    convertProject.value = full;
    convertUpdate.value = u;
    convertSourceText.value = String(u?.content ?? '').trim();
    convertVisible.value = true;
  } catch {
    ElMessage.error('项目详情加载失败，请稍后重试');
  }
}

// ---- 进展合并：同项目内把一条进展拖到另一条上即合并（桌面拖拽 / 移动端长按拖拽） ----
const merge = useUpdateMerge({
  getItem: (key) => {
    for (const p of projects.value) {
      const hit = (p.updates || []).find((u: any) => u.id === key);
      if (hit) return hit;
    }
    return null;
  },
  onMerged: () => load(),
});

/** 打开新建弹窗：里程碑必填，默认先给一行待填 */
function openCreateDialog() {
  showCreate.value = true;
  if (!createForm.skipMilestone && !createForm.milestones.length) addMilestone();
}

async function create() {
  if (!createForm.name.trim()) {
    ElMessage.warning('请输入项目名称');
    return;
  }
  if (!createForm.startDate || !createForm.endDate) {
    ElMessage.warning('请设定项目计划起止日期');
    return;
  }
  if (createForm.endDate < createForm.startDate) {
    ElMessage.warning('计划交付日不能早于开始日');
    return;
  }
  const validMs = createForm.milestones.filter((ms) => ms.name.trim() && ms.dueDate);
  if (!createForm.skipMilestone && !validMs.length) {
    ElMessage.warning('请填写至少一个里程碑；确实不需要请勾选「本项目确定不需要里程碑」');
    return;
  }
  if (!createForm.skipRequirementDoc && !reqDocFiles.value.length) {
    ElMessage.warning('请上传至少一份需求文档；确实不需要请勾选「本项目确定不需要需求文档」');
    return;
  }
  creating.value = true;
  try {
    // 三步协调：1) 创建项目（携带豁免确认） 2) 逐个上传需求文档到项目空间 3) PATCH 回写 requirementDocIds
    const created: any = await projectsApi.create({
      name: createForm.name,
      description: createForm.description,
      color: createForm.color,
      departmentIds: createForm.departmentIds,
      dingtalkConversationId: createForm.dingtalkConversationId || null,
      dingtalkGroupName: createForm.dingtalkGroupName || null,
      startDate: createForm.startDate,
      endDate: createForm.endDate,
      skipMilestone: createForm.skipMilestone,
      skipRequirementDoc: createForm.skipRequirementDoc,
      milestones: validMs.map((ms) => ({ name: ms.name.trim(), dueDate: ms.dueDate, description: ms.description?.trim() || null })),
    });
    const projectId: string = created?.id;
    if (!projectId) throw new Error('项目创建失败：未返回 id');
    const uploaded: string[] = [];
    for (const f of reqDocFiles.value) {
      // 立项必传的需求文档自动打「产品需求文档」类型，进项目空间后可被类型筛选到
      const r: any = await documentsApi.upload(f, {
        scope: 'project',
        targetId: projectId,
        docType: '产品需求文档',
      });
      if (r?.id) uploaded.push(r.id);
    }
    if (uploaded.length) {
      await projectsApi.update(projectId, { requirementDocIds: uploaded });
    }
    ElMessage.success('项目已创建并提交审批');
    showCreate.value = false;
    Object.assign(createForm, {
      name: '',
      description: '',
      color: '#428bff',
      departmentIds: [],
      dingtalkConversationId: '',
      dingtalkGroupName: '',
      startDate: '',
      endDate: '',
      milestones: [],
      skipMilestone: false,
      skipRequirementDoc: false,
    });
    reqDocFiles.value = [];
    load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '创建失败，请重试');
  } finally {
    creating.value = false;
  }
}

/** 新里程碑行 */
function addMilestone() {
  createForm.milestones.push({ name: '', dueDate: '', description: '' });
}
function removeMilestone(i: number) {
  createForm.milestones.splice(i, 1);
  // 必填：清空最后一行后自动补一行，引导继续填写
  if (!createForm.milestones.length && !createForm.skipMilestone) addMilestone();
}
/** 选择需求文档（多选，确认后才上传） */
function onPickDocs(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const list = input.files ? Array.from(input.files) : [];
  reqDocFiles.value = list;
}
function clearDocs() {
  reqDocFiles.value = [];
  if (reqDocInputRef.value) reqDocInputRef.value.value = '';
}
function pickDocs() {
  reqDocInputRef.value?.click();
}

/** 填写群名 → 调后端校验唯一命中 → 关联成功 */
async function resolveGroup() {
  const name = (createForm.dingtalkGroupName || '').trim();
  if (!name) {
    ElMessage.warning('请先填写钉钉群名称');
    return;
  }
  resolvingGroup.value = true;
  try {
    const r: any = await projectsApi.resolveDingtalkGroup(name);
    createForm.dingtalkConversationId = r.conversationId;
    createForm.dingtalkGroupName = r.name;
    ElMessage.success(`已关联钉钉群：${r.name}`);
  } catch (e: any) {
    createForm.dingtalkConversationId = '';
    ElMessage.error(e?.response?.data?.message || '群校验失败，请稍后重试');
  } finally {
    resolvingGroup.value = false;
  }
}

/** 取消已关联的群 */
function unlinkGroup() {
  createForm.dingtalkConversationId = '';
  createForm.dingtalkGroupName = '';
}

onMounted(async () => {
  load();
  departments.value = await departmentsApi.list().catch(() => []);
});
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
/* 顶部快捷导航：部门 chips + 项目迷你卡（点击定位到下方完整卡片，原卡片样式不动） */
.qnav {
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.qn-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color);
  cursor: pointer;
}
.qn-chip:hover {
  background: var(--el-fill-color-dark);
}
.qn-chip.on {
  color: #fff;
  background: var(--el-color-primary);
}
.qn-chip b {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.75;
}
.qn-projs {
  padding-top: 2px;
}
.qn-proj {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  padding: 3px 10px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: #fff;
  border: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  transition: border-color 0.15s;
}
.qn-proj:hover {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.qn-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}
.qn-proj .ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 搜索框：占 view-tabs 剩余空间 */
.proj-search {
  width: 240px;
  margin-left: auto;
}
/* 搜索命中原因小标签 */
.proj-hit {
  display: inline-block;
  margin-top: 8px;
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 6px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
/* 快捷定位高亮：点顶部迷你卡后目标完整卡片闪两下 */
.project-card.flash {
  animation: qcard-flash 0.8s ease-in-out 2;
}
@keyframes qcard-flash {
  0%, 100% { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05); }
  50% { box-shadow: 0 0 0 3px var(--el-color-primary-light-5); }
}
@media (max-width: 900px) {
  .proj-search {
    width: 100%;
    margin-left: 0;
    order: 10;
  }
}
.project-card {
  background: #fff;
  border-radius: 10px;
  padding: 16px;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
  transition: transform 0.15s;
}
.project-card:hover {
  transform: translateY(-2px);
}
.proj-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.proj-color {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}
.proj-name {
  font-size: var(--fs-lg);
  font-weight: 600;
}
/* 顶部轻量统计条：项目总数 + 按部门分布 + 任务/成员总数 */
.proj-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
  border-left: 3px solid var(--el-color-primary);
  font-size: 13px;
}
.ps-item {
  color: var(--el-text-color-regular);
}
.ps-item b {
  font-size: 15px;
  color: var(--el-color-primary);
}
.ps-divider {
  width: 1px;
  height: 14px;
  background: var(--el-border-color);
}
/* 卡片最新纪要行 */
.proj-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
}
.proj-note .pn-title {
  flex: 1;
  min-width: 0;
  color: var(--el-text-color-regular);
}
.proj-note .pn-time {
  white-space: nowrap;
  font-size: 12px;
}
.view-tabs {
  margin-bottom: var(--sp-3);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
/* 按部门分组的组头：占满整行栅格，下沿一条细线把各组隔开 */
.dept-group-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 2px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  margin-bottom: 2px;
}
.dept-group-head:first-child {
  padding-top: 2px;
}
.dept-group-name {
  font-weight: 600;
  font-size: 15px;
}
.archived-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
}
.proj-dept {
  font-size: 12px;
  margin-top: 4px;
  color: #909399;
}
.proj-desc {
  font-size: 13px;
  color: #606266;
  margin: 8px 0 12px;
  min-height: 36px;
}
.ellipsis-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.proj-meta {
  display: flex;
  gap: 10px;
  font-size: 12px;
}
.upd-empty {
  font-size: 12px;
  margin-top: 8px;
}
.upd-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  min-width: 0;
}
/* 进展条目（与首页样式一致）：前缀消息日简写加粗，文本 AI 浓缩，绿色 */
.upd-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  line-height: 1.45;
  color: #67c23a;
  border-radius: 6px;
  padding: 2px 6px;
  margin: 0 -6px;
  cursor: pointer;
}
.upd-item:hover {
  background: rgba(103, 194, 58, 0.1);
}
.upd-item:active {
  background: rgba(103, 194, 58, 0.18);
}
.upd-item .upd-date {
  font-weight: 600;
  flex-shrink: 0;
  color: #95d475;
}
.upd-item .upd-text {
  flex: 1;
  min-width: 0;
  color: #67c23a;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 当天（消息日为今天）的进展条目：加深绿 + 浅绿底高亮 */
.upd-item.fresh {
  background: #f0f9eb;
  color: #529b2e;
}
.upd-item.fresh:hover {
  background: #e1f3d8;
}
.upd-item.fresh:active {
  background: #d3edd0;
}
.upd-item.fresh .upd-date {
  color: #529b2e;
}
.upd-item.fresh .upd-text {
  color: #529b2e;
}
/* 已转为任务的进展：蓝色显示以示区别（覆盖当天高亮的绿色） */
.upd-item.converted,
.upd-item.converted .upd-text {
  color: var(--app-brand);
}
.upd-item.converted:hover {
  background: rgba(66, 139, 255, 0.1);
}
.upd-item.converted:active {
  background: rgba(66, 139, 255, 0.18);
}
.upd-item.converted .upd-date {
  color: #7baeff;
}
.upd-conv {
  flex-shrink: 0;
  font-size: var(--fs-2xs);
  line-height: 1.5;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--app-brand);
  background: rgba(66, 139, 255, 0.12);
}
/* 拖拽合并：源条目半透明，命中目标高亮 */
.upd-item.dragging {
  opacity: 0.45;
}
.upd-item.drag-over {
  background: rgba(66, 139, 255, 0.16);
  outline: 1px dashed var(--app-brand);
}
.empty {
  padding: 40px 0;
  grid-column: 1 / -1;
  text-align: center;
}
.group-resolve {
  width: 100%;
}
.group-hint {
  font-size: 12px;
  margin-top: 4px;
}
.ms-row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}
.doc-picker {
  display: flex;
  gap: 8px;
  align-items: center;
}
.doc-list {
  margin: 6px 0 0 20px;
  padding: 0;
  font-size: 12px;
}
/* 必填项旁边的「确定不需要」豁免勾选：与标题同行，字号略小 */
.skip-check {
  margin-left: 12px;
  font-weight: normal;
  vertical-align: middle;
}
.skip-check :deep(.el-checkbox__label) {
  font-size: 12px;
  font-weight: normal;
  color: var(--el-text-color-secondary);
}
.skip-hint {
  font-size: 12px;
  line-height: 1.6;
}
.status-tag {
  margin-left: 6px;
}
.health-green, .health-yellow, .health-red {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 4px;
}
.health-green { background: #67c23a; }
.health-yellow { background: #e6a23c; }
.health-red { background: #f56c6c; }
</style>
