<template>
  <div class="ap">
    <!-- 助教：由发起人任命，可审核加分与管理活动 -->
    <section v-if="canManage" class="ap-sec">
      <div class="ap-h">
        助教 <span class="muted">可审核加分、管理现场</span>
      </div>
      <div class="ap-tags">
        <el-tag
          v-for="a in board?.assistants || []"
          :key="a.userId"
          size="small"
          type="success"
          effect="plain"
          :closable="canManage"
          @close="toggleAssistant(a.userId, false)"
        >
          助教 · {{ a.name }}
        </el-tag>
        <span v-if="!(board?.assistants || []).length" class="muted">尚未任命</span>
      </div>
      <div class="ap-ops">
        <el-select v-model="assistantPick" size="small" filterable placeholder="选一名参会人任命为助教" class="ap-sel">
          <el-option v-for="p in assistantCandidates" :key="p.userId" :label="p.name" :value="p.userId" />
        </el-select>
        <el-button size="small" type="primary" :disabled="!assistantPick" @click="toggleAssistant(assistantPick, true)">任命</el-button>
      </div>
    </section>

    <!-- 答题加分：现场答对 → 自助申请 → 管理层审批 -->
    <section class="ap-sec">
      <div class="ap-h">
        答题加分 <span class="muted">答对自助申请，审批通过才计分</span>
      </div>
      <div v-if="canManage" class="ap-quiz">
        <el-input v-model="quizForm.question" size="small" placeholder="题目（参会人可见，如：今天分享了哪三个关键词？）" @input="quizTouched = true" />
        <div class="ap-ops">
          <el-input v-model="quizForm.answer" size="small" placeholder="标准答案（仅管理层可见）" class="ap-grow" @input="quizTouched = true" />
          <el-input-number v-model="quizForm.points" :min="1" :max="20" size="small" />
          <el-button size="small" type="primary" :loading="savingQuiz" @click="saveQuizCfg">保存</el-button>
        </div>
        <div class="muted tip">题目与答案都清空即关闭答题加分</div>
      </div>
      <div v-else class="muted">
        {{ board?.quiz?.enabled ? `题目：${board.quiz.question}（答对 +${board.quiz.points}）` : '本场未开放答题加分' }}
      </div>
    </section>

    <!-- 访问密码：活动对所有人开放，发起者可加一道密码门 -->
    <section v-if="canManage" class="ap-sec">
      <div class="ap-h">
        访问密码
        <span class="muted">设了密码后，对外页需输入密码才能进活动主页</span>
        <el-tag v-if="board?.passwordProtected" size="small" type="warning" effect="plain">已开启</el-tag>
      </div>
      <div v-if="!pwdEditing && board?.passwordProtected" class="ap-ops">
        <span class="muted">陌生人打开链接后要先输密码；记住密码发在活动通知里即可</span>
        <el-button size="small" @click="startPwdEdit">修改密码</el-button>
        <el-button size="small" type="danger" plain :loading="savingPwd" @click="clearPublicPassword">取消密码</el-button>
      </div>
      <div v-else class="ap-ops">
        <el-input
          v-model="pwdForm.password"
          size="small"
          type="password"
          show-password
          maxlength="20"
          :placeholder="board?.passwordProtected ? '输入新密码（4~20 位）' : '访问密码（4~20 位，留空为不设）'"
          class="ap-grow"
          @keyup.enter="savePublicPassword"
        />
        <el-button size="small" type="primary" :loading="savingPwd" :disabled="pwdForm.password.trim().length < 4" @click="savePublicPassword">保存</el-button>
        <el-button v-if="!board?.passwordProtected || pwdEditing" size="small" text @click="pwdEditing = false">取消</el-button>
      </div>
      <div class="muted tip">不设密码的活动链接拿到就能直接进；密码只存加密值，组织者自己打开链接不需要输</div>
    </section>

    <!-- 给个赞 · 加分 -->
    <section v-if="canManage" class="ap-sec">
      <div class="ap-h">给个赞 · 加分 <span class="muted">组织者 / 助教可直接加分</span></div>
      <div class="ap-ops">
        <el-select v-model="scoreForm.target" size="small" filterable placeholder="选择加分对象" class="ap-sel">
          <el-option
            v-for="p in scoreTargets"
            :key="p.key"
            :label="`${p.name}${p.kind === 'GUEST' ? '（来宾）' : p.isAssistant ? '（助教）' : ''}`"
            :value="p.key"
          />
        </el-select>
        <el-input-number v-model="scoreForm.points" :min="1" :max="50" size="small" />
        <el-input v-model="scoreForm.reason" size="small" placeholder="加分理由（可选）" class="ap-grow" />
        <el-button size="small" type="primary" :loading="scoring" :disabled="!scoreForm.target" @click="doAddScore">加分</el-button>
      </div>
    </section>

    <!-- 待审批 -->
    <section v-if="canManage && (board?.pending || []).length" class="ap-sec">
      <div class="ap-h">待审批 <span class="muted">{{ board.pending.length }} 条</span></div>
      <div v-for="p in board.pending" :key="p.id" class="ap-pending">
        <b>{{ p.name }}</b>
        <span class="ap-pending-points">+{{ p.points }}</span>
        <span class="muted ap-pending-reason">{{ p.reason }}</span>
        <span class="ap-ops">
          <el-button size="small" text type="primary" @click="reviewScore(p.id, true)">通过</el-button>
          <el-button size="small" text type="danger" @click="reviewScore(p.id, false)">驳回</el-button>
        </span>
      </div>
    </section>

    <!-- 小组得分：实时 · 下面的头像可直接拖进来分组 -->
    <section class="ap-sec">
      <div class="ap-h">
        小组得分
        <span class="muted">{{ dragHint }}</span>
      </div>
      <div
        v-for="(g, i) in board?.groups || []"
        :key="g.id"
        class="ap-group"
        :class="{ 'ap-drop-over': drag.isOver(g.id), 'ap-drop-same': drag.isOver(g.id) && dragSrcInGroup(g) }"
        :data-drop-key="g.id"
        @dragover="drag.onDragOver($event, g.id)"
        @dragleave="drag.onDragLeave(g.id)"
        @drop.prevent="drag.onDrop($event, g.id)"
      >
        <span class="ap-group-rank" :class="{ hot: i === 0 }">{{ i + 1 }}</span>
        <div class="ap-group-main">
          <div class="ap-group-name">
            {{ g.name }}
            <span class="muted">
              <template v-if="g.leaderName">组长 {{ g.leaderName }} · </template>{{ g.memberCount }} 人
            </span>
            <span v-if="drag.isOver(g.id)" class="ap-drop-tip">{{ dragSrcInGroup(g) ? `${dragName} 已在本组` : `放到这里 · ${dragName} 加入本组` }}</span>
          </div>
          <div class="ap-group-members">
            <el-tag v-for="m in g.members" :key="m.guestId || m.userId || `${m.name}-${m.points}`" size="small" :type="m.isLeader ? 'warning' : 'info'" effect="plain">
              {{ m.name }}<template v-if="m.points"> {{ m.points }}</template>
            </el-tag>
          </div>
        </div>
        <div class="ap-group-score">{{ g.score }}</div>
        <span class="ap-ops">
          <el-button v-if="canGroup && !myGroupId" size="small" text type="primary" @click="joinGroup(g.id)">加入</el-button>
          <el-button v-if="myGroupId === g.id" size="small" text type="danger" @click="leaveGroup(g.id)">退出</el-button>
          <el-button v-if="myGroupId === g.id || canManage" size="small" text @click="openSetLeader(g)">选组长</el-button>
        </span>
      </div>
      <div v-if="!(board?.groups || []).length" class="muted">还没人组队{{ canDragAny ? '：把下面的头像拖到这里就能建组' : '' }}</div>

      <!-- 拖头像到这块空白区 = 以这个人新建一个小组 -->
      <div
        v-if="canDragAny"
        class="ap-newgroup"
        :class="{ over: drag.isOver('new') }"
        data-drop-key="new"
        @dragover="drag.onDragOver($event, 'new')"
        @dragleave="drag.onDragLeave('new')"
        @drop.prevent="drag.onDrop($event, 'new')"
      >
        <span class="ap-newgroup-icon">＋</span>
        <span>{{ drag.isOver('new') ? `松手：把 ${dragName} 单独分成一个新小组` : '把头像拖到这里 = 新建一个小组' }}</span>
      </div>

      <!-- 拖头像到这里 = 把人从小组里拖出来（回到未分组） -->
      <div
        v-if="canDragAny"
        class="ap-leavegroup"
        :class="{ over: drag.isOver('leave') }"
        data-drop-key="leave"
        @dragover="drag.onDragOver($event, 'leave')"
        @dragleave="drag.onDragLeave('leave')"
        @drop.prevent="drag.onDrop($event, 'leave')"
      >
        <span class="ap-leavegroup-icon">✕</span>
        <span>{{ drag.isOver('leave') ? `松手：把 ${dragName} 移出小组` : '把头像拖到这里 = 移出小组（回到未分组）' }}</span>
      </div>

      <div v-if="canGroup" class="ap-ops">
        <template v-if="myGroupId">
          <span class="muted">我在「{{ myGroup?.name }}」</span>
        </template>
        <template v-else>
          <el-input v-model="groupForm.name" size="small" placeholder="组名（如：第一排三兄弟）" class="ap-sel" />
          <el-select v-model="groupForm.memberIds" multiple size="small" filterable placeholder="拉上旁边的同事（可选）" class="ap-sel">
            <el-option v-for="p in groupCandidates" :key="p.userId" :label="p.name" :value="p.userId" />
          </el-select>
          <el-button size="small" type="primary" :loading="creatingGroup" :disabled="!groupForm.name.trim()" @click="createGroup">建组</el-button>
        </template>
      </div>
      <div class="muted tip">{{ isTouch ? '长按头像不动、拖到上面的小组上松手即可分组，拖到「移出小组」就是退组' : '把头像直接拖到上面的小组里即可分组，拖到「移出小组」就是退组' }}；组得分 = 组内成员本场已通过的加分之和，页面每 5 秒自动同步</div>
    </section>

    <!-- 个人得分：点头像计分，拖头像到小组里分组 -->
    <section v-if="boardPeople.length" class="ap-sec">
      <div class="ap-h">
        个人得分 <span class="muted">{{ personHint }}</span>
      </div>
      <div class="ap-people">
        <div v-for="p in boardPeople" :key="p.key" class="ap-person">
          <button
            type="button"
            class="ap-avatar"
            :class="{ clickable: canManage, draggable: canDragPerson(p), pulling: drag.isSource(p.key) }"
            :style="avatarInk(p)"
            :title="avatarTitle(p)"
            :draggable="canDragPerson(p)"
            @click="openAvatarScore(p)"
            @dragstart="drag.onDragStart($event, p)"
            @dragend="drag.onDragEnd()"
            @touchstart="drag.onTouchStart($event, p)"
            @touchmove="drag.onTouchMove($event)"
            @touchend="drag.onTouchEnd()"
            @touchcancel="drag.onTouchCancel()"
          >
            {{ avatarText(p.name) }}
            <span v-if="canManage" class="ap-avatar-plus">＋</span>
          </button>
          <span class="ap-person-name">
            {{ p.name }}
            <el-tag v-if="p.isOwner" size="small" effect="plain">组织者</el-tag>
            <el-tag v-else-if="p.isAssistant" size="small" type="success" effect="plain">助教</el-tag>
            <el-tag v-else-if="p.kind === 'GUEST'" size="small" type="warning" effect="plain">来宾</el-tag>
          </span>
          <span class="ap-person-score">{{ p.points }}</span>
        </div>
      </div>
    </section>

    <!-- 点头像计分：老师给表现优秀的成员直接加分 -->
    <el-dialog v-model="avatarScore.visible" width="min(340px, 92vw)" align-center :show-close="false">
      <div class="ap-score-head">
        <span class="ap-avatar big" :style="avatarInk(avatarScore.person || { name: avatarScore.name })">{{ avatarText(avatarScore.name) }}</span>
        <div>
          <div class="ap-score-name">{{ avatarScore.name }}</div>
          <div class="muted">当前 {{ avatarScore.points }} 分 · 给表现优秀的 TA 计个分</div>
        </div>
      </div>
      <div class="ap-ops" style="margin: 10px 0">
        <el-button
          v-for="n in [1, 2, 3, 5, 10]"
          :key="n"
          size="small"
          :type="avatarScore.pointsPick === n ? 'primary' : 'default'"
          @click="avatarScore.pointsPick = n; avatarScore.quick = n; avatarScore.pointsCustom = false"
        >+{{ n }}</el-button>
        <el-input-number v-model="avatarScore.quick" :min="1" :max="50" size="small" @change="avatarScore.pointsCustom = true" />
      </div>
      <el-input v-model="avatarScore.reason" size="small" placeholder="计分理由（可选，如：回答精彩 / 主动帮助同学）" @keyup.enter="submitAvatarScore" />
      <template #footer>
        <el-button size="small" @click="avatarScore.visible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="avatarScore.saving" @click="submitAvatarScore">确认加分</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { meetingsApi } from '../api';
