<template>
  <div class="page">
    <div class="page-title">账号状态</div>

    <div class="page-card pending-card">
      <div class="pending-icon">
        <el-icon><Lock /></el-icon>
      </div>
      <div class="pending-title">你的账号尚未加入组织</div>
      <div class="muted pending-tip">
        管理员为你分配部门后，即可使用项目、任务、会议、文档等全部功能。<br />
        请把下面这段账号信息发给管理员（微信/钉钉均可），方便快速定位你的账号。
      </div>

      <div class="pending-info">
        <div class="info-row">
          <span class="muted info-label">姓名</span>
          <span class="info-value">{{ user?.name || '—' }}</span>
        </div>
        <div class="info-row">
          <span class="muted info-label">登录账号</span>
          <span class="info-value">{{ user?.username || user?.email || '—' }}</span>
        </div>
        <div class="info-row">
          <span class="muted info-label">手机号</span>
          <span class="info-value">{{ user?.phone || '未填写' }}</span>
        </div>
        <div class="info-row">
          <span class="muted info-label">注册时间</span>
          <span class="info-value">{{ user?.createdAt ? fmt(user.createdAt, 'YYYY-MM-DD HH:mm') : '—' }}</span>
        </div>
      </div>

      <div class="pending-ops">
        <el-button type="primary" :loading="checking" @click="refresh">我已加入，刷新状态</el-button>
        <el-button @click="logout">退出登录</el-button>
      </div>
      <div v-if="checking || !loaded" class="muted tip">正在为你确认最新状态…</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';

const router = useRouter();
const auth = useAuthStore();
const checking = ref(false);
const loaded = ref(false);
const user = computed(() => auth.user);

onMounted(() => refresh());

/** 重新拉取自己的资料：管理员刚分配部门时无需重新登录，刷新即可进入系统 */
async function refresh() {
  checking.value = true;
  try {
    await auth.fetchMe();
  } catch {
    /* 拉取失败保持等待页，用户可再次点击刷新 */
  } finally {
    checking.value = false;
    loaded.value = true;
  }
  if (!auth.pendingOrg) {
    ElMessage.success('已加入组织，欢迎使用');
    router.replace('/');
  }
}

function logout() {
  auth.logout();
  router.replace('/login');
}
</script>

<style scoped>
.pending-card {
  max-width: 620px;
  margin: 24px auto;
  text-align: center;
}
.pending-icon {
  font-size: 40px;
  color: #e6a23c;
  margin-bottom: 8px;
}
.pending-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 10px;
}
.pending-tip {
  line-height: 1.8;
  margin-bottom: 18px;
}
.pending-info {
  text-align: left;
  max-width: 360px;
  margin: 0 auto 20px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 14px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  font-size: 14px;
}
.info-label {
  flex: none;
}
.info-value {
  word-break: break-all;
  text-align: right;
}
.pending-ops {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tip {
  margin-top: 10px;
  font-size: 13px;
}
</style>
