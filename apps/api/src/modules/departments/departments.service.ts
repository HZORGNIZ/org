import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { deptAuthorityIds, isDeptAuthority, ledDeptWhere, deptRosterWhere, pickDefaultManager } from '../../common/dept-authority';
import { dailyExcerpt } from '../../common/daily-body';
import { CN_OFFSET_MS, fmtBeijingDate } from '../../common/beijing-time';
import { slotRangeLabel, slotsHours } from '../../common/work-slots';

/** 日报频率合法值（feature 3） */
const REPORT_FREQS = ['NONE', 'DAILY', 'WORKDAY', 'WEEKLY_COUNT'];
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 岗位清单默认值（Setting key=positions 不存在时） */
export const DEFAULT_POSITIONS = ['产品经理', '工程师', '运维'];

@Injectable()
export class DepartmentsService {
  constructor(private prisma: PrismaService) {}

  /** 部门列表（含负责人/共管人与项目/成员/文档数），按 sortOrder 再按创建时间 */
  async list() {
    const depts = await this.prisma.department.findMany({
      include: {
        leader: { select: { id: true, name: true } },
        _count: { select: { projectLinks: true, members: true, docs: true, files: true, folders: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    // managerIds 是标量数组（无关系字段），姓名在这里批量解析一次，不逐部门查
    const mgrIds = [...new Set(depts.flatMap((d) => d.managerIds ?? []))];
    const mgrs = mgrIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: mgrIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(mgrs.map((u) => [u.id, u.name]));
    return depts.map((d) => ({
      ...d,
      managerNames: (d.managerIds ?? []).map((id) => nameById.get(id) ?? '').filter(Boolean),
    }));
  }

  /** 首页「我的部门情况」：当前用户所在部门概况（主部门优先，无主部门时回退额外部门）；未归属返回 null */
  async myStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { departmentId: true, extraDepartments: { select: { id: true } } },
    });
    const ids = [
      ...new Set([user?.departmentId, ...(user?.extraDepartments ?? []).map((d) => d.id)].filter((x): x is string => Boolean(x))),
    ];
    if (!ids.length) return null;
    // 只在额外部门里的人（主部门为空）以前会被当成「尚未归属部门」，这里按 sortOrder 取第一个部门为代表
    const ordered = await this.prisma.department.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (!ordered.length) return null;
    const base = await this.statusOf(ordered[0].id);
    if (!base) return null;
    return { ...base, departments: ordered };
  }

  /** 单个部门概况：名称/描述/负责人/共管人/项目数/成员数/文档数/上传文件数 */
  async statusOf(departmentId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      include: {
        leader: { select: { id: true, name: true } },
        _count: { select: { projectLinks: true, members: true, docs: true, files: true, folders: true } },
      },
    });
    if (!dept) return null;
    return {
      id: dept.id,
      name: dept.name,
      description: dept.description,
      leader: dept.leader,
      managers: await this.resolveManagers(dept.managerIds ?? []),
      projectCount: dept._count.projectLinks,
      memberCount: dept._count.members,
      docCount: dept._count.docs,
      fileCount: dept._count.files,
      folderCount: dept._count.folders,
    };
  }

  /** 按名单顺序解析共管人（名单顺序即管理员的排序意图，不能按 createdAt 重排） */
  private async resolveManagers(ids: string[]) {
    if (!ids.length) return [] as { id: string; name: string; avatar: string | null }[];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatar: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return ids
      .map((id) => byId.get(id))
      .filter((u): u is { id: string; name: string; avatar: string | null } => Boolean(u));
  }

