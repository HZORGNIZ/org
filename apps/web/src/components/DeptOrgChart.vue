<template>
  <!-- 部门架构图：公司 → 部门（负责人/共管人/人数/项目数）→ 可展开成员；纯展示，无新表，
       数据来自 departments.list（部门层）+ departments.detail（展开时懒加载成员名单） -->
  <div class="org-chart">
    <div class="org-toolbar">
      <span class="org-title">部门架构</span>
      <el-radio-group v-model="view" size="small">
        <el-radio-button value="chart">架构图</el-radio-button>
        <el-radio-button value="list">列表</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 架构图视图 -->
    <div v-if="view === 'chart'" v-loading="loading" class="org-body">
      <div class="org-root">
        <span class="org-root-name">公司</span>
        <span class="org-root-sub">{{ depts.length }} 个部门 · {{ totalMembers }} 名成员</span>
      </div>
      <div class="org-trunk"></div>
      <div class="org-row">
        <div v-for="d in depts" :key="d.id" class="org-branch">
          <div class="org-dept" :class="{ open: expanded === d.id }" @click="toggleDept(d)">
            <div class="org-dept-name">{{ d.name }}</div>
            <div class="org-dept-line">负责人：{{ d.leader?.name || '未设置' }}</div>
            <div v-if="d.managerNames?.length" class="org-dept-line">共管：{{ d.managerNames.join('、') }}</div>
            <div class="org-dept-stats">
              <span>成员 <b>{{ d._count?.members ?? 0 }}</b></span>
              <span>项目 <b>{{ d._count?.projectLinks ?? 0 }}</b></span>
            </div>
            <div v-if="expanded === d.id" v-loading="loadingMembers" class="org-members">
              <span v-for="m in members" :key="m.id" class="org-member" :class="{ lead: m.id === d.leaderId }">
                {{ m.name }}<i v-if="m.id === d.leaderId">★</i>
              </span>
              <span v-if="!members.length && !loadingMembers" class="org-member-empty">暂无成员</span>
            </div>
            <span class="org-toggle">{{ expanded === d.id ? '收起成员 ▴' : '展开成员 ▾' }}</span>
          </div>
        </div>
        <div v-if="!depts.length && !loading" class="org-empty">还没有部门，先在下方列表新增部门</div>
      </div>
    </div>

    <!-- 列表视图：沿用下面原有的部门表格（本组件不渲染列表内容，仅切换视图由父级控制） -->
    <slot v-else />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { departmentsApi } from '../api';

/** 视图切换：chart=架构图 / list=列表（列表内容由父级 slot 渲染，保持原有表格不动） */
const view = ref<'chart' | 'list'>('chart');
const loading = ref(false);
const loadingMembers = ref(false);
const depts = ref<any[]>([]);
const expanded = ref('');
const members = ref<{ id: string; name: string; avatar?: string | null }[]>([]);

const totalMembers = computed(() =>
  depts.value.reduce((s: number, d: any) => {
    const c = Number(d?._count?.members);
    return s + (Number.isFinite(c) ? c : 0);
  }, 0),
);

onMounted(async () => {
  loading.value = true;
  depts.value = (await departmentsApi.list().catch(() => [])) as any[];
  loading.value = false;
});

/** 展开某个部门：懒加载成员名单（重复点击收起） */
async function toggleDept(d: any) {
  if (expanded.value === d.id) {
    expanded.value = '';
    members.value = [];
    return;
  }
  expanded.value = d.id;
  members.value = [];
  loadingMembers.value = true;
  try {
    const detail: any = await departmentsApi.detail(d.id);
    members.value = (detail?.members || []).map((m: any) => ({ id: m.id, name: m.name, avatar: m.avatar }));
  } catch {
    members.value = [];
  } finally {
    loadingMembers.value = false;
  }
}
</script>

<style scoped>
.org-chart {
  margin-bottom: 16px;
}
.org-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.org-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}
.org-body {
  border: 1px solid #dbe5f2;
  border-radius: 12px;
  padding: 20px 16px 16px;
  background: #f7faff;
}
.org-root {
  width: fit-content;
  margin: 0 auto;
  background: #1b4fa8;
  color: #fff;
  border-radius: 10px;
  padding: 8px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.org-root-name {
  font-size: 15px;
  font-weight: 700;
}
.org-root-sub {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.78);
}
.org-trunk {
  width: 1px;
  height: 18px;
  background: #9dbbe8;
  margin: 0 auto;
}
.org-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 18px;
  position: relative;
}
/* 横向汇流线 + 每个部门的垂直接口线，构成组织树的连线 */
.org-row::before {
  content: '';
  position: absolute;
  top: 0;
  left: 4%;
  right: 4%;
  height: 1px;
  background: #9dbbe8;
}
.org-branch {
  flex: 1 1 220px;
  min-width: 220px;
  max-width: 300px;
  position: relative;
}
.org-branch::before {
  content: '';
  position: absolute;
  top: -18px;
  left: 50%;
  width: 1px;
  height: 18px;
  background: #9dbbe8;
}
.org-dept {
  position: relative;
  background: #fff;
  border: 1px solid #c6d9f3;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.org-dept:hover {
  border-color: #428bff;
  box-shadow: 0 2px 10px rgba(66, 139, 255, 0.14);
}
.org-dept.open {
  border-color: #1b4fa8;
}
.org-dept-name {
  font-size: 14px;
  font-weight: 600;
  color: #1f2d3d;
}
.org-dept-line {
  font-size: 12px;
  color: #66738a;
  margin-top: 3px;
}
.org-dept-stats {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: #66738a;
}
.org-dept-stats b {
  color: #1b4fa8;
}
.org-members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #d5e2f5;
  min-height: 24px;
}
.org-member {
  font-size: 12px;
  color: #344563;
  background: #eef4ff;
  border-radius: 12px;
  padding: 2px 10px;
}
.org-member.lead {
  background: #1b4fa8;
  color: #fff;
}
.org-member i {
  font-style: normal;
  margin-left: 2px;
}
.org-member-empty {
  font-size: 12px;
  color: #a0a6b1;
}
.org-toggle {
  display: inline-block;
  margin-top: 6px;
  font-size: 12px;
  color: #428bff;
}
.org-empty {
  width: 100%;
  text-align: center;
  color: #909399;
  font-size: 13px;
  padding: 8px 0;
}
@media (max-width: 767.98px) {
  .org-row {
    flex-direction: column;
  }
  .org-row::before {
    display: none;
  }
  .org-branch {
    max-width: none;
  }
  .org-branch::before {
    display: none;
  }
}
</style>
