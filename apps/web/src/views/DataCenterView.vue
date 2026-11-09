<template>
  <div class="page">
    <div class="page-title">资料中心</div>

    <!-- 大 tab 收三类沉淀内容：知识库 / SOP / 资讯；与地址栏 ?tab= 同步（旧路由与站内深链按此直达对应页签） -->
    <el-tabs v-model="tab" class="dc-tabs" @tab-change="onTabChange">
      <el-tab-pane label="知识库" name="knowledge">
        <KnowledgeView embedded />
      </el-tab-pane>
      <el-tab-pane label="SOP" name="sops">
        <SopsView embedded />
      </el-tab-pane>
      <el-tab-pane label="资讯" name="news">
        <NewsView embedded />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import KnowledgeView from './KnowledgeView.vue';
import SopsView from './SopsView.vue';
import NewsView from './NewsView.vue';

/** 默认展示「资讯」；无 ?tab= 或非法值都归到 news，news 时清掉 query 保持地址干净 */
type TabKey = 'knowledge' | 'sops' | 'news';
const route = useRoute();
const router = useRouter();
function normTab(v: unknown): TabKey {
  return v === 'knowledge' || v === 'sops' ? v : 'news';
}
const tab = ref<TabKey>(normTab(route.query.tab));

function onTabChange(name: unknown) {
  tab.value = normTab(name);
  const q = { ...route.query };
  if (tab.value === 'news') delete q.tab;
  else q.tab = tab.value;
  router.replace({ query: q });
}

// 站内跳转/浏览器前进后退改到 ?tab= 时同步高亮
watch(
  () => route.query.tab,
  (v) => {
    const t = normTab(v);
    if (t !== tab.value) tab.value = t;
  },
);
</script>

<style scoped>
/* 页签胶囊样式与下边距均由 styles.css 统一（13px/胶囊/12px 间距），不再在此局部覆盖 */
/* 内嵌子页：去掉各自上一级的 .page 内边距与居中限制，避免与 tab 容器双重留白 */
.dc-tabs :deep(.page.embedded) {
  max-width: none;
  margin: 0;
  padding: 0;
}
/* 内嵌子页的页头：不再用深宝蓝大块，降为仅靠右排列操作按钮的紧凑工具条 */
.dc-tabs :deep(.page-title.title-embedded) {
  background: none;
  box-shadow: none;
  color: inherit;
  padding: 0;
  margin: 0 0 12px;
  border-radius: 0;
  justify-content: flex-end;
  min-height: auto;
}
</style>
