<template>
  <!-- 加分点赞动画：全屏大拇指出场 + 加分飘字（纯展示，不拦截点击） -->
  <Transition name="burst">
    <div v-if="visible" class="score-burst">
      <div class="burst-stage">
        <span class="burst-ring r1" />
        <span class="burst-ring r2" />
        <span class="burst-ring r3" />
        <div class="burst-thumb">👍</div>
        <div class="burst-line">
          <span class="burst-name">{{ name }}</span>
          <span class="burst-points">+{{ points }}</span>
        </div>
        <div v-if="reason" class="burst-reason">{{ reason }}</div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref } from 'vue';

/** 排队播放：连续多人加分时依次放，不互相覆盖 */
const visible = ref(false);
const name = ref('');
const points = ref(0);
const reason = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let queue: Array<{ name: string; points: number; reason?: string }> = [];

function next() {
  if (visible.value) return;
  const item = queue.shift();
  if (!item) return;
  name.value = item.name;
  points.value = item.points;
  reason.value = item.reason || '';
  visible.value = true;
  timer = setTimeout(() => {
    visible.value = false;
    timer = setTimeout(next, 260);
  }, 1900);
}

/** 播放一次加分动画（同名同分的重复事件由调用方去重） */
function play(item: { name: string; points: number; reason?: string }) {
  queue.push(item);
  next();
}

defineExpose({ play });
</script>

<style scoped>
.score-burst {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: radial-gradient(circle at 50% 45%, rgba(255, 196, 60, 0.22), rgba(0, 0, 0, 0.28));
}

.burst-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 32px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
  animation: pop 0.42s cubic-bezier(0.22, 1.4, 0.4, 1) both;
}

.burst-thumb {
  font-size: 132px;
  line-height: 1;
  filter: drop-shadow(0 12px 18px rgba(255, 153, 0, 0.35));
  animation: thumb 1.9s ease-in-out both;
}

.burst-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.burst-name {
  font-size: 18px;
  font-weight: 700;
  color: #303133;
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.burst-points {
  font-size: 30px;
  font-weight: 800;
  color: #f56c6c;
  animation: rise 1.9s ease-out both;
}

.burst-reason {
  font-size: 13px;
  color: #909399;
  max-width: 62vw;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.burst-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 120px;
  height: 120px;
  margin: -60px 0 0 -60px;
  border-radius: 50%;
  border: 3px solid rgba(245, 108, 108, 0.5);
  animation: ring 1.5s ease-out both;
}
.r2 { animation-delay: 0.22s; }
.r3 { animation-delay: 0.44s; }

@keyframes pop {
  from { opacity: 0; transform: scale(0.7); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes thumb {
  0% { transform: scale(0.4) rotate(-18deg); }
  35% { transform: scale(1.22) rotate(10deg); }
  55% { transform: scale(0.96) rotate(-4deg); }
  75% { transform: scale(1.04) rotate(0deg); }
  100% { transform: scale(1) rotate(0deg); }
}
@keyframes rise {
  0% { opacity: 0; transform: translateY(10px); }
  25% { opacity: 1; transform: translateY(0); }
  100% { opacity: 1; transform: translateY(-4px); }
}
@keyframes ring {
  from { opacity: 0.85; transform: scale(0.6); }
  to { opacity: 0; transform: scale(2.6); }
}

.burst-enter-active,
.burst-leave-active { transition: opacity 0.22s ease; }
.burst-enter-from,
.burst-leave-to { opacity: 0; }

@media (max-width: 640px) {
  .burst-thumb { font-size: 96px; }
  .burst-stage { padding: 18px 22px; border-radius: 22px; }
  .burst-points { font-size: 24px; }
}
</style>
