<template>
  <div class="page">
    <div class="page-title">
      大模型调用
      <el-button text type="primary" :loading="loading" @click="load">刷新</el-button>
    </div>

    <!-- 按天查看 -->
    <div class="page-card">
      <div class="toolbar">
        <el-button-group>
          <el-button @click="shiftDay(-1)">前一天</el-button>
          <el-button :disabled="isToday" @click="shiftDay(1)">后一天</el-button>
        </el-button-group>
        <el-date-picker
          v-model="date"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          placeholder="选择日期"
          class="date-picker"
          @change="load"
        />
        <el-button :disabled="isToday" @click="goToday">回到今天</el-button>
      </div>
      <div class="stats">
        <span class="muted">{{ date }} 共 {{ items.length }} 次调用</span>
        <el-tag v-for="s in byStatus" :key="s.key" :type="s.type" size="small" effect="plain">
          {{ s.label }} {{ s.count }}
        </el-tag>
      </div>
      <div v-if="byPrompt.length" class="stats">
        <span class="muted">功能分布</span>
        <el-tag v-for="p in byPrompt" :key="p.name" size="small" type="info" effect="plain">
          {{ p.label }} ×{{ p.count }}
        </el-tag>
      </div>
    </div>

    <!-- 当日调用列表 -->
    <div class="page-card">
      <div v-loading="loading">
        <div v-if="!items.length && !loading" class="empty muted">当日无大模型调用记录</div>
        <div v-for="it in items" :key="it.id" class="call-row" @click="openDetail(it.id)">
          <div class="call-head">
            <span class="call-time">{{ it.time.slice(11) }}</span>
            <el-tag size="small" class="prompt-tag">{{ it.promptName }}</el-tag>
            <span class="call-desc ellipsis">{{ it.description || '未标注功能' }}</span>
            <el-tag :type="statusMeta(it.status).type" size="small" effect="plain">
              {{ statusMeta(it.status).label }}
            </el-tag>
          </div>
          <div class="call-sub muted">
            {{ it.caller || '未知来源' }} · {{ it.model }}
            <template v-if="it.attempt > 1"> · 第 {{ it.attempt }}/3 次尝试</template>
            <template v-if="it.durationMs != null"> · 耗时 {{ fmtMs(it.durationMs) }}</template>
            <template v-if="it.promptTokens != null">
              · tokens {{ it.promptTokens }}→{{ it.completionTokens ?? 0 }}
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 单次调用详情 -->
    <el-drawer v-model="detailVisible" title="调用详情" size="min(920px, 96vw)">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <div class="meta-grid">
            <div><span class="muted">调用时间：</span>{{ detail.time }}</div>
            <div><span class="muted">调用缘由：</span>{{ detail.description || '未标注功能' }}</div>
            <div><span class="muted">提示词：</span>{{ detail.promptName }}</div>
            <div><span class="muted">调用来源：</span>{{ detail.caller || '未知' }}</div>
            <div><span class="muted">模型：</span>{{ detail.model }}</div>
            <div><span class="muted">尝试：</span>第 {{ detail.attempt }}/3 次</div>
            <div>
              <span class="muted">状态：</span>
              <el-tag :type="statusMeta(detail.status).type" size="small" effect="plain">
                {{ statusMeta(detail.status).label }}
              </el-tag>
            </div>
            <div><span class="muted">耗时：</span>{{ fmtMs(detail.durationMs) }}</div>
            <div v-if="detail.promptTokens != null">
              <span class="muted">tokens：</span>{{ detail.promptTokens }} → {{ detail.completionTokens ?? 0 }}
            </div>
            <div v-if="detail.finishReason"><span class="muted">finish_reason：</span>{{ detail.finishReason }}</div>
          </div>

          <div v-if="detail.error" class="detail-section">
            <div class="section-head"><span class="section-title">错误信息</span></div>
            <pre class="code-block error-block">{{ detail.error }}</pre>
          </div>

          <div class="detail-section">
            <div class="section-head">
              <span class="section-title">完整提示词</span>
              <el-button text type="primary" size="small" @click="copyText(detail.promptText, '提示词')">
                复制
              </el-button>
            </div>
            <pre class="code-block">{{ detail.promptText }}</pre>
          </div>

          <div class="detail-section">
            <div class="section-head">
              <span class="section-title">大模型返回结果</span>
              <el-button
                text
                type="primary"
                size="small"
                :disabled="!detail.response"
                @click="copyText(detail.response, '返回结果')"
              >
                复制
              </el-button>
            </div>
            <pre v-if="detail.response" class="code-block">{{ detail.response }}</pre>
            <div v-else class="muted">（本次调用无返回内容）</div>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { aiCallsApi } from '../api';

