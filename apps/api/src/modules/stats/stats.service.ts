import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ledDeptWhere } from '../../common/dept-authority';
import { rankExcludedUserIds } from '../../common/rank-exclude';

type Scope = 'dept' | 'project' | 'user';
type Period = 'week' | 'month' | 'quarter';

interface DashRow {
  id: string;
  name: string;
  sub: string | null; // 部门视角=负责人 / 项目视角=负责人 / 人员视角=部门名
  memberCount: number;
  projectCount: number | string | null; // 部门视角=项目数；项目视角=关联部门名（逗号分隔）；人员视角=null
  taskTotal: number;
  taskDone: number;
  taskOverdue: number;
  reportCount: number;
  hours: number;
  lastActivityAt: string | null; // 最近一次进展/日报时间
}

/** 全公司数据缓存（5 分钟）：key = scope:period，仅 ADMIN 视角缓存，避免每次实时聚合 */
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 北京时区（UTC+8）下的周期起止 */
function periodRange(period: Period): { gte: Date; lt: Date; label: string } {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // 北京墙钟
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const dow = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  const monday = new Date(Date.UTC(y, m, now.getUTCDate() - dow + 1));
  if (period === 'week') {
    return { gte: monday, lt: new Date(monday.getTime() + 7 * 86400000), label: '本周' };
  }
  if (period === 'month') {
    return { gte: new Date(Date.UTC(y, m, 1)), lt: new Date(Date.UTC(y, m + 1, 1)), label: '本月' };
  }
  const qStartMonth = Math.floor(m / 3) * 3;
  return {
    gte: new Date(Date.UTC(y, qStartMonth, 1)),
    lt: new Date(Date.UTC(y, qStartMonth + 3, 1)),
    label: '本季度',
  };
}

