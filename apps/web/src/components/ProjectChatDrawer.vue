<template>
  <!-- 项目群抽屉：右侧滑出，切 tab 不中断；5s 轮询增量拉新消息 -->
  <el-drawer
    :model-value="visible"
    direction="rtl"
    size="360px"
    :with-header="false"
    :modal="false"
    append-to-body
    class="pchat-drawer"
    @update:model-value="(v: boolean) => emit('update:visible', v)"
    @open="onOpen"
  >
    <div class="pchat">
      <div class="pchat-head">
        <span class="pchat-title"># {{ projectName }} · 项目群</span>
        <span class="muted pchat-meta">{{ members.length }} 人</span>
        <el-button text size="small" class="pchat-close" @click="emit('update:visible', false)">✕</el-button>
      </div>

      <div class="pchat-body" ref="bodyRef" @scroll="onScroll">
        <div v-if="hasMore" class="pchat-more" @click="loadOlder">查看更早的消息</div>
        <div v-if="!loading && !messages.length" class="muted pchat-empty">
          还没有消息，说点什么吧——项目里的进展、问题、通知都可以在这里同步。
        </div>
        <template v-for="(m, i) in messages" :key="m.id">
          <div v-if="showDayDivider(i)" class="pchat-day">{{ dayLabel(m.createdAt) }}</div>
          <div class="pchat-msg" :class="{ mine: m.mine, del: !!m.deletedAt }">
            <div v-if="!m.mine" class="pchat-avatar" :title="m.sender?.name">
              {{ (m.sender?.name || '—').slice(0, 1) }}
            </div>
            <div class="pchat-main">
              <div class="pchat-who muted">
                {{ m.mine ? '我' : m.sender?.name || '—' }} · {{ fmt(m.createdAt, 'HH:mm') }}
                <span v-if="m.mine && m.canDelete && !m.deletedAt" class="pchat-del" @click="recall(m)">撤回</span>
                <span v-else-if="!m.mine && m.canDelete && !m.deletedAt" class="pchat-del" @click="recall(m)">删除</span>
              </div>
              <div v-if="m.replyTo && !m.deletedAt" class="pchat-quote">回复 {{ m.replyTo.senderName }}：{{ m.replyTo.content }}</div>
              <div class="pchat-bubble" @dblclick="startReply(m)">{{ m.deletedAt ? '该消息已撤回' : m.content }}</div>
              <div v-if="!m.deletedAt" class="pchat-acts">
                <span class="pchat-act" @click="startReply(m)">回复</span>
                <span class="pchat-act" @click="toNote(m)">转为纪要</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div v-if="replyTo" class="pchat-replying">
        回复 {{ replyTo.sender?.name }}：{{ replyTo.content.slice(0, 40) }}
        <span class="pchat-reply-x" @click="replyTo = null">✕</span>
      </div>
      <div class="pchat-input">
        <el-input
          v-model="draft"
          type="textarea"
          :rows="2"
          resize="none"
          maxlength="1000"
          placeholder="发消息给项目成员…（Enter 发送，Shift+Enter 换行）"
          @keydown="onKeydown"
        />
        <el-button type="primary" size="small" :loading="sending" :disabled="!draft.trim()" @click="send">发送</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { projectsApi } from '../api';
import { fmt } from '../utils/format';

const props = defineProps<{ visible: boolean; projectId: string; projectName: string }>();
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'sent'): void }>();

const messages = ref<any[]>([]);
const members = ref<any[]>([]);
const replyTo = ref<any>(null);
const draft = ref('');
const sending = ref(false);
const loading = ref(false);
const hasMore = ref(false);
const bodyRef = ref<HTMLElement | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

function showDayDivider(i: number) {
  if (i === 0) return true;
  const a = messages.value[i - 1]?.createdAt?.slice(0, 10);
  const b = messages.value[i]?.createdAt?.slice(0, 10);
  return a !== b;
}
function dayLabel(d: string) {
  return fmt(d, 'YYYY年M月D日');
}

/** 首次打开：拉最新 50 条 + 成员，滚到底，清红点，启动轮询 */
async function onOpen() {
  await loadLatest();
  await nextTick();
  scrollToBottom();
  projectsApi.chatRead(props.projectId).catch(() => {});
  startPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollNew, 5000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
onBeforeUnmount(stopPolling);

async function loadLatest() {
  loading.value = true;
  try {
    const r: any = await projectsApi.chatList(props.projectId, { limit: 50 });
    messages.value = r?.messages ?? [];
    members.value = r?.members ?? [];
    hasMore.value = (r?.messages ?? []).length >= 50;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '消息加载失败');
  } finally {
    loading.value = false;
  }
}

