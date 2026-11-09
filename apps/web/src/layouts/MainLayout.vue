<template>
  <div class="shell" :class="{ 'imp-personating': auth.isImpersonating }">
    <!-- 管理员身份预览横幅：预览态常驻顶部，一键退出恢复管理员视角 -->
    <div v-if="auth.isImpersonating" class="impersonate-bar">
      <el-icon class="imp-icon"><View /></el-icon>
      <span class="imp-text">管理员预览模式：正在以「{{ auth.impersonatingName }}」的身份浏览，用于快速排查问题。</span>
      <el-button type="warning" size="small" @click="exitPreview">退出预览</el-button>
    </div>
    <div class="layout">
      <!-- PC 侧边栏 -->
      <aside v-if="isDesktop" class="sidebar">
      <div class="logo">MyOrgNiz</div>
      <el-menu :default-active="activeMenu" router class="menu">
        <el-menu-item index="/">
          <el-icon><HomeFilled /></el-icon><span>首页</span>
        </el-menu-item>
        <el-menu-item index="/reports">
          <el-icon><Document /></el-icon><span>工作管理</span>
        </el-menu-item>
        <el-menu-item index="/projects">
          <el-icon><FolderOpened /></el-icon><span>项目</span>
        </el-menu-item>
        <el-menu-item index="/tasks">
          <el-icon><List /></el-icon><span>任务</span>
        </el-menu-item>
        <el-menu-item index="/meetings">
          <el-icon><ChatDotSquare /></el-icon><span>会议活动</span>
        </el-menu-item>
        <el-menu-item index="/ideas">
          <el-icon><Sunny /></el-icon><span>灵感</span>
        </el-menu-item>
        <el-menu-item index="/retrospectives">
          <el-icon><RefreshLeft /></el-icon><span>复盘</span>
        </el-menu-item>
        <el-menu-item index="/data-center">
          <el-icon><Notebook /></el-icon><span>资料中心</span>
        </el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="/admin">
          <el-icon><Setting /></el-icon><span>管理后台</span>
        </el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="/ai-calls">
          <el-icon><Cpu /></el-icon><span>大模型调用</span>
        </el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="/secrecy">
          <el-icon><Lock /></el-icon><span>保密管理</span>
        </el-menu-item>
        <el-menu-item index="/inventory">
          <el-icon><Files /></el-icon><span>项目盘点</span>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <el-dropdown @command="onUserCommand">
          <div class="user-chip">
            <el-avatar :size="30" :src="auth.user?.avatar || undefined">{{ auth.user?.name?.slice(0, 1) }}</el-avatar>
            <span>{{ auth.user?.name }}</span>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="profile">个人中心</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <!-- 移动端顶部栏 -->
    <header v-else class="header">
      <div class="header-title" @click="$router.push('/')">MyOrgNiz</div>
      <div class="header-actions">
        <el-badge :value="app.unreadCount" :hidden="!app.unreadCount" :max="99">
          <el-icon class="header-icon" @click="$router.push('/notifications')">
            <Bell />
          </el-icon>
        </el-badge>
        <el-dropdown @command="onUserCommand">
          <el-avatar :size="30" :src="auth.user?.avatar || undefined" class="header-avatar">{{ auth.user?.name?.slice(0, 1) }}</el-avatar>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="profile">个人中心</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <!-- 内容区 -->
    <main class="content">
      <router-view />
    </main>

    <!-- 首次登录强制修改密码 -->
    <el-dialog
      v-model="pwdVisible"
      title="首次登录，请修改密码"
      width="min(92vw, 400px)"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
    >
      <el-form label-position="top" size="default">
        <el-form-item label="当前密码（初始密码）">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="管理员分配的初始密码" />
        </el-form-item>
        <el-form-item label="新密码（至少 6 位）">
          <el-input v-model="pwdForm.newPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input
            v-model="pwdForm.confirm"
            type="password"
            show-password
            autocomplete="new-password"
            @keyup.enter="submitPwd"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button text @click="logout">退出登录</el-button>
        <el-button type="primary" :loading="pwdSaving" @click="submitPwd">确认修改</el-button>
      </template>
    </el-dialog>

    <!-- 移动端底部导航 -->
      <nav v-if="!isDesktop" class="tabbar">
      <div
        v-for="tab in tabs"
        :key="tab.path"
        class="tab-item"
        :class="{ active: activeMenu === tab.path }"
        @click="$router.push(tab.tab ? { path: tab.path, query: { tab: tab.tab } } : tab.path)"
      >
        <el-icon :size="22"><component :is="tab.icon" /></el-icon>
        <span>{{ tab.label }}</span>
      </div>
    </nav>

    <!-- 管理者 Agent 悬浮窗：后台总闸开 ∧ 管理者角色；身份预览态隐藏（避免预览他人时误执行写操作） -->
    <ManagerAgentChat v-if="agentVisible" :tier="agentTier" :bucket="agentBucket" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { authApi, agentApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { useAppStore } from '../stores/app';
import ManagerAgentChat from '../components/ManagerAgentChat.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();

// 断点必须是真响应式的：以前写成 computed(() => window.innerWidth >= 768)，
// 而 innerWidth 不是响应式源，转屏/缩放窗口后侧边栏与底部导航不会切换；
// 当时为了「触发响应式更新」在 resize 回调里又 dispatch 了一个 resize，等于自触发死循环（栈溢出）
const isDesktop = ref(window.innerWidth >= 768);
const activeMenu = computed(() => {
  const path = route.path;
  if (path === '/') return '/';
  return '/' + path.split('/')[1];
});

// 首次登录强制改密
const pwdVisible = ref(false);
const pwdSaving = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });

