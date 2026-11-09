import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { deptAuthorityIds, deptRosterWhere, ledDeptWhere, pickDefaultManager } from '../../common/dept-authority';
import { fmtBeijingDate } from '../../common/beijing-time';
import { IMPORTANCE_SCORE } from '../meeting/meeting.service';
import { ReportsService } from '../reports/reports.service';

/** 调用者（controller 从 JWT 载荷传入） */
export type MemberActor = { id: string; role: string };

/** 画像可见档位：full 本人或管理员（全量）/ manage 其所管部门的管理者（公开块 + 管理块）/ peer 同部门同事（只有公开块） */
export type MemberViewLevel = 'full' | 'manage' | 'peer';

const MONTHS_TREND = 6; // 工时趋势看近 6 个月
const CALENDAR_DAYS = 14; // 应写/已写日历看近 14 天
const TIMELINE_DAYS = 30; // 日报时间轴看近 30 天

/** 本地月份串 YYYY-MM（periodStart 存的就是服务器本地零点，按本地月分桶才与录入日一致） */
function localMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 员工画像：把一个人的项目、任务、工时、日报、会议活动、贡献聚合成一页，供管理者与同部门同事了解彼此。
 * 私有信息（PBC 得分与意见、部门成员备注）在后端就按档位置空，不靠前端隐藏。
 */
@Injectable()
export class MembersService {
  constructor(
    private prisma: PrismaService,
    private reports: ReportsService,
  ) {}

