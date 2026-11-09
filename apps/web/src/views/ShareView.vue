<template>
  <div class="share-page">
    <div class="share-box">
      <div class="share-logo">My<span>Org</span>Niz</div>

      <!-- 加载中 -->
      <div v-if="loadingProject" class="muted center">正在加载…</div>

      <!-- 项目不存在 -->
      <div v-else-if="projectMissing" class="center">
        <el-empty description="链接无效或该项目已不存在" />
        <el-button type="primary" @click="$router.push('/login')">前往登录</el-button>
      </div>

      <!-- 正常：项目名 + 密码访问 -->
      <template v-else>
        <div class="share-project">{{ project?.name }}</div>
        <div class="muted center">该空间提供了对外可见的文档，请输入访问密码查看</div>

        <!-- 密码输入 -->
        <el-form v-if="!unlocked" class="pwd-form" @submit.prevent="unlock">
          <el-form-item>
            <el-input
              v-model="password"
              type="password"
              size="large"
              placeholder="访问密码"
              show-password
              autocomplete="off"
              @keyup.enter="unlock"
            >
              <template #prefix><el-icon><Lock /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-button type="primary" size="large" class="submit" :loading="checking" @click="unlock">
            访问文档
          </el-button>
          <div v-if="checked && !files.length" class="muted tip">密码错误，或该项目下没有与此密码匹配的对外文档</div>
        </el-form>

        <!-- 已解锁：文档下载列表 -->
        <div v-else class="docs">
          <div class="docs-head">
            <b>对外文档（{{ files.length }}）</b>
            <el-button text size="small" @click="reset">重新输入密码</el-button>
          </div>
          <div v-if="!files.length" class="muted center">没有可下载的文档</div>
          <div v-for="f in files" :key="f.id" class="doc-row">
            <div class="doc-main">
              <el-icon class="doc-icon"><Document /></el-icon>
              <div class="doc-info">
                <div class="ellipsis doc-name" :title="f.name">{{ f.name }}</div>
                <div class="muted doc-meta">
                  {{ formatBytes(f.size) }} · {{ fmtShort(f.updatedAt) }}
                  <template v-if="f.externalExpiresAt"> · 有效期至 {{ fmtShort(f.externalExpiresAt) }}</template>
                  <template v-if="f.note"> · {{ f.note }}</template>
                </div>
              </div>
            </div>
            <el-button size="small" type="primary" :loading="downloadingId === f.id" @click="download(f)">
              下载
            </el-button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { publicApi } from '../api';
import { formatBytes, fmtShort } from '../utils/format';

const route = useRoute();
const projectId = String(route.params.projectId || '');

const loadingProject = ref(true);
const projectMissing = ref(false);
const project = ref<any>(null);

const password = ref('');
const checking = ref(false);
const checked = ref(false);
const unlocked = ref(false);
const files = ref<any[]>([]);
const downloadingId = ref('');

onMounted(async () => {
  if (!projectId) {
    projectMissing.value = true;
    loadingProject.value = false;
    return;
  }
  try {
    project.value = await publicApi.project(projectId);
  } catch {
    projectMissing.value = true;
  } finally {
    loadingProject.value = false;
  }
});

async function unlock() {
  const pwd = password.value.trim();
  if (!pwd) {
    ElMessage.warning('请输入访问密码');
    return;
  }
  checking.value = true;
  try {
    const res = await publicApi.docs(projectId, pwd);
    files.value = res.files || [];
    unlocked.value = files.value.length > 0;
    checked.value = true;
  } catch {
    files.value = [];
    unlocked.value = false;
    checked.value = true;
  } finally {
    checking.value = false;
  }
}

function reset() {
  unlocked.value = false;
  checked.value = false;
  files.value = [];
}

async function download(f: any) {
  downloadingId.value = f.id;
  try {
    const blob = await publicApi.content(f.id, password.value.trim());
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
    downloadingId.value = '';
  }
}
</script>

<style scoped>
.share-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #e8f0fe 0%, #edf2fa 60%);
  padding: 20px;
  overflow-y: auto;
}
.share-box {
  width: min(94vw, 560px);
  background: #fff;
  border-radius: 16px;
  padding: 32px 24px;
  box-shadow: 0 8px 30px rgba(66, 139, 255, 0.14);
}
.share-logo {
  font-size: 26px;
  font-weight: 800;
  text-align: center;
  color: #303133;
  margin-bottom: 8px;
}
.share-logo span {
  color: var(--el-color-primary);
}
.share-project {
  font-size: 19px;
  font-weight: 700;
  text-align: center;
  margin: 10px 0 6px;
}
.center {
  text-align: center;
}
.muted {
  color: #909399;
  font-size: 13px;
}
.pwd-form {
  margin-top: 20px;
}
.submit {
  width: 100%;
}
.tip {
  margin-top: 12px;
  text-align: center;
}
.docs {
  margin-top: 18px;
}
.docs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.doc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 8px;
  border: 1px solid #f0f2f5;
  border-radius: 8px;
  margin-bottom: 8px;
}
.doc-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.doc-icon {
  color: var(--el-color-primary);
  flex-shrink: 0;
}
.doc-info {
  min-width: 0;
}
.doc-name {
  font-size: 14px;
  font-weight: 500;
}
.doc-meta {
  font-size: 12px;
  margin-top: 2px;
}
</style>
