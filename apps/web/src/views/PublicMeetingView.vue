<template>
  <div class="pm-page">
    <ScoreBurst ref="burst" />

    <div v-if="loading && !data" class="pm-loading">加载中…</div>
    <div v-else-if="error" class="pm-error">
      <div class="pm-error-icon">🙈</div>
      <div class="pm-error-title">{{ error }}</div>
      <div class="pm-error-tip">请向活动组织者确认链接是否正确</div>
    </div>

    <!-- 访问密码门：发起人设了密码的活动，输对密码才能进主页 -->
    <div v-else-if="gate" class="pm-gate">
      <div class="pm-card">
        <div class="pm-gate-icon">🔒</div>
        <div class="pm-gate-title">该活动需要访问密码</div>
        <div class="pm-gate-tip">活动对所有人开放，发起人设置了访问密码，输入正确即可进入活动主页</div>
        <el-input
          v-model="gatePwd"
          type="password"
          show-password
          maxlength="20"
          placeholder="请输入访问密码"
          class="pm-field"
          @keyup.enter="submitGate"
        />
        <el-button type="primary" class="pm-btn" :loading="gateSubmitting" @click="submitGate">进入活动</el-button>
      </div>
    </div>

    <template v-else-if="data">
      <!-- 右上角常驻二维码：不小心退出 / 关掉页面，扫它就能回到本页（签到状态自动恢复） -->
      <button type="button" class="pm-qr-fab" title="扫码回到本页" aria-label="扫码回到本页" @click="qrOpen = true">
        <span class="pm-qr-fab-img" v-html="pageQr" />
        <span class="pm-qr-fab-tip">扫码回页</span>
      </button>

      <!-- 活动头部 -->
      <header class="pm-hero">
        <div class="pm-hero-top">
          <span class="pm-brand">会议活动 · 对外</span>
          <span class="pm-status" :class="statusClass">{{ STATUS_TEXT[data.meeting.status] || data.meeting.status }}</span>
        </div>
        <h1 class="pm-title">{{ data.meeting.title }}</h1>
        <div class="pm-meta">
          <span>{{ TYPE_LABEL[data.meeting.type] || data.meeting.type }}</span>
          <span class="pm-dot">·</span>
          <span>重要性 {{ IMPORTANCE[data.meeting.important] || '中' }}</span>
          <span class="pm-dot">·</span>
          <span>{{ data.meeting.ownerName }} 组织</span>
        </div>
        <div class="pm-meta">
          <span>{{ fmt(data.meeting.startAt, 'MM-DD HH:mm') }} ~ {{ fmt(data.meeting.endAt, 'HH:mm') }}</span>
          <template v-if="data.meeting.location">
            <span class="pm-dot">·</span>
            <span>{{ data.meeting.location }}</span>
          </template>
        </div>
        <div v-if="data.meeting.cancelledReason" class="pm-warn">已取消：{{ data.meeting.cancelledReason }}</div>

        <div class="pm-stats">
          <div class="pm-stat">
            <b>{{ data.stats.checkedCount }}</b>
            <span>已签到</span>
          </div>
          <div class="pm-stat">
            <b>{{ data.stats.guestCount }}</b>
            <span>外部来宾</span>
          </div>
          <div class="pm-stat">
            <b>{{ data.stats.groupCount }}</b>
            <span>小组</span>
          </div>
          <div class="pm-stat">
            <b>{{ data.stats.scoreTotal }}</b>
            <span>总加分</span>
          </div>
        </div>
      </header>

      <main class="pm-body">
        <!-- 陌生人签到 -->
        <section class="pm-card">
          <div class="pm-card-head">
            <h2>签到</h2>
            <span class="pm-muted">姓名 + 手机号 + 性别（男 / 女）</span>
          </div>
          <div v-if="me.name" class="pm-checked">
            <span class="pm-checked-icon">✅</span>
            <div class="pm-checked-main">
              <div class="pm-checked-name">
                {{ me.name }} 已签到
                <span v-if="me.gender" class="pm-gender-tag" :class="me.gender === 'FEMALE' ? 'girl' : 'boy'">{{ me.gender === 'FEMALE' ? '女' : '男' }}</span>
              </div>
              <div class="pm-muted">
                当前得分 <b class="pm-score">{{ myPoints }}</b>
                <template v-if="!data.quiz.enabled"> · 活动进行中</template>
              </div>
              <el-button size="small" text type="primary" class="pm-edit-link" @click="toggleEdit">
                {{ editing ? '取消修改' : '姓名 / 手机号填错了？修改' }}
              </el-button>
            </div>
          </div>
          <template v-else>
            <el-input v-model="form.name" placeholder="你的姓名" maxlength="20" class="pm-field" />
            <el-input v-model="form.phone" placeholder="手机号（用于区分同名）" maxlength="11" class="pm-field" inputmode="numeric" />
            <!-- 性别二选一：座位图上男士浅蓝、女士浅粉 -->
            <div class="pm-gender">
              <span class="pm-gender-label">性别</span>
              <el-radio-group v-model="form.gender">
                <el-radio-button value="MALE">男</el-radio-button>
                <el-radio-button value="FEMALE">女</el-radio-button>
              </el-radio-group>
            </div>
            <el-button type="primary" class="pm-btn" :loading="checking" @click="doCheckin">签到</el-button>
          </template>

          <!-- 填错了可以改：改对姓名 + 手机号会自动匹配上现有成员 -->
          <div v-if="me.name && editing" class="pm-edit">
            <el-input v-model="editForm.name" placeholder="姓名" maxlength="20" class="pm-field" />
            <el-input v-model="editForm.phone" placeholder="手机号" maxlength="11" class="pm-field" inputmode="numeric" />
            <div class="pm-gender">
              <span class="pm-gender-label">性别</span>
              <el-radio-group v-model="editForm.gender">
                <el-radio-button value="MALE">男</el-radio-button>
                <el-radio-button value="FEMALE">女</el-radio-button>
              </el-radio-group>
            </div>
            <el-button type="primary" class="pm-btn" :loading="savingEdit" @click="doUpdate">保存修改</el-button>
            <div class="pm-muted pm-tip">改成与注册用户一致的姓名和手机号，会重新匹配并记入你的活动记录</div>
          </div>
        </section>

        <!-- 自由组队：扫了码就能自己拉小组，一人只能在一个组 -->
        <section class="pm-card">
          <div class="pm-card-head">
            <h2>自由组队</h2>
            <span class="pm-muted">
              <template v-if="!me.guestId">先签到才能组队</template>
              <template v-else-if="myGroup">我在「{{ myGroup.name }}」· 头像可拖到别的小组</template>
              <template v-else>还没进组 · 把头像拖到小组里即可加入</template>
            </span>
          </div>

          <template v-if="me.guestId">
            <!-- 自己的头像：拖到下面的小组上就加入，拖到新建区就自己当组长建一个组 -->
            <div class="pm-myteam">
              <button
                type="button"
                class="pm-myavatar"
                :class="{ pulling: teamDrag.isSource('me') }"
                :style="avatarInk({ name: me.name || '我', gender: me.gender })"
                :title="isTouch ? '长按头像不松手，拖到下面的小组上即可加入' : '把自己的头像拖到下面的小组上即可加入'"
                draggable="true"
                @dragstart="teamDrag.onDragStart($event, meSource)"
                @dragend="teamDrag.onDragEnd()"
                @touchstart="teamDrag.onTouchStart($event, meSource)"
                @touchmove="teamDrag.onTouchMove($event)"
                @touchend="teamDrag.onTouchEnd()"
                @touchcancel="teamDrag.onTouchCancel()"
              >
                {{ avatarText(me.name || '我') }}
              </button>
              <span class="pm-muted">
                {{ isTouch ? '长按上面这个头像不松手' : '把上面这个头像拖住' }}，拖到哪个小组就加入哪个组；拖到下面「新建小组」就自己当组长，拖到「移出小组」就退组
              </span>
            </div>

            <!-- 已经在一个组里：改组名 / 当组长 / 退出 / 解散 -->
            <div v-if="myGroup" class="pm-team-new">
              <el-input v-model="groupForm.name" placeholder="组名" maxlength="20" class="pm-field" />
              <div class="pm-team-ops">
                <el-button size="small" type="primary" :loading="groupBusy" :disabled="!groupForm.name.trim()" @click="doRenameGroup">改组名</el-button>
                <el-button v-if="!myGroupLeaderName" size="small" :loading="groupBusy" @click="doBeLeader">我来当组长</el-button>
                <span v-else-if="!isMyLeader" class="pm-muted">组长 {{ myGroupLeaderName }}</span>
                <el-button size="small" plain :loading="groupBusy" @click="doLeaveGroup">退出小组</el-button>
                <el-button v-if="isMyLeader" size="small" type="danger" plain :loading="groupBusy" @click="doRemoveGroup">解散小组</el-button>
              </div>
            </div>
            <!-- 还没进组：起个组名就当组长 -->
            <div v-else class="pm-team-new">
              <el-input v-model="groupForm.name" placeholder="给你的小组起个名（如：第一排三兄弟）" maxlength="20" class="pm-field" />
              <el-button type="primary" class="pm-btn" :loading="groupBusy" :disabled="!groupForm.name.trim()" @click="doCreateGroup">建组，我当组长</el-button>
            </div>

            <div
              v-for="g in joinableGroups"
              :key="g.id"
              class="pm-team"
              :class="{ 'pm-drop-over': teamDrag.isOver(g.id) }"
              :data-drop-key="g.id"
              @dragover="teamDrag.onDragOver($event, g.id)"
              @dragleave="teamDrag.onDragLeave(g.id)"
              @drop.prevent="teamDrag.onDrop($event, g.id)"
            >
              <div class="pm-team-main">
                <div class="pm-team-name">
                  {{ g.name }}
                  <span class="pm-muted">{{ g.leaderName ? `组长 ${g.leaderName} · ` : '' }}{{ g.memberCount }} 人</span>
                  <span v-if="teamDrag.isOver(g.id)" class="pm-drop-tip">放到这里 · 我加入本组</span>
                </div>
                <div class="pm-group-members">
                  <span v-for="m in g.members" :key="m.guestId || m.userId || m.name" class="pm-chip" :class="{ leader: m.isLeader }">
                    {{ m.name }}<b v-if="m.points"> {{ m.points }}</b>
                  </span>
                </div>
              </div>
              <div class="pm-team-ops">
                <el-button size="small" type="primary" plain :loading="groupBusy" @click="doJoinGroup(g.id)">
                  {{ myGroup ? '换到这个组' : '加入' }}
                </el-button>
              </div>
            </div>
            <div v-if="!joinableGroups.length" class="pm-muted pm-tip">还没有别的小组，你可以先建一个，旁边的人就能加入</div>

            <!-- 拖头像到这块空白区 = 自己新建一个小组 -->
            <div
              class="pm-newteam"
              :class="{ over: teamDrag.isOver('new') }"
              data-drop-key="new"
              @dragover="teamDrag.onDragOver($event, 'new')"
              @dragleave="teamDrag.onDragLeave('new')"
              @drop.prevent="teamDrag.onDrop($event, 'new')"
            >
              <span class="pm-newteam-icon">＋</span>
              <span>{{ teamDrag.isOver('new') ? '松手：自己单独建一个小组，你就是组长' : '把头像拖到这里 = 新建一个小组（你就是组长）' }}</span>
            </div>

            <!-- 已经在组里才给退组的投放区 -->
            <div
              v-if="myGroup"
              class="pm-leaveteam"
              :class="{ over: teamDrag.isOver('leave') }"
              data-drop-key="leave"
              @dragover="teamDrag.onDragOver($event, 'leave')"
              @dragleave="teamDrag.onDragLeave('leave')"
              @drop.prevent="teamDrag.onDrop($event, 'leave')"
            >
              <span class="pm-leaveteam-icon">✕</span>
              <span>{{ teamDrag.isOver('leave') ? '松手：移出这个小组，回到未分组' : '把头像拖到这里 = 移出小组（回到未分组）' }}</span>
            </div>
            <div class="pm-muted pm-tip">同一组的人会挨在一起；建组 / 加入后可以到上面的座位图里把小组拖到大致真实的位置</div>
          </template>
          <div v-else class="pm-empty">扫码签到后就能自己拉小组（填姓名 + 手机号 + 性别即可）</div>
        </section>

        <!-- 会场座位图：名字就是头像，拖头像分组，同组的人待在一起 -->
        <section class="pm-card">
          <MeetingSeatMap
            :board="data"
            :meeting-id="adminMeetingId"
            :can-drag="canManage || canGroup || !!me.guestId"
            :my-group-ids="canManage || canGroup ? [] : myGroupIds"
            :seat-saver="seatSaver"
            :me-id="myUserId"
            :can-group="canManage"
            :my-guest-id="me.guestId"
            @refresh="load(false, true)"
            @assign="onSeatAssign"
            @unassign="onSeatUnassign"
            @score="onSeatScore"
          />
        </section>

        <!-- 答题加分 -->
        <section v-if="data.quiz.enabled" class="pm-card">
          <div class="pm-card-head">
            <h2>答题加分</h2>
            <span class="pm-quiz-points">答对 +{{ data.quiz.points }}</span>
          </div>
          <div class="pm-question">{{ data.quiz.question }}</div>
          <template v-if="quizDone">
            <div class="pm-ok">已提交，等待活动组织者 / 助教审批</div>
          </template>
          <template v-else>
            <el-input v-model="quiz.answer" placeholder="填写你的答案" maxlength="60" class="pm-field" />
            <el-input v-model="quiz.reason" placeholder="加分理由（可选，比如：第一个答对）" maxlength="60" class="pm-field" />
            <el-button type="primary" class="pm-btn" :loading="quizSending" @click="doQuiz">提交答案</el-button>
            <div class="pm-muted pm-tip">答对后加分需组织者审批通过才计入得分</div>
          </template>
        </section>

        <!-- 小组得分（实时） -->
        <section class="pm-card">
          <div class="pm-card-head">
            <h2>小组得分</h2>
            <span class="pm-muted">实时 · 每 5 秒刷新</span>
          </div>
          <div v-if="!data.groups.length" class="pm-empty">还没有人分组（座位相邻的人可以自己组队）</div>
          <div v-for="(g, i) in data.groups" :key="g.id" class="pm-group" :class="{ top: i === 0 }">
            <div class="pm-group-rank">{{ i + 1 }}</div>
            <div class="pm-group-main">
              <div class="pm-group-name">
                {{ g.name }}
                <span v-if="i === 0 && g.score > 0" class="pm-crown">👑</span>
              </div>
              <div class="pm-muted">
                {{ g.leaderName ? `组长 ${g.leaderName} · ` : '' }}{{ g.memberCount }} 人
              </div>
              <div class="pm-group-members">
                <span v-for="m in g.members" :key="m.name + m.points" class="pm-chip" :class="{ leader: m.isLeader }">
                  {{ m.name }}<b v-if="m.points"> {{ m.points }}</b>
                </span>
              </div>
            </div>
            <div class="pm-group-score" :class="{ hot: i === 0 }">{{ g.score }}</div>
          </div>
        </section>

        <!-- 现场管理：组织者 / 助教打开同一个链接就是管理页 -->
        <section v-if="canManage || canGroup" class="pm-card pm-admin">
          <div class="pm-card-head">
            <h2>现场管理</h2>
            <span class="pm-muted">{{ canManage ? '你是本场组织者 / 助教' : '你是本场参会人' }}</span>
          </div>
          <MeetingActivityPanel
            ref="panelRef"
            :meeting-id="adminMeetingId"
            :board="data"
            :can-manage="canManage"
            :can-group="canGroup"
            :me-id="myUserId"
            @refresh="load(false, true)"
            @burst="playBurst"
          />
        </section>

        <!-- 个人得分 -->
        <section class="pm-card">
          <div class="pm-card-head">
            <h2>个人得分</h2>
            <span class="pm-muted">{{ people.length }} 人</span>
          </div>
          <div class="pm-people">
            <div v-for="p in people" :key="p.key" class="pm-person">
              <span class="pm-person-name">
                {{ p.name }}
                <span v-if="p.isOwner" class="pm-tag">组织者</span>
                <span v-else-if="p.isAssistant" class="pm-tag assistant">助教</span>
                <span v-else-if="p.kind === 'GUEST'" class="pm-tag guest">来宾</span>
              </span>
              <span class="pm-person-score">{{ p.points }}</span>
            </div>
            <div v-if="!people.length" class="pm-empty">还没有参与记录</div>
          </div>
        </section>

        <!-- 加分动态 -->
        <section v-if="data.recent.length" class="pm-card">
          <div class="pm-card-head"><h2>加分动态</h2></div>
          <div v-for="r in data.recent" :key="r.id" class="pm-feed">
            <span class="pm-feed-thumb">👍</span>
            <div class="pm-feed-main">
              <div>
                <b>{{ r.name }}</b>
                <span class="pm-feed-points">+{{ r.points }}</span>
                <span v-if="r.source === 'QUIZ'" class="pm-tag">答题</span>
              </div>
              <div v-if="r.reason" class="pm-muted">{{ r.reason }}</div>
            </div>
            <span class="pm-muted pm-feed-time">{{ timeAgo(r.createdAt) }}</span>
          </div>
        </section>

        <div class="pm-footer">数据实时同步 · 仅供本场活动参与者查看</div>
      </main>

      <!-- 放大二维码：给旁边的人扫，或长按识别 / 保存 -->
      <el-dialog v-model="qrOpen" title="扫码回到本页" width="min(320px, 92vw)" align-center>
        <div class="pm-qr-big">
          <img :src="pageQrImg" alt="本活动页二维码" />
        </div>
        <div class="pm-qr-note">
          不小心退出了？扫这个二维码就能回到本页，已签到、得分和小组都会自动恢复；也可以长按二维码识别，或把本页收进微信浮窗。
        </div>
        <el-button class="pm-btn" @click="copyPageUrl">复制本页链接</el-button>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import ScoreBurst from '../components/ScoreBurst.vue';
