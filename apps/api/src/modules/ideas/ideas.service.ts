import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IdeaStatus, Prisma, Role } from '@prisma/client';
import { CN_OFFSET_MS } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';

/** AI 规划输出的项目提议 */
export interface ProjectProposal {
  name: string;
  description?: string;
  ideaIds: string[];
  taskSeeds?: string[];
}
/** AI 规划输出的任务提议（projectId 可为已有项目 id，或 __newN__ 引用本次拟新建的第 N 个项目） */
export interface TaskProposal {
  title: string;
  projectId?: string;
  description?: string;
  dueDate?: string | null;
  priority?: string;
  assigneeId?: string | null;
  ideaIds: string[];
}

/** Date → 北京墙钟日期串 'YYYY-MM-DD'（供灵感转项目时给必填项供默认值） */
function bjDate(d: Date): string {
  return new Date(d.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 灵感 / 需求管理：
 * - list：分「我的 / 同项目组 / 同部门」三组（同部门含 extraDepartments）；管理员另给一组「全部灵感」覆盖全组织
 * - create/remove：作者或管理员
 * - plan：调用 ideas.plan 出项目/任务提议（不落库）
 * - commit：人工确认后落库；建项目仅 DEPT_LEADER/ADMIN，建任务需项目成员；回写来源灵感为 CONVERTED
 */
@Injectable()
export class IdeasService {
  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private projects: ProjectsService,
    private tasks: TasksService,
  ) {}

  /** 分组列表：普通成员按 协作 / 同部门 范围可见；管理员看全组织 */
  async list(me: { id: string; role: string }) {
    const ideaInclude = {
      author: { select: { id: true, name: true, avatar: true } },
      project: { select: { id: true, name: true } },
    } as const;
    // 管理员：不受协作 / 部门范围限制，本人的进「我的灵感」，其余人的一律进「全部灵感」
    if (me.role === Role.ADMIN) {
      const all = await this.prisma.idea.findMany({
        where: { status: { not: IdeaStatus.ARCHIVED } },
        include: ideaInclude,
        orderBy: { createdAt: 'desc' },
      });
      return {
        mine: all.filter((i) => i.authorId === me.id),
        sameProject: [] as typeof all,
        sameDept: [] as typeof all,
        others: all.filter((i) => i.authorId !== me.id),
      };
    }
    // 我所属部门（主 + 额外）
    const meFull = await this.prisma.user.findUnique({
      where: { id: me.id },
      select: { departmentId: true, extraDepartments: { select: { id: true } } },
    });
    const myDeptIds = new Set<string>();
    if (meFull?.departmentId) myDeptIds.add(meFull.departmentId);
    for (const d of meFull?.extraDepartments ?? []) myDeptIds.add(d.id);

    // 我参与/负责的项目，及其协作成员（项目负责人 + 成员）
    const myProjects = await this.prisma.project.findMany({
      where: { deletedAt: null, OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
      select: {
        id: true,
        ownerId: true,
        members: { select: { userId: true } },
      },
    });
    const coWorkers = new Set<string>();
    for (const p of myProjects) {
      coWorkers.add(p.ownerId);
      for (const m of p.members) coWorkers.add(m.userId);
    }
    coWorkers.delete(me.id);

    // 同部门成员 id（排除我；用于 sameDept 分组）
    let deptMemberIds = new Set<string>();
    if (myDeptIds.size) {
      const dm = await this.prisma.user.findMany({
        where: {
          id: { not: me.id },
          OR: [{ departmentId: { in: [...myDeptIds] } }, { extraDepartments: { some: { id: { in: [...myDeptIds] } } } }],
        },
        select: { id: true },
      });
      deptMemberIds = new Set(dm.map((u) => u.id));
    }

    // 候选作者集合：我 ∪ 协作成员 ∪ 同部门成员，一次性拉取范围内非归档灵感
    const candidateAuthors = new Set<string>([me.id, ...coWorkers, ...deptMemberIds]);
    const ideas = await this.prisma.idea.findMany({
      where: { authorId: { in: [...candidateAuthors] }, status: { not: IdeaStatus.ARCHIVED } },
      include: ideaInclude,
      orderBy: { createdAt: 'desc' },
    });

    const mine: any[] = [];
    const sameProject: any[] = [];
    const sameDept: any[] = [];
    for (const idea of ideas) {
      if (idea.authorId === me.id) {
        mine.push(idea);
      } else if (coWorkers.has(idea.authorId)) {
        sameProject.push(idea);
      } else if (deptMemberIds.has(idea.authorId)) {
        sameDept.push(idea);
      }
    }
    return { mine, sameProject, sameDept, others: [] as typeof ideas };
  }

  async create(me: { id: string }, data: { content: string; projectId?: string | null; source?: string }) {
    const content = (data.content ?? '').trim();
    if (!content) throw new BadRequestException('灵感内容不能为空');
    let projectId = data.projectId ?? null;
    if (projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
      if (!p) projectId = null;
    }
    return this.prisma.idea.create({
      data: {
        content,
        authorId: me.id,
        projectId,
        source: data.source ?? 'MANUAL',
      },
      include: { author: { select: { id: true, name: true, avatar: true } }, project: { select: { id: true, name: true } } },
    });
  }

  /** 删除灵感：作者或管理员 */
  async remove(me: { id: string; role: string }, id: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) throw new NotFoundException('灵感不存在');
    if (idea.authorId !== me.id && me.role !== Role.ADMIN) {
      throw new ForbiddenException('仅作者或管理员可删除灵感');
    }
    await this.prisma.idea.delete({ where: { id } });
    return { ok: true };
  }

  /** AI 规划：输出项目/任务提议，不落库 */
  async plan(me: { id: string; role: string }, data: { ideaIds: string[] }) {
    const ideaIds = [...new Set((data.ideaIds ?? []).filter(Boolean))];
    if (!ideaIds.length) throw new BadRequestException('请至少选择一条灵感');
    const ideas = await this.prisma.idea.findMany({
      where: { id: { in: ideaIds } },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (!ideas.length) throw new NotFoundException('未找到所选灵感');
    // 我可建任务的项目上下文（负责人/成员）
    const myProjects = await this.prisma.project.findMany({
      where: { deletedAt: null, OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
      select: { id: true, name: true },
      orderBy: { updatedAt: 'desc' },
    });
    const ideasText = ideas
      .map((i) => `- id=${i.id} | 作者=${i.author?.name ?? '未知'} | ${i.content}`)
      .join('\n');
    const myProjectsText = myProjects.length
      ? myProjects.map((p) => `- id=${p.id} | ${p.name}`).join('\n')
      : '（我目前未参与任何项目）';
    const proposal = await this.ai.generateJson<{ projects?: ProjectProposal[]; tasks?: TaskProposal[] }>(
      'ideas.plan',
      { ideas: ideasText, myProjects: myProjectsText, role: me.role },
    );
    if (!proposal) {
      return { ok: false, projects: [], tasks: [], message: 'AI 规划暂时不可用，请稍后重试或手动创建' };
    }
    return { ok: true, projects: proposal.projects ?? [], tasks: proposal.tasks ?? [] };
  }

  /**
   * 人工确认后落库：
   * - projects：仅 DEPT_LEADER/ADMIN 可建；建项目后把来源灵感作者加为成员，回写 CONVERTED+projectId
   * - tasks：projectId 可为已有项目 id 或 __newN__（引用本次新建第 N 个项目）；需为该(新)项目成员/负责人；回写 CONVERTED
   */
  async commit(
    me: { id: string; role: string },
    data: { projects?: ProjectProposal[]; tasks?: TaskProposal[] },
  ) {
    const projects = (data.projects ?? []).filter((p) => p && (p.name ?? '').trim());
    const tasks = (data.tasks ?? []).filter((t) => t && (t.title ?? '').trim());
    if (!projects.length && !tasks.length) throw new BadRequestException('没有可创建的内容');

    const canCreateProject = me.role === Role.ADMIN || me.role === Role.DEPT_LEADER;
    if (projects.length && !canCreateProject) {
      throw new ForbiddenException('仅部门负责人或系统管理员可新建项目');
    }

    const createdProjectIds: string[] = [];
    const convertedIdeaIds = new Set<string>();

    // 1) 新建项目
    for (const p of projects) {
      const ideaIds = (p.ideaIds ?? []).filter(Boolean);
      const authors = await this.ideaAuthors(ideaIds);
      const created = await this.projects.create(me.id, {
        name: p.name.trim(),
        description: (p.description ?? '').trim() || undefined,
        // 灵感转项目不采集立项确认项：给默认起止日与占位里程碑、豁免需求文档，保持旧转化链路可用
        startDate: bjDate(new Date()),
        endDate: bjDate(new Date(Date.now() + 30 * 86_400_000)),
        milestones: [{ name: '一期上线', dueDate: bjDate(new Date(Date.now() + 30 * 86_400_000)) }],
        skipRequirementDoc: true,
      });
      createdProjectIds.push(created.id);
      // 来源灵感作者加为项目成员（非负责人本人）
      for (const authorId of authors) {
        if (authorId === me.id) continue;
        try {
          await this.projects.addMember(created.id, me.id, authorId, me.role === Role.ADMIN);
        } catch {
          /* 已是成员或无权限，忽略 */
        }
      }
      if (ideaIds.length) await this.markConverted(ideaIds, created.id, convertedIdeaIds);
    }

    // 2) 新建任务
    const createdTaskIds: string[] = [];
    for (const t of tasks) {
      const ideaIds = (t.ideaIds ?? []).filter(Boolean);
      const projectId = await this.resolveTaskProject(me, t.projectId, createdProjectIds);
      if (!projectId) continue;
      const assigneeId = t.assigneeId && t.assigneeId !== 'me' ? t.assigneeId : me.id;
      try {
        const task = await this.tasks.create(me, {
          projectId,
          title: t.title.trim(),
          description: (t.description ?? '').trim() || undefined,
          priority: t.priority,
          assigneeId,
          dueDate: t.dueDate || null,
        });
        createdTaskIds.push(task.id);
        if (ideaIds.length) await this.markConverted(ideaIds, projectId, convertedIdeaIds);
      } catch {
        /* 单条任务失败不影响整体（如无权限/校验失败） */
      }
    }

    return {
      projects: createdProjectIds,
      tasks: createdTaskIds,
      convertedIdeas: [...convertedIdeaIds],
    };
  }

  /** 解析任务归属项目：__newN__ → 本次新建第 N 个项目；否则视为已有项目 id（需我可访问） */
  private async resolveTaskProject(
    me: { id: string; role: string },
    projectId: string | undefined,
    createdProjectIds: string[],
  ): Promise<string | null> {
    const raw = (projectId ?? '').trim();
    if (!raw) return null;
    const m = raw.match(/^__?new_?(\d+)__?$/i);
    if (m) return createdProjectIds[Number(m[1])] ?? null;
    // 已有项目：确认未删除
    const p = await this.prisma.project.findFirst({ where: { id: raw, deletedAt: null }, select: { id: true } });
    if (!p) return null;
    return p.id;
  }

  /** 一批灵感作者的 distinct userId */
  private async ideaAuthors(ideaIds: string[]): Promise<string[]> {
    if (!ideaIds.length) return [];
    const rows = await this.prisma.idea.findMany({ where: { id: { in: ideaIds } }, select: { authorId: true } });
    return [...new Set(rows.map((r) => r.authorId))];
  }

  /** 回写灵感为 CONVERTED，并关联 projectId（尽力而为） */
  private async markConverted(ideaIds: string[], projectId: string | null, sink: Set<string>) {
    if (!ideaIds.length) return;
    await this.prisma.idea.updateMany({
      where: { id: { in: ideaIds } },
      data: { status: IdeaStatus.CONVERTED, ...(projectId ? { projectId } : {}) },
    });
    for (const id of ideaIds) sink.add(id);
  }
}
