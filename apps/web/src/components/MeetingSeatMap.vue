<template>
  <div class="sm">
    <div class="sm-head">
      <div class="sm-title">
        会场座位图
        <span class="sm-muted">{{ totalPeople }} 人 · {{ tiles.length }} 个位置</span>
      </div>
      <div class="sm-tip">
        <template v-if="picking">再点一个小组（或拖过去）：把「{{ curPerson?.name }}」分进这个组；点空白格子是单独建一组，点下面「移出小组」是退组</template>
        <template v-else-if="canGroup">点任何人的头像 = 给 TA 计分；把头像拖到小组上就分进这个组，拖到空白格子是单独建一组，拖到下面「移出小组」就退组（手机上长按头像不松手再点目标）</template>
        <template v-else-if="canDrag && limited">拖动自己所在的小组摆位置；把自己的头像拖到别的小组即可加入</template>
        <template v-else-if="canDrag && groupCount">拖动小组即可调整座位（同一组的人待在一起）</template>
        <template v-else-if="groupCount">电脑端可以拖动自己所在的小组调整座位</template>
        <template v-else>还没有分组：所有人先按顺序排成矩阵，分成小组后同组会聚在一起</template>
      </div>
    </div>

    <div class="sm-grid" :style="{ gridTemplateColumns: `repeat(${COLS}, minmax(88px, 1fr))` }">
      <!-- 背景格：投放目标 -->
      <div
        v-for="cell in cells"
        :key="`c-${cell.row}-${cell.col}`"
        class="sm-cell"
        :class="{ hover: hoverKey === cell.key, armed: picking || !!armedId }"
        :style="{ gridRow: cell.row + 1, gridColumn: cell.col + 1 }"
        @dragover.prevent="hoverKey = cell.key"
        @dragleave="hoverKey === cell.key && (hoverKey = '')"
        @drop.prevent="onCellDrop(cell)"
        @click="clickCell(cell.row, cell.col)"
      />

      <!-- 小组 / 单人头像：拖人 = 分组，拖小组卡片 = 调整座位 -->
      <div
        v-for="t in tiles"
        :key="t.id"
        class="sm-tile"
        :class="{
          group: !!t.groupId,
          single: !t.groupId,
          dragging: draggingId === t.id && dragKind === 'seat',
          pdrag: dragKind === 'person' && isCur(dragPerson),
          sel: isCur(t.members[0]),
          armed: armedId === t.id,
          target: isTarget(t),
          leader: hasLeader(t),
        }"
        :style="{ gridRow: t.row + 1, gridColumn: t.col + 1 }"
        :draggable="canDragTile(t)"
        :title="tileTitle(t)"
        @dragstart="onDragStart($event, t)"
        @dragend="onDragEnd"
        @dragover.prevent="hoverKey = `${t.row}:${t.col}`"
        @drop.prevent.stop="onTileDrop(t)"
        @click.stop="pickTile(t)"
      >
        <template v-if="t.groupId">
          <div class="sm-tile-head">
            <span class="sm-tile-name">{{ t.name }}</span>
            <span v-if="t.score" class="sm-tile-score">{{ t.score }}</span>
          </div>
          <div class="sm-avatars">
            <span
              v-for="m in t.members"
              :key="m.key || personKey(m)"
              class="sm-avatar"
              :class="{ me: isMe(m), lead: m.isLeader, pdrag: isCur(m), sel: isCur(m) }"
              :style="avatarStyle(m)"
              :draggable="canDragMember(m)"
              :title="memberTitle(m)"
              @dragstart.stop="onMemberDragStart($event, m)"
              @dragend="onDragEnd"
              @click.stop="pickMember(m)"
              @touchstart="onPressStart($event, m)"
              @touchmove="onPressMove"
              @touchend="onPressEnd"
              @touchcancel="onPressEnd"
            >
              {{ m.name }}
              <i v-if="m.isLeader" class="sm-crown">★</i>
            </span>
            <span v-if="!t.members.length" class="sm-muted">还没有组员</span>
          </div>
        </template>
        <template v-else>
          <span
            class="sm-avatar solo"
            :class="{ me: isMe(t.members[0]) }"
            :style="avatarStyle(t.members[0])"
            :title="memberTitle(t.members[0])"
            @touchstart="onPressStart($event, t.members[0])"
            @touchmove="onPressMove"
            @touchend="onPressEnd"
            @touchcancel="onPressEnd"
          >
            {{ t.name }}
          </span>
        </template>
      </div>
    </div>

    <!-- 拖进来容易，拖出去也要有地方：把人拖到这里就回到未分组 -->
    <div
      v-if="canDragAny"
      class="sm-leave"
      :class="{ target: picking, hover: leaveHover }"
      @dragover.prevent="leaveHover = true"
      @dragleave="leaveHover = false"
      @drop.prevent="onLeaveDrop"
      @click="clickLeave"
    >
      <span class="sm-leave-icon">✕</span>
      <span>
        {{
          picking
            ? `松手 / 点一下：把「${curPerson?.name}」移出小组，回到未分组`
            : '把人拖到这里 = 移出小组（回到未分组，小组空了会自动收掉）'
        }}
      </span>
    </div>

    <div v-if="!tiles.length" class="sm-empty">还没有人签到，扫码签到后就会出现在座位图上</div>
    <div v-if="canDrag && !groupCount" class="sm-muted sm-foot">
      提示：先自己建一个小组（或加入旁边的小组），小组才会出现在座位图里并且可以拖动
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { meetingsApi } from '../api';
import { genderTone } from '../utils/avatar';
import { isTouchDevice } from '../utils/useDragTo';