import { avatarInk, avatarText } from '../utils/avatar';
import { isTouchDevice, useDragTo } from '../utils/useDragTo';

const props = defineProps<{
  meetingId: string;
  board: any;
  canManage: boolean;
  canGroup: boolean;
  /** 当前登录用户 id：用来判断「我在哪个组」 */
  meId?: string;
}>();

const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'burst', payload: { name: string; points: number; reason?: string }): void;
}>();

const assistantPick = ref('');
const quizForm = reactive({ question: '', answer: '', points: 2 });
const quizTouched = ref(false);
const savingQuiz = ref(false);
// ---------- 访问密码（发起者可设：对外页需输密码才能进） ----------
const pwdForm = reactive({ password: '' });
const pwdEditing = ref(false);
const savingPwd = ref(false);

function startPwdEdit() {
  pwdForm.password = '';
  pwdEditing.value = true;
}

async function savePublicPassword() {
  const pwd = pwdForm.password.trim();
  if (pwd.length < 4) return ElMessage.warning('访问密码至少 4 位');
  savingPwd.value = true;
  try {
    await meetingsApi.setPublicPassword(props.meetingId, pwd);
    ElMessage.success('访问密码已设置，对外页需输密码才能进入');
    pwdForm.password = '';
    pwdEditing.value = false;
    emit('refresh');
  } finally {
    savingPwd.value = false;
  }
}