import MeetingActivityPanel from '../components/MeetingActivityPanel.vue';
import MeetingSeatMap from '../components/MeetingSeatMap.vue';
import { meetingsApi, publicMeetingsApi } from '../api';
import { avatarInk, avatarText } from '../utils/avatar';
import { fmt, timeAgo } from '../utils/format';
import { qrDataUrl, qrSvg } from '../utils/qr';
import { isTouchDevice, useDragTo } from '../utils/useDragTo';

const TYPE_LABEL: Record<string, string> = { WEEKLY: '周会', DAILY: '日会站会', PROJECT: '项目会', REVIEW: '评审会', ACTIVITY: '活动', OTHER: '其他' };
const IMPORTANCE: Record<string, string> = { HIGH: '高', MEDIUM: '中', LOW: '低' };
const STATUS_TEXT: Record<string, string> = { DRAFT: '筹备中', SCHEDULED: '待开始', IN_PROGRESS: '进行中', MINUTING: '整理中', DONE: '已结束', CANCELLED: '已取消' };

const route = useRoute();
const token = String(route.params.token || '');

// ---------- 右上角常驻二维码：退出后扫码回到本页 ----------
// 二维码内容 = 本页对外链接（同一个 token），重新打开时按 localStorage 里的 guestId 恢复签到状态
const pageUrl = computed(() => (token ? `${location.origin}/share/meeting/${token}` : ''));
const pageQr = computed(() => (pageUrl.value ? qrSvg(pageUrl.value, { cellSize: 4, margin: 1 }) : ''));
const pageQrImg = computed(() => (pageUrl.value ? qrDataUrl(pageUrl.value, { cellSize: 8, margin: 2 }) : ''));
const qrOpen = ref(false);