const props = defineProps<{
  board: any;
  meetingId: string;
  /** 有权限拖动小组卡片摆座位（组织者 / 助教 / 本场参会人 / 已签到的来宾） */
  canDrag: boolean;
  meId?: string;
  /** 只允许拖自己所在的组（扫了码的来宾）；不传或空表示可以拖所有组 */
  myGroupIds?: string[];
  /** 自定义落库方式：来宾走免登录接口，组织者走内部接口 */
  seatSaver?: (groupId: string, row: number, col: number) => Promise<unknown>;
  /** 管理层：可以把任何人的头像拖进小组（普通人不传，只能拖自己） */
  canGroup?: boolean;
  /** 已签到来宾的 guestId：用来判断“这个头像就是我本人” */
  myGuestId?: string;
}>();

const emit = defineEmits<{
  (e: 'refresh'): void;
  /** 拖人分组：groupId 为空表示单独新建一组；with 表示两个人一起成组；cell 是落点的格子坐标 */
  (
    e: 'assign',
    ev: { person: Person; groupId: string; name?: string; with?: Person; cell?: { row: number; col: number } },
  ): void;
  /** 拖到「移出小组」区：把这个人从组里退出来（groupId 是他现在所在的组） */
  (e: 'unassign', ev: { person: Person; groupId: string; name?: string }): void;
  /** 点头像：发起人 / 管理员 / 助教点任何人的头像 = 给 TA 计分 */
  (e: 'score', person: Person): void;
}>();

/** 每行几列：会场大致按 5 列摆放 */
const COLS = 5;
/** 至少留两行，空格子既是对齐的矩阵，也是拖动的投放区 */
const MIN_ROWS = 2;

interface Person {
  key?: string;
  userId?: string | null;
  guestId?: string | null;
  name: string;
  gender?: string | null;
  points?: number;
  isLeader?: boolean;
  isOwner?: boolean;
  isAssistant?: boolean;
  kind?: string;
}
interface Tile {
  id: string;
  groupId: string | null;
  name: string;
  score: number;
  members: Person[];
  row: number;
  col: number;
}

const draggingId = ref('');
const hoverKey = ref('');
const leaveHover = ref(false);
/** 当前这一拖是“摆座位”还是“分组”：拖小组卡片 = seat，拖人的头像 = person */
const dragKind = ref<'seat' | 'person'>('seat');
/** 鼠标上这个人（拖拽中），与下面触屏用的“点选” */
const dragPerson = ref<Person | null>(null);
/** 点一下人的头像、再点小组 / 空白格也能分组（触屏 / 无拖拽环境） */
const armedPerson = ref<Person | null>(null);
/** 点一下小组、再点一个空格子也能落位（触屏/无拖拽环境） */
const armedId = ref('');
/** 刚落库的最新坐标：等 refresh 回来期间先按本地坐标画，避免闪回原位 */
const localSeat = ref<Record<string, { row: number; col: number }>>({});