async function clearPublicPassword() {
  const res = await ElMessageBox.confirm('取消后陌生人打开链接可直接进入活动主页，确定吗？', '取消访问密码', {
    confirmButtonText: '取消密码',
    cancelButtonText: '再想想',
    type: 'warning',
  }).catch(() => null);
  if (!res) return;
  savingPwd.value = true;
  try {
    await meetingsApi.setPublicPassword(props.meetingId, '');
    ElMessage.success('已取消访问密码，对外链接可直接进入');
    pwdEditing.value = false;
    emit('refresh');
  } finally {
    savingPwd.value = false;
  }
}
const scoreForm = reactive({ target: '', points: 2, reason: '' });
const scoring = ref(false);
const groupForm = reactive({ name: '', memberIds: [] as string[] });
const creatingGroup = ref(false);

// ---------- 点头像计分：老师给表现优秀的成员直接加分 ----------
const avatarScore = reactive({
  visible: false,
  person: null as any,
  name: '',
  points: 0,
  quick: 2,
  pointsPick: 2,
  pointsCustom: false,
  reason: '',
  saving: false,
});

function openAvatarScore(p: any, fromSeat = false) {
  if (!props.canManage || !p) return;
  // 座位图上的头像不经过本组件的拖拽，不需要（也不能）吃拖拽余波的 click
  if (!fromSeat && drag.consumeClick()) return; // 拖拽松手会补发一次 click，不要误开计分框
  avatarScore.person = p;
  avatarScore.name = p.name;
  avatarScore.points = p.points || 0;
  avatarScore.quick = 2;
  avatarScore.pointsPick = 2;
  avatarScore.pointsCustom = false;
  avatarScore.reason = '';
  avatarScore.visible = true;
}

