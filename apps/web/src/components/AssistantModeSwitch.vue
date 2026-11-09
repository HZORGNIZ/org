<template>
  <!-- 助手三模式切换：工作台（关掉助手看业务页） / 机器人（首页悬浮窗） / 助理 Agent（/mobile 全屏） -->
  <div class="ams" :class="{ compact }" role="group" aria-label="助手模式切换">
    <button
      v-for="m in modes"
      :key="m.key"
      class="ams-btn"
      :class="{ active: m.key === current }"
      :title="m.tip"
      :aria-pressed="m.key === current"
      @click="go(m.key)"
    >
      <span class="ams-ico">{{ m.icon }}</span><span class="ams-label">{{ m.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';

type Mode = 'workspace' | 'robot' | 'agent';

const props = withDefaults(defineProps<{ current: Mode; compact?: boolean }>(), { compact: false });
const emit = defineEmits<{ (e: 'switch', mode: Mode): void }>();
const router = useRouter();

const modes: { key: Mode; label: string; icon: string; tip: string }[] = [
  { key: 'workspace', label: '工作台', icon: '⌂', tip: '收起小助手，回到工作台页面' },
  { key: 'robot', label: '机器人', icon: '🤖', tip: '首页右下角的悬浮机器人' },
  { key: 'agent', label: '助理 Agent', icon: '⤢', tip: '全屏助理 Agent（手机端 /mobile）' },
];

/** 跳转交给本组件：父组件只处理「切走后要不要收起面板」这类副作用 */
function go(mode: Mode) {
  emit('switch', mode);
  if (mode === props.current) return;
  if (mode === 'workspace') router.push('/');
  else if (mode === 'robot') router.push({ path: '/', query: { agent: '1' } });
  else router.push('/mobile');
}
</script>

<style scoped>
.ams {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: #f2f6fd;
  border: 1px solid #e2ebfa;
  border-radius: 16px;
  padding: 2px;
}
.ams-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: #6b7688;
  font-size: 12px;
  line-height: 1.6;
  padding: 3px 10px;
  border-radius: 14px;
  cursor: pointer;
  white-space: nowrap;
}
.ams-btn:hover {
  color: #428bff;
}
.ams-btn.active {
  background: #fff;
  color: #428bff;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(66, 139, 255, 0.18);
}
.ams-ico {
  font-size: 12px;
}
/* 紧凑模式：悬浮窗里空间有限，隐藏图标压缩内边距 */
.compact .ams-btn {
  padding: 2px 8px;
  font-size: 11px;
}
.compact .ams-ico {
  display: none;
}
</style>