function seatOf(v: unknown) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 50 ? n : -1;
}

/** 组内的成员（组卡） */
const groupTiles = computed<Tile[]>(() =>
  (props.board?.groups || []).map((g: any) => {
    const local = localSeat.value[g.id];
    return {
      id: `group:${g.id}`,
      groupId: g.id,
      name: g.name,
      score: g.score ?? 0,
      members: (g.members || []) as Person[],
      row: local ? local.row : seatOf(g.seatRow),
      col: local ? local.col : seatOf(g.seatCol),
    };
  }),
);

/** 还没进小组的人：各自一个单人头像，自动补进空格子 */
const soloTiles = computed<Tile[]>(() => {
  const inGroup = new Set<string>();
  for (const g of groupTiles.value) for (const m of g.members) for (const k of keysOf(m)) inGroup.add(k);
  const all: Person[] = [
    ...(props.board?.participants || []),
    ...(props.board?.guests || []).filter((g: any) => !g.linkedUserId),
  ];
  return all
    .filter((p) => !keysOf(p).some((k) => inGroup.has(k)))
    .map((p) => ({
      id: `person:${personKey(p)}`,
      groupId: null,
      name: p.name,
      score: p.points ?? 0,
      members: [p],
      row: -1,
      col: -1,
    }));
});

const groupCount = computed(() => groupTiles.value.length);
/** 只能拖自己的组：扫了码的来宾 */
const mineGroups = computed(() => props.myGroupIds ?? []);
const limited = computed(() => mineGroups.value.length > 0);
/** 只要能拖人（管理层能拖任何人，普通人能拖自己）就给出「移出小组」区 */
const canDragAny = computed(() => !!props.canGroup || !!props.meId || !!props.myGuestId);

/** 当前手里拿着的人（拖拽中优先，其次是被点选中的） */
const curPerson = computed(() => dragPerson.value || armedPerson.value);
/** 正在分组：高亮所有合法投放目标 */
const picking = computed(() => !!curPerson.value);
/** 只管理层能把两个人拖到一起成组（来宾只能自己一个人建组） */
const canMerge = computed(() => !!props.canGroup);

/** 这个人是不是“我”（注册参会人看 userId，签到来宾看 guestId） */
function isMePerson(p?: Person) {
  if (!p) return false;
  return (!!props.meId && p.userId === props.meId) || (!!props.myGuestId && p.guestId === props.myGuestId);
}

function isCur(p?: Person) {
  return samePerson(curPerson.value ?? undefined, p);
}

/**
 * 同一个人的两种写法：注册账号看 userId，扫码签到看 guestId。
 * 同一个同事既在名单里又扫了码时，小组卡片里存的是哪一个都不确定，
 * 所以两边只要有任意一项对上就算同一个人（否则他会在座位图上出现两次）。
 */
function keysOf(p?: Person): string[] {
  if (!p) return [];
  const out: string[] = [];
  if (p.userId) out.push(`u:${p.userId}`);
  if (p.guestId) out.push(`g:${p.guestId}`);
  if (!out.length) out.push(personKey(p));
  return out;
}

function samePerson(a?: Person, b?: Person) {
  if (!a || !b) return false;
  const ka = keysOf(a);
  return keysOf(b).some((k) => ka.includes(k));
}

/** 这个人现在在哪个组（拖出去的时候要知道从哪个组退） */
function groupIdOf(p: Person) {
  const g = (props.board?.groups || []).find((x: any) => (x.members || []).some((m: any) => samePerson(m, p)));
  return g?.id || '';
}

/**
 * 拖小组卡片 = 调整座位（沿用旧规则）；
 * 拖还没进组的单人头像 = 分组，管理层拖任何人，普通人只能拖自己
 */
function canDragTile(t: Tile) {
  if (t.groupId) {
    if (!props.canDrag) return false;
    return !limited.value || mineGroups.value.includes(t.groupId);
  }
  return canDragMember(t.members[0]);
}

/** 已经在组里的人也可以被拖出去换组 */
function canDragMember(m?: Person) {
  if (!m) return false;
  return !!props.canGroup || isMePerson(m);
}