async function copyPageUrl() {
  if (!pageUrl.value) return;
  try {
    await navigator.clipboard.writeText(pageUrl.value);
    ElMessage.success('本页链接已复制');
  } catch {
    ElMessage.warning(`复制失败，请手动复制：${pageUrl.value}`);
  }
}

const data = ref<any>(null);
const loading = ref(false);
const error = ref('');
// ---------- 访问密码门 ----------
/** 命中密码门：展示密码输入卡片，不加载活动数据 */
const gate = ref(false);
const gatePwd = ref('');
const gateSubmitting = ref(false);
const burst = ref<InstanceType<typeof ScoreBurst> | null>(null);
/** 当前浏览器有登录态时，同一链接切到管理视角（组织者 / 助教 / 参会人） */
const myUserId = ref('');
const canManage = computed(() => !!data.value?.permissions?.canManage);
const canGroup = computed(() => !!data.value?.permissions?.canGroup);
const adminMeetingId = computed(() => String(data.value?.meeting?.id || ''));

const form = reactive({ name: '', phone: '', gender: '' });
const editForm = reactive({ name: '', phone: '', gender: '' });
const quiz = reactive({ answer: '', reason: '' });
const checking = ref(false);
const savingEdit = ref(false);
/** 已签到的人可以改自己填错的姓名 / 手机号 */
const editing = ref(false);
const quizSending = ref(false);
const quizDone = ref(false);
/** 本机记住的签到身份（刷新/重开链接仍是自己） */
const me = reactive({ name: '', phone: '', guestId: '', gender: '' });