function logout() {
  auth.logout();
  router.push('/login');
}

// 小助手悬浮窗：可见性与档位全部以服务端 /agent/config 为准（总闸 ∧（管理者 ∨ 员工档））
// 前端不再自己判角色：否则后台开了员工档，页面也不会给普通成员渲染入口
const agentVisibleFlag = ref(false);
const agentTier = ref<'manager' | 'member'>('manager');
const agentBucket = ref<'org' | 'project' | 'member'>('org');
const agentVisible = computed(() => agentVisibleFlag.value && !auth.isImpersonating);

/** 退出身份预览：恢复管理员登录态并整页刷新，确保各视图以管理员视角重新加载 */
function exitPreview() {
  auth.stopImpersonation();
  router.push('/admin');
  window.location.reload();
}

async function submitPwd() {
  if (!pwdForm.oldPassword) {
    ElMessage.warning('请输入当前密码');
    return;
  }
  if (pwdForm.newPassword.length < 6) {
    ElMessage.warning('新密码至少 6 位');
    return;
  }
  if (pwdForm.newPassword !== pwdForm.confirm) {
    ElMessage.warning('两次输入的新密码不一致');
    return;
  }
  pwdSaving.value = true;
  try {
    await authApi.changePassword({ oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword });
    if (auth.user) auth.user.mustChangePassword = false;
    localStorage.setItem('myorgniz_user', JSON.stringify(auth.user));
    pwdVisible.value = false;
    ElMessage.success('密码修改成功');
  } finally {
    pwdSaving.value = false;
  }
}

// 移动端底部导航：高频直达 5 项；消息入口保留顶部铃铛（避免重复），低频入口（项目/看板/复盘/知识库等）在首页底部快捷入口
const tabs: { path: string; label: string; icon: string; tab?: string }[] = [
  { path: '/', label: '首页', icon: 'HomeFilled' },
  { path: '/tasks', label: '任务', icon: 'List' },
  { path: '/reports', label: '日报', icon: 'Document' },
  { path: '/data-center', label: '资料', icon: 'Notebook', tab: 'sops' },
  { path: '/profile', label: '我的', icon: 'User' },
];

function onResize() {
  isDesktop.value = window.innerWidth >= 768;
}

function onUserCommand(cmd: string) {
  if (cmd === 'profile') router.push('/profile');
  if (cmd === 'logout') {
    auth.logout();
    app.stopPolling();
    router.push('/login');
  }
}

