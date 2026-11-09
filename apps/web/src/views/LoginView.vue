<template>
  <div class="login-page">
    <div class="login-box">
      <div class="logo">My<span>Org</span>Niz</div>
      <div class="slogan">团队 AI 协作系统 · 公告 / 任务 / 日报 / 知识库</div>

      <el-radio-group v-model="mode" class="mode-switch">
        <el-radio-button value="login">登 录</el-radio-button>
        <el-radio-button value="register">注 册</el-radio-button>
      </el-radio-group>

      <!-- 登录 -->
      <el-form v-if="mode === 'login'" :model="form" size="large" @submit.prevent="login">
        <el-form-item>
          <el-input v-model="form.account" placeholder="邮箱 / 用户名" autocomplete="username">
            <template #prefix><el-icon><Message /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            show-password
            autocomplete="current-password"
            @keyup.enter="login"
          >
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-button type="primary" size="large" class="submit" :loading="loading" @click="login">
          登 录
        </el-button>
      </el-form>

      <!-- 注册 -->
      <el-form v-else :model="regForm" size="large" label-position="top" @submit.prevent="register">
        <el-form-item label="用户名" required>
          <el-input v-model="regForm.username" placeholder="登录用户名（2-20 位字母/数字/下划线）" maxlength="20" autocomplete="username">
            <template #prefix><el-icon><UserFilled /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="真实姓名" required>
          <el-input v-model="regForm.name" placeholder="请输入真实姓名（团队内可见）" maxlength="30">
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="邮箱" required>
          <el-input v-model="regForm.email" placeholder="工作邮箱" autocomplete="email">
            <template #prefix><el-icon><Message /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="手机号" required>
          <el-input v-model="regForm.phone" placeholder="手机号（团队通讯用）" maxlength="20">
            <template #prefix><el-icon><Iphone /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="密码（至少 6 位）" required>
          <el-input
            v-model="regForm.password"
            type="password"
            placeholder="设置密码"
            show-password
            autocomplete="new-password"
          >
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="确认密码" required>
          <el-input
            v-model="regForm.confirm"
            type="password"
            placeholder="再次输入密码"
            show-password
            autocomplete="new-password"
            @keyup.enter="register"
          >
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-button type="primary" size="large" class="submit" :loading="loading" @click="register">
          注册并登录
        </el-button>
        <div class="muted reg-note">注册后为普通成员，可参与项目与任务协作</div>
      </el-form>

      <!-- 外部访客：先点「文档空间」再输入密码（不显眼入口） -->
      <el-divider content-position="center">
        <span class="guest-divider">外部访客</span>
      </el-divider>

      <div v-if="!guest.revealed" class="guest-entry">
        <div class="muted guest-lead">收到分享密码的访客，可进入文档空间查看并下载对外文档</div>
        <el-button size="default" class="submit" @click="guest.revealed = true">文档空间</el-button>
      </div>

      <el-form v-else-if="!guest.unlocked" size="default" @submit.prevent="guestUnlock">
        <el-form-item>
          <el-input
            v-model="guest.password"
            type="password"
            placeholder="输入访问密码查看可下载文档"
            show-password
            autocomplete="off"
            @keyup.enter="guestUnlock"
          >
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-button size="default" class="submit" :loading="guest.checking" @click="guestUnlock">
          访问文档
        </el-button>
        <div v-if="guest.checked && !guest.files.length" class="muted guest-tip">
          密码错误，或暂无对外公开的文档
        </div>
      </el-form>

      <div v-else class="guest-docs">
        <div class="guest-docs-head">
          <b>可下载文档（{{ guest.files.length }}）</b>
          <el-button text size="small" @click="guestReset">重新输入密码</el-button>
        </div>
        <div v-for="f in guest.files" :key="f.id" class="guest-doc-row">
          <div class="guest-doc-main">
            <el-icon class="guest-doc-icon"><Document /></el-icon>
            <div class="guest-doc-info">
              <div class="ellipsis guest-doc-name" :title="f.name">{{ f.name }}</div>
              <div class="muted guest-doc-meta">
                <template v-if="f.project?.name">{{ f.project.name }} · </template>
                {{ formatBytes(f.size) }} · {{ fmtShort(f.updatedAt) }}
                <template v-if="f.externalExpiresAt"> · 有效期至 {{ fmtShort(f.externalExpiresAt) }}</template>
              </div>
            </div>
          </div>
          <el-button size="small" type="primary" :loading="guest.downloadingId === f.id" @click="guestDownload(f)">
            下载
          </el-button>
        </div>
      </div>
    </div>

    <!-- 底部备案号：登录/注册页也对外的首页，点击跳转工信部备案管理系统 -->
    <footer class="login-beian">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备2026081809号-2</a>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { authApi, publicApi } from '../api';
import { formatBytes, fmtShort } from '../utils/format';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const mode = ref<'login' | 'register'>('login');
const loading = ref(false);

const form = reactive({ account: '', password: '' });
const regForm = reactive({ username: '', name: '', email: '', phone: '', password: '', confirm: '' });