/** 自由组队：建组 / 加入 / 退出都在同一个链接里完成，不需要账号 */
const groupForm = reactive({ name: '' });
const groupBusy = ref(false);
/** 我所在的组：用签到拿到的 guestId 在成员里找自己（已关联注册账号时组织者可能按 userId 把 TA 分进去了） */
const myGroup = computed(() => {
  const d = data.value;
  if (!d || !me.guestId) return null;
  const linked = String((d.guests || []).find((x: any) => x.guestId === me.guestId)?.linkedUserId || '');
  return (
    (d.groups || []).find(
      (g: any) => (g.members || []).some((m: any) => m.guestId === me.guestId || (!!linked && m.userId === linked)),
    ) ?? null
  );
});
const myGroupId = computed(() => String(myGroup.value?.id || ''));
/** 只能拖自己所在的小组 */
const myGroupIds = computed(() => (myGroupId.value ? [myGroupId.value] : []));
const isMyLeader = computed(() =>
  !!(myGroup.value?.members || []).some((m: any) => m.guestId === me.guestId && m.isLeader),
);
/** 组里现在的组长名字（空表示还没人当组长） */
const myGroupLeaderName = computed(() => String(myGroup.value?.leaderName || ''));
/** 可以加入 / 换到的小组（自己已在不列） */
const joinableGroups = computed(() => (data.value?.groups || []).filter((g: any) => g.id !== myGroupId.value));

const storageKey = computed(() => `myorgniz_guest_${token}`);
const quizKey = computed(() => `myorgniz_guest_quiz_${token}_${me.phone}`);

const statusClass = computed(() => String(data.value?.meeting?.status || '').toLowerCase());

/** 个人榜：内部参会人（已签到优先）+ 外部来宾；已关联注册用户的来宾不重列 */
const people = computed(() => {
  const d = data.value;
  if (!d) return [];
  const rows = [...(d.participants || []), ...(d.guests || [])]
    .filter((p: any) => !p.linkedUserId)
    .filter((p: any) => p.kind === 'GUEST' || p.checked || p.isOwner);
  return rows.sort((a: any, b: any) => b.points - a.points || Number(b.checked) - Number(a.checked));
});

const myPoints = computed(() => {
  const d = data.value;
  if (!d || !me.guestId) return 0;
  const g = (d.guests || []).find((x: any) => x.guestId === me.guestId);
  return g?.points ?? 0;
});

/** 最近一次加分 id：轮询时只对新增的条目放动画 */
let seenScoreId = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 本机有登录态（组织者 / 助教 / 参会人）→ 同一个链接再拉一次内部看板 */
function hasLogin() {
  return !!localStorage.getItem('myorgniz_token');
}

/** 输入密码解锁：换票据后重新加载页面（同一设备 30 天内不再重复输） */
async function submitGate() {
  const pwd = gatePwd.value.trim();
  if (!pwd) return ElMessage.warning('请输入访问密码');
  gateSubmitting.value = true;
  try {
    await publicMeetingsApi.unlock(token, pwd);
    gate.value = false;
    gatePwd.value = '';
    ElMessage.success('密码正确，已进入活动页');
    await load(true);
  } finally {
    gateSubmitting.value = false;
  }
}

