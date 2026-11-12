<template>
  <div class="page-card prv-card" v-loading="loading">
    <div class="prv-head">
      <div>
        <span class="page-title">待我审核</span>
        <span v-if="total" class="muted prv-total">共 {{ total }} 条待处理</span>
      </div>
      <el-button text type="primary" size="small" :loading="loading" @click="load">刷新</el-button>
    </div>

    <!-- 项目审批：别人申请立项后等待审批（ADMIN 全量 / 被指定的审批人与加签人） -->
    <div class="prv-sec">
      <div class="prv-sec-head">
        <span class="prv-sec-title">项目审批</span>
        <el-tag size="small" :type="projects.length ? 'danger' : 'info'" effect="plain">{{ projects.length }} 条</el-tag>
      </div>
      <div v-if="!projects.length" class="muted prv-empty">暂无待审批的项目申请</div>
      <div v-for="p in projects" :key="'p-' + p.id" class="prv-row" @click="emit('jump', { kind: 'project', id: p.id })">
        <el-tag size="small" type="primary" effect="plain">项目</el-tag>
        <span class="prv-main ellipsis">{{ p.name }}</span>
        <span class="muted prv-meta">{{ p.owner?.name }} 申请 · {{ fmt(p.approvalSubmittedAt, 'MM-DD HH:mm') }} 提交</span>
        <span class="prv-go"><el-button text type="primary" size="small">去审批 →</el-button></span>
      </div>
    </div>

    <!-- PBC 计划审批：成员提交的月度 PBC 计划等待审批（ADMIN/部门负责人） -->
    <div class="prv-sec">
      <div class="prv-sec-head">
        <span class="prv-sec-title">PBC 计划审批</span>
        <el-tag size="small" :type="pbcPlans.length ? 'danger' : 'info'" effect="plain">{{ pbcPlans.length }} 条</el-tag>
      </div>
      <div v-if="!pbcPlans.length" class="muted prv-empty">暂无待审批的 PBC 计划</div>
      <div v-for="r in pbcPlans" :key="'plan-' + r.userId + '-' + r.month" class="prv-row" @click="emit('jump', { kind: 'pbc-plan' })">
        <el-tag size="small" type="warning" effect="plain">PBC 计划</el-tag>
        <span class="prv-main ellipsis">{{ r.name }}</span>
        <span class="muted prv-meta">{{ r.month }} · 计划 {{ r.total }} 分 · 等待审批</span>
        <span class="prv-go"><el-button text type="primary" size="small">去审批 →</el-button></span>
      </div>
    </div>

    <!-- PBC 考核评分：成员已自评，等待打分上级/管理员复核定稿 -->
    <div class="prv-sec">
      <div class="prv-sec-head">
        <span class="prv-sec-title">PBC 考核评分</span>
        <el-tag size="small" :type="pbcScores.length ? 'danger' : 'info'" effect="plain">{{ pbcScores.length }} 条</el-tag>
      </div>
      <div v-if="!pbcScores.length" class="muted prv-empty">暂无待复核的 PBC 自评</div>
      <div v-for="r in pbcScores" :key="'score-' + r.userId + '-' + r.month" class="prv-row" @click="emit('jump', { kind: 'pbc-review' })">
        <el-tag size="small" type="success" effect="plain">PBC 考核</el-tag>
        <span class="prv-main ellipsis">{{ r.name }}</span>
        <span class="muted prv-meta">{{ r.month }} · 已自评 {{ r.selfTotal ?? '—' }} 分 · 等待复核</span>
        <span class="prv-go"><el-button text type="primary" size="small">去评分 →</el-button></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePendingReview } from '../utils/usePendingReview';
import { fmt } from '../utils/format';

/** 点行跳转：project → 项目详情；pbc-plan / pbc-review → 工作管理 PBC 区（父级决定站内切换还是路由跳转） */
const emit = defineEmits<{ (e: 'jump', payload: { kind: 'project' | 'pbc-plan' | 'pbc-review'; id?: string }): void }>();

const { projects, pbcPlans, pbcScores, loading, total, load } = usePendingReview();
load();
</script>

<style scoped>
.prv-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.prv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.prv-total {
  font-size: 13px;
  margin-left: 10px;
}
.prv-sec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.prv-sec-title {
  font-weight: 600;
  font-size: 14px;
}
.prv-empty {
  font-size: 13px;
  padding: 2px 0 4px;
}
.prv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.prv-row:hover {
  background: #f5f8ff;
}
.prv-row + .prv-row {
  border-top: 1px solid #f0f2f5;
}
.prv-main {
  font-size: 14px;
  min-width: 0;
}
.prv-meta {
  font-size: 12px;
  min-width: 0;
}
.prv-go {
  margin-left: auto;
  flex-shrink: 0;
}
@media (max-width: 767px) {
  .prv-meta {
    display: none;
  }
}
</style>
