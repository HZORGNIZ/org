<template>
  <!-- 机器人形象「悬浮智核」（A 款）：纯 SVG，悬浮球 / 面板头像 / 欢迎页大图共用同一形象；
       thinking=true 时眼睛做眨动/扫描动画（打字中反馈） -->
  <svg
    class="agent-robot"
    :class="{ thinking }"
    :viewBox="`0 0 120 120`"
    :width="size"
    :height="size"
    role="img"
    aria-label="机器人小助手"
  >
    <!-- 轨道环（装饰，随 thinking 缓转） -->
    <ellipse class="robot-ring" cx="60" cy="62" rx="50" ry="17" fill="none" stroke="#9dbbe8" stroke-width="2.5" transform="rotate(-18 60 62)" />
    <circle class="robot-ring-dot" cx="14" cy="70" r="4" fill="#7fb2f0" />
    <!-- 头顶信号 -->
    <circle cx="60" cy="14" r="3.5" fill="#428bff" />
    <line x1="60" y1="17.5" x2="60" y2="26" stroke="#428bff" stroke-width="2.5" stroke-linecap="round" />
    <!-- 主体球体 -->
    <circle cx="60" cy="62" r="36" fill="#378add" />
    <circle cx="60" cy="62" r="36" fill="#1b4fa8" opacity="0.55" />
    <!-- 高光带 -->
    <path d="M32 56 Q60 42 88 56 Q60 50 32 56" fill="#e6f1fb" opacity="0.9" />
    <!-- 面罩 -->
    <rect x="36" y="50" width="48" height="24" rx="12" fill="#042c53" />
    <!-- 双眼（thinking 时做扫描位移） -->
    <circle class="robot-eye robot-eye-l" cx="50" cy="62" r="5.5" fill="#85b7eb" />
    <circle class="robot-eye robot-eye-r" cx="70" cy="62" r="5.5" fill="#85b7eb" />
    <!-- 侧翼小翼片 -->
    <path d="M24 58 L18 62 L24 66 Z" fill="#7fb2f0" />
    <path d="M96 58 L102 62 L96 66 Z" fill="#7fb2f0" />
    <!-- 底部悬浮投影 -->
    <ellipse cx="60" cy="106" rx="22" ry="4.5" fill="#0c447c" opacity="0.18" />
  </svg>
</template>

<script setup lang="ts">
/** 形象参数：size 像素尺寸；thinking 打字中动画开关（悬浮球不需要，聊天头/欢迎页可开） */
withDefaults(defineProps<{ size?: number; thinking?: boolean }>(), { size: 48, thinking: false });
</script>

<style scoped>
.agent-robot {
  display: block;
}
/* 打字中：轨道环缓转 + 眼睛左右扫描，形成“在想”的科技感反馈 */
@media (prefers-reduced-motion: no-preference) {
  .robot-ring {
    transform-origin: 60px 62px;
  }
  .thinking .robot-ring {
    animation: robot-ring-spin 2.4s linear infinite;
  }
  .thinking .robot-eye-l {
    animation: robot-eye-scan 1.6s ease-in-out infinite;
  }
  .thinking .robot-eye-r {
    animation: robot-eye-scan 1.6s ease-in-out infinite 0.12s;
  }
}
@keyframes robot-ring-spin {
  from {
    transform: rotate(-18deg);
  }
  to {
    transform: rotate(162deg);
  }
}
@keyframes robot-eye-scan {
  0%,
  100% {
    transform: translateX(0);
  }
  50% {
    transform: translateX(3.5px);
  }
}
</style>