@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async dashboard(me: { id: string; role: string }, scopeRaw?: string, periodRaw?: string) {
    const scope: Scope = scopeRaw === 'dept' || scopeRaw === 'user' ? scopeRaw : 'project';
    const period: Period = periodRaw === 'week' || periodRaw === 'month' || periodRaw === 'quarter' ? periodRaw : 'week';
    const isAdmin = me.role === 'ADMIN';

    // 全公司数据缓存（管理员看的就是全公司口径）
    const cacheKey = `full:${scope}:${period}`;
    if (isAdmin) {
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
    }

    const { gte, lt, label } = periodRange(period);
    const excluded = await rankExcludedUserIds(this.prisma);

    // ---- 管理范围解析 ----
    // 部门：管理员=全部；部门负责人/共管人=管辖部门；普通成员=所在部门
    let deptIds: string[] | null = null; // null=全部
    let ledDeptIds: string[] = []; // 我管辖的部门（负责人/共管人）
    if (!isAdmin) {
      const [led, memberOf] = await Promise.all([
        this.prisma.department.findMany({ where: ledDeptWhere(me.id), select: { id: true } }),
        this.prisma.department.findMany({ where: { members: { some: { id: me.id } } }, select: { id: true } }),
      ]);
      ledDeptIds = led.map((d) => d.id);
      deptIds = [...new Set([...ledDeptIds, ...memberOf.map((d) => d.id)])];
      if (!deptIds.length) deptIds = ['__none__'];
    }
    // 项目：管理员=全部；负责人/共管人=管辖部门关联项目∪自己的项目；普通成员=自己的项目
    let projectIds: string[] | null = null; // null=全部
    if (!isAdmin) {
      const own = await this.prisma.project.findMany({
        where: { deletedAt: null, OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
        select: { id: true },
      });
      const ownIds = own.map((p) => p.id);
      const deptLinked = ledDeptIds.length
        ? await this.prisma.projectDepartment.findMany({ where: { departmentId: { in: ledDeptIds } }, select: { projectId: true } })
        : [];
      projectIds = [...new Set([...ownIds, ...deptLinked.map((l) => l.projectId)])];
      if (!projectIds.length) projectIds = ['__none__'];
    }

    let rows: DashRow[];
    if (scope === 'dept') rows = await this.deptRows(gte, lt, deptIds, excluded);
    else if (scope === 'project') rows = await this.projectRows(gte, lt, projectIds, excluded);
    else rows = await this.userRows(gte, lt, me, isAdmin, deptIds, excluded);

    const data = { scope, period, periodLabel: label, isAdmin, rows };
    if (isAdmin) cache.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  /** 一段时间内某组用户的日报数与工时（不含只看不排的成员） */
  private async reportAgg(userIds: string[], gte: Date, lt: Date) {
    if (!userIds.length) return new Map<string, { count: number; hours: number }>();
    const reports = await this.prisma.report.findMany({
      where: { type: 'DAILY', status: 'PUBLISHED', ownerId: { in: userIds }, periodStart: { gte, lt } },
      select: { ownerId: true, hours: true },
    });
    const agg = new Map<string, { count: number; hours: number }>();
    for (const r of reports) {
      if (!r.ownerId) continue;
      const a = agg.get(r.ownerId) ?? { count: 0, hours: 0 };
      a.count += 1;
      if (typeof r.hours === 'number' && Number.isFinite(r.hours) && r.hours > 0) a.hours += r.hours;
      agg.set(r.ownerId, a);
    }
    return agg;
  }

  /** 任务聚合：全量完成率 + 当前逾期（dueDate 已过且未完成）；keyOf 决定归到部门/项目/人员 */
  private taskAgg<T extends { status: string; dueDate: Date | null }>(tasks: T[], keyOf: (t: T) => string | null) {
    const agg = new Map<string, { total: number; done: number; overdue: number }>();
    const now = new Date();
    for (const t of tasks) {
      const k = keyOf(t);
      if (!k) continue;
      const a = agg.get(k) ?? { total: 0, done: 0, overdue: 0 };
      a.total += 1;
      if (t.status === 'DONE') a.done += 1;
      else if (t.dueDate && t.dueDate < now) a.overdue += 1;
      agg.set(k, a);
    }
    return agg;
  }

  /** 最近活动（进展/日报）时间 */
  private async lastActivityAgg(projectIds: string[], userIds: string[]) {
    const [upd, rep] = await Promise.all([
      projectIds.length
        ? this.prisma.projectUpdate.findMany({
            where: { projectId: { in: projectIds } },
            orderBy: { createdAt: 'desc' },
            take: 500,
            select: { projectId: true, createdAt: true },
          })
        : Promise.resolve([] as { projectId: string; createdAt: Date }[]),
      userIds.length
        ? this.prisma.report.findMany({
            where: { ownerId: { in: userIds }, type: 'DAILY' },
            orderBy: { createdAt: 'desc' },
            take: 500,
            select: { ownerId: true, projectId: true, createdAt: true },
          })
        : Promise.resolve([] as { ownerId: string | null; projectId: string | null; createdAt: Date }[]),
    ]);
    // 回传原始明细，由各视角自行归组
    return { updates: upd, reports: rep };
  }

  // ============ 按部门 ============
  private async deptRows(gte: Date, lt: Date, deptIds: string[] | null, excluded: Set<string>): Promise<DashRow[]> {
    const depts = await this.prisma.department.findMany({
      where: deptIds ? { id: { in: deptIds } } : {},
      select: {
        id: true,
        name: true,
        leader: { select: { name: true } },
        members: { select: { id: true } },
        projectLinks: { select: { projectId: true } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    if (!depts.length) return [];
    const deptUserIds = depts.map((d) => d.members.map((m) => m.id).filter((id) => !excluded.has(id)));
    const allUserIds = [...new Set(deptUserIds.flat())];
    const linkProjectIds = [...new Set(depts.flatMap((d) => d.projectLinks.map((l) => l.projectId)))];

    const [reportAggMap, tasks, { updates, reports: recentReports }] = await Promise.all([
      this.reportAgg(allUserIds, gte, lt),
      linkProjectIds.length
        ? this.prisma.task.findMany({
            where: { project: { deletedAt: null, id: { in: linkProjectIds } } },
            select: { assigneeId: true, status: true, dueDate: true, projectId: true },
          })
        : Promise.resolve([] as { assigneeId: string | null; status: string; dueDate: Date | null; projectId: string }[]),
      this.lastActivityAgg(linkProjectIds, allUserIds),
    ]);

    // 项目 → 部门映射（一项目多部门时算首个关联部门，排行不重复计）
    const deptIdSet = new Set(depts.map((d) => d.id));
    const projToDept = new Map<string, string>();
    const links = await this.prisma.projectDepartment.findMany({
      where: { projectId: { in: linkProjectIds }, departmentId: { in: [...deptIdSet] } },
      orderBy: { createdAt: 'asc' },
      select: { projectId: true, departmentId: true },
    });
    for (const l of links) if (!projToDept.has(l.projectId)) projToDept.set(l.projectId, l.departmentId);

    const taskByKey = this.taskAgg(tasks, (t) => projToDept.get(t.projectId) ?? null);
    const updByDept = new Map<string, Date>();
    for (const u of updates) {
      const d = projToDept.get(u.projectId);
      if (!d) continue;
      const prev = updByDept.get(d);
      if (!prev || u.createdAt > prev) updByDept.set(d, u.createdAt);
    }
    const repByDept = new Map<string, Date>();
    const userIdToDept = new Map<string, string>();
    depts.forEach((d, i) => deptUserIds[i].forEach((id) => userIdToDept.set(id, d.id)));
    for (const r of recentReports) {
      if (!r.ownerId) continue;
      const d = userIdToDept.get(r.ownerId);
      if (!d) continue;
      const prev = repByDept.get(d);
      if (!prev || r.createdAt > prev) repByDept.set(d, r.createdAt);
    }

    return depts.map((d) => {
      const uids = deptUserIds[depts.indexOf(d)];
      const rep = { count: 0, hours: 0 };
      for (const id of uids) {
        const a = reportAggMap.get(id);
        if (a) {
          rep.count += a.count;
          rep.hours += a.hours;
        }
      }
      const t = taskByKey.get(d.id) ?? { total: 0, done: 0, overdue: 0 };
      const last = [updByDept.get(d.id), repByDept.get(d.id)].filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null;
      return {
        id: d.id,
        name: d.name,
        sub: d.leader?.name ?? null,
        memberCount: uids.length,
        projectCount: d.projectLinks.length,
        taskTotal: t.total,
        taskDone: t.done,
        taskOverdue: t.overdue,
        reportCount: rep.count,
        hours: round1(rep.hours),
        lastActivityAt: last ? last.toISOString() : null,
      };
    });
  }

  // ============ 按项目 ============
  private async projectRows(gte: Date, lt: Date, projectIds: string[] | null, excluded: Set<string>): Promise<DashRow[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        ...(projectIds ? { id: { in: projectIds } } : {}),
      },
      select: {
        id: true,
        name: true,
        color: true,
        ownerId: true,
        owner: { select: { name: true } },
        members: { select: { userId: true } },
        departments: { select: { department: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!projects.length) return [];
    const ids = projects.map((p) => p.id);
    const projUserIds = projects.map((p) => [...new Set([p.ownerId, ...p.members.map((m) => m.userId)])].filter((id) => !excluded.has(id)));
    const allUserIds = [...new Set(projUserIds.flat())];

    const [reportAggMap, tasks, { updates }] = await Promise.all([
      this.reportAgg(allUserIds, gte, lt),
      this.prisma.task.findMany({
        where: { projectId: { in: ids } },
        select: { assigneeId: true, status: true, dueDate: true, projectId: true },
      }),
      this.lastActivityAgg(ids, []),
    ]);

    const taskByKey = this.taskAgg(tasks, (t) => t.projectId);
    const updByProj = new Map<string, Date>();
    for (const u of updates) {
      const prev = updByProj.get(u.projectId);
      if (!prev || u.createdAt > prev) updByProj.set(u.projectId, u.createdAt);
    }
    // 项目日报按 report.projectId 归（无法归属的忽略）
    const repByProjAgg = new Map<string, { count: number; hours: number }>();
    const periodReports = await this.prisma.report.findMany({
      where: { type: 'DAILY', status: 'PUBLISHED', projectId: { in: ids }, periodStart: { gte, lt }, ownerId: { notIn: [...excluded] } },
      select: { projectId: true, hours: true },
    });
    for (const r of periodReports) {
      if (!r.projectId) continue;
      const a = repByProjAgg.get(r.projectId) ?? { count: 0, hours: 0 };
      a.count += 1;
      if (typeof r.hours === 'number' && Number.isFinite(r.hours) && r.hours > 0) a.hours += r.hours;
      repByProjAgg.set(r.projectId, a);
    }

    return projects.map((p) => {
      const t = taskByKey.get(p.id) ?? { total: 0, done: 0, overdue: 0 };
      const rep = repByProjAgg.get(p.id) ?? { count: 0, hours: 0 };
      const lastUpd = updByProj.get(p.id) ?? null;
      return {
        id: p.id,
        name: p.name,
        sub: p.owner?.name ?? null,
        memberCount: projUserIds[projects.indexOf(p)].length,
        projectCount: p.departments.map((d) => d.department.name).join('、') || null,
        taskTotal: t.total,
        taskDone: t.done,
        taskOverdue: t.overdue,
        reportCount: rep.count,
        hours: round1(rep.hours),
        lastActivityAt: lastUpd ? lastUpd.toISOString() : null,
      };
    });
  }

  // ============ 按人员 ============
  private async userRows(
    gte: Date,
    lt: Date,
    me: { id: string; role: string },
    isAdmin: boolean,
    deptIds: string[] | null,
    excluded: Set<string>,
  ): Promise<DashRow[]> {
    // 管理员=全体；部门负责人=管辖部门成员；普通成员=本部门同事 + 自己
    let userIds: string[] | null = null;
    if (!isAdmin) {
      const users = await this.prisma.user.findMany({
        where: deptIds && deptIds[0] !== '__none__' ? { departmentId: { in: deptIds }, active: true } : { id: me.id },
        select: { id: true },
      });
      userIds = [...new Set([...users.map((u) => u.id), me.id])];
    }
    const users = await this.prisma.user.findMany({
      where: { active: true, ...(userIds ? { id: { in: userIds } } : {}) },
      select: { id: true, name: true, avatar: true, department: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!users.length) return [];
    const ids = users.map((u) => u.id);

    const [reportAggMap, tasks, lastDailies] = await Promise.all([
      this.reportAgg(ids, gte, lt),
      this.prisma.task.findMany({
        where: { assigneeId: { in: ids }, project: { deletedAt: null } },
        select: { assigneeId: true, status: true, dueDate: true, projectId: true },
      }),
      this.prisma.report.findMany({
        where: { ownerId: { in: ids }, type: 'DAILY' },
        orderBy: { periodStart: 'desc' },
        distinct: ['ownerId'],
        select: { ownerId: true, periodStart: true },
      }),
    ]);
    const lastDailyMap = new Map(lastDailies.filter((r) => r.ownerId).map((r) => [r.ownerId as string, r.periodStart]));
    const taskByKey = this.taskAgg(tasks, (t) => t.assigneeId);

    return users
      .filter((u) => !excluded.has(u.id))
      .map((u) => {
        const t = taskByKey.get(u.id) ?? { total: 0, done: 0, overdue: 0 };
        const rep = reportAggMap.get(u.id) ?? { count: 0, hours: 0 };
        const lastDaily = lastDailyMap.get(u.id) ?? null;
        return {
          id: u.id,
          name: u.name,
          sub: u.department?.name ?? null,
          memberCount: 0,
          projectCount: null,
          taskTotal: t.total,
          taskDone: t.done,
          taskOverdue: t.overdue,
          reportCount: rep.count,
          hours: round1(rep.hours),
          lastActivityAt: lastDaily ? lastDaily.toISOString() : null,
        };
      });
  }
}