/** 分组进行中的投放高亮：小组卡永远可接，别的单人头像可以合为一组 */
function isTarget(t: Tile) {
  if (!picking.value) return false;
  if (t.groupId) return true;
  return canMerge.value && !isCur(t.members[0]);
}

function tileTitle(t: Tile) {
  if (t.groupId) {
    return canDragTile(t)
      ? `${t.name} · ${t.members.length} 人：拖卡片是调整座位，点头像里的人可以分进别的组`
      : `${t.name} · ${t.members.length} 人`;
  }
  return canDragTile(t) ? `${t.name}：把头像拖到小组上就加入这个组` : t.name;
}

function memberTitle(m: Person) {
  if (!canDragMember(m)) return m.name;
  if (props.canGroup) {
    return isTouchDevice
      ? `${m.name}：点一下给 TA 计分；长按头像不松手再点小组 = 分进去，点「移出小组」= 退组`
      : `${m.name}：点一下给 TA 计分；拖到别的小组就换组，拖到空白格子是单独建一组，拖到下面「移出小组」就退组`;
  }
  return '拖自己的头像到别的小组即可加入，拖到下面「移出小组」就退组';
}
const totalPeople = computed(() => {
  const keys = new Set<string>();
  for (const t of groupTiles.value) for (const m of t.members) keys.add(personKey(m));
  for (const t of soloTiles.value) keys.add(personKey(t.members[0]));
  return keys.size;
});

/**
 * 摆放：有坐标的小组先占格子（同一格子只收一个），
 * 其余的小组和单人头像按顺序补进还没人坐的格子。
 */
const tiles = computed<Tile[]>(() => {
  const taken = new Map<string, Tile>();
  const pending: Tile[] = [];
  for (const t of groupTiles.value) {
    const k = `${t.row}:${t.col}`;
    if (t.row >= 0 && t.col >= 0 && t.col < COLS && !taken.has(k)) taken.set(k, t);
    else pending.push(t);
  }
  pending.push(...soloTiles.value);
  let r = 0;
  let c = 0;
  for (const t of pending) {
    while (taken.has(`${r}:${c}`)) {
      c += 1;
      if (c >= COLS) {
        c = 0;
        r += 1;
      }
    }
    taken.set(`${r}:${c}`, { ...t, row: r, col: c });
    c += 1;
    if (c >= COLS) {
      c = 0;
      r += 1;
    }
  }
  return Array.from(taken.values());
});

const rows = computed(() => {
  let max = MIN_ROWS - 1;
  for (const t of tiles.value) max = Math.max(max, t.row);
  return Math.max(max + 1, Math.ceil(tiles.value.length / COLS));
});

const cells = computed(() => {
  const list: { row: number; col: number; key: string }[] = [];
  for (let r = 0; r < rows.value; r += 1) {
    for (let c = 0; c < COLS; c += 1) list.push({ row: r, col: c, key: `${r}:${c}` });
  }
  return list;
});

function personKey(p: Person) {
  if (p.key) return p.key;
  if (p.userId) return `u:${p.userId}`;
  if (p.guestId) return `g:${p.guestId}`;
  return `n:${p.name}`;
}

function isMe(p: Person) {
  return isMePerson(p);
}

function hasLeader(t: Tile) {
  return !!t.groupId && t.members.some((m) => m.isLeader);
}

/** 头像配色：男士浅蓝 / 女士浅粉（签到时二选一填的），没填性别的按姓名散列 */
function avatarStyle(p: Person) {
  const tone = genderTone(p?.gender);
  if (tone) return { background: tone.background, color: tone.color, borderColor: tone.borderColor };
  const name = p?.name || '?';
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return {
    background: `hsl(${h}, 70%, 93%)`,
    color: `hsl(${h}, 45%, 32%)`,
    borderColor: `hsl(${h}, 55%, 82%)`,
  };
}

