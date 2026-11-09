<template>
  <!-- 成员周报聚合直排：姓名 · 部门 · 角色 · 归属 · 内容（项目/公司/部门视图共用） -->
  <div class="mate-doc">
    <section
      v-for="s in sections"
      :key="s.userId"
      class="mate-sec"
      :class="{ nocontent: !s.submitted }"
    >
      <header class="mate-hd">
        <b class="mate-name">{{ s.name }}</b>
        <span class="muted">{{ s.departmentName || '—' }}</span>
        <el-tag
          v-if="s.roleTag && s.roleTag !== 'MEMBER'"
          size="small"
          :type="s.roleTag === 'DEPT_LEADER' ? 'warning' : 'primary'"
          effect="plain"
        >
          {{ ROLE_TAG[s.roleTag] || s.roleTag }}
        </el-tag>
        <el-tag v-if="s.scopeNote" size="small" type="info" effect="plain">{{ s.scopeNote }}</el-tag>
        <el-tag :type="s.submitted ? 'success' : 'danger'" size="small" effect="plain">
          {{ s.submitted ? '已交' : '本周未交' }}
        </el-tag>
        <span v-if="s.isSelf" class="muted">我</span>
        <span v-if="s.source" class="muted mate-sub-src">{{ s.source === 'AI' ? 'AI 润色' : '手写' }}</span>
      </header>
      <pre v-if="s.content" class="mate-text">{{ s.content }}</pre>
      <div v-else class="muted">本周未提交周报</div>
    </section>
    <div v-if="!sections || !sections.length" class="muted">{{ emptyText }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  sections?: any[];
  emptyText?: string;
}>();

const ROLE_TAG: Record<string, string> = { DEPT_LEADER: '部门负责人', PROJ_OWNER: '项目负责人', MEMBER: '成员' };
</script>

<style scoped>
.mate-doc {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 40px;
}
.mate-sec {
  border: 1px solid var(--app-border);
  border-left: 3px solid #4a7fd6;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
}
.mate-sec.nocontent {
  border-left-color: #dcdfe6;
  background: #fafafa;
}
.mate-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mate-name {
  font-size: 14px;
}
.mate-sub-src {
  font-size: 12px;
}
.mate-text {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
}
</style>