async function load(first = false, silent = false) {
  if (!token) {
    error.value = '链接无效';
    return;
  }
  if (!silent) loading.value = true;
  try {
    const res = await publicMeetingsApi.view(token);
    let merged = res;
    if (hasLogin()) {
      try {
        const b = await meetingsApi.board(res.meeting.id);
        // 内部看板多出：权限、待审批、标准答案、完整手机号；其余字段两边一致
        merged = { ...res, ...b, meeting: { ...res.meeting, ...b.meeting } };
      } catch {
        // 不是本场参会人 / 链接不对应：保持对外视角
      }
    }
    data.value = merged;
    gate.value = false;
    error.value = '';
    const latest = merged.recent?.[0];
    if (first) {
      seenScoreId = latest?.id || '';
    } else if (latest && latest.id !== seenScoreId) {
      seenScoreId = latest.id;
      burst.value?.play({ name: latest.name, points: latest.points, reason: latest.reason || undefined });
    }
  } catch (e: any) {
    const status = e?.response?.status;
    // 设了访问密码（或票据已失效）：切到密码门并停轮询，避免每 5 秒反复撞门
    if (status === 403 && e?.response?.data?.message?.code === 'NEED_PASSWORD') {
      gate.value = true;
      data.value = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    if (first) {
      error.value = status === 404 ? '活动不存在或链接已失效' : e?.response?.data?.message || '加载失败，请刷新重试';
    }
  } finally {
    if (!silent) loading.value = false;
  }
}

/** 管理面板里加分 / 审批通过时放大拇指动画 */
function playBurst(p: { name: string; points: number; reason?: string }) {
  burst.value?.play(p);
}

/** 现场管理卡片（只有组织者 / 助教能看到）：座位图上点头像计分复用它的计分框 */
const panelRef = ref<InstanceType<typeof MeetingActivityPanel> | null>(null);

/** 发起人 / 管理员 / 助教在座位图上点任何人的头像 = 直接给 TA 加分 */
function onSeatScore(p: any) {
  if (!panelRef.value) return ElMessage.warning('还没拿到你的管理权限，刷新一下再点头像');
  panelRef.value.openAvatarScore(p, true);
}

async function doCheckin() {
  const name = form.name.trim();
  const phone = form.phone.replace(/\s|-/g, '');
  const gender = form.gender;
  if (!name) return ElMessage.warning('请填写姓名');
  if (!/^1\d{10}$/.test(phone)) return ElMessage.warning('请填写 11 位手机号');
  if (!gender) return ElMessage.warning('请选一下性别（男 / 女）');
  checking.value = true;
  try {
    const res = await publicMeetingsApi.checkin(token, { name, phone, gender });
    me.name = res.name;
    me.phone = phone;
    me.gender = res.gender || gender;
    me.guestId = res.guestId;
    localStorage.setItem(storageKey.value, JSON.stringify({ name: res.name, phone, guestId: res.guestId, gender: me.gender }));
    if (res.linked) {
      ElMessage.success(`已识别为注册用户 ${res.userName || res.name}，本次参加已计入你的活动记录`);
    } else if (res.merged) {
      // 名字 / 手机号与之前签到的重合：并到原来那条上，之前的得分一起累计
      ElMessage.success('已匹配到你之前的签到记录，得分已合并计算');
    } else {
      ElMessage.success(res.already ? '你已签过到了' : '签到成功，欢迎参加');
    }
    await load();
  } finally {
    checking.value = false;
  }
}

function toggleEdit() {
  editing.value = !editing.value;
  if (editing.value) {
    editForm.name = me.name;
    editForm.phone = me.phone;
    editForm.gender = me.gender;
  }
}

/** 改签到信息：改对了会重新匹配上注册用户，并刷新座位图 */
async function doUpdate() {
  const name = editForm.name.trim();
  const phone = editForm.phone.replace(/\s|-/g, '');
  const gender = editForm.gender;
  if (!name) return ElMessage.warning('请填写姓名');
  if (!/^1\d{10}$/.test(phone)) return ElMessage.warning('请填写 11 位手机号');
  if (!gender) return ElMessage.warning('请选一下性别（男 / 女）');
  if (!me.guestId) return ElMessage.warning('没找到本次签到记录，请重新签到');
  savingEdit.value = true;
  try {
    const res = await publicMeetingsApi.updateCheckin(token, { guestId: me.guestId, name, phone, gender });
    me.name = res.name;
    me.phone = res.phone;
    me.gender = res.gender || gender;
    me.guestId = res.guestId;
    localStorage.setItem(
      storageKey.value,
      JSON.stringify({ name: res.name, phone: res.phone, guestId: res.guestId, gender: me.gender }),
    );
    quizDone.value = localStorage.getItem(quizKey.value) === '1';
    editing.value = false;
    if (res.linked) {
      ElMessage.success(`已匹配到注册用户 ${res.userName || res.name}，本次参加已计入活动记录`);
    } else {
      ElMessage.success(res.merged ? '已合并到之前的签到记录' : '信息已更新，座位图已同步');
    }
    await load();
  } finally {
    savingEdit.value = false;
  }
}

/** 进了组就把组名回填到输入框，改组名时不用重打 */
watch(
  myGroupId,
  () => {
    groupForm.name = myGroup.value?.name || '';
  },
  { immediate: true },
);

/** 组队操作统一收口：失败提示由 http 拦截器弹出 */
async function runGroup(action: () => Promise<unknown>, okText: string) {
  if (!me.guestId) return ElMessage.warning('请先签到，再组队');
  groupBusy.value = true;
  try {
    await action();
    ElMessage.success(okText);
    await load(false, true);
  } finally {
    groupBusy.value = false;
  }
}

function doCreateGroup() {
  const name = groupForm.name.trim();
  if (!name) return ElMessage.warning('请给小组起个名字');
  void runGroup(async () => {
    await publicMeetingsApi.createGroup(token, me.guestId, name);
  }, '建组成功，你就是组长');
}

function doJoinGroup(groupId: string) {
  void runGroup(() => publicMeetingsApi.joinGroup(token, me.guestId, groupId), '已加入这个小组');
}

// ---------- 来宾拖自己的头像入组：拖到小组上松手 = 加入这个组 ----------
const isTouch = isTouchDevice;
/** 免登录组队只有一个可拖的人 = 自己 */
const meSource = computed(() => ({ key: 'me', name: me.name || '我' }));

const teamDrag = useDragTo<{ key: string; name: string }>({
  keyOf: (s) => s.key,
  canDrag: () => !!me.guestId,
  onDropTarget: (_s, targetKey) => dropMyAvatar(targetKey),
});

/** 松手：落到小组上就加入，落到新建区就起个组名自己当组长 */
async function dropMyAvatar(targetKey: string) {
  if (groupBusy.value) return;
  if (!me.guestId) {
    ElMessage.warning('请先签到，再组队');
    return;
  }
  groupBusy.value = true;
  try {
    if (targetKey === 'leave') {
      if (!myGroupId.value) {
        ElMessage.info('你还没有分组，不用移出');
      } else {
        await publicMeetingsApi.leaveGroup(token, me.guestId, myGroupId.value);
        ElMessage.success(`已移出「${myGroup.value?.name || '小组'}」，现在回到未分组`);
      }
    } else if (targetKey === 'new') {
      const fallback = `第${(data.value?.groups || []).length + 1}组`;
      let name = fallback;
      try {
        const r = await ElMessageBox.prompt('给这个新小组起个名字', '自己建一个组', {
          inputValue: fallback,
          confirmButtonText: '建组，我当组长',
          cancelButtonText: '取消',
          inputValidator: (v: string) => (String(v ?? '').trim().length <= 20 ? true : '组名最长 20 字'),
        });
        name = String(r?.value ?? '').trim() || fallback;
      } catch {
        return; // 点了取消就不建组
      }
      const res: any = await publicMeetingsApi.assignGroup(token, me.guestId, { name });
      ElMessage.success(`已新建「${res.name}」，你是组长`);
    } else {
      const res: any = await publicMeetingsApi.assignGroup(token, me.guestId, { groupId: targetKey });
      ElMessage.success(`已加入「${res.name}」`);
    }
    await load(false, true);
  } finally {
    groupBusy.value = false;
  }
}

function doLeaveGroup() {
  if (!myGroupId.value) return;
  void runGroup(() => publicMeetingsApi.leaveGroup(token, me.guestId, myGroupId.value), '已退出小组');
}

function doRenameGroup() {
  const name = groupForm.name.trim();
  if (!name) return ElMessage.warning('请填写组名');
  if (!myGroupId.value) return;
  void runGroup(() => publicMeetingsApi.updateGroup(token, me.guestId, myGroupId.value, { name }), '组名已更新');
}

function doBeLeader() {
  if (!myGroupId.value) return;
  void runGroup(
    () => publicMeetingsApi.updateGroup(token, me.guestId, myGroupId.value, { leaderGuestId: me.guestId }),
    '你现在是这个小组的组长',
  );
}

function doRemoveGroup() {
  if (!myGroupId.value) return;
  void runGroup(() => publicMeetingsApi.removeGroup(token, me.guestId, myGroupId.value), '小组已解散');
}

/** 座位落库：组织者 / 参会人走内部接口，扫码来宾走免登录接口 */
function seatSaver(groupId: string, row: number, col: number) {
  if (canManage.value || canGroup.value) {
    return meetingsApi.updateGroup(adminMeetingId.value, groupId, { seatRow: row, seatCol: col });
  }
  return publicMeetingsApi.updateGroup(token, me.guestId, groupId, { seatRow: row, seatCol: col });
}

/**
 * 在座位图上拖人分组：
 * - 组织者 / 管理员 / 助教可以拖任何人 → 走内部接口
 * - 已签到来宾拖自己 → 走免登录接口（注册参会人拖自己同样走内部接口，后端按本人放行）
 * - groupId 为空 = 单独新建一组（后端自动按「第 N 组」起名）；with = 两个人一起成组；cell = 新组摆在哪一格
 */
async function onSeatAssign(ev: { person: any; groupId: string; name?: string; with?: any; cell?: { row: number; col: number } }) {
  if (groupBusy.value) return;
  const p = ev.person || {};
  if (!p.userId && !p.guestId) return ElMessage.warning('这个头像没带身份，刷新一下页面再拖');
  const target = String(ev.groupId || '');
  const selfGuest = !canManage.value && !!me.guestId && String(p.guestId || '') === me.guestId;
  groupBusy.value = true;
  try {
    if (selfGuest) {
      const res: any = await publicMeetingsApi.assignGroup(token, me.guestId, target ? { groupId: target } : { name: '' });
      ElMessage.success(target ? `已加入「${res.name}」` : `已新建「${res.name}」，你是组长`);
      await placeNewGroup(res.groupId, ev, true);
    } else {
      const who = p.userId ? { userId: String(p.userId) } : { guestId: String(p.guestId) };
      const res: any = await meetingsApi.assignGroup(adminMeetingId.value, { ...who, ...(target ? { groupId: target } : {}) });
      const other = ev.with || null;
      if (!target && other) {
        const who2 = other.userId ? { userId: String(other.userId) } : { guestId: String(other.guestId) };
        await meetingsApi.assignGroup(adminMeetingId.value, { ...who2, groupId: res.groupId });
        ElMessage.success(`已新建「${res.name}」：${p.name}、${other.name}`);
      } else {
        ElMessage.success(target ? `已把 ${p.name} 分到「${res.name}」` : `已新建「${res.name}」，${p.name} 当组长`);
      }
      await placeNewGroup(res.groupId, ev, false);
    }
    await load(false, true);
  } finally {
    groupBusy.value = false;
  }
}

/** 新建出来的小组尽量落在拖到的那个格子上（摆座位失败也不影响分组结果） */
async function placeNewGroup(groupId: string, ev: { groupId: string; cell?: { row: number; col: number } }, isGuest: boolean) {
  if (ev.groupId || !ev.cell || !groupId) return;
  const { row, col } = ev.cell;
  try {
    if (isGuest) await publicMeetingsApi.updateGroup(token, me.guestId, groupId, { seatRow: row, seatCol: col });
    else await meetingsApi.updateGroup(adminMeetingId.value, groupId, { seatRow: row, seatCol: col });
  } catch {
    // 坐位没摆上不要紧，分组已经成功了
  }
}

/**
 * 在座位图上把人拖出小组（拖到「移出小组」区）：回到未分组
 * - 已签到来宾拖自己 → 免登录退出接口
 * - 管理层拖任何人 / 登录参会人拖自己 → 内部接口，后端按人退组（两个身份一起摘）
 */
async function onSeatUnassign(ev: { person: any; groupId: string }) {
  if (groupBusy.value) return;
  const p = ev.person || {};
  const groupId = String(ev.groupId || '');
  if (!p.userId && !p.guestId) return ElMessage.warning('这个头像没带身份，刷新一下页面再拖');
  if (!groupId) return ElMessage.warning('没找到 TA 现在所在的小组，刷新一下再试');
  const selfGuest = !canManage.value && !!me.guestId && String(p.guestId || '') === me.guestId;
  groupBusy.value = true;
  try {
    if (selfGuest) {
      await publicMeetingsApi.leaveGroup(token, me.guestId, groupId);
      ElMessage.success('已移出这个小组，现在回到未分组');
    } else {
      const who = p.userId ? { userId: String(p.userId) } : { guestId: String(p.guestId) };
      const res: any = await meetingsApi.leaveMember(adminMeetingId.value, who);
      ElMessage.success(res?.removed ? `已把 ${res.name} 移出小组` : `${res?.name || p.name} 本来就没有分组`);
    }
    await load(false, true);
  } finally {
    groupBusy.value = false;
  }
}

async function doQuiz() {
  if (!me.phone) return ElMessage.warning('请先签到，再答题加分');
  if (!quiz.answer.trim()) return ElMessage.warning('请填写答案');
  quizSending.value = true;
  try {
    await publicMeetingsApi.quiz(token, { phone: me.phone, answer: quiz.answer.trim(), reason: quiz.reason.trim() || undefined });
    quizDone.value = true;
    localStorage.setItem(quizKey.value, '1');
    ElMessage.success('答案正确，加分已提交审批');
    await load();
  } finally {
    quizSending.value = false;
  }
}

onMounted(async () => {
  try {
    const u = JSON.parse(localStorage.getItem('myorgniz_user') || 'null');
    myUserId.value = u?.id || '';
  } catch {
    myUserId.value = '';
  }
  try {
    const raw = localStorage.getItem(storageKey.value);
    if (raw) {
      const saved = JSON.parse(raw);
      me.name = saved.name || '';
      me.phone = saved.phone || '';
      me.gender = saved.gender || '';
      me.guestId = saved.guestId || '';
      quizDone.value = localStorage.getItem(quizKey.value) === '1';
    }
  } catch {
    // 本地缓存坏了就当没签过
  }
  try {
    // 本机票据还有效就直接进；否则探测一次，需要密码时展示密码门
    let needGate = false;
    try {
      const acc = await publicMeetingsApi.access(token);
      needGate = acc.needPassword && !acc.valid;
    } catch {
      // 探测失败（网络抖动等）不拦截，照常尝试加载，撞门时由 load 兼容处理
    }
    if (needGate) {
      gate.value = true;
    } else {
      await load(true);
    }
  } finally {
    if (!gate.value && !error.value) {
      pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') load(false);
      }, 5000);
    }
  }
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.pm-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #eef3ff 0%, #f7f8fb 240px);
  padding-bottom: 28px;
  color: #303133;
  -webkit-tap-highlight-color: transparent;
}