onMounted(async () => {
  window.addEventListener('resize', onResize);
  await auth.fetchMe().catch(() => undefined);
  // 首次登录（管理员创建的用户）强制修改密码；预览态下不弹窗打断排查
  if (!auth.isImpersonating && auth.user?.mustChangePassword) pwdVisible.value = true;
  app.startPolling();
  // 登录用户都拉一次 config（接口很轻：两次 Setting 主键查），由服务端判定可不可见、哪个档
  const cfg: any = await agentApi.getConfig().catch(() => null);
  agentVisibleFlag.value = !!cfg?.visible;
  if (cfg?.tier) agentTier.value = cfg.tier === 'member' ? 'member' : 'manager';
  if (cfg?.bucket) agentBucket.value = cfg.bucket;
});
onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  app.stopPolling();
});
</script>

<style scoped>
.shell {
  min-height: 100%;
}

.layout {
  display: flex;
  min-height: 100%;
}

/* 管理员身份预览横幅 */
.impersonate-bar {
  position: sticky;
  top: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fdf6ec;
  color: #b88230;
  border-bottom: 1px solid #f5dab1;
  padding: 8px 16px;
  font-size: 14px;
}
.imp-icon {
  font-size: 18px;
}
.imp-text {
  flex: 1;
  min-width: 0;
}

/* 预览态下将侧栏/顶部栏下移，避免被横幅遮挡 */
.imp-personating .sidebar {
  top: 42px;
  height: calc(100vh - 42px);
}
.imp-personating .header {
  top: 42px;
}
.imp-personating .content {
  padding-top: calc(var(--app-header-h) + 42px);
}
@media (min-width: 768px) {
  .imp-personating .content {
    padding-top: 0;
  }
}

/* PC 侧栏：深宝蓝，与页面深色页头形成统一结构色 */
.sidebar {
  width: 200px;
  flex-shrink: 0;
  background: linear-gradient(180deg, #0f3572 0%, #16417f 55%, #1b4fa8 100%);
  border-right: 1px solid #0c2b5e;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
}
.logo {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.02em;
  padding: 18px 20px;
}
.menu {
  border-right: none;
  flex: 1;
  /* 关键：允许该 flex 子项在侧栏内独立滚动，避免菜单项过多时把底部头像顶出可视区 */
  min-height: 0;
  overflow-y: auto;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: #c7d9f2;
  --el-menu-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-menu-active-color: #ffffff;
}
.menu :deep(.el-menu-item.is-active) {
  background: linear-gradient(90deg, rgba(66, 139, 255, 0.38), rgba(66, 139, 255, 0.12));
  box-shadow: inset 3px 0 0 #8cc2ff;
  font-weight: 600;
}
.sidebar-footer {
  flex-shrink: 0;
  padding: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px;
  border-radius: 8px;
  color: #dbe7f5;
}
.user-chip:hover {
  background: rgba(255, 255, 255, 0.08);
}

/* 移动端顶栏：深宝蓝，与 PC 侧栏保持一致 */
.header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--app-header-h);
  background: linear-gradient(135deg, #0f3572 0%, #123e86 40%, #1b4fa8 75%, #428bff 100%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  box-shadow: 0 2px 10px rgba(18, 62, 134, 0.28);
  z-index: 100;
}
.header-title {
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.02em;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.header-icon {
  font-size: 20px;
  cursor: pointer;
  color: #e8f1ff;
}
.header-avatar {
  cursor: pointer;
  background: #2f6fe0;
  color: #fff;
}

/* 内容区 */
.content {
  flex: 1;
  min-width: 0;
  padding-top: var(--app-header-h);
}

@media (min-width: 768px) {
  .content {
    padding-top: 0;
  }
}

/* 移动端底部导航：白底 + 深宝蓝选中态，保持轻量不抢内容 */
.tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(var(--app-tabbar-h) + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: #fff;
  border-top: 1px solid #dbe6f5;
  box-shadow: 0 -2px 10px rgba(18, 62, 134, 0.06);
  display: flex;
  z-index: 100;
}
.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: var(--fs-2xs);
  color: #7b8798;
}
.tab-item.active {
  color: #1b4fa8;
  font-weight: 600;
}
</style>