interface CallItem {
  id: string;
  time: string;
  promptName: string;
  description?: string | null;
  caller?: string | null;
  model: string;
  attempt: number;
  status: string;
  durationMs?: number | null;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  error?: string | null;
}

const STATUS_META: Record<string, { label: string; type: 'success' | 'warning' | 'info' | 'danger' }> = {
  SUCCESS: { label: '成功', type: 'success' },
  TRUNCATED: { label: '被截断', type: 'warning' },
  EMPTY: { label: '空返回', type: 'info' },
  ERROR: { label: '失败', type: 'danger' },
};

const date = ref(dayjs().format('YYYY-MM-DD'));
const items = ref<CallItem[]>([]);
const loading = ref(false);
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<any>(null);

const isToday = computed(() => date.value === dayjs().format('YYYY-MM-DD'));

const byStatus = computed(() => {
  const counts = new Map<string, number>();
  for (const it of items.value) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
  return Object.keys(STATUS_META)
    .filter((k) => counts.get(k))
    .map((k) => ({ key: k, ...STATUS_META[k], count: counts.get(k)! }));
});

const byPrompt = computed(() => {
  const counts = new Map<string, { label: string; count: number }>();
  for (const it of items.value) {
    const cur = counts.get(it.promptName);
    counts.set(it.promptName, { label: it.description || it.promptName, count: (cur?.count ?? 0) + 1 });
  }
  return [...counts.entries()].map(([name, v]) => ({ name, ...v }));
});

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, type: 'info' as const };
}

function fmtMs(ms: number | null | undefined) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function load() {
  loading.value = true;
  try {
    const res: any = await aiCallsApi.list(date.value);
    items.value = res?.items ?? [];
  } finally {
    loading.value = false;
  }
}

function shiftDay(n: number) {
  date.value = dayjs(date.value).add(n, 'day').format('YYYY-MM-DD');
  load();
}

function goToday() {
  date.value = dayjs().format('YYYY-MM-DD');
  load();
}

async function openDetail(id: string) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await aiCallsApi.detail(id);
  } finally {
    detailLoading.value = false;
  }
}

async function copyText(text: string | null | undefined, label: string) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // 非安全上下文（无 HTTPS）下 clipboard API 不可用，退回到 textarea 复制
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    ElMessage.success(`${label}已复制`);
  } catch {
    ElMessage.error('复制失败，请手动选择复制');
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.date-picker {
  width: 160px;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.stats + .stats {
  margin-top: 6px;
}
.call-row {
  padding: 10px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
}
.call-row:last-child {
  border-bottom: none;
}
.call-row:hover {
  background: #fafbfc;
}
.call-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.call-time {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  font-variant-numeric: tabular-nums;
}
.prompt-tag {
  font-family: Consolas, Monaco, monospace;
}
.call-desc {
  font-size: 14px;
  flex: 1;
  min-width: 60px;
}
.call-sub {
  margin-top: 3px;
  font-size: 12px;
}
.empty {
  text-align: center;
  padding: 30px 0;
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px 12px;
  font-size: 13px;
  margin-bottom: 16px;
}
.detail-section {
  margin-bottom: 16px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.section-title {
  font-weight: 600;
  font-size: var(--fs-lg);
}
.code-block {
  margin: 0;
  padding: 10px;
  background: #f7f8fa;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  font-family: Consolas, Monaco, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 40vh;
  overflow: auto;
}
.error-block {
  background: #fef0f0;
  border-color: #fde2e2;
  color: #f56c6c;
}
</style>