// 会场座位图在父组件里，组织者点座位图头像时也复用这一个计分框
defineExpose({ openAvatarScore });

async function submitAvatarScore() {
  const p = avatarScore.person;
  if (!p || avatarScore.saving) return;
  const points = avatarScore.pointsCustom ? Number(avatarScore.quick) || 0 : avatarScore.pointsPick;
  if (points < 1 || points > 50) return ElMessage.warning('分值请在 1~50 之间');
  avatarScore.saving = true;
  try {
    const isGuest = p.key.startsWith('g:');
    const res: any = await meetingsApi.addScore(props.meetingId, {
      targetType: isGuest ? 'GUEST' : 'USER',
      userId: isGuest ? undefined : p.key.slice(2),
      guestId: isGuest ? p.key.slice(2) : undefined,
      points,
      reason: avatarScore.reason.trim() || undefined,
    });
    avatarScore.visible = false;
    ElMessage.success(`已给 ${res.name} 加 ${res.points} 分`);
    emit('burst', { name: res.name, points: res.points, reason: avatarScore.reason.trim() || undefined });
    emit('refresh');
  } finally {
    avatarScore.saving = false;
  }
}

// ---------- 拖头像分组：拖到小组上松手 = 把 TA 分进这个组 ----------
const assigning = ref(false);
const isTouch = isTouchDevice;