/** 登录/注册后去哪里：优先 redirect 参数（从 /mobile 被踢回来的就回 /mobile）；只收站内相对路径 */
function loginTarget() {
  const raw = String(route.query.redirect ?? '');
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

async function login() {
  if (!form.account || !form.password) {
    ElMessage.warning('请输入账号和密码');
    return;
  }
  loading.value = true;
  try {
    const { accessToken, user } = await authApi.login(form.account, form.password);
    auth.setAuth(accessToken, user);
    ElMessage.success(`欢迎回来，${user.name}`);
    // replace：登录页不留在历史栈里，以免手机上按返回又回到登录页
    router.replace(loginTarget());
  } finally {
    loading.value = false;
  }
}

async function register() {
  const username = regForm.username.trim();
  const name = regForm.name.trim();
  const email = regForm.email.trim();
  const phone = regForm.phone.trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) {
    ElMessage.warning('用户名需 2-20 位字母/数字/下划线');
    return;
  }
  if (name.length < 2) {
    ElMessage.warning('请输入真实姓名（至少 2 个字符）');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ElMessage.warning('请输入有效的邮箱地址');
    return;
  }
  if (!phone) {
    ElMessage.warning('请输入手机号');
    return;
  }
  if (regForm.password.length < 6) {
    ElMessage.warning('密码至少 6 位');
    return;
  }
  if (regForm.password !== regForm.confirm) {
    ElMessage.warning('两次输入的密码不一致');
    return;
  }
  loading.value = true;
  try {
    const { accessToken, user } = await authApi.register({ username, name, email, phone, password: regForm.password });
    auth.setAuth(accessToken, user);
    ElMessage.success(`注册成功，欢迎 ${user.name}`);
    router.replace(loginTarget());
  } finally {
    loading.value = false;
  }
}

// ---------- 外部访客：全局密码访问文档 ----------
const guest = reactive({
  revealed: false,
  password: '',
  checking: false,
  checked: false,
  unlocked: false,
  files: [] as any[],
  downloadingId: '',
});

async function guestUnlock() {
  const pwd = guest.password.trim();
  if (!pwd) {
    ElMessage.warning('请输入访问密码');
    return;
  }
  guest.checking = true;
  try {
    const res = await publicApi.searchDocs(pwd);
    guest.files = res.files || [];
    guest.unlocked = guest.files.length > 0;
    guest.checked = true;
  } catch {
    guest.files = [];
    guest.unlocked = false;
    guest.checked = true;
  } finally {
    guest.checking = false;
  }
}

function guestReset() {
  guest.unlocked = false;
  guest.checked = false;
  guest.files = [];
}

async function guestDownload(f: any) {
  guest.downloadingId = f.id;
  try {
    const blob = await publicApi.content(f.id, guest.password.trim());
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    ElMessage.error('下载失败，请重新输入密码');
  } finally {
    guest.downloadingId = '';
  }
}
</script>

<style scoped>
.login-page {
  position: relative;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #e8f0fe 0%, #edf2fa 60%);
  padding: 20px;
  overflow-y: auto;
}
/* 底部备案号：弱化存在的浅灰小字，固定悬于页面底部 */
.login-beian {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12px;
  text-align: center;
  font-size: 12px;
}
.login-beian a {
  color: #9aa5b4;
  text-decoration: none;
}
.login-beian a:hover {
  color: var(--app-brand);
  text-decoration: underline;
}
.login-box {
  width: min(92vw, 400px);
  background: #fff;
  border-radius: 16px;
  padding: 36px 28px;
  box-shadow: 0 8px 30px rgba(66, 139, 255, 0.14);
}
.logo {
  font-size: 30px;
  font-weight: 800;
  text-align: center;
  color: var(--el-color-primary);
}
.logo span {
  color: #303133;
}
.slogan {
  text-align: center;
  color: #909399;
  font-size: 13px;
  margin: 8px 0 18px;
}
.mode-switch {
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}
.submit {
  width: 100%;
}
.reg-note {
  text-align: center;
  font-size: 12px;
  margin-top: 10px;
}
.guest-divider {
  color: #a8abb2;
  font-size: 12px;
}
.guest-entry {
  text-align: center;
}
.guest-lead {
  font-size: 12px;
  margin-bottom: 10px;
}
.guest-tip {
  text-align: center;
  font-size: 12px;
  margin-top: 10px;
}
.guest-docs {
  margin-top: 6px;
  max-height: 46vh;
  overflow-y: auto;
}
.guest-docs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 14px;
}
.guest-doc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border: 1px solid #f0f2f5;
  border-radius: 8px;
  margin-bottom: 6px;
}
.guest-doc-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.guest-doc-icon {
  color: var(--el-color-primary);
  flex-shrink: 0;
}
.guest-doc-info {
  min-width: 0;
}
.guest-doc-name {
  font-size: 13px;
  font-weight: 500;
}
.guest-doc-meta {
  font-size: 12px;
  margin-top: 2px;
}
.hint {
  text-align: center;
  margin-top: 16px;
}
</style>
