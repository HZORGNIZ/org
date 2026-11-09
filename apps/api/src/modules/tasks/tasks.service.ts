import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { deptRosterWhere, ledDeptWhere } from '../../common/dept-authority';

const taskInclude = {
  assignee: { select: { id: true, name: true, avatar: true } },
  creator: { select: { id: true, name: true } },
  tags: true,
  project: {
    select: {
      id: true,
      name: true,
      ownerId: true,
      deletedAt: true,
      confidential: true,
      owner: { select: { id: true, name: true } },
      members: { select: { userId: true, role: true, user: { select: { id: true, name: true } } } },
      ndaSigns: { select: { userId: true } },
      departments: { select: { department: { select: { id: true, name: true, leaderId: true } } } },
    },
  },
  comments: {
    include: { author: { select: { id: true, name: true, avatar: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.TaskInclude;

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  /** 列表视图：按项目/负责人/状态/关键词筛选；管理员全量，普通用户见自己负责/参与的项目，部门负责人另可见本部门（主+额外）成员的任务 */
  async list(
    query: {
      projectId?: string;
      assigneeId?: string;
      status?: TaskStatus;
      keyword?: string;
    },
    me: { id: string; role: string },
  ) {
    const and: Prisma.TaskWhereInput[] = [];
    // 回收站（软删除）项目下的任务对所有角色都不展示
    and.push({ project: { deletedAt: null } });
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.assigneeId) and.push({ assigneeId: query.assigneeId });
    if (query.status) and.push({ status: query.status });
    if (query.keyword) and.push({ OR: [{ title: { contains: query.keyword } }, { description: { contains: query.keyword } }] });
    if (me.role !== Role.ADMIN) {
      // 保密项目的任务：只认「已签署保密协议的项目成员/负责人」，部门负责人管辖成员那一条对保密项目不再默认放行
      and.push(this.ndaGate(me.id));
      const memberIds = [...(await this.managedMemberIdSet(me.id, me.role))];
      const projectOr: Prisma.ProjectWhereInput[] = [{ ownerId: me.id }, { members: { some: { userId: me.id } } }];
      if (memberIds.length) projectOr.push({ ownerId: { in: memberIds } });
      const vis: Prisma.TaskWhereInput = { OR: [{ project: { OR: projectOr } }] };
      if (memberIds.length) vis.OR!.push({ assigneeId: { in: memberIds } });
      and.push(vis);
    }
    return this.prisma.task.findMany({
      where: { AND: and },
      include: taskInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /** 保密项目闸门：非保密项目不限；保密项目仅已签协议者可见（仅用于非管理员分支） */
  private ndaGate(userId: string): Prisma.TaskWhereInput {
    return {
      project: {
        OR: [{ confidential: false }, { confidential: true, ndaSigns: { some: { userId } } }],
      },
    };
  }

  /**
   * 我可管辖的部门成员 id 集合（主部门 departmentId ∪ 额外部门 extraDepartments）。
   * 管理员返回空集（列表另走全量分支，不依赖此集合）；非部门负责人/共管人也返回空集。
   */
  private async managedMemberIdSet(meId: string, role: string): Promise<Set<string>> {
    if (role === Role.ADMIN) return new Set();
    const led = await this.prisma.department.findMany({ where: ledDeptWhere(meId), select: { id: true } });
    if (!led.length) return new Set();
    const members = await this.prisma.user.findMany({
      where: deptRosterWhere(led.map((d) => d.id)),
      select: { id: true },
    });
    return new Set(members.map((m) => m.id));
  }

  /** 我的任务（首页/我的工作台）；任务只对项目成员可见：指派目标应为项目成员，非成员即使被指派也不可见 */
  async myTasks(me: { id: string; role: string }) {
    const now = new Date();
    // 与 list() 同口径：回收站（软删除）项目下的任务视同不存在，首页不能比任务页多显示
    // （否则会出现“首页看得到待办、我的任务里找不到”，而且点进去详情接口直接 404）
    const projectAnd: Prisma.ProjectWhereInput[] = [{ deletedAt: null }];
    // 非管理员：仅本人参与项目内的任务（admin 不受项目归属限制）
    if (me.role !== Role.ADMIN) {
      projectAnd.push({ OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] });
      projectAnd.push({
        OR: [{ confidential: false }, { confidential: true, ndaSigns: { some: { userId: me.id } } }],
      });
    }
    const scope: Prisma.TaskWhereInput = { project: { AND: projectAnd } };
    const [todo, done, overdue, hidden] = await Promise.all([
      this.prisma.task.findMany({
        where: { assigneeId: me.id, status: { not: 'DONE' }, ...scope },
        include: { project: { select: { id: true, name: true, color: true } } },
        orderBy: [{ dueDate: 'asc' }],
        take: 50,
      }),
      this.prisma.task.findMany({
        where: {
          assigneeId: me.id,
          status: 'DONE',
          completedAt: { gte: new Date(now.getTime() - 7 * 86400000) },
          ...scope,
        },
        include: { project: { select: { id: true, name: true, color: true } } },
        orderBy: { completedAt: 'desc' },
        take: 20,
      }),
      this.prisma.task.count({
        where: { assigneeId: me.id, status: { not: 'DONE' }, dueDate: { lt: now }, ...scope },
      }),
      // 不计入待办的回收站项目任务数：给首页一句说明，免得当事人以为任务被改坏了
      this.prisma.task.count({
        where: { assigneeId: me.id, status: { not: 'DONE' }, project: { deletedAt: { not: null } } },
      }),
    ]);
    return { todo, done, overdue, hidden };
  }

  async get(id: string, me: { id: string; role: string }) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: taskInclude,
    });
    // 回收站项目下的任务视同不存在
    if (task && task.project?.deletedAt) throw new NotFoundException('任务不存在');
    // 可见性：项目成员/管理员（canAccessTask）或 部门负责人可见本部门成员的任务；均不满足统一返回 404
    let allowed = this.canAccessTask(task, me);
    if (!allowed && task) {
      // 部门负责人跨成员查看对保密项目失效（未签协议就是看不了）
      if (!task.project?.confidential) {
        const set = await this.managedMemberIdSet(me.id, me.role);
        if (set.size && ((task.assigneeId && set.has(task.assigneeId)) || set.has(task.project?.ownerId ?? '')))
          allowed = true;
      }
    }
    if (!task || !allowed) throw new NotFoundException('任务不存在');
    return task;
  }

  async create(
    me: { id: string; role: string },
    data: {
      projectId: string;
      boardId?: string;
      columnId?: string;
      title: string;
      description?: string;
      priority?: string;
      assigneeId?: string;
      dueDate?: string | null;
      startDate?: string | null;
      progress?: number;
      estimateHours?: number | null;
      tags?: string[];
    },
  ) {
    const userId = me.id;
    // 只能在自己参与的项目里创建任务
    const projectCtx = await this.findProjectCtx(data.projectId);
    if (!projectCtx) throw new NotFoundException('项目不存在');
    if (!this.isMemberOrAdmin(me, projectCtx)) {
      throw new ForbiddenException('仅项目成员可在该项目创建任务');
    }
    // 负责人需为项目成员（保证被指派者必然能看见并维护自己的任务）
    if (
      data.assigneeId &&
      data.assigneeId !== projectCtx.ownerId &&
      !projectCtx.members.some((m) => m.userId === data.assigneeId)
    ) {
      throw new BadRequestException('任务负责人需为该项目成员');
    }
    this.assertTimeRange(data.startDate, data.dueDate);
    // 未指定看板列时自动落入项目首个看板的首列（待办），保证任务在看板可见
    let boardId = data.boardId;
    let columnId = data.columnId;
    if (!columnId) {
      const board = await this.prisma.kanbanBoard.findFirst({
        where: { projectId: data.projectId },
        orderBy: { createdAt: 'asc' },
        include: { columns: { orderBy: { sortOrder: 'asc' }, take: 1 } },
      });
      if (board?.columns[0]) {
        boardId = board.id;
        columnId = board.columns[0].id;
      }
    }
    const task = await this.prisma.task.create({
      data: {
        projectId: data.projectId,
        boardId,
        columnId,
        title: data.title,
        description: data.description,
        priority: (data.priority as any) ?? 'MEDIUM',
        assigneeId: data.assigneeId,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        startDate: data.startDate ? new Date(data.startDate) : null,
        progress: this.normalizeProgress(data.progress),
        estimateHours: data.estimateHours,
        creatorId: userId,
        tags: data.tags?.length
          ? { create: data.tags.map((name) => ({ name })) }
          : undefined,
      },
      include: taskInclude,
    });
    await this.recordActivity(task.id, userId, 'created', {
      title: task.title,
    });
    return task;
  }

  async update(
    id: string,
    me: { id: string; role: string },
    data: Partial<{
      title: string;
      description: string;
      status: TaskStatus;
      priority: string;
      assigneeId: string | null;
      dueDate: string | null;
      startDate: string | null;
      progress: number;
      estimateHours: number | null;
      boardId: string | null;
      columnId: string | null;
      sortOrder: number;
      tags: string[];
      /** 调整进度时的必填进展说明（落到活动记录 detail.note） */
      note?: string;
      /** 前端表单 spread 的多余字段，需剔除避免进入数据库更新 */
      progressNote?: string;
    }>,
  ) {
    const userId = me.id;
    const prev = await this.prisma.task.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            ownerId: true,
            confidential: true,
            members: { select: { userId: true } },
            ndaSigns: { select: { userId: true } },
          },
        },
      },
    });
    if (!prev) throw new NotFoundException('任务不存在');
    if (!this.canAccessTask(prev, me)) throw new ForbiddenException('仅项目成员可操作该任务');
    // 改派负责人需为项目成员（与 create 校验一致）
    if (
      data.assigneeId &&
      data.assigneeId !== prev.assigneeId &&
      data.assigneeId !== prev.project.ownerId &&
      !prev.project.members.some((m) => m.userId === data.assigneeId)
    ) {
      throw new BadRequestException('任务负责人需为该项目成员');
    }
    this.assertTimeRange(data.startDate, data.dueDate);

    const diff: Record<string, unknown> = {};
    if (data.status && data.status !== prev.status) {
      diff.status = { from: prev.status, to: data.status };
    }
    if (data.assigneeId !== undefined && data.assigneeId !== prev.assigneeId) {
      diff.assigneeId = { from: prev.assigneeId, to: data.assigneeId };
    }
    if (data.columnId !== undefined && data.columnId !== prev.columnId) {
      // 存列名（活动记录展示更可读；null 表示列表任务区）
      const [oldCol, newCol] = await Promise.all([
        prev.columnId ? this.prisma.kanbanColumn.findUnique({ where: { id: prev.columnId } }) : null,
        data.columnId ? this.prisma.kanbanColumn.findUnique({ where: { id: data.columnId } }) : null,
      ]);
      diff.columnId = { from: oldCol?.name ?? null, to: newCol?.name ?? null };
    }
    if (data.title && data.title !== prev.title) {
      diff.title = { from: prev.title, to: data.title };
    }
    if (data.priority && data.priority !== prev.priority) {
      diff.priority = { from: prev.priority, to: data.priority };
    }
    if (data.dueDate !== undefined) {
      const nd = data.dueDate ? new Date(data.dueDate) : null;
      if (nd?.getTime() !== prev.dueDate?.getTime()) diff.dueDate = { from: prev.dueDate, to: nd };
    }
    if (data.startDate !== undefined) {
      const ns = data.startDate ? new Date(data.startDate) : null;
      if (ns?.getTime() !== prev.startDate?.getTime()) diff.startDate = { from: prev.startDate, to: ns };
    }
    // 进度：可上下调整（不再只增不减），但实际发生变化时必须填写进展说明
    let progressNote: string | undefined;
    if (data.progress !== undefined) {
      const p = this.normalizeProgress(data.progress);
      if (p !== prev.progress) {
        diff.progress = { from: prev.progress ?? 0, to: p };
        progressNote = (data.note ?? '').trim();
        if (!progressNote) {
          throw new BadRequestException('调整任务进度必须填写进展说明（具体做了什么）');
        }
        if (progressNote.length > 500) {
          throw new BadRequestException('进展说明不能超过 500 字');
        }
      }
    }

    // 标签差异
    const tags = data.tags;
    if (tags) {
      const prevTags = (await this.prisma.taskTag.findMany({ where: { taskId: id } })).map(
        (t) => t.name,
      );
      const diffAdd = tags.filter((t) => !prevTags.includes(t));
      const diffDel = prevTags.filter((t) => !tags.includes(t));
      if (diffAdd.length || diffDel.length) diff.tags = { from: prevTags, to: tags };
    }

    const task = await this.prisma.$transaction(async (tx) => {
      if (data.tags) {
        await tx.taskTag.deleteMany({ where: { taskId: id } });
        if (data.tags.length) {
          await tx.taskTag.createMany({
            data: data.tags.map((name) => ({ taskId: id, name })),
          });
        }
      }
      const { tags: _tags, note: _note, progressNote: _progressNote, ...rest } = data;
      const done = rest.status === 'DONE';
      // 完成状态进度自动置 100（未显式传进度时，由系统补记活动注释）
      const autoFull = done && rest.progress === undefined ? 100 : undefined;
      if (autoFull !== undefined && (prev.progress ?? 0) < 100) {
        diff.progress = { from: prev.progress ?? 0, to: 100 };
        progressNote = '标记任务为完成，进度自动置为 100%';
      }
      // 标量外键（boardId/columnId/assigneeId）需用 UncheckedUpdateInput
      const updateData = {
        ...rest,
        dueDate: rest.dueDate !== undefined ? (rest.dueDate ? new Date(rest.dueDate) : null) : undefined,
        startDate: rest.startDate !== undefined ? (rest.startDate ? new Date(rest.startDate) : null) : undefined,
        ...(autoFull !== undefined ? { progress: autoFull } : {}),
        // 传了 status 就同步完成时间：置 DONE 记录当前时刻，从完成态改回则清空（与看板拖列回退行为一致）
        ...(rest.status !== undefined ? { completedAt: done ? new Date() : null } : {}),
      } as Prisma.TaskUncheckedUpdateInput;
      return tx.task.update({
        where: { id },
        data: updateData,
        include: taskInclude,
      });
    });

    if (Object.keys(diff).length) {
      const detail = { ...diff } as Record<string, unknown>;
      // 进度调整的说明随 diff 一并入活动记录（detail.note）
      if (diff.progress && progressNote) detail.note = progressNote;
      await this.recordActivity(id, userId, 'updated', detail);
    }
    return task;
  }

  /** 看板拖拽：移动到列 + 调整顺序；目标列为规范语义列时同步任务状态（拖入「已完成」列视为完成，进度未满自动补 100） */
  async move(id: string, columnId: string | null, sortOrder: number, me: { id: string; role: string }) {
    const userId = me.id;
    const prev = await this.prisma.task.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            ownerId: true,
            confidential: true,
            members: { select: { userId: true } },
            ndaSigns: { select: { userId: true } },
          },
        },
      },
    });
    if (!prev) throw new NotFoundException('任务不存在');
    if (!this.canAccessTask(prev, me)) throw new ForbiddenException('仅项目成员可操作该任务');
    // 取目标列名用于活动记录展示（移出看板时为空）；目标列必须属于任务所在项目
    let columnName: string | null = null;
    if (columnId) {
      const col = await this.prisma.kanbanColumn.findUnique({
        where: { id: columnId },
        include: { board: { select: { projectId: true } } },
      });
      if (!col) throw new BadRequestException('目标看板列不存在');
      if (col.board.projectId !== prev.projectId) {
        throw new BadRequestException('不能将任务移动到其他项目的看板列');
      }
      columnName = col.name;
    }
    const detail: Record<string, unknown> = { columnId, columnName, sortOrder };
    // 标量外键（columnId）需用 UncheckedUpdateInput
    const updateData: Prisma.TaskUncheckedUpdateInput = { columnId, sortOrder };
    // 列名→状态：已完成/进行中/待办 三个规范列（用户自命名列不干预，保持原状态）
    const synced = this.inferStatusByColumnName(columnName);
    if (synced && synced !== prev.status) {
      updateData.status = synced;
      detail.status = { from: prev.status, to: synced };
      updateData.completedAt = synced === 'DONE' ? new Date() : null;
    }
    // 拖入「已完成」列：进度未满自动补 100（与 update() 置 DONE 行为一致）
    if (synced === 'DONE' && (prev.progress ?? 0) < 100) {
      updateData.progress = 100;
      detail.progress = { from: prev.progress ?? 0, to: 100 };
    }
    const task = await this.prisma.task.update({
      where: { id },
      data: updateData,
    });
    await this.recordActivity(id, userId, 'moved', detail);
    return task;
  }

  /** 看板列名 → 任务状态语义（规范三列：待办/进行中/已完成；未识别返回 null 不干预） */
  private inferStatusByColumnName(name: string | null): TaskStatus | null {
    if (!name) return null;
    if (/完成|done/i.test(name)) return 'DONE';
    if (/进行|doing|in.?progress/i.test(name)) return 'IN_PROGRESS';
    if (/待办|todo|未开始|规划/i.test(name)) return 'TODO';
    return null;
  }

  async remove(id: string, me: { id: string; role: string }) {
    const ctx = await this.findTaskCtx(id);
    if (!ctx || !this.canAccessTask(ctx, me)) throw new NotFoundException('任务不存在');
    return this.prisma.task.delete({ where: { id } });
  }

  /** 规范化进度：0-100 整数，非法抛 400 */
  private normalizeProgress(p: number | null | undefined) {
    if (p === undefined || p === null) return 0;
    const n = Math.round(Number(p));
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new BadRequestException('任务进度需为 0-100 的整数');
    }
    return n;
  }

  /** 起止时间合法性：开始时间不晚于截止时间 */
  private assertTimeRange(startDate?: string | null, dueDate?: string | null) {
    if (!startDate || !dueDate) return;
    if (new Date(startDate).getTime() > new Date(dueDate).getTime()) {
      throw new BadRequestException('开始时间不能晚于截止时间');
    }
  }

  async addComment(taskId: string, me: { id: string; role: string }, content: string) {
    const ctx = await this.findTaskCtx(taskId);
    if (!ctx || !this.canAccessTask(ctx, me)) throw new NotFoundException('任务不存在');
    const comment = await this.prisma.taskComment.create({
      data: { taskId, authorId: me.id, content },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
    await this.recordActivity(taskId, me.id, 'commented', { content: content.slice(0, 100) });
    return comment;
  }

  /** 删除活动记录（项目负责人 / 部门负责人 / 系统管理员；活动记录不可编辑） */
  async removeActivity(taskId: string, activityId: string, me: { id: string; role: string }) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            ownerId: true,
            departments: { where: { department: ledDeptWhere(me.id) }, select: { id: true } },
          },
        },
      },
    });
    if (!task) throw new NotFoundException('任务不存在');
    const activity = await this.prisma.taskActivity.findFirst({
      where: { id: activityId, taskId },
    });
    if (!activity) throw new NotFoundException('活动记录不存在');
    if (me.role !== 'ADMIN') {
      const allowed =
        task.project.ownerId === me.id || task.project.departments.length > 0;
      if (!allowed) {
        throw new ForbiddenException('仅项目负责人、部门负责人或系统管理员可删除活动记录');
      }
    }
    await this.prisma.taskActivity.delete({ where: { id: activityId } });
    return { ok: true };
  }

  // ---- 可见性辅助：任务只对项目成员可见（系统管理员全量），与项目模块口径一致 ----

  /** 任务所属项目成员上下文（任务不存在 → null） */
  private async findTaskCtx(id: string) {
    return this.prisma.task.findUnique({
      where: { id },
      select: {
        id: true,
        projectId: true,
        project: {
          select: {
            ownerId: true,
            confidential: true,
            members: { select: { userId: true } },
            ndaSigns: { select: { userId: true } },
          },
        },
      },
    });
  }

  /** 项目级成员上下文（项目不存在 → null） */
  private async findProjectCtx(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true, confidential: true, members: { select: { userId: true } }, ndaSigns: { select: { userId: true } } },
    });
  }

  /** 系统管理员或项目负责人/成员 → 可访问；保密项目额外要求已签署保密协议 */
  private isMemberOrAdmin(
    me: { id: string; role: string },
    ctx:
      | { ownerId: string; members: { userId: string }[]; confidential?: boolean; ndaSigns?: { userId: string }[] }
      | null,
  ) {
    if (!ctx) return false;
    if (me.role === Role.ADMIN) return true;
    if (!(ctx.ownerId === me.id || ctx.members.some((m) => m.userId === me.id))) return false;
    // 保密项目：成员身份不够，必须已签协议（ndaSigns 未随查询带出时按「未签」保守处理）
    if (ctx.confidential) return !!ctx.ndaSigns?.some((s) => s.userId === me.id);
    return true;
  }

  /** 任务可见性判定（task 需已带 project.ownerId / project.members / project.confidential / project.ndaSigns） */
  private canAccessTask(
    task:
      | {
          project?: {
            ownerId: string;
            members: { userId: string }[];
            confidential?: boolean;
            ndaSigns?: { userId: string }[];
          } | null;
        }
      | null,
    me: { id: string; role: string },
  ) {
    return this.isMemberOrAdmin(me, task?.project ?? null);
  }

  /** 任务变更流水（供 AI 日报/周报聚合） */
  private async recordActivity(
    taskId: string,
    userId: string,
    action: string,
    detail?: Record<string, unknown>,
  ) {
    return this.prisma.taskActivity.create({
      data: { taskId, userId, action, detail: detail as Prisma.InputJsonValue },
    });
  }

  async activities(taskId: string, me: { id: string; role: string }) {
    const ctx = await this.findTaskCtx(taskId);
    if (!ctx || !this.canAccessTask(ctx, me)) throw new NotFoundException('任务不存在');
    return this.prisma.taskActivity.findMany({
      where: { taskId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
