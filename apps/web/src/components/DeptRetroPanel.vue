<template>
  <div class="dept-retro">
    <!-- 发起条：周期选择 + 发起（负责人/共管人/管理员） -->
    <div v-if="canManage" class="page-card dr-head">
      <span class="dr-title">部门复盘</span>
      <span class="muted">按月发起；AI 会聚合当月任务/工时/日报周报/PBC/项目进展生成复盘稿，定稿后部门成员可见</span>
      <div class="dr-ops">
        <el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" style="width: 130px" />
        <el-button type="primary" size="small" :disabled="!period" @click="create">发起 {{ period }} 复盘</el-button>
      </div>
    </div>
    <div v-else class="page-card dr-head">
      <span class="dr-title">部门复盘</span>
      <span class="muted">部门复盘由负责人发起，定稿结论在此展示</span>
    </div>

    <!-- 复盘记录列表 -->
    <div class="page-card" v-loading="loading">
      <div v-if="!loading && !list.length" class="muted dr-empty">暂无部门复盘记录</div>
      <div v-for="r in list" :key="r.id" class="dr-card">
        <div class="dr-card-head">
          <b>{{ r.title }}</b>
          <el-tag size="small" effect="plain">{{ r.period }}</el-tag>
          <el-tag v-if="r.hasAi" size="small" type="primary" effect="plain">AI 稿已生成</el-tag>
          <el-tag v-if="r.finalContent" size="small" type="success" effect="dark">已定稿</el-tag>
          <span class="muted dr-meta">{{ r.departmentName }} · {{ r.creatorName }} 发起于 {{ fmt(r.createdAt, 'YYYY-MM-DD') }}</span>
        </div>

        <!-- AI 稿（负责人/管理员可见可编辑；成员不可见原文，只看定稿） -->
        <div v-if="r.canManage && r.aiContent && editId !== r.id" class="dr-block">
          <div class="dr-block-title">
            AI 复盘稿
            <el-button size="small" text type="primary" @click="startEdit(r)">以此为底稿写结论</el-button>
            <el-button size="small" text :loading="aiLoading === r.id" @click="regen(r)">重新生成</el-button>
          </div>
          <div class="markdown-box"><MarkdownView :content="r.aiContent" /></div>
        </div>

        <!-- 定稿结论（全员可见） -->
        <div v-if="r.finalContent && editId !== r.id" class="dr-block dr-final">
          <div class="dr-block-title">复盘结论（定稿）<span v-if="r.finalAt" class="muted">· {{ fmt(r.finalAt, 'YYYY-MM-DD HH:mm') }}</span></div>
          <div class="markdown-box"><MarkdownView :content="r.finalContent" /></div>
        </div>

        <!-- 编辑结论 -->
        <div v-if="editId === r.id" class="dr-block dr-final">
          <div class="dr-block-title">编辑复盘结论<span class="muted">保存定稿后部门成员可见</span></div>
          <el-input v-model="editDraft" type="textarea" :rows="10" placeholder="输入复盘结论（Markdown）" />
          <div class="dr-ops" style="margin-top: 8px">
            <el-button size="small" @click="editId = ''">取消</el-button>
            <el-button type="primary" size="small" :loading="saving" @click="saveFinal(r)">保存定稿</el-button>
          </div>
        </div>

        <!-- 操作行 -->
        <div v-if="r.canManage && !r.aiContent && editId !== r.id" class="dr-ops">
          <el-button type="success" size="small" :loading="aiLoading === r.id" @click="genAi(r)">AI 生成复盘</el-button>
          <span class="muted">聚合 {{ r.period }} 当月数据，约需 10~20 秒</span>
        </div>
        <div v-if="r.canManage && !r.finalContent && !r.aiContent && editId !== r.id" class="dr-ops">
          <el-button size="small" text type="warning" @click="startEdit(r)">不经 AI，直接写结论</el-button>
        </div>
        <div v-if="r.canManage && !r.finalContent && r.aiContent && editId !== r.id" class="dr-ops">
          <el-button size="small" type="warning" plain @click="startEdit(r)">写复盘结论（定稿后成员可见）</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { retrospectivesApi } from '../api';
import { fmt } from '../utils/format';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ departmentId: string; canManage: boolean }>();

const list = ref<any[]>([]);
const loading = ref(false);
const period = ref(dayjs().format('YYYY-MM'));
const aiLoading = ref('');
const editId = ref('');
const editDraft = ref('');
const saving = ref(false);

async function load() {
  loading.value = true;
  try {
    const all: any[] = await retrospectivesApi.deptList();
    list.value = all.filter((r) => r.departmentId === props.departmentId);
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (!props.canManage || !period.value) return;
  try {
    await retrospectivesApi.deptCreate(props.departmentId, { period: period.value });
    ElMessage.success(`${period.value} 部门复盘已发起`);
    load();
  } catch {
    /* 拦截器已提示（重复发起等） */
  }
}

async function genAi(r: any) {
  aiLoading.value = r.id;
  try {
    const updated: any = await retrospectivesApi.deptAi(r.id);
    Object.assign(r, updated);
    ElMessage.success('AI 复盘稿已生成，请审阅后定稿');
  } catch {
    /* 拦截器已提示 */
  } finally {
    aiLoading.value = '';
  }
}

function regen(r: any) {
  genAi(r);
}

function startEdit(r: any) {
  editId.value = r.id;
  editDraft.value = r.finalContent || r.aiContent || '';
}

async function saveFinal(r: any) {
  if (!editDraft.value.trim()) {
    ElMessage.warning('结论内容不能为空');
    return;
  }
  saving.value = true;
  try {
    const res: any = await retrospectivesApi.deptSaveConclusion(r.id, editDraft.value.trim());
    Object.assign(r, res);
    ElMessage.success('复盘结论已定稿，部门成员可见');
    editId.value = '';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.dr-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dr-title {
  font-size: 14px;
  font-weight: 500;
}
.dr-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.dr-empty {
  padding: 16px 0;
  text-align: center;
}
.dr-card {
  padding: 12px 4px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.dr-card:last-child {
  border-bottom: none;
}
.dr-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dr-meta {
  font-size: 12px;
  margin-left: auto;
}
.dr-block {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.dr-final {
  border-left: 3px solid var(--el-color-success);
}
.dr-block-title {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
