import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ReportStatus, ReportType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DingtalkDmService } from '../integrations/dingtalk-dm.service';
import { beijingMondayOf, beijingMondayDate, isoWeekOf, cnWeekLabel, fmtBeijingDate, CN_OFFSET_MS } from '../../common/beijing-time';
import { rankExcludedUserIds } from '../../common/rank-exclude';
import { deptAuthorityIds, deptRosterWhere, isDeptAuthority, ledDeptWhere } from '../../common/dept-authority';
import { dailyBodyOf } from '../../common/daily-body';

/** 周报归属入参：项目 / 部门 / 纯个人（三者互斥，优先级 项目>部门>个人） */
export interface WeeklyScope {
  projectId?: string | null;
  departmentId?: string | null;
}

/** 由归属算出 scopeKey：项目 P:{id} / 部门 D:{id} / 个人 '' */
export function weeklyScopeKey(scope?: WeeklyScope | null): string {
  const projectId = (scope?.projectId ?? '').trim();
  const departmentId = (scope?.departmentId ?? '').trim();
  if (projectId) return `P:${projectId}`;
  if (departmentId) return `D:${departmentId}`;
  return '';
}

/**
 * 日报工时归一：接受数字或数字字符串，限定 0~24 小时（一天不可能超过 24h）
 * - 0 是合法值：日报必须上报工时，确实没有投入就明确写 0
 * - null/undefined/空串/非法值返回 null（由调用方决定兜底 0）
 */
export function normalizeHours(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(Math.min(n, 24) * 10) / 10;
}

