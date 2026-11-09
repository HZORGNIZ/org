<template>
  <div class="aw">
    <!-- 1. 问候行：机器人小图标 + 时段问候 + 角色徽章 -->
    <div class="aw-hd">
      <span class="aw-avatar" v-html="robotSvg"></span>
      <div class="aw-hd-txt">
        <div class="aw-greet">{{ greetWord }}，{{ name || '你好' }}</div>
        <div class="aw-sub">我是项目助理小助手，下面这些都能帮你做 👇</div>
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

    <!-- 3. 能力云：分组胶囊，按三档差异化；点一条填进输入框，改完再发 -->
    <div class="aw-cap-hd">我能帮你做这些 · 点一条填进输入框，改完再发</div>
    <div v-for="g in capGroups" :key="g.title" class="aw-cap-group">
      <div class="aw-cap-title">{{ g.title }}</div>
      <div class="aw-cap-items">
        <button
          v-for="q in g.items"
          :key="q"
          class="aw-chip"
          :disabled="disabled"
          title="点击填入输入框，可补充或修改后再发送"
          @click="$emit('fill', q)"
        >{{ q }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

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
defineEmits<{ (e: 'fill', text: string): void }>();

const ov = computed(() => props.overview ?? null);

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
  // 没写：区分「排了班（该写）」与「没排班（不算应发）」
  return d.plannedToday ? '还没写，点下方帮我写' : '今日没排班，不算应发';
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

/** 能力云分组：按三档（员工 / 项目负责人 = 员工 + 团队视角 / 管理员 = 项目负责人 + 全站视角），每条都是真能发出的一句话 */
const CAP_GROUPS: Record<'org' | 'project' | 'member', { title: string; items: string[] }[]> = {
  member: [
    { title: '写日报 / 周报', items: ['帮我写今天的日报', '提交我本周的周报', '我这周周报还没交吗？'] },
    { title: '我的待办', items: ['我手里还有哪些待办？', '我今天该做什么？', '我有任务逾期了吗？'] },
    { title: '我的排名', items: ['我的公司排名怎么样？', '我这个月写了几篇日报？', '我工时排第几？'] },
    { title: '我的工作时间', items: ['我现在的工作时间是怎么排的？', '帮我把周一到周五设成 9:30-19:00', '我周六要写日报吗？'] },
    { title: '我的会议', items: ['我今天有没有会要参加？', '我这周有哪些会议？'] },
    { title: '找沉淀', items: ['知识库里有没有写过部署流程？', '这个事的标准做法（SOP）是什么？'] },
  ],
  project: [
    { title: '我的项目', items: ['我项目现在进度怎么样？', '我项目最近有什么风险？', '我项目下谁的任务逾期了？'] },
    { title: '团队交报与排行', items: ['我项目下今天还有谁没交日报？', '我们项目谁工时最多？', '这周谁还没交周报？'] },
    { title: '开会', items: ['明天 15:00 开个项目周会，参会：张三、李四', '把我那个未发布的草稿会议发布出去'] },
    { title: '催办', items: ['催大家写今天的日报', '把没交周报的催一下', '把逾期任务催一下，发到项目群'] },
    { title: '组员任务', items: ['帮我把张三的“测试报告”标成已完成', '把李四那个任务的截止推到下周五'] },
    { title: '我自己的', items: ['帮我写今天的日报', '我的公司排名怎么样？', '帮我设置我的工作时间'] },
    { title: '找沉淀', items: ['知识库里有没有写过部署流程？', '这个事的标准做法（SOP）是什么？'] },
  ],
  org: [
    { title: '全站情况', items: ['全站项目的进度怎么样？', '最近有什么风险？', '全站工时排名谁第一？', '这周谁还没交周报？'] },
    { title: '预警提醒', items: ['把风险项目提醒对应负责人', '需关注的项目也提一提'] },
    { title: '统一通知', items: ['把这条通知发到公司群：今天下午 6 点例会', '给张三、李四发个提醒'] },
    { title: '派活与催办', items: ['给张三加一条任务：11-06 前交测试报告', '催大家写今天的日报', '把逾期任务催一下，发到项目群'] },
    { title: '开会', items: ['明天 15:00 开个项目周会，参会：张三、李四', '把我那个未发布的草稿会议发布出去'] },
    { title: '我自己的', items: ['帮我写今天的日报', '我的公司排名怎么样？', '帮我设置我的工作时间'] },
    { title: '找沉淀', items: ['知识库里有没有写过部署流程？', '新人入职的标准 SOP 是什么？'] },
  ],
};
const capGroups = computed(() => CAP_GROUPS[props.bucket] ?? CAP_GROUPS.member);

// 问候行小机器人图标（scoped 样式里对 v-html 注入的 svg 用 :deep）
const robotSvg =
  '<svg viewBox="0 0 48 48" width="30" height="30">' +
  '<circle cx="24" cy="24" r="23" fill="#428bff" />' +
  '<rect x="13" y="16" width="22" height="16" rx="5" fill="#fff" />' +
  '<circle cx="20" cy="24" r="2.4" fill="#428bff" />' +
  '<circle cx="28" cy="24" r="2.4" fill="#428bff" />' +
  '<rect x="21" y="9" width="6" height="4" rx="2" fill="#fff" />' +
  '<line x1="24" y1="13" x2="24" y2="16" stroke="#fff" stroke-width="2" />' +
  '</svg>';
</script>

<style scoped>
.aw {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 8px;
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
