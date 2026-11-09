<template>
  <!-- 项目助理小助手独立入口（手机友好）：复用悬浮窗同一组件与同一套后端服务，
       差别只是宿主形态——这里内嵌全屏、打开即对话，不渲染悬浮球 -->
  <div class="mobile-page">
    <template v-if="ready">
      <ManagerAgentChat v-if="visible" ref="chatEl" :tier="tier" :bucket="bucket" mode="embedded" />
      <div v-else class="mobile-off">
        <div class="mobile-off-icon">🤖</div>
        <div class="mobile-off-title">项目助理小助手暂未开放</div>
        <div class="mobile-off-sub">管理员尚未开启小助手总闸（或员工档已关闭）。可以打开电脑端首页联系管理员，稍后再来。</div>
        <router-link to="/" class="mobile-off-link">前往完整工作台首页 →</router-link>
      </div>
    </template>
    <div v-else class="mobile-loading">正在唤起小助手…</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { agentApi } from '../api';
import ManagerAgentChat from '../components/ManagerAgentChat.vue';

/**
 * 可见性与档位以服务端 /agent/config 为唯一口径（与 MainLayout 悬浮窗同一判定），
 * 前端不自己判角色；拉取失败按未开放呈现（比白屏友好）
 */
const ready = ref(false);
const visible = ref(false);
const tier = ref<'manager' | 'member'>('manager');
const bucket = ref<'org' | 'project' | 'member'>('org');
const chatEl = ref<InstanceType<typeof ManagerAgentChat> | null>(null);

onMounted(async () => {
  const cfg: any = await agentApi.getConfig().catch(() => null);
  visible.value = !!cfg?.visible;
  if (cfg?.tier) tier.value = cfg.tier === 'member' ? 'member' : 'manager';
  if (cfg?.bucket) bucket.value = cfg.bucket;
  ready.value = true;
  // 播报不需要在这里触发：ManagerAgentChat 内嵌模式挂载后自行串行执行
  // 「接续最近会话 -> 今天第一次打开则播报」，竞态已在组件内收口
});
</script>

<style scoped>
.mobile-page {
  min-height: 100dvh;
  background: #f7f9fc;
}
.mobile-loading {
  padding: 40vh 20px 0;
  text-align: center;
  color: #8a94a6;
  font-size: 14px;
}
.mobile-off {
  max-width: 420px;
  margin: 0 auto;
  padding: 28vh 24px 24px;
  text-align: center;
}
.mobile-off-icon {
  font-size: 44px;
  margin-bottom: 12px;
}
.mobile-off-title {
  font-size: 17px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.mobile-off-sub {
  font-size: 13px;
  color: #8a94a6;
  line-height: 1.7;
  margin-bottom: 18px;
}
.mobile-off-link {
  display: inline-block;
  font-size: 13px;
  color: #428bff;
  text-decoration: none;
  background: #f5f8ff;
  border: 1px solid #d6e4ff;
  border-radius: 16px;
  padding: 6px 16px;
}
</style>