/** 管理层能拖任何人；普通参会人只能拖自己（等于自己加入小组） */
function canDragPerson(p: any) {
  return props.canManage || (!!props.meId && p.key === `u:${props.meId}`);
}
const canDragAny = computed(() => props.canManage || !!props.meId);

const drag = useDragTo<any>({
  keyOf: (p) => String(p.key ?? ''),
  canDrag: canDragPerson,
  onDropTarget: (p, targetKey) => assignToGroup(p, targetKey),
});

/** 当前被拖动的人（给悬停提示用） */
const dragName = computed(() => {
  const key = drag.dragKey.value;
  if (!key) return 'TA';
  return (boardPeople.value as any[]).find((x) => x.key === key)?.name || 'TA';
});

/** 被拖的人是否已经在悬停的这个组里（注册账号 / 扫码签到两个身份都算） */
function dragSrcInGroup(g: any) {
  const key = drag.dragKey.value;
  if (!key) return false;
  const p: any = (boardPeople.value as any[]).find((x) => x.key === key);
  if (!p) return false;
  return (g?.members || []).some((m: any) => (!!p.userId && m.userId === p.userId) || (!!p.guestId && m.guestId === p.guestId));
}

const dragHint = computed(() =>
  canDragAny.value ? '实时 · 把下面的头像拖到小组上就能分组，拖到「移出小组」就是退组' : '实时 · 座位相邻的自己组队',
);
const personHint = computed(() => {
  if (props.canManage) return isTouch ? '点头像计分 · 长按头像拖到小组里分组，拖到「移出小组」退组' : '点头像计分 · 头像可拖到小组里分组，也可拖出小组';
  if (props.meId) return '把自己的头像拖到上面的小组里即可加入，拖到「移出小组」就退组';
  return '';
});

function avatarTitle(p: any) {
  if (props.canManage) return `点一下给 ${p.name} 计分；拖头像到上面的小组里分组，拖到「移出小组」就退组`;
  if (canDragPerson(p)) return '长按自己的头像，拖到上面的小组里即可加入，拖到「移出小组」就退组';
  return p.name;
}