  /**
   * 部门详情：基本信息 + 成员（备注 + 最近进展） + 部门在跑的项目（仅人工「主要关联」 + 成员名单）
   * 可见性：管理员/部门管理者（负责人 ∪ 共管人）看任意部门；普通成员看自己所在部门（主 ∪ 额外）
   * 项目口径（165 改回）：只取 ProjectDepartment 人工关联。
   * 曾用并集口径（名册成员参与的项目也带入）：跨部门挂靠的负责人会把不相干项目灌进每个所属部门，已废弃。
   */
  async detail(id: string, me: { id: string; role: string; departmentId?: string | null }) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      include: {
        leader: { select: { id: true, name: true } },
        _count: { select: { projectLinks: true, members: true, docs: true, files: true, folders: true } },
      },
    });
    if (!dept) throw new NotFoundException('部门不存在');
    const canManage = me.role === Role.ADMIN || isDeptAuthority(dept, me.id);
    if (!canManage) {
      // 主部门未命中时，回退查「额外部门」成员资格（一人可属多部门）
      const isMember = (await this.prisma.user.count({ where: { id: me.id, ...deptRosterWhere(id) } })) > 0;
      if (!isMember) throw new ForbiddenException('仅可查看自己所在部门');
    }
    // 时间口径与 reportStatus 一致：本地零点/本地周一（periodStart 存的就是服务器本地零点）
    const now = new Date();
    const todayKey = new Date(now);
    todayKey.setHours(0, 0, 0, 0);
    const dayIdx = (todayKey.getDay() + 6) % 7;
    const mondayLocal = new Date(todayKey);
    mondayLocal.setDate(todayKey.getDate() - dayIdx);
    const recentStart = new Date(todayKey);
    recentStart.setDate(todayKey.getDate() - 59); // 最近进展回看 60 天，够覆盖「本周 + 上次写日报」

    const members = await this.prisma.user.findMany({
      where: deptRosterWhere(id),
      select: {
        id: true,
        name: true,
        avatar: true,
        role: true,
        ledDepartments: { select: { id: true }, where: { id } },
        projectMembers: {
          select: { position: true, project: { select: { id: true, name: true, archived: true } } },
          where: { project: { archived: false } },
        },
        notesReceived: {
          where: { departmentId: id },
          select: { note: true, author: { select: { name: true } }, updatedAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const rosterIds = members.map((m) => m.id);
    const rosterSet = new Set(rosterIds);

    const [links, reports] = await Promise.all([
      this.prisma.projectDepartment.findMany({
        where: { departmentId: id },
        select: { projectId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      // 成员最近进展：一次批量取近 60 天日报，本周篇数/今日是否已写/最近一篇正文都从这份算，不逐人查
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: { in: rosterIds }, periodStart: { gte: recentStart } },
        select: { ownerId: true, periodStart: true, hours: true, correctedContent: true, rawContent: true, manualContent: true },
        orderBy: { periodStart: 'desc' },
      }),
    ]);

    const lastBy = new Map<string, (typeof reports)[number]>();
    const weekCount = new Map<string, number>();
    const wroteToday = new Set<string>();
    for (const r of reports) {
      if (!r.ownerId) continue;
      if (!lastBy.has(r.ownerId)) lastBy.set(r.ownerId, r);
      if (r.periodStart && r.periodStart.getTime() >= mondayLocal.getTime()) {
        weekCount.set(r.ownerId, (weekCount.get(r.ownerId) ?? 0) + 1);
      }
      if (r.periodStart && r.periodStart.getTime() === todayKey.getTime()) wroteToday.add(r.ownerId);
    }

    const allProjectIds = links.map((l) => l.projectId);
    const projectRows = allProjectIds.length
      ? await this.prisma.project.findMany({
          where: { id: { in: allProjectIds }, archived: false, deletedAt: null },
          select: {
            id: true,
            name: true,
            color: true,
            confidential: true,
            ownerId: true,
            createdAt: true,
            owner: { select: { id: true, name: true, avatar: true } },
            members: {
              select: { position: true, user: { select: { id: true, name: true, avatar: true, role: true } } },
            },
            _count: { select: { tasks: true, members: true } },
          },
        })
      : [];
    const rowById = new Map(projectRows.map((p) => [p.id, p]));
    const projects = allProjectIds
      .filter((pid) => rowById.has(pid))
      .map((pid) => {
        const p = rowById.get(pid)!;
        const inThis = p.ownerId === me.id || p.members.some((m) => m.user.id === me.id);
        // 保密项目：非该项目成员（且非管理员）看不到成员名单，只给「保密项目·仅成员可见」
        const membersHidden = p.confidential && me.role !== Role.ADMIN && !inThis;
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          confidential: p.confidential,
          owner: p.owner,
          via: 'link' as const,
          memberCount: p._count.members,
          taskCount: p._count.tasks,
          membersHidden,
          members: membersHidden
            ? []
            : p.members
                .map((m) => ({
                  id: m.user.id,
                  name: m.user.name,
                  avatar: m.user.avatar,
                  role: m.user.role,
                  position: m.position,
                  inDept: rosterSet.has(m.user.id),
                  isOwner: m.user.id === p.ownerId,
                }))
                .sort((a, b) => (a.isOwner === b.isOwner ? 0 : a.isOwner ? -1 : 1)),
        };
      });

    return {
      department: { ...dept, managers: await this.resolveManagers(dept.managerIds ?? []) },
      canManage,
      weekStart: fmtBeijingDate(mondayLocal),
      today: fmtBeijingDate(now),
      members: members.map((m) => {
        const last = lastBy.get(m.id);
        return {
          id: m.id,
          name: m.name,
          avatar: m.avatar,
          role: m.role,
          isLeader: m.ledDepartments.length > 0,
          isManager: (dept.managerIds ?? []).includes(m.id),
          projects: m.projectMembers.map((mp) => ({
            id: mp.project.id,
            name: mp.project.name,
            position: mp.position,
          })),
          note: m.notesReceived[0]?.note ?? null,
          noteBy: m.notesReceived[0]?.author?.name ?? null,
          noteAt: m.notesReceived[0]?.updatedAt ?? null,
          weekCount: weekCount.get(m.id) ?? 0,
          wroteToday: wroteToday.has(m.id),
          lastDaily: last
            ? { date: fmtBeijingDate(last.periodStart), hours: last.hours ?? null, text: dailyExcerpt(last) }
            : null,
        };
      }),
      projects,
    };
  }

  /** 编辑/删除部门成员备注：仅系统管理员或该部门管理者；note 为空则删除 */
  async setNote(
    id: string,
    operator: { id: string; role: string },
    userId: string,
    note: string,
  ) {
    await this.assertCanManageDept(id, operator);
    const trimmed = (note || '').trim();
    if (!trimmed) {
      await this.prisma.departmentMemberNote.deleteMany({ where: { departmentId: id, userId } });
      return { ok: true, note: null };
    }
    // 归属判定用名册口径（主部门 ∪ 额外部门），否则额外部门成员无法被备注
    const member = await this.prisma.user.count({ where: { id: userId, ...deptRosterWhere(id) } });
    if (!member) throw new NotFoundException('该用户不在此部门');
    const saved = await this.prisma.departmentMemberNote.upsert({
      where: { departmentId_userId: { departmentId: id, userId } },
      create: { departmentId: id, userId, note: trimmed, authorId: operator.id },
      update: { note: trimmed, authorId: operator.id },
    });
    return { ok: true, note: saved.note };
  }

  async create(data: { name: string; description?: string; sortOrder?: number }) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestException('部门名称必填');
    const exists = await this.prisma.department.findUnique({ where: { name } });
    if (exists) throw new BadRequestException('部门名称已存在');
    return this.prisma.department.create({
      data: { name, description: data.description?.trim() || null, sortOrder: data.sortOrder ?? 0 },
    });
  }

  /** 改名/描述/排序：管理员或该部门负责人 */
  async update(id: string, operator: { id: string; role: string }, data: { name?: string; description?: string; sortOrder?: number }) {
    await this.assertCanManageDept(id, operator);
    const patch: { name?: string; description?: string | null; sortOrder?: number } = {};
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('部门名称不能为空');
      const dup = await this.prisma.department.findFirst({ where: { name, NOT: { id } } });
      if (dup) throw new BadRequestException('部门名称已存在');
      patch.name = name;
    }
    if (data.description !== undefined) patch.description = data.description.trim() || null;
    if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;
    return this.prisma.department.update({ where: { id }, data: patch });
  }

  /**
   * 删除部门：仅管理员。
   * 依赖 schema 外键语义，只解除关联而不删除项目/成员本体：
   *  - 项目：ProjectDepartment 关联行随部门级联删除，项目本身保留（仅不再「主要关联」该部门）
   *  - 成员：User.departmentId onDelete=SetNull，账号保留，变为未分配部门
   *  - 负责人：Department.leaderId onDelete=SetNull，删除后若其不再负责任何部门/项目则降级为普通成员
   *  - 部门自有内容（文档/文件/文件夹/成员备注）随部门一并删除
   */
  async remove(id: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, leaderId: true, managerIds: true },
    });
    if (!dept) throw new NotFoundException('部门不存在');
    await this.prisma.department.delete({ where: { id } });
    // 原负责人/共管人若已不再领导任何部门且不负责任何项目，则降级为普通成员
    for (const uid of deptAuthorityIds(dept)) await this.maybeDowngradeDeptLeader(uid);
    return { id, deleted: true };
  }

  /**
   * 设置/取消部门负责人（管理员或该部门管理者）
   * - 设负责人：该用户 role 若为 MEMBER 升级为 DEPT_LEADER（不降级已是更高角色者），并把他从共管人名单里去重
   * - 取消/替换负责人：原负责人不再领导任何部门（含共管）、且不再负责任何项目、且当前为 DEPT_LEADER 时，降级为 MEMBER
   */
  async setLeader(id: string, operator: { id: string; role: string }, userId: string | null) {
    await this.assertCanManageDept(id, operator);
    const dept = await this.prisma.department.findUnique({ where: { id } });
    if (!dept) throw new NotFoundException('部门不存在');
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
      if (!user) throw new NotFoundException('用户不存在');
    }
    const affectedId = dept.leaderId; // 变更前负责人，用于降级判定
    await this.prisma.department.update({
      where: { id },
      // 负责人不重复出现在共管人名单里（两者同权限，同时存在只会让展示与降级判定变复杂）
      data: { leaderId: userId || null, managerIds: userId ? (dept.managerIds ?? []).filter((u) => u !== userId) : dept.managerIds },
    });

    if (userId) {
      // 升级为新负责人：仅把 MEMBER 升为 DEPT_LEADER，已是 ADMIN/PROJECT_LEADER 等更高角色者不动，
      // 否则把管理员/项目负责人设为部门负责人会误降级、丢失原有更高权限（与 setManagers 同口径）
      await this.prisma.user.updateMany({
        where: { id: userId, role: Role.MEMBER },
        data: { role: Role.DEPT_LEADER },
      });
    }
    if (affectedId && affectedId !== userId) await this.maybeDowngradeDeptLeader(affectedId);
    return this.prisma.department.findUnique({
      where: { id },
      include: { leader: { select: { id: true, name: true } } },
    });
  }

  /**
   * 设置部门共管人名单（管理员或该部门管理者）：共管人与负责人同权限，管的是整个部门。
   * 大部门（如探索研发部 56 人）一个负责人管不过来时在此增设，不按项目切分管辖范围。
   * - 候选限本部门名册（主 ∪ 额外），负责人不重复出现在名单里；
   * - 新入选且当前为 MEMBER → 升 DEPT_LEADER（否则名单里有人但 Agent 档位/前端 gating 不够，权限会漂移）；
   * - 被移出者按「不再负责任何部门（含共管）且不再 owner 任何未归档项目」降级为 MEMBER。
   */
  async setManagers(id: string, operator: { id: string; role: string }, userIds: string[]) {
    await this.assertCanManageDept(id, operator);
    const dept = await this.prisma.department.findUnique({ where: { id }, select: { id: true, leaderId: true, managerIds: true } });
    if (!dept) throw new NotFoundException('部门不存在');
    const next = [
      ...new Set(
        (userIds ?? [])
          .map((u) => String(u).trim())
          .filter((u) => u && u !== dept.leaderId),
      ),
    ];
    if (next.length) {
      const valid = await this.prisma.user.findMany({ where: { id: { in: next }, ...deptRosterWhere(id) }, select: { id: true } });
      const ok = new Set(valid.map((v) => v.id));
      if (next.some((u) => !ok.has(u))) throw new BadRequestException('共管人必须是本部门在职成员');
    }
    const prev = new Set(dept.managerIds ?? []);
    await this.prisma.department.update({ where: { id }, data: { managerIds: next } });
    const added = next.filter((u) => !prev.has(u));
    if (added.length) {
      // 只把 MEMBER 升为 DEPT_LEADER，已是 ADMIN/更高角色者不动
      await this.prisma.user.updateMany({ where: { id: { in: added }, role: Role.MEMBER }, data: { role: Role.DEPT_LEADER } });
    }
    const removed = [...prev].filter((u) => !next.includes(u) && u !== dept.leaderId);
    for (const uid of removed) await this.maybeDowngradeDeptLeader(uid);
    return { id, managerIds: next, managers: await this.resolveManagers(next) };
  }

  /** 用户若不再领导任何部门（负责人 ∪ 共管人）且不再负责任何项目、且当前为部门负责人，则降为普通成员 */
  private async maybeDowngradeDeptLeader(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || user.role !== Role.DEPT_LEADER) return;
    const stillLeading = await this.prisma.department.count({ where: ledDeptWhere(userId) });
    if (stillLeading > 0) return;
    const stillOwning = await this.prisma.project.count({ where: { ownerId: userId, archived: false } });
    if (stillOwning > 0) return;
    await this.prisma.user.update({ where: { id: userId }, data: { role: Role.MEMBER } });
  }

  /** 管理员或该部门管理者（负责人 ∪ 共管人）可管理部门 */
  private async assertCanManageDept(id: string, operator: { id: string; role: string }) {
    if (operator.role === Role.ADMIN) return;
    const dept = await this.prisma.department.findUnique({ where: { id }, select: { leaderId: true, managerIds: true } });
    if (!dept) throw new NotFoundException('部门不存在');
    if (isDeptAuthority(dept, operator.id)) return;
    throw new ForbiddenException('仅系统管理员或该部门负责人/共管人可管理此部门');
  }

  /** 我可调整的部门名册（负责人/共管人管辖的部门）：用于共管人候选与汇报关系下放的边界 */
  private async managedRosterIds(userId: string, opts?: { excludeSelf?: boolean }) {
    const depts = await this.prisma.department.findMany({ where: ledDeptWhere(userId), select: { id: true } });
    if (!depts.length) return new Set<string>();
    const members = await this.prisma.user.findMany({ where: deptRosterWhere(depts.map((d) => d.id)), select: { id: true } });
    const set = new Set(members.map((m) => m.id));
    if (opts?.excludeSelf) set.delete(userId);
    return set;
  }

  // ---------- 日报规则（feature 3：部门负责人设定成员多久写一次 + 未写提醒） ----------

  /** 读取部门日报规则（仅管理员/该部门负责人） */
  async getReportSetting(id: string, operator: { id: string; role: string }) {
    await this.assertCanManageDept(id, operator);
    const d = await this.prisma.department.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        reportFrequency: true,
        reportWeeklyCount: true,
        reportRemindTime: true,
        reportNotifyLeader: true,
      },
    });
    if (!d) throw new NotFoundException('部门不存在');
    return d;
  }

  /** 更新部门日报规则（仅管理员/该部门负责人），保存后立即生效（提醒 Worker 每小时读库） */
  async updateReportSetting(
    id: string,
    operator: { id: string; role: string },
    data: { reportFrequency?: string; reportWeeklyCount?: number | null; reportRemindTime?: string; reportNotifyLeader?: boolean },
  ) {
    await this.assertCanManageDept(id, operator);
    const patch: Record<string, any> = {};
    if (data.reportFrequency !== undefined) {
      const f = String(data.reportFrequency).trim().toUpperCase();
      if (!REPORT_FREQS.includes(f)) throw new BadRequestException('日报频率参数非法');
      patch.reportFrequency = f;
    }
    if (data.reportWeeklyCount !== undefined) {
      if (data.reportWeeklyCount === null || data.reportWeeklyCount === undefined) {
        patch.reportWeeklyCount = null;
      } else {
        const n = Number(data.reportWeeklyCount);
        if (!Number.isInteger(n) || n < 1 || n > 7) throw new BadRequestException('每周次数须为 1-7 的整数');
        patch.reportWeeklyCount = n;
      }
    }
    if (data.reportRemindTime !== undefined) {
      const t = String(data.reportRemindTime).trim();
      if (!TIME_RE.test(t)) throw new BadRequestException('提醒时间须为 HH:mm（北京时间）');
      patch.reportRemindTime = t;
    }
    if (data.reportNotifyLeader !== undefined) {
      patch.reportNotifyLeader = !!data.reportNotifyLeader;
    }
    // WEEKLY_COUNT 需有每周次数
    const current = await this.prisma.department.findUnique({
      where: { id },
      select: { reportFrequency: true, reportWeeklyCount: true },
    });
    const finalFreq = patch.reportFrequency ?? current?.reportFrequency;
    const finalCount = patch.reportWeeklyCount !== undefined ? patch.reportWeeklyCount : current?.reportWeeklyCount;
    if (finalFreq === 'WEEKLY_COUNT' && (!finalCount || finalCount < 1)) {
      throw new BadRequestException('每周自定义次数模式需设置 1-7 的次数');
    }
    await this.prisma.department.update({ where: { id }, data: patch });
    return this.getReportSetting(id, operator);
  }

  /**
   * 部门本周成员日报完成情况（仅管理员/该部门管理者（负责人 ∪ 共管人））
   * - 与 ReportReminderService 同口径：本地周一为一周起点，今日=本地零点（与 submitDaily 存 periodStart 一致）
   * - 今日排班取「我的工作时间安排」里今天的北京周几：没排班的人不算应发日报，不会收到提醒
   * - 返回每人本周已写篇数/今日是否已写 + 今日排班 + 上次提醒时间，便于负责人直观查看谁没写
   */
  async reportStatus(id: string, operator: { id: string; role: string }) {
    await this.assertCanManageDept(id, operator);
    const dept = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, name: true, leaderId: true, managerIds: true, reportFrequency: true, reportWeeklyCount: true, reportRemindTime: true, reportNotifyLeader: true },
    });
    if (!dept) throw new NotFoundException('部门不存在');

    const now = new Date();
    const bj = new Date(now.getTime() + CN_OFFSET_MS);
    const bjDow = (bj.getUTCDay() + 6) % 7; // 0=周一
    const todayKey = new Date(now); todayKey.setHours(0, 0, 0, 0);
    const dayIdx = (todayKey.getDay() + 6) % 7;
    const mondayLocal = new Date(todayKey); mondayLocal.setDate(todayKey.getDate() - dayIdx);

    const members = await this.prisma.user.findMany({
      // 名册口径：主部门 ∪ 额外部门（只查 departmentId 会漏掉额外加入本部门的成员，他们同样应写日报）
      where: deptRosterWhere(id),
      select: { id: true, name: true, avatar: true, role: true, lastReportRemindAt: true },
    });
    const reports = await this.prisma.report.findMany({
      where: { type: 'DAILY', ownerId: { in: members.map((m) => m.id) }, periodStart: { gte: mondayLocal } },
      select: { ownerId: true, periodStart: true },
    });
    const weekCount = new Map<string, number>();
    const wroteToday = new Set<string>();
    for (const r of reports) {
      if (!r.ownerId) continue;
      weekCount.set(r.ownerId, (weekCount.get(r.ownerId) ?? 0) + 1);
      if (r.periodStart && r.periodStart.getTime() === todayKey.getTime()) wroteToday.add(r.ownerId);
    }

    // 今日（北京周几）的工作时间安排：决定谁算「应发日报人员」
    const slotRows = await this.prisma.userWorkSlot.findMany({
      where: { userId: { in: members.map((m) => m.id) }, weekday: bjDow },
      orderBy: [{ startMin: 'asc' }],
      select: { userId: true, startMin: true, endMin: true },
    });
    const planByUser = new Map<string, { startMin: number; endMin: number }[]>();
    for (const s of slotRows) {
      const list = planByUser.get(s.userId) ?? [];
      list.push({ startMin: s.startMin, endMin: s.endMin });
      planByUser.set(s.userId, list);
    }

    return {
      department: dept,
      weekStart: fmtBeijingDate(mondayLocal),
      today: fmtBeijingDate(now),
      members: members.map((m) => {
        const slots = planByUser.get(m.id) ?? [];
        return {
          id: m.id,
          name: m.name,
          avatar: m.avatar,
          role: m.role,
          isLeader: m.id === dept.leaderId,
          isManager: (dept.managerIds ?? []).includes(m.id),
          weekCount: weekCount.get(m.id) ?? 0,
          wroteToday: wroteToday.has(m.id),
          plannedToday: slots.length > 0,
          plannedSlots: slots.map((s) => slotRangeLabel(s.startMin, s.endMin)),
          plannedHours: slotsHours(slots),
          lastReportRemindAt: m.lastReportRemindAt,
        };
      }),
      bjDow,
    };
  }

  // ---------- 岗位清单（Setting key=positions） ----------

  async getPositions(): Promise<string[]> {
    const setting = await this.prisma.setting.findUnique({ where: { key: 'positions' } });
    const value = setting?.value as unknown;
    if (Array.isArray(value) && value.length) return value.map((v) => String(v));
    return DEFAULT_POSITIONS;
  }

  async savePositions(list: string[]): Promise<string[]> {
    const cleaned = [...new Set((list || []).map((p) => String(p).trim()).filter(Boolean))];
    await this.prisma.setting.upsert({
      where: { key: 'positions' },
      create: { key: 'positions', value: cleaned },
      update: { value: cleaned },
    });
    return cleaned;
  }

  // ---------- 汇报树（User.reportsToId 自引用，全公司一棵/多棵树，根=总负责人） ----------

  /**
   * 汇报树：取全体启用成员，按 reportsToId 组装嵌套树（树本身全公司可读，便于知道「每个人向谁汇报」）。
   * 返回 { roots[], flat[], canEditIds[] }：roots 为无上级者（总负责人/一级），flat 为扁平清单供下拉与编辑，
   * canEditIds 为当前登录人可调汇报关系的范围（管理员=全体；部门管理者=自己管辖部门的名册，不含自己）。
   * 悬空 reportsToId（指向已停用/删除者）归入 roots，避免成员从树上丢失。
   */
  async getReportTree(me: { id: string; role: string }) {
    const users = await this.prisma.user.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        role: true,
        departmentId: true,
        reportsToId: true,
        department: { select: { id: true, name: true, leaderId: true, managerIds: true } },
        extraDepartments: { select: { id: true, name: true } },
      },
      orderBy: [{ name: 'asc' }],
    });
    const canEdit = me.role === Role.ADMIN ? new Set(users.map((u) => u.id)) : await this.managedRosterIds(me.id, { excludeSelf: true });
    const byId = new Map<string, any>();
    // 无上级（将归入 roots）者标注默认汇报对象：严格按「只向上」层级（管理员为根；其余→主部门负责人→在职管理员），口径与回填一致，保证不成环
    const activeSet = new Set(users.map((u) => u.id));
    const deptById = new Map(users.map((u) => [u.id, u.department]));
    const admins = (await this.prisma.user.findMany({ where: { role: Role.ADMIN, active: true }, select: { id: true } })).map((a) => a.id);
    const flat = users.map((u) => {
      const node: any = {
        id: u.id,
        name: u.name,
        role: u.role,
        departmentId: u.departmentId,
        departmentName: u.department?.name ?? null,
        departmentNames: [u.department?.name, ...(u.extraDepartments ?? []).map((d) => d.name)].filter(Boolean) as string[],
        reportsToId: u.reportsToId,
        canEdit: canEdit.has(u.id),
        children: [] as any[],
      };
      byId.set(u.id, node);
      return node;
    });
    const roots: any[] = [];
    for (const node of flat) {
      const parent = node.reportsToId ? byId.get(node.reportsToId) : null;
      if (parent && parent !== node) parent.children.push(node);
      else {
        if (node.reportsToId) node.reportsToId = null; // 悬空上级归为根
        const def = pickDefaultManager(node.id, node.role, deptById.get(node.id), admins, (id) => activeSet.has(id));
        if (def) {
          node.defaultReportsToId = def;
          node.defaultReportsToName = byId.get(def)?.name ?? null;
        }
        roots.push(node);
      }
    }
    // 每层按姓名稳定排序
    const sortRec = (arr: any[]) => {
      arr.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
      arr.forEach((n) => sortRec(n.children));
    };
    sortRec(roots);
    return { roots, flat: flat.map(({ children, ...rest }) => rest), canEditIds: [...canEdit] };
  }

  /**
   * 设置某人的直属上级。parentId 为空表示置为根（清空上级）。
   * 权限：管理员任意；部门管理者（负责人 ∪ 共管人）只能改自己管辖部门名册内成员的上级，
   * 且新上级只能是自己或同一名册成员（避免把本部门成员挂到自己看不见的体系下）。
   * 校验：上级存在且启用、非本人、且沿上级链上溯不成环（新上级不能是本人后代）。
   */
  async setReportsTo(operator: { id: string; role: string }, userId: string, parentId: string | null) {
    const isAdmin = operator.role === Role.ADMIN;
    if (!isAdmin) {
      const editable = await this.managedRosterIds(operator.id, { excludeSelf: true });
      if (!editable.has(userId)) throw new ForbiddenException('只能调整本部门名册内成员的汇报关系');
      if (parentId && parentId !== operator.id && !editable.has(parentId)) {
        throw new ForbiddenException('只能指定自己或本部门成员为上级');
      }
    }
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, active: true } });
    if (!target) throw new NotFoundException('成员不存在');
    if (parentId) {
      if (parentId === userId) throw new BadRequestException('不能将自己设为直属上级');
      const parent = await this.prisma.user.findUnique({ where: { id: parentId }, select: { id: true, active: true, reportsToId: true } });
      if (!parent) throw new NotFoundException('上级不存在');
      // 沿 parentId 上溯，若遇到 userId 说明新上级是自己的后代，会成环
      let cursor: string | null = parent.reportsToId;
      const guard = new Set<string>([parentId]);
      while (cursor) {
        if (cursor === userId) throw new BadRequestException('不能把自己的下属设为自己的上级（会形成环）');
        if (guard.has(cursor)) break; // 已有数据本身成环，防御死循环
        guard.add(cursor);
        const up: { reportsToId: string | null } | null = await this.prisma.user.findUnique({
          where: { id: cursor },
          select: { reportsToId: true },
        });
        cursor = up?.reportsToId ?? null;
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { reportsToId: parentId || null } });
    return { ok: true, userId, reportsToId: parentId || null };
  }

  /**
   * 回填默认汇报对象（仅系统管理员）：对 reportsToId 为空 / 自引用 / 指向不在职者的成员，
   * 按「主部门负责人(含共管人) → 在职管理员」取第一个有效者写入 User.reportsToId。
   * 已手动设置且上级在职的成员不改动；幂等（再跑一次 filled=0）；推不出默认的保持为空。
   */
  async backfillReportsTo(me: { id: string; role: string }) {
    if (me.role !== Role.ADMIN) throw new ForbiddenException('仅系统管理员可回填默认汇报对象');
    const users = await this.prisma.user.findMany({
      where: { active: true },
      select: { id: true, role: true, reportsToId: true, department: { select: { leaderId: true, managerIds: true } } },
    });
    const admins = (await this.prisma.user.findMany({ where: { role: Role.ADMIN, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } })).map((a) => a.id);
    const activeSet = new Set(users.map((u) => u.id));
    let eligible = 0;
    let filled = 0;
    let skipped = 0;
    for (const u of users) {
      const dangling = Boolean(u.reportsToId) && !activeSet.has(u.reportsToId as string);
      const selfRef = u.reportsToId === u.id;
      if (!u.reportsToId || dangling || selfRef) {
        eligible += 1;
        const def = pickDefaultManager(u.id, u.role, u.department, admins, (id) => activeSet.has(id));
        if (def) {
          await this.prisma.user.update({ where: { id: u.id }, data: { reportsToId: def } });
          filled += 1;
        } else {
          skipped += 1;
        }
      }
    }
    return { scanned: users.length, eligible, filled, skipped };
  }
}
