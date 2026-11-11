<template>
  <div class="page-card hw-card" v-loading="loading">
    <div class="block-title-row">
      <span class="block-title">硬件资产清单</span>
      <div class="hw-actions">
        <el-button v-if="canManage" type="primary" size="small" @click="openForm(null)">
          <el-icon><Plus /></el-icon>&nbsp;添加硬件
        </el-button>
      </div>
    </div>

    <div class="hw-meta">
      <el-tag size="small" effect="plain">共 {{ items.length }} 项</el-tag>
      <el-tag v-for="s in HW_STATUSES" :key="s.value" size="small" :type="s.tag" effect="plain">
        {{ s.label }} {{ countByStatus(s.value) }}
      </el-tag>
    </div>

    <div v-if="!items.length" class="muted hw-empty">
      还没有硬件记录。点右上角「添加硬件」登记第一个元件（名称 / 型号 / 说明 / 状态 / 保管人 / 备注）。
    </div>

    <el-table v-else :data="items" size="small" class="hw-table">
      <el-table-column label="元件名称" min-width="140">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
        </template>
      </el-table-column>
      <el-table-column label="型号" min-width="120">
        <template #default="{ row }">{{ row.model || '-' }}</template>
      </el-table-column>
      <el-table-column label="说明" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ row.desc || '-' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="130">
        <template #default="{ row }">
          <el-tag size="small" :type="statusOf(row.status)?.tag ?? 'info'" effect="plain">
            {{ statusOf(row.status)?.label ?? row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="保管人" width="120">
        <template #default="{ row }">
          <span v-if="row.keeper" class="hw-keeper">
            <el-avatar :size="20" :src="row.keeper.avatar || undefined">{{ (row.keeper.name || '?').slice(0, 1) }}</el-avatar>
            {{ row.keeper.name }}
          </span>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.remark || '-' }}</template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" type="primary" @click="openForm(row)">编辑</el-button>
          <el-button text size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="muted hw-tip">
      状态流转：待采购 → 采购中 → 已采购待领取 → 已分配 → 已归还；新建时保管人默认为项目组长，可按实际持有人调整。
    </div>

    <el-dialog v-model="formVisible" :title="editing ? '编辑硬件' : '添加硬件'" width="min(96vw, 520px)" append-to-body destroy-on-close>
      <el-form label-position="top" size="small">
        <div class="hw-row">
          <el-form-item label="元件名称" required class="half">
            <el-input v-model="form.name" maxlength="60" placeholder="如：STM32 主控板" />
          </el-form-item>
          <el-form-item label="型号" class="half">
            <el-input v-model="form.model" maxlength="80" placeholder="如：STM32F407VET6" />
          </el-form-item>
        </div>
        <el-form-item label="说明（是什么 / 用途）">
          <el-input v-model="form.desc" type="textarea" :rows="2" maxlength="300" placeholder="简要说明这个元件是什么、用来做什么" />
        </el-form-item>
        <div class="hw-row">
          <el-form-item label="状态" class="half">
            <el-select v-model="form.status" style="width: 100%">
              <el-option v-for="s in HW_STATUSES" :key="s.value" :label="s.label" :value="s.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="保管人" class="half">
            <el-select v-model="form.keeperId" clearable filterable style="width: 100%">
              <el-option v-for="u in keeperOptions" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
        </div>
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
    /** 可管理（添加/编辑/删除）：系统管理员或项目负责人 */
    canManage?: boolean;
    /** 项目负责人（新建硬件时保管人默认值） */
    owner?: any;
    /** 全员名单（保管人下拉） */
    users?: any[];
  }>(),
  { canManage: false, owner: null, users: () => [] },
);

type HwStatus = { value: string; label: string; tag: 'info' | 'warning' | 'primary' | 'success' };
const HW_STATUSES: HwStatus[] = [
  { value: 'TO_PURCHASE', label: '待采购', tag: 'warning' },
  { value: 'PURCHASING', label: '采购中', tag: 'warning' },
  { value: 'PURCHASED_PENDING', label: '已采购待领取', tag: 'primary' },
  { value: 'ASSIGNED', label: '已分配', tag: 'success' },
  { value: 'RETURNED', label: '已归还', tag: 'info' },
];
const statusOf = (v: string) => HW_STATUSES.find((s) => s.value === v);

const items = ref<any[]>([]);
const loading = ref(false);
const saving = ref(false);
const formVisible = ref(false);
const editing = ref<any>(null);
const form = reactive({
  name: '',
  model: '',
  desc: '',
  status: 'TO_PURCHASE',
  keeperId: '' as string,
  remark: '',
});

/** 保管人下拉：项目负责人排最前 + 全员 */
const keeperOptions = computed(() => {
  const list = [...(props.users ?? [])];
  const o = props.owner;
  if (o?.id && !list.some((u) => u.id === o.id)) list.unshift({ id: o.id, name: `${o.name}（组长）` });
  return list;
});

const countByStatus = (v: string) => items.value.filter((i) => i.status === v).length;

async function load() {
  loading.value = true;
  try {
    const r: any = await projectsApi.hardwareList(props.projectId);
    items.value = r?.items || [];
  } catch {
    ElMessage.error('硬件清单加载失败，请刷新重试');
  } finally {
    loading.value = false;
  }
}

function openForm(row?: any) {
  editing.value = row || null;
  Object.assign(form, {
    name: row?.name ?? '',
    model: row?.model ?? '',
    desc: row?.desc ?? '',
    status: row?.status ?? 'TO_PURCHASE',
    // 新建时保管人默认项目组长；编辑时保留原保管人
    keeperId: row?.keeperId ?? props.owner?.id ?? '',
    remark: row?.remark ?? '',
  });
  formVisible.value = true;
}

async function save() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写元件名称');
    return;
  }
  saving.value = true;
  const payload = {
    name: form.name.trim(),
    model: form.model.trim() || null,
    desc: form.desc.trim() || null,
    status: form.status,
    keeperId: form.keeperId || null,
    remark: form.remark.trim() || null,
  };
  try {
    if (editing.value) await projectsApi.hardwareUpdate(props.projectId, editing.value.id, payload);
    else await projectsApi.hardwareCreate(props.projectId, payload as any);
    ElMessage.success(editing.value ? '硬件已更新' : '硬件已添加');
    formVisible.value = false;
    await load();
  } catch {
    ElMessage.error('保存失败，请稍后重试');
  } finally {
    saving.value = false;
  }
}

async function remove(row: any) {
  await ElMessageBox.confirm(`确定删除硬件「${row.name}」？删除后不可恢复。`, '删除硬件', { type: 'warning' });
  try {
    await projectsApi.hardwareRemove(props.projectId, row.id);
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
.hw-actions {
  display: flex;
  gap: 8px;
}
.hw-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.hw-empty {
  padding: 18px 0;
  font-size: 13px;
}
.hw-table {
  width: 100%;
}
.hw-keeper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hw-tip {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.hw-row {
  display: flex;
  gap: 12px;
}
.hw-row .half {
  flex: 1;
  min-width: 0;
}
</style>