async function assignToGroup(p: any, targetKey: string) {
  if (assigning.value || !p) return;
  const isGuest = p.key.startsWith('g:');
  const who = isGuest ? { guestId: p.key.slice(2) } : { userId: p.key.slice(2) };
  assigning.value = true;
  try {
    if (targetKey === 'leave') {
      // 拖到「移出小组」区：从组里退出来，回到未分组（小组空了后端会收掉）
      const res: any = await meetingsApi.leaveMember(props.meetingId, who);
      ElMessage.success(res?.removed ? `已把 ${res.name} 移出小组，现在回到未分组` : `${res?.name || p.name} 本来就没有分组`);
    } else if (targetKey === 'new') {
      let name = `第${(props.board?.groups || []).length + 1}组`;
      try {
        const r = await ElMessageBox.prompt('给这个新小组起个名字', `把 ${p.name} 单独分一组`, {
          inputValue: name,
          confirmButtonText: '建组',
          cancelButtonText: '取消',
          inputValidator: (v: string) => (String(v ?? '').trim().length <= 20 ? true : '组名最长 20 字'),
        });
        name = String(r?.value ?? '').trim();
      } catch {
        return; // 用户取消
      }
      const res: any = await meetingsApi.assignGroup(props.meetingId, { ...who, name });
      ElMessage.success(`已新建「${res.name}」，${res.memberName} 进了这个组`);
    } else {
      const res: any = await meetingsApi.assignGroup(props.meetingId, { ...who, groupId: targetKey });
      ElMessage.success(`已把 ${res.memberName} 分到「${res.name}」`);
    }
    emit('refresh');
  } finally {
    assigning.value = false;
  }
}

/** 答题设置回填：只在用户没动过表单时同步，避免轮询覆盖正在输入的内容 */
function syncQuiz() {
  const q = props.board?.quiz;
  if (quizTouched.value || !q) return;
  quizForm.question = q.question || '';
  quizForm.answer = q.answer || '';
  quizForm.points = q.points || 2;
}

const assistantCandidates = computed(() =>
  (props.board?.participants || []).filter((p: any) => p.kind === 'USER' && !p.isOwner && !p.isAssistant),
);
/** 已关联注册用户的来宾不再单列（分数已归到用户名下） */
const scoreTargets = computed(() => [
  ...(props.board?.participants || []),
  ...(props.board?.guests || []).filter((g: any) => !g.linkedUserId),
]);
const groupCandidates = computed(() => (props.board?.participants || []).filter((p: any) => p.userId !== props.meId));
/** 我自己本场扫码签到那条记录的 guestId：组员关系可能记在 TA 身上而不是注册账号上 */
const myGuestId = computed(() => String((props.board?.participants || []).find((p: any) => p.userId === props.meId)?.guestId || ''));
const myGroup = computed(() =>
  (props.board?.groups || []).find(
    (g: any) =>
      (g.members || []).some((m: any) => (!!m.userId && m.userId === props.meId) || (!!myGuestId.value && m.guestId === myGuestId.value)),
  ),
);
const myGroupId = computed(() => myGroup.value?.id || '');
const boardPeople = computed(() =>
  [...(props.board?.participants || []), ...(props.board?.guests || []).filter((g: any) => !g.linkedUserId)].sort(
    (a: any, c: any) => c.points - a.points || a.name.localeCompare(c.name),
  ),
);

// 看板每 5 秒刷新一次，只在用户没动过表单时回填答题设置
watch(() => props.board, syncQuiz, { immediate: true });

async function toggleAssistant(userId: string, enable: boolean) {
  if (!userId) return;
  await meetingsApi.setAssistant(props.meetingId, userId, enable);
  ElMessage.success(enable ? '已任命助教，可审核加分与管理现场' : '已卸任助教');
  assistantPick.value = '';
  emit('refresh');
}

