<template>
  <div class="aw">
    <!-- 1. 问候行：机器人小图标 + 时段问候 + 角色徽章 -->
    <div class="aw-hd">
      <span class="aw-avatar"><AgentRobot :size="42" /></span>
      <div class="aw-hd-txt">
        <div class="aw-greet">{{ greetWord }}，{{ name || '你好' }}</div>
        <div class="aw-sub">嗨，想进来做什么？点下面的卡片直达，或直接打字。</div>
      </div>
      <span class="aw-badge" :class="'aw-badge-' + bucket">{{ roleLabel }}</span>
    </div>

    <!-- 2. 今日速览（4 格）：确定性拼数据，取不到就整块隐藏，不白屏 -->
    <div v-if="ov" class="aw-grid">
      <div class="aw-cell">
        <div class="aw-cell-k">待办</div>
        <div class="aw-cell-v">{{ ov.todo ? ov.todo.count : '—' }}<span class="aw-unit">条</span></div>
        <div class="aw-cell-x" :class="{ 'aw-warn': (ov.todo?.overdue ?? 0) > 0 }">
          {{ ov.todo ? (ov.todo.overdue > 0 ? `含逾期 ${ov.todo.overdue} 条` : '暂无逾期') : '待办加载中' }}
        </div>
      </div>
      <div class="aw-cell">
        <div class="aw-cell-k">今天会议</div>
        <div class="aw-cell-v">{{ ov.meetings?.count ?? 0 }}<span class="aw-unit">场</span></div>
        <div class="aw-cell-x">{{ meetingHint }}</div>
      </div>
      <div class="aw-cell">
        <div class="aw-cell-k">今日日报</div>
        <div class="aw-cell-v">{{ dailyState }}</div>
        <div class="aw-cell-x">{{ dailyHint }}</div>
      </div>
      <div class="aw-cell">
        <div class="aw-cell-k">{{ ov.ranking?.label || '本月' }}排名</div>
        <div class="aw-cell-v aw-cell-v-sm">{{ rankText }}</div>
        <div class="aw-cell-x">{{ rankSub }}</div>
      </div>
    </div>
    <div v-else-if="!loading" class="aw-grid-off">今日速览暂时没取到，你可以直接问我 ↓</div>

    <!-- 3. 进门卡片（收敛方案 v1）：按角色给 4 张卡，点了直达对应智能体并自动发出预设问题 -->
    <div class="aw-cards">
      <button
        v-for="c in cards"
        :key="c.title"
        class="aw-card"
        :class="{ 'aw-card-split': c.split }"
        :disabled="disabled"
        @click="onCard(c)"
      >
        <span class="aw-card-t">{{ c.title }}</span>
        <span class="aw-card-d">{{ c.desc }}</span>
        <span v-if="c.split" class="aw-card-opts">
          <span
            v-for="o in c.opts"
            :key="o.bot"
            class="aw-card-opt"
            @click.stop="onCard(o)"
          >{{ o.label }}</span>
        </span>
      </button>
    </div>

    <!-- 4. 常用快捷问：点一条填进输入框，改完再发 -->
    <div class="aw-cap-hd">常用 · 点一条填进输入框，改完再发</div>
    <div class="aw-cap-items">
      <button
        v-for="q in quickList"
        :key="q"
        class="aw-chip"
        :disabled="disabled"
        title="点击填入输入框，可补充或修改后再发送"
        @click="$emit('fill', q)"
      >{{ q }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AgentRobot from './AgentRobot.vue';

/**
 * 智能体助手首屏欢迎屏：三入口（首页悬浮窗 / /mobile 全屏）共用同一空态。
 * 只做展示与「点胶囊填输入框」，不发起任何请求——数据由父组件一次性取 /agent/overview 传下来；
 * overview 取失败（null）时整块速览隐藏，只留能力云，保证不白屏。
 */
const props = withDefaults(
  defineProps<{
    name?: string;
    bucket?: 'org' | 'project' | 'member';
    /** /agent/overview 返回体；为 null 表示未取到（降级只显示能力云） */
    overview?: any | null;
    loading?: boolean;
    disabled?: boolean;
  }>(),
  { name: '', bucket: 'member', overview: null, loading: false, disabled: false },
);
const emit = defineEmits<{ (e: 'fill', text: string): void; (e: 'go', card: { bot?: string; text?: string }): void }>();

const ov = computed(() => props.overview ?? null);

/** 进门卡片：成员 3 张 / 管理者（org/project 档）4 张；split 卡内含子选项 */
interface WelcomeCard { title: string; desc: string; bot?: string; text?: string; split?: boolean; opts?: { label: string; bot: string; text?: string }[] }
const CARDS: Record<'org' | 'project' | 'member', WelcomeCard[]> = {
  member: [
    { title: '写我的日报', desc: 'AI 拉取今天的进展自动成稿，我确认后提交', bot: 'assistant', text: '帮我写今天的日报' },
    { title: '没处理的任务', desc: '待办清单 + 逾期提醒 + 建议顺序', bot: 'assistant', text: '列出我还没处理的任务和逾期项' },
    { title: '我的会 · 约时间', desc: '查我的日程；约书书老师 / 杨老师的时间', bot: 'booking', text: '我想约老师的时间' },
  ],
  project: [
    { title: '项目风险扫描', desc: '延期项目 · 逾期任务 · 连续无日报', bot: 'assistant', text: '扫一下当前项目风险：延期项目、逾期任务、连续没交日报的项目' },
    { title: '催一下日报', desc: '列出未交名单，我确认后发群催办', bot: 'assistant', text: '查一下今天谁还没交日报，列个名单，我确认后发群催办' },
    { title: '待我确认', desc: '项目审批 · PBC · 别人约我的时间', bot: 'assistant', text: '列出现在需要我确认的事项：项目审批、PBC 计划与考核、别人约我的时间' },
    { title: '我的开放时间与预约', desc: '维护可约时段 · 确认/拒绝预约', bot: 'booking', text: '查看我的待确认预约和可约时间' },
  ],
  org: [
    { title: '项目风险扫描', desc: '全站延期项目 · 逾期任务 · 无日报', bot: 'assistant', text: '扫一下全站项目风险：延期项目、逾期任务、连续没交日报的项目' },
    { title: '催一下日报', desc: '全站未交名单，我确认后发群催办', bot: 'assistant', text: '查一下今天全站谁还没交日报，列个名单，我确认后发群催办' },
    { title: '待我确认', desc: '项目审批 · PBC · 别人约我的时间', bot: 'assistant', text: '列出现在需要我确认的事项：项目审批、PBC 计划与考核、别人约我的时间' },
    { title: '我的开放时间与预约', desc: '维护可约时段 · 确认/拒绝预约', bot: 'booking', text: '查看我的待确认预约和可约时间' },
  ],
};
const cards = computed(() => CARDS[props.bucket] ?? CARDS.member);

/** 常用快捷问：每档 6 条以内，不再分组成堆 */
const QUICK: Record<'org' | 'project' | 'member', string[]> = {
  member: ['我这周周报还没交吗？', '我今天有没有会要参加？', '我现在的工作时间是怎么排的？', '知识库里有没有部署流程的文档？', '我的公司排名怎么样？'],
  project: ['我项目现在进度怎么样？', '我项目下谁的任务逾期了？', '明天 15:00 开个项目周会，参会：张三、李四', '这周谁还没交周报？', '知识库里有没有部署流程的文档？'],
  org: ['全站项目的进度怎么样？', '这周谁还没交周报？', '把这条通知发到公司群：今天下午 6 点例会', '全站工时排名谁第一？', '新人入职的标准 SOP 是什么？'],
};
const quickList = computed(() => QUICK[props.bucket] ?? QUICK.member);

function onCard(c: { bot?: string; text?: string }) {
  if (props.disabled) return;
  emit('go', { bot: c.bot, text: c.text });
}

// 时段问候：按北京墙钟（与服务端日期戳同一口径），不依赖容器时区
const greetWord = computed(() => {
  const bjHour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  if (bjHour < 12) return '上午好';
  if (bjHour < 18) return '下午好';
  return '晚上好';
});
const roleLabel = computed(() => (props.bucket === 'org' ? '管理员' : props.bucket === 'project' ? '项目负责人' : '员工'));

const meetingHint = computed(() => {
  const items = ov.value?.meetings?.items ?? [];
  if (!items.length) return '今天没有安排会议';
  const first = items[0];
  return items.length === 1 ? `${first.time} ${first.title}` : `${first.time} ${first.title} 等`;
});

const dailyState = computed(() => {
  const d = ov.value?.daily;
  if (!d) return '—';
  return d.wrote ? '已写' : '未写';
});
const dailyHint = computed(() => {
  const d = ov.value?.daily;
  if (!d) return '日报状态加载中';
  if (d.wrote) return `今日工时 ${d.todayHours || '—'} 小时`;
  // 没写：区分「勾选了时段（该写）」与「没勾选（不算应发）」
  return d.plannedToday ? '还没写，点下方帮我写' : '今日未勾选时段，不算应发';
});

const rankText = computed(() => {
  const r = ov.value?.ranking;
  if (!r) return '—';
  const parts: string[] = [];
  parts.push(r.hoursRank ? `工时第 ${r.hoursRank}` : '工时未入榜');
  parts.push(r.reportRank ? `日报第 ${r.reportRank}` : '日报未入榜');
  return parts.join(' · ');
});
const rankSub = computed(() => {
  const r = ov.value?.ranking;
  if (!r) return '排名加载中';
  if (!r.hoursRank && !r.reportRank) return '该时段还没有已发布的带工时日报';
  return `共 ${r.hoursTotal || 0} 人参与 · 我本月日报 ${r.myReportCount ?? 0} 篇`;
});


// 问候行小机器人图标已换成 AgentRobot 形象组件（与悬浮球/面板头同一套 SVG）
</script>

<style scoped>
.aw {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 8px;
}
/* 科技感底纹：淡蓝细网格 + 左上角一圈柔光，让欢迎区更像“智能体驾驶舱” */
.aw {
  position: relative;
  background-image: repeating-linear-gradient(0deg, rgba(66, 139, 255, 0.05) 0, rgba(66, 139, 255, 0.05) 1px, transparent 1px, transparent 22px),
    repeating-linear-gradient(90deg, rgba(66, 139, 255, 0.05) 0, rgba(66, 139, 255, 0.05) 1px, transparent 1px, transparent 22px);
  border-radius: 12px;
}
.aw-hd {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aw-avatar {
  display: inline-flex;
  flex: none;
  filter: drop-shadow(0 2px 6px rgba(66, 139, 255, 0.35));
}
.aw-avatar :deep(svg) { display: block; }
.aw-hd-txt { flex: 1; min-width: 0; }
.aw-greet {
  font-size: 16px;
  font-weight: 600;
  color: #1f2d3d;
  line-height: 1.3;
}
.aw-sub {
  font-size: 12px;
  color: #8a94a6;
  margin-top: 2px;
}
.aw-badge {
  flex: none;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  color: #fff;
  background: #909399;
}
.aw-badge-org { background: #e6a23c; }
.aw-badge-project { background: #409eff; }
.aw-badge-member { background: #67c23a; }

.aw-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.aw-grid-off {
  font-size: 12px;
  color: #b0b6c3;
  padding: 6px 2px;
}
.aw-cell {
  background: linear-gradient(180deg, #f6f9ff 0%, #f2f6fd 100%);
  border: 1px solid #e6effc;
  border-radius: 10px;
  padding: 8px 10px;
  min-width: 0;
}
.aw-cell-k {
  font-size: 11px;
  color: #8a94a6;
}
.aw-cell-v {
  font-size: 20px;
  font-weight: 700;
  color: #1f2d3d;
  line-height: 1.2;
  margin-top: 2px;
}
.aw-cell-v-sm { font-size: 14px; }
.aw-unit {
  font-size: 11px;
  font-weight: 400;
  color: #8a94a6;
  margin-left: 2px;
}
.aw-cell-x {
  font-size: 11px;
  color: #9aa4b2;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.aw-warn { color: #f56c6c; }

/* 进门卡片：2×2 网格，标题 + 一句话说明；split 卡内含子按钮 */
.aw-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.aw-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  text-align: left;
  background: #fff;
  border: 1px solid #e2ebf8;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  min-width: 0;
}
.aw-card:hover:not(:disabled) {
  border-color: #bcd6fb;
  background: #f2f8ff;
}
.aw-card:disabled { opacity: 0.6; cursor: not-allowed; }
.aw-card-t {
  font-size: 13px;
  font-weight: 600;
  color: #1f5fd0;
}
.aw-card-d {
  font-size: 11px;
  color: #8a94a6;
  line-height: 1.4;
}
.aw-card-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}
.aw-card-opt {
  font-size: 11px;
  color: #3a4a63;
  background: #f2f6fd;
  border: 1px solid #e2ebf8;
  border-radius: 12px;
  padding: 3px 9px;
  cursor: pointer;
}
.aw-card-opt:hover {
  background: #e7f0fd;
  border-color: #bcd6fb;
  color: #1f5fd0;
}

.aw-cap-hd {
  font-size: 13px;
  color: #5a6b8c;
  font-weight: 600;
  margin-top: 2px;
}
.aw-cap-group { margin-top: 6px; }
.aw-cap-title {
  font-size: 12px;
  color: #428bff;
  font-weight: 600;
  margin-bottom: 4px;
}
.aw-cap-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.aw-chip {
  font-size: 12px;
  color: #3a4a63;
  background: #f2f6fd;
  border: 1px solid #e2ebf8;
  border-radius: 14px;
  padding: 4px 10px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: normal;
  text-align: left;
}
.aw-chip:hover:not(:disabled) {
  background: #e7f0fd;
  border-color: #bcd6fb;
  color: #1f5fd0;
}
.aw-chip:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
