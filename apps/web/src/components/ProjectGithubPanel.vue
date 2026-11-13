<template>
  <div class="page-card gh-card" v-loading="loading">
    <div class="block-title-row">
      <span class="block-title">GitHub 仓库信息</span>
      <div class="gh-actions">
        <el-button v-if="canManage" type="primary" size="small" @click="openForm(null)">
          <el-icon><Plus /></el-icon>&nbsp;添加仓库
        </el-button>
      </div>
    </div>

    <div class="gh-meta">
      <el-tag size="small" effect="plain">共 {{ items.length }} 个仓库</el-tag>
      <el-tag v-if="privateCount" size="small" type="warning" effect="plain">私有 {{ privateCount }}</el-tag>
      <el-tag v-if="items.length - privateCount" size="small" type="success" effect="plain">公开 {{ items.length - privateCount }}</el-tag>
      <el-tag size="small" type="info" effect="plain">仅项目成员 / 负责人 / 部门负责人 / 管理员可见</el-tag>
    </div>

    <div v-if="!items.length" class="muted gh-empty">
      还没有 GitHub 仓库记录。点右上角「添加仓库」登记第一个仓库（名称 / 地址 / 说明 / 备注），由项目负责人维护。
    </div>

    <el-table v-else :data="items" size="small" class="gh-table">
      <el-table-column label="仓库名称" min-width="150">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
        </template>
      </el-table-column>
      <el-table-column label="仓库地址" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <el-link type="primary" :href="row.url" target="_blank">{{ row.url }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="可见性" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.isPrivate ? 'warning' : 'success'" effect="plain">
            {{ row.isPrivate ? '私有' : '公开' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ row.desc || '-' }}</template>
      </el-table-column>
      <el-table-column label="备注" min-width="130" show-overflow-tooltip>
        <template #default="{ row }">{{ row.remark || '-' }}</template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" type="primary" @click="openForm(row)">编辑</el-button>
          <el-button text size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="muted gh-tip">
      GitHub 信息由项目负责人维护；仅项目成员、项目负责人、部门负责人与系统管理员可见（保密项目需先签协议）。
    </div>

    <el-dialog v-model="formVisible" :title="editing ? '编辑仓库' : '添加仓库'" width="min(96vw, 520px)" append-to-body destroy-on-close>
      <el-form label-position="top" size="small">
        <div class="gh-row">
          <el-form-item label="仓库名称" required class="half">
            <el-input v-model="form.name" maxlength="60" placeholder="如：myorgniz 主仓" />
          </el-form-item>
          <el-form-item label="可见性" class="half">
            <el-select v-model="form.isPrivate" style="width: 100%">
              <el-option label="私有仓库" :value="true" />
              <el-option label="公开仓库" :value="false" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="仓库地址" required>
          <el-input v-model="form.url" maxlength="300" placeholder="https://github.com/用户/仓库" />
        </el-form-item>
        <el-form-item label="说明（仓库内容 / 职责）">
          <el-input v-model="form.desc" type="textarea" :rows="2" maxlength="300" placeholder="简要说明这个仓库放什么、谁来维护" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="300" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="formVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { projectsApi } from '../api';

const props = withDefaults(
  defineProps<{
    projectId: string;
    /** 可维护（添加/编辑/删除）：系统管理员或项目负责人 */
    canManage?: boolean;
  }>(),
  { canManage: false },
);

const items = ref<any[]>([]);
const loading = ref(false);
const saving = ref(false);
const formVisible = ref(false);
const editing = ref<any>(null);
const form = reactive({
  name: '',
  url: '',
  desc: '',
  isPrivate: true,
  remark: '',
});

const privateCount = computed(() => items.value.filter((i) => i.isPrivate).length);

async function load() {
  loading.value = true;
  try {
    const r: any = await projectsApi.githubList(props.projectId);
    items.value = r?.items || [];
  } catch {
    ElMessage.error('GitHub 信息加载失败，请刷新重试');
  } finally {
    loading.value = false;
  }
}

function openForm(row?: any) {
  editing.value = row || null;
  Object.assign(form, {
    name: row?.name ?? '',
    url: row?.url ?? '',
    desc: row?.desc ?? '',
    isPrivate: row?.isPrivate ?? true,
    remark: row?.remark ?? '',
  });
  formVisible.value = true;
}

async function save() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写仓库名称');
    return;
  }
  if (!/^https:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/.*)?$/.test(form.url.trim())) {
    ElMessage.warning('仓库地址需为 https://github.com/用户/仓库 格式');
    return;
  }
  saving.value = true;
  const payload = {
    name: form.name.trim(),
    url: form.url.trim(),
    desc: form.desc.trim() || null,
    isPrivate: form.isPrivate,
    remark: form.remark.trim() || null,
  };
  try {
    if (editing.value) await projectsApi.githubUpdate(props.projectId, editing.value.id, payload);
    else await projectsApi.githubCreate(props.projectId, payload as any);
    ElMessage.success(editing.value ? '仓库信息已更新' : '仓库已添加');
    formVisible.value = false;
    await load();
  } catch {
    ElMessage.error('保存失败，请稍后重试');
  } finally {
    saving.value = false;
  }
}

async function remove(row: any) {
  await ElMessageBox.confirm(`确定删除仓库「${row.name}」？删除后不可恢复。`, '删除仓库', { type: 'warning' });
  try {
    await projectsApi.githubRemove(props.projectId, row.id);
    ElMessage.success('已删除');
    await load();
  } catch {
    ElMessage.error('删除失败，请稍后重试');
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<style scoped>
.gh-actions {
  display: flex;
  gap: 8px;
}
.gh-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.gh-empty {
  padding: 18px 0;
  font-size: 13px;
}
.gh-table {
  width: 100%;
}
.gh-tip {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.gh-row {
  display: flex;
  gap: 12px;
}
.gh-row .half {
  flex: 1;
  min-width: 0;
}
</style>
