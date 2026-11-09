<template>
  <div class="page">
    <div class="page-title">
      通知中心
      <el-button text type="primary" :disabled="!list.length" @click="readAll">全部已读</el-button>
    </div>

    <div class="page-card">
      <div v-loading="loading" class="notify-list">
        <div v-if="!list.length && !loading" class="muted empty">暂无通知</div>
        <div
          v-for="n in list"
          :key="n.id"
          class="notify-row"
          :class="{ unread: !n.read }"
          @click="open(n)"
        >
          <div class="notify-dot" :class="{ active: !n.read }"></div>
          <div class="notify-body">
            <div class="notify-title" :class="{ bold: !n.read }">{{ n.title }}</div>
            <div class="muted notify-content ellipsis-2">{{ n.content }}</div>
            <div class="muted notify-time">{{ timeAgo(n.createdAt) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { notificationsApi } from '../api';
import { useAppStore } from '../stores/app';
import { timeAgo } from '../utils/format';

const router = useRouter();
const app = useAppStore();
const list = ref<any[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    list.value = await notificationsApi.list();
  } finally {
    loading.value = false;
  }
}

async function open(n: any) {
  // 后端 Notification 字段为布尔 read（此前误用 readAt 导致已读状态永不更新）
  if (!n.read) {
    await notificationsApi.read(n.id);
    n.read = true;
    app.refreshUnread();
  }
  if (n.link) router.push(n.link);
}

async function readAll() {
  await notificationsApi.readAll();
  list.value.forEach((n) => {
    n.read = true;
  });
  app.refreshUnread();
  ElMessage.success('已全部标记为已读');
}

onMounted(load);
</script>

<style scoped>
.notify-list {
  min-height: 80px;
}
.notify-row {
  display: flex;
  gap: 10px;
  padding: 12px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
}
.notify-row:last-child {
  border-bottom: none;
}
.notify-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: transparent;
  margin-top: 6px;
  flex-shrink: 0;
}
.notify-dot.active {
  background: var(--el-color-primary);
}
.notify-body {
  flex: 1;
  min-width: 0;
}
.notify-title {
  font-size: 14px;
  margin-bottom: 2px;
}
.notify-title.bold {
  font-weight: 600;
}
.notify-content {
  font-size: 13px;
  line-height: 1.5;
}
.notify-time {
  margin-top: 4px;
  font-size: 12px;
}
.ellipsis-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.empty {
  text-align: center;
  padding: 30px 0;
}
</style>