async function saveQuizCfg() {
  if (!quizForm.question.trim() !== !quizForm.answer.trim()) {
    return ElMessage.warning('题目和标准答案需要同时填写，或都清空以关闭');
  }
  savingQuiz.value = true;
  try {
    await meetingsApi.saveQuiz(props.meetingId, {
      question: quizForm.question.trim(),
      answer: quizForm.answer.trim(),
      points: Number(quizForm.points) || 2,
    });
    quizTouched.value = false;
    ElMessage.success(quizForm.question.trim() ? '答题加分已保存' : '答题加分已关闭');
    emit('refresh');
  } finally {
    savingQuiz.value = false;
  }
}

async function doAddScore() {
  if (!scoreForm.target) return;
  const isGuest = scoreForm.target.startsWith('g:');
  const id = scoreForm.target.slice(2);
  scoring.value = true;
  try {
    const res: any = await meetingsApi.addScore(props.meetingId, {
      targetType: isGuest ? 'GUEST' : 'USER',
      userId: isGuest ? undefined : id,
      guestId: isGuest ? id : undefined,
      points: Number(scoreForm.points) || 1,
      reason: scoreForm.reason.trim() || undefined,
    });
    ElMessage.success(`已给 ${res.name} 加 ${res.points} 分`);
    emit('burst', { name: res.name, points: res.points, reason: scoreForm.reason.trim() || undefined });
    scoreForm.reason = '';
    scoreForm.target = '';
    emit('refresh');
  } finally {
    scoring.value = false;
  }
}

async function reviewScore(scoreId: string, approve: boolean) {
  const p = (props.board?.pending || []).find((x: any) => x.id === scoreId);
  await meetingsApi.reviewScore(props.meetingId, scoreId, approve);
  ElMessage.success(approve ? '已通过，加分已计入' : '已驳回');
  if (approve && p) emit('burst', { name: p.name, points: p.points, reason: p.reason || undefined });
  emit('refresh');
}

async function createGroup() {
  const name = groupForm.name.trim();
  if (!name) return ElMessage.warning('请给小组起个名字');
  creatingGroup.value = true;
  try {
    await meetingsApi.createGroup(props.meetingId, { name, memberIds: groupForm.memberIds });
    ElMessage.success(`已建组「${name}」`);
    groupForm.name = '';
    groupForm.memberIds = [];
    emit('refresh');
  } finally {
    creatingGroup.value = false;
  }
}

async function joinGroup(groupId: string) {
  await meetingsApi.joinGroup(props.meetingId, groupId);
  ElMessage.success('已加入小组');
  emit('refresh');
}

async function leaveGroup(groupId: string) {
  await meetingsApi.leaveGroup(props.meetingId, groupId);
  ElMessage.success('已退出小组');
  emit('refresh');
}

/** 选组长：从本组成员里挑一个 */
async function openSetLeader(g: any) {
  const names = (g.members || []).map((m: any) => m.name);
  if (!names.length) return ElMessage.warning('组里还没有成员');
  const { value } = await ElMessageBox.prompt(`可选组长：${names.join('、')}`, '选组长', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    inputPlaceholder: '填组长姓名',
    inputValidator: (v) => (names.includes(String(v ?? '').trim()) ? true : '请填写组内成员的姓名'),
  }).catch(() => null as any);
  if (!value) return;
  const target = (g.members || []).find((m: any) => m.name === String(value).trim());
  if (!target?.userId) return ElMessage.warning('只支持把内部成员选为组长');
  await meetingsApi.updateGroup(props.meetingId, g.id, { leaderId: target.userId });
  ElMessage.success(`组长已改为 ${target.name}`);
  emit('refresh');
}
</script>