function onDragStart(e: DragEvent, t: Tile) {
  if (!canDragTile(t)) return;
  draggingId.value = t.id;
  armedId.value = '';
  armedPerson.value = null;
  // 拖小组卡片是摆座位，拖单人头像是分组
  dragKind.value = t.groupId ? 'seat' : 'person';
  dragPerson.value = t.groupId ? null : t.members[0];
  e.dataTransfer?.setData('text/plain', t.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

/** 从小组卡片里直接拖某个组员出来：事件不往上冒，避免同时触发摆座位 */
function onMemberDragStart(e: DragEvent, m: Person) {
  if (!canDragMember(m)) return;
  dragKind.value = 'person';
  dragPerson.value = m;
  armedId.value = '';
  armedPerson.value = null;
  draggingId.value = '';
  e.dataTransfer?.setData('text/plain', personKey(m));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragEnd() {
  draggingId.value = '';
  hoverKey.value = '';
  leaveHover.value = false;
  dragKind.value = 'seat';
  dragPerson.value = null;
  clearTimeout(pressTimer);
}

function pickTile(t: Tile) {
  if (!canDragTile(t)) return;
  // 还没进组的人：点一下 = 选中这个人
  if (!t.groupId) {
    pickMember(t.members[0]);
    return;
  }
  // 已经选好了人，再点这个小组 = 把人分进来
  if (curPerson.value) {
    assignPerson(curPerson.value, t);
    return;
  }
  armedId.value = armedId.value === t.id ? '' : t.id;
  if (armedId.value) ElMessage.info(`已选中「${t.name}」，点一个空格子放过去`);
}

/** 触屏通道：点人 → 再点小组 / 另一个人的头像 / 空白格 /「移出小组」区 */
function pickMember(m?: Person) {
  if (!canDragMember(m)) return;
  const me2 = m as Person;
  // 长按已经把这个人选好了，忽略手机补发的这一次 click
  if (Date.now() < swallowTapUntil) return;
  // 管理层：手里还没有人时，点头像 = 给这个人计分（分组请用拖拽 / 长按）
  if (props.canGroup && !armedPerson.value) {
    scorePerson(me2);
    return;
  }
  if (isCur(me2)) {
    armedPerson.value = null;
    return;
  }
  if (curPerson.value) {
    // 手里已经有人：再点别人 = 把前一个人分到 TA 所在的组（TA 还没进组就合为新的一组）
    const target = tiles.value.find((t) => t.members.some((x) => samePerson(x, me2))) ?? null;
    assignPerson(curPerson.value, target);
    return;
  }
  armPerson(me2);
}

/** 把这个人拿在手里（点选分组 / 退组通道） */
function armPerson(m: Person) {
  armedPerson.value = m;
  armedId.value = '';
  ElMessage.info(`已选中「${m.name}」：点一个小组就分进去，点空白格子是单独建一组，点下面「移出小组」就退组`);
}

/** 点头像计分：小组卡片里的组员没带 key，这里按 userId / guestId 补一个 */
function scorePerson(m: Person) {
  const key = m.key || (m.userId ? `u:${m.userId}` : m.guestId ? `g:${m.guestId}` : '');
  if (!key) {
    ElMessage.warning('这个头像没带身份，刷新一下页面再点');
    return;
  }
  emit('score', { ...m, key });
}

/** 手机上没有 HTML5 拖拽：长按头像 = 把这个人选中用于分组 / 退组（短按是计分） */
const LONG_PRESS_MS = 450;
/** 位移超过这个阈值当成页面滑动，不进入长按 */
const MOVE_CANCEL_PX = 10;
/** 长按生效后短暂屏蔽补发 click 的截止时间 */
let swallowTapUntil = 0;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressX = 0;
let pressY = 0;

function onPressStart(e: TouchEvent, m: Person) {
  if (!props.canGroup || e.touches.length !== 1 || !canDragMember(m)) return;
  const t = e.touches[0];
  pressX = t.clientX;
  pressY = t.clientY;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    // 已进入长按：这次 touch 结尾补发的 click 不再当成“点头像计分”
    swallowTapUntil = Date.now() + 700;
    (navigator as any)?.vibrate?.(15);
    armPerson(m);
  }, LONG_PRESS_MS);
}

function onPressMove(e: TouchEvent) {
  const t = e.touches[0];
  if (t && Math.hypot(t.clientX - pressX, t.clientY - pressY) > MOVE_CANCEL_PX) clearTimeout(pressTimer);
}

function onPressEnd() {
  clearTimeout(pressTimer);
}

function clickCell(row: number, col: number) {
  if (armedPerson.value) {
    assignPerson(armedPerson.value, null, { row, col });
    return;
  }
  if (armedId.value) dropAt(row, col);
}

function onTileDrop(t: Tile) {
  if (dragKind.value === 'person') {
    assignPerson(dragPerson.value as Person, t);
    return;
  }
  dropAt(t.row, t.col);
}

function onCellDrop(cell: { row: number; col: number }) {
  if (dragKind.value === 'person') {
    assignPerson(dragPerson.value as Person, null, cell);
    return;
  }
  dropAt(cell.row, cell.col);
}

/**
 * 分组落子：
 * - 落在小组卡片上 = 加入这个组
 * - 落在另一个单人头像上 = 两个人一起新建一组（仅管理层）
 * - 落在空白格子上 = 单独新建一组，并把新组摆在这一格
 */
function assignPerson(p: Person, target: Tile | null, cell?: { row: number; col: number }) {
  const name = p.name || 'TA';
  if (target?.groupId) {
    if (target.members.some((m) => samePerson(m, p))) {
      ElMessage.info(`${name} 已经在「${target.name}」里了`);
      clearPick();
      return;
    }
    emit('assign', { person: p, groupId: target.groupId, name: target.name });
  } else if (target && canMerge.value && !samePerson(target.members[0], p)) {
    emit('assign', { person: p, groupId: '', with: target.members[0], cell: { row: target.row, col: target.col } });
  } else {
    emit('assign', { person: p, groupId: '', cell });
  }
  clearPick();
}

/**
 * 移出小组：拖到「移出小组」区松手，或点人后再点这个区
 * - 已经在组里 → 退组（小组空了后端会自动收掉）
 * - 本来就没组 → 只提示，不发请求
 */
function unassignPerson(p: Person) {
  const name = p.name || 'TA';
  const groupId = groupIdOf(p);
  if (!groupId) {
    ElMessage.info(`${name} 还没有分组，不用移出`);
    clearPick();
    return;
  }
  emit('unassign', { person: p, groupId, name });
  clearPick();
}

function onLeaveDrop() {
  leaveHover.value = false;
  if (dragKind.value !== 'person') return;
  const p = dragPerson.value;
  if (!p) return;
  unassignPerson(p);
}

function clickLeave() {
  const p = curPerson.value;
  if (!p) {
    ElMessage.info('先点一下要退组的人的头像，再点这里');
    return;
  }
  unassignPerson(p);
}

function clearPick() {
  dragKind.value = 'seat';
  dragPerson.value = null;
  armedPerson.value = null;
  draggingId.value = '';
  hoverKey.value = '';
  leaveHover.value = false;
}

function dropAt(row: number, col: number) {
  if (dragKind.value === 'person') {
    clearPick();
    return;
  }
  const id = draggingId.value || armedId.value;
  draggingId.value = '';
  armedId.value = '';
  hoverKey.value = '';
  if (!id) return;
  const self = tiles.value.find((t) => t.id === id);
  if (!self || !self.groupId) return;
  if (self.row === row && self.col === col) return;
  void place(self, row, col);
}

/** 落位：目标格子有别的组就和它换位置（它是自动补位的也一样换） */
async function place(self: Tile, row: number, col: number) {
  const occupant = tiles.value.find((t) => t.row === row && t.col === col && t.id !== self.id);
  if (occupant?.groupId && !canDragTile(occupant)) {
    ElMessage.warning('这个位置被别的小组占着，换一个空格子吧');
    return;
  }
  const from = { row: self.row, col: self.col };
  const nextLocal: Record<string, { row: number; col: number }> = {
    ...localSeat.value,
    [self.groupId as string]: { row, col },
  };
  if (occupant?.groupId) nextLocal[occupant.groupId] = from;
  localSeat.value = nextLocal;
  const save = props.seatSaver
    ? props.seatSaver
    : (groupId: string, r: number, c: number) => meetingsApi.updateGroup(props.meetingId, groupId, { seatRow: r, seatCol: c });
  try {
    await save(self.groupId as string, row, col);
    if (occupant?.groupId) {
      await save(occupant.groupId, from.row, from.col);
    }
    emit('refresh');
  } catch {
    localSeat.value = {};
    ElMessage.warning('座位没保存成功，请再拖一次');
  }
}

/** 看板刷新回来就丢掉本地坐标，改用服务端结果 */
watch(
  () => props.board,
  () => {
    localSeat.value = {};
  },
);
</script>

<style scoped>
.sm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sm-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.sm-title {
  font-size: 15px;
  font-weight: 700;
}
.sm-muted {
  color: #909399;
  font-size: 12px;
  font-weight: 400;
  margin-left: 6px;
}
.sm-tip {
  color: #909399;
  font-size: 12px;
}
.sm-grid {
  display: grid;
  gap: 8px;
  grid-auto-rows: minmax(96px, auto);
  background: #fafbff;
  border-radius: 12px;
  padding: 8px;
  overflow-x: auto;
}
.sm-cell {
  border: 1px dashed #e2e7f2;
  border-radius: 12px;
  transition: background 0.15s, border-color 0.15s;
  min-height: 96px;
}
.sm-cell.hover {
  background: #eaf1ff;
  border-color: #7aa2f7;
}
.sm-cell.armed {
  border-color: #c3d4ff;
  cursor: pointer;
}

.sm-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 7px;
  background: #fff;
  border: 1px solid #e8edf7;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(23, 43, 77, 0.06);
  overflow: hidden;
  z-index: 1;
  transition: box-shadow 0.15s, transform 0.15s;
}
.sm-tile.group {
  cursor: grab;
  max-height: 168px;
}
.sm-tile.group:active {
  cursor: grabbing;
}
.sm-tile.group.leader {
  border-color: #ffe0a3;
  background: linear-gradient(180deg, #fffdf6, #fff);
}
.sm-tile.dragging {
  opacity: 0.45;
}
/* 头像上的字不应该被选中（选中后拖不动，体验像坏了） */
.sm-tile,
.sm-avatar {
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.sm-tile.single[draggable='true'],
.sm-avatar[draggable='true'] {
  cursor: grab;
}
.sm-tile.pdrag,
.sm-avatar.pdrag {
  opacity: 0.4;
}
.sm-tile.target {
  border-color: #7aa2f7;
  box-shadow: 0 0 0 2px rgba(122, 162, 247, 0.45), 0 4px 14px rgba(59, 110, 246, 0.18);
}
/* 被点选中的那个人（触屏“点人 → 再点组”通道要有可见反馈） */
.sm-tile.sel,
.sm-avatar.sel {
  box-shadow: 0 0 0 2px #3b6ef6, 0 4px 14px rgba(59, 110, 246, 0.22);
  cursor: grabbing;
}
.sm-tile.armed {
  box-shadow: 0 0 0 2px #7aa2f7, 0 6px 18px rgba(59, 110, 246, 0.24);
}
.sm-tile.single {
  align-items: center;
  justify-content: center;
  border-style: dashed;
  box-shadow: none;
  background: #fcfdff;
}
.sm-tile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: #4a5875;
}
.sm-tile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-tile-score {
  flex: 0 0 auto;
  color: #f56c6c;
}
.sm-avatars {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  overflow-y: auto;
}
.sm-avatar {
  position: relative;
  min-width: 38px;
  height: 38px;
  padding: 0 5px;
  border-radius: 10px;
  border: 1px solid transparent;
  font-size: 11px;
  line-height: 1.1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  word-break: break-all;
  overflow: hidden;
}
.sm-avatar.solo {
  width: 86%;
  height: 62px;
  font-size: 13px;
  border-radius: 12px;
}
.sm-avatar.me {
  box-shadow: 0 0 0 2px #3b6ef6;
}
.sm-avatar.lead {
  font-weight: 700;
}
.sm-crown {
  position: absolute;
  top: 0;
  right: 2px;
  font-size: 8px;
  color: #f0a020;
}
.sm-empty {
  color: #a8abb2;
  font-size: 13px;
  padding: 6px 0;
}
/* 拖出小组的投放区：拖人的头像时高亮，平时也能看清位置 */
.sm-leave {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed #f3c5c5;
  border-radius: 12px;
  background: #fffafa;
  color: #a1556a;
  font-size: 12px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.sm-leave-icon {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f7e3e6;
  color: #d0482f;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
}
.sm-leave.target {
  border-color: #f0919b;
  background: #fff4f5;
}
.sm-leave.hover,
.sm-leave.target:hover {
  box-shadow: 0 0 0 2px rgba(240, 145, 155, 0.45);
  cursor: pointer;
}
.sm-foot {
  margin-left: 0;
}
</style>
