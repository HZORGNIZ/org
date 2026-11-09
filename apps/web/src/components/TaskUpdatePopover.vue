<template>
  <!-- 桌面悬停浮窗：展示任务更新记录（仅 hover 设备触发，触屏无感、单击进详情行为不变） -->
  <div
    class="tup-wrap"
    @mouseenter="onEnter"
    @mouseleave="scheduleHide"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="show"
        class="tup-panel"
        :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        @mouseenter="cancelHide"
        @mouseleave="hide"
      >
        <div class="tup-head">
          <span class="tup-title" :title="task?.title">{{ task?.title }}</span>
          <span class="tup-cap">更新记录</span>
        </div>
        <div class="tup-list">
          <template v-if="activities.length">
            <div v-for="a in visibleActs" :key="a.id" class="tup-item">
              <div class="tup-item-head">
                <b>{{ a.user?.name || '某人' }}</b>
                <span class="tup-act">{{ actionLabel(a) }}</span>
                <span class="tup-time">{{ fmtShort(a.createdAt) }}</span>
              </div>
              <div v-if="activityLines(a, userMap).length" class="tup-lines">
                <div
                  v-for="(line, i) in activityLines(a, userMap)"
                  :key="i"
                  class="tup-line"
                  :class="{ note: line.note }"
                >
                  {{ line.text }}
                </div>
              </div>
            </div>
            <div v-if="activities.length > 5" class="tup-more">仅显示最近 5 条，共 {{ activities.length }} 条</div>
          </template>
          <div v-else-if="loadingActs" class="tup-empty">加载中…</div>
          <div v-else class="tup-empty">暂无更新记录</div>
        </div>
        <div class="tup-foot">
          <el-button text type="primary" size="small" @click="openDetail">打开任务详情</el-button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { tasksApi, usersApi } from '../api';
import { fmtShort } from '../utils/format';
import { actionLabel, activityLines } from '../utils/taskActivity';

const props = defineProps<{ task: any }>();
const emit = defineEmits<{ (e: 'open'): void }>();

const show = ref(false);
const pos = ref({ x: 0, y: 0 });
const loadingActs = ref(false);
const activities = ref<any[]>([]);
const userMap = ref<Map<string, string>>(new Map());

const visibleActs = computed(() => activities.value.slice(0, 5));

// 仅鼠标精确悬停设备启用（触屏/笔不触发，单击进详情不受影响）
const canHover =
  typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

let enterTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let dragging = false;

// 系统用户 id→姓名（模块级只拉一次）
let userListPromise: Promise<Map<string, string>> | null = null;
function getUserMap(): Promise<Map<string, string>> {
  if (!userListPromise) {
    userListPromise = usersApi
      .list()
      .then((us: any[]) => new Map(us.map((u: any) => [u.id, u.name])))
      .catch(() => new Map());
  }
  return userListPromise;
}

// 活动缓存：同一任务 30 秒内不重复请求（悬停扫过卡片不刷接口）
const actCache = new Map<string, { t: number; data: any[] }>();
async function ensureActs(taskId: string) {
  const hit = actCache.get(taskId);
  if (hit && Date.now() - hit.t < 30000) {
    activities.value = hit.data;
    return;
  }
  loadingActs.value = true;
  try {
    const list = await tasksApi.activities(taskId);
    actCache.set(taskId, { t: Date.now(), data: list });
    activities.value = list;
  } finally {
    loadingActs.value = false;
  }
}

/** 面板贴鼠标右下展开，越界自动翻到左侧/上方 */
function computePos(cx: number, cy: number) {
  const W = 330;
  const GAP = 14;
  const M = 8;
  const estH = 400;
  let x = cx + GAP;
  let y = cy + GAP;
  if (x + W > window.innerWidth - M) x = Math.max(M, cx - W - GAP);
  if (y + estH > window.innerHeight - M) y = Math.max(M, cy - estH - GAP);
  return { x, y };
}

function onEnter(e: MouseEvent) {
  if (!canHover || dragging) return;
  const taskId = props.task?.id;
  if (!taskId) return;
  clearTimeout(hideTimer);
  hideTimer = undefined;
  const cx = e.clientX;
  const cy = e.clientY;
  enterTimer = setTimeout(() => {
    if (!canHover || dragging) return;
    pos.value = computePos(cx, cy);
    show.value = true;
    ensureActs(taskId);
    if (!userMap.value.size) {
      getUserMap().then((m) => {
        userMap.value = m;
      });
    }
  }, 250);
}

/** 移出卡片：短暂延迟再隐藏，允许鼠标滑入面板 */
function scheduleHide() {
  clearTimeout(enterTimer);
  enterTimer = undefined;
  if (!show.value) return;
  hideTimer = setTimeout(() => {
    show.value = false;
  }, 200);
}

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

function hide() {
  clearTimeout(enterTimer);
  clearTimeout(hideTimer);
  enterTimer = undefined;
  hideTimer = undefined;
  show.value = false;
}

function openDetail() {
  hide();
  emit('open');
}

// 原生拖拽期间抑制浮窗（拖任务卡片/列表行）
function onDragStart() {
  dragging = true;
  hide();
}
function onDragEnd() {
  dragging = false;
}

onBeforeUnmount(() => {
  clearTimeout(enterTimer);
  clearTimeout(hideTimer);
});
</script>

<style scoped>
.tup-wrap {
  display: contents;
}
.tup-panel {
  position: fixed;
  z-index: 3100;
  width: min(330px, 88vw);
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(4px);
  overflow: hidden;
}
.tup-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #f7f9fc;
  border-bottom: 1px solid #f0f2f5;
}
.tup-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tup-cap {
  flex-shrink: 0;
  font-size: 11px;
  color: #909399;
}
.tup-list {
  max-height: 300px;
  overflow-y: auto;
  padding: 6px 12px;
}
.tup-item {
  padding: 6px 0;
  border-bottom: 1px dashed #f2f4f7;
}
.tup-item:last-child {
  border-bottom: none;
}
.tup-item-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.tup-item-head b {
  color: #303133;
  font-weight: 600;
}
.tup-act {
  color: #606266;
}
.tup-time {
  margin-left: auto;
  flex-shrink: 0;
  color: #a8abb2;
  font-size: 11px;
}
.tup-lines {
  margin-top: 2px;
}
.tup-line {
  font-size: 12px;
  color: #606266;
  line-height: 1.6;
  word-break: break-word;
}
.tup-line.note {
  color: #909399;
  font-style: italic;
}
.tup-more,
.tup-empty {
  padding: 8px 0;
  text-align: center;
  font-size: 12px;
  color: #a8abb2;
}
.tup-foot {
  padding: 6px 8px 6px 12px;
  border-top: 1px solid #f0f2f5;
  display: flex;
  justify-content: flex-end;
  background: #fbfcfe;
}
</style>
