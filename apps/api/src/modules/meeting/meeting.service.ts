import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ReportType, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { isoWeekOf, beijingMondayOf, fmtBeijing, CN_OFFSET_MS } from '../../common/beijing-time';
import { hasAtLeast } from '../../common/permissions';
import { isDeptAuthority, ledDeptWhere } from '../../common/dept-authority';
import { FilesService } from '../files/files.service';
import { MeetingNotifyKind } from './meeting-notify.service';
import { MeetingReminderQueue } from './meeting-reminder.queue';
import { MeetingReminderService } from './meeting-reminder.service';

/** 会议状态机：草稿 → 已安排 →（进行中 → 纪要整理中 →）已完成 / 已取消 */
export const MEETING_STATUS = ['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'MINUTING', 'DONE', 'CANCELLED'];
/** 会议层级：部门周会 / 公司 leader 周会 / 项目会议 / 临时-小组会议 / 活动（活动不单列一类，是层级之一） */
export const MEETING_SCOPES = ['DEPT', 'COMPANY', 'PROJECT', 'PERSONAL', 'ACTIVITY'];
export const MEETING_TYPES = ['WEEKLY', 'DAILY', 'PROJECT', 'REVIEW', 'ACTIVITY', 'OTHER'];
/** 重要性档位：高 / 中（默认）/ 低 */
export const MEETING_IMPORTANCE = ['HIGH', 'MEDIUM', 'LOW'];
/** 活跃度权重：参加一次高 / 中 / 低重要性的会议活动分别累加 3 / 2 / 1 分 */
export const IMPORTANCE_SCORE: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
/** 自主签到窗口：会议开始时刻起 1 小时内本人可自助签到，过后需要补签 */
export const CHECKIN_WINDOW_MS = 60 * 60 * 1000;
/** 团队公告卡片打卡窗口：从会议开始时刻起 3 天内都能打，比会议页的 1 小时自助签到宽松 */
export const BOARD_CHECKIN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** 团队公告卡片的时间窗：北京日历日「今天 ± 3 天」，含今天共 7 天 */
export const BOARD_WINDOW_DAYS = 3;
/** 公告卡片取数上限（7 天窗口足够用，留上限只为防意外） */
const BOARD_TAKE = 100;
/** 会前材料类型：读周报 / 读日报 / 只填文字材料 / 不要求 */
export const MEETING_MATERIAL_TYPES = ['REPORT_WEEKLY', 'REPORT_DAILY', 'TEXT', 'NONE'];

/** 调用方传入的当前用户（id/role/departmentId 足够判权与推人） */
export interface MeetingActor {
  id: string;
  name: string;
  role: string;
  departmentId?: string | null;
}

/** 判可见性只要这几个字段：列表行、详情行、公告行都满足这个形状 */
interface MeetingAccessRow {
  id: string;
  ownerId: string;
  scope: string;
  type: string;
  deptId?: string | null;
  projectId?: string | null;
  participantIds?: string[];
  assistantIds?: string[];
  extraProjectIds?: string[];
}

/** visibilityCtx() 的结果：我在哪些部门 / 项目组 / 我管哪些部门 */
interface MeetingVisibilityCtx {
  deptIds: Set<string>;
  projectIds: Set<string>;
  ledDeptIds: Set<string>;
  isAdmin: boolean;
}

/** 创建/编辑会议的入参（日期为前端本地时区 ISO 串，与任务 dueDate 同口径存绝对时刻） */
export interface MeetingInput {
  title?: string;
  scope?: string;
  type?: string;
  importance?: string; // HIGH 高 / MEDIUM 中 / LOW 低（不传默认中）
  agenda?: string;
  deptId?: string | null;
  projectId?: string | null;
  slotId?: string | null;
  location?: string | null;
  startAt?: string;
  endAt?: string;
  materialType?: string;
  materialRequirement?: string | null;
  reportPeriodStart?: string | null;
  participantIds?: string[];
  groupConversationId?: string | null;
  groupName?: string | null;
  remindEnabled?: boolean;
  remindBeforeMinutes?: number;
  publish?: boolean; // 创建即发布（发群 + 邀请），对应「保存并发布」
  notifyMode?: string; // 通知方式：BOTH 群发+私发 / GROUP 只群发 / DM 只私发
  minutesWriterId?: string | null; // 纪要撰写人（不传则默认主持人）
  docText?: string; // 会议/活动文档的在线文字记录
}

/** 会议管理核心服务（事前-事中-事后闭环）
 * 只拥有「会议 / 会前材料 / 点评 / 条目 / 纪要」；
 * 执行落地到 Task、通知落地到钉钉、材料来源落地到 Report（见 meeting-task.service / meeting-notify.service）
 */
@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private prisma: PrismaService,
    private queue: MeetingReminderQueue,
    private reminder: MeetingReminderService,
    private files: FilesService,
  ) {}

  /** 会议列表：view=mine 我参加的 / owned 我发起的 / all 全部（仅部门负责人及以上）；kind=ACTIVITY 只看活动 */
  async list(me: MeetingActor, q: { view?: string; scope?: string; status?: string; type?: string; kind?: string; keyword?: string; take?: number | string }) {
    const view = (q.view ?? 'mine').toUpperCase();
    const take = Math.min(Math.max(Number(q.take) || 50, 1), 200);
    const and: Record<string, unknown>[] = [{ deletedAt: null }];
    if (q.scope) and.push({ scope: q.scope.toUpperCase() });
    if (q.type) and.push({ type: q.type.toUpperCase() });
    // 类型分组：活动 / 会议（除活动外的所有会议类型）
    if ((q.kind ?? '').toUpperCase() === 'ACTIVITY') and.push({ type: 'ACTIVITY' });
    else if ((q.kind ?? '').toUpperCase() === 'MEETING') and.push({ type: { not: 'ACTIVITY' } });
    if (q.status) and.push({ status: q.status.toUpperCase() });
    if (q.keyword) and.push({ OR: [{ title: { contains: q.keyword } }, { agenda: { contains: q.keyword } }] });

    // 基本信息全员可见：view=all 不再限部门负责人（内容面逐行用 fullAccess 判定并脱敏）
    if (view === 'OWNED') {
      and.push({ ownerId: me.id });
    } else if (view !== 'ALL') {
      // MINE：我发起的 ∪ 我被邀请的（材料行/参会名册）；别人未发布的草稿不对受邀人曝光
      and.push({
        OR: [
          { ownerId: me.id },
          { status: { not: 'DRAFT' }, materials: { some: { userId: me.id } } },
          { status: { not: 'DRAFT' }, participantIds: { has: me.id } },
        ],
      });
    }
    if (view !== 'OWNED') {
      // 自己的草稿自己看得见，其余一律不进列表（view=all 放开后否则会把别人的草稿标题漏出去）
      and.push({ OR: [{ status: { not: 'DRAFT' } }, { ownerId: me.id }] });
      and.push(this.visibilityGate(me));
    }

    const rows = await this.prisma.meeting.findMany({
      where: { AND: and },
      orderBy: [{ startAt: 'desc' }],
      take,
      include: {
        owner: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    // 就绪度与条目数一次批量聚合，避免 N+1
    const ids = rows.map((r) => r.id);
    const [matAgg, itemAgg] = ids.length
      ? await Promise.all([
          this.prisma.meetingMaterial.groupBy({ by: ['meetingId', 'status'], where: { meetingId: { in: ids } }, _count: true }),
          this.prisma.meetingItem.groupBy({ by: ['meetingId'], where: { meetingId: { in: ids } }, _count: true }),
        ])
      : [[], []];
    const matMap = new Map<string, { total: number; submitted: number }>();
    for (const g of matAgg as Array<{ meetingId: string; status: string; _count: number }>) {
      const cur = matMap.get(g.meetingId) ?? { total: 0, submitted: 0 };
      cur.total += g._count;
      if (g.status === 'SUBMITTED') cur.submitted += g._count;
      matMap.set(g.meetingId, cur);
    }
    const itemMap = new Map<string, number>();
    for (const g of itemAgg as Array<{ meetingId: string; _count: number }>) itemMap.set(g.meetingId, g._count);

    // 我的签到状态与出勤人数（一次批量，避免逐行查）
    const [myAtt, attAgg] = ids.length
      ? await Promise.all([
          this.prisma.meetingAttendance.findMany({ where: { meetingId: { in: ids }, userId: me.id }, select: { meetingId: true, method: true } }),
          this.prisma.meetingAttendance.groupBy({ by: ['meetingId'], where: { meetingId: { in: ids } }, _count: true }),
        ])
      : [[], []];
    const myAttMap = new Map<string, string>();
    for (const a of myAtt as Array<{ meetingId: string; method: string }>) myAttMap.set(a.meetingId, a.method);
    const attCountMap = new Map<string, number>();
    for (const g of attAgg as Array<{ meetingId: string; _count: number }>) attCountMap.set(g.meetingId, g._count);

    // 列表页一键「签到」的可见性：与详情 canSelfCheckin 同口径（参会人 + 开始后 1 小时窗口内 + 已发布未取消 + 本人未签）
    const now = new Date();
    const ctx = await this.visibilityCtx(me);
    const flags = await this.fullAccessFlags(me, rows, ctx);
    const kw = (q.keyword ?? '').trim();

    return rows
      .map((r) => {
        // 内容面权限：看不到完整内容的人只拿到基本信息，议题/材料进度/条目数/纪要标记一律脱敏
        const full = flags.get(r.id) === true;
        // 搜索命中了 agenda 但议程对他不可见：这条不能出现在结果里，否则「搜得到」本身就漏了内容
        if (!full && kw && !r.title.includes(kw)) return null;
        const base = {
          id: r.id,
          title: r.title,
          scope: r.scope,
          type: r.type,
          importance: r.importance,
          status: r.status,
          startAt: r.startAt,
          endAt: r.endAt,
          agenda: full ? r.agenda : '',
          location: r.location,
          ownerId: r.ownerId,
          ownerName: r.owner?.name ?? '',
          departmentName: r.department?.name ?? null,
          projectName: r.project?.name ?? null,
          participantCount: r.participantIds.length,
          materialReady: full ? matMap.get(r.id) ?? { total: 0, submitted: 0 } : { total: 0, submitted: 0 },
          itemCount: full ? itemMap.get(r.id) ?? 0 : 0,
          materialType: full ? r.materialType : null,
          groupNotified: full ? !!r.groupNotifiedAt : false,
          minutesReady: full ? !!r.minutes : false,
          attendanceCount: attCountMap.get(r.id) ?? 0,
          myCheckedIn: myAttMap.has(r.id),
          myCheckinMethod: myAttMap.get(r.id) ?? null,
          canSelfCheckin:
            full &&
            !myAttMap.has(r.id) &&
            ((r.participantIds ?? []).includes(me.id) || r.ownerId === me.id) &&
            !!r.startAt &&
            now.getTime() >= r.startAt.getTime() &&
            now.getTime() <= r.startAt.getTime() + CHECKIN_WINDOW_MS &&
            r.status !== 'CANCELLED' &&
            r.status !== 'DRAFT',
          mine: r.ownerId === me.id,
          canManage: r.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN),
          fullAccess: full,
          lockReason: full ? null : this.lockHint(r, { departmentName: r.department?.name, projectName: r.project?.name }),
        };
        return base;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }

  /**
   * 团队公告卡片的会议活动通知：北京日历日「今天 ± 3 天」（含今天共 7 天）内的会议与活动，全员可见。
   * 只输出通知需要的字段（标题 / 时间 / 地点 / 组织者 / 我的打卡状态 + 详情链接），
   * 议题正文、材料、纪要不给无关同事，避免为了打卡把内容面铺宽。
   */
  async announceBoard(me: MeetingActor) {
    const now = new Date();
    // 北京今日 00:00 对应的绝对时刻（不依赖容器时区），再往前 / 往后括出整天窗口
    const bj = new Date(now.getTime() + CN_OFFSET_MS);
    const dayStart = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - CN_OFFSET_MS;
    const from = new Date(dayStart - BOARD_WINDOW_DAYS * 86400000);
    const to = new Date(dayStart + (BOARD_WINDOW_DAYS + 1) * 86400000);

    const rows = await this.prisma.meeting.findMany({
      where: {
        deletedAt: null,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        startAt: { gte: from, lt: to },
        // 保密项目的会议对圈外人整场不出现（连标题与时间也是信息）
        ...this.visibilityGate(me),
      },
      orderBy: { startAt: 'asc' },
      take: BOARD_TAKE,
      include: {
        owner: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    const ids = rows.map((r) => r.id);
    const [myAtt, attAgg] = ids.length
      ? await Promise.all([
          this.prisma.meetingAttendance.findMany({
            where: { meetingId: { in: ids }, userId: me.id },
            select: { meetingId: true, method: true, checkedAt: true },
          }),
          this.prisma.meetingAttendance.groupBy({ by: ['meetingId'], where: { meetingId: { in: ids } }, _count: true }),
        ])
      : [[], []];
    const myAttMap = new Map<string, { method: string; checkedAt: Date }>();
    for (const a of myAtt as Array<{ meetingId: string; method: string; checkedAt: Date }>) myAttMap.set(a.meetingId, a);
    const attCountMap = new Map<string, number>();
    for (const g of attAgg as Array<{ meetingId: string; _count: number }>) attCountMap.set(g.meetingId, g._count);
    const ctx = await this.visibilityCtx(me);
    const flags = await this.fullAccessFlags(me, rows, ctx);

    return rows.map((r) => {
      const started = !!r.startAt && now.getTime() >= r.startAt.getTime();
      const deadline = r.startAt ? new Date(r.startAt.getTime() + BOARD_CHECKIN_WINDOW_MS) : null;
      const checked = myAttMap.get(r.id);
      // 公告卡片只展基本信息，但打卡要按完整内容权限判：隔壁部门的人不应该给别人的部门会打卡
      const full = flags.get(r.id) === true;
      return {
        id: r.id,
        title: r.title,
        /** 活动与会议在公告里是两个标签，除文案外口径完全一致 */
        kind: r.type === 'ACTIVITY' ? 'ACTIVITY' : 'MEETING',
        type: r.type,
        importance: r.importance,
        status: r.status,
        startAt: r.startAt,
        endAt: r.endAt,
        location: r.location,
        ownerName: r.owner?.name ?? '',
        departmentName: r.department?.name ?? null,
        attendanceCount: attCountMap.get(r.id) ?? 0,
        myCheckedIn: !!checked,
        myCheckinMethod: checked?.method ?? null,
        myCheckedAt: checked?.checkedAt ?? null,
        notStarted: !started,
        /** 能否在这行里看到完整内容（无权限时前端不渲染打卡按钮，只给锁标识） */
        fullAccess: full,
        lockReason: full ? null : this.lockHint(r, { departmentName: r.department?.name, projectName: r.project?.name }),
        /** 公告里点「打卡」的判定：有完整查看权限 + 已开始 + 3 天窗口内 + 本人未打 */
        canCheckin: full && !checked && started && !!deadline && now.getTime() <= deadline.getTime(),
        checkinDeadline: deadline,
        link: `/meetings/${r.id}`,
      };
    });
  }

  /** 会议活动详情：基本信息全员可看；内容面（议题/材料/纪要/名单/条目/文档）按层级判权限 */
  async detail(me: MeetingActor, id: string) {
    const m = await this.mustFind(id);
    await this.assertBasicViewer(me, m);
    const ctx = await this.visibilityCtx(me);
    if (!(await this.hasFullAccess(me, m, ctx))) return this.basicDetail(me, m);
    const [owner, dept, project, materials, items, writer, participants, attendances, praises, attachments, ledDepts, docEditor] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: m.ownerId }, select: { id: true, name: true, avatar: true } }),
      m.deptId ? this.prisma.department.findUnique({ where: { id: m.deptId }, select: { id: true, name: true } }) : Promise.resolve(null),
      m.projectId ? this.prisma.project.findUnique({ where: { id: m.projectId }, select: { id: true, name: true } }) : Promise.resolve(null),
      this.prisma.meetingMaterial.findMany({
        where: { meetingId: m.id },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true, avatar: true, departmentId: true, department: { select: { name: true } } } } },
      }),
      this.prisma.meetingItem.findMany({
        where: { meetingId: m.id },
        orderBy: [{ kind: 'asc' }, { dueDate: 'asc' }],
        include: { assignee: { select: { id: true, name: true } }, task: { select: { id: true, title: true, status: true } } },
      }),
      this.prisma.user.findUnique({ where: { id: m.minutesWriterId ?? m.ownerId }, select: { id: true, name: true } }),
      this.prisma.user.findMany({
        where: { id: { in: m.participantIds } },
        select: {
          id: true,
          name: true,
          avatar: true,
          departmentId: true,
          department: { select: { name: true } },
          // 行内补签按钮的权限要看额外部门（一个人可属多部门），与 canMakeupFor 同口径
          extraDepartments: { select: { id: true } },
        },
      }),
      this.prisma.meetingAttendance.findMany({ where: { meetingId: m.id }, include: { operator: { select: { id: true, name: true } } } }),
      this.prisma.meetingPraise.findMany({
        where: { meetingId: m.id },
        orderBy: { createdAt: 'asc' },
        include: { praiser: { select: { id: true, name: true } } },
      }),
      this.prisma.attachment.findMany({ where: { meetingId: m.id }, orderBy: { createdAt: 'asc' }, include: { uploader: { select: { id: true, name: true } } } }),
      this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } }),
      m.docUpdatedById ? this.prisma.user.findUnique({ where: { id: m.docUpdatedById }, select: { id: true, name: true } }) : Promise.resolve(null),
    ]);

    const canManage = m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN);
    const canPraise = canManage || (m.assistantIds ?? []).includes(me.id);
    const isParticipant = m.participantIds.includes(me.id) || m.ownerId === me.id;
    const ledDeptIds = new Set(ledDepts.map((d) => d.id));
    const now = new Date();
    const windowStart = m.startAt;
    const windowEnd = new Date(m.startAt.getTime() + CHECKIN_WINDOW_MS);
    const selfOpen = now.getTime() >= windowStart.getTime() && now.getTime() <= windowEnd.getTime();
    const attMap = new Map(attendances.map((a) => [a.userId, a]));
    const praiseMap = new Map<string, Array<{ id: string; praiserId: string; praiserName: string; reason: string | null; createdAt: Date }>>();
    for (const p of praises) {
      const list = praiseMap.get(p.userId) ?? [];
      list.push({ id: p.id, praiserId: p.praiserId, praiserName: p.praiser?.name ?? '', reason: p.reason, createdAt: p.createdAt });
      praiseMap.set(p.userId, list);
    }
    const attendanceRows = participants
      .map((u: any) => {
        const a: any = attMap.get(u.id);
        const uDeptIds = [u.departmentId, ...(u.extraDepartments ?? []).map((d: any) => d.id)].filter((x): x is string => !!x);
        const canMakeupRow =
          !a &&
          now.getTime() > windowEnd.getTime() &&
          m.status !== 'CANCELLED' &&
          (m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN) || (m.assistantIds ?? []).includes(me.id) || uDeptIds.some((d) => ledDeptIds.has(d)));
        return {
          userId: u.id,
          name: u.name,
          avatar: u.avatar ?? null,
          departmentId: u.departmentId ?? null,
          departmentName: u.department?.name ?? null,
          checked: !!a,
          method: a?.method ?? null,
          reason: a?.reason ?? null,
          checkedAt: a?.checkedAt ?? null,
          operatorName: a?.operator?.name ?? null,
          praises: praiseMap.get(u.id) ?? [],
          canMakeup: canMakeupRow,
          canPraise: canPraise && u.id !== me.id,
        };
      })
      .sort((a: any, b: any) => (a.checked === b.checked ? String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'zh-Hans-CN') : a.checked ? -1 : 1));
    const files = await Promise.all(
      attachments.map(async (f: any) => ({
        id: f.id,
        fileName: f.fileName,
        mimeType: f.mimeType,
        size: f.size,
        uploaderId: f.uploaderId,
        uploaderName: f.uploader?.name ?? '',
        createdAt: f.createdAt,
        url: await this.files.presignedUrl(f.fileKey),
        canDelete: f.uploaderId === me.id || canManage,
      })),
    );
    return {
      id: m.id,
      title: m.title,
      scope: m.scope,
      type: m.type,
      importance: m.importance,
      status: m.status,
      agenda: m.agenda,
      startAt: m.startAt,
      endAt: m.endAt,
      location: m.location,
      ownerId: m.ownerId,
      owner: owner ?? null,
      department: dept ?? null,
      project: project ?? null,
      slotId: m.slotId,
      autoCreated: m.autoCreated,
      isoWeek: m.isoWeek,
      materialType: m.materialType,
      materialRequirement: m.materialRequirement,
      reportPeriodStart: m.reportPeriodStart,
      materialDeadline: m.materialDeadline,
      notifyMode: m.notifyMode,
      minutesWriterId: m.minutesWriterId ?? m.ownerId,
      participantIds: m.participantIds,
      groupConversationId: m.groupConversationId,
      groupName: m.groupName,
      extraProjectIds: m.extraProjectIds,
      remindEnabled: m.remindEnabled,
      remindBeforeMinutes: m.remindBeforeMinutes,
      remindAt: m.remindAt,
      startNotifiedAt: m.startNotifiedAt,
      groupNotifiedAt: m.groupNotifiedAt,
      minutesSentAt: m.minutesSentAt,
      minutes: m.minutes,
      minutesWriter: writer ?? null,
      // ---- 会议/活动文档 ----
      docText: m.docText ?? '',
      docUpdatedAt: m.docUpdatedAt,
      docUpdatedBy: docEditor ?? null,
      files,
      // ---- 活动互动（对外链接 / 助教）----
      publicToken: m.publicToken,
      assistantIds: m.assistantIds ?? [],
      quizQuestion: m.quizQuestion,
      quizPoints: m.quizPoints,
      // ---- 考勤 ----
      attendance: {
        windowStart,
        windowEnd,
        selfOpen,
        masked: false,
        checked: attendanceRows.filter((r: any) => r.checked).length,
        total: attendanceRows.length,
        isParticipant,
        mine: attMap.get(me.id)
          ? {
              method: attMap.get(me.id)!.method,
              checkedAt: attMap.get(me.id)!.checkedAt,
              reason: attMap.get(me.id)!.reason,
            }
          : null,
        canSelfCheckin: !attMap.get(me.id) && isParticipant && selfOpen && m.status !== 'CANCELLED' && m.status !== 'DRAFT',
        // 矩阵入口只看「我有没有补签权限」，不被签到窗口卡住（会议进行中也能代签）
        canMakeupAny: this.canMakeupAny(me, m, ledDepts) && m.status !== 'CANCELLED' && m.status !== 'DRAFT',
        rows: attendanceRows,
      },
      praises: praises.map((p: any) => ({
        id: p.id,
        userId: p.userId,
        praiserId: p.praiserId,
        praiserName: p.praiser?.name ?? '',
        reason: p.reason,
        createdAt: p.createdAt,
      })),
      canPraise,
      cancelledReason: m.cancelledReason,
      createdAt: m.createdAt,
      canManage: m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN),
      canReview: m.ownerId === me.id || hasAtLeast(me.role, Role.DEPT_LEADER),
      // 内容面已判定可见，前端用这两个字段决定锁提示要不要渲染
      fullAccess: true,
      lockReason: null,
      materials: materials.map((x: any) => ({
        id: x.id,
        userId: x.userId,
        name: x.user?.name ?? '',
        avatar: x.user?.avatar ?? null,
        departmentName: x.user?.department?.name ?? null,
        status: x.status,
        source: x.source,
        reportId: x.reportId,
        hasContent: !!(x.editedContent || x.rawContent),
        submittedAt: x.submittedAt,
        isSelf: x.userId === me.id,
      })),
      items: items.map((x: any) => ({
        id: x.id,
        kind: x.kind,
        title: x.title,
        detail: x.detail,
        assigneeId: x.assigneeId,
        assigneeName: x.assignee?.name ?? null,
        dueDate: x.dueDate,
        source: x.source,
        confirmed: x.confirmed,
        taskId: x.taskId,
        taskStatus: x.task?.status ?? null,
        createdRound: x.createdRound,
      })),
    };
  }

  /**
   * 无完整查看权限时的详情：只给基本信息（标题 / 时间 / 地点 / 发起人 / 状态 / 签到人数）。
   * 字段名与完整载荷保持一致，内容面全部置空，前端不用为脱敏版写第二套模板。
   */
  private async basicDetail(me: MeetingActor, m: Awaited<ReturnType<MeetingService['mustFind']>>) {
    const [owner, dept, project, mine, checked] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: m.ownerId }, select: { id: true, name: true, avatar: true } }),
      m.deptId ? this.prisma.department.findUnique({ where: { id: m.deptId }, select: { id: true, name: true } }) : Promise.resolve(null),
      m.projectId ? this.prisma.project.findUnique({ where: { id: m.projectId }, select: { id: true, name: true } }) : Promise.resolve(null),
      this.prisma.meetingAttendance.findUnique({ where: { meetingId_userId: { meetingId: m.id, userId: me.id } } }),
      this.prisma.meetingAttendance.count({ where: { meetingId: m.id } }),
    ]);
    const windowStart = m.startAt;
    const windowEnd = new Date(m.startAt.getTime() + CHECKIN_WINDOW_MS);
    return {
      id: m.id,
      title: m.title,
      scope: m.scope,
      type: m.type,
      importance: m.importance,
      status: m.status,
      agenda: '',
      startAt: m.startAt,
      endAt: m.endAt,
      location: m.location,
      ownerId: m.ownerId,
      owner: owner ?? null,
      department: dept ?? null,
      project: project ?? null,
      slotId: m.slotId,
      autoCreated: m.autoCreated,
      isoWeek: m.isoWeek,
      // ---- 内容面：议题 / 材料 / 纪要 / 文档 / 名单 / 群信息一律不下发 ----
      materialType: null,
      materialRequirement: null,
      reportPeriodStart: null,
      materialDeadline: null,
      notifyMode: null,
      minutesWriterId: null,
      participantIds: [],
      participantCount: m.participantIds.length,
      groupConversationId: null,
      groupName: null,
      extraProjectIds: [],
      remindEnabled: false,
      remindBeforeMinutes: 0,
      remindAt: null,
      startNotifiedAt: null,
      groupNotifiedAt: null,
      minutesSentAt: null,
      minutes: null,
      minutesWriter: null,
      docText: '',
      docUpdatedAt: null,
      docUpdatedBy: null,
      files: [],
      publicToken: null,
      assistantIds: [],
      quizQuestion: null,
      quizPoints: 0,
      attendance: {
        windowStart,
        windowEnd,
        selfOpen: false,
        masked: true,
        checked,
        total: m.participantIds.length,
        isParticipant: false,
        mine: mine ? { method: mine.method, checkedAt: mine.checkedAt, reason: mine.reason } : null,
        canSelfCheckin: false,
        canMakeupAny: false,
        rows: [],
      },
      praises: [],
      canPraise: false,
      cancelledReason: null,
      createdAt: m.createdAt,
      canManage: false,
      canReview: false,
      materials: [],
      items: [],
      fullAccess: false,
      lockReason: this.lockHint(m, { departmentName: dept?.name, projectName: project?.name }),
    };
  }

  /** 创建会议：按层级自动推参会人，人为覆盖优先；publish=true 时直接置为已安排 */
  async create(me: MeetingActor, input: MeetingInput) {
    const startAt = this.parseDate(input.startAt, '开始时间');
    const endAt = this.parseDate(input.endAt, '结束时间');
    if (endAt.getTime() <= startAt.getTime()) throw new BadRequestException('结束时间需晚于开始时间');
    const scope = MEETING_SCOPES.includes((input.scope ?? '').toUpperCase()) ? (input.scope as string).toUpperCase() : 'PERSONAL';
    // 活动是层级之一：scope=ACTIVITY 时类型恒为 ACTIVITY，标题/说明按活动措辞校验
    const isActivity = scope === 'ACTIVITY';
    const title = (input.title ?? '').trim();
    if (title.length < 2) throw new BadRequestException(isActivity ? '请填写活动名称' : '请填写会议主题');
    const agenda = (input.agenda ?? '').trim();
    if (!agenda) throw new BadRequestException(isActivity ? '请填写活动说明' : '请填写会议内容/议题');

    const type = isActivity
      ? 'ACTIVITY'
      : MEETING_TYPES.includes((input.type ?? '').toUpperCase())
        ? (input.type as string).toUpperCase()
        : 'WEEKLY';
    // 重要性：高/中/低，不传默认中（所有会议与活动都必须有档位）
    const importance = MEETING_IMPORTANCE.includes((input.importance ?? '').toUpperCase()) ? (input.importance as string).toUpperCase() : 'MEDIUM';
    const materialType = MEETING_MATERIAL_TYPES.includes((input.materialType ?? '').toUpperCase())
      ? (input.materialType as string).toUpperCase()
      : scope === 'DEPT' || scope === 'COMPANY'
        ? 'REPORT_WEEKLY'
        : 'NONE';

    // 部门推断：DEPT 必须指定部门，其余层级用发起人所在部门（公司级不绑部门）
    const deptId = scope === 'DEPT' ? (input.deptId ?? me.departmentId ?? null) : scope === 'PERSONAL' || scope === 'COMPANY' ? null : input.deptId ?? null;
    if (scope === 'DEPT' && !deptId) throw new BadRequestException('请选择开会部门');
    if (scope === 'PROJECT' && !input.projectId) throw new BadRequestException('请选择关联项目');

    const participants = await this.resolveParticipants(scope, { me, deptId, projectId: input.projectId }, input.participantIds);
    if (!participants.length) throw new BadRequestException('请选择参会人员');
    if (!participants.includes(me.id)) participants.push(me.id);
    const minutesWriterId = await this.normWriter(input.minutesWriterId);

    const startNotifiedGuard = startAt.getTime() < Date.now() - 60_000;
    const remindEnabled = input.remindEnabled !== false && !startNotifiedGuard;
    const before = Math.min(Math.max(Number(input.remindBeforeMinutes) || 0, 0), 1440);

    const meeting = await this.prisma.meeting.create({
      data: {
        title,
        agenda,
        scope,
        type,
        importance,
        ownerId: me.id,
        deptId,
        projectId: input.projectId ?? null,
        slotId: input.slotId ?? null,
        location: (input.location ?? '').trim() || null,
        startAt,
        endAt,
        status: input.publish ? 'SCHEDULED' : 'DRAFT',
        materialType: materialType === 'NONE' ? null : materialType,
        materialRequirement: (input.materialRequirement ?? '').trim() || null,
        reportPeriodStart: materialType.startsWith('REPORT_') ? beijingMondayOf(startAt) : null,
        materialDeadline: materialType === 'NONE' ? null : startAt,
        participantIds: participants,
        groupConversationId: (input.groupConversationId ?? '').trim() || null,
        groupName: (input.groupName ?? '').trim() || null,
        remindEnabled,
        remindBeforeMinutes: before,
        notifyMode: this.normNotifyMode(input.notifyMode),
        minutesWriterId: minutesWriterId ?? me.id,
        remindAt: remindEnabled ? new Date(startAt.getTime() - before * 60_000) : null,
        // 活动天然带一条对外开放链接：陌生人可看活动/签到/答题加分
        publicToken: type === 'ACTIVITY' ? randomBytes(10).toString('hex') : null,
      },
    });
    await this.upsertMaterials(meeting, participants);
    this.logger.log(`会议已创建 meeting=${meeting.id} scope=${scope} by=${me.name} 参会=${participants.length}`);
    if (input.publish) {
      await this.queue.pushSend(meeting.id, 'INVITE');
      await this.pullOnPublish(meeting.id);
    }
    return this.detail(me, meeting.id);
  }

  /** 编辑会议（仅 DRAFT/SCHEDULED 允许；已通知后改时间需重新提醒，由 P0-b 处理） */
  async update(me: MeetingActor, id: string, input: MeetingInput) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    if (m.status !== 'DRAFT' && m.status !== 'SCHEDULED') throw new BadRequestException('该会议状态已不可编辑');

    const data: Record<string, unknown> = {};
    const title = (input.title ?? '').trim();
    if (title) data.title = title;
    const agenda = (input.agenda ?? '').trim();
    if (agenda) data.agenda = agenda;
    if (input.location !== undefined) data.location = (input.location ?? '').trim() || null;
    if (input.scope) {
      if (!MEETING_SCOPES.includes(input.scope.toUpperCase())) throw new BadRequestException('会议层级非法');
      data.scope = input.scope.toUpperCase();
    }
    if (input.type) {
      if (!MEETING_TYPES.includes(input.type.toUpperCase())) throw new BadRequestException('会议类型非法');
      data.type = input.type.toUpperCase();
    }
    // 层级改成活动即按活动处理（类型固定，不接受其它会议类型）
    if (data.scope === 'ACTIVITY') data.type = 'ACTIVITY';
    if (input.importance !== undefined) {
      const im = (input.importance ?? '').toUpperCase();
      if (!MEETING_IMPORTANCE.includes(im)) throw new BadRequestException('重要性非法（只支持 HIGH/MEDIUM/LOW）');
      data.importance = im;
    }
    if (input.deptId !== undefined) data.deptId = input.deptId || null;
    if (input.projectId !== undefined) data.projectId = input.projectId || null;
    if (input.groupConversationId !== undefined) data.groupConversationId = (input.groupConversationId ?? '').trim() || null;
    if (input.groupName !== undefined) data.groupName = (input.groupName ?? '').trim() || null;
    if (input.notifyMode !== undefined) data.notifyMode = this.normNotifyMode(input.notifyMode);
    if (input.minutesWriterId !== undefined) data.minutesWriterId = (await this.normWriter(input.minutesWriterId)) ?? m.ownerId;
    if (input.materialType !== undefined) {
      const mt = (input.materialType ?? 'NONE').toUpperCase();
      data.materialType = mt === 'NONE' ? null : MEETING_MATERIAL_TYPES.includes(mt) ? mt : null;
      if (data.materialType === null) {
        data.materialRequirement = null;
        data.reportPeriodStart = null;
        data.materialDeadline = null;
      }
    }
    if (input.materialRequirement !== undefined) data.materialRequirement = (input.materialRequirement ?? '').trim() || null;

    const startAt = input.startAt ? this.parseDate(input.startAt, '开始时间') : null;
    const endAt = input.endAt ? this.parseDate(input.endAt, '结束时间') : null;
    const ns = startAt ?? m.startAt;
    const ne = endAt ?? m.endAt;
    if (ne.getTime() <= ns.getTime()) throw new BadRequestException('结束时间需晚于开始时间');
    if (startAt) data.startAt = startAt;
    if (endAt) data.endAt = endAt;
    if (input.remindBeforeMinutes !== undefined || startAt || input.remindEnabled !== undefined) {
      const before = Math.min(Math.max(Number(input.remindBeforeMinutes ?? m.remindBeforeMinutes) || 0, 0), 1440);
      const enabled = input.remindEnabled !== undefined ? input.remindEnabled !== false : m.remindEnabled;
      data.remindEnabled = enabled;
      data.remindBeforeMinutes = before;
      data.remindAt = enabled ? new Date(ns.getTime() - before * 60_000) : null;
      data.startNotifiedAt = null; // 改了提醒设置则允许重新提醒
    }
    // 参会人变化：补齐缺失材料行，移出的人保留行（已点评/已提交需留痕），仅同步 participantIds
    if (Array.isArray(input.participantIds)) {
      const ids = Array.from(new Set(input.participantIds.filter(Boolean)));
      if (!ids.includes(me.id)) ids.push(me.id);
      data.participantIds = ids;
    }
    if (data.materialDeadline !== undefined || startAt) data.materialDeadline = (data.materialType ?? m.materialType) ? ne : null;

    await this.prisma.meeting.update({ where: { id: m.id }, data: data as never });
    const fresh = await this.mustFind(m.id);
    await this.upsertMaterials(fresh, fresh.participantIds);
    return this.detail(me, m.id);
  }

  /** 发布：草稿 → 已安排（同时是周期位 autoPilot 的人工开关，见冷启动规则）；首次发布才投递通知，避免重发扰人 */
  async publish(me: MeetingActor, id: string) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    const wasDraft = m.status === 'DRAFT';
    if (wasDraft) {
      await this.prisma.meeting.update({ where: { id }, data: { status: 'SCHEDULED' } });
    }
    if (m.slotId) {
      // 冷启动：负责人亲自发布过一次，以后自动生成的会议直接发群
      await this.prisma.departmentMeetingSlot.updateMany({ where: { id: m.slotId }, data: { autoPilot: true } });
    }
    if (wasDraft) {
      await this.queue.pushSend(id, 'INVITE');
      await this.pullOnPublish(id);
    }
    return { ok: true, autoPilot: !!m.slotId, notified: wasDraft };
  }

  /** 状态流转：开会 / 整理纪要 / 完成（DONE 触发纪要落库与待办确认，见 P0-d） */
  async setStatus(me: MeetingActor, id: string, status: string) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    const s = (status ?? '').toUpperCase();
    if (!MEETING_STATUS.includes(s)) throw new BadRequestException('会议状态非法');
    const allow: Record<string, string[]> = {
      IN_PROGRESS: ['SCHEDULED', 'DRAFT'],
      MINUTING: ['IN_PROGRESS'],
      DONE: ['IN_PROGRESS', 'MINUTING'],
      SCHEDULED: ['DRAFT'],
    };
    if (s !== 'CANCELLED' && !(allow[s] ?? []).includes(m.status)) {
      throw new BadRequestException(`会议当前状态不能流转到 ${s}`);
    }
    await this.prisma.meeting.update({ where: { id }, data: { status: s } });
    return { ok: true, status: s };
  }

  /** 保存会议纪要正文；send=true 同时投递「纪要发群」（AI 生成后人工确认，或手工写纪要后一键发） */
  async saveMinutes(me: MeetingActor, id: string, minutes: string, opts: { send?: boolean } = {}) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    await this.prisma.meeting.update({ where: { id }, data: { minutes, minutesEditedAt: new Date() } });
    const send = !!opts.send && !!minutes?.trim();
    if (send) await this.queue.pushSend(id, 'MINUTES');
    return { ok: true, queued: send };
  }

  /**
   * 手动补发会议通知（仅主持人/管理员）
   * - dryRun=true：只返回将发送的对象与正文，不发送、不置幂等位（验收/预览用）
   * - 真实发送一律投递队列异步执行：dws 子进程逐条发送可达数十秒，不能堵在接口里
   */
  async notify(me: MeetingActor, id: string, kind: string, opts: { dryRun?: boolean; force?: boolean } = {}) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    const k = (kind || 'INVITE').toUpperCase();
    const allow: MeetingNotifyKind[] = ['INVITE', 'GROUP', 'START', 'CANCEL', 'MINUTES', 'MATERIAL', 'WRAP_UP'];
    if (!allow.includes(k as MeetingNotifyKind)) throw new BadRequestException('通知类型非法');
    if (opts.dryRun) return this.reminder.sendOne(id, k as MeetingNotifyKind, { dryRun: true, force: !!opts.force });
    await this.queue.pushSend(id, k);
    return { ok: true, queued: true, kind: k };
  }

  /** 取消会议（软性：保留记录，participant 仍可见「已取消」） */
  async cancel(me: MeetingActor, id: string, reason?: string) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    if (m.status === 'DONE') throw new BadRequestException('已完成的会议不能取消');
    const wasActive = m.status !== 'CANCELLED';
    await this.prisma.meeting.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledReason: (reason ?? '').trim() || null, remindEnabled: false, remindAt: null },
    });
    if (wasActive) await this.queue.pushSend(id, 'CANCEL');
    return { ok: true, notified: wasActive };
  }

  /** 删除会议（软删除，仅发起人/管理员） */
  async remove(me: MeetingActor, id: string) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    await this.prisma.meeting.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }

  // ========== 会前材料聚合与点评（docs/meeting-prd.md §6.2 / §6.4） ==========

  /** 周报正文取值优先级（§6.2）：correctedContent > rawContent > content JSON 结构化拼接 */
  private materialTextFromReport(r: any): string {
    if (!r) return '';
    const fixed = String(r.correctedContent ?? '').trim();
    if (fixed) return fixed;
    const raw = String(r.rawContent ?? '').trim();
    if (raw) return raw;
    const c: any = r.content;
    if (!c || typeof c !== 'object') return '';
    const parts: string[] = [];
    if (c.summary) parts.push(`摘要：${String(c.summary).trim()}`);
    for (const s of Array.isArray(c.sections) ? c.sections : []) {
      const t = String(s?.title ?? '').trim();
      const items = Array.isArray(s?.items)
        ? s.items.map((x: any) => `- ${typeof x === 'string' ? x : String(x?.text ?? x?.content ?? '')}`).filter((l: string) => l.length > 2).join('\n')
        : '';
      if (t || items) parts.push([t, items].filter(Boolean).join('\n'));
    }
    if (c.nextWeek) parts.push(`下周计划：\n${String(c.nextWeek).trim()}`);
    return parts.join('\n\n').trim();
  }

  /**
   * 读取 / 重新读取参会人周报，写成本场会议的材料快照（§6.2）
   * - 快照不跟随后续周报修改；主持人可显式重读刷新（editedContent 为会中人工修改，不会被覆盖）
   * - 读不到 → 标 MISSING 进入缺交催办名单；本人手写材料（MANUAL）不被覆盖
   */
  async readReports(me: MeetingActor, id: string, userIds: string[] = []) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    if (!m.materialType || m.materialType === 'TEXT') throw new BadRequestException('本场会议不要求读取周报/日报作为材料');
    return this.pull(m, userIds);
  }

  /** 发布时自动拉一次周报（失败不阻断发布，只记日志；主持人还可在材料页手动重读） */
  private async pullOnPublish(id: string) {
    try {
      const m = await this.prisma.meeting.findUnique({ where: { id } });
      if (!m || !m.materialType || m.materialType === 'TEXT') return;
      await this.pull(m, []);
    } catch (e) {
      this.logger.warn(`会议发布时自动读取周报失败 meeting=${id}: ${(e as Error).message}`);
    }
  }

  /** 真正拉周报的体（readReports 与发布自动读取共用） */
  private async pull(
    m: {
      id: string;
      title: string;
      materialType: string | null;
      reportPeriodStart: Date | null;
      startAt: Date;
      scope?: string | null;
      projectId?: string | null;
    },
    userIds: string[],
  ) {
    const type = m.materialType === 'REPORT_DAILY' ? ReportType.DAILY : ReportType.WEEKLY;
    const periodStart = m.reportPeriodStart ?? beijingMondayOf(m.startAt);
    const rows = await this.prisma.meetingMaterial.findMany({
      where: { meetingId: m.id, ...(userIds.length ? { userId: { in: userIds } } : {}) },
    });
    let read = 0;
    let missing = 0;
    let kept = 0;
    for (const row of rows) {
      const rep = await this.pickMeetingReport(type, row.userId, periodStart, m.scope, m.projectId);
      const text = this.materialTextFromReport(rep);
      if (rep && text) {
        await this.prisma.meetingMaterial.update({
          where: { id: row.id },
          data: {
            source: 'REPORT',
            reportId: rep.id,
            rawContent: text,
            status: 'SUBMITTED',
            submittedAt: row.submittedAt ?? new Date(),
            refreshedAt: new Date(),
          },
        });
        read += 1;
        continue;
      }
      // 读不到周报：保留已手写提交的材料，其余标缺交
      if (row.source === 'MANUAL' && (row.editedContent || row.rawContent)) {
        kept += 1;
        continue;
      }
      await this.prisma.meetingMaterial.update({ where: { id: row.id }, data: { status: 'MISSING', refreshedAt: new Date() } });
      missing += 1;
    }
    this.logger.log(`会议材料读取完成「${m.title}」来源=${type} 读到 ${read} 人，缺交 ${missing} 人，保留手写 ${kept} 人`);
    return { ok: true, read, missing, kept, periodStart, total: rows.length };
  }

  /**
   * 为会议读取择一份参会人周报：
   * - 周报一律只取个人周报（scopeKey ''）：不再按项目归属区分
   * - 兼容历史周仅有项目/部门归属行：取不到个人则回落当周任一（尽量不误判缺交）
   * - 日报：固定个人（scopeKey ''）
   */
  private async pickMeetingReport(
    type: ReportType,
    ownerId: string,
    periodStart: Date,
    scope?: string | null,
    projectId?: string | null,
  ) {
    if (type === ReportType.DAILY) {
      return this.prisma.report.findUnique({
        where: { type_ownerId_periodStart_scopeKey: { type, ownerId, periodStart, scopeKey: '' } },
      });
    }
    const list = await this.prisma.report.findMany({ where: { type, ownerId, periodStart } });
    const personal = list.find((r) => !r.scopeKey || r.scopeKey === '');
    if (personal) return personal;
    return list[0] ?? null;
  }

  /**
   * 聚合材料直排视图（§6.4）：单页返回全部门正文，不做“点目录逐条查看”
   * - 正文优先级：editedContent（会中修改）> correctedContent（AI 润色）> rawContent（原文快照）
   * - 排序：主持人第一，其余按部门→姓名（中文拼音）
   * - rawContent（原文）只给本人/主持人/管理员，用于「查看原文」
   */
  async materialsView(me: MeetingActor, id: string) {
    const m = await this.mustFind(id);
    await this.assertViewer(me, m);
    const rows = await this.prisma.meetingMaterial.findMany({
      where: { meetingId: id },
      include: {
        user: { select: { id: true, name: true, avatar: true, departmentId: true, department: { select: { name: true } } } },
        reviews: { orderBy: { createdAt: 'asc' }, include: { reviewer: { select: { id: true, name: true } } } },
      },
    });
    const canManage = this.canManage(m, me);
    const sections = rows
      .map((x: any) => {
        const edited = String(x.editedContent ?? '').trim();
        const fixed = String(x.correctedContent ?? '').trim();
        const origin = String(x.rawContent ?? '').trim();
        return {
          id: x.id,
          userId: x.userId,
          name: x.user?.name ?? '已注销用户',
          avatar: x.user?.avatar ?? null,
          departmentName: x.user?.department?.name ?? null,
          status: x.status,
          source: x.source,
          reportId: x.reportId,
          content: edited || fixed || origin,
          isEdited: !!edited,
          rawContent: canManage || x.userId === me.id ? origin : null,
          submittedAt: x.submittedAt,
          refreshedAt: x.refreshedAt,
          isSelf: x.userId === me.id,
          reviews: (x.reviews ?? []).map((rv: any) => ({ id: rv.id, reviewerId: rv.reviewerId, reviewerName: rv.reviewer?.name ?? '', content: rv.content, createdAt: rv.createdAt })),
        };
      })
      .sort((a: any, b: any) => {
        const hostA = a.userId === m.ownerId ? 0 : 1;
        const hostB = b.userId === m.ownerId ? 0 : 1;
        if (hostA !== hostB) return hostA - hostB;
        const d = String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'zh-Hans-CN');
        return d !== 0 ? d : String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
      });
    const submitted = sections.filter((s: any) => s.status === 'SUBMITTED').length;
    const missing = sections.filter((s: any) => s.status === 'MISSING').length;
    return {
      meetingId: id,
      title: m.title,
      status: m.status,
      materialType: m.materialType,
      materialRequirement: m.materialRequirement,
      reportPeriodStart: m.reportPeriodStart,
      materialDeadline: m.materialDeadline,
      canManage,
      canReview: m.ownerId === me.id || hasAtLeast(me.role, Role.DEPT_LEADER),
      total: sections.length,
      submitted,
      missing,
      sections,
    };
  }

  /** 参会人自己提交/更新文字材料（forUserId 仅主持人/管理员可用，用于代交） */
  async submitMaterial(me: MeetingActor, id: string, content: string, forUserId?: string) {
    const m = await this.mustFind(id);
    const target = forUserId && forUserId !== me.id ? forUserId : me.id;
    if (target !== me.id) this.assertManager(me, m);
    else await this.assertViewer(me, m);
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('请填写材料内容');
    if (target !== me.id && !m.participantIds.includes(target)) throw new BadRequestException('该人不在参会名册');
    const row = await this.prisma.meetingMaterial.upsert({
      where: { meetingId_userId: { meetingId: id, userId: target } },
      update: { source: 'MANUAL', rawContent: text, editedContent: null, status: 'SUBMITTED', submittedAt: new Date(), reportId: null },
      create: { meetingId: id, userId: target, source: 'MANUAL', rawContent: text, status: 'SUBMITTED', submittedAt: new Date() },
    });
    // 不在名册的人提了材料就顺便拉进来，否则缺交名单永远消不掉
    if (!m.participantIds.includes(target)) {
      await this.prisma.meeting.update({ where: { id }, data: { participantIds: [...m.participantIds, target] } });
    }
    this.logger.log(`会议材料已提交「${m.title}」user=${target} 字数=${text.length}`);
    return { ok: true, id: row.id, status: row.status };
  }

  /** 会中修改某人材料正文（F9）：写 editedContent，rawContent 保留可查原文 */
  async editMaterial(me: MeetingActor, materialId: string, content: string) {
    const row = await this.prisma.meetingMaterial.findUnique({ where: { id: materialId }, include: { meeting: true } });
    if (!row?.meeting || row.meeting.deletedAt) throw new NotFoundException('材料不存在');
    this.assertManager(me, row.meeting);
    const text = (content ?? '').trim();
    await this.prisma.meetingMaterial.update({ where: { id: materialId }, data: { editedContent: text || null } });
    return { ok: true, edited: !!text };
  }

  /** 点评材料（F8）：独立留痕，不覆盖原文；主持人及以上或部门负责人可用 */
  async addReview(me: MeetingActor, materialId: string, content: string) {
    const row = await this.prisma.meetingMaterial.findUnique({ where: { id: materialId }, include: { meeting: true } });
    if (!row?.meeting || row.meeting.deletedAt) throw new NotFoundException('材料不存在');
    const m = row.meeting;
    await this.assertViewer(me, m);
    if (!(m.ownerId === me.id || hasAtLeast(me.role, Role.DEPT_LEADER))) throw new ForbiddenException('仅主持人或部门负责人可点评材料');
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('点评内容不能为空');
    const rv = await this.prisma.meetingReview.create({
      data: { meetingId: m.id, materialId, reviewerId: me.id, content: text.slice(0, 2000) },
    });
    return { ok: true, id: rv.id, reviewerName: me.name, content: rv.content, createdAt: rv.createdAt };
  }

  /** 删除自己的点评（主持人/管理员可删任意一条，保留已发群纪要不受影响） */
  async deleteReview(me: MeetingActor, reviewId: string) {
    const rv = await this.prisma.meetingReview.findUnique({ where: { id: reviewId }, include: { meeting: true } });
    if (!rv?.meeting || rv.meeting.deletedAt) throw new NotFoundException('点评不存在');
    if (!(rv.reviewerId === me.id || this.canManage(rv.meeting, me))) throw new ForbiddenException('只能删除自己的点评');
    await this.prisma.meetingReview.delete({ where: { id: reviewId } });
    return { ok: true };
  }

  // ========== 会议活动考勤 / 点赞 / 文档（签到二维码、补签、活跃度） ==========

  /** 自主签到：会议开始时刻起 1 小时内，参会人本人操作（发起人视为参会） */
  async checkin(me: MeetingActor, id: string) {
    return this.recordSelfCheckin(me, id, { windowMs: CHECKIN_WINDOW_MS, rosterRequired: true });
  }

  /**
   * 团队公告卡片打卡：登录后就能打，窗口放宽到开始后 3 天，且不要求在参会名册内。
   * 名册外的人打过卡就补进 participantIds——口径与补签、活动对外签到一致（到场即应到，否则应到与实到永远对不上）。
   */
  async boardCheckin(me: MeetingActor, id: string) {
    return this.recordSelfCheckin(me, id, { windowMs: BOARD_CHECKIN_WINDOW_MS, rosterRequired: false });
  }

  /** 自主签到的统一实现：只有「窗口长度」与「是否要求名册」两处口径不同，其余（幂等、留痕、活跃度累加）完全共用 */
  private async recordSelfCheckin(
    me: MeetingActor,
    id: string,
    opts: { windowMs: number; rosterRequired: boolean },
  ) {
    const m = await this.mustFind(id);
    if (m.status === 'CANCELLED') throw new BadRequestException('会议活动已取消，无法签到');
    if (m.status === 'DRAFT') throw new BadRequestException('会议活动尚未发布，无法签到');
    // 看不到完整内容的人不能到场：部门会只给本部门、项目会只给项目组、公司会只给部门负责人 / 共管人，活动全员
    await this.assertViewer(me, m);
    const isParticipant = m.participantIds.includes(me.id) || m.ownerId === me.id;
    if (opts.rosterRequired && !isParticipant) throw new ForbiddenException('你不在本场会议活动的参会名册中');
    const now = new Date();
    if (now.getTime() < m.startAt.getTime()) {
      throw new BadRequestException(`签到未开始：${fmtBeijing(m.startAt).slice(0, 16)} 开始后可自主签到`);
    }
    const windowEnd = new Date(m.startAt.getTime() + opts.windowMs);
    if (now.getTime() > windowEnd.getTime()) {
      throw new BadRequestException(
        opts.rosterRequired
          ? '自主签到已截止（开始后 1 小时内），请联系发起人、管理员或部门主管补签'
          : `打卡已截止（开始后 ${Math.round(opts.windowMs / 86400000)} 天内可打），请联系发起人或管理员补签`,
      );
    }
    const exists = await this.prisma.meetingAttendance.findUnique({ where: { meetingId_userId: { meetingId: id, userId: me.id } } });
    if (exists) return { ok: true, already: true, method: exists.method, checkedAt: exists.checkedAt };
    if (!isParticipant) {
      await this.prisma.meeting.update({
        where: { id },
        data: { participantIds: Array.from(new Set([...(m.participantIds ?? []), me.id])) },
      });
    }
    const row = await this.prisma.meetingAttendance.create({
      data: { meetingId: id, userId: me.id, method: 'SELF', checkedAt: now },
    });
    this.logger.log(`${opts.rosterRequired ? '会议活动自主签到' : '团队公告打卡'}「${m.title}」user=${me.name}`);
    return { ok: true, already: false, id: row.id, method: row.method, checkedAt: row.checkedAt };
  }

  /**
   * 补签 / 代签：发起人 / 管理员 / 本场助教 / 对方所在部门（主 ∪ 额外，含共管人）管理者操作。
   * 不在参会名册的人被补签就视为实际到场，顺便写进 participantIds：否则「应到」与「实到」永远对不上。
   * 理由可以不传：矩阵点选走自动文案（窗口内=代签，窗口外=补签），逐行 prompt 仍可写真实理由。
   */
  async makeupCheckin(me: MeetingActor, id: string, userId: string, reason?: string) {
    const m = await this.mustFind(id);
    if (m.status === 'CANCELLED') throw new BadRequestException('会议活动已取消，无需补签');
    if (m.status === 'DRAFT') throw new BadRequestException('会议活动尚未发布，无法签到');
    const targetId = (userId ?? '').trim();
    if (!targetId) throw new BadRequestException('请选择要补签的成员');
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true, name: true, active: true } });
    if (!target) throw new BadRequestException('该成员不存在');
    if (!target.active) throw new BadRequestException('该成员已停用，不能补签');
    const allowed = await this.canMakeupFor(me, m, targetId);
    if (!allowed) throw new ForbiddenException('仅会议发起人、管理员、本场助教或对方所在部门主管可补签');
    const exists = await this.prisma.meetingAttendance.findUnique({ where: { meetingId_userId: { meetingId: id, userId: targetId } } });
    if (exists) throw new BadRequestException('该成员已签到，无需补签');
    const windowEnd = new Date(m.startAt.getTime() + CHECKIN_WINDOW_MS);
    const inWindow = Date.now() <= windowEnd.getTime();
    const text = (reason ?? '').trim() || (inWindow ? '管理员代签（签到窗口内）' : '管理员矩阵补签');
    const autoAdded = !m.participantIds.includes(targetId) && targetId !== m.ownerId;
    const row = await this.prisma.meetingAttendance.create({
      data: { meetingId: id, userId: targetId, method: 'MAKEUP', reason: text.slice(0, 500), operatorId: me.id, checkedAt: new Date() },
    });
    if (autoAdded) await this.prisma.meeting.update({ where: { id }, data: { participantIds: { push: targetId } } });
    this.logger.log(`会议活动补签「${m.title}」target=${targetId} by=${me.name} 理由=${text.slice(0, 40)} autoAdded=${autoAdded}`);
    return { ok: true, id: row.id, method: row.method, checkedAt: row.checkedAt, autoAdded };
  }

  /**
   * 全员补签矩阵的取数：全体在职成员 + 本场签到状态 + 逐人「我能不能给他签」。
   * 拼音排序不在这里做（浏览器 ICU 才可靠，容器 Node 不一定），只给个按姓名的稳定初序。
   */
  async checkinCandidates(me: MeetingActor, id: string) {
    const m = await this.mustFind(id);
    await this.assertViewer(me, m);
    const [users, attendances, ledDepts] = await Promise.all([
      this.prisma.user.findMany({
        where: { active: true },
        select: {
          id: true,
          name: true,
          avatar: true,
          role: true,
          departmentId: true,
          department: { select: { name: true } },
          extraDepartments: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.meetingAttendance.findMany({ where: { meetingId: m.id }, include: { operator: { select: { name: true } } } }),
      this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } }),
    ]);
    if (!this.canMakeupAny(me, m, ledDepts)) throw new ForbiddenException('仅会议发起人、管理员、本场助教或部门主管可使用全员补签');
    const allAccess = m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN) || (m.assistantIds ?? []).includes(me.id);
    const ledDeptIds = new Set(ledDepts.map((d) => d.id));
    const attMap = new Map(attendances.map((a) => [a.userId, a]));
    const now = new Date();
    const windowEnd = new Date(m.startAt.getTime() + CHECKIN_WINDOW_MS);
    const closed = m.status === 'CANCELLED' || m.status === 'DRAFT';
    const items = users.map((u: any) => {
      const a: any = attMap.get(u.id);
      const uDeptIds = [u.departmentId, ...(u.extraDepartments ?? []).map((d: any) => d.id)].filter((x): x is string => !!x);
      const departmentNames = [u.department?.name, ...(u.extraDepartments ?? []).map((d: any) => d.name)].filter((x): x is string => !!x);
      return {
        userId: u.id,
        name: u.name,
        avatar: u.avatar ?? null,
        role: u.role,
        departmentNames,
        checked: !!a,
        method: a?.method ?? null,
        checkedAt: a?.checkedAt ?? null,
        operatorName: a?.operator?.name ?? null,
        reason: a?.reason ?? null,
        // 原名册里有没有他：前端给名册外的人打「+入册」角标，点下去才知道会改变参会人数
        inRoster: m.participantIds.includes(u.id) || u.id === m.ownerId,
        canMakeup: !a && !closed && (allAccess || uDeptIds.some((d) => ledDeptIds.has(d))),
      };
    });
    return {
      meetingId: m.id,
      title: m.title,
      status: m.status,
      windowStart: m.startAt,
      windowEnd,
      selfOpen: now.getTime() >= m.startAt.getTime() && now.getTime() <= windowEnd.getTime(),
      checked: attendances.length,
      rosterCount: m.participantIds.length,
      total: items.length,
      canMakeupAny: true,
      items,
    };
  }

  /** 能否使用全员补签矩阵：发起人 / 管理员 / 本场助教 / 任一部门（负责人或共管人）的管理者 */
  private canMakeupAny(me: MeetingActor, m: { ownerId: string; assistantIds?: string[] }, ledDepts: { id: string }[]) {
    return m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN) || (m.assistantIds ?? []).includes(me.id) || ledDepts.length > 0;
  }

  /** 撤销考勤（误签/误补签，仅发起人/管理员） */
  async removeAttendance(me: MeetingActor, id: string, userId: string) {
    const m = await this.mustFind(id);
    this.assertManager(me, m);
    await this.prisma.meetingAttendance.deleteMany({ where: { meetingId: id, userId } });
    return { ok: true };
  }

  /** 会中表现点赞：发起人 / 管理员 / 本场助教；理由可选；同一人对同一人一场一次（重复提交即更新理由） */
  async addPraise(me: MeetingActor, id: string, userId: string, reason?: string) {
    const m = await this.mustFind(id);
    const canPraise = m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN) || (m.assistantIds ?? []).includes(me.id);
    if (!canPraise) throw new ForbiddenException('仅会议发起人、管理员或本场助教可点赞');
    const targetId = (userId ?? '').trim();
    if (!targetId) throw new BadRequestException('请选择要点赞的成员');
    if (!m.participantIds.includes(targetId)) throw new BadRequestException('该成员不在参会名册');
    if (targetId === me.id) throw new BadRequestException('不能给自己点赞');
    const text = (reason ?? '').trim();
    const row = await this.prisma.meetingPraise.upsert({
      where: { meetingId_userId_praiserId: { meetingId: id, userId: targetId, praiserId: me.id } },
      update: { reason: text ? text.slice(0, 300) : null },
      create: { meetingId: id, userId: targetId, praiserId: me.id, reason: text ? text.slice(0, 300) : null },
    });
    return { ok: true, id: row.id };
  }

  /** 撤销点赞（本人或发起人/管理员） */
  async removePraise(me: MeetingActor, praiseId: string) {
    const row = await this.prisma.meetingPraise.findUnique({ where: { id: praiseId }, include: { meeting: true } });
    if (!row?.meeting || row.meeting.deletedAt) throw new NotFoundException('点赞记录不存在');
    if (!(row.praiserId === me.id || this.canManage(row.meeting, me))) throw new ForbiddenException('只能撤销自己给出的点赞');
    await this.prisma.meetingPraise.delete({ where: { id: praiseId } });
    return { ok: true };
  }

  /** 保存会议/活动文档的在线文字记录（参会成员均可编辑，记录最后编辑人） */
  async saveDoc(me: MeetingActor, id: string, text: string) {
    const m = await this.mustFind(id);
    await this.assertDocEditor(me, m);
    const body = (text ?? '').trim();
    await this.prisma.meeting.update({
      where: { id },
      data: { docText: body || null, docUpdatedAt: new Date(), docUpdatedById: me.id },
    });
    return { ok: true, docText: body, docUpdatedAt: new Date() };
  }

  /** 上传会议/活动文档附件（参会成员均可上传） */
  async addFile(me: MeetingActor, id: string, file: { buffer: Buffer; originalname: string; mimetype: string; size: number }) {
    const m = await this.mustFind(id);
    await this.assertDocEditor(me, m);
    if (!file?.buffer?.length) throw new BadRequestException('请选择要上传的文件');
    const att: any = await this.files.upload({
      file: file.buffer,
      fileName: this.decodeFileName(file.originalname),
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      uploaderId: me.id,
      meetingId: id,
    });
    return { ok: true, id: att.id, fileName: att.fileName, url: att.url };
  }

  /** 删除文档附件（上传人 / 发起人 / 管理员） */
  async removeFile(me: MeetingActor, fileId: string) {
    const att = await this.prisma.attachment.findUnique({ where: { id: fileId } });
    if (!att?.meetingId) throw new NotFoundException('附件不存在');
    const m = await this.mustFind(att.meetingId);
    if (!(att.uploaderId === me.id || this.canManage(m, me))) throw new ForbiddenException('仅上传人或发起人可删除附件');
    await this.files.remove(att.fileKey);
    return { ok: true };
  }

  /** 文档编辑权：参会名册成员 / 发起人 / 管理员 */
  private async assertDocEditor(me: MeetingActor, m: Awaited<ReturnType<MeetingService['mustFind']>>) {
    await this.assertViewer(me, m);
    if (m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN)) return;
    if (m.participantIds.includes(me.id)) return;
    throw new ForbiddenException('仅参会成员可编辑本场会议活动文档');
  }

  /** 能否为某人补签：发起人 / 管理员 / 本场助教 / 对方所在部门（含额外部门）的管理者（负责人 ∪ 共管人） */
  private async canMakeupFor(me: MeetingActor, m: { ownerId: string; assistantIds: string[] }, targetUserId: string) {
    if (m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN)) return true;
    if ((m.assistantIds ?? []).includes(me.id)) return true;
    return this.leadsTargetDept(me.id, targetUserId);
  }

  /** 我是否管着「该用户所在的某个部门」：主部门 ∪ 额外部门都算，负责人与共管人同权限 */
  private async leadsTargetDept(meId: string, targetUserId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { departmentId: true, extraDepartments: { select: { id: true } } },
    });
    const ids = [
      ...new Set([target?.departmentId, ...(target?.extraDepartments ?? []).map((d) => d.id)].filter((x): x is string => Boolean(x))),
    ];
    if (!ids.length) return false;
    return (await this.prisma.department.count({ where: { id: { in: ids }, ...ledDeptWhere(meId) } })) > 0;
  }

  /** 活跃度汇总：参加次数 × 重要性权重（高 3 / 中 2 / 低 1） */
  private summarizeAttendance(rows: Array<{ method: string; meeting: { type: string; importance: string } }>) {
    let score = 0;
    let activityCount = 0;
    let meetingCount = 0;
    let selfCount = 0;
    let makeupCount = 0;
    for (const r of rows) {
      score += IMPORTANCE_SCORE[String(r.meeting?.importance ?? 'MEDIUM').toUpperCase()] ?? IMPORTANCE_SCORE.MEDIUM;
      if (r.meeting?.type === 'ACTIVITY') activityCount += 1;
      else meetingCount += 1;
      if (r.method === 'MAKEUP') makeupCount += 1;
      else selfCount += 1;
    }
    return { score, attended: rows.length, activityCount, meetingCount, selfCount, makeupCount };
  }

  /** 我的活跃度与近期出勤 */
  async myStats(me: MeetingActor) {
    const rows = await this.prisma.meetingAttendance.findMany({
      where: { userId: me.id, meeting: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } } },
      include: { meeting: { select: { id: true, title: true, type: true, importance: true, startAt: true } } },
      orderBy: { checkedAt: 'desc' },
      take: 500,
    });
    const praiseCount = await this.prisma.meetingPraise.count({ where: { userId: me.id, meeting: { deletedAt: null } } });
    const summary = this.summarizeAttendance(rows as any);
    return {
      ...summary,
      praiseCount,
      recent: rows.slice(0, 8).map((r: any) => ({
        meetingId: r.meetingId,
        title: r.meeting?.title ?? '',
        type: r.meeting?.type ?? '',
        importance: r.meeting?.importance ?? 'MEDIUM',
        startAt: r.meeting?.startAt ?? null,
        method: r.method,
        checkedAt: r.checkedAt,
        score: IMPORTANCE_SCORE[String(r.meeting?.importance ?? 'MEDIUM').toUpperCase()] ?? IMPORTANCE_SCORE.MEDIUM,
      })),
    };
  }

  /** 某人全部参加过的会议活动 + 出勤概况（本人 / 管理员 / 其部门管理者（含共管人）可看） */
  async memberStats(me: MeetingActor, userId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true, departmentId: true, department: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException('成员不存在');
    if (target.id !== me.id && !hasAtLeast(me.role, Role.ADMIN)) {
      if (!(await this.leadsTargetDept(me.id, userId))) throw new ForbiddenException('无权查看该成员的考勤明细');
    }
    const rows = await this.prisma.meetingAttendance.findMany({
      where: { userId, meeting: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } } },
      include: {
        meeting: { select: { id: true, title: true, type: true, importance: true, startAt: true, scope: true } },
        operator: { select: { id: true, name: true } },
      },
      orderBy: { checkedAt: 'desc' },
      take: 500,
    });
    const praises = await this.prisma.meetingPraise.findMany({
      where: { userId, meeting: { deletedAt: null } },
      include: { praiser: { select: { name: true } }, meeting: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const expected = await this.prisma.meeting.count({
      where: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] }, participantIds: { has: userId } },
    });
    const summary = this.summarizeAttendance(rows as any);
    return {
      user: target,
      expected,
      missed: Math.max(expected - summary.attended, 0),
      praiseCount: praises.length,
      ...summary,
      items: rows.map((r: any) => ({
        meetingId: r.meetingId,
        title: r.meeting?.title ?? '',
        type: r.meeting?.type ?? '',
        importance: r.meeting?.importance ?? 'MEDIUM',
        startAt: r.meeting?.startAt ?? null,
        method: r.method,
        checkedAt: r.checkedAt,
        reason: r.reason,
        operatorName: r.operator?.name ?? null,
        score: IMPORTANCE_SCORE[String(r.meeting?.importance ?? 'MEDIUM').toUpperCase()] ?? IMPORTANCE_SCORE.MEDIUM,
      })),
      praises: praises.map((p: any) => ({
        id: p.id,
        meetingId: p.meetingId,
        meetingTitle: p.meeting?.title ?? '',
        praiserName: p.praiser?.name ?? '',
        reason: p.reason,
        createdAt: p.createdAt,
      })),
    };
  }

  /** 全组织出勤与活跃度总览（管理员全量；部门管理者（负责人 ∪ 共管人）只看自己所管辖的部门） */
  async attendanceOverview(me: MeetingActor, q: { from?: string; to?: string; deptId?: string }) {
    if (!hasAtLeast(me.role, Role.DEPT_LEADER)) throw new ForbiddenException('仅管理员/部门负责人可查看考勤统计');
    const isAdmin = hasAtLeast(me.role, Role.ADMIN);
    const led = await this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } });
    const ledIds = led.map((d) => d.id);
    let deptFilter: string[] | null = isAdmin ? null : ledIds;
    const deptId = (q.deptId ?? '').trim();
    if (deptId) {
      if (!isAdmin && !ledIds.includes(deptId)) throw new ForbiddenException('只能查看自己负责部门的考勤');
      deptFilter = [deptId];
    }
    if (!isAdmin && !(deptFilter ?? []).length) throw new ForbiddenException('你尚未担任部门负责人，没有可查看的考勤范围');

    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 90 * 86400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('时间范围非法');

    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        ...(deptFilter
          ? { OR: [{ departmentId: { in: deptFilter } }, { extraDepartments: { some: { id: { in: deptFilter } } } }] }
          : {}),
      },
      select: { id: true, name: true, role: true, departmentId: true, department: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    const meetings = await this.prisma.meeting.findMany({
      where: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] }, startAt: { gte: from, lte: to } },
      select: { id: true, title: true, type: true, importance: true, participantIds: true, startAt: true },
      orderBy: { startAt: 'desc' },
    });
    const meetingMap = new Map(meetings.map((m) => [m.id, m]));
    const expected = new Map<string, number>();
    for (const mt of meetings) {
      for (const uid of mt.participantIds) expected.set(uid, (expected.get(uid) ?? 0) + 1);
    }
    const atts = meetings.length
      ? await this.prisma.meetingAttendance.findMany({
          where: { meetingId: { in: meetings.map((m) => m.id) } },
          select: { meetingId: true, userId: true, method: true, checkedAt: true },
        })
      : [];
    const byUser = new Map<string, Array<{ method: string; meeting: { type: string; importance: string } }>>();
    for (const a of atts) {
      const mt = meetingMap.get(a.meetingId);
      if (!mt) continue;
      const list = byUser.get(a.userId) ?? [];
      list.push({ method: a.method, meeting: { type: mt.type, importance: mt.importance } });
      byUser.set(a.userId, list);
    }
    const rows = users.map((u) => {
      const summary = this.summarizeAttendance(byUser.get(u.id) ?? []);
      const exp = expected.get(u.id) ?? 0;
      return {
        userId: u.id,
        name: u.name,
        role: u.role,
        departmentName: u.department?.name ?? null,
        expected: exp,
        ...summary,
        missed: Math.max(exp - summary.attended, 0),
        rate: exp ? Math.round((summary.attended / exp) * 100) : 0,
      };
    });
    rows.sort((a, b) => b.score - a.score || b.attended - a.attended || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const totalScore = rows.reduce((s, r) => s + r.score, 0);
    const totalAttended = rows.reduce((s, r) => s + r.attended, 0);
    const totalExpected = rows.reduce((s, r) => s + r.expected, 0);
    return {
      from,
      to,
      meetings: meetings.length,
      activityMeetings: meetings.filter((m) => m.type === 'ACTIVITY').length,
      memberCount: rows.length,
      totalAttended,
      totalExpected,
      avgScore: rows.length ? Math.round((totalScore / rows.length) * 10) / 10 : 0,
      rows,
    };
  }

  /** 层级模板：返回发起表单的预填值（名称/时间/参会人/材料要求/钉钉群）
   * weekday/time 用于「按周期位推算下次开会时间」，前端据此填 startAt
   */
  async template(me: MeetingActor, opts: { scope?: string; deptId?: string; projectId?: string; weekday?: number; time?: string }) {
    const scope = (opts.scope ?? 'PERSONAL').toUpperCase();
    const now = new Date();
    if (scope === 'DEPT' || scope === 'COMPANY') {
      const deptIdForScope = scope === 'COMPANY' ? null : opts.deptId ?? me.departmentId ?? null;
      const slots = await this.slotsFor(scope === 'COMPANY' ? null : deptIdForScope, scope);
      const active = slots.find((s) => s.active) ?? slots[0];
      const participantIds = await this.resolveParticipants(scope, { me, deptId: active?.departmentId ?? null, projectId: null }, undefined);
      // slot 未带群时回退到「关联群配置」的默认群（公司=Setting；部门=Department 独立列）
      const slotGroup = active?.groupConversationId ?? null;
      const def = slotGroup ? null : await this.defaultGroupFor(scope, active?.departmentId ?? deptIdForScope);
      return {
        title: this.defaultTitle(scope, active?.name, now),
        type: 'WEEKLY',
        materialType: active?.materialType ?? 'REPORT_WEEKLY',
        materialRequirement: '',
        groupConversationId: slotGroup ?? def?.conversationId ?? null,
        groupName: slotGroup ? (active?.groupName ?? null) : (def?.name ?? null),
        slotId: active?.id ?? null,
        deptId: active?.departmentId ?? null,
        weekday: active?.weekday ?? null,
        time: active?.time ?? null,
        durationMinutes: active?.durationMinutes ?? 60,
        remindBeforeMinutes: active?.remindBeforeMinutes ?? 0,
        participantIds,
        autoPilot: !!active?.autoPilot,
        slots,
      };
    }
    if (scope === 'ACTIVITY') {
      // 活动：现在不必按周期位排期，默认两小时、不要求会前材料，参会人取本部门（没部门就自己）
      const deptId = opts.deptId ?? me.departmentId ?? null;
      const ids = await this.resolveParticipants('DEPT', { me, deptId }, undefined);
      return {
        title: '',
        type: 'ACTIVITY',
        materialType: 'NONE',
        materialRequirement: '',
        groupConversationId: null,
        groupName: null,
        deptId,
        durationMinutes: 120,
        remindBeforeMinutes: 0,
        participantIds: Array.from(new Set([me.id, ...ids])),
        slots: [],
      };
    }
    if (scope === 'PROJECT') {
      const p = opts.projectId ? await this.prisma.project.findUnique({ where: { id: opts.projectId }, include: { members: true } }) : null;
      return {
        title: p ? `${p.name} 项目会议` : '项目会议',
        type: 'PROJECT',
        materialType: 'NONE',
        materialRequirement: '',
        groupConversationId: p?.dingtalkConversationId ?? null,
        groupName: p?.dingtalkGroupName ?? null,
        projectId: p?.id ?? opts.projectId ?? null,
        durationMinutes: 60,
        remindBeforeMinutes: 0,
        participantIds: p ? Array.from(new Set([p.ownerId, ...p.members.map((m: any) => m.userId)])) : [me.id],
        slots: [],
      };
    }
    return {
      title: this.defaultTitle('PERSONAL', null, now),
      type: 'OTHER',
      materialType: 'NONE',
      materialRequirement: '',
      groupConversationId: null,
      groupName: null,
      durationMinutes: 60,
      remindBeforeMinutes: 0,
      participantIds: [me.id],
      slots: [],
    };
  }

  /** 可选钉钉群：各项目关联的群（去重），供发起表单下拉 */
  async groupOptions(me: MeetingActor) {
    const projects = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        dingtalkConversationId: { not: null },
        ...(hasAtLeast(me.role, Role.ADMIN) ? {} : { OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] }),
      },
      select: { id: true, name: true, dingtalkConversationId: true, dingtalkGroupName: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const map = new Map<string, { conversationId: string; groupName: string; projectNames: string[] }>();
    for (const p of projects) {
      const cid = p.dingtalkConversationId!;
      const cur = map.get(cid) ?? { conversationId: cid, groupName: p.dingtalkGroupName || cid, projectNames: [] };
      cur.projectNames.push(p.name);
      map.set(cid, cur);
    }
    // 部门周期位上的群也纳入候选
    const slots = await this.prisma.departmentMeetingSlot.findMany({
      where: { deletedAt: null, groupConversationId: { not: null } },
      select: { groupConversationId: true, groupName: true, department: { select: { name: true } } },
      take: 100,
    });
    for (const s of slots) {
      const cid = s.groupConversationId!;
      if (!map.has(cid)) map.set(cid, { conversationId: cid, groupName: s.groupName || cid, projectNames: [] });
    }
    // 部门「关联群配置」的默认群也纳入候选，保证发起表单下拉能显示预填群名
    const depts = await this.prisma.department.findMany({
      where: { meetingGroupConversationId: { not: null } },
      select: { meetingGroupConversationId: true, meetingGroupName: true, name: true },
      take: 200,
    });
    for (const d of depts) {
      const cid = d.meetingGroupConversationId!;
      if (!map.has(cid)) map.set(cid, { conversationId: cid, groupName: d.meetingGroupName || cid, projectNames: [] });
    }
    // 公司默认群
    const comp = await this.defaultGroupFor('COMPANY', null);
    if (comp && !map.has(comp.conversationId)) map.set(comp.conversationId, { conversationId: comp.conversationId, groupName: comp.name || comp.conversationId, projectNames: [] });
    return Array.from(map.values());
  }

  /** 读「关联群配置」默认群：COMPANY=Setting('meeting.group.company')；DEPT=Department 独立列 */
  async defaultGroupFor(scope: string, deptId: string | null): Promise<{ conversationId: string; name: string | null } | null> {
    if (scope === 'COMPANY') {
      const s = await this.prisma.setting.findUnique({ where: { key: 'meeting.group.company' } });
      const v = s?.value as { conversationId?: string; name?: string } | null;
      return v?.conversationId ? { conversationId: v.conversationId, name: v.name ?? null } : null;
    }
    if (scope === 'DEPT' && deptId) {
      const d = await this.prisma.department.findUnique({ where: { id: deptId }, select: { meetingGroupConversationId: true, meetingGroupName: true } });
      return d?.meetingGroupConversationId ? { conversationId: d.meetingGroupConversationId, name: d.meetingGroupName ?? null } : null;
    }
    return null;
  }

  /** 关联群配置读取：管理员看公司+全部部门；部门管理者（含共管人）只看本人所管辖的部门 */
  async groupConfig(me: MeetingActor) {
    const isAdmin = hasAtLeast(me.role, Role.ADMIN);
    const company = await this.defaultGroupFor('COMPANY', null);
    const depts = await this.prisma.department.findMany({
      where: isAdmin ? {} : ledDeptWhere(me.id),
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, meetingGroupConversationId: true, meetingGroupName: true },
    });
    return {
      canManageCompany: isAdmin,
      company: company ? { conversationId: company.conversationId, name: company.name } : { conversationId: null, name: null },
      departments: depts.map((d) => ({ id: d.id, name: d.name, conversationId: d.meetingGroupConversationId, groupName: d.meetingGroupName })),
    };
  }

  /** 设置公司会议默认群（仅管理员；conversationId 为空即清除） */
  async saveCompanyGroup(body: { conversationId?: string | null; name?: string | null }) {
    const conversationId = (body?.conversationId ?? '').trim() || null;
    const name = (body?.name ?? '').trim() || null;
    const value = conversationId ? { conversationId, name } : { conversationId: null, name: null };
    await this.prisma.setting.upsert({ where: { key: 'meeting.group.company' }, create: { key: 'meeting.group.company', value: value as any }, update: { value: value as any } });
    return { ok: true, company: value };
  }

  /** 设置某部门会议默认群（管理员或该部门管理者（负责人 ∪ 共管人）；conversationId 为空即清除） */
  async saveDeptGroup(me: MeetingActor, deptId: string, body: { conversationId?: string | null; name?: string | null }) {
    const dept = await this.prisma.department.findUnique({ where: { id: deptId }, select: { id: true, leaderId: true, managerIds: true } });
    if (!dept) throw new NotFoundException('部门不存在');
    if (!hasAtLeast(me.role, Role.ADMIN) && !isDeptAuthority(dept, me.id)) throw new ForbiddenException('仅部门负责人或管理员可配置该部门的会议关联群');
    const conversationId = (body?.conversationId ?? '').trim() || null;
    const name = (body?.name ?? '').trim() || null;
    await this.prisma.department.update({ where: { id: deptId }, data: { meetingGroupConversationId: conversationId, meetingGroupName: conversationId ? name : null } });
    return { ok: true, deptId, conversationId, name };
  }

  // ============ 内部工具 ============

  async mustFind(id: string) {
    const m = await this.prisma.meeting.findFirst({ where: { id, deletedAt: null } });
    if (!m) throw new NotFoundException('会议不存在');
    return m;
  }

  /**
   * 我的可见性上下文：部门（主 ∪ 额外）、项目组（成员 ∪ 我负责的）、我管辖的部门（负责人 ∪ 共管人）。
   * 列表要逐行判权限，所以一次查好放内存，不给每行发查询。
   */
  private async visibilityCtx(me: MeetingActor): Promise<MeetingVisibilityCtx> {
    const [self, inProjects, ledDepts] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: me.id },
        select: { departmentId: true, extraDepartments: { select: { id: true } } },
      }),
      this.prisma.project.findMany({
        where: { OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
        select: { id: true },
      }),
      this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } }),
    ]);
    const deptIds = new Set<string>();
    if (me.departmentId) deptIds.add(me.departmentId);
    if (self?.departmentId) deptIds.add(self.departmentId);
    for (const d of self?.extraDepartments ?? []) deptIds.add(d.id);
    return {
      deptIds,
      projectIds: new Set(inProjects.map((p) => p.id)),
      ledDeptIds: new Set(ledDepts.map((d) => d.id)),
      isAdmin: hasAtLeast(me.role, Role.ADMIN),
    };
  }

  /** 活动与会议是两个对等入口：层级或类型任一为 ACTIVITY 即按活动处理 */
  private isActivityRow(m: { type?: string | null; scope?: string | null }) {
    return (m.type ?? '').toUpperCase() === 'ACTIVITY' || (m.scope ?? '').toUpperCase() === 'ACTIVITY';
  }

  /**
   * 完整信息可见性：基本信息（标题/时间/地点/发起人/状态/签到人数）人人可看，内容面按层级收紧——
   *   活动 → 全员；DEPT → 该部门成员（主 ∪ 额外）与该部门负责人/共管人；
   *   PROJECT → 该项目组（成员 ∪ 项目负责人，含「其他关联项目」）；
   *   COMPANY → 任一部门的负责人或共管人；PERSONAL 及其余 → 只有发起人与名册内的人。
   * 发起人、管理员、名册内参会人、本场助教在任何层级都可见：他们本来就是被叫来的人。
   */
  private fullAccessFor(me: MeetingActor, m: MeetingAccessRow, ctx: MeetingVisibilityCtx): boolean {
    if (ctx.isAdmin || m.ownerId === me.id) return true;
    if ((m.participantIds ?? []).includes(me.id) || (m.assistantIds ?? []).includes(me.id)) return true;
    if (this.isActivityRow(m)) return true;
    const scope = (m.scope ?? '').toUpperCase();
    if (scope === 'DEPT') {
      return !!m.deptId && (ctx.deptIds.has(m.deptId) || ctx.ledDeptIds.has(m.deptId));
    }
    if (scope === 'PROJECT') {
      const ids = [m.projectId, ...(m.extraProjectIds ?? [])].filter((x): x is string => !!x);
      return ids.some((id) => ctx.projectIds.has(id));
    }
    if (scope === 'COMPANY') return ctx.ledDeptIds.size > 0 || hasAtLeast(me.role, Role.DEPT_LEADER);
    return false;
  }

  /** 锁提示：告诉用户「谁能看」，别只留一个看不懂的锁 */
  private lockHint(m: MeetingAccessRow, names: { departmentName?: string | null; projectName?: string | null }) {
    if (this.isActivityRow(m)) return '';
    const scope = (m.scope ?? '').toUpperCase();
    if (scope === 'DEPT') {
      return names.departmentName ? `部门会议 · 仅「${names.departmentName}」成员可查看完整内容` : '部门会议 · 仅该部门成员可查看完整内容';
    }
    if (scope === 'PROJECT') {
      return names.projectName ? `项目会议 · 仅「${names.projectName}」项目组成员可查看完整内容` : '项目会议 · 仅该项目组人员可查看完整内容';
    }
    if (scope === 'COMPANY') return '公司负责人会议 · 仅部门负责人 / 部门副负责人可查看完整内容';
    return '临时会议 · 仅发起人与参会人可查看完整内容';
  }

  /** 层级规则之外再认一道「我有材料行 = 我本来就是应到的人」；详情单条走这里 */
  private async hasFullAccess(me: MeetingActor, m: MeetingAccessRow, ctx: MeetingVisibilityCtx) {
    if (this.fullAccessFor(me, m, ctx)) return true;
    const hasMaterial = await this.prisma.meetingMaterial.count({ where: { meetingId: m.id, userId: me.id } });
    return hasMaterial > 0;
  }

  /**
   * 多行判权（列表 / 公告）：先按层级规则内存判，再对没通过的行补一次「我有材料行」，
   * 整批只查一次库。不补这一刀会出现「卡片带锁、点进去却是完整内容」的自相矛盾。
   */
  private async fullAccessFlags(
    me: MeetingActor,
    rows: MeetingAccessRow[],
    ctx: MeetingVisibilityCtx,
  ): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const pending: string[] = [];
    for (const r of rows) {
      const full = this.fullAccessFor(me, r, ctx);
      out.set(r.id, full);
      if (!full) pending.push(r.id);
    }
    if (pending.length) {
      const mats = await this.prisma.meetingMaterial.findMany({
        where: { meetingId: { in: pending }, userId: me.id },
        select: { meetingId: true },
      });
      for (const x of mats as Array<{ meetingId: string }>) out.set(x.meetingId, true);
    }
    return out;
  }

  /**
   * 保密项目的关联会议对圈外人整场不可见（连标题与时间都不出现），与项目/任务同口径。
   * 已是发起人或名册内参会人的照常可见（他本来就在会里），管理员不受限。
   */
  private visibilityGate(me: MeetingActor): Record<string, unknown> {
    if (hasAtLeast(me.role, Role.ADMIN)) return {};
    return {
      OR: [
        { ownerId: me.id },
        { participantIds: { has: me.id } },
        { projectId: null },
        { project: { confidential: false } },
        { project: { confidential: true, ndaSigns: { some: { userId: me.id } } } },
      ],
    };
  }

  /** 单条取数时的保密闸门：与列表同一口径，圈外人当作「会议不存在」 */
  private async assertNotConfidential(me: MeetingActor, m: MeetingAccessRow) {
    if (!m.projectId || hasAtLeast(me.role, Role.ADMIN)) return;
    if (m.ownerId === me.id || (m.participantIds ?? []).includes(me.id)) return;
    const p = await this.prisma.project.findUnique({ where: { id: m.projectId }, select: { confidential: true } });
    if (!p?.confidential) return;
    const signed = await this.prisma.ndaSign.count({ where: { projectId: m.projectId, userId: me.id } });
    if (!signed) throw new NotFoundException('会议不存在');
  }

  /** 基本可见性：标题 / 时间 / 地点 / 发起人这类信息全员可看，草稿与保密项目会议除外 */
  async assertBasicViewer(me: MeetingActor, m: Awaited<ReturnType<MeetingService['mustFind']>>) {
    if (hasAtLeast(me.role, Role.ADMIN) || m.ownerId === me.id) return;
    if (m.status === 'DRAFT') throw new ForbiddenException('会议尚未发布');
    await this.assertNotConfidential(me, m);
  }

  /** 可见性：发起人 / 参会人 / 该部门负责人 / 管理员（他人草稿不可见） */
  async assertViewer(me: MeetingActor, m: Awaited<ReturnType<MeetingService['mustFind']>>) {
    await this.assertNotConfidential(me, m);
    if (hasAtLeast(me.role, Role.ADMIN) || m.ownerId === me.id) return;
    if (m.status === 'DRAFT') throw new ForbiddenException('会议尚未发布');
    // 内容面（议程 / 材料 / 纪要 / 名单 / 签到）按层级判定：活动全员，其余看部门 / 项目组 / 部门负责人
    const ctx = await this.visibilityCtx(me);
    if (await this.hasFullAccess(me, m, ctx)) return;
    throw new ForbiddenException(this.lockHint(m, {}) || '无权查看该会议');
  }

  /** 可管理：仅发起人本人或管理员 */
  assertManager(me: MeetingActor, m: { ownerId: string }) {
    if (m.ownerId !== me.id && !hasAtLeast(me.role, Role.ADMIN)) throw new ForbiddenException('仅会议发起人可操作该会议');
  }

  /** 会议行的「我能否管理」快捷判断（不含软删除/状态检查） */
  canManage(m: { ownerId: string }, me: MeetingActor) {
    return m.ownerId === me.id || hasAtLeast(me.role, Role.ADMIN);
  }

  /** 周期位（部门多场 + 公司层从 Setting 读）；enabled=false 的也返回，前端可展示「已暂停」 */
  async slotsFor(departmentId: string | null, scope = 'DEPT') {
    if (scope === 'COMPANY') {
      const s = await this.prisma.setting.findUnique({ where: { key: 'meeting.company.leader' } });
      const raw = s?.value;
      const arr = (Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []);
      return arr.map((x, i) => ({
        id: `company:${i}`,
        departmentId: null,
        name: String(x.name ?? '周会'),
        weekday: Number(x.weekday ?? 1),
        time: String(x.time ?? '09:30'),
        durationMinutes: Number(x.durationMinutes ?? 60),
        autoCreate: x.autoCreate !== false,
        createAheadDays: Number(x.createAheadDays ?? 3),
        materialType: (x.materialType as string) ?? 'REPORT_WEEKLY',
        groupConversationId: (x.groupConversationId as string) ?? null,
        groupName: (x.groupName as string) ?? null,
        remindEnabled: x.remindEnabled !== false,
        remindBeforeMinutes: Number(x.remindBeforeMinutes ?? 0),
        autoPilot: x.autoPilot === true,
        enabled: x.enabled !== false,
        sortOrder: Number(x.sortOrder ?? i),
        active: x.enabled !== false,
      }));
    }
    if (!departmentId) return [];
    const rows = await this.prisma.departmentMeetingSlot.findMany({
      where: { departmentId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { weekday: 'asc' }],
    });
    return rows.map((r) => ({ ...r, active: r.enabled }));
  }

  /** 按层级自动推参会人；显式传入则以显式为准 */
  async resolveParticipants(
    scope: string,
    ctx: { me: MeetingActor; deptId?: string | null; projectId?: string | null },
    explicit?: string[],
  ): Promise<string[]> {
    if (Array.isArray(explicit) && explicit.length) return Array.from(new Set(explicit.filter(Boolean)));
    if (scope === 'DEPT' && ctx.deptId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: ctx.deptId },
        include: { members: { select: { id: true } }, extraMembers: { select: { id: true } } },
      });
      const ids = (dept?.members ?? []).map((m) => m.id).concat((dept?.extraMembers ?? []).map((m) => m.id));
      return Array.from(new Set([ctx.me.id, ...ids]));
    }
    if (scope === 'COMPANY') {
      const leaders = await this.prisma.user.findMany({
        where: { active: true, role: { in: [Role.ADMIN, Role.DEPT_LEADER] } },
        select: { id: true },
      });
      return Array.from(new Set([ctx.me.id, ...leaders.map((u) => u.id)]));
    }
    if (scope === 'PROJECT' && ctx.projectId) {
      const p = await this.prisma.project.findUnique({ where: { id: ctx.projectId }, include: { members: { select: { userId: true } } } });
      return Array.from(new Set([ctx.me.id, p?.ownerId, ...(p?.members ?? []).map((m) => m.userId)].filter(Boolean) as string[]));
    }
    return [ctx.me.id];
  }

  /** 为参会人补齐材料行（幂等：已存在不动，移出的人保留行留痕） */
  async upsertMaterials(m: { id: string; materialType: string | null }, participantIds: string[]) {
    if (!m.materialType) return;
    // 要求读周报/日报的行初始来源记 REPORT，只收文字材料的记 MANUAL（与重读时的覆盖判定一致）
    const source = m.materialType.startsWith('REPORT_') ? 'REPORT' : 'MANUAL';
    for (const userId of participantIds) {
      const exists = await this.prisma.meetingMaterial.findUnique({ where: { meetingId_userId: { meetingId: m.id, userId } } });
      if (!exists) {
        await this.prisma.meetingMaterial.create({ data: { meetingId: m.id, userId, source, status: 'PENDING' } });
      }
    }
  }

  private defaultTitle(scope: string, slotName: string | null | undefined, now: Date): string {
    const label = isoWeekOf(now).replace('-W', ' 年第 ') + ' 周';
    if (scope === 'DEPT') return `${slotName ? slotName : '部门'}会议（${label}）`;
    if (scope === 'COMPANY') return `公司负责人周会（${label}）`;
    return '临时会议';
  }

  /** multer/busboy 以 latin1 解出的中文文件名还原为 UTF-8（与文档空间同一口径） */
  private decodeFileName(raw: string): string {
    const base = String(raw ?? '').split(/[\\/]/).pop() || 'file';
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim() || 'file';
    if (/[\u00c0-\u00ff]/.test(cleaned) && !/[\u4e00-\u9fa5]/.test(cleaned)) {
      const restored = Buffer.from(cleaned, 'latin1').toString('utf8');
      if (!restored.includes('\uFFFD')) return restored.slice(0, 180);
    }
    return cleaned.slice(0, 180);
  }

  private parseDate(v: string | undefined | null, label: string): Date {
    const d = new Date((v ?? '').trim());
    if (!v || Number.isNaN(d.getTime())) throw new BadRequestException(`请选择${label}`);
    return d;
  }

  /** 通知方式归一：BOTH 群发+私发（默认，与历史行为一致）/ GROUP 只群发 / DM 只私发 */
  private normNotifyMode(v?: string): string {
    const s = (v ?? 'BOTH').toString().toUpperCase();
    if (!['BOTH', 'GROUP', 'DM'].includes(s)) throw new BadRequestException('通知方式非法（只支持 BOTH/GROUP/DM）');
    return s;
  }

  /** 纪要撰写人：必须是在职账号；为空表示用默认（主持人本人） */
  private async normWriter(v?: string | null): Promise<string | null> {
    const id = (v ?? '').trim();
    if (!id) return null;
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, active: true } });
    if (!u?.active) throw new BadRequestException('纪要撰写人不存在或已停用');
    return id;
  }
}