/** 向上翻历史（以当前最早一条为锚点） */
async function loadOlder() {
  const oldest = messages.value[0]?.id;
  if (!oldest) return;
  try {
    const r: any = await projectsApi.chatList(props.projectId, { beforeId: oldest, limit: 50 });
    const older = r?.messages ?? [];
    if (older.length) {
      const el = bodyRef.value;
      const prevH = el?.scrollHeight ?? 0;
      messages.value = [...older, ...messages.value];
      await nextTick();
      if (el) el.scrollTop = el.scrollHeight - prevH;
    }
    hasMore.value = older.length >= 50;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '历史消息加载失败');
  }
}

/** 5s 增量：以最新一条为锚点拉新消息；期间用户上翻则不打断阅读位置 */
async function pollNew() {
  if (!props.visible) return;
  const newest = messages.value[messages.value.length - 1]?.id;
  if (!newest) return loadLatest();
  try {
    const r: any = await projectsApi.chatList(props.projectId, { afterId: newest, limit: 100 });
    const fresh = r?.messages ?? [];
    if (fresh.length) {
      const nearBottom =
        bodyRef.value && bodyRef.value.scrollHeight - bodyRef.value.scrollTop - bodyRef.value.clientHeight < 60;
      messages.value = [...messages.value, ...fresh];
      emit('sent');
      if (nearBottom) {
        await nextTick();
        scrollToBottom();
      }
      projectsApi.chatRead(props.projectId).catch(() => {});
    }
  } catch {
    /* 轮询失败静默，下个周期重试 */
  }
}

function scrollToBottom() {
  const el = bodyRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function onScroll() {
  // 预留：滚动联动（历史分页走「查看更早的消息」按钮，避免误触发）
}

function startReply(m: any) {
  if (m.deletedAt) return;
  replyTo.value = m;
}

async function send() {
  const content = draft.value.trim();
  if (!content) return;
  sending.value = true;
  try {
    const r: any = await projectsApi.chatSend(props.projectId, { content, replyToId: replyTo.value?.id || undefined });
    if (r?.message) messages.value = [...messages.value, r.message];
    draft.value = '';
    replyTo.value = null;
    await nextTick();
    scrollToBottom();
    emit('sent');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

async function recall(m: any) {
  try {
    await ElMessageBox.confirm('确定撤回这条消息？', '撤回消息', {
      type: 'warning',
      confirmButtonText: '撤回',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    await projectsApi.chatDelete(m.id);
    const idx = messages.value.findIndex((x) => x.id === m.id);
    if (idx >= 0) messages.value[idx] = { ...messages.value[idx], content: '', deletedAt: new Date().toISOString() };
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '撤回失败');
  }
}

/** 一键沉淀：把消息转成「项目备注」纪要（标题取消息前 20 字） */
async function toNote(m: any) {
  try {
    await projectsApi.createNote(props.projectId, {
      kind: 'NOTE',
      title: String(m.content).slice(0, 20) || '群聊摘录',
      content: `> 来自项目群 · ${m.sender?.name || ''} · ${fmt(m.createdAt, 'YYYY-MM-DD HH:mm')}\n\n${m.content}`,
    });
    ElMessage.success('已转为项目纪要（概览页「项目纪要」卡片可查看）');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '转纪要失败');
  }
}
</script>

<style scoped>
.pchat {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.pchat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.pchat-title {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pchat-meta {
  font-size: 12px;
  flex-shrink: 0;
}
.pchat-close {
  margin-left: auto;
}
.pchat-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pchat-more {
  text-align: center;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  padding: 2px 0 6px;
  user-select: none;
}
.pchat-empty {
  font-size: 12.5px;
  text-align: center;
  padding: 30px 0;
}
.pchat-day {
  align-self: center;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 999px;
  padding: 2px 10px;
}
.pchat-msg {
  display: flex;
  gap: 8px;
}
.pchat-msg.mine {
  flex-direction: row-reverse;
}
.pchat-msg.del .pchat-bubble {
  color: var(--el-text-color-secondary);
  font-style: italic;
}
.pchat-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 16px;
}
.pchat-main {
  max-width: 82%;
  min-width: 0;
}
.pchat-msg.mine .pchat-main {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.pchat-who {
  font-size: 11px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.pchat-del {
  color: var(--el-color-danger);
  cursor: pointer;
  font-size: 11px;
}
.pchat-quote {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  border-left: 2px solid var(--el-border-color);
  padding-left: 6px;
  margin: 4px 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pchat-bubble {
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  margin-top: 2px;
  cursor: default;
}
.pchat-msg.mine .pchat-bubble {
  background: var(--el-color-primary-light-9);
}
.pchat-acts {
  display: none;
  gap: 10px;
  font-size: 11px;
  color: var(--el-color-primary);
  margin-top: 2px;
}
.pchat-msg:hover .pchat-acts {
  display: flex;
}
.pchat-replying {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 4px 8px;
  margin: 0 14px;
}
.pchat-reply-x {
  margin-left: auto;
  cursor: pointer;
  color: var(--el-text-color-tertiary);
}
.pchat-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>