<style scoped>
.ap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ap-sec {
  border: 1px solid #eef1f6;
  border-radius: 12px;
  padding: 10px 12px;
  background: #fff;
}
.ap-h {
  font-weight: 700;
  font-size: 14px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.muted {
  color: #909399;
  font-weight: 400;
  font-size: 12px;
}
.tip {
  margin-top: 6px;
}
.ap-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.ap-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.ap-sel {
  width: 200px;
}
.ap-grow {
  flex: 1;
  min-width: 150px;
}
.ap-quiz {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ap-pending {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px dashed #f0f2f5;
  font-size: 13px;
}
.ap-pending:last-child {
  border-bottom: none;
}
.ap-pending-points {
  color: #f56c6c;
  font-weight: 700;
}
.ap-pending-reason {
  flex: 1;
  min-width: 80px;
}
.ap-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 10px;
  background: #fafbff;
  margin-bottom: 6px;
  flex-wrap: wrap;
  border: 1px dashed transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
}
/* 拖拽悬停：头像正停在这个小组上 */
.ap-group.ap-drop-over {
  background: #eef4ff;
  border-color: #3b6ef6;
}
.ap-group.ap-drop-over.ap-drop-same {
  background: #f6f7f9;
  border-color: #c9ced6;
}
.ap-drop-tip {
  margin-left: 6px;
  font-size: 12px;
  color: #3b6ef6;
  font-weight: 600;
}
/* 拖头像到这块空白区新建小组 */
.ap-newgroup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  margin-bottom: 8px;
  border: 1px dashed #cdd6e8;
  border-radius: 10px;
  background: #fbfcff;
  color: #8a94a6;
  font-size: 13px;
  transition: all 0.12s ease;
}
.ap-newgroup.over {
  border-color: #3b6ef6;
  background: #eef4ff;
  color: #3b6ef6;
  font-weight: 600;
}
/* 拖出小组的投放区：与“新建小组”并排，但用退组的中性色 */
.ap-leavegroup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  margin-bottom: 8px;
  border: 1px dashed #f0c6c6;
  border-radius: 10px;
  background: #fffafa;
  color: #a1556a;
  font-size: 13px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition: all 0.12s ease;
}
.ap-leavegroup.over {
  border-color: #d0482f;
  background: #fff1f2;
  color: #d0482f;
  font-weight: 600;
}
.ap-newgroup-icon {
  font-size: 16px;
  line-height: 1;
}
.ap-group-rank {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border-radius: 50%;
  background: #e6ecff;
  color: #3b6ef6;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ap-group-rank.hot {
  background: #ffb02e;
  color: #fff;
}
.ap-group-main {
  flex: 1;
  min-width: 120px;
}
.ap-group-name {
  font-size: 13px;
  font-weight: 700;
}
.ap-group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.ap-group-score {
  font-size: 18px;
  font-weight: 800;
  color: #3b6ef6;
}
.ap-people {
  display: flex;
  flex-direction: column;
}
.ap-person {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed #f5f6f8;
  font-size: 13px;
}
.ap-person:last-child {
  border-bottom: none;
}
.ap-person-name {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.ap-person-score {
  font-weight: 700;
  color: #3b6ef6;
}
/* 成员头像：老师点它直接计分 */
.ap-avatar {
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  position: relative;
  flex: none;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(23, 43, 77, 0.14);
}
.ap-avatar.clickable {
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.ap-avatar.clickable:hover {
  transform: scale(1.08);
  box-shadow: 0 4px 12px rgba(59, 110, 246, 0.35);
}
.ap-avatar.clickable:active {
  transform: scale(0.94);
}
/* 可拖拽的头像：十字标提示能拿能动，拖动中半透明 */
.ap-avatar.draggable {
  cursor: grab;
}
.ap-avatar.draggable:active {
  cursor: grabbing;
}
.ap-avatar.pulling {
  opacity: 0.45;
  transform: scale(0.92);
}
.ap-avatar-plus {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #ff9f0a;
  color: #fff;
  font-size: 11px;
  line-height: 15px;
  border: 1.5px solid #fff;
}
.ap-avatar.big {
  width: 46px;
  height: 46px;
  font-size: 17px;
}
.ap-score-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ap-score-name {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
}
@media (max-width: 480px) {
  .ap-sel {
    width: 100%;
  }
  .ap-ops > .el-button {
    flex: 1;
  }
}
</style>
