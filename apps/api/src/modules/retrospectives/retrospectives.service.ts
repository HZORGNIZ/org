import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RetroKind, Role } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { SopsService } from '../sops/sops.service';
import { PrismaService } from '../../common/prisma.service';

/** 结构化复盘固定 5 问（顺序固定，创建时预置到 questions） */
export const STRUCTURED_QUESTIONS: { key: string; question: string }[] = [
  { key: 'q1', question: '项目的预期目标是什么，达到了预期目标吗？' },
  { key: 'q2', question: '如果没达到预期目标，原因是什么？' },
  { key: 'q3', question: '有哪些成功的经验？' },
  { key: 'q4', question: '碰到了什么挑战，是如何解决的？' },
  { key: 'q5', question: '未来的工作中如何避坑？' },
];

/**
 * 项目复盘：负责人创建复盘轮次（结构化 5 问 / 一般复盘导入总结），
 * 组员在截止日前各自提交，负责人「AI 汇总」生成项目复盘报告。
 */
@Injectable()
export class RetrospectivesService {
  private readonly logger = new Logger(RetrospectivesService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private files: FilesService,
    private sops: SopsService,
  ) {}

  // ---- 权限口径 ----

  private async roleOf(userId: string): Promise<Role> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role ?? Role.MEMBER;
  }

  /** 我参与的项目（owner 或成员，不含已归档） */
  private async myProjectIds(userId: string): Promise<string[]> {
    const [owned, memberships] = await Promise.all([
      this.prisma.project.findMany({
        where: { archived: false, ownerId: userId },
        select: { id: true },
      }),
      this.prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } }),
    ]);
    return [...new Set([...owned.map((p) => p.id), ...memberships.map((m) => m.projectId)])];
  }

  /** 加载项目并返回调用者的成员/负责人/管理员口径 */
  private async loadProjectCtx(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: { select: { userId: true } } },
    });
    if (!project) throw new NotFoundException('项目不存在');
    const isAdmin = (await this.roleOf(userId)) === Role.ADMIN;
    const isOwner = project.ownerId === userId;
    const isMember = isOwner || project.members.some((m) => m.userId === userId);
    return { project, isAdmin, isOwner, isMember };
  }

  private assertManager(ctx: { isAdmin: boolean; isOwner: boolean }) {
    if (!ctx.isAdmin && !ctx.isOwner) throw new ForbiddenException('仅项目负责人或管理员可操作');
  }

  // ---- 查询 ----

  /** 全部项目的复盘轮次 + 成员进度 + 我的提交状态（管理员可见全部项目，成员仅见参与项目） */
  async list(userId: string) {
    const isAdmin = (await this.roleOf(userId)) === Role.ADMIN;
    const projectIds = isAdmin
      ? (
          await this.prisma.project.findMany({
            where: { archived: false },
            select: { id: true },
          })
        ).map((p) => p.id)
      : await this.myProjectIds(userId);
    const [retros, members, owned] = await Promise.all([
      this.prisma.projectRetro.findMany({
        where: { projectId: { in: projectIds } },
        include: {
          project: { select: { id: true, name: true, ownerId: true } },
          submissions: { select: { userId: true, submittedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId: { in: projectIds } },
        select: { projectId: true, userId: true },
      }),
      this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, ownerId: true },
      }),
    ]);
    const ownerByProject = new Map(owned.map((p) => [p.id, p.ownerId]));
    const memberIdsByProject = new Map<string, string[]>();
    for (const m of members) {
      const arr = memberIdsByProject.get(m.projectId) ?? [];
      arr.push(m.userId);
      memberIdsByProject.set(m.projectId, arr);
    }
    return retros.map((r) => {
      const memberIds = new Set([
        ...(ownerByProject.get(r.projectId) ? [ownerByProject.get(r.projectId)!] : []),
        ...(memberIdsByProject.get(r.projectId) ?? []),
      ]);
      const submittedIds = new Set(r.submissions.map((s) => s.userId));
      return {
        id: r.id,
        projectId: r.projectId,
        kind: r.kind,
        title: r.title,
        status: r.status,
        deadline: r.deadline,
        summary: r.summary,
        finalContent: r.finalContent,
        finalAt: r.finalAt,
        createdAt: r.createdAt,
        project: r.project,
        membersTotal: memberIds.size,
        submittedCount: r.submissions.length,
        mySubmitted: submittedIds.has(userId),
        canSummarize: r.submissions.length > 0,
        overdue: r.status === 'OPEN' && !!r.deadline && r.deadline.getTime() < Date.now(),
      };
    });
  }

  /** 复盘详情（含可提交成员列表与全部提交）；项目成员及以上可见 */
  async getDetail(id: string, userId: string) {
    const retro = await this.prisma.projectRetro.findUnique({
      where: { id },
      include: {
        project: {
          include: {
            owner: { select: { id: true, name: true, avatar: true } },
            members: { select: { userId: true, role: true, user: { select: { id: true, name: true, avatar: true } } } },
          },
        },
        submissions: { include: { user: { select: { id: true, name: true } } } },
      },
    });
    if (!retro) throw new NotFoundException('复盘不存在');
    const ctx = await this.loadProjectCtx(retro.projectId, userId);
    if (!ctx.isAdmin && !ctx.isMember) throw new ForbiddenException('仅项目成员可查看复盘');
    const isAdmin = await this.roleOf(userId);
    return {
      ...retro,
      // 可提交成员：负责人 + ProjectMember 去重
      members: [
        { userId: retro.project.owner.id, name: retro.project.owner.name, avatar: retro.project.owner.avatar, role: 'OWNER' },
        ...retro.project.members.map((m) => ({ userId: m.userId, name: m.user.name, avatar: m.user.avatar, role: m.role })),
      ].filter((m, i, arr) => arr.findIndex((x) => x.userId === m.userId) === i),
      canManage: retro.project.ownerId === userId || isAdmin === Role.ADMIN,
    };
  }

  // ---- 负责人操作 ----

  /** 创建复盘轮次（负责人/管理员）；STRUCTURED 自动预置固定 5 问 */
  async create(
    userId: string,
    body: { projectId: string; kind: RetroKind; title?: string; deadline?: string | null },
  ) {
    const ctx = await this.loadProjectCtx(body.projectId, userId);
    this.assertManager(ctx);
    const kind = body.kind === RetroKind.GENERAL ? RetroKind.GENERAL : RetroKind.STRUCTURED;
    const retro = await this.prisma.projectRetro.create({
      data: {
        projectId: body.projectId,
        kind,
        title: body.title?.trim() || `${ctx.project.name}复盘`,
        questions: kind === RetroKind.STRUCTURED ? (STRUCTURED_QUESTIONS as any) : ([] as any),
        deadline: body.deadline ? new Date(body.deadline) : null,
        createdById: userId,
      },
      include: { project: { select: { id: true, name: true } } },
    });
    return retro;
  }

  /** 修改复盘（负责人/管理员）：标题/截止日/状态 */
  async update(
    id: string,
    userId: string,
    body: { title?: string; deadline?: string | null; status?: string },
  ) {
    const retro = await this.prisma.projectRetro.findUnique({ where: { id } });
    if (!retro) throw new NotFoundException('复盘不存在');
    const ctx = await this.loadProjectCtx(retro.projectId, userId);
    this.assertManager(ctx);
    return this.prisma.projectRetro.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.deadline !== undefined ? { deadline: body.deadline ? new Date(body.deadline) : null } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
  }

  // ---- 成员提交 ----

  /** 提交/覆盖提交（成员本人；每人一轮一条） */
  async submit(
    userId: string,
    retroId: string,
    body: {
      answers?: Record<string, string>;
      content?: string;
      attachment?: { name?: string; key?: string };
    },
  ) {
    const retro = await this.prisma.projectRetro.findUnique({
      where: { id: retroId },
      include: { project: { select: { ownerId: true } } },
    });
    if (!retro) throw new NotFoundException('复盘不存在');
    const ctx = await this.loadProjectCtx(retro.projectId, userId);
    if (!ctx.isAdmin && !ctx.isMember) throw new ForbiddenException('仅项目成员可提交复盘');

    const data: {
      answers?: any;
      content?: string;
      attachmentName?: string;
      attachmentKey?: string;
    } = {};

    if (retro.kind === RetroKind.STRUCTURED) {
      // 结构化：5 问回答齐全
      const answers = body.answers ?? {};
      const questions = (retro.questions as { key: string }[]) ?? STRUCTURED_QUESTIONS;
      const keys = questions.map((q) => q.key);
      const missing = keys.filter((k) => !(typeof answers[k] === 'string' && answers[k].trim()));
      if (missing.length)
        throw new BadRequestException(`结构化复盘需回答全部问题，未作答：${missing.join('、')}`);
      data.answers = Object.fromEntries(keys.map((k) => [k, answers[k].trim()]));
    } else {
      // 一般复盘：粘贴文本与上传文档至少其一
      const content = body.content?.trim() ?? '';
      const attachment = body.attachment ?? {};
      const hasFile = !!attachment.name && !!attachment.key;
      if (!content && !hasFile)
        throw new BadRequestException('一般复盘请粘贴总结文本或上传文档（二选一或都填）');
      if (content) data.content = content;
      if (hasFile) {
        data.attachmentName = attachment.name;
        data.attachmentKey = attachment.key;
      }
    }

    return this.prisma.retroSubmission.upsert({
      where: { retroId_userId: { retroId, userId } },
      create: { retroId, userId, ...data },
      update: { ...data, submittedAt: new Date() },
    });
  }

  // ---- AI 汇总 ----

  /** AI 汇总所有成员提交为复盘报告（负责人/管理员；无提交时 400） */
  async summarize(userId: string, retroId: string) {
    const retro = await this.prisma.projectRetro.findUnique({
      where: { id: retroId },
      include: {
        project: { select: { name: true } },
        submissions: { include: { user: { select: { name: true } } } },
      },
    });
    if (!retro) throw new NotFoundException('复盘不存在');
    const ctx = await this.loadProjectCtx(retro.projectId, userId);
    this.assertManager(ctx);
    if (!retro.submissions.length) throw new BadRequestException('暂无成员提交，还不能生成汇总报告');

    const submissionsText = await this.formatSubmissionsForAi(retro as any);
    // 项目经营数据（任务/工时/日报周报/纪要）：让 AI 汇总不止基于成员提交，还能对照客观经营情况
    const contextText = await this.projectContextText(retro.projectId);
    const markdown = await this.ai.generate('retrospective.summary', {
      projectName: retro.project.name,
      retroKind: retro.kind,
      submissions: submissionsText,
      context: contextText,
    });
    if (!markdown) throw new ServiceUnavailableException('AI 汇总失败，请稍后重试');

    const updated = await this.prisma.projectRetro.update({
      where: { id: retroId },
      data: { summary: markdown.trim(), summaryBy: userId, summarizedAt: new Date(), status: 'SUMMARIZED' },
      include: { project: { select: { id: true, name: true } } },
    });
    // 汇总成功后自动异步提取 SOP 候选（供 SOP 页自动推荐；不阻塞汇总响应，失败仅记录日志）
    this.sops
      .extractFromRetro(userId, retroId)
      .then((r) => this.logger.log(`复盘「${retro.title}」自动提取 SOP 完成: 新建 ${r.created.length} 条，跳过 ${r.skipped} 条`))
      .catch((e) => this.logger.warn(`复盘「${retro.title}」自动提取 SOP 失败: ${(e as Error).message}`));
    return updated;
  }

  /** 把成员提交整理为 AI 输入文本；GENERAL 的附件在 MinIO 可用时尝试解析 .docx 文本，失败降级为仅文件名 */
  private async formatSubmissionsForAi(retro: {
    kind: RetroKind;
    questions: any;
    submissions: {
      answers?: any;
      content?: string | null;
      attachmentName?: string | null;
      attachmentKey?: string | null;
      user: { name: string };
    }[];
  }) {
    const blocks: string[] = [];
    let idx = 0;
    for (const s of retro.submissions) {
      idx += 1;
      const who = s.user?.name || `成员${idx}`;
      if (retro.kind === RetroKind.STRUCTURED) {
        const questions = (retro.questions as { key: string; question: string }[]) ?? STRUCTURED_QUESTIONS;
        const lines = [`【成员：${who}】`];
        for (const q of questions) {
          const answer = s.answers?.[q.key]?.trim();
          lines.push(`${q.key}. ${q.question}\n答：${answer || '（未作答）'}`);
        }
        blocks.push(lines.join('\n'));
      } else {
        let text = s.content?.trim() || '';
        if (s.attachmentKey && s.attachmentName) {
          const parsed = await this.tryParseAttachmentText(s.attachmentKey, s.attachmentName);
          text = text
            ? `${text}\n\n【附件：${s.attachmentName}】\n${parsed}`
            : `【附件：${s.attachmentName}】\n${parsed}`;
        }
        blocks.push(`【成员：${who}】\n${text || '（未提供文本内容）'}`);
      }
    }
    return blocks.join('\n\n');
  }

  /** .docx 用 mammoth 解析为文本；MinIO 不可用/解析失败返回降级提示（不阻塞汇总） */
  private async tryParseAttachmentText(key: string, name: string): Promise<string> {
    try {
      const buf = await this.files.download(key);
      if (!buf || !buf.length) return '（附件文本解析不可用，未读取到文件内容）';
      if (/\.docx$/i.test(name)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mammoth = require('mammoth');
        const { value } = await mammoth.extractRawText({ buffer: buf });
        const text = (value || '').trim();
        return text || '（附件未解析出文本内容）';
      }
      return `（附件 ${name} 非 docx 格式，仅保留文件名）`;
    } catch (e) {
      this.logger.warn(`解析复盘附件失败（降级为仅文件名）: ${name}`, e as Error);
      return `（附件 ${name} 文本解析失败，仅保留文件名）`;
    }
  }

  /** 项目经营数据文本（AI 汇总的客观对照面）：任务完成/逾期 + 近30天日报周报工时 + 最近纪要 */
  private async projectContextText(projectId: string): Promise<string> {
    try {
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * 86400000);
      const [tasks, reports, notes] = await Promise.all([
        this.prisma.task.groupBy({
          by: ['status'],
          where: { projectId, project: { archived: false } },
          _count: true,
        }),
        this.prisma.report.groupBy({
          by: ['type'],
          where: { projectId, periodStart: { gte: monthAgo, lt: now }, status: 'PUBLISHED' },
          _count: true,
        }),
        this.prisma.projectNote.findMany({
          where: { projectId, kind: { in: ['PROGRESS', 'REPORT'] } },
          orderBy: { publishedAt: 'desc' },
          take: 5,
          select: { kind: true, title: true, content: true, publishedAt: true },
        }),
      ]);
      const taskLine = tasks.map((t) => `${t.status}:${t._count}`).join(' / ') || '无任务';
      const reportLine = reports.map((r) => `${r.type}:${r._count} 篇`).join(' / ') || '无提交';
      const noteLines = notes.map((n) => `- [${n.kind}] ${n.title}（${n.publishedAt.toISOString().slice(0, 10)}）${String(n.content ?? '').slice(0, 120)}`);
      const overdue = await this.prisma.task.count({
        where: { projectId, project: { archived: false }, status: { not: 'DONE' }, dueDate: { lt: now } },
      });
      return [
        `任务分布：${taskLine}；其中逾期未完成 ${overdue} 个`,
        `近 30 天项目归属日报/周报提交：${reportLine}`,
        ...(noteLines.length ? ['最近项目纪要：', ...noteLines] : []),
      ].join('\n');
    } catch (e) {
      this.logger.warn(`项目经营数据聚合失败（复盘汇总降级为仅成员提交）: ${(e as Error).message}`);
      return '（项目经营数据暂不可用）';
    }
  }

  /** 项目复盘定稿：负责人/管理员保存最终结论（可改 AI 稿，也可不经 AI 直接输入） */
  async saveConclusion(userId: string, retroId: string, content: string) {
    const text = String(content ?? '').trim();
    if (!text) throw new BadRequestException('结论内容不能为空');
    const retro = await this.prisma.projectRetro.findUnique({ where: { id: retroId }, select: { id: true, projectId: true } });
    if (!retro) throw new NotFoundException('复盘不存在');
    const ctx = await this.loadProjectCtx(retro.projectId, userId);
    this.assertManager(ctx);
    return this.prisma.projectRetro.update({
      where: { id: retroId },
      data: { finalContent: text, finalById: userId, finalAt: new Date() },
      select: { id: true, finalContent: true, finalAt: true },
    });
  }

  // ======== 部门复盘（部门管理 · 复盘 tab）========

  /** 部门可见口径：管理员=全部；负责人/共管人=所辖部门；普通成员=主部门+额外部门（只读） */
  private async myDeptScope(userId: string) {
    const isAdmin = (await this.roleOf(userId)) === Role.ADMIN;
    const [me, ledDepts] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { departmentId: true, extraDepartments: { select: { id: true } } },
      }),
      this.prisma.department.findMany({
        where: { OR: [{ leaderId: userId }, { managerIds: { has: userId } }] },
        select: { id: true },
      }),
    ]);
    const manageIds = new Set(ledDepts.map((d) => d.id));
    const visibleIds = new Set<string>([
      ...manageIds,
      ...(me?.departmentId ? [me.departmentId] : []),
      ...(me?.extraDepartments ?? []).map((d) => d.id),
    ]);
    return { isAdmin, manageIds, visibleIds };
  }

  private assertDeptManage(scope: { isAdmin: boolean; manageIds: Set<string> }, departmentId: string) {
    if (!scope.isAdmin && !scope.manageIds.has(departmentId)) {
      throw new ForbiddenException('仅部门负责人/共管人或管理员可操作部门复盘');
    }
  }

  /** 部门复盘列表：可见部门的全部复盘（含部门名与我的操作权限） */
  async deptList(userId: string) {
    const scope = await this.myDeptScope(userId);
    const rows = await this.prisma.deptRetro.findMany({
      where: scope.isAdmin ? {} : { departmentId: { in: [...scope.visibleIds] } },
      include: {
        department: { select: { id: true, name: true } },
        creator: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      departmentId: r.departmentId,
      departmentName: r.department?.name ?? '',
      period: r.period,
      title: r.title,
      hasAi: !!r.aiContent,
      aiContent: r.aiContent,
      finalContent: r.finalContent,
      finalAt: r.finalAt,
      createdAt: r.createdAt,
      creatorName: r.creator?.name ?? '',
      canManage: scope.isAdmin || scope.manageIds.has(r.departmentId),
    }));
  }

  /** 发起部门复盘（负责人/共管人/管理员）：period=YYYY-MM */
  async deptCreate(userId: string, body: { departmentId: string; period: string; title?: string }) {
    const departmentId = String(body?.departmentId ?? '');
    const period = String(body?.period ?? '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException('复盘周期格式应为 YYYY-MM');
    const dept = await this.prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, name: true } });
    if (!dept) throw new NotFoundException('部门不存在');
    const scope = await this.myDeptScope(userId);
    this.assertDeptManage(scope, departmentId);
    const dup = await this.prisma.deptRetro.findFirst({ where: { departmentId, period }, select: { id: true } });
    if (dup) throw new BadRequestException(`${period} 已有部门复盘，请直接在该记录上生成/定稿`);
    return this.prisma.deptRetro.create({
      data: {
        departmentId,
        period,
        title: String(body?.title ?? '').trim() || `${dept.name} ${period} 月度复盘`,
        createdById: userId,
      },
    });
  }

  /** 部门成员（主部门 + 额外加入，口径与部门工作总览一致） */
  private async deptMemberIds(departmentId: string): Promise<string[]> {
    const members = await this.prisma.user.findMany({
      where: { OR: [{ departmentId }, { extraDepartments: { some: { id: departmentId } } }] },
      select: { id: true, name: true },
    });
    return members.map((m) => m.id);
  }

  /** AI 生成部门复盘：聚合周期内 任务/工时/日报周报/PBC + 项目进展 → Markdown（整体情况 + 每人小结） */
  async deptAiGenerate(userId: string, retroId: string) {
    const retro = await this.prisma.deptRetro.findUnique({
      where: { id: retroId },
      include: { department: { select: { id: true, name: true } } },
    });
    if (!retro) throw new NotFoundException('部门复盘不存在');
    const scope = await this.myDeptScope(userId);
    this.assertDeptManage(scope, retro.departmentId);

    const memberIds = await this.deptMemberIds(retro.departmentId);
    if (!memberIds.length) throw new BadRequestException('该部门暂无成员，无法生成复盘');
    const monthStart = new Date(`${retro.period}-01T00:00:00+08:00`);
    const nextY = Number(retro.period.slice(0, 4)) + (Number(retro.period.slice(5, 7)) === 12 ? 1 : 0);
    const nextM = Number(retro.period.slice(5, 7)) === 12 ? 1 : Number(retro.period.slice(5, 7)) + 1;
    const monthEnd = new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00+08:00`);
    const now = new Date();

    const [members, tasks, hoursRows, reports, pbcs, projects] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } }),
      this.prisma.task.findMany({
        where: { assigneeId: { in: memberIds } },
        select: { id: true, title: true, status: true, dueDate: true, assigneeId: true },
      }),
      this.prisma.report.groupBy({
        by: ['ownerId'],
        where: { type: 'DAILY', ownerId: { in: memberIds }, periodStart: { gte: monthStart, lt: monthEnd } },
        _sum: { hours: true },
        _count: true,
      }),
      this.prisma.report.groupBy({
        by: ['ownerId', 'type'],
        where: { ownerId: { in: memberIds }, periodStart: { gte: monthStart, lt: monthEnd }, status: 'PUBLISHED' },
        _count: true,
      }),
      this.prisma.pbc.findMany({
        where: { ownerId: { in: memberIds }, month: retro.period },
        select: { ownerId: true, status: true, reviewStatus: true, leaderTotal: true },
      }),
      this.prisma.projectDepartment.findMany({
        where: { departmentId: retro.departmentId },
        include: { project: { select: { id: true, name: true, status: true, archived: true } } },
      }),
    ]);

    // 项目进度按任务完成率实时计算（Project 模型无 progress 字段）
    const projIds = projects.map((p) => p.project.id);
    const projTasks = projIds.length
      ? await this.prisma.task.findMany({ where: { projectId: { in: projIds } }, select: { projectId: true, status: true } })
      : [];
    const projTaskStats = new Map<string, { total: number; done: number }>();
    for (const t of projTasks) {
      const s = projTaskStats.get(t.projectId) ?? { total: 0, done: 0 };
      s.total += 1;
      if (t.status === 'DONE') s.done += 1;
      projTaskStats.set(t.projectId, s);
    }

    const nameById = new Map(members.map((m) => [m.id, m.name]));
    const taskStats = new Map<string, { total: number; done: number; overdue: number }>();
    for (const t of tasks) {
      if (!t.assigneeId) continue;
      const s = taskStats.get(t.assigneeId) ?? { total: 0, done: 0, overdue: 0 };
      s.total += 1;
      if (t.status === 'DONE') s.done += 1;
      else if (t.dueDate && t.dueDate < now) s.overdue += 1;
      taskStats.set(t.assigneeId, s);
    }
    const hoursById = new Map<string, { hours: number; days: number }>();
    for (const h of hoursRows) {
      if (!h.ownerId) continue; // groupBy 结果 ownerId 可空（类型收窄）
      hoursById.set(h.ownerId, { hours: Math.round((h._sum.hours ?? 0) * 10) / 10, days: h._count });
    }
    const reportCount = new Map<string, { daily: number; weekly: number }>();
    for (const r of reports) {
      if (!r.ownerId) continue;
      const cur = reportCount.get(r.ownerId) ?? { daily: 0, weekly: 0 };
      if (r.type === 'DAILY') cur.daily += r._count;
      if (r.type === 'WEEKLY') cur.weekly += r._count;
      reportCount.set(r.ownerId, cur);
    }
    const pbcById = new Map<string, { status: string; leaderTotal: number | null }>();
    for (const p of pbcs) pbcById.set(p.ownerId, { status: p.status, leaderTotal: p.leaderTotal ?? null });

    const personLines = members.map((m) => {
      const ts = taskStats.get(m.id) ?? { total: 0, done: 0, overdue: 0 };
      const hr = hoursById.get(m.id);
      const rp = reportCount.get(m.id);
      const pb = pbcById.get(m.id);
      return [
        `【${m.name}】`,
        `任务：共 ${ts.total}（完成 ${ts.done}，逾期 ${ts.overdue}）`,
        `本月工时：${hr?.hours ?? 0} 小时（日报 ${rp?.daily ?? 0} 篇，周报 ${rp?.weekly ?? 0} 篇）`,
        `PBC：${pb ? `${pb.status}${pb.leaderTotal != null ? `，考核得分 ${pb.leaderTotal}` : ''}` : '本月未创建'}`,
      ].join('\n');
    });

    const projectLines = projects
      .filter((p) => !p.project.archived)
      .map((p) => {
        const ts = projTaskStats.get(p.project.id) ?? { total: 0, done: 0 };
        const pct = ts.total ? Math.round((ts.done / ts.total) * 100) : 0;
        return `- ${p.project.name}：任务完成率 ${pct}%（${ts.done}/${ts.total}）`;
      });
    const deptStats = {
      members: members.length,
      tasksTotal: tasks.length,
      tasksDone: tasks.filter((t) => t.status === 'DONE').length,
      tasksOverdue: tasks.filter((t) => t.status !== 'DONE' && t.dueDate && t.dueDate < now).length,
      totalHours: [...hoursById.values()].reduce((a, b) => a + b.hours, 0),
      projects: projectLines.length,
    };

    const markdown = await this.ai.generate('department.retro', {
      deptName: retro.department?.name ?? '',
      period: retro.period,
      deptStats: JSON.stringify(deptStats),
      projects: projectLines.join('\n') || '（本部门暂无在办项目）',
      persons: personLines.join('\n\n'),
    });
    if (!markdown) throw new ServiceUnavailableException('AI 复盘生成失败，请稍后重试');

    const updated = await this.prisma.deptRetro.update({
      where: { id: retroId },
      data: { aiContent: markdown.trim(), aiMeta: deptStats as any },
    });
    return { ...updated, aiMeta: deptStats };
  }

  /** 部门复盘定稿（可改 AI 稿或自行输入）；定稿后部门成员可见 */
  async deptSaveConclusion(userId: string, retroId: string, content: string) {
    const text = String(content ?? '').trim();
    if (!text) throw new BadRequestException('结论内容不能为空');
    const retro = await this.prisma.deptRetro.findUnique({ where: { id: retroId }, select: { departmentId: true } });
    if (!retro) throw new NotFoundException('部门复盘不存在');
    const scope = await this.myDeptScope(userId);
    this.assertDeptManage(scope, retro.departmentId);
    return this.prisma.deptRetro.update({
      where: { id: retroId },
      data: { finalContent: text, finalById: userId, finalAt: new Date() },
      select: { id: true, finalContent: true, finalAt: true },
    });
  }
}