  /**
   * 人名搜索（人名可点入口的前端校验用）：只在「我有权查看画像」的范围里找，
   * 否则任意登录用户都能把全员名单当目录枚举出来。
   */
  async search(me: MemberActor, q: string) {
    const term = (q ?? '').trim();
    if (!term) return [];
    const nameOr: Prisma.UserWhereInput = {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { username: { contains: term, mode: 'insensitive' } },
      ],
    };
    const where: Prisma.UserWhereInput =
      me.role === Role.ADMIN
        ? { active: true, AND: [nameOr] }
        : { active: true, AND: [await this.visibleWhere(me), nameOr] };
    const rows = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        avatar: true,
        role: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
      take: 20,
    });
    return rows;
  }

  /** 成员画像聚合 */
  async profile(targetId: string, me: MemberActor) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        name: true,
        username: true,
        avatar: true,
        role: true,
        active: true,
        createdAt: true,
        departmentId: true,
        department: { select: { id: true, name: true, leaderId: true, managerIds: true } },
        extraDepartments: { select: { id: true, name: true } },
        reportsTo: { select: { id: true, name: true, avatar: true } },
        subordinates: { where: { active: true }, select: { id: true, name: true, avatar: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!target) throw new NotFoundException('成员不存在');
    const level = await this.resolveLevel(me, target.id, [
      target.departmentId,
      ...(target.extraDepartments ?? []).map((d) => d.id),
    ]);
    const canSeePrivate = level !== 'peer';

    // 默认汇报对象（直属上级）：未手动设置时按「主部门负责人(含共管人) → 在职管理员」实时算，与回填/汇报树同口径（仅展示，不落库）
    const authorityIds = deptAuthorityIds(target.department);
    const adminIds = (await this.prisma.user.findMany({ where: { role: Role.ADMIN, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } })).map((a) => a.id);
    const candIds = [...new Set([...authorityIds, ...adminIds])].filter((id) => id !== target.id);
    const activeCands = candIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: candIds }, active: true }, select: { id: true, name: true, avatar: true } })
      : [];
    const activeCandMap = new Map(activeCands.map((p) => [p.id, p]));
    const defaultManagerId = target.reportsTo ? null : pickDefaultManager(target.id, target.role, target.department, adminIds, (id) => activeCandMap.has(id));
    const defaultManager = defaultManagerId ? activeCandMap.get(defaultManagerId)! : null;

    // 本地时间基准：与 submitDaily 存 periodStart（本地零点）同口径
    const now = new Date();
    const todayKey = new Date(now);
    todayKey.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const trendStart = new Date(now.getFullYear(), now.getMonth() - (MONTHS_TREND - 1), 1);
    const dayIdx = (todayKey.getDay() + 6) % 7; // 0=周一
    const weekStart = new Date(todayKey);
    weekStart.setDate(todayKey.getDate() - dayIdx);
    const calStart = new Date(todayKey);
    calStart.setDate(todayKey.getDate() - (CALENDAR_DAYS - 1));

    const [
      managedDepts,
      ledDepts,
      ownedProjects,
      joinedProjects,
      dailyReports,
      reportTotal,
      taskGroups,
      taskOverdue,
      taskMonthDone,
      taskRecentDone,
      attendances,
      hostedMeetings,
      joinedMeetings,
      praiseCount,
      itemCount,
      ideaCount,
      fileCount,
      docCount,
      hoursTotal,
      pbcRows,
      noteRows,
      deptRules,
      meetingItemsRaw,
      reportMonthsRaw,
    ] = await Promise.all([
      // 他作为共管人的部门（大部门多名管理者时，画像上要能看出他管哪个部门）
      this.prisma.department.findMany({ where: { managerIds: { has: targetId } }, select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.department.findMany({ where: { leaderId: targetId }, select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.project.findMany({
        where: { ownerId: targetId, deletedAt: null },
        select: { id: true, name: true, color: true, status: true, archived: true, startDate: true, endDate: true, approvalSubmittedAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.projectMember.findMany({
        where: { userId: targetId, project: { deletedAt: null, archived: false } },
        select: { position: true, project: { select: { id: true, name: true, color: true, status: true, ownerId: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      // 近 6 个月日报：工时合计与月度趋势、本月提交天数、近 14 天日历都从这一份算，不重复查库
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: targetId, periodStart: { gte: trendStart } },
        select: { periodStart: true, hours: true },
      }),
      this.prisma.report.count({ where: { type: 'DAILY', ownerId: targetId } }),
      this.prisma.task.groupBy({
        by: ['status'],
        where: { assigneeId: targetId, project: { deletedAt: null } },
        _count: { _all: true },
      }),
      this.prisma.task.count({
        where: { assigneeId: targetId, status: { not: 'DONE' }, dueDate: { lt: now }, project: { deletedAt: null } },
      }),
      this.prisma.task.count({
        where: { assigneeId: targetId, status: 'DONE', completedAt: { gte: monthStart }, project: { deletedAt: null } },
      }),
      this.prisma.task.findMany({
        where: { assigneeId: targetId, status: 'DONE', project: { deletedAt: null } },
        select: { id: true, title: true, completedAt: true, project: { select: { id: true, name: true } } },
        orderBy: { completedAt: 'desc' },
        take: 10,
      }),
      // 会议/活动出勤：口径与 meeting.myStats 一致（已发布且未删除的会议活动才计分）
      this.prisma.meetingAttendance.findMany({
        where: { userId: targetId, meeting: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } } },
        select: { method: true, meeting: { select: { type: true, importance: true } } },
        take: 500,
      }),
      this.prisma.meeting.count({ where: { ownerId: targetId, deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } } }),
      this.prisma.meeting.count({ where: { participantIds: { has: targetId }, deletedAt: null } }),
      this.prisma.meetingPraise.count({ where: { userId: targetId, meeting: { deletedAt: null } } }),
      this.prisma.meetingItem.count({ where: { assigneeId: targetId, meeting: { deletedAt: null } } }),
      this.prisma.idea.count({ where: { authorId: targetId } }),
      this.prisma.documentFile.count({ where: { uploaderId: targetId } }),
      this.prisma.knowledgeDoc.count({ where: { authorId: targetId } }),
      // 累计工时只认已发布（DRAFT 是 AI 生成待确认，不算实际投入）
      this.prisma.report.aggregate({
        where: { type: 'DAILY', ownerId: targetId, status: 'PUBLISHED' },
        _sum: { hours: true },
      }),
      canSeePrivate
        ? this.prisma.pbc.findMany({
            where: { ownerId: targetId },
            select: {
              month: true,
              total: true,
              status: true,
              reviewStatus: true,
              selfTotal: true,
              leaderTotal: true,
              leaderComment: true,
              reviewComment: true,
              decomposedAt: true,
            },
            orderBy: { month: 'desc' },
            take: MONTHS_TREND,
          })
        : Promise.resolve([]),
      canSeePrivate
        ? this.prisma.departmentMemberNote.findMany({
            where: { userId: targetId },
            select: { note: true, updatedAt: true, department: { select: { name: true } }, author: { select: { name: true } } },
            orderBy: { updatedAt: 'desc' },
          })
        : Promise.resolve([]),
      // 日报达成率对照的是「他主部门（或所管部门）的日报规则」
      target.departmentId
        ? this.prisma.department.findUnique({
            where: { id: target.departmentId },
            select: { reportFrequency: true, reportWeeklyCount: true },
          })
        : Promise.resolve(null),
      // 会议/活动明细（画像上列最近 20 场）：与上面的计数同口径，只认已发布未删除的会议活动
      this.prisma.meetingAttendance.findMany({
        where: { userId: targetId, meeting: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } } },
        include: {
          meeting: { select: { id: true, title: true, type: true, importance: true, startAt: true } },
          operator: { select: { name: true } },
        },
        orderBy: { checkedAt: 'desc' },
        take: 20,
      }),
      // 近 6 个月逐篇报告（日报 + 周报）：只取日期/类型/工时，正文仍由 personTimeline 统一截断
      this.prisma.report.findMany({
        where: { ownerId: targetId, type: { in: ['DAILY', 'WEEKLY'] }, periodStart: { gte: trendStart } },
        select: { periodStart: true, type: true, hours: true },
        orderBy: { periodStart: 'desc' },
        take: 400,
      }),
    ]);

    // ---- 工时 ----
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const monthLabels: string[] = [];
    for (let i = MONTHS_TREND - 1; i >= 0; i--) monthLabels.push(localMonth(new Date(now.getFullYear(), now.getMonth() - i, 1)));
    const monthlyMap = new Map<string, number>(monthLabels.map((m) => [m, 0]));
    let monthHours = 0;
    let weekHours = 0;
    let monthDays = 0;
    const writtenDays = new Set<number>();
    const weekWritten = new Set<number>();
    for (const r of dailyReports) {
      const d = r.periodStart;
      const h = typeof r.hours === 'number' ? r.hours : 0;
      const key = localMonth(d);
      if (monthlyMap.has(key)) monthlyMap.set(key, round1((monthlyMap.get(key) ?? 0) + h));
      if (d >= monthStart) monthHours = round1(monthHours + h);
      if (d >= weekStart) weekHours = round1(weekHours + h);
      const dayTs = new Date(d).setHours(0, 0, 0, 0);
      if (d >= monthStart) writtenDays.add(dayTs);
      if (d >= weekStart) weekWritten.add(dayTs);
    }
    monthDays = writtenDays.size;

    // ---- 排班与近 14 天日历（应写口径同 reportStatus：当天有排班才算应写） ----
    const slots = await this.prisma.userWorkSlot.findMany({ where: { userId: targetId }, select: { weekday: true } });
    const slotWeekdays = new Set(slots.map((s) => s.weekday));
    const calendar: { date: string; weekday: number; planned: boolean; written: boolean; hours: number | null }[] = [];
    const hoursByDay = new Map<number, number | null>();
    for (const r of dailyReports) hoursByDay.set(new Date(r.periodStart).setHours(0, 0, 0, 0), typeof r.hours === 'number' ? r.hours : null);
    for (let i = 0; i < CALENDAR_DAYS; i++) {
      const d = new Date(calStart);
      d.setDate(calStart.getDate() + i);
      const wd = (d.getDay() + 6) % 7;
      const dayHours = hoursByDay.get(d.getTime());
      calendar.push({
        date: fmtBeijingDate(d),
        weekday: wd,
        planned: slotWeekdays.has(wd),
        written: dayHours !== undefined,
        hours: dayHours ?? null,
      });
    }
    // 本周应写天数：WEEKLY_COUNT 看目标次数；WORKDAY 看排班；DAILY 看周一到今天的天数
    const freq = deptRules?.reportFrequency ?? 'NONE';
    let expectedWeek: number | null = null;
    if (freq === 'WEEKLY_COUNT') expectedWeek = deptRules?.reportWeeklyCount ?? null;
    else if (freq === 'WORKDAY') {
      expectedWeek = 0;
      for (let i = 0; i <= dayIdx; i++) if (slotWeekdays.has(i)) expectedWeek += 1;
    } else if (freq === 'DAILY') expectedWeek = dayIdx + 1;
    const weekDone = weekWritten.size;

    // ---- 会议活跃度 ----
    let score = 0;
    let activityCount = 0;
    let meetingCount = 0;
    let selfCount = 0;
    let makeupCount = 0;
    for (const a of attendances) {
      score += IMPORTANCE_SCORE[String(a.meeting?.importance ?? 'MEDIUM').toUpperCase()] ?? IMPORTANCE_SCORE.MEDIUM;
      if (a.meeting?.type === 'ACTIVITY') activityCount += 1;
      else meetingCount += 1;
      if (a.method === 'MAKEUP') makeupCount += 1;
      else selfCount += 1;
    }

    const taskByStatus: Record<string, number> = {};
    for (const g of taskGroups) taskByStatus[g.status] = g._count._all;

    // ---- 会议/活动明细：谁给他补签的只算管理信息，同事档不露操作人 ----
    const meetingItems = meetingItemsRaw.map((a: any) => ({
      meetingId: a.meetingId,
      title: a.meeting?.title ?? '',
      type: a.meeting?.type ?? '',
      importance: a.meeting?.importance ?? 'MEDIUM',
      startAt: a.meeting?.startAt ?? null,
      method: a.method,
      score: IMPORTANCE_SCORE[String(a.meeting?.importance ?? 'MEDIUM').toUpperCase()] ?? IMPORTANCE_SCORE.MEDIUM,
      operatorName: canSeePrivate ? a.operator?.name ?? null : null,
    }));

    // ---- 报告逐月明细：只列日期/类型/工时（不列正文，避免与 timeline 两套截断口径漂移） ----
    const monthBuckets = new Map<string, { daily: number; weekly: number; hours: number; days: { date: string; type: string; hours: number | null }[] }>();
    for (const m of monthLabels) monthBuckets.set(m, { daily: 0, weekly: 0, hours: 0, days: [] });
    for (const r of reportMonthsRaw) {
      const bucket = monthBuckets.get(localMonth(r.periodStart));
      if (!bucket) continue;
      const h = typeof r.hours === 'number' ? r.hours : null;
      if (r.type === 'DAILY') {
        bucket.daily += 1;
        // 工时只累加日报，与上方柱状图/日历完全同口径（周报没有工时）
        if (h !== null) bucket.hours = round1(bucket.hours + h);
      } else bucket.weekly += 1;
      bucket.days.push({ date: fmtBeijingDate(r.periodStart), type: r.type, hours: h });
    }
    const reportMonths = [...monthLabels].reverse().map((month) => ({ month, ...monthBuckets.get(month)! }));

    return {
      id: target.id,
      name: target.name,
      username: target.username ?? null,
      avatar: target.avatar ?? null,
      role: target.role,
      active: target.active,
      joinedAt: target.createdAt,
      viewLevel: level,
      canSeePrivate,
      identity: {
        departments: [
          ...(target.department ? [{ id: target.department.id, name: target.department.name, primary: true }] : []),
          ...(target.extraDepartments ?? []).map((d) => ({ id: d.id, name: d.name, primary: false })),
        ],
        ledDepartments: ledDepts,
        managedDepartments: managedDepts.filter((d) => d.id !== target.departmentId),
        manager: target.reportsTo ?? null,
        defaultManager,
        subordinates: target.subordinates,
      },
      hours: {
        total: round1(hoursTotal._sum.hours ?? 0),
        month: monthHours,
        week: weekHours,
        monthly: monthLabels.map((m) => ({ month: m, hours: monthlyMap.get(m) ?? 0 })),
      },
      reports: {
        total: reportTotal,
        monthDays,
        weekCount: weekDone,
        frequency: freq,
        expectedWeek,
        compliance: expectedWeek && expectedWeek > 0 ? Math.min(1, Math.round((weekDone / expectedWeek) * 100) / 100) : null,
        calendar,
        months: reportMonths,
      },
      projects: {
        owned: ownedProjects,
        joined: joinedProjects.map((m) => ({
          id: m.project.id,
          name: m.project.name,
          color: m.project.color,
          status: m.project.status,
          position: m.position,
          isOwner: m.project.ownerId === targetId,
        })),
        count: new Set([...ownedProjects.map((p) => p.id), ...joinedProjects.map((m) => m.project.id)]).size,
      },
      tasks: {
        byStatus: taskByStatus,
        overdue: taskOverdue,
        monthDone: taskMonthDone,
        recentDone: taskRecentDone,
      },
      meetings: {
        attended: attendances.length,
        hosted: hostedMeetings,
        invited: joinedMeetings,
        activityCount,
        meetingCount,
        selfCount,
        makeupCount,
        score,
        praiseCount,
        itemCount,
        items: meetingItems,
      },
      contribution: { ideas: ideaCount, files: fileCount, docs: docCount },
      // 私有块：非管理档直接不给（后端裁剪，不是前端隐藏）
      pbc: canSeePrivate ? pbcRows : null,
      notes: canSeePrivate ? noteRows : null,
      // 日报时间轴复用 ReportsService.personTimeline，避免正文取值与可见范围两套口径
      timeline: await this.reports.personTimeline({ id: me.id, role: me.role }, { userId: targetId, from: fmtBeijingDate(new Date(todayKey.getTime() - (TIMELINE_DAYS - 1) * 86400000)) }),
    };
  }

  /** 画像可见档位：管理员/本人全量；其所管部门成员为管理档；共享部门（主 ∪ 额外）或汇报相邻为同事档；其余无权 */
  private async resolveLevel(me: MemberActor, targetId: string, targetDeptIds: (string | null)[]): Promise<MemberViewLevel> {
    if (me.role === Role.ADMIN || me.id === targetId) return 'full';
    const deptIds = [...new Set(targetDeptIds.filter((x): x is string => Boolean(x)))];
    if (deptIds.length && me.role !== Role.MEMBER) {
      const managed = await this.prisma.department.count({ where: { id: { in: deptIds }, ...ledDeptWhere(me.id) } });
      if (managed > 0) return 'manage';
    }
    const visible = await this.prisma.user.count({ where: { id: targetId, AND: [await this.visibleWhere(me)] } });
    if (visible > 0) return 'peer';
    throw new ForbiddenException('无权查看该成员画像');
  }

  /** 我能查看画像的人员范围：同部门（含我管辖的部门）名册 ∪ 我的下属 ∪ 我的上级 ∪ 本人 */
  private async visibleWhere(me: MemberActor): Promise<Prisma.UserWhereInput> {
    const [meRow, ledDepts] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: me.id },
        select: { departmentId: true, reportsToId: true, extraDepartments: { select: { id: true } } },
      }),
      this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } }),
    ]);
    const deptIds = [
      ...new Set(
        [meRow?.departmentId, ...(meRow?.extraDepartments ?? []).map((d) => d.id), ...ledDepts.map((d) => d.id)].filter(
          (x): x is string => Boolean(x),
        ),
      ),
    ];
    const or: Prisma.UserWhereInput[] = [{ reportsToId: me.id }, { id: me.id }];
    if (meRow?.reportsToId) or.push({ id: meRow.reportsToId });
    if (deptIds.length) or.push(deptRosterWhere(deptIds));
    return { OR: or };
  }
}
