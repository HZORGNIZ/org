<template>
  <el-dialog
    :model-value="modelValue"
    title="全员补签"
    width="min(860px, 94vw)"
    align-center
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="mk-head">
      <el-input v-model="q" size="small" placeholder="搜姓名/部门（多音姓氏按本音归段，搜索可兜底）" clearable class="mk-search" />
      <span class="mk-count muted">
        已签到 <b>{{ stat.checked }}</b>/{{ stat.roster }} · 候选 {{ stat.total }} 人
      </span>
    </div>
    <div class="mk-tip muted">
      点姓名即为其补签，理由自动记为「{{ data?.selfOpen ? '管理员代签（签到窗口内）' : '管理员矩阵补签' }}」；
      不在本场名册的人会被同时加入参会名单。要写真实理由，请用下方考勤列表里的逐行「补签」。
    </div>

    <div v-loading="loading" class="mk-body">
      <template v-if="shown.length">
        <!-- 有关键词时不分段平铺，避免多音字归错段后搜不到人 -->
        <div v-if="keyword" class="mk-group">
          <div class="mk-grid">
            <div v-for="it in shown" :key="it.userId" v-bind="cellProps(it)" @click="pick(it)">
              <span class="mk-name ellipsis">{{ it.name }}</span>
              <span class="mk-dept ellipsis">{{ it.departmentNames.join('、') || '未归属' }}</span>
              <span v-if="badge(it)" class="mk-badge">{{ badge(it) }}</span>
            </div>
          </div>
        </div>
        <div v-for="g in groups" v-else :key="g.letter" class="mk-group">
          <div class="mk-letter">{{ g.letter }}<span class="mk-letter-n muted">{{ g.items.length }}</span></div>
          <div class="mk-grid">
            <div v-for="it in g.items" :key="it.userId" v-bind="cellProps(it)" @click="pick(it)">
              <span class="mk-name ellipsis">{{ it.name }}</span>
              <span class="mk-dept ellipsis">{{ it.departmentNames.join('、') || '未归属' }}</span>
              <span v-if="badge(it)" class="mk-badge">{{ badge(it) }}</span>
            </div>
          </div>
        </div>
      </template>
      <div v-else-if="!loading" class="muted mk-empty">{{ keyword ? '没有匹配的在职成员' : '暂无可补签的成员' }}</div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 全员补签矩阵：管理员 / 发起人 / 本场助教 / 部门主管按姓名拼音 A–Z 点选补签。
 * 取数一次拿全员（含本场签到状态与逐人权限标记），点一个签一个、就地置灰，支持连续点选。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { meetingsApi } from '../api';
import { groupByLetter } from '../utils/pinyin-order';

type Cell = {
  userId: string;
  name: string;
  departmentNames: string[];
  checked: boolean;
  method: string | null;
  operatorName: string | null;
  inRoster: boolean;
  canMakeup: boolean;
};

const props = defineProps<{ modelValue: boolean; meetingId: string }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 每成功补签一人通知一次，父层据此刷新详情与列表（父层自己做去抖） */
  (e: 'changed'): void;
}>();

const loading = ref(false);
const busy = ref(false);
const q = ref('');
const data = ref<any>(null);
const items = ref<Cell[]>([]);

const keyword = computed(() => q.value.trim());
const shown = computed(() => {
  const k = keyword.value;
  if (!k) return items.value;
  return items.value.filter((x) => x.name.includes(k) || x.departmentNames.some((d) => d.includes(k)));
});
const groups = computed(() => groupByLetter(shown.value));
const stat = computed(() => ({
  checked: data.value?.checked ?? items.value.filter((x) => x.checked).length,
  roster: data.value?.rosterCount ?? 0,
  total: items.value.length,
}));

async function load() {
  if (!props.meetingId) return;
  loading.value = true;
  try {
    const r: any = await meetingsApi.makeupCandidates(props.meetingId);
    data.value = r;
    items.value = (r?.items ?? []) as Cell[];
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '候选名单读取失败');
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.modelValue, props.meetingId],
  ([open]) => {
    if (open) {
      q.value = '';
      load();
    }
  },
  { immediate: true },
);

function cellProps(it: Cell) {
  const cls = it.checked ? (it.method === 'MAKEUP' ? 'made' : 'done') : it.canMakeup ? 'todo' : 'off';
  const tip = it.checked
    ? `${it.name} 已签到${it.method === 'MAKEUP' ? `（${it.operatorName ? `${it.operatorName} ` : ''}补签）` : ''}`
    : it.canMakeup
      ? `点击为 ${it.name} 补签${it.inRoster ? '' : '（同时加入本场名册）'}`
      : `${it.name} 不在你的部门名册，无权限补签`;
  return { class: ['mk-cell', cls], title: tip };
}

/** 名册外的人打个角标，点下去会改变参会人数，得让人看得见 */
function badge(it: Cell) {
  if (it.checked || it.inRoster) return '';
  return '+入册';
}

async function pick(it: Cell) {
  if (it.checked || busy.value) return;
  if (!it.canMakeup) {
    ElMessage.warning(`${it.name} 不在你的部门名册，无权限补签`);
    return;
  }
  busy.value = true;
  try {
    const r: any = await meetingsApi.makeupCheckin(props.meetingId, it.userId, '');
    it.checked = true;
    it.method = 'MAKEUP';
    it.inRoster = true;
    if (data.value) data.value.checked = (data.value.checked ?? 0) + 1;
    ElMessage.success(`${it.name} 已${r?.autoAdded ? '入册并' : ''}补签`);
    emit('changed');
  } catch (e: any) {
    // 失败常见于这场已经签过（别人刚扫了码）：拉一次最新状态，不把错误算在点错的人头上
    ElMessage.error(e?.response?.data?.message || `${it.name} 补签失败`);
    if (e?.response?.status === 400) await load();
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.mk-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.mk-search {
  flex: 1 1 220px;
}
.mk-count {
  font-size: 12px;
  white-space: nowrap;
}
.mk-count b {
  color: var(--el-color-primary);
}
.mk-tip {
  font-size: 12px;
  line-height: 1.5;
  margin: 6px 0 10px;
}
.mk-body {
  max-height: 62vh;
  overflow: auto;
  min-height: 120px;
}
.mk-group + .mk-group {
  margin-top: 4px;
}
.mk-letter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  color: var(--el-color-primary);
  padding: 6px 2px 4px;
  position: sticky;
  top: 0;
  background: var(--el-bg-color, #fff);
  z-index: 1;
}
.mk-letter-n {
  font-weight: 400;
  font-size: 12px;
}
.mk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 6px;
}
.mk-cell {
  position: relative;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 5px 6px;
  min-width: 0;
  cursor: pointer;
  background: #fff;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.mk-cell .mk-name {
  display: block;
  font-size: 13px;
  line-height: 1.3;
}
.mk-cell .mk-dept {
  display: block;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  line-height: 1.3;
}
.mk-cell.todo:hover {
  border-color: var(--el-color-warning);
  box-shadow: 0 0 0 1px var(--el-color-warning-lighter) inset;
}
.mk-cell.done {
  cursor: default;
  border-color: var(--el-color-success-light-5);
  background: var(--el-color-success-light-9);
}
.mk-cell.made {
  cursor: default;
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
}
.mk-cell.off {
  cursor: not-allowed;
  opacity: 0.5;
  background: var(--el-fill-color-light);
}
.mk-badge {
  position: absolute;
  right: 3px;
  top: 2px;
  font-size: 10px;
  color: var(--el-color-warning);
}
.mk-empty {
  padding: 24px 0;
  text-align: center;
}
</style>