export interface GenerateReportOptions {
  type: ReportType;
  periodStart: Date;
  periodEnd: Date;
  manualContent?: string;
  /** 空则聚合当前用户，'team' 聚合团队全部任务 */
  ownerId?: string;
  scope?: 'me' | 'team';
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private notifications: NotificationsService,
    private dm: DingtalkDmService,
  ) {}

  /**
   * 历史列表（按可见范围）：
   * - 系统管理员：全部报告（含团队聚合报告）
   * - 项目负责人/政委：本人 ∪ 其担任负责人/政委的项目全体成员 + 团队聚合报告
   * - 普通成员：仅本人
   * 团队聚合报告 ownerId 为 null，仅管理员与项目负责人/政委可见。
   */
  async list(me: { id: string; role: string }, type?: ReportType, limit = 200) {
    const visible = await this.visibleOwnerIds(me);
    return this.prisma.report.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(visible.all
          ? {}
          : {
              OR: [{ ownerId: { in: visible.ids } }, ...(visible.includeTeam ? [{ ownerId: null }] : [])],
            }),
      },
      include: {
        owner: { select: { id: true, name: true, department: { select: { id: true, name: true } } } },
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  async get(id: string, me: { id: string; role: string }) {
    const report = await this.prisma.report.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });
    if (!report) throw new NotFoundException('报告不存在');
    if (!(await this.canViewReport(report, me))) throw new NotFoundException('报告不存在');
    return report;
  }

  /**
   * 计算当前用户可见的报告归属：
   * - ADMIN 全量
   * - 负责人（项目/部门，含部门共管人）= 其管辖项目成员 ∪ 所管部门名册成员
   * - 普通成员 = 本人 ∪ 同部门（主部门 ∪ 额外部门）全员：部门内相互看彼此日报是刻意放开的口径
   * 注：Web 端同部门互看不经管理者 Agent 开放（Agent 普通成员档的工具白名单不变）。
   */
  async visibleOwnerIds(me: { id: string; role: string }) {
    if (me.role === 'ADMIN') return { all: true as const, ids: [] as string[], includeTeam: true };
    const [owned, ledDepts, meRow] = await Promise.all([
      this.prisma.project.findMany({ where: { ownerId: me.id }, select: { id: true } }),
      this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } }),
      this.prisma.user.findUnique({
        where: { id: me.id },
        select: { departmentId: true, extraDepartments: { select: { id: true } } },
      }),
    ]);
    const deptProjectIds = ledDepts.length
      ? (await this.prisma.projectDepartment.findMany({ where: { departmentId: { in: ledDepts.map((d) => d.id) } }, select: { projectId: true } })).map((l) => l.projectId)
      : [];
    const projectIds = [...new Set([...owned.map((p) => p.id), ...deptProjectIds])];
    const ids = new Set<string>([me.id]);
    // 项目维度：本人负责的项目 + 所领导部门关联的项目，其成员与负责人均可见
    if (projectIds.length) {
      const projects = await this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { ownerId: true, members: { select: { userId: true } } },
      });
      for (const p of projects) {
        ids.add(p.ownerId);
        for (const m of p.members) ids.add(m.userId);
      }
    }
    // 部门维度：负责人/共管人看自己管辖的部门，普通成员看自己所在部门（主部门 ∪ 额外部门）
    const myDeptIds = [
      ...new Set([meRow?.departmentId, ...(meRow?.extraDepartments ?? []).map((d) => d.id)].filter((x): x is string => Boolean(x))),
    ];
    const rosterDeptIds = [...new Set([...ledDepts.map((d) => d.id), ...myDeptIds])];
    if (rosterDeptIds.length) {
      const deptMembers = await this.prisma.user.findMany({ where: deptRosterWhere(rosterDeptIds), select: { id: true } });
      for (const m of deptMembers) ids.add(m.id);
    }
    const isLeader = projectIds.length > 0 || ledDepts.length > 0;
    return { all: false as const, ids: [...ids], includeTeam: isLeader };
  }

  /** 报告是否对当前用户可见（归属本人 / 管理员 / 可见集合内 / 团队报告且有管辖项目） */
  private async canViewReport(report: { ownerId: string | null }, me: { id: string; role: string }) {
    if (report.ownerId === me.id || me.role === 'ADMIN') return true;
    const visible = await this.visibleOwnerIds(me);
    if (visible.all) return true;
    if (report.ownerId === null) return visible.includeTeam;
    return visible.ids.includes(report.ownerId);
  }

  /** 是否可维护团队聚合报告（管理员或任一项目负责人/部门管理者（含共管人）） */
  private async canManageTeamReports(me: { id: string; role: string }) {
    if (me.role === 'ADMIN') return true;
    const [owned, ledDepts] = await Promise.all([
      this.prisma.project.count({ where: { ownerId: me.id } }),
      this.prisma.department.count({ where: ledDeptWhere(me.id) }),
    ]);
    return owned + ledDepts > 0;
  }

  // ---- 日报看板与工时统计（工作管理大 tab 与项目详情共用） ----

  /** 解析 YYYY-MM-DD 为服务器本地零点（与 submitDaily 存 periodStart 口径一致，不传则取今天） */
  private dayStartOf(date?: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
    if (!m) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * 解析查看范围的人员：
   * - 指定项目：项目成员 ∪ 负责人（需为管理员/负责人/成员/关联部门管理者（含共管人））
   * - 指定部门：该部门在职成员（需为管理员/该部门管理者/该部门自己成员）
   * - 不指定：按登录人可见范围（管理员=全体；负责人=管辖范围；普通成员=本人 ∪ 同部门成员）
   */
  private async resolveViewUsers(
    me: { id: string; role: string },
    opts: { projectId?: string; departmentId?: string },
  ): Promise<{ all: boolean; ids: string[]; scopeLabel: string }> {
    if (opts.projectId) {
      const proj = await this.prisma.project.findUnique({
        where: { id: opts.projectId },
        select: { id: true, name: true, ownerId: true, members: { select: { userId: true } } },
      });
      if (!proj || (proj as any).deletedAt) throw new NotFoundException('项目不存在');
      const linkedDepts = await this.prisma.projectDepartment.findMany({
        where: { projectId: proj.id },
        select: { departmentId: true },
      });
      const isDeptLeader = linkedDepts.length
        ? (await this.prisma.department.count({ where: { AND: [{ id: { in: linkedDepts.map((d) => d.departmentId) } }, ledDeptWhere(me.id)] } })) > 0
        : false;
      const allowed =
        me.role === 'ADMIN' ||
        proj.ownerId === me.id ||
        proj.members.some((m) => m.userId === me.id) ||
        isDeptLeader;
      if (!allowed) throw new ForbiddenException('无权查看该项目日报');
      const ids = [...new Set([proj.ownerId, ...proj.members.map((m) => m.userId)])];
      return { all: false, ids, scopeLabel: `项目·${proj.name}` };
    }
    if (opts.departmentId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: opts.departmentId },
        select: { id: true, name: true, leaderId: true, managerIds: true },
      });
      if (!dept) throw new NotFoundException('部门不存在');
      // 同部门成员可看本部门日报看板（与 visibleOwnerIds 同口径），无需是负责人
      const isMember = (await this.prisma.user.count({ where: { id: me.id, ...deptRosterWhere(dept.id) } })) > 0;
      if (!(me.role === 'ADMIN' || isDeptAuthority(dept, me.id) || isMember)) throw new ForbiddenException('无权查看该部门日报');
      const members = await this.prisma.user.findMany({ where: deptRosterWhere(dept.id), select: { id: true } });
      return { all: false, ids: members.map((m) => m.id), scopeLabel: `部门·${dept.name}` };
    }
    const vis = await this.visibleOwnerIds(me);
    if (vis.all) return { all: true, ids: [], scopeLabel: '全体成员' };
    return { all: false, ids: vis.ids, scopeLabel: '我可见的成员' };
  }

  /** 日报正文快照（AI 修正 > 手写原文 > 人工补充）：统一走 common/daily-body，部门详情与画像共用同一口径 */
  private dailyBody(r: any): string {
    return dailyBodyOf(r);
  }

  /**
   * 按日期聚合某范围所有人的日报（像看一份文档）：默认今日，可指定项目/部门。
   * 项目口径 = 「这个项目的成员当天写的日报」全部体现（负责人 + 成员名册），
   * 不再要求「日报归属本项目」：一人一天只有一篇日报（唯一键含 scopeKey，日报 scopeKey 恒为 ""），
   * 它会同时出现在该成员所在的每个项目里；每条仍带「归属项目」标签（report.projectId，AI 判断，可为空）便于区分。
   * 已交在前（按部门→姓名），未交以 submitted=false 排在最后，便于一眼看出谁没写。
   */
  async dailyOverview(me: { id: string; role: string }, opts: { date?: string; projectId?: string; departmentId?: string }) {
    const dayStart = this.dayStartOf(opts.date);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const scope = await this.resolveViewUsers(me, opts);
    const where: any = { type: 'DAILY', periodStart: { gte: dayStart, lt: dayEnd } };
    // 不按 report.projectId 过滤：项目名册（resolveViewUsers 给出）成员的日报一律展示
    if (!scope.all) where.ownerId = { in: scope.ids };
    const reports: any[] = await this.prisma.report.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, avatar: true, department: { select: { name: true } } } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { periodStart: 'asc' },
    });
    const items = reports
      .filter((r) => r.ownerId)
      .map((r) => ({
        userId: r.ownerId as string,
        name: r.owner?.name ?? '未知',
        avatar: r.owner?.avatar ?? null,
        departmentName: r.owner?.department?.name ?? null,
        projectName: r.project?.name ?? null,
        hours: typeof r.hours === 'number' ? r.hours : null,
        content: this.dailyBody(r),
        submitted: true,
        reportId: r.id,
      }));
    // 未交成员（仅在能枚举出完整名册时补上）
    if (!scope.all) {
      const submittedSet = new Set(items.map((i) => i.userId));
      const missing = scope.ids.filter((id) => !submittedSet.has(id));
      if (missing.length) {
        const users = await this.prisma.user.findMany({
          where: { id: { in: missing }, active: true },
          select: { id: true, name: true, avatar: true, department: { select: { name: true } } },
        });
        for (const u of users) {
          items.push({
            userId: u.id,
            name: u.name,
            avatar: u.avatar ?? null,
            departmentName: u.department?.name ?? null,
            projectName: null,
            hours: null,
            content: '',
            submitted: false,
            reportId: null,
          });
        }
      }
    }
    items.sort((a, b) => {
      if (a.submitted !== b.submitted) return a.submitted ? -1 : 1;
      const d = String(a.departmentName ?? '').localeCompare(String(b.departmentName ?? ''), 'zh-Hans-CN');
      if (d) return d;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    const totalHours = Math.round(items.reduce((s, i) => s + (typeof i.hours === 'number' ? i.hours : 0), 0) * 10) / 10;
    const submittedCount = items.filter((i) => i.submitted).length;
    return {
      date: fmtBeijingDate(dayStart),
      scopeLabel: scope.scopeLabel,
      items,
      totalHours,
      submittedCount,
      rosterCount: items.length,
    };
  }

  /**
   * 某成员日报时间轴（按天倒序）：每天正文 + 当日工时，并给出区间累计工时。
   * 默认最近 30 天；仅本人、管理员或其可见范围内可看。
   */
  async personTimeline(me: { id: string; role: string }, opts: { userId?: string; from?: string; to?: string }) {
    const targetId = (opts.userId ?? '').trim() || me.id;
    if (targetId !== me.id && me.role !== 'ADMIN') {
      const vis = await this.visibleOwnerIds(me);
      if (!vis.all && !vis.ids.includes(targetId)) throw new ForbiddenException('无权查看该成员日报');
    }
    const toDate = opts.to ? this.dayStartOf(opts.to) : this.dayStartOf(fmtBeijingDate(new Date()));
    const fromDate = opts.from ? this.dayStartOf(opts.from) : new Date(toDate.getTime() - 29 * 86400000);
    const [user, reports] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true, name: true, avatar: true, department: { select: { name: true } } } }),
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: targetId, periodStart: { gte: fromDate, lt: new Date(toDate.getTime() + 86400000) } },
        include: { project: { select: { name: true } } },
        orderBy: { periodStart: 'desc' },
      }),
    ]);
    if (!user) throw new NotFoundException('成员不存在');
    const days = (reports as any[]).map((r) => ({
      id: r.id,
      date: fmtBeijingDate(r.periodStart),
      hours: typeof r.hours === 'number' ? r.hours : null,
      projectName: r.project?.name ?? null,
      content: this.dailyBody(r),
    }));
    const totalHours = Math.round(days.reduce((s, d) => s + (typeof d.hours === 'number' ? d.hours : 0), 0) * 10) / 10;
    return {
      user: { id: user.id, name: user.name, avatar: user.avatar ?? null, departmentName: user.department?.name ?? null },
      from: fmtBeijingDate(fromDate),
      to: fmtBeijingDate(toDate),
      days,
      totalHours,
      dayCount: days.length,
      avgHours: days.length ? Math.round((totalHours / days.length) * 10) / 10 : 0,
    };
  }

  /**
   * 工时排行：scope=week（本周北京周一起 7 天）| month（本月北京自然月）| cumulative（累计全部），按工时高到低。
   * 可限定项目/部门（同样按「成员名册」口径：成员当天全部工时计入其所在每个项目，
   * 因为一篇日报只有一个当日工时、无法按项目拆分；跨项目共享成员会重复计入，属预期）；
   * 不限定则按登录人可见范围（管理员=全公司）。仅供查看，不影响写入。
   */
  async hoursRanking(
    me: { id: string; role: string },
    opts: { scope?: string; projectId?: string; departmentId?: string; date?: string; all?: boolean },
  ) {
    const scopeKind = opts.scope === 'week' ? 'week' : opts.scope === 'month' ? 'month' : 'cumulative';
    const ref = opts.date ? this.dayStartOf(opts.date) : new Date();
    let gte: Date | undefined;
    let lt: Date | undefined;
    let label: string;
    if (scopeKind === 'week') {
      const monday = beijingMondayOf(ref);
      gte = monday;
      lt = new Date(monday.getTime() + 7 * 86400000);
      label = `${beijingMondayDate(monday)} 起本周`;
    } else if (scopeKind === 'month') {
      // 北京自然月，与「本月日报数」同口径（日报 periodStart 存的是北京日历日的零点时刻）
      const bj = new Date(ref.getTime() + CN_OFFSET_MS);
      const y = bj.getUTCFullYear();
      const mo = bj.getUTCMonth();
      gte = new Date(Date.UTC(y, mo, 1) - CN_OFFSET_MS);
      lt = new Date(Date.UTC(y, mo + 1, 1) - CN_OFFSET_MS);
      label = `${y} 年 ${mo + 1} 月累计`;
    } else {
      label = '累计（全部）';
    }
    // all=true：强制公司全员口径（首页“本周工时排行”用），不受查看者角色收窄；否则按可见范围
    const roster = opts.all
      ? { all: true, ids: [] as string[], scopeLabel: '公司全员' }
      : await this.resolveViewUsers(me, opts);
    // 杨力/书书等「只看不排」的成员整条排除：不进名次，工时也不计入合计与人数
    const excluded = await rankExcludedUserIds(this.prisma);
    const where: any = { type: 'DAILY', status: 'PUBLISHED', ownerId: { not: null } };
    // 与日报列表同口径：按成员名册取数，不再按 report.projectId 过滤
    if (!roster.all) where.ownerId = { in: roster.ids.filter((id) => !excluded.has(id)) };
    else if (excluded.size) where.ownerId = { notIn: [...excluded] };
    if (gte) where.periodStart = { gte, lt };
    const reports = await this.prisma.report.findMany({ where, select: { ownerId: true, hours: true } });
    const agg = new Map<string, { hours: number; days: number }>();
    for (const r of reports) {
      if (!r.ownerId) continue;
      const h = typeof r.hours === 'number' && Number.isFinite(r.hours) ? Math.max(0, Math.min(r.hours, 24)) : 0;
      const a = agg.get(r.ownerId) ?? { hours: 0, days: 0 };
      if (h > 0) {
        a.hours += h;
        a.days += 1;
      }
      agg.set(r.ownerId, a);
    }
    const ids = [...agg.keys()].filter((id) => agg.get(id)!.hours > 0);
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, department: { select: { name: true } } } })
      : [];
    const byId = new Map((users as any[]).map((u) => [u.id, u]));
    const rows = ids
      .map((id) => ({
        userId: id,
        name: byId.get(id)?.name ?? '未知',
        departmentName: byId.get(id)?.department?.name ?? null,
        hours: Math.round(agg.get(id)!.hours * 10) / 10,
        days: agg.get(id)!.days,
      }))
      .sort((a, b) => b.hours - a.hours || b.days - a.days);
    const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));
    const totalHours = Math.round(ranked.reduce((s, r) => s + r.hours, 0) * 10) / 10;
    return { scope: scopeKind, label, scopeLabel: roster.scopeLabel, rows: ranked, totalHours, memberCount: ranked.length };
  }

  /**
   * 日报数量排行：北京自然月（默认）或本周（scope=week）内已发布 DAILY 日报的篇数，按篇数降序。
   * 与工时排行同口径：一篇日报算 1 篇，按成员名册取数；同样排除「只看不排」成员；
   * all=true 时强制公司全员口径（首页榜单用），否则按登录人可见范围。
   */
  async reportCountRanking(
    me: { id: string; role: string },
    opts: { scope?: string; projectId?: string; departmentId?: string; all?: boolean } = {},
  ) {
    const scopeKind = opts.scope === 'week' ? 'week' : 'month';
    const bj = new Date(Date.now() + CN_OFFSET_MS);
    const y = bj.getUTCFullYear();
    const mo = bj.getUTCMonth(); // 0 起始
    const month = `${y}-${String(mo + 1).padStart(2, '0')}`;
    let gte: Date;
    let lt: Date;
    let label: string;
    let week: string | null = null;
    if (scopeKind === 'week') {
      // 北京本周：周一起 7 天，与工时排行的周口径一致
      const monday = beijingMondayOf(new Date());
      gte = monday;
      lt = new Date(monday.getTime() + 7 * 86400000);
      week = beijingMondayDate(monday);
      label = `${week} 起本周`;
    } else {
      // 北京自然月 → 绝对时刻（日报 periodStart 存的是北京日历日的零点时刻）
      gte = new Date(Date.UTC(y, mo, 1) - CN_OFFSET_MS);
      lt = new Date(Date.UTC(y, mo + 1, 1) - CN_OFFSET_MS);
      label = `${y} 年 ${mo + 1} 月累计`;
    }
    const roster = opts.all
      ? { all: true, ids: [] as string[], scopeLabel: '公司全员' }
      : await this.resolveViewUsers(me, opts);
    const excluded = await rankExcludedUserIds(this.prisma);
    const where: any = { type: 'DAILY', status: 'PUBLISHED', ownerId: { not: null }, periodStart: { gte, lt } };
    if (!roster.all) where.ownerId = { in: roster.ids.filter((id) => !excluded.has(id)) };
    else if (excluded.size) where.ownerId = { notIn: [...excluded] };
    const reports = await this.prisma.report.findMany({ where, select: { ownerId: true } });
    const agg = new Map<string, number>();
    for (const r of reports) {
      if (!r.ownerId) continue;
      agg.set(r.ownerId, (agg.get(r.ownerId) ?? 0) + 1);
    }
    const ids = [...agg.keys()];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, department: { select: { name: true } } } })
      : [];
    const byId = new Map((users as any[]).map((u) => [u.id, u]));
    const rows = ids
      .map((id) => ({
        userId: id,
        name: byId.get(id)?.name ?? '未知',
        departmentName: byId.get(id)?.department?.name ?? null,
        count: agg.get(id)!,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
    const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));
    const totalCount = ranked.reduce((s, r) => s + r.count, 0);
    return { scope: scopeKind, month, week, label, scopeLabel: roster.scopeLabel, rows: ranked, totalCount, memberCount: ranked.length };
  }

  /**
   * 生成日报/周报：
   * 1. 聚合任务活动（本人/团队）+ 钉钉群消息
   * 2. AI 按 prompts/report.daily.md 或 report.weekly.md 生成结构化内容
   * 3. 保存为 DRAFT，人工确认后 PUBLISHED
   * AI 不可用时降级为纯数据聚合（不阻塞主流程）
   */
  async generate(userId: string, options: GenerateReportOptions) {
    const { type, periodStart, periodEnd } = options;
    const teamScope = options.scope === 'team';
    // 数据聚合维度（团队=全司/全体任务），存储归属：团队聚合报告 ownerId 为 null
    const aggregateOwner = teamScope ? 'team' : userId;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // ---- 1. 聚合数据 ----
    const [activities, messages, manual] = await Promise.all([
      this.collectActivities(aggregateOwner, periodStart, periodEnd),
      this.collectMessages(periodStart, periodEnd),
      options.manualContent ?? Promise.resolve(undefined),
    ]);

    const taskText = this.formatActivities(activities, teamScope);
    const chatText = this.formatMessages(messages);

    // ---- 2. AI 生成 ----
    const promptName = type === ReportType.DAILY ? 'report.daily' : 'report.weekly';
    let aiResult: unknown = null;
    try {
      aiResult = await this.ai.generateJson(promptName, {
        userName: user?.name ?? '我',
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        taskChanges: taskText || '（无）',
        chatSummary: chatText || '（无）',
        manualContent: manual || '（无）',
      });
    } catch (e) {
      this.logger.error(`AI 生成${type}失败`, e as Error);
    }

    // AI 失败时降级为数据聚合摘要（三段式标题）
    const fallback = {
      summary: `${type === ReportType.DAILY ? '日报' : '周报'}（AI 不可用，数据聚合）`,
      sections: [
        { title: '已完成的工作', items: taskText.split('\n').filter(Boolean).slice(0, 20) },
        { title: '后续计划', items: [] },
        { title: '需要协调的问题', items: chatText.split('\n').filter(Boolean).slice(0, 10) },
      ],
    };
    const content = (aiResult as any) ?? fallback;

    // ---- 3. 保存（同周期重复生成则覆盖；团队报告 ownerId 为 null，用 findFirst 定位） ----
    const existing = teamScope
      ? await this.prisma.report.findFirst({ where: { type, ownerId: null, periodStart, scopeKey: '' } })
      : await this.prisma.report.findUnique({
          where: { type_ownerId_periodStart_scopeKey: { type, ownerId: userId, periodStart, scopeKey: '' } },
        });
    const report = existing
      ? await this.prisma.report.update({
          where: { id: existing.id },
          data: {
            periodEnd,
            content: content as any,
            aiGenerated: (aiResult ?? undefined) as any,
            manualContent: manual,
          },
        })
      : await this.prisma.report.create({
          data: {
            type,
            ownerId: teamScope ? null : userId,
            periodStart,
            periodEnd,
            content: content as any,
            aiGenerated: (aiResult ?? undefined) as any,
            manualContent: manual,
            status: ReportStatus.DRAFT,
          },
        });
    return report;
  }

  async update(
    id: string,
    data: { manualContent?: string; rawContent?: string; status?: ReportStatus; hours?: number | null | string },
    me: { id: string; role: string },
  ) {
    const report = await this.prisma.report.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('报告不存在');
    // 仅本人或系统管理员可编辑；团队聚合报告（ownerId null）由管理员或项目负责人/政委维护（含发布）
    const isTeamReport = report.ownerId === null;
    const allowed =
      report.ownerId === me.id || me.role === 'ADMIN' || (isTeamReport && (await this.canManageTeamReports(me)));
    if (!allowed) throw new ForbiddenException('仅报告本人或系统管理员可编辑');
    // 工时修正：body 带了 hours 就以人工值为准（0 是合法值）；null/空串表示无值，按 0 记录
    const hoursTouched = data.hours !== undefined && data.hours !== '';
    const hoursPatch = hoursTouched ? { hours: normalizeHours(data.hours) ?? 0 } : {};
    const rest: Record<string, unknown> = { ...data };
    delete rest.hours;
    const updated = await this.prisma.report.update({
      where: { id },
      data: {
        ...rest,
        ...hoursPatch,
        // 手写周报原文修订：不重跑 AI，同步修正内容避免展示过期
        ...(report.type === ReportType.WEEKLY && data.rawContent !== undefined
          ? { correctedContent: data.rawContent.trim() }
          : {}),
      },
    });
    // 修订手写日报原文 → 重新 AI 修正并更新项目进展（仅日报；周报手写原文不重跑 AI；团队报告无原文不会进入）
    if (data.rawContent !== undefined && report.rawContent !== data.rawContent.trim()) {
      if (report.type === ReportType.DAILY && updated.ownerId) {
        // 本次一并修正了工时的，以人工值为准，不被 AI 重新提取覆盖
        await this.processReportText(
          updated.ownerId,
          id,
          hoursTouched ? normalizeHours(data.hours) : undefined,
        );
      }
    }
    return updated;
  }

  /**
   * 提交手写日报（首页快速日报）：
   * - 同日重复提交：原文换行追加合并，整体重新 AI 处理
   * - 直接提交即发布（无需确认）
   * - 工时（必填项，前端会拦）：表单显式填了就以人工值为准；没填则沿用当天已有工时，
   *   仍为空才交给 AI 从正文提取；最终都没有则记 0（不再留 null）
   */
  async submitDaily(userId: string, rawContent: string, hoursRaw?: unknown) {
    const text = rawContent.trim();
    if (!text) throw new BadRequestException('日报内容不能为空');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const existing = await this.prisma.report.findUnique({
      where: { type_ownerId_periodStart_scopeKey: { type: ReportType.DAILY, ownerId: userId, periodStart: start, scopeKey: '' } },
    });
    const merged = existing && existing.rawContent ? `${existing.rawContent}\n${text}` : text;
    // 空字符串/undefined = 本次没填工时，不干预；填了就以人工值为准
    const hoursOverride =
      hoursRaw === undefined || hoursRaw === null || hoursRaw === ''
        ? (typeof existing?.hours === 'number' ? existing.hours : undefined)
        : normalizeHours(hoursRaw);
    const report = existing
      ? await this.prisma.report.update({
          where: { id: existing.id },
          data: { rawContent: merged, periodEnd: new Date(), status: ReportStatus.PUBLISHED },
        })
      : await this.prisma.report.create({
          data: {
            type: ReportType.DAILY,
            ownerId: userId,
            periodStart: start,
            periodEnd: new Date(),
            rawContent: merged,
            status: ReportStatus.PUBLISHED,
          },
        });
    const processed = await this.processReportText(userId, report.id, hoursOverride);
    const backfill = (processed as any)?.backfill ?? [];
    const final = await this.prisma.report.findUnique({
      where: { id: report.id },
      include: { project: { select: { id: true, name: true } } },
    });
    // 写完日报实时钉钉私聊通知部门负责人（fire-and-forget，不阻塞提交；部门关闭或无负责人则跳过）
    void this.notifyDeptLeader(userId, final, '日报');
    return { ...final, backfill };
  }

  /**
   * 成员提交汇报内容后钉钉私聊其部门负责人（委托通用 DingtalkDmService.notifyDeptLeader）
   * - 正文取修正后内容，回退原文；kind 区分日报/周报
   * - 具体部门/开关/负责人判定与发送均由 dm 统一处理，失败不影响主流程
   */
  private async notifyDeptLeader(userId: string, report: any, kind: string) {
    const body = (report?.correctedContent || report?.rawContent || '').trim();
    await this.dm.notifyDeptLeader(userId, { kind, excerpt: body });
  }

  /**
   * 提交手写周报（三段式：已完成的工作/后续计划/需要协调的问题）：
   * - periodStart 统一为「北京周周一 00:00」绝对时刻（与 P0-f 聚合、会议读取对齐）；传入日期（补发）归一到其所在周
   * - 归属一律个人（scopeKey ''）：每人每周仅一份个人周报，项目/部门/周会按成员归属自动汇集其个人周报
   * - 同周重复提交追加合并原文；直接提交即发布；不做 AI 修正/补录/项目进展更新
   * - groupIds 非空则同步把周报原文发到勾选的钉钉群（群发失败不阻断提交，逐群回写结果）
   * - scope 形参保留但忽略（旧 P:/D: 归属周报只读兼容，不再新写）
   */
  async submitWeekly(
    userId: string,
    rawContent: string,
    groupIds?: string[],
    scope?: WeeklyScope,
    periodStart?: string,
  ) {
    const text = rawContent.trim();
    if (!text) throw new BadRequestException('周报内容不能为空');
    // 周口径统一到北京周一：补发日期归一到其所在周，非法/缺省用当前时间
    const base = periodStart ? new Date(periodStart) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    const periodEnd = new Date(monday.getTime() + 7 * 86400000);

    // 归属一律个人：不再手选项目/部门，scopeKey 恒为 ''（旧 P:/D: 行只读保留，不迁移）
    const existing = await this.prisma.report.findUnique({
      where: {
        type_ownerId_periodStart_scopeKey: { type: ReportType.WEEKLY, ownerId: userId, periodStart: monday, scopeKey: '' },
      },
    });
    const merged = existing && existing.rawContent ? `${existing.rawContent}\n${text}` : text;
    const report = existing
      ? await this.prisma.report.update({
          where: { id: existing.id },
          data: {
            rawContent: merged,
            correctedContent: merged,
            periodEnd,
            status: ReportStatus.PUBLISHED,
            projectId: null,
            departmentId: null,
          },
        })
      : await this.prisma.report.create({
          data: {
            type: ReportType.WEEKLY,
            ownerId: userId,
            periodStart: monday,
            periodEnd,
            rawContent: merged,
            correctedContent: merged,
            status: ReportStatus.PUBLISHED,
            projectId: null,
            departmentId: null,
            scopeKey: '',
          },
        });
    const final = await this.prisma.report.findUnique({
      where: { id: report.id },
      include: { project: { select: { id: true, name: true } } },
    });
    // 写完周报实时钉钉私聊通知部门负责人（与日报同一开关 gating，fire-and-forget 不阻塞提交）
    void this.notifyDeptLeader(userId, final, '周报');
    // 勾选了「同步发到关联群」：把周报原文直发到这些群（逐群同步发送并返回真实结果）
    const groups = await this.sendWeeklyToGroups(userId, final, groupIds ?? []);
    return { ...final, backfill: [], groups };
  }

  /**
   * 将已存在的本周周报原文再发一次到指定钉钉群（不修改周报记录，避免重发 append 重复）
   * - 周报现一律个人唯一；个人行优先，兼容历史周仅有项目/部门归属行：取不到个人则回落当周任一
   * - scopeKey 形参保留兼容旧调用，实际按个人优先→任一命中
   */
  async resendWeeklyToGroups(userId: string, periodStart: Date, scopeKey: string, groupIds: string[]) {
    const inc = { project: { select: { id: true, name: true } } };
    let report = await this.prisma.report.findUnique({
      where: { type_ownerId_periodStart_scopeKey: { type: ReportType.WEEKLY, ownerId: userId, periodStart, scopeKey: '' } },
      include: inc,
    });
    if (!report) {
      const list = await this.prisma.report.findMany({
        where: { type: ReportType.WEEKLY, ownerId: userId, periodStart },
        include: inc,
      });
      report = list.find((r) => !r.scopeKey) ?? list[0] ?? null;
    }
    if (!report) throw new BadRequestException('本周还没有周报，请先写好后再发群');
    const groups = await this.sendWeeklyToGroups(userId, report, groupIds);
    return { ok: true, groups };
  }

  /**
   * 周报同步发群（需求 6）：原文直发，不加工不加 AI 摘要
   * - dws 以个人身份发群，收看不出是谁的周报，所以带一行抬头做署名归属
   * - 任何一群失败只记日志与结果，不影响周报已提交入库
   */
  private async sendWeeklyToGroups(userId: string, report: any, groupIds: string[]) {
    const ids = Array.from(new Set((groupIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)));
    if (!ids.length) return [];
    const body = String(report?.correctedContent || report?.rawContent || '').trim();
    if (!body) return [];
    const [user, projects] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, department: { select: { name: true } } },
      }),
      this.prisma.project.findMany({
        where: { dingtalkConversationId: { in: ids } },
        select: { dingtalkConversationId: true, dingtalkGroupName: true, name: true },
        take: 200,
      }),
    ]);
    const nameOf = new Map<string, string>();
    for (const p of projects) {
      const cid = p.dingtalkConversationId!;
      if (!nameOf.has(cid)) nameOf.set(cid, p.dingtalkGroupName || p.name || cid);
    }
    // 周次双标注（{M}月第{N}周 · {ISO}）+ 归属标注（项目/部门）
    const weekStart = report?.periodStart ? new Date(report.periodStart) : null;
    const weekLabel = weekStart && !Number.isNaN(weekStart.getTime()) ? `${cnWeekLabel(weekStart)} · ${isoWeekOf(weekStart)}` : '';
    let scopeLabel = '';
    if (report?.project?.name) scopeLabel = `【项目·${report.project.name}】`;
    else if (report?.departmentId) {
      const dep = await this.prisma.department.findUnique({ where: { id: report.departmentId }, select: { name: true } });
      if (dep?.name) scopeLabel = `【部门·${dep.name}】`;
    }
    const dept = user?.department?.name ? `（${user.department.name}）` : '';
    const headTitle = scopeLabel ? `项目/部门周报` : '本周周报';
    const text = [
      `📮 ${headTitle}｜${user?.name ?? ''}${dept}${scopeLabel ? ` ${scopeLabel}` : ''}${weekLabel ? `（${weekLabel}）` : ''}`,
      '',
      body,
      '',
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
    const out: { conversationId: string; groupName: string; ok: boolean; error?: string }[] = [];
    for (const cid of ids) {
      try {
        const r = await this.dm.sendGroup(cid, text);
        out.push({ conversationId: cid, groupName: nameOf.get(cid) ?? cid, ok: r.ok, error: r.error });
        if (!r.ok) this.logger.warn(`周报同步发群失败（群 ${nameOf.get(cid) ?? cid}）: ${r.error ?? '未知'}`);
      } catch (e) {
        out.push({ conversationId: cid, groupName: nameOf.get(cid) ?? cid, ok: false, error: (e as Error).message });
        this.logger.warn(`周报同步发群异常（群 ${cid}）: ${(e as Error).message}`);
      }
    }
    this.logger.log(`周报同步发群完成 user=${user?.name ?? userId} 成功 ${out.filter((x) => x.ok).length}/${out.length} 群`);
    return out;
  }

  /**
   * AI 处理手写日报：修正错字并整理为三段式 + 智能判断所属项目 + 提取当日工时 + 按时间拆分补录历史日报/周报
   * - 命中项目 → 按 reportId upsert 项目进展（修订后重新更新同一条，不重复刷屏）并通知成员
   * - 原文提到的昨天/前天 → 合并补录到对应日期日报；上周 → 合并补录到上周周报
   * - 无法判断项目或 AI 不可用 → 只保存日报，不更新项目进展（不阻塞提交）
   * - 泛化入口：周报手写提交不调用（跳过 AI，仅存 rawContent）
   * @param hoursOverride 人工已修正的工时（undefined=不干预采用 AI 提取值；null=按 0 记录）
   */
  async processReportText(userId: string, reportId: string, hoursOverride?: number | null) {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report || !report.rawContent) return null;

    // 仅从用户加入的项目中判断归属（负责人或成员）
    const projects = await this.prisma.project.findMany({
      where: { archived: false, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });

    let aiResult: {
      corrected?: string;
      projectId?: string | null;
      hours?: number | string | null;
      history?: { when: 'today' | 'yesterday' | 'day_before_yesterday' | 'last_week'; text: string }[];
    } | null = null;
    try {
      aiResult = await this.ai.generateJson('report.daily.analyze', {
        rawContent: report.rawContent,
        projects: projects.map((p) => `- ${p.id}：${p.name}`).join('\n') || '（无）',
      });
    } catch (e) {
      this.logger.error('AI 处理日报失败', e as Error);
    }

    const corrected = aiResult?.corrected?.trim() || report.rawContent;
    const projectId =
      aiResult?.projectId && projects.some((p) => p.id === aiResult.projectId) ? aiResult.projectId : null;
    // 工时：人工值优先；否则用 AI 从正文提取并归一到 0~24；两者都没有则记 0（日报必须上报工时）
    const hours = (hoursOverride === undefined ? normalizeHours(aiResult?.hours) : hoursOverride) ?? 0;

    const updated = await this.prisma.report.update({
      where: { id: report.id },
      data: {
        correctedContent: corrected,
        projectId,
        hours,
        aiGenerated: (aiResult ?? undefined) as any,
      },
    });

    // 按时间拆分：补录昨天/前天日报、上周周报（修订重处理时自动防重）
    const backfill = await this.backfillHistory(userId, report.id, aiResult?.history);

    if (!projectId) return { ...updated, backfill };

    // 命中项目：upsert 进展（同一日报修订后更新同一条记录）
    const existingUpdate = await this.prisma.projectUpdate.findFirst({ where: { reportId: report.id } });
    if (existingUpdate) {
      await this.prisma.projectUpdate.update({
        where: { id: existingUpdate.id },
        data: { projectId, content: corrected, periodEnd: new Date(), createdAt: new Date() },
      });
    } else {
      await this.prisma.projectUpdate.create({
        data: {
          projectId,
          content: corrected,
          keyPoints: [],
          source: 'DAILY_REPORT',
          reportId: report.id,
          periodStart: report.periodStart,
          periodEnd: new Date(),
        },
      });
    }

    // 通知项目成员
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: { select: { userId: true } } },
    });
    if (project) {
      const memberIds = [...new Set([project.ownerId, ...project.members.map((m) => m.userId)])];
      await this.notifications.createMany(memberIds, {
        type: 'SYSTEM',
        title: `项目「${project.name}」进展已更新（日报）`,
        content: corrected.slice(0, 100),
        link: `/projects/${projectId}`,
      });
    }
    return { ...updated, backfill };
  }

  /**
   * 补录历史日报/周报：AI 从日报原文中识别出的历史时间点内容，合并到对应日期的记录
   * - yesterday / day_before_yesterday → 对应日期日报（存在则追加原文，不存在则新建）
   * - last_week → 上周周报（存在则合并进 content.sections，不存在则新建）
   * - 修订重处理时通过去空白包含判断防重，避免重复追加
   */
  private async backfillHistory(
    userId: string,
    reportId: string,
    history?: { when: string; text: string }[],
  ) {
    const backfill: { type: ReportType; date: string; label: string }[] = [];
    if (!Array.isArray(history) || !history.length) return backfill;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fmtLocal = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const labelMap: Record<string, string> = {
      yesterday: '昨天',
      day_before_yesterday: '前天',
      last_week: '上周',
    };

    for (const h of history) {
      const text = (h?.text || '').trim();
      const label = labelMap[h?.when];
      if (!text || !label) continue;

      // 上周 → 周报（上周一的北京周口径，与写入侧统一）
      if (h.when === 'last_week') {
        const lastMonday = beijingMondayOf(new Date(today.getTime() - 7 * 86400000));
        const existing = await this.prisma.report.findUnique({
          where: {
            type_ownerId_periodStart_scopeKey: { type: ReportType.WEEKLY, ownerId: userId, periodStart: lastMonday, scopeKey: '' },
          },
        });
        if (existing) {
          const content = (existing.content as any) || { summary: '', sections: [] };
          const sections = Array.isArray(content.sections) ? content.sections : [];
          const flat = JSON.stringify(sections).replace(/\s+/g, '');
          if (!flat.includes(text.replace(/\s+/g, ''))) {
            const done = sections.find((s: any) => s?.title?.includes('完成'));
            if (done) done.items = [...(done.items || []), text];
            else sections.push({ title: '本周完成（补录）', items: [text] });
            await this.prisma.report.update({
              where: { id: existing.id },
              data: { content: content as any, status: ReportStatus.PUBLISHED },
            });
          }
        } else {
          await this.prisma.report.create({
            data: {
              type: ReportType.WEEKLY,
              ownerId: userId,
              periodStart: lastMonday,
              periodEnd: new Date(lastMonday.getTime() + 7 * 86400000),
              content: {
                summary: '（由日报补录生成）',
                sections: [{ title: '本周完成（补录）', items: [text] }],
                nextWeek: [],
              },
              aiGenerated: { backfilledFrom: reportId, when: 'last_week' },
              status: ReportStatus.PUBLISHED,
            },
          });
        }
        backfill.push({ type: ReportType.WEEKLY, date: beijingMondayDate(lastMonday), label });
        continue;
      }

      // 昨天/前天 → 对应日期日报
      const offset = h.when === 'yesterday' ? -1 : -2;
      const day = new Date(today);
      day.setDate(today.getDate() + offset);
      const existing = await this.prisma.report.findUnique({
        where: { type_ownerId_periodStart_scopeKey: { type: ReportType.DAILY, ownerId: userId, periodStart: day, scopeKey: '' } },
      });
      const tag = `（补录 ${label}）`;
      if (existing) {
        const raw = (existing.rawContent || '').replace(/\s+/g, '');
        const corr = (existing.correctedContent || '').replace(/\s+/g, '');
        const key = text.replace(/\s+/g, '');
        if (!raw.includes(key) && !corr.includes(key)) {
          await this.prisma.report.update({
            where: { id: existing.id },
            data: {
              rawContent: existing.rawContent ? `${existing.rawContent}\n${tag}${text}` : `${tag}${text}`,
              correctedContent: existing.correctedContent
                ? `${existing.correctedContent}\n${tag}${text}`
                : text,
              status: ReportStatus.PUBLISHED,
            },
          });
        }
      } else {
        await this.prisma.report.create({
          data: {
            type: ReportType.DAILY,
            ownerId: userId,
            periodStart: day,
            periodEnd: new Date(),
            rawContent: `${tag}${text}`,
            correctedContent: text,
            // 补录的历史日报没有工时信息：按「未上报 = 0」口径落库，避免历史行留 null
            hours: 0,
            aiGenerated: { backfilledFrom: reportId, when: h.when },
            status: ReportStatus.PUBLISHED,
          },
        });
      }
      backfill.push({ type: ReportType.DAILY, date: fmtLocal(day), label });
    }
    return backfill;
  }

  // ---- 周报归属可选项 & 公司/部门聚合（P0-f 写侧扩展） ----

  /** 周报正文取值优先级（与 P0-f / 会议材料一致）：correctedContent > rawContent > content JSON 结构化拼接 */
  private reportBody(r: any): string {
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
   * 手写周报弹窗「AI 生成」：把本周（或补发周）已发布的本人日报聚合成三段式周报草稿。
   * - 只聚合不落库：返回三段文本回填表单，人工可改后再走 submitWeekly 提交
   * - 周报一律为个人汇报（不再按项目/部门归属）：取数固定本人本周已发日报，聚焦线索恒为「个人」
   * - AI 不可用时降级：把日报正文整体作为「已完成的工作」草稿，不阻断人工填写
   */
  async generateWeeklyDraft(
    userId: string,
    opts: { periodStart?: string; projectId?: string; departmentId?: string },
  ) {
    const base = opts.periodStart ? new Date(opts.periodStart) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    const sunday = new Date(monday.getTime() + 7 * 86400000 - 1);

    const [user, dailies] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      this.prisma.report.findMany({
        where: { type: ReportType.DAILY, ownerId: userId, status: ReportStatus.PUBLISHED, periodStart: { gte: monday, lt: sunday } },
        orderBy: { periodStart: 'asc' },
      }),
    ]);
    const scopeLabel = '个人';

    const dayLines: string[] = [];
    for (const d of dailies) {
      const body = this.reportBody(d);
      if (body) dayLines.push(`【${fmtBeijingDate(d.periodStart)}】\n${body}`);
    }
    if (!dayLines.length) {
      throw new BadRequestException(`本周（${beijingMondayDate(monday)} 起）还没有已提交的日报，无法由日报生成，请手写或先补交日报`);
    }

    let aiResult: any = null;
    try {
      aiResult = await this.ai.generateJson<any>('report.weekly.draft', {
        userName: user?.name ?? '我',
        periodStart: beijingMondayDate(monday),
        periodEnd: fmtBeijingDate(sunday),
        scopeLabel,
        dailyEntries: dayLines.join('\n\n').slice(0, 12000),
      });
    } catch (e) {
      this.logger.error(`周报草稿 AI 生成失败`, e as Error);
    }
    if (!aiResult || !Array.isArray(aiResult.sections)) {
      // 降级：不阻断使用，日报原文整体作为「已完成的工作」草稿供人工整理
      return {
        ok: false,
        reason: 'AI 暂不可用，已把本周日报原文填入草稿，请自行整理后提交',
        weekLabel: `${beijingMondayDate(monday)} 起本周`,
        dailyCount: dayLines.length,
        done: dayLines.join('\n\n'),
        plan: '',
        issue: '',
      };
    }
    const pick = (kw: string) => {
      const sec = aiResult.sections.find((s: any) => String(s?.title ?? '').includes(kw));
      const items = Array.isArray(sec?.items) ? sec.items : [];
      return items.map((x: any) => (typeof x === 'string' ? x : String(x?.text ?? ''))).filter((l: string) => l.trim()).join('\n');
    };
    return {
      ok: true,
      weekLabel: `${beijingMondayDate(monday)} 起本周`,
      dailyCount: dayLines.length,
      summary: String(aiResult.summary ?? '').trim(),
      done: pick('完成'),
      plan: pick('计划'),
      issue: pick('协调'),
    };
  }

  /**
   * 我的工时卡（首页顶部横幅）：只统计本人已发布日报的 hours。
   * 口径：本周=北京周一起（与周报同周口径）；本月=自然月；累计=从首篇打卡日报至今。
   * 无数据均为 0，不报错（首页常驻卡片，宁缺毋断）。
   */
  async myHoursSummary(userId: string) {
    const rows = await this.prisma.report.findMany({
      where: { ownerId: userId, type: 'DAILY', status: ReportStatus.PUBLISHED },
      select: { periodStart: true, hours: true },
      orderBy: { periodStart: 'asc' },
    });
    const dayOf = (d: Date) => new Date(`${fmtBeijingDate(d)}T00:00:00+08:00`);
    const nowBj = dayOf(new Date());
    const weekStart = beijingMondayOf(new Date());
    const monthStart = new Date(`${fmtBeijingDate(new Date()).slice(0, 7)}-01T00:00:00+08:00`);
    let week = 0;
    let month = 0;
    let total = 0;
    let weekDays = 0;
    let monthDays = 0;
    for (const r of rows) {
      const h = Number(r.hours);
      if (!Number.isFinite(h) || h <= 0) continue;
      const v = Math.min(24, h);
      const day = dayOf(r.periodStart);
      total += v;
      if (day >= weekStart && day <= nowBj) {
        week += v;
        weekDays += 1;
      }
      if (day >= monthStart && day <= nowBj) {
        month += v;
        monthDays += 1;
      }
    }
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return {
      weekHours: r1(week),
      monthHours: r1(month),
      totalHours: r1(total),
      weekDays,
      monthDays,
      totalDays: rows.filter((r) => Number(r.hours) > 0).length,
      firstWorkDay: rows.length ? fmtBeijingDate(rows[0].periodStart) : null,
    };
  }

  /**
   * 手写周报弹窗的下拉数据源：本人可归属的项目（负责∩未归档）与部门（主部门+额外加入），及本周周次标注
   */
  async weeklyComposeOptions(me: { id: string; role: string }) {
    const now = new Date();
    const [projects, user] = await Promise.all([
      this.prisma.project.findMany({
        where: { archived: false, OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findUnique({
        where: { id: me.id },
        select: {
          departmentId: true,
          department: { select: { id: true, name: true } },
          extraDepartments: { select: { id: true, name: true } },
        },
      }),
    ]);
    const deptMap = new Map<string, string>();
    if (user?.departmentId) deptMap.set(user.departmentId, user.department?.name ?? user.departmentId);
    for (const d of user?.extraDepartments ?? []) deptMap.set(d.id, d.name);
    return {
      isoWeek: isoWeekOf(now),
      weekLabel: cnWeekLabel(now),
      weekDate: beijingMondayDate(now),
      projects,
      departments: [...deptMap.entries()].map(([id, name]) => ({ id, name })),
    };
  }

  /** 简单字符串哈希（FNV-1a，36 进制）——用于公司聚合缓存 key 的参与人签名 */
  private fnvHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /** 公司/部门聚合的可选参会人候选集（ADMIN=全司活跃；负责人=其可见集合） */
  private async listAggregateCandidates(visible: { all: boolean; ids: string[] }) {
    const where = visible.all ? { active: true } : { id: { in: visible.ids } };
    return this.prisma.user.findMany({
      where,
      select: { id: true, name: true, avatar: true, departmentId: true, department: { select: { name: true } } },
      orderBy: [{ department: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
  }

  /**
   * 公司/部门周报聚合：勾选参会人（不传=可见范围内全部），取其本周（含补发）的个人周报，按成员归属自动汇集直排 sections
   * - 新周报一人本周仅一份（个人）；旧的多归属行（项目/部门）仍拼接并标注归属以只读兼容
   * - 排序：部门负责人优先 → 其余按部门名→姓名；无周报者置底
   */
  async weeklyAggregate(
    me: { id: string; role: string },
    opts: { periodStart?: string; participantIds?: string[] },
  ) {
    const base = opts.periodStart ? new Date(opts.periodStart) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    const bjDate = beijingMondayDate(monday);

    const visible = await this.visibleOwnerIds(me);
    const poolUsers = await this.listAggregateCandidates(visible);
    const poolIds = new Set(poolUsers.map((u) => u.id));
    const requested = Array.from(new Set((opts.participantIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)));
    const targetIds = requested.length ? requested.filter((id) => poolIds.has(id)) : [...poolIds];

    const [users, reports, ledDepts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, name: true, avatar: true, departmentId: true, department: { select: { name: true } } },
      }),
      this.prisma.report.findMany({ where: { type: ReportType.WEEKLY, ownerId: { in: targetIds }, periodStart: monday } }),
      // 部门管理权限（负责人 ∪ 共管人）：共管人与负责人同档，聚合周报的档位排序不能只认负责人
      this.prisma.department.findMany({
        where: { OR: [{ leaderId: { in: targetIds } }, { managerIds: { hasSome: targetIds } }] },
        select: { leaderId: true, managerIds: true, name: true, sortOrder: true },
      }),
    ]);

    // 归属名称解析（P: 用 report.projectId，D: 用 report.departmentId）
    const projIds = Array.from(new Set(reports.filter((r) => r.scopeKey?.startsWith('P:')).map((r) => r.projectId).filter(Boolean))) as string[];
    const deptIds = Array.from(new Set(reports.filter((r) => r.scopeKey?.startsWith('D:')).map((r) => r.departmentId).filter(Boolean))) as string[];
    const projName = new Map<string, string>();
    const deptName = new Map<string, string>();
    if (projIds.length) {
      const rows = await this.prisma.project.findMany({ where: { id: { in: projIds } }, select: { id: true, name: true } });
      for (const r of rows) projName.set(r.id, r.name);
    }
    if (deptIds.length) {
      const rows = await this.prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } });
      for (const r of rows) deptName.set(r.id, r.name);
    }

    // 部门管理者映射：userId -> 最小 sortOrder（代表档位）
    const leaderOrder = new Map<string, number>();
    for (const d of ledDepts) {
      for (const uid of deptAuthorityIds(d)) {
        const cur = leaderOrder.get(uid);
        if (cur === undefined || d.sortOrder < cur) leaderOrder.set(uid, d.sortOrder);
      }
    }

    const byOwner = new Map<string, any[]>();
    for (const r of reports) {
      const oid = r.ownerId as string;
      const arr = byOwner.get(oid);
      if (arr) arr.push(r);
      else byOwner.set(oid, [r]);
    }

    const ranked = users
      .map((u) => {
        const list = byOwner.get(u.id) ?? [];
        const parts: string[] = [];
        let anyAi = false;
        for (const r of list) {
          const body = this.reportBody(r);
          if (!body) continue;
          if (String(r.correctedContent ?? '').trim()) anyAi = true;
          let tag = '';
          if (r.scopeKey?.startsWith('P:') && r.projectId) tag = `【项目·${projName.get(r.projectId) ?? r.projectId}】\n`;
          else if (r.scopeKey?.startsWith('D:') && r.departmentId) tag = `【部门·${deptName.get(r.departmentId) ?? r.departmentId}】\n`;
          parts.push(`${tag}${body}`);
        }
        const content = parts.join('\n\n');
        const submitted = !!content;
        const isLeader = leaderOrder.has(u.id);
        return {
          userId: u.id,
          name: u.name,
          avatar: u.avatar ?? null,
          departmentName: u.department?.name ?? null,
          roleTag: isLeader ? 'DEPT_LEADER' : 'MEMBER',
          submitted,
          source: submitted ? (anyAi ? 'AI' : 'MANUAL') : null,
          content,
          isSelf: u.id === me.id,
          _tier: isLeader ? 1 : 3,
          _deptOrder: leaderOrder.get(u.id) ?? 9999,
          _deptName: u.department?.name ?? '',
        };
      })
      .sort((a, b) => {
        if (a.submitted !== b.submitted) return a.submitted ? -1 : 1;
        if (a._tier !== b._tier) return a._tier - b._tier;
        if (a._tier === 1 && a._deptOrder !== b._deptOrder) return a._deptOrder - b._deptOrder;
        const d = String(a._deptName).localeCompare(String(b._deptName), 'zh-Hans-CN');
        return d !== 0 ? d : String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
      });

    const submitted = ranked.filter((s) => s.submitted).length;
    const total = ranked.length;
    const sections = ranked.map(({ _tier, _deptOrder, _deptName, ...rest }) => rest);
    const signature = this.fnvHash([...targetIds].sort().join(','));
    const summary = await this.getCachedAggregateSummary(bjDate, signature);

    return {
      scope: 'COMPANY',
      periodStart: monday,
      weekLabel: `${cnWeekLabel(monday)} · ${isoWeekOf(monday)}`,
      weekDate: bjDate,
      total,
      readiness: { total, submitted, missing: total - submitted },
      summary,
      signature,
      candidates: poolUsers.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar ?? null, departmentName: u.department?.name ?? null, selected: targetIds.includes(u.id) })),
      sections,
    };
  }

  private aggregateSummaryKey(bjDate: string, signature: string) {
    return `companyWeeklySummary:${bjDate}:${signature}`;
  }

  private async getCachedAggregateSummary(bjDate: string, signature: string) {
    const row = await this.prisma.setting.findUnique({ where: { key: this.aggregateSummaryKey(bjDate, signature) } });
    return (row?.value as { summary?: unknown } | undefined)?.summary ?? null;
  }

  /**
   * 公司/部门周报 AI 总结（复用 project.weekly.summary 提示词），结果缓存在 Setting
   * - refresh=false 且有缓存直接返回；AI 不可用/无正文 → { ok:false }（前端降级）
   */
  async weeklyAggregateSummary(
    me: { id: string; role: string },
    opts: { periodStart?: string; participantIds?: string[] },
    refresh = false,
  ) {
    const agg = await this.weeklyAggregate(me, opts);
    if (!refresh && agg.summary) return { ok: true, cached: true, summary: agg.summary };

    let reportsText = '';
    const missing: string[] = [];
    for (const s of agg.sections as any[]) {
      const dept = s.departmentName ?? '未分组';
      if (!s.submitted || !s.content) {
        missing.push(`${s.name}（${dept}）`);
        continue;
      }
      const line = `【${s.name}｜${dept}】\n${String(s.content).slice(0, 1200)}`;
      if (reportsText.length >= 9000) break;
      reportsText = reportsText ? `${reportsText}\n\n${line}` : line;
    }
    if (!reportsText) {
      return { ok: false, summary: null, reason: missing.length ? '本周尚无人提交周报，无法总结' : '本周暂无周报' };
    }

    const ai = await this.ai.generateJson<Record<string, unknown>>('project.weekly.summary', {
      projectName: '公司/部门周报',
      weekLabel: agg.weekLabel,
      reports: reportsText,
      missing: missing.join('、') || '（无，全员已提交）',
    });
    if (!ai) return { ok: false, summary: null, reason: 'AI 总结生成失败，可直接阅读下方成员周报' };

    const key = this.aggregateSummaryKey(agg.weekDate, agg.signature);
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: { summary: ai, generatedAt: new Date().toISOString() } as any },
      update: { value: { summary: ai, generatedAt: new Date().toISOString() } as any },
    });
    this.logger.log(`公司/部门周报 AI 总结完成 week=${agg.weekDate} 已交${agg.readiness.submitted}/共${agg.readiness.total}`);
    return { ok: true, cached: false, summary: ai };
  }

  // ---- 数据聚合 ----

  private async collectActivities(ownerId: string, start: Date, end: Date) {
    return this.prisma.taskActivity.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        ...(ownerId !== 'team'
          ? { OR: [{ userId: ownerId }, { task: { assigneeId: ownerId } }] }
          : {}),
      },
      include: {
        task: {
          select: {
            title: true,
            status: true,
            priority: true,
            project: { select: { name: true } },
          },
        },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  private async collectMessages(start: Date, end: Date) {
    return this.prisma.messageInbox.findMany({
      where: { receivedAt: { gte: start, lt: end } },
      orderBy: { receivedAt: 'asc' },
      take: 1000,
    });
  }

  private formatActivities(activities: any[], isTeam: boolean) {
    const lines = activities.map((a) => {
      const who = isTeam ? `${a.user?.name ?? '某人'}:` : '';
      const actionMap: Record<string, string> = {
        created: '创建任务',
        updated: '更新任务',
        status_changed: '变更状态',
        moved: '移动任务',
        commented: '评论任务',
        completed: '完成任务',
      };
      return `- ${who}${actionMap[a.action] ?? a.action}「${a.task?.title ?? ''}」(${a.task?.project?.name ?? ''})`;
    });
    return lines.join('\n');
  }

  private formatMessages(messages: any[]) {
    // 按群聚合，输出群名+条数，并附上代表文本（截断）
    const byGroup = new Map<string, { name: string; count: number; samples: string[] }>();
    for (const m of messages) {
      const key = m.conversationId ?? 'unknown';
      const g = byGroup.get(key) ?? {
        name: m.conversationName ?? '群聊',
        count: 0,
        samples: [] as string[],
      };
      g.count += 1;
      if (g.samples.length < 3 && m.content) g.samples.push(m.content.slice(0, 80));
      byGroup.set(key, g);
    }
    const lines = [...byGroup.values()].map(
      (g) => `- 【${g.name}】${g.count} 条消息${g.samples.length ? `：${g.samples.join(' / ')}` : ''}`,
    );
    return lines.join('\n');
  }
}
