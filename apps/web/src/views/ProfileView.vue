<template>
  <div class="page">
    <div class="page-title">个人中心</div>

    <div class="page-card profile">
      <el-avatar :size="64" :src="auth.user?.avatar || undefined" class="avatar">{{ auth.user?.name?.slice(0, 1) }}</el-avatar>
      <div class="profile-info">
        <div class="name">{{ auth.user?.name }}</div>
        <div class="muted">{{ auth.user?.email }}</div>
        <el-tag :type="auth.user?.role === 'ADMIN' ? 'danger' : 'info'" size="small" class="role-tag">
          {{ auth.user?.role === 'ADMIN' ? '管理员' : '成员' }}
        </el-tag>
      </div>
      <el-button type="danger" plain class="logout-btn" @click="logout">退出登录</el-button>
    </div>

    <div class="page-card">
      <div class="card-title">编辑资料</div>
      <el-form label-position="top" style="max-width: 420px">
        <el-form-item label="昵称">
          <el-input v-model="form.name" maxlength="30" />
        </el-form-item>
        <el-form-item label="头像">
          <!-- 内置卡通头像池：奇数男生版/偶数女生版，点头像即选中，保存后全站生效 -->
          <div class="avatar-picker">
            <button
              v-for="i in AVATAR_COUNT"
              :key="i"
              type="button"
              class="ap-tile"
              :class="{ on: form.avatar === avatarUrl(i) }"
              :title="i % 2 === 1 ? '男生款' : '女生款'"
              @click="form.avatar = avatarUrl(i)"
            >
              <img :src="avatarUrl(i)" :alt="'头像' + i" loading="lazy" />
            </button>
            <button type="button" class="ap-tile ap-none" :class="{ on: !form.avatar }" title="不显示头像（用姓名首字）" @click="form.avatar = ''">
              无
            </button>
          </div>
          <el-input v-model="form.avatar" placeholder="也可粘贴自定义图片链接 https://…（可选）" />
        </el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </el-form>
    </div>

    <div class="page-card">
      <div class="card-title">修改密码</div>
      <el-form label-position="top" style="max-width: 420px">
        <el-form-item label="当前密码">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码（至少 6 位）">
          <el-input v-model="pwdForm.newPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pwdForm.confirm" type="password" show-password @keyup.enter="changePwd" />
        </el-form-item>
        <el-button type="primary" :loading="pwdSaving" @click="changePwd">确认修改</el-button>
      </el-form>
    </div>

    <div class="page-card">
      <div class="card-title">集成状态</div>
      <div class="integ-row">
        <span>AI 服务</span>
        <el-tag :type="integration.ai?.enabled ? 'success' : 'info'" size="small">
          {{ integration.ai?.enabled ? '已启用' : '未配置' }}
        </el-tag>
      </div>
      <div v-for="s in integration.messageSources || []" :key="s.type" class="integ-row">
        <span>消息源：{{ s.name }}</span>
        <el-tag :type="s.connected ? 'success' : 'info'" size="small">
          {{ s.connected ? '已连接' : '未连接' }}
        </el-tag>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { authApi, integrationsApi, usersApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { useAppStore } from '../stores/app';

const router = useRouter();
const auth = useAuthStore();
const app = useAppStore();
const saving = ref(false);
const integration = ref<any>({});

/** 退出登录：清除本地登录态并回到登录页 */
async function logout() {
  try {
    await ElMessageBox.confirm('确定退出登录吗？', '退出登录', { type: 'warning', confirmButtonText: '退出' });
  } catch {
    return;
  }
  auth.logout();
  app.stopPolling();
  router.push('/login');
}

const form = reactive({
  name: auth.user?.name || '',
  avatar: auth.user?.avatar || '',
});

/** 内置头像池：apps/web/public/avatars/avatar_01..37.png（奇数=男，偶数=女） */
const AVATAR_COUNT = 37;
function avatarUrl(i: number) {
  return `/avatars/avatar_${String(i).padStart(2, '0')}.png`;
}

const pwdSaving = ref(false);
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' });

/** 个人主动修改密码 */
async function changePwd() {
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
    Object.assign(pwdForm, { oldPassword: '', newPassword: '', confirm: '' });
    ElMessage.success('密码修改成功');
  } finally {
    pwdSaving.value = false;
  }
}

async function save() {
  if (!form.name.trim()) {
    ElMessage.warning('昵称不能为空');
    return;
  }
  saving.value = true;
  try {
    await usersApi.updateMe({ name: form.name.trim(), avatar: form.avatar.trim() || undefined });
    await auth.fetchMe();
    ElMessage.success('已保存');
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  integration.value = await integrationsApi.status();
});
</script>

<style scoped>
.profile {
  display: flex;
  align-items: center;
  gap: 16px;
}
.logout-btn {
  margin-left: auto;
  flex-shrink: 0;
}
.avatar {
  background: var(--el-color-primary);
  color: #fff;
  font-size: 26px;
  flex-shrink: 0;
}
.name {
  font-size: 18px;
  font-weight: 600;
}
.role-tag {
  margin-top: 6px;
}
.card-title {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 14px;
}
.integ-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid #f5f7fa;
  font-size: 14px;
}
.integ-row:last-child {
  border-bottom: none;
}
.avatar-picker {
  display: grid;
  grid-template-columns: repeat(8, 44px);
  gap: 8px;
  margin-bottom: 10px;
}
.ap-tile {
  width: 44px;
  height: 44px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  background: #f5f7fa;
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.ap-tile img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.ap-tile:hover {
  border-color: var(--el-color-primary-light-5);
}
.ap-tile.on {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-3);
}
.ap-none {
  font-size: 13px;
  color: #909399;
}
@media (max-width: 640px) {
  .avatar-picker {
    grid-template-columns: repeat(6, 44px);
  }
}
</style>
