<template>
  <div class="page">
    <div class="page-title">
      保密管理
      <el-button text type="primary" :loading="loading" @click="load">刷新</el-button>
    </div>

    <!-- 保密协议：全站共用一份模板，改写正文即生成新版本（签署记录到具体版本，事后可追溯） -->
    <div class="page-card">
      <div class="page-title">
        保密协议
        <el-tag size="small" type="info" effect="plain">当前版本 v{{ nda.version }}</el-tag>
      </div>
      <div class="muted tip">
        协议为全站一份通用模板，Markdown 正文。保密项目的成员进入项目时需在线签署；
        改版后已签署的成员不受影响（不强制重签），尚未签署的成员签的就是新版本。
      </div>
      <div class="nda-edit">
        <el-input
          v-model="ndaContent"
          type="textarea"
          :rows="14"
          placeholder="请填写保密协议正文（Markdown）"
          resize="vertical"
        />
        <div v-if="preview" class="nda-preview">
          <MarkdownView :content="ndaContent" />
        </div>
      </div>
      <div class="nda-bar">
        <el-button size="small" @click="preview = !preview">{{ preview ? '收起预览' : '预览效果' }}</el-button>
        <el-button size="small" @click="resetContent">还原为当前版本</el-button>
        <el-button size="small" type="primary" :loading="savingNda" @click="saveNda">保存为新版本</el-button>
      </div>
    </div>

    <!-- 保密项目访问留痕：进入保密项目详情、预览/下载其文件与文档都会落一条（含管理员） -->
    <div class="page-card">
      <div class="page-title">
        保密访问留痕
        <span class="muted log-count">近 {{ days }} 天共 {{ items.length }} 条</span>
      </div>
      <div class="toolbar">
        <el-select v-model="days" size="small" style="width: 120px" @change="loadLogs">
          <el-option label="近 1 天" :value="1" />
          <el-option label="近 7 天" :value="7" />
          <el-option label="近 30 天" :value="30" />
          <el-option label="近 90 天" :value="90" />
        </el-select>
        <el-select v-model="projectId" size="small" clearable placeholder="全部保密项目" style="width: 200px" @change="loadLogs">
          <el-option v-for="p in confidentialProjects" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <el-input
          v-model="userKeyword"
          size="small"
          clearable
          placeholder="按姓名筛选（本地）"
          style="width: 160px"
        />
      </div>
      <div v-loading="loadingLogs">
        <div v-if="!shown.length && !loadingLogs" class="empty muted">该时间段内没有保密项目的访问留痕</div>
        <div v-for="it in shown" :key="it.id" class="log-row">
          <div class="log-head">
            <span class="log-time">{{ it.time.slice(11) }}</span>
            <el-tag :type="ACTION_META[it.action]?.type ?? 'info'" size="small" effect="plain">
              {{ ACTION_META[it.action]?.label ?? it.action }}
            </el-tag>
            <span class="log-user">{{ it.userName }}</span>
            <el-tag size="small" type="info" effect="plain">{{ RES_META[it.resType] ?? it.resType }}</el-tag>
            <span class="log-name ellipsis">{{ it.resName }}</span>
          </div>
          <div class="log-sub muted">
            {{ it.time.slice(0, 10) }} · 项目：{{ projectName(it.projectId) }}
            <template v-if="it.ip"> · IP {{ it.ip }}</template>
            <template v-if="it.userAgent"> · {{ shortUa(it.userAgent) }}</template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { projectsApi } from '../api';
import MarkdownView from '../components/MarkdownView.vue';

const ACTION_META: Record<string, { label: string; type: 'success' | 'warning' | 'info' }> = {
  ENTER: { label: '进入详情', type: 'info' },
  VIEW: { label: '预览/阅读', type: 'success' },
  DOWNLOAD: { label: '下载', type: 'warning' },
};
const RES_META: Record<string, string> = {
  PROJECT: '项目',
  DOCFILE: '文档空间文件',
  KNOWLEDGE_DOC: '知识库文档',
};

const loading = ref(false);
const nda = ref<any>({ version: 1, content: '' });
const ndaContent = ref('');
const preview = ref(false);
const savingNda = ref(false);

const projects = ref<any[]>([]);
const items = ref<any[]>([]);
const loadingLogs = ref(false);
const days = ref(7);
const projectId = ref('');
const userKeyword = ref('');

/** 只列保密项目作为留痕过滤项 */
const confidentialProjects = computed(() => projects.value.filter((p) => p.confidential));

const shown = computed(() => {
  const kw = userKeyword.value.trim();
  if (!kw) return items.value;
  return items.value.filter((it) => String(it.userName || '').includes(kw));
});

function projectName(id?: string | null) {
  if (!id) return '—';
  return projects.value.find((p) => p.id === id)?.name ?? id;
}

/** 浏览器标识只留内核与版本，避免一行塞不下 */
function shortUa(ua: string) {
  return ua.length > 60 ? `${ua.slice(0, 60)}…` : ua;
}

/** 还原为当前生效版本（放弃本地未保存的修改） */
function resetContent() {
  ndaContent.value = nda.value.content ?? '';
  preview.value = false;
}

async function saveNda() {
  const text = ndaContent.value.trim();
  if (text.length < 20) {
    ElMessage.warning('协议正文过短，请至少填写一段完整条款');
    return;
  }
  savingNda.value = true;
  try {
    const r: any = await projectsApi.saveNdaTemplate(ndaContent.value);
    if (r?.changed) ElMessage.success(`已保存为协议 v${r.version}`);
    else ElMessage.info('正文与当前版本一致，未生成新版本');
    await loadNda();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败');
  } finally {
    savingNda.value = false;
  }
}

async function loadNda() {
  const cur = await projectsApi.ndaTemplate().catch(() => null);
  nda.value = cur ?? { version: 1, content: '' };
  ndaContent.value = nda.value.content ?? '';
}

async function loadLogs() {
  loadingLogs.value = true;
  try {
    items.value = await projectsApi
      .accessLogs({ days: String(days.value), limit: '500', projectId: projectId.value || undefined })
      .catch(() => []);
  } finally {
    loadingLogs.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    projects.value = await projectsApi.list().catch(() => []);
    await Promise.all([loadNda(), loadLogs()]);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.tip {
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 10px;
}
.nda-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nda-preview {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 12px 14px;
  background: #fbfcfe;
  max-height: 46vh;
  overflow: auto;
}
.nda-bar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.log-count {
  font-size: 12px;
  font-weight: 400;
}
.log-row {
  padding: 9px 4px;
  border-bottom: 1px solid #f5f7fa;
}
.log-row:last-child {
  border-bottom: none;
}
.log-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.log-time {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  font-variant-numeric: tabular-nums;
}
.log-user {
  font-size: 14px;
}
.log-name {
  font-size: 14px;
  flex: 1;
  min-width: 80px;
}
.log-sub {
  margin-top: 3px;
  font-size: 12px;
}
.empty {
  text-align: center;
  padding: 30px 0;
}
</style>
