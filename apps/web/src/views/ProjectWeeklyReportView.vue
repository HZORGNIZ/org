<template>
  <div class="weekly-page" v-loading="loading">
    <!-- 顶部：返回项目 + 标题 + 周期选择 + 就绪度 + 发起会议入口 -->
    <div class="page-card wp-head">
      <div class="wp-title-row">
        <el-button text @click="backToProject">
          <el-icon><ArrowLeft /></el-icon>&nbsp;返回项目
        </el-button>
        <h2 class="wp-title">{{ data?.projectName || '项目周报' }}</h2>
        <el-button type="primary" size="small" plain @click="createProjectMeeting">
          <el-icon><Plus /></el-icon>&nbsp;发起项目会议
        </el-button>
      </div>

      <div class="wp-bar">
        <div class="wp-period">
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
          <span class="muted wp-week">{{ data?.weekLabel || '' }}</span>
        </div>
        <div class="wp-readiness">
          <span v-if="data" class="muted">
            就绪度
            <b :class="readinessClass">{{ data.readiness.submitted }}/{{ data.readiness.total }}</b>
            <span v-if="data.readiness.missing">（{{ data.readiness.missing }} 人未交）</span>
          </span>
        </div>
      </div>
    </div>

    <!-- AI 总结卡 -->
    <div class="page-card wp-summary" v-if="data">
      <div class="block-title-row">
        <span class="block-title">AI 总结</span>
        <div>
          <el-button v-if="summary" size="small" text :loading="summarizing" @click="genSummary(true)">重新总结</el-button>
          <el-button v-else size="small" type="primary" :loading="summarizing" @click="genSummary(false)">生成 AI 总结</el-button>
        </div>
      </div>

      <div v-if="summaryErr" class="muted wp-sum-err">{{ summaryErr }}</div>
      <div v-else-if="!summary" class="muted">尚未生成 AI 总结，点右上角按钮由 AI 汇总本周全员周报（总览 / 进展 / 下周 / 风险 / 需关注）。</div>
      <div v-else class="wp-sum-body">
        <p v-if="summary.overview" class="wp-overview">{{ summary.overview }}</p>
        <div v-if="summary.progress?.length" class="wp-sum-sec">
          <div class="wp-sum-h">本周进展</div>
          <ul><li v-for="(p, i) in summary.progress" :key="'p' + i">{{ p }}</li></ul>
        </div>
        <div v-if="summary.nextWeek?.length" class="wp-sum-sec">
          <div class="wp-sum-h">下周计划</div>
          <ul><li v-for="(p, i) in summary.nextWeek" :key="'n' + i">{{ p }}</li></ul>
        </div>
        <div v-if="summary.risks?.length" class="wp-sum-sec">
          <div class="wp-sum-h warn">风险与阻塞</div>
          <ul><li v-for="(p, i) in summary.risks" :key="'r' + i" class="warn-text">{{ p }}</li></ul>
        </div>
        <div v-if="summary.attention?.length" class="wp-sum-sec">
          <div class="wp-sum-h attn">需关注</div>
          <div v-for="(a, i) in summary.attention" :key="'a' + i" class="wp-attn-row">
            <b>{{ a.name }}</b>
            <span class="muted">{{ a.dept }}</span>
            <span>{{ a.point }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 成员周报聚合直排（公用组件）：姓名 · 部门 · 角色 · 归属 · 内容 -->
    <div class="page-card wp-list" v-loading="loading">
      <div class="block-title-row">
        <span class="block-title">成员周报（{{ data?.total || 0 }}）</span>
        <span class="muted">部门负责人、项目负责人置顶，其余按部门归组；未提交者置底</span>
      </div>

      <MemberReportsAggregate :sections="data?.sections" empty-text="该项目还没有成员，先去项目页添加成员。" />
      <div class="muted tip">聚合直排：一屏看全员的「姓名 · 部门 · 内容」，与会议会前材料同一取数口径（AI 润色 &gt; 原文 &gt; 结构化拼接）。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { projectsApi } from '../api';
import MemberReportsAggregate from '../components/MemberReportsAggregate.vue';

const route = useRoute();
const router = useRouter();

const projectId = computed(() => String(route.params.id ?? ''));
const data = ref<any>(null);
const loading = ref(false);
const summarizing = ref(false);
const summary = ref<any>(null);
const summaryErr = ref('');

// 周期：customDate 为 YYYY-MM-DD；为空表示「本周」（不传 periodStart，服务端取本周）
const customDate = ref<string>('');
const isCustom = computed(() => !!customDate.value);
const isPrevWeek = computed(() => !!customDate.value && customDate.value === dayjs().subtract(7, 'day').format('YYYY-MM-DD'));

const readinessClass = computed(() => {
  const r = data.value?.readiness;
  if (!r || !r.total) return '';
  return r.submitted >= r.total ? 'ready-full' : r.submitted === 0 ? 'ready-none' : 'ready-part';
});

async function load() {
  if (!projectId.value) return;
  loading.value = true;
  try {
    const r = await projectsApi.weeklyReport(projectId.value, customDate.value || undefined);
    data.value = r;
    summary.value = r?.summary || null;
    summaryErr.value = '';
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载项目周报失败');
  } finally {
    loading.value = false;
  }
}

async function genSummary(refresh: boolean) {
  summarizing.value = true;
  summaryErr.value = '';
  try {
    const r = await projectsApi.weeklySummary(projectId.value, customDate.value || undefined, refresh);
    if (r?.ok && r.summary) summary.value = r.summary;
    else summaryErr.value = r?.reason || 'AI 总结生成失败，可直接阅读下方成员周报';
  } catch (e: any) {
    summaryErr.value = e?.response?.data?.message || 'AI 总结生成失败';
  } finally {
    summarizing.value = false;
  }
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

function backToProject() {
  router.push(`/projects/${projectId.value}`);
}
function createProjectMeeting() {
  router.push(`/meetings?create=PROJECT&projectId=${projectId.value}`);
}

onMounted(load);
</script>

<style scoped>
.weekly-page {
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
.wp-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wp-title {
  margin: 0;
  flex: 1;
  font-size: 18px;
}
.wp-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.wp-period {
  display: flex;
  align-items: center;
}
.wp-week {
  margin-left: 12px;
  font-size: 13px;
}
.readiness-full { color: #67c23a; }
.readiness-part { color: #e6a23c; }
.readiness-none { color: #f56c6c; }
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
.wp-sum-err { color: #e6a23c; margin: 6px 0; }
.wp-sum-body { margin-top: 8px; }
.wp-overview {
  margin: 0 0 10px;
  padding: 8px 10px;
  background: #f5f7fb;
  border-radius: 6px;
  line-height: 1.7;
  color: #303133;
}
.wp-sum-sec { margin-top: 10px; }
.wp-sum-h {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.wp-sum-h.warn { color: #e6a23c; }
.wp-sum-h.attn { color: #f56c6c; }
.wp-sum-sec ul {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
  font-size: 13px;
  color: #303133;
}
.warn-text { color: #b88230; }
.wp-attn-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
  line-height: 1.8;
}
.mate-doc {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 40px;
}
.mate-sec {
  border: 1px solid var(--app-border);
  border-left: 3px solid #4a7fd6;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
}
.mate-sec.nocontent {
  border-left-color: #dcdfe6;
  background: #fafafa;
}
.mate-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mate-name { font-size: 14px; }
.mate-sub-src { font-size: 12px; }
.mate-text {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
}
.tip {
  margin-top: 10px;
  font-size: 12px;
}
</style>
