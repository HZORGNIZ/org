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
    const markdown = await this.ai.generate('retrospective.summary', {
      projectName: retro.project.name,
      retroKind: retro.kind,
      submissions: submissionsText,
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
}
