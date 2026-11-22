<template>
  <el-dialog v-model="visible" :title="item?.name ?? '文档预览'" width="78%" top="4vh" destroy-on-close @closed="cleanup">
    <div v-loading="loading" class="docpv-body">
      <!-- PDF：iframe 内嵌翻页 -->
      <iframe v-if="previewKind === 'pdf' && blobUrl" :src="blobUrl" class="docpv-frame" title="pdf preview" />

      <!-- 图片：直接展示 -->
      <div v-else-if="previewKind === 'image' && blobUrl" class="docpv-center">
        <img :src="blobUrl" :alt="item?.name" class="docpv-img" />
      </div>

      <!-- docx：复用后端转换 HTML -->
      <div v-else-if="previewKind === 'docx' && docxHtml" class="docpv-docx" v-html="docxHtml" />

      <!-- 在线文档（KnowledgeDoc）：Markdown 渲染 -->
      <MarkdownView v-else-if="item?.kind === 'doc' && mdText" :content="mdText" />

      <!-- 纯文本 / csv：文本直出，csv 做简单表格化 -->
      <template v-else-if="previewKind === 'text' && textContent !== null">
        <table v-if="isCsv && csvRows.length" class="docpv-csv">
          <tr v-for="(r, ri) in csvRows.slice(0, 300)" :key="ri" :class="{ head: ri === 0 }">
            <td v-for="(c, ci) in r" :key="ci">{{ c }}</td>
          </tr>
        </table>
        <pre v-else class="docpv-text">{{ textContent }}</pre>
      </template>

      <!-- xlsx 等：暂不支持解析，引导下载 -->
      <div v-else-if="!loading" class="docpv-center docpv-fallback">
        <p>该格式暂不支持在线预览，可下载后查看。</p>
        <el-button type="primary" @click="download">下载文件</el-button>
      </div>
    </div>

    <template #footer>
      <span class="docpv-meta">{{ metaText }}</span>
      <el-button @click="visible = false">关闭</el-button>
      <el-button v-if="item?.kind === 'file'" type="primary" @click="download">下载</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import MarkdownView from './MarkdownView.vue';
import { documentsApi, knowledgeApi } from '../api';

export type DocPreviewItem = {
  kind: 'file' | 'doc';
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  uploaderName?: string;
  updatedAt?: string;
  previewKind?: string;
};

const props = defineProps<{ modelValue: boolean; item: DocPreviewItem | null }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const loading = ref(false);
const blobUrl = ref('');
const docxHtml = ref('');
const mdText = ref('');
const textContent = ref<string | null>(null);

const previewKind = computed(() => props.item?.previewKind ?? 'none');
const isCsv = computed(() => /\.(csv)$/i.test(props.item?.name ?? ''));

const csvRows = computed<string[][]>(() => {
  if (!isCsv.value || textContent.value === null) return [];
  return textContent.value
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 300)
    .map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
});

const metaText = computed(() => {
  const it = props.item;
  if (!it) return '';
  const size = it.size ? (it.size > 1024 * 1024 ? `${(it.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(it.size / 1024))}KB`) : '';
  const time = it.updatedAt ? it.updatedAt.slice(0, 10) : '';
  return [size, it.uploaderName, time].filter(Boolean).join(' · ');
});

watch(
  () => [props.modelValue, props.item?.id] as const,
  async ([open, id]) => {
    if (!open || !id || !props.item) return;
    await load();
  },
);

async function load() {
  const it = props.item!;
  if (!it) return;
  loading.value = true;
  blobUrl.value = '';
  docxHtml.value = '';
  mdText.value = '';
  textContent.value = null;
  try {
    if (it.kind === 'doc') {
      // 在线文档：直接拉 Markdown 正文渲染
      const r: any = await knowledgeApi.get(it.id);
      mdText.value = r?.content ?? r?.doc?.content ?? '';
      return;
    }
    if (previewKind.value === 'docx') {
      const r: any = await documentsApi.editable(it.id);
      docxHtml.value = r?.html ?? '';
      return;
    }
    if (['pdf', 'image'].includes(previewKind.value)) {
      const blob = await documentsApi.content(it.id, { inline: true });
      blobUrl.value = URL.createObjectURL(new Blob([blob], { type: it.mimeType || 'application/octet-stream' }));
      return;
    }
    if (previewKind.value === 'text') {
      const blob = await documentsApi.content(it.id, { inline: true });
      textContent.value = await blob.text();
      return;
    }
    // 其他格式：保持空态展示下载引导
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '文档加载失败');
  } finally {
    loading.value = false;
  }
}

async function download() {
  const it = props.item;
  if (!it || it.kind !== 'file') return;
  try {
    const blob = await documentsApi.content(it.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = it.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e: any) {
    ElMessage.error(e?.message || '下载失败');
  }
}

function cleanup() {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = '';
  }
  docxHtml.value = '';
  mdText.value = '';
  textContent.value = null;
}
</script>

<style scoped>
.docpv-body {
  min-height: 320px;
  max-height: 72vh;
  overflow: auto;
}
.docpv-frame {
  width: 100%;
  height: 70vh;
  border: none;
}
.docpv-center {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
}
.docpv-img {
  max-width: 100%;
  max-height: 68vh;
  object-fit: contain;
}
.docpv-docx {
  background: #fff;
  padding: 24px 32px;
}
.docpv-text {
  margin: 0;
  padding: 16px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--el-font-family, sans-serif);
}
.docpv-csv {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.docpv-csv td {
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  padding: 6px 10px;
}
.docpv-csv tr.head td {
  background: var(--el-fill-color-light, #f5f7fa);
  font-weight: 500;
}
.docpv-fallback p {
  color: var(--el-text-color-secondary, #909399);
  margin: 0 0 12px;
}
.docpv-meta {
  float: left;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  line-height: 32px;
}
</style>
