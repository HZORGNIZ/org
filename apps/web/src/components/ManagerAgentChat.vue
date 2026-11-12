<template>
  <!-- 悬浮机器人球：可拖动、位置记忆；点击展开对话面板（内嵌移动模式下不渲染） -->
  <div
    v-if="floating"
    ref="ballEl"
    class="agent-ball"
    :class="{ 'agent-ball-hidden': open }"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
    @pointerdown="onBallDown"
    @pointermove="onBallMove"
    @pointerup="onBallUp"
  >
    <svg viewBox="0 0 48 48" width="46" height="46">
      <circle cx="24" cy="24" r="23" fill="#428bff" />
      <rect x="13" y="16" width="22" height="16" rx="5" fill="#fff" />
      <circle cx="20" cy="24" r="2.4" fill="#428bff" />
      <circle cx="28" cy="24" r="2.4" fill="#428bff" />
      <rect x="21" y="9" width="6" height="4" rx="2" fill="#fff" />
      <line x1="24" y1="13" x2="24" y2="16" stroke="#fff" stroke-width="2" />
      <rect x="17" y="34" width="14" height="3" rx="1.5" fill="#d7e7ff" />
    </svg>
    <span class="agent-ball-tip">问问我</span>
  </div>

  <!-- 对话面板：锚定在球附近（左右按屏幕半区自适应）；内嵌模式全屏铺满 -->
  <div v-if="open" class="agent-panel" :class="{ 'agent-panel-mobile': embedded, 'agent-panel-inline': mode === 'inline' }" :style="floating ? panelStyle : {}">
    <div class="agent-hd">
      <span class="agent-hd-title">项目助理 · 小助手</span>
      <span class="agent-hd-sub" :title="hdSub">{{ hdSub }}</span>
      <div class="agent-hd-ops">
        <button class="agent-mini-btn" title="历史会话" @click="openHistory">历史</button>
        <button class="agent-mini-btn" title="新会话" @click="clearChat">新会话</button>
        <button v-if="floating" class="agent-mini-btn" title="全屏助理（手机端 /mobile）" @click="goFullscreen">⤢ 全屏</button>
        <!-- 用「－ 收起」而不是 ✕：避免用户以为点了就关掉找不回，收起后右下角机器人球随时可再打开 -->
        <button v-if="floating" class="agent-mini-btn" title="收起面板，点右下角机器人球可随时再打开" @click="open = false">－ 收起</button>
      </div>
    </div>

    <!-- 三模式切换：工作台 / 机器人（悬浮窗）/ 助理 Agent（/mobile）；内嵌页左侧多一个「首页」直达 -->
    <div class="agent-mode-row">
      <button v-if="embedded" class="agent-home-btn" title="回到工作台首页" @click="router.push('/')">⌂ 首页</button>
      <span v-else></span>
      <AssistantModeSwitch :current="mode === 'floating' ? 'robot' : 'agent'" compact @switch="onModeSwitch" />
    </div>

    <!-- 历史会话面板（服务端持久）：列表/切换/删除 -->
    <div v-if="showHistory" class="agent-history">
      <div class="agent-history-hd">
        <span>历史会话</span>
        <button class="agent-mini-btn" @click="showHistory = false">返回当前会话</button>
      </div>
      <div class="agent-history-list">
        <div v-if="!sessions.length" class="agent-empty">还没有历史会话</div>
        <div v-for="s in sessions" :key="s.id" class="agent-hist-item" :class="{ active: s.id === sessionId }" @click="openSession(s.id)">
          <div class="agent-hist-main">
            <div class="agent-hist-title">{{ s.title }}</div>
            <div class="agent-hist-meta">{{ s.messageCount }} 条 · {{ relTime(s.updatedAt) }}</div>
          </div>
          <button class="agent-hist-del" title="删除会话" @click.stop="removeSession(s.id)">✕</button>
        </div>
      </div>
    </div>

    <div v-else ref="listEl" class="agent-list">
      <div v-if="!msgs.length" class="agent-empty">
        <!-- 首屏欢迎屏：问候 + 今日速览（4 格，来自 /agent/overview）+ 能力云；三入口共用同一组件 -->
        <AgentWelcome
          :name="overview?.name || auth.user?.name || ''"
          :bucket="bucket"
          :overview="overview"
          :loading="ovLoading"
          :disabled="sending"
          @fill="fillDraft"
        />
      </div>
      <div v-for="(m, i) in msgs" :key="i" class="agent-row" :class="'agent-row-' + m.role">
        <!-- 用户消息 -->
        <div v-if="m.role === 'user'" class="agent-bubble agent-bubble-user">{{ m.text }}</div>
        <!-- 助手消息：正文 + 工具痕迹 + 动作确认卡 -->
        <div v-else class="agent-msg-agent">
          <div v-if="m.trace && m.trace.length" class="agent-trace">已查询：{{ m.trace.map((t: any) => TOOL_LABELS[t.tool] ?? t.tool).join('、') }}</div>
          <div class="agent-bubble agent-bubble-agent">{{ m.text }}</div>
          <!-- 只读回答里的可点跳转（工具结果里带的 links，不进模型上下文） -->
          <div v-if="m.links && m.links.length" class="agent-links">
            <router-link v-for="(l, li) in m.links" :key="li" :to="l.to" class="agent-link">{{ l.label }} →</router-link>
          </div>
          <div v-if="m.action && !m.decided" class="agent-action">
            <div class="agent-action-hd">
              <el-icon><Promotion /></el-icon>
              {{ ACTION_TITLES[m.action.kind] ?? '待确认操作' }}
            </div>
            <template v-if="m.action.needClarify">
              <div class="agent-action-note">
                <template v-if="m.action.needClarify === 'hours'">{{ m.action.reason }}</template>
                <template v-else>暂时无法生成操作：{{ m.action.reason }}</template>
              </div>
              <!-- 日报缺工时：不用重述正文，补一个数字就能直接提交 -->
              <div
                v-if="m.action.kind === 'DAILY_SUBMIT' && m.action.needClarify === 'hours' && m.action.rawContent"
                class="agent-clarify-hours"
              >
                <el-input-number
                  v-model="m.action.hoursInput"
                  :min="0"
                  :max="24"
                  :step="0.5"
                  :precision="1"
                  size="small"
                  controls-position="right"
                  placeholder="今天工作了几个小时"
                  style="width: 160px"
                />
                <el-button size="small" type="primary" :loading="m.action.running" @click="submitClarifyDaily(m)">填好并提交日报</el-button>
                <span class="agent-clarify-tip">填 0 表示今天确实没有工时投入</span>
              </div>
            </template>
            <template v-else>
              <div v-for="(row, ri) in actionRows(m.action)" :key="ri" class="agent-action-row">
                <span class="agent-action-k">{{ row.k }}</span><span class="agent-action-v">{{ row.v }}</span>
              </div>
              <div class="agent-action-ops">
                <el-button size="small" type="primary" :loading="m.action.running" @click="confirmAction(m)">确认执行</el-button>
                <el-button size="small" text @click="cancelAction(m)">取消</el-button>
              </div>
            </template>
          </div>
          <div v-else-if="m.action && m.decided === 'done'" class="agent-action-done">✅ 已执行：{{ m.resultLabel || m.action.label }}<router-link v-if="m.link" :to="m.link" class="agent-done-link">去查看</router-link></div>
          <div v-else-if="m.action && m.decided === 'cancelled'" class="agent-action-done agent-action-cancelled">已取消该操作</div>
        </div>
      </div>
      <div v-if="sending" class="agent-row agent-row-assistant">
        <div class="agent-bubble agent-bubble-agent agent-typing">思考中<span class="dot">...</span></div>
      </div>
    </div>

    <div v-if="!showHistory" class="agent-chips">
      <button
        v-for="c in quickChips"
        :key="c"
        class="agent-chip"
        :disabled="sending"
        title="点击填入输入框，可补充或修改后再发送"
        @click="fillDraft(c)"
      >{{ c }}</button>
    </div>
    <div v-if="!showHistory && listening" class="agent-voice-tip">正在聆听…松开结束（说完可修改再发送）</div>
    <div v-if="!showHistory" class="agent-input">
      <el-input
        ref="inputEl"
        v-model="draft"
        type="textarea"
        :rows="1"
        autosize
        resize="none"
        :placeholder="
          bucket === 'member'
            ? '问我的待办/日报/周报/会议，或让我帮你写日报…'
            : bucket === 'project'
              ? '问我项目情况/团队交报，或让我发群提醒大家交日报/催任务…'
              : '问我全站项目情况，或让我把通知发到公司群/项目群…'
        "
        :disabled="sending"
        @keydown.enter.exact.prevent="send()"
      />
      <el-button
        :type="listening ? 'danger' : 'default'"
        :class="{ 'voice-pulse': listening }"
        :disabled="!srSupported || sending"
        circle
        :title="srSupported ? '按住说话，松开结束（只填入输入框，不自动发送）' : '当前浏览器不支持语音录入，请用 Edge / Chrome'"
        @mousedown.prevent="startVoice"
        @mouseup.prevent="stopVoice"
        @mouseleave.prevent="stopVoice"
        @touchstart.prevent="startVoice"
        @touchend.prevent="stopVoice"
        @touchcancel.prevent="stopVoice"
      >
        <el-icon :size="18"><Microphone /></el-icon>
      </el-button>
      <el-button type="primary" :loading="sending" circle title="发送" @click="send()">
        <el-icon><Promotion /></el-icon>
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AssistantModeSwitch from './AssistantModeSwitch.vue';
import AgentWelcome from './AgentWelcome.vue';
import { ElMessage } from 'element-plus';
import { Promotion, Microphone } from '@element-plus/icons-vue';
import { agentApi, meetingsApi, reportsApi, tasksApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { useSpeechInput } from '../composables/useSpeechInput';

/**
 * 档位由外层从 /agent/config 传下来（manager | member）；浮动浮窗/内嵌全屏两种宿主
 * 能力清单与示例提问按档位裁：给普通成员看一堆他点不动的催办按钮，只会产生“为什么发了没反应”的工单
 */
/**
 * 档位 tier（manager|member）决定能用哪些工具/动作；引导分档 bucket（org|project|member）决定快捷问与能力清单文案：
 * 管理员/部门负责人=全站视角，项目负责人=本项目视角，普通成员=员工视角。均由外层从 /agent/config 透传
 */
const props = withDefaults(
  defineProps<{ tier?: 'manager' | 'member'; bucket?: 'org' | 'project' | 'member'; mode?: 'floating' | 'embedded' | 'inline' }>(),
  { tier: 'manager', bucket: undefined, mode: 'floating' },
);
const tier = computed<'manager' | 'member'>(() => props.tier ?? 'manager');
// 引导档：外层没传 bucket 时按 tier 兜底（member→员工视角，manager→全站视角），保证旧调用不报错
const bucket = computed<'org' | 'project' | 'member'>(() => props.bucket ?? (tier.value === 'member' ? 'member' : 'org'));
const embedded = computed(() => props.mode === 'embedded');
/** 悬浮球宿主（/mobile 全屏 or 项目页「AI员工」Tab 内嵌）也归入「已展开」这一类 */
const floating = computed(() => props.mode === 'floating');
const embeddedLike = computed(() => embedded.value || props.mode === 'inline');

/** 消息模型：role=user/assistant；assistant 可携带工具痕迹 trace、待确认动作 action 与只读回答的可点跳转 links */
interface AgentMsg {
  role: 'user' | 'assistant';
  text: string;
  trace?: { tool: string; args: any }[];
  action?: any; // { kind,...payload } 或 { kind, needClarify, reason }
  decided?: '' | 'done' | 'cancelled';
  resultLabel?: string;
  /** 动作执行成功后的站内跳转（如去会议详情抽屉） */
  link?: string;
  /** 助手回答附带的可点跳转（由后端工具结果里的 links 上托） */
  links?: { label: string; to: string }[];
}

const TOOL_LABELS: Record<string, string> = {
  list_projects: '项目清单',
  project_progress: '项目进展',
  project_risks: '风险健康度',
  project_tasks: '任务明细',
  project_weekly: '项目周报',
  list_meetings: '会议列表',
  group_options: '钉钉群',
  weekly_status: '本周周报情况',
  daily_status: '今日日报情况',
  overdue_tasks: '逾期任务',
  my_today: '今日写作素材',
  my_tasks: '我的待办',
  search_knowledge: '知识库检索',
  search_sop: 'SOP 检索',
  my_ranking: '我的排名',
  team_ranking: '团队排行',
  my_work_schedule: '我的工作时间',
};
const ACTION_TITLES: Record<string, string> = {
  MEETING_CREATE: '发起会议（确认后创建并发布邀请）',
  MEETING_PUBLISH: '发布会议（草稿→已安排，发邀请）',
  MEETING_NOTIFY: '补发会议通知',
  WEEKLY_SEND_GROUP: '把周报发到钉钉群',
  WEEKLY_CHASE: '催交周报（站内提醒缺交人）',
  TASK_CREATE: '下发任务（确认后创建并通知被指派人）',
  TASK_PATCH: '调整任务（确认后改状态/截止/优先级）',
  OVERDUE_CHASE: '逾期任务催办发到群（消息自带处理链接）',
  NOTIFY_BROADCAST: '发通知到群/个人（自动附处理链接）',
  DAILY_SUBMIT: '提交今日日报',
  WEEKLY_SUBMIT: '提交周报',
  WORK_SCHEDULE_SET: '设置我的工作/培训时间安排',
  DAILY_CHASE: '催今日日报（分群点名＋站内提醒）',
  RISK_ALERT: '风险项目提醒对应负责人',
};

/** 输入框上方常驻快捷问：按引导档三套（全站/项目/员工） */
const QUICK_CHIPS: Record<'org' | 'project' | 'member', string[]> = {
  org: ['全站项目的进度？', '最近有什么风险？', '这周谁还没交周报？', '等会开个会，帮我发一下'],
  project: ['我项目进度怎么样？', '我项目下谁还没交日报？', '这周谁还没交周报？', '等会开个会，帮我发一下', '帮我写今天的日报'],
  member: ['我手里还有哪些待办？', '帮我写今天的日报', '我这周周报还没交吗？', '我今天有没有会要参加？'],
};
const quickChips = computed(() => QUICK_CHIPS[bucket.value]);

/** 头部副标题：按引导档三套（窄屏只显一行，超长省略，悬浮看全文） */
const hdSub = computed(() =>
  bucket.value === 'member'
    ? '查我的进度与待办 · 写日报周报 · 找知识与 SOP'
    : bucket.value === 'project'
      ? '查我项目进度/团队交报 · 发本项目群提醒 · 发起会议 · 写我的日报'
      : '查全站进度/风险/周报 · 发公司群/项目群通知 · 下发任务',
);

/** 空态能力云已迁到 AgentWelcome.vue（按三档重写）；这里只保留输入框上方常驻快捷问与首屏速览数据 */
// 今日速览一次性取自 /agent/overview（确定性拼数据，不走大模型）；取失败置 null，AgentWelcome 降级为只显示能力云
const overview = ref<any>(null);
const ovLoading = ref(false);
async function loadOverview() {
  ovLoading.value = true;
  try {
    overview.value = await agentApi.overview();
  } catch {
    overview.value = null;
  } finally {
    ovLoading.value = false;
  }
}

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const open = ref(embeddedLike.value);

/** 头部的「全屏」：切到 /mobile 的全屏助理（同一套会话，接着聊） */
function goFullscreen() {
  open.value = false;
  router.push('/mobile');
}
/** 模式切换副作用：切到工作台时把悬浮窗收起来（其余跳转由切换器自己完成） */
function onModeSwitch(mode: 'workspace' | 'robot' | 'agent') {
  if (mode === 'workspace') open.value = false;
}
const sending = ref(false);
const draft = ref('');
const inputEl = ref<any>(null);

// ---- 语音录入：按住麦克风说话，识别结果追加到输入框（不自动发送）----
const speech = useSpeechInput(
  () => draft.value,
  (text) => {
    draft.value = text;
    // 识别过程中光标跟到末尾，接着说/接着改都不用手动定位
    nextTick(() => {
      const ta: HTMLTextAreaElement | undefined = (inputEl.value as any)?.textarea;
      if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
    });
  },
);
const { srSupported, listening } = speech;
function startVoice() {
  if (sending.value) return;
  speech.start();
}
function stopVoice() {
  speech.stop();
}
// 面板被收起（切模式/全屏/关闭）时别让麦克风继续开着
watch(open, (v) => {
  if (!v) speech.stop();
});
const msgs = ref<AgentMsg[]>([]);
const listEl = ref<HTMLElement | null>(null);
// 会话服务端持久：当前会话 id（仅本地记指针，正文从服务端取） + 历史列表 + 面板开关
const sessionId = ref<string | null>(null);
const sessions = ref<any[]>([]);
const showHistory = ref(false);
watch(showHistory, (v) => {
  if (v) speech.stop();
});
let saveTimer: any = null;

// ---- 悬浮球位置：拖动 + 视口限位 + localStorage 记忆 ----
const BALL_SIZE = 52;
const ballEl = ref<HTMLElement | null>(null);
const pos = reactive({ x: 0, y: 0 });
const posKey = computed(() => `agent-ball-pos:${auth.user?.id ?? 'anon'}`);
const histKey = computed(() => `agent-chat:${auth.user?.id ?? 'anon'}`);
let dragging = false;
let moved = 0;
let lastPoint = { x: 0, y: 0 };

function clampPos(x: number, y: number) {
  return {
    x: Math.min(Math.max(x, 8), window.innerWidth - BALL_SIZE - 8),
    y: Math.min(Math.max(y, 8), window.innerHeight - BALL_SIZE - 8),
  };
}
function initPos() {
  try {
    const saved = JSON.parse(localStorage.getItem(posKey.value) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      Object.assign(pos, clampPos(saved.x, saved.y));
      return;
    }
  } catch { /* 忽略坏数据 */ }
  Object.assign(pos, clampPos(window.innerWidth - BALL_SIZE - 18, window.innerHeight - BALL_SIZE - 120));
}
function onBallDown(e: PointerEvent) {
  dragging = true;
  moved = 0;
  lastPoint = { x: e.clientX, y: e.clientY };
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
}
function onBallMove(e: PointerEvent) {
  if (!dragging) return;
  const dx = e.clientX - lastPoint.x;
  const dy = e.clientY - lastPoint.y;
  moved += Math.abs(dx) + Math.abs(dy);
  lastPoint = { x: e.clientX, y: e.clientY };
  if (moved > 4) Object.assign(pos, clampPos(pos.x + dx, pos.y + dy));
}
function onBallUp() {
  if (!dragging) return;
  dragging = false;
  localStorage.setItem(posKey.value, JSON.stringify({ x: pos.x, y: pos.y }));
  if (moved <= 4) open.value = !open.value; // 短按=展开/收起
}
function onResize() {
  Object.assign(pos, clampPos(pos.x, pos.y));
}

/** 面板锚点：贴屏幕左半→面板往右展开，反之往左（PANEL_W 与 .agent-panel 的 width 保持一致） */
const PANEL_W = 420;
const panelStyle = computed(() => {
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  // 与 CSS 的 min(92vw, PANEL_W) 同口径，小屏时实际宽度更小
  const panelW = Math.min(winW * 0.92, PANEL_W);
  const onLeft = pos.x < winW / 2;
  return {
    left: onLeft ? `${Math.max(8, Math.min(pos.x, winW - panelW - 8))}px` : undefined,
    // 右侧锚定：右偏移不能太靠左，否则面板会挤出屏幕左侧
    right: onLeft ? undefined : `${Math.max(8, Math.min(winW - pos.x - BALL_SIZE, winW - panelW - 8))}px`,
    top: `${Math.min(pos.y, Math.max(8, winH - 560))}px`,
  };
});

// ---- 会话（服务端持久为主，localStorage 镜像为离线兜底） ----
function activeIdKey() {
  // 移动入口/项目页 AI员工/悬浮窗各记各的活动会话指针（同一用户多张脸互不踩踏）
  return `agent-active-sid:${auth.user?.id ?? 'anon'}${props.mode === 'embedded' ? ':mobile' : props.mode === 'inline' ? ':project' : ''}`;
}
function loadMirror(): AgentMsg[] {
  try {
    const saved = JSON.parse(localStorage.getItem(histKey.value) || '[]');
    return Array.isArray(saved) ? saved.slice(-60) : [];
  } catch {
    return [];
  }
}
function loadHistory(): Promise<void> {
  // 启动时优先按上次活动会话从服务端载入；失败/无则回落本地镜像
  const mirror = loadMirror();
  const sid = localStorage.getItem(activeIdKey());
  if (sid) {
    sessionId.value = sid;
    return agentApi
      .getSession(sid)
      .then((s) => {
        if (s && Array.isArray(s.messages)) {
          msgs.value = s.messages as AgentMsg[];
          scrollBottom();
        }
      })
      .catch(() => {
        msgs.value = mirror;
      });
  }
  msgs.value = mirror;
  // 移动端浏览器没有“上次活动会话”指针：回退到服务端最近一次会话，
  // 实现跨设备接续——电脑上聊到哪，手机打开 /mobile 就接到哪
  if (embeddedLike.value && !mirror.length) {
    return agentApi
      .listSessions()
      .then((r: any) => {
        const latest = (r?.sessions ?? [])[0];
        if (latest && !msgs.value.length) return openSession(latest.id);
      })
      .catch(() => {
        /* 无会话/拉取失败：保持空会话，后续由每日播报补齐 */
      });
  }
  return Promise.resolve();
}
function saveHistory() {
  // 先写本地镜像（即时、离线可恢复），再防抖持久到服务端
  try {
    localStorage.setItem(histKey.value, JSON.stringify(msgs.value.slice(-60)));
  } catch {
    /* 容量满忽略 */
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSession, 800);
}
async function persistSession() {
  if (!msgs.value.length) return;
  try {
    const r: any = await agentApi.saveSession({ id: sessionId.value ?? undefined, messages: msgs.value.slice(-200) });
    if (r?.id) {
      sessionId.value = r.id;
      localStorage.setItem(activeIdKey(), r.id);
    }
  } catch {
    /* 服务端不可用时本地镜像仍在，下次自动重试 */
  }
}
function clearChat() {
  // 当前会话已即时持久化，直接开启新会话（不删除历史）
  clearTimeout(saveTimer);
  sessionId.value = null;
  localStorage.removeItem(activeIdKey());
  msgs.value = [];
  // 新会话回到首屏欢迎屏：重取一次今日速览（不再重播每日播报，避免与速览重复）
  void loadOverview();
  try {
    localStorage.removeItem(histKey.value);
  } catch {
    /* ignore */
  }
  showHistory.value = false;
}

// ---- 历史会话面板 ----
async function openHistory() {
  showHistory.value = true;
  // 打开前把当前会话落库，保证列表含最新一条
  if (msgs.value.length) await persistSession();
  try {
    sessions.value = (await agentApi.listSessions())?.sessions ?? [];
  } catch {
    sessions.value = [];
  }
}
async function openSession(id: string) {
  if (id === sessionId.value) {
    showHistory.value = false;
    return;
  }
  clearTimeout(saveTimer);
  if (msgs.value.length) await persistSession(); // 切走前保存当前
  try {
    const s: any = await agentApi.getSession(id);
    msgs.value = Array.isArray(s?.messages) ? (s.messages as AgentMsg[]) : [];
    sessionId.value = id;
    localStorage.setItem(activeIdKey(), id);
    showHistory.value = false;
    scrollBottom();
  } catch (e: any) {
    ElMessage.error(`打开会话失败：${e?.message ?? e}`);
  }
}
async function removeSession(id: string) {
  try {
    await agentApi.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (id === sessionId.value) {
      sessionId.value = null;
      localStorage.removeItem(activeIdKey());
      msgs.value = [];
    }
  } catch (e: any) {
    ElMessage.error(`删除失败：${e?.message ?? e}`);
  }
}
function relTime(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}
async function scrollBottom() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 当前页面上下文：项目详情页带上项目（后端用名称指代） */
function pageContext() {
  const projectId = String(route.params.id ?? '') || undefined;
  const projectName = projectId && route.path.startsWith('/projects/')
    ? String((route.query.name as string) ?? '') || undefined
    : undefined;
  return { projectId, projectName, route: route.path };
}

/**
 * 快捷文案只当"快捷方式"：点一下把这句话填进输入框，不替用户直接发出。
 * 用户常要补时间/人名/群名（如"把没交周报的催一下"要指定群），改完由用户自己点发送，
 * 发送后才交给模型理解并出确认卡。
 */
function fillDraft(text: string) {
  if (sending.value) return;
  const cur = draft.value.trim();
  draft.value = cur ? `${cur}\n${text}` : text;
  nextTick(() => {
    const inst: any = inputEl.value;
    inst?.focus?.();
    const ta: HTMLTextAreaElement | undefined = inst?.textarea;
    if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
  });
}

async function send(preset?: string) {
  const text = (preset ?? draft.value).trim();
  if (!text || sending.value) return;
  draft.value = '';
  msgs.value.push({ role: 'user', text });
  saveHistory();
  await runAgent();
}

async function runAgent() {
  sending.value = true;
  scrollBottom();
  try {
    // 携带最近对话（截断在 16 条内由后端控制）；动作执行结果消息 role=user（系统回报）
    const history = msgs.value.slice(-16).map((m) => ({ role: m.role, content: m.text }));
    const r: any = await agentApi.chat(history, pageContext());
    msgs.value.push({
      role: 'assistant',
      text: String(r?.reply ?? '（无答复）'),
      trace: Array.isArray(r?.toolTrace) ? r.toolTrace : [],
      links: Array.isArray(r?.links) ? r.links : [],
      action: r?.action && typeof r.action === 'object' ? { ...r.action, running: false } : undefined,
      decided: '',
    });
  } catch (e: any) {
    msgs.value.push({ role: 'assistant', text: `出错了：${e?.message ?? e}`, trace: [] });
  } finally {
    sending.value = false;
    saveHistory();
    scrollBottom();
  }
}

// ---- 确认卡片 ----
function actionRows(a: any) {
  const rows: { k: string; v: string }[] = [];
  const push = (k: string, v: any) => { if (v !== undefined && v !== null && String(v).trim()) rows.push({ k, v: String(v) }); };
  if (a.kind === 'MEETING_CREATE') {
    push('主题', a.title);
    push('议题', a.agenda);
    push('时间', `${a.startLabel} ~ ${a.endLabel}`);
    push('层级', a.scope === 'PROJECT' ? `项目会议（${a.projectName}）` : a.scope === 'COMPANY' ? '公司会议' : a.scope === 'DEPT' ? '部门会议' : '个人会议');
    push('参会人', (a.participantNames ?? []).map((p: any) => (p.dept ? `${p.name}（${p.dept}）` : p.name)).join('、') + '、本人');
    if (a.groupName) push('发到群', a.groupName);
    push('发布', a.publish === false ? '仅存草稿（不通知）' : '创建后立即发布并通知');
  } else if (a.kind === 'MEETING_PUBLISH' || a.kind === 'MEETING_NOTIFY') {
    push('会议', a.meetingTitle);
    push('动作', a.label);
  } else if (a.kind === 'WEEKLY_SEND_GROUP') {
    push('内容', `${a.scopeLabel}（${a.periodStart} 起）`);
    push('发到群', (a.groupNames ?? []).join('、'));
    push('说明', '确认后我直接把周报原文发到这些群（不修改周报记录）');
  } else if (a.kind === 'WEEKLY_CHASE') {
    push('周期', a.weekLabel);
    push('催交对象', (a.names ?? []).join('、'));
    push('方式', '站内提醒（不发钉钉私聊）');
  } else if (a.kind === 'TASK_CREATE') {
    (a.tasks ?? []).forEach((t: any, i: number) => {
      push(a.tasks.length > 1 ? `任务${i + 1}` : '任务', t.title);
      push('项目', t.projectName);
      push('指派', t.assigneeName ?? '不指派');
      push('截止', t.dueLabel ?? '未定');
      if (t.priority && t.priority !== 'MEDIUM') push('优先级', t.priority);
    });
    push('通知方式', '确认后即时给被指派人发站内信＋钉钉私聊');
    if (a.clarifyNote) push('待确认', a.clarifyNote);
  } else if (a.kind === 'TASK_PATCH') {
    push('任务', a.taskTitle);
    if (a.projectName) push('项目', a.projectName + (a.projectArchived ? '（已归档）' : ''));
    push('负责人', a.assigneeName);
    // 逐项列出「从什么改成什么」：只写“要改任务”的确认卡没人敢点
    for (const c of a.changes ?? []) push(`改${c.k}`, `${c.from} → ${c.to}`);
    if (a.note) push('提示', a.note);
  } else if (a.kind === 'OVERDUE_CHASE') {
    // 分人分群：逐群展示各自收到的名单（每群只含自己项目成员）
    for (const gp of a.groupPlans ?? []) {
      push(`群·${gp.groupName}`, gp.items?.length ? `催：${gp.people.join('、')}（${gp.items.length} 条逾期）` : '本群无逾期成员，自动跳过不发');
    }
    if ((a.items ?? []).length) push('涉及共', `${a.items.length} 条逾期任务`);
    const firstPlan = (a.groupPlans ?? []).find((p: any) => p.items?.length);
    if (firstPlan) push('首群文案', firstPlan.text);
    push('说明', '发送前系统重扫，每个群只收自己项目成员的名单');
  } else if (a.kind === 'NOTIFY_BROADCAST') {
    const gc: any[] = a.groupContents ?? [];
    if (gc.length) {
      // 分人分群：每群只发与其成员相关的内容
      for (const x of gc) push(`群·${x.groupName}文案`, String(x.content).slice(0, 300));
    } else if ((a.groupNames ?? []).length) {
      push('发到群', (a.groupNames ?? []).join('、'));
    }
    if ((a.personNames ?? []).length) push('通知人', (a.personNames ?? []).join('、'));
    if (a.content) push('文案（逐字发送）', a.content);
    push('方式', '群走钉钉群发；个人走钉钉私聊＋站内信');
  } else if (a.kind === 'DAILY_SUBMIT') {
    push('当日工时', `${a.hours} 小时`);
    push('提交正文', a.rawContent);
    if (a.appendedMerge) push('提示', '今天已交过日报，本次将追加合并并重新整理');
  } else if (a.kind === 'WEEKLY_SUBMIT') {
    push('归属', `${a.scopeLabel}（${a.periodStart} 周）`);
    if ((a.groupNames ?? []).length) push('随发群', (a.groupNames ?? []).join('、'));
    push('提交正文', a.rawContent);
  } else if (a.kind === 'WORK_SCHEDULE_SET') {
    // 整周格子：逐日列出改完之后长什么样（保存是整周覆盖，没说到的天会被原样保留或按 mode 清空）
    if (a.clearedAll) {
      push('结果', '整周不排班（清空我所有工作时间安排）');
    } else {
      for (const d of a.days ?? []) push(d.label, d.ranges?.length ? `${d.ranges.join(' / ')}（${d.hours} 小时）` : '不排班');
      push('周总时长', `${a.weeklyHours} 小时`);
    }
    if ((a.changedLabels ?? []).length) push('改动日', (a.changedLabels ?? []).join('、'));
    if (a.note) push('提示', a.note);
  } else if (a.kind === 'DAILY_CHASE') {
    push('日期', `${a.date}（${a.weekdayName}）· ${a.scopeLabel}`);
    push('应发/已交', `应发 ${a.plannedCount} 人，已交 ${a.wroteCount} 人，待催 ${a.missingCount} 人`);
    for (const gp of a.groupPlans ?? []) push(`群·${gp.groupName}`, gp.people?.length ? `点名：${gp.people.join('、')}` : '本群无待催成员，自动跳过不发');
    if ((a.soloNames ?? []).length) push('只发站内信', (a.soloNames ?? []).join('、'));
    const firstPlan = (a.groupPlans ?? []).find((p: any) => p.people?.length);
    if (firstPlan?.text) push('首群文案', String(firstPlan.text).slice(0, 300));
    push('说明', a.note ?? '发送前系统重扫；没排班的人不进名单、不被打扰');
  } else if (a.kind === 'RISK_ALERT') {
    push('日期', `${a.date}· ${a.leaderCount} 位负责人 / ${a.projectCount} 个项目${a.includeAttention ? '（含需关注）' : ''}`);
    for (const it of a.items ?? []) push(`${it.leader}·${it.project}`, `${it.level}${it.healthPercent !== null && it.healthPercent !== undefined ? ` · 健康度 ${it.healthPercent}%` : ''}${it.topRisk ? `：${it.topRisk}` : ''}`);
    for (const l of a.leaders ?? []) push(`提醒·${l.name}`, `${l.projectNames.join('、')}${(l.groupNames ?? []).length ? `（发到：${l.groupNames.join('、')}）` : '（无绑定项目群，只发站内信）'}`);
    push('说明', a.note ?? '每位负责人只收到自己那几个项目；发送前系统重扫风险名单');
  }
  return rows;
}

async function confirmAction(m: AgentMsg) {
  const a = m.action;
  if (!a || a.running || m.decided) return;
  a.running = true;
  try {
    let resultLabel = '';
    if (a.kind === 'MEETING_CREATE') {
      const created: any = await meetingsApi.create({
        title: a.title,
        agenda: a.agenda,
        scope: a.scope,
        projectId: a.projectId ?? null,
        startAt: a.startAt,
        endAt: a.endAt,
        participantIds: a.participantIds ?? [],
        location: a.location ?? null,
        publish: a.publish !== false,
        groupConversationId: a.groupConversationId ?? null,
        groupName: a.groupName ?? null,
      });
      resultLabel = `已创建会议《${a.title}》${a.publish !== false ? '并已发布邀请' : '（草稿）'}`;
      if (a.groupName && created?.id && a.publish !== false) {
        // 创建即发布已发邀请；用户额外点名了群且未随发布带出时补一次群通知
        try { await meetingsApi.notify(created.id, 'GROUP'); } catch { /* 群通知失败不阻断 */ }
      }
      m.link = created?.id ? `/meetings?open=${created.id}` : '/meetings';
    } else if (a.kind === 'MEETING_PUBLISH') {
      await meetingsApi.publish(a.meetingId);
      resultLabel = `已发布会议《${a.meetingTitle}》并发出邀请`;
      m.link = `/meetings?open=${a.meetingId}`;
    } else if (a.kind === 'MEETING_NOTIFY') {
      await meetingsApi.notify(a.meetingId, a.notifyKind ?? 'INVITE');
      resultLabel = `已为《${a.meetingTitle}》补发「${a.notifyKind ?? 'INVITE'}」通知`;
      m.link = `/meetings?open=${a.meetingId}`;
    } else if (a.kind === 'WEEKLY_SEND_GROUP') {
      const r: any = await agentApi.weeklyToGroup({ periodStart: a.periodStartIso, scopeKey: a.scopeKey, groupIds: a.groupIds });
      const failed = (r?.failed ?? []) as string[];
      resultLabel = failed.length
        ? `已发到 ${r?.sent ?? 0} 个群，失败：${failed.join('、')}`
        : `已把${a.scopeLabel}发到：${(a.groupNames ?? []).join('、')}`;
      m.link = '/reports';
    } else if (a.kind === 'WEEKLY_CHASE') {
      const r: any = await agentApi.chaseWeekly({ names: a.names });
      resultLabel = r?.skipped ? (r.reason ?? '无需催交') : `已提醒：${(r?.chased ?? []).join('、')}`;
    } else if (a.kind === 'TASK_CREATE') {
      const r: any = await agentApi.createTasks({ tasks: a.tasks ?? [] });
      const failed = ((r?.tasks ?? []) as any[]).filter((t) => !t.ok);
      resultLabel = `已创建 ${r?.created ?? 0} 个任务，通知 ${r?.notified ?? 0} 人` + (failed.length ? `；失败：${failed.map((f) => `${f.title}（${f.error}）`).join('、')}` : '');
      m.link = '/tasks';
    } else if (a.kind === 'TASK_PATCH') {
      // 直接调首页快捷操作同一个接口：权限、看板落位、活动记录、标 DONE 自动置 100% 都是现成逻辑，不在 Agent 里再写一份
      await tasksApi.update(a.taskId, a.patch ?? {});
      resultLabel = `已调整《${a.taskTitle}》：${(a.changes ?? []).map((c: any) => `${c.k}→${c.to}`).join('，')}`;
      m.link = `/tasks?open=${a.taskId}`;
    } else if (a.kind === 'OVERDUE_CHASE') {
      const r: any = await agentApi.chaseOverdue({ groupIds: a.groupIds ?? [], names: (a.items ?? []).map((t: any) => t.who) });
      if (r?.skipped) {
        resultLabel = r.reason ?? '当前无人逾期，无需催办';
      } else {
        const failed = (r?.failed ?? []) as string[];
        resultLabel = failed.length
          ? `已发到 ${r?.sent ?? 0} 个群，失败：${failed.join('、')}`
          : `已把逾期催办发到：${(a.groupNames ?? []).join('、')}`;
      }
    } else if (a.kind === 'NOTIFY_BROADCAST') {
      const r: any = await agentApi.notify({
        content: a.content ?? '',
        groupIds: a.groupIds ?? [],
        personIds: a.personIds ?? [],
        groupContents: (a.groupContents ?? []).map((g: any) => ({ conversationId: g.conversationId, content: g.content })),
      });
      const gFailed = ((r?.groups ?? []) as any[]).filter((g) => !g.ok).map((g) => g.groupName);
      const pCount = ((r?.persons ?? []) as any[]).length;
      resultLabel = `通知完成：群 ${(r?.sentGroups ?? 0)}/${((a.groupIds ?? []) as any[]).length} 个${gFailed.length ? `（失败：${gFailed.join('、')}）` : ''}${pCount ? `，已通知个人 ${pCount} 人` : ''}`;
    } else if (a.kind === 'DAILY_SUBMIT') {
      await reportsApi.submitDaily(a.rawContent, typeof a.hours === 'number' ? a.hours : null);
      resultLabel = (a.appendedMerge ? '已提交今日日报（与当天已有内容追加合并）' : '已提交今日日报') + `，当日工时 ${a.hours} 小时`;
      m.link = '/reports';
    } else if (a.kind === 'WEEKLY_SUBMIT') {
      await reportsApi.submitWeekly(a.rawContent, a.groupIds ?? [], {
        projectId: a.projectId ?? undefined,
        departmentId: a.departmentId ?? undefined,
        periodStart: a.periodStartIso,
      });
      resultLabel = `已提交${a.scopeLabel}（${a.periodStart} 周）${(a.groupNames ?? []).length ? `，并发到：${(a.groupNames ?? []).join('、')}` : ''}`;
      m.link = '/reports';
    } else if (a.kind === 'WORK_SCHEDULE_SET') {
      // 直接复用首页同一接口 PUT /reports/work-slots（整表覆盖、天然按本人收敛），不在 Agent 里重写权限
      await reportsApi.saveWorkSlots(a.slots ?? []);
      resultLabel = a.clearedAll ? '已清空我的工作/培训时间安排' : `已更新我的工作/培训时间（本周合计 ${a.weeklyHours} 小时）`;
      m.link = '/reports';
    } else if (a.kind === 'DAILY_CHASE') {
      const r: any = await agentApi.chaseDaily({ groupIds: a.groupIds ?? [], personIds: a.personIds ?? [] });
      if (r?.skipped) {
        resultLabel = r.reason ?? '这些人现在已经都交过日报，无需催办';
      } else {
        const failed = (r?.failed ?? []) as string[];
        resultLabel =
          `已催 ${(r?.chased ?? []).length} 人交今日日报，发到 ${r?.sent ?? 0} 个群` +
          (failed.length ? `（失败：${failed.join('、')}）` : '') +
          (r?.inboxOk ? '，并已发站内信' : '');
      }
      m.link = '/reports';
    } else if (a.kind === 'RISK_ALERT') {
      const r: any = await agentApi.riskAlert({ userIds: a.personIds ?? [], includeAttention: !!a.includeAttention });
      if (r?.skipped) {
        resultLabel = r.reason ?? '当前没有风险项目，无需提醒';
      } else {
        resultLabel =
          `已提醒 ${(r?.leaders ?? []).length} 位负责人处理 ${r?.projectCount ?? 0} 个风险项目，发到 ${r?.sentGroups ?? 0} 个群` +
          ((r?.failedGroups ?? 0) ? `（${r.failedGroups} 个群发送失败）` : '');
      }
      m.link = '/projects';
    } else {
      throw new Error('不支持的操作类型');
    }
    m.decided = 'done';
    m.resultLabel = resultLabel;
    ElMessage.success(resultLabel);
    msgs.value.push({ role: 'user', text: `（系统回报）操作已完成：${resultLabel}。${a.label ?? ''}` });
  } catch (e: any) {
    a.running = false;
    ElMessage.error(`执行失败：${e?.message ?? e}`);
    msgs.value.push({ role: 'user', text: `（系统回报）操作执行失败：${e?.message ?? e}，请向用户说明并可调整后重新发起` });
  }
  saveHistory();
  scrollBottom();
  // 执行/失败后让 Agent 知情并收尾（异步，不阻塞界面）
  runAgentQuiet();
}

/**
 * 日报缺工时追问：用户只补一个工时数字，正文沿用 Agent 已整理好的 rawContent 直接提交，
 * 不需要把日报重说一遍
 */
async function submitClarifyDaily(m: AgentMsg) {
  const a = m.action;
  if (!a || a.running || m.decided) return;
  const h = a.hoursInput;
  if (h === null || h === undefined || h === '') {
    ElMessage.warning('请先填写今天的工作时长（小时），确实没有投入就填 0');
    return;
  }
  a.running = true;
  try {
    await reportsApi.submitDaily(a.rawContent, Number(h));
    m.decided = 'done';
    m.resultLabel = `已提交今日日报，当日工时 ${Number(h)} 小时`;
    m.link = '/reports';
    ElMessage.success(m.resultLabel);
    msgs.value.push({ role: 'user', text: `（系统回报）操作已完成：${m.resultLabel}` });
  } catch (e: any) {
    ElMessage.error(`提交失败：${e?.response?.data?.message || e?.message || e}`);
  } finally {
    a.running = false;
  }
  saveHistory();
  scrollBottom();
  runAgentQuiet();
}

/** 动作执行后的知情回合：不进 loading，静默让 Agent 得到「已执行」反馈 */
async function runAgentQuiet() {
  try {
    const history = msgs.value.slice(-16).map((m) => ({ role: m.role, content: m.text }));
    const r: any = await agentApi.chat(history, pageContext());
    msgs.value.push({ role: 'assistant', text: String(r?.reply ?? ''), trace: [] });
  } catch { /* 收尾回合失败不影响主流程 */ }
  saveHistory();
  scrollBottom();
}

function cancelAction(m: AgentMsg) {
  m.decided = 'cancelled';
  m.action.running = false;
  msgs.value.push({ role: 'user', text: `（系统回报）用户取消了这个操作：${m.action.label ?? m.action.kind}。请简短确认并问是否需要调整。` });
  saveHistory();
  runAgentQuiet();
}

/** 每日播报消息的识别：新版首行「📅 日期 每日播报」；旧版（deploy96 上线初期无日期戳）首句「你好，」 */
function isDailyGreet(m: AgentMsg) {
  return m.role === 'assistant' && (/^📅 \d{4}-\d{2}-\d{2} 每日播报/.test(m.text) || /^你好，/.test(m.text));
}

/**
 * 内嵌移动入口：每天第一次打开播报一次（不再仅限空会话）。
 * 去重依据：当前会话里最后一条播报的日期戳——播报本身会落库同步到电脑端，
 * 所以手机播过后电脑再开 /mobile 不会重复刷屏；历史旧版播报无日期戳，一律视为“不是今天的”
 */
async function greetDaily() {
  if (!embedded.value) return;
  // 新会话不再重复播速览（首屏 AgentWelcome 已含同样的今日信息）；只有接续了历史会话才补一条当日播报
  if (!msgs.value.length) return;
  const last = [...msgs.value].reverse().find(isDailyGreet);
  if (last && last.text.startsWith(`📅 ${todayStr()} 每日播报`)) return;
  try {
    const r: any = await agentApi.mobileGreet();
    // 等待期间用户已手动开了对话：不再插入，免得插在半路打断思路
    if (msgs.value.some((m) => m.role === 'user')) return;
    msgs.value.push({
      role: 'assistant',
      text: String(r?.reply ?? ''),
      trace: [],
      links: Array.isArray(r?.links) ? r.links : [],
    });
    saveHistory();
    scrollBottom();
  } catch {
    /* 播报失败不阻断：用户仍可手动提问，回退到能力清单 */
  }
}

function todayStr() {
  // 北京时间日期（与服务端 mobileGreet 的日期戳同一口径）
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 移动入口启动序列：先接续历史会话，再判定今天是否该播报（串行避免竞态） */
async function start() {
  await loadHistory();
  await greetDaily();
}

// ---- 生命周期 ----
async function checkConfig() {
  // 内嵌模式的可见性由外层（MobileAssistantView / 项目页 AI员工 Tab）判定（这里收面板会白屏）
  if (embeddedLike.value) return;
  try {
    const cfg = await agentApi.getConfig();
    if (!cfg?.visible) open.value = false; // 后台关闸/角色变化：收起已展开面板（外层 v-if 负责隐藏本体）
  } catch {
    /* 拉取失败保持现状，外层不渲染 */
  }
}
onMounted(() => {
  initPos();
  void loadOverview(); // 首屏欢迎屏的今日速览（无论哪入口都预取，空会话时直接展示）
  if (embeddedLike.value) void start(); // 内嵌入口：接续历史 -> 每日播报（串行）
  else loadHistory();
  // 从 /mobile 或模式切换器过来（/?agent=1）：直接展开悬浮窗，且把参数从地址栏清掉，刷新不会反复弹
  if (!embedded.value && route.query.agent === '1') {
    open.value = true;
    const rest = { ...route.query };
    delete rest.agent;
    router.replace({ path: route.path, query: rest });
  }
  window.addEventListener('resize', onResize);
  checkConfig();
});
onUnmounted(() => window.removeEventListener('resize', onResize));
defineExpose({ checkConfig, start });
</script>

<style scoped>
.agent-ball {
  position: fixed;
  z-index: 3000;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  cursor: grab;
  user-select: none;
  touch-action: none;
  filter: drop-shadow(0 4px 12px rgba(66, 139, 255, 0.45));
  transition: transform 0.15s ease;
}
.agent-ball:hover { transform: scale(1.06); }
.agent-ball-hidden { opacity: 0; pointer-events: none; }
.agent-ball-tip {
  position: absolute;
  top: -6px;
  right: -10px;
  background: #67c23a;
  color: #fff;
  font-size: 10px;
  border-radius: 8px;
  padding: 1px 6px;
  white-space: nowrap;
}
.agent-panel {
  position: fixed;
  z-index: 3001;
  width: min(92vw, 420px);
  height: min(72vh, 540px);
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 内嵌全屏模式（/mobile）：铺满视口，安全区避让刘海/手势条，字体稍大便于手机阅读 */
.agent-panel-mobile {
  position: fixed;
  inset: 0;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100vw;
  height: 100dvh;
  border-radius: 0;
  box-shadow: none;
  z-index: 2000;
  padding-bottom: env(safe-area-inset-bottom);
}
.agent-panel-mobile .agent-bubble {
  font-size: 15px;
}
/* 项目页「AI员工」Tab 内嵌：不再是 fixed 悬浮窗，撑满宿主容器（高度由外层给） */
.agent-panel-inline {
  position: relative;
  inset: auto;
  width: 100%;
  height: 100%;
  max-width: none;
  min-height: 540px;
  border-radius: 14px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
  z-index: auto;
  padding-bottom: 0;
}
.agent-panel-mobile .agent-hd {
  padding-top: calc(10px + env(safe-area-inset-top));
  /* 手机窄屏：标题/副标题/按钮放不下时允许换行，避免互相挤压 */
  flex-wrap: wrap;
}
.agent-hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px;
  background: linear-gradient(135deg, #428bff, #6ea4ff);
  color: #fff;
}
.agent-hd-title { font-weight: 600; font-size: 14px; flex: 0 0 auto; white-space: nowrap; }
/* 副标题固定只占一行：宽度不够就省略号截断，鼠标悬浮看全文（原生 title） */
.agent-hd-sub {
  font-size: 11px;
  opacity: 0.85;
  flex: 1 1 0;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 手机全屏入口仍按原先的两行自动换行（触屏没有 hover，截断后看不到全文） */
.agent-panel-mobile .agent-hd-sub {
  flex: 1 1 auto;
  white-space: normal;
  overflow: visible;
}
.agent-hd-ops { display: flex; gap: 6px; flex: 0 0 auto; }
.agent-mini-btn {
  border: none;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  border-radius: 6px;
  font-size: 11px;
  padding: 2px 7px;
  cursor: pointer;
}
/* 三模式切换条（工作台 / 机器人 / 助理 Agent）：贴在标题栏下方，右侧靠边 */
.agent-mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: #fff;
  border-bottom: 1px solid #eef2f8;
}
/* 内嵌页（/mobile）的「首页」直达：小尺寸实心按钮，不抢切换器的视觉 */
.agent-home-btn {
  border: 1px solid #d6e4ff;
  background: #f5f8ff;
  color: #428bff;
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.6;
  padding: 2px 12px;
  cursor: pointer;
  white-space: nowrap;
}
.agent-home-btn:hover {
  background: #eaf2ff;
}
.agent-list { flex: 1; overflow-y: auto; padding: 10px; background: #f7f9fc; }
.agent-empty { color: #8a94a6; font-size: 12px; text-align: left; padding: 14px 12px; line-height: 1.7; }
.agent-row { display: flex; margin-bottom: 10px; }
.agent-row-user { justify-content: flex-end; }
.agent-row-assistant { justify-content: flex-start; }
.agent-msg-agent { max-width: 86%; display: flex; flex-direction: column; gap: 4px; }
.agent-bubble {
  padding: 8px 11px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-bubble-user { background: #428bff; color: #fff; max-width: 80%; border-bottom-right-radius: 4px; }
.agent-bubble-agent { background: #fff; color: #303133; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06); }
.agent-trace { font-size: 11px; color: #909399; margin-left: 4px; }
.agent-typing { color: #909399; }
.dot { animation: agent-blink 1.2s infinite; }
@keyframes agent-blink { 0%, 100% { opacity: 0.2; } 50% { opacity: 1; } }
.agent-action {
  background: #fff;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  padding: 10px;
  box-shadow: 0 1px 4px rgba(66, 139, 255, 0.12);
}
.agent-action-hd { font-size: 13px; font-weight: 600; color: #428bff; margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
.agent-action-row { display: flex; font-size: 12px; line-height: 1.7; }
.agent-action-k { color: #8a94a6; flex: 0 0 68px; }
.agent-action-v { color: #303133; flex: 1; word-break: break-all; white-space: pre-line; }
.agent-action-note { font-size: 12px; color: #e6a23c; line-height: 1.6; }
.agent-clarify-hours { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.agent-clarify-tip { font-size: 11px; color: #909399; }
.agent-action-ops { margin-top: 8px; display: flex; gap: 8px; justify-content: flex-end; }
.agent-action-done { font-size: 12px; color: #67c23a; background: #f0f9eb; border-radius: 8px; padding: 6px 10px; }
.agent-done-link { color: #428bff; margin-left: 8px; text-decoration: none; font-weight: 600; }
.agent-action-cancelled { color: #909399; background: #f4f4f5; }
.agent-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px 0; background: #fff; }
.agent-chip {
  border: 1px solid #d6e4ff;
  background: #f5f8ff;
  color: #428bff;
  font-size: 11px;
  border-radius: 12px;
  padding: 2px 9px;
  cursor: pointer;
}
.agent-chip:disabled { opacity: 0.5; cursor: not-allowed; }
/* 空会话能力清单：分组 + 每条都可点 */
.agent-cap-hd { color: #6b7280; margin-bottom: 8px; }
.agent-cap-group { margin-bottom: 6px; }
.agent-cap-title { font-size: 11px; color: #428bff; font-weight: 600; margin-bottom: 4px; }
.agent-chip-cap { display: inline-block; margin: 0 6px 4px 0; cursor: pointer; }
/* 只读回答里的可点跳转 */
.agent-links { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 0 4px; }
.agent-link {
  font-size: 11px;
  color: #428bff;
  text-decoration: none;
  background: #f5f8ff;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  padding: 1px 8px;
}
.agent-link:hover { background: #e8f1ff; }
.agent-input { display: flex; gap: 8px; align-items: flex-end; padding: 8px 10px 10px; background: #fff; }
/* 语音录入：聆听时的提示与麦克风呼吸灯 */
.agent-voice-tip {
  padding: 6px 12px 0;
  background: #fff;
  font-size: 11px;
  color: #f56c6c;
  font-weight: 600;
}
.voice-pulse {
  animation: agentVoicePulse 1.2s ease-in-out infinite;
}
@keyframes agentVoicePulse {
  0%,
  100% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(245, 108, 108, 0); }
}
/* 历史会话面板 */
.agent-history {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f7f9fc;
  overflow: hidden;
}
.agent-history-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  border-bottom: 1px solid #eef1f6;
  background: #fff;
}
.agent-history-list { flex: 1; overflow-y: auto; padding: 8px; }
.agent-hist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 9px;
  cursor: pointer;
  background: #fff;
  margin-bottom: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
.agent-hist-item:hover { background: #f0f6ff; }
.agent-hist-item.active { border: 1px solid #428bff; }
.agent-hist-main { flex: 1; min-width: 0; }
.agent-hist-title {
  font-size: 13px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-hist-meta { font-size: 11px; color: #909399; margin-top: 2px; }
.agent-hist-del {
  border: none;
  background: transparent;
  color: #c0c4cc;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 6px;
}
.agent-hist-del:hover { color: #f56c6c; background: #fef0f0; }
</style>