.pm-loading,
.pm-error {
  padding: 80px 24px;
  text-align: center;
  color: #909399;
}
.pm-error-icon { font-size: 54px; }
.pm-error-title { margin-top: 10px; font-size: 17px; font-weight: 600; color: #303133; }
.pm-error-tip { margin-top: 6px; font-size: 13px; }

/* 访问密码门 */
.pm-gate { max-width: 420px; margin: 12vh auto 0; padding: 0 16px; }
.pm-gate-icon { text-align: center; font-size: 46px; }
.pm-gate-title { margin-top: 8px; text-align: center; font-size: 17px; font-weight: 700; color: #303133; }
.pm-gate-tip { margin: 8px 0 16px; text-align: center; font-size: 12px; line-height: 1.7; color: #909399; }

.pm-hero {
  padding: 18px 16px 16px;
  background: linear-gradient(135deg, #3b6ef6 0%, #6a8dff 60%, #8a6cff 100%);
  color: #fff;
  border-radius: 0 0 22px 22px;
  box-shadow: 0 10px 26px rgba(59, 110, 246, 0.28);
}
/* 右上角常驻二维码：固定在视口右上角，滚动也一直在 */
.pm-qr-fab {
  position: fixed;
  top: calc(8px + env(safe-area-inset-top, 0px));
  right: calc(8px + env(safe-area-inset-right, 0px));
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 4px 2px;
  border: 0;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 6px 18px rgba(23, 43, 77, 0.22);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.pm-qr-fab:active { transform: scale(0.96); }
.pm-qr-fab-img { display: block; width: 52px; height: 52px; }
.pm-qr-fab-img :deep(svg) { display: block; width: 100%; height: 100%; }
.pm-qr-fab-tip { font-size: 9px; line-height: 1.3; color: #6b7280; }

.pm-qr-big { display: flex; justify-content: center; padding: 2px 0 12px; }
.pm-qr-big img { display: block; width: 200px; height: 200px; }
.pm-qr-note { margin-bottom: 12px; font-size: 12px; line-height: 1.65; color: #6b7280; }

/* 头部文字给右上角二维码让出位置，避免遮挡标题与状态 */
.pm-hero-top { padding-right: 68px; display: flex; align-items: center; justify-content: space-between; font-size: 12px; opacity: 0.9; }
.pm-brand { letter-spacing: 0.5px; }
.pm-status {
  padding: 2px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  font-size: 12px;
}
.pm-status.in_progress { background: #ff7a45; }
.pm-status.cancelled { background: rgba(0, 0, 0, 0.35); }
.pm-title { margin: 8px 0 6px; padding-right: 68px; font-size: 21px; line-height: 1.28; font-weight: 700; }
.pm-meta { display: flex; flex-wrap: wrap; gap: 6px; padding-right: 68px; font-size: 13px; opacity: 0.92; margin-top: 2px; }
.pm-dot { opacity: 0.6; }
.pm-warn { margin-top: 8px; font-size: 13px; background: rgba(0, 0, 0, 0.25); padding: 6px 10px; border-radius: 8px; }

.pm-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 14px;
}
.pm-stat {
  text-align: center;
  padding: 8px 4px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.16);
}
.pm-stat b { display: block; font-size: 19px; }
.pm-stat span { font-size: 11px; opacity: 0.9; }

.pm-body { padding: 14px 12px 0; display: flex; flex-direction: column; gap: 12px; }

.pm-card {
  background: #fff;
  border-radius: 16px;
  padding: 14px;
  box-shadow: 0 4px 16px rgba(23, 43, 77, 0.06);
}
.pm-card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.pm-card-head h2 { margin: 0; font-size: 15px; font-weight: 700; }
.pm-admin { border: 1px solid #d9e2ff; box-shadow: 0 4px 16px rgba(59, 110, 246, 0.12); }
.pm-muted { color: #909399; font-size: 12px; }
.pm-tip { margin-top: 8px; }
.pm-empty { color: #a8abb2; font-size: 13px; padding: 8px 0; }

.pm-field { margin-bottom: 10px; }
.pm-btn { width: 100%; height: 44px; border-radius: 12px; font-size: 15px; }

.pm-checked { display: flex; align-items: center; gap: 12px; }
.pm-checked-icon { font-size: 30px; }
.pm-checked-main { min-width: 0; }
.pm-checked-name { font-size: 15px; font-weight: 600; }
.pm-edit-link { padding: 0; height: auto; margin-top: 4px; font-size: 12px; }
.pm-edit {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #eef1f6;
}
.pm-score { color: #f56c6c; font-size: 16px; }

.pm-quiz-points { color: #f56c6c; font-weight: 700; font-size: 13px; }
.pm-question {
  background: #f5f7fd;
  border-left: 3px solid #3b6ef6;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.55;
  margin-bottom: 11px;
}
.pm-ok { color: #67c23a; font-size: 14px; padding: 6px 0; }

.pm-group {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 12px;
  background: #fafbff;
  margin-bottom: 8px;
}
.pm-group.top { background: linear-gradient(120deg, #fff7e6, #fff1f0); box-shadow: inset 0 0 0 1px #ffe2b7; }
.pm-group-rank {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 50%;
  background: #e6ecff;
  color: #3b6ef6;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pm-group.top .pm-group-rank { background: #ffb02e; color: #fff; }
.pm-group-main { flex: 1; min-width: 0; }
.pm-group-name { font-size: 14px; font-weight: 700; }
.pm-crown { margin-left: 4px; }
.pm-group-members { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.pm-chip {
  font-size: 11px;
  color: #5a6b8c;
  background: #eef2fb;
  border-radius: 999px;
  padding: 2px 8px;
}
.pm-chip.leader { background: #fff1d6; color: #b87400; }
.pm-chip b { color: #f56c6c; }
.pm-group-score { font-size: 22px; font-weight: 800; color: #3b6ef6; }
.pm-group-score.hot { color: #f56c6c; }

/* 自由组队 */
.pm-team-new { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.pm-team-new .pm-field { flex: 1 1 220px; margin-bottom: 0; }
.pm-team-new .pm-btn { width: auto; flex: 0 0 auto; padding: 0 18px; height: 40px; }
.pm-team {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  background: #fafbff;
  margin-bottom: 8px;
}
.pm-team-main { flex: 1; min-width: 0; }
.pm-team-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.pm-team-ops { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; flex: 0 0 auto; }

/* 自由组队：把自己的头像拖到小组上 */
.pm-myteam { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.pm-myavatar {
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  flex: none;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  cursor: grab;
}
.pm-myavatar:active { cursor: grabbing; }
.pm-myavatar.pulling { opacity: 0.45; transform: scale(0.92); }
.pm-myteam .pm-muted { font-size: 12px; line-height: 1.5; }
/* 投放高亮：用 inset 阴影避免撑开布局 */
.pm-team.pm-drop-over { background: #eef4ff; box-shadow: inset 0 0 0 1px #3b6ef6; }
.pm-drop-tip { margin-left: 6px; font-size: 12px; color: #3b6ef6; font-weight: 600; }
.pm-newteam {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  margin: 4px 0 8px;
  border: 1px dashed #cdd6e8;
  border-radius: 12px;
  font-size: 13px;
  color: #8a94a6;
  background: #fbfcff;
}
.pm-newteam.over { border-color: #3b6ef6; background: #eef4ff; color: #3b6ef6; font-weight: 600; }
.pm-newteam-icon { font-size: 16px; line-height: 1; }

/* 拖出小组的投放区（与新建区同样拖头像，但是退组） */
.pm-leaveteam {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  margin: 4px 0 8px;
  border: 1px dashed #f0c6c6;
  border-radius: 12px;
  font-size: 13px;
  color: #a1556a;
  background: #fffafa;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.pm-leaveteam.over { border-color: #d0482f; background: #fff1f2; color: #d0482f; font-weight: 600; }
.pm-leaveteam-icon { font-size: 15px; line-height: 1; }

/* 签到时的性别二选一 */
.pm-gender {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0 10px;
}
.pm-gender-label { font-size: 13px; color: #606266; flex: 0 0 auto; }
.pm-gender-tag {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 18px;
  display: inline-block;
}
.pm-gender-tag.boy { background: #d7e8ff; color: #1a4c9e; }
.pm-gender-tag.girl { background: #ffdcea; color: #a33166; }

.pm-people { display: flex; flex-direction: column; }
.pm-person {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 2px;
  border-bottom: 1px dashed #f0f2f5;
  font-size: 14px;
}
.pm-person:last-child { border-bottom: none; }
.pm-person-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pm-person-score { font-weight: 700; color: #3b6ef6; }
.pm-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #eef2fb; color: #5a6b8c; }
.pm-tag.assistant { background: #eafaf0; color: #3ba55d; }
.pm-tag.guest { background: #f4f0ff; color: #7a5af5; }

.pm-feed { display: flex; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px dashed #f0f2f5; }
.pm-feed:last-child { border-bottom: none; }
.pm-feed-thumb { font-size: 20px; }
.pm-feed-main { flex: 1; min-width: 0; font-size: 14px; }
.pm-feed-points { color: #f56c6c; font-weight: 700; margin-left: 6px; }
.pm-feed-time { flex: 0 0 auto; }

.pm-footer { text-align: center; color: #b1b3b8; font-size: 12px; padding: 16px 0 4px; }

@media (min-width: 720px) {
  .pm-page { max-width: 720px; margin: 0 auto; }
  .pm-hero { border-radius: 18px; margin: 16px 12px 0; }
  .pm-body { padding: 14px 12px 0; }
}

/* 电脑浏览器：会场座位图需要横向空间，页面适当加宽 */
@media (min-width: 1024px) {
  .pm-page { max-width: 980px; }
}
</style>
