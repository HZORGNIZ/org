<template>
  <div class="cw-page" v-loading="loading">
    <!-- 顶部：标题 + 周期选择 + 就绪度 -->
    <div class="page-card cw-head">
      <div class="cw-title-row">
        <h2 class="cw-title">公司 / 部门周报聚合</h2>
        <span class="muted">勾选参会成员，汇总其本周（含补发）各归属周报，直排「姓名 · 部门 · 内容」</span>
      </div>
      <div class="cw-bar">
        <div class="cw-period">
          <el-button-group size="small">
            <el-button :type="!isCustom ? 'primary' : ''" @click="pickThisWeek">本周</el-button>
            <el-button :type="isPrevWeek ? 'primary' : ''" @click="pickLastWeek">上一周</el-button>
          </el-button-group>
          <el-date-picker
            v-model="customDate"
            type="date"
            size="small"
            value-format="YYYY-MM-DD"
            placeholder="自选某周"
            style="width: 140px; margin-left: 8px"
            @change="pickCustom"
          />
          <span class="muted cw-week">{{ data?.weekLabel || '' }}</span>
        </div>
        <div class="cw-readiness">
          <span v-if="data" class="muted">
            就绪度
            <b :class="readinessClass">{{ data.readiness.submitted }}/{{ data.readiness.total }}</b>
            <span v-if="data.readiness.missing">（{{ data.readiness.missing }} 人未交）</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 参会成员勾选 -->
    <div class="page-card cw-participants" v-if="data">
      <div class="block-title-row">
        <span class="block-title">参会成员（{{ selectedIds.length }}/{{ candidates.length }}）</span>
        <div>
          <el-button size="small" text @click="selectAll">全选</el-button>
          <el-button size="small" text @click="clearSelection">清空</el-button>
        </div>
      </div>
      <el-checkbox-group v-model="selectedIds" class="cw-chk-group" @change="onSelectionChange">
        <el-checkbox v-for="c in candidates" :key="c.id" :value="c.id" class="cw-chk">
          {{ c.name }}<span class="muted">{{ c.departmentName ? `（${c.departmentName}）` : '' }}</span>
        </el-checkbox>
      </el-checkbox-group>
      <div v-if="!candidates.length" class="muted">没有可汇总的成员（仅管理员可看全司，部门负责人可看本部门及其项目成员）。</div>
    </div>

    <!-- AI 总结卡 -->
    <div class="page-card cw-summary" v-if="data">
      <div class="block-title-row">
        <span class="block-title">AI 总结</span>
        <div>
          <el-button v-if="summary" size="small" text :loading="summarizing" @click="genSummary(true)">重新总结</el-button>
          <el-button v-else size="small" type="primary" :loading="summarizing" @click="genSummary(false)">生成 AI 总结</el-button>
        </div>
      </div>
      <div v-if="summaryErr" class="muted cw-sum-err">{{ summaryErr }}</div>
      <div v-else-if="!summary" class="muted">尚未生成 AI 总结，点右上角按钮由 AI 汇总所勾选成员本周周报（总览 / 进展 / 下周 / 风险 / 需关注）。</div>
      <div v-else class="cw-sum-body">
        <p v-if="summary.overview" class="cw-overview">{{ summary.overview }}</p>
        <div v-if="summary.progress?.length" class="cw-sum-sec">
          <div class="cw-sum-h">本周进展</div>
          <ul><li v-for="(p, i) in summary.progress" :key="'p' + i">{{ p }}</li></ul>
        </div>
        <div v-if="summary.nextWeek?.length" class="cw-sum-sec">
          <div class="cw-sum-h">下周计划</div>
          <ul><li v-for="(p, i) in summary.nextWeek" :key="'n' + i">{{ p }}</li></ul>
        </div>
        <div v-if="summary.risks?.length" class="cw-sum-sec">
          <div class="cw-sum-h warn">风险与阻塞</div>
          <ul><li v-for="(p, i) in summary.risks" :key="'r' + i" class="warn-text">{{ p }}</li></ul>
        </div>
        <div v-if="summary.attention?.length" class="cw-sum-sec">
          <div class="cw-sum-h attn">需关注</div>
          <div v-for="(a, i) in summary.attention" :key="'a' + i" class="cw-attn-row">
            <b>{{ a.name }}</b>
            <span class="muted">{{ a.dept }}</span>
            <span>{{ a.point }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 成员周报聚合直排（公用组件） -->
    <div class="page-card cw-list" v-loading="loading">
      <div class="block-title-row">
        <span class="block-title">参会成员周报（{{ data?.total || 0 }}）</span>
        <span class="muted">部门负责人置顶，其余按部门归组；未提交者置底</span>
      </div>
      <MemberReportsAggregate :sections="data?.sections" empty-text="请选择参会成员后查看其本周周报。" />
      <div class="muted tip">聚合直排口径与项目周报一致：一人本周多份（项目/部门/个人）会拼接并标注归属；取数优先级 AI 润色 &gt; 原文 &gt; 结构化拼接。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { reportsApi } from '../api';
import MemberReportsAggregate from '../components/MemberReportsAggregate.vue';

const data = ref<any>(null);
const loading = ref(false);
const summarizing = ref(false);
const summary = ref<any>(null);
const summaryErr = ref('');

const customDate = ref<string>('');
const isCustom = computed(() => !!customDate.value);
const isPrevWeek = computed(() => !!customDate.value && customDate.value === dayjs().subtract(7, 'day').format('YYYY-MM-DD'));

const candidates = ref<any[]>([]);
const selectedIds = ref<string[]>([]);

const readinessClass = computed(() => {
  const r = data.value?.readiness;
  if (!r || !r.total) return '';
  return r.submitted >= r.total ? 'ready-full' : r.submitted === 0 ? 'ready-none' : 'ready-part';
});

async function load() {
  loading.value = true;
  try {
    const r = await reportsApi.weeklyAggregate(customDate.value || undefined, selectedIds.value.length ? selectedIds.value : undefined);
    data.value = r;
    summary.value = r?.summary || null;
    summaryErr.value = '';
    candidates.value = r?.candidates ?? [];
    // 首次加载（未显式勾选）用服务端返回的 selected 初始化选择，之后保留用户选择
    if (!selectedIds.value.length) {
      selectedIds.value = candidates.value.filter((c: any) => c.selected).map((c: any) => c.id);
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载周报聚合失败');
  } finally {
    loading.value = false;
  }
}

async function genSummary(refresh: boolean) {
  summarizing.value = true;
  summaryErr.value = '';
  try {
    const r = await reportsApi.weeklyAggregateSummary(
      customDate.value || undefined,
      selectedIds.value.length ? selectedIds.value : undefined,
      refresh,
    );
    if (r?.ok && r.summary) summary.value = r.summary;
    else summaryErr.value = r?.reason || 'AI 总结生成失败，可直接阅读下方成员周报';
  } catch (e: any) {
    summaryErr.value = e?.response?.data?.message || 'AI 总结生成失败';
  } finally {
    summarizing.value = false;
  }
}

function onSelectionChange() {
  load();
}
function selectAll() {
  selectedIds.value = candidates.value.map((c: any) => c.id);
  load();
}
function clearSelection() {
  selectedIds.value = [];
  load();
}

function pickThisWeek() {
  customDate.value = '';
  load();
}
function pickLastWeek() {
  customDate.value = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  load();
}
function pickCustom() {
  load();
}

onMounted(load);
</script>

<style scoped>
.cw-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page-card {
  background: #fff;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  padding: 14px 16px;
}
.cw-title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.cw-title {
  margin: 0;
  font-size: 18px;
}
.cw-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.cw-period {
  display: flex;
  align-items: center;
}
.cw-week {
  margin-left: 12px;
  font-size: 13px;
}
.ready-full { color: #67c23a; }
.ready-part { color: #e6a23c; }
.ready-none { color: #f56c6c; }
.block-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.block-title {
  font-weight: 600;
  font-size: 15px;
}
.cw-chk-group {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
}
.cw-chk {
  margin-right: 0;
}
.cw-sum-err { color: #e6a23c; margin: 6px 0; }
.cw-sum-body { margin-top: 8px; }
.cw-overview {
  margin: 0 0 10px;
  padding: 8px 10px;
  background: #f5f7fb;
  border-radius: 6px;
  line-height: 1.7;
  color: #303133;
}
.cw-sum-sec { margin-top: 10px; }
.cw-sum-h {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.cw-sum-h.warn { color: #e6a23c; }
.cw-sum-h.attn { color: #f56c6c; }
.cw-sum-sec ul {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
  font-size: 13px;
  color: #303133;
}
.warn-text { color: #b88230; }
.cw-attn-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
  line-height: 1.8;
}
.tip {
  margin-top: 10px;
  font-size: 12px;
}
</style>
