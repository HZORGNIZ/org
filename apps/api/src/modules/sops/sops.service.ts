import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role, ReportStatus, SopSourceType, SopStatus } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../../common/prisma.service';

/** 标题归一化：全角转半角、去空白与常见标点、统一小写（供跨批近似去重兜底） */
function normalizeTitle(t: string): string {
  return t
    .trim()
    // 全角 → 半角
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/[，。、：:；;（）()【】\[\]「」"'“”‘’?？!！\-_·,.]+/g, '')
    .toLowerCase();
}

/** bigram Dice 相似度（归一化后短文本的近似度；与包含判定共同防标题措辞漂移漏网） */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [k, v] of ga) inter += Math.min(v, gb.get(k) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/** 与已见标题列表判重：归一化后相等 / 互含（长度≥8） / bigram Dice ≥ 0.75 */
function isNearDuplicateTitle(norm: string, seen: string[]): boolean {
  if (!norm) return false;
  for (const s of seen) {
    if (s === norm) return true;
    if (norm.length >= 8 && s.length >= 8 && (norm.includes(s) || s.includes(norm))) return true;
    if (diceSimilarity(norm, s) >= 0.75) return true;
  }
  return false;
}

/**
 * SOP（标准经验库）：从复盘内容 AI 提取候选 → 人工确认/打标签；
 * 查看全体登录用户可见；管理操作 = ADMIN 或 SOP 来源项目负责人。
 */
@Injectable()
export class SopsService {
  private readonly logger = new Logger(SopsService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
  ) {}

  private async roleOf(userId: string): Promise<Role> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role ?? Role.MEMBER;
  }

  private async isAdmin(userId: string): Promise<boolean> {
    return (await this.roleOf(userId)) === Role.ADMIN;
  }

  /** 是否某项目负责人（用于"任何项目负责人可人工新增"口径） */
  private async isAnyOwner(userId: string): Promise<boolean> {
    const p = await this.prisma.project.findFirst({ where: { ownerId: userId }, select: { id: true } });
    return !!p;
  }

  /** SOP 管理权限：ADMIN 或来源项目负责人（无来源项目的仅 ADMIN 可管） */
  private async canManage(sop: { projectId?: string | null }, userId: string): Promise<boolean> {
    if (await this.isAdmin(userId)) return true;
    if (!sop.projectId) return false;
    const p = await this.prisma.project.findFirst({
      where: { id: sop.projectId, ownerId: userId },
      select: { id: true },
    });
    return !!p;
  }

  // ---- 查询 ----

  /** 列表（默认 CANDIDATE+APPROVED；CANDIDATE 优先展示，updatedAt 倒序）+ 全量标签聚合 */
  async list(query: { status?: string; tag?: string; keyword?: string }) {
    const status = query.status as SopStatus | undefined;
    const statuses: SopStatus[] = status
      ? [status]
      : [SopStatus.CANDIDATE, SopStatus.APPROVED];
    const all = await this.prisma.sop.findMany({
      where: {
        status: { in: statuses },
        ...(query.tag ? { tags: { has: query.tag } } : {}),
        ...(query.keyword
          ? { OR: [{ title: { contains: query.keyword, mode: 'insensitive' } }, { content: { contains: query.keyword, mode: 'insensitive' } }] }
          : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        retro: { select: { id: true, title: true } },
        proposer: { select: { id: true, name: true } },
        confirmedBy: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // CANDIDATE 优先排序 + 全量标签聚合（分页前统计全部候选项的标签，方便筛选用）
    const tagCount = new Map<string, number>();
    for (const s of all) {
      for (const t of s.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
    const items = [...all.filter((s) => s.status === SopStatus.CANDIDATE), ...all.filter((s) => s.status === SopStatus.APPROVED)];
    return {
      items,
      allTags: [...tagCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    };
  }

  /** 人工新增 MANUAL（ADMIN 或任意项目负责人；新增即 APPROVED 生效） */
  async createManual(
    userId: string,
    body: { title: string; content: string; tags?: string[]; projectId?: string },
  ) {
    const title = body.title?.trim();
    const content = body.content?.trim();
    if (!title || !content) throw new BadRequestException('标题与内容不能为空');
    const tags = (body.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 10);
    if (!(await this.isAdmin(userId)) && !(await this.isAnyOwner(userId)))
      throw new ForbiddenException('仅管理员或项目负责人可新增 SOP');

    // 若指定来源项目，必须是该项目负责人
    if (body.projectId) {
      const p = await this.prisma.project.findFirst({
        where: { id: body.projectId, ownerId: userId },
        select: { id: true },
      });
      if (!(await this.isAdmin(userId)) && !p)
        throw new ForbiddenException('只能把 SOP 关联到自己负责的项目');
    }
    const now = new Date();
    return this.prisma.sop.create({
      data: {
        title,
        content,
        tags,
        status: SopStatus.APPROVED,
        sourceType: SopSourceType.MANUAL,
        projectId: body.projectId || null,
        proposerId: userId,
        confirmedById: userId,
        confirmedAt: now,
      },
      include: {
        project: { select: { id: true, name: true } },
        retro: { select: { id: true, title: true } },
        proposer: { select: { id: true, name: true } },
      },
    });
  }

  // ---- AI 提取 ----

  /**
   * 从复盘汇总报告提取 SOP 候选（该复盘所在项目负责人/ADMIN）
   * AI 与已有 SOP 去重；代码兜底：同 retroId 已提取过的 title 完全一致则跳过
   */
  async extractFromRetro(userId: string, retroId: string) {
    const retro = await this.prisma.projectRetro.findUnique({
      where: { id: retroId },
      include: {
        project: { select: { id: true, name: true, ownerId: true } },
        submissions: { include: { user: { select: { name: true } } } },
      },
    });
    if (!retro) throw new NotFoundException('复盘不存在');
    if (retro.status !== 'SUMMARIZED' || !retro.summary)
      throw new BadRequestException('该复盘尚未生成汇总报告，请先 AI 汇总');
    if (!(await this.isAdmin(userId)) && retro.project.ownerId !== userId)
      throw new ForbiddenException('仅该复盘项目负责人或管理员可提取 SOP');

    const existingSops = await this.prisma.sop.findMany({
      where: { status: { in: [SopStatus.APPROVED, SopStatus.CANDIDATE] } },
      select: { title: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    const submissionsText = retro.submissions
      .map((s) => {
        const who = s.user?.name ?? '成员';
        if (retro.kind === 'STRUCTURED') {
          const answers = (s.answers as Record<string, string>) ?? {};
          return `【${who}】${Object.values(answers)
            .map((v) => v?.trim())
            .filter(Boolean)
            .join('；')}`;
        }
        return `【${who}】${s.content?.trim() || ''}${s.attachmentName ? `（附件：${s.attachmentName}）` : ''}`;
      })
      .filter(Boolean)
      .join('\n');

    const retroContent = [
      `# ${retro.project.name}：${retro.title}`,
      '',
      '## 复盘汇总报告',
      retro.summary,
      '',
      '## 成员提交摘要',
      submissionsText || '（无）',
    ].join('\n');

    const ai = await this.ai.generateJson<{ sops?: { title?: string; content?: string }[] }>('sop.extract', {
      retroContent,
      existingSops: existingSops.length
        ? existingSops.map((e) => `- ${e.title}：${(e.content || '').slice(0, 120)}`).join('\n')
        : '（无）',
    });
    const candidates = (ai?.sops ?? []).filter(
      (s): s is { title: string; content: string } =>
        typeof s?.title === 'string' &&
        !!s.title.trim() &&
        typeof s?.content === 'string' &&
        !!s.content.trim(),
    );
    if (!candidates.length) {
      return { created: [], skipped: 0, note: 'AI 未提取到新的 SOP（可能与已有 SOP 重复或无有效内容）' };
    }

    // 兜底去重：同源（同一复盘）已提取过的近似 title 跳过（归一化同名 / 互含 / Dice 相似）
    const existingSameRetro = await this.prisma.sop.findMany({
      where: { retroId, status: { in: [SopStatus.CANDIDATE, SopStatus.APPROVED] } },
      select: { title: true },
    });
    const seenTitles = existingSameRetro.map((e) => normalizeTitle(e.title));

    const created: any[] = [];
    let skipped = 0;
    for (const c of candidates) {
      const title = c.title.trim();
      const content = c.content.trim();
      if (isNearDuplicateTitle(normalizeTitle(title), seenTitles)) {
        skipped += 1;
        continue;
      }
      seenTitles.push(normalizeTitle(title));
      created.push(
        await this.prisma.sop.create({
          data: {
            title,
            content,
            status: SopStatus.CANDIDATE,
            sourceType: SopSourceType.RETRO_EXTRACT,
            retroId,
            projectId: retro.projectId,
            proposerId: userId,
          },
          include: {
            project: { select: { id: true, name: true } },
            retro: { select: { id: true, title: true } },
            proposer: { select: { id: true, name: true } },
          },
        }),
      );
    }
    return { created, skipped };
  }

  /**
   * 从团队记录（群聊消息 / 日报 / 周报文字）AI 提取 SOP 候选（人工确认后生效）
   * - projectId 指定：仅该项目关联群消息 + 归属该项目的已发布报告；不指定：全部群聊与已发布报告
   * - 权限：ADMIN 可全团队/任意项目；项目负责人仅可提取自己负责的项目
   * - AI 与已有 SOP 语义去重；代码兜底：与任一 CANDIDATE/APPROVED SOP 完全同名 title 跳过
   * - 材料预算控制：文本总量与条数设上限，超限保留最新内容
   */
  async extractFromTeam(userId: string, body: { days?: number; projectId?: string }) {
    const isAdmin = await this.isAdmin(userId);
    const days = Math.min(Math.max(Math.round(Number(body?.days) || 30), 1), 92);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    // 权限与项目解析：ADMIN 可不选项目（全团队）；负责人必须选自己负责的项目
    let project: { id: string; name: string; ownerId: string; dingtalkConversationId: string | null } | null = null;
    if (body?.projectId) {
      project = await this.prisma.project.findUnique({
        where: { id: body.projectId },
        select: { id: true, name: true, ownerId: true, dingtalkConversationId: true },
      });
      if (!project) throw new NotFoundException('项目不存在');
      if (!isAdmin && project.ownerId !== userId)
        throw new ForbiddenException('仅该项目负责人或管理员可提取 SOP');
    } else if (!isAdmin) {
      throw new ForbiddenException('仅管理员可提取全团队记录；项目负责人请选择自己负责的项目');
    }
    const scopeName = project ? `项目「${project.name}」` : '团队';

    // ---- 材料一：群聊消息（项目维度按绑定群过滤；未绑群的指定项目无群聊材料） ----
    const messageWhere = {
      receivedAt: { gte: since },
      content: { not: null },
      ...(body?.projectId
        ? project?.dingtalkConversationId
          ? { conversationId: project.dingtalkConversationId }
          : { conversationId: '__unbound__' }
        : {}),
    };
    const messages = await this.prisma.messageInbox.findMany({
      where: messageWhere,
      orderBy: { receivedAt: 'desc' },
      take: 150,
    });
    const msgTexts = messages
      .filter((m) => m.content && !/^\[(图片|文件|语音|视频|链接|消息)\]/.test(m.content))
      .map((m) => {
        const group = m.conversationName ? `（${m.conversationName}）` : '';
        const who = m.senderName ?? '成员';
        // 单条截断 90 字并限量：输入过长会触发推理模型思考超限截断（v4-flash 实测 4k+ 字即开始不稳），经验线索在短句内即可判断
        return `[${m.receivedAt.toISOString().slice(0, 16)}]${group} ${who}: ${(m.content ?? '').slice(0, 90)}`;
      });

    // ---- 材料二：日报/周报（已发布；项目维度按 projectId 归属过滤） ----
    const reports = await this.prisma.report.findMany({
      where: {
        updatedAt: { gte: since },
        status: ReportStatus.PUBLISHED,
        ...(body?.projectId ? { projectId: body.projectId } : {}),
      },
      include: { owner: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const reportTexts: string[] = [];
    for (const r of reports) {
      // 优先手写原文/修正文本，无则展平 AI 结构化内容
      let text = (r.rawContent ?? r.correctedContent ?? '').trim();
      if (!text) {
        const content = (r.content as { summary?: string; sections?: { title?: string; items?: string[] }[] } | null) ?? null;
        text = [content?.summary ?? '', ...(content?.sections ?? []).map((s) => `${s.title ?? ''}\n${(s.items ?? []).join('\n')}`)]
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      if (r.manualContent) text = `${text}\n【手动补充】${r.manualContent}`;
      if (!text) continue;
      const kind = r.type === 'WEEKLY' ? '周报' : '日报';
      const who = r.owner?.name ?? '成员';
      const span = `${r.periodStart.toISOString().slice(0, 10)} ~ ${r.periodEnd.toISOString().slice(0, 10)}`;
      reportTexts.push(`[${span}] ${kind}｜${who}\n${text.slice(0, 600)}`);
    }

    // 总预算 1.2 万字符：与复盘提取同一量级（实测该量级推理模型不超限）；消息与报告各取最新（desc 顺序贪心），超限保留最新内容
    const budget = 12_000;
    const sections: string[] = [];
    for (const [label, texts] of [
      ['群聊记录', msgTexts],
      ['日报与周报', reportTexts],
    ] as const) {
      let acc = '';
      for (const t of texts) {
        if (acc.length >= budget) break;
        acc = `${acc}\n${t}`;
      }
      if (acc.trim()) sections.push(`## ${label}\n${acc.trim()}`);
    }
    const sourceText = sections.join('\n\n');
    if (!sourceText.trim()) {
      return {
        created: [],
        skipped: 0,
        sources: { messages: 0, reports: 0 },
        note: `最近 ${days} 天没有可用的群聊/日报/周报文字记录`,
      };
    }

    // 已有 SOP：AI 语义去重输入（最近 100 条）+ 代码兜底全局同名跳过
    const existingSops = await this.prisma.sop.findMany({
      where: { status: { in: [SopStatus.APPROVED, SopStatus.CANDIDATE] } },
      select: { title: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    const ai = await this.ai.generateJson<{ sops?: { title?: string; content?: string }[] }>(
      'sop.extract.team',
      {
        scopeName,
        days,
        sourceText,
        existingSops: existingSops.length
          ? existingSops.map((e) => `- ${e.title}：${(e.content || '').slice(0, 120)}`).join('\n')
          : '（无）',
      },
    );
    const candidates = (ai?.sops ?? []).filter(
      (s): s is { title: string; content: string } =>
        typeof s?.title === 'string' &&
        !!s.title.trim() &&
        typeof s?.content === 'string' &&
        !!s.content.trim(),
    );
    if (!candidates.length) {
      return {
        created: [],
        skipped: 0,
        sources: { messages: msgTexts.length, reports: reportTexts.length },
        note: 'AI 未提取到新的 SOP（可能与已有 SOP 重复或无有效内容）',
      };
    }

    // 代码兜底去重：与任一 CANDIDATE/APPROVED SOP 近似同名 title 跳过（归一化同名 / 互含 / Dice 相似）
    const existingAll = await this.prisma.sop.findMany({
      where: { status: { in: [SopStatus.CANDIDATE, SopStatus.APPROVED] } },
      select: { title: true },
    });
    const seenTitles = existingAll.map((e) => normalizeTitle(e.title));

    const created: any[] = [];
    let skipped = 0;
    for (const c of candidates) {
      const title = c.title.trim();
      const content = c.content.trim();
      if (isNearDuplicateTitle(normalizeTitle(title), seenTitles)) {
        skipped += 1;
        continue;
      }
      seenTitles.push(normalizeTitle(title));
      created.push(
        await this.prisma.sop.create({
          data: {
            title,
            content,
            status: SopStatus.CANDIDATE,
            sourceType: SopSourceType.TEAM_EXTRACT,
            projectId: body?.projectId || null,
            proposerId: userId,
          },
          include: {
            project: { select: { id: true, name: true } },
            retro: { select: { id: true, title: true } },
            proposer: { select: { id: true, name: true } },
          },
        }),
      );
    }
    return { created, skipped, sources: { messages: msgTexts.length, reports: reportTexts.length } };
  }

  // ---- 确认/编辑 ----

  /** 确认/拒绝/编辑/打标签（ADMIN 或来源项目负责人）；approve 记录确认人，reject 标 REJECTED 保留审计 */
  async patch(
    id: string,
    userId: string,
    body: { status?: SopStatus; title?: string; content?: string; tags?: string[]; addTags?: string[] },
  ) {
    const sop = await this.prisma.sop.findUnique({ where: { id } });
    if (!sop) throw new NotFoundException('SOP 不存在');
    if (!(await this.canManage(sop, userId)))
      throw new ForbiddenException('仅管理员或该 SOP 来源项目负责人可操作');

    const data: {
      status?: SopStatus;
      title?: string;
      content?: string;
      tags?: string[];
      confirmedById?: string;
      confirmedAt?: Date;
    } = {};
    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) throw new BadRequestException('标题不能为空');
      data.title = title;
    }
    if (body.content !== undefined) {
      const content = body.content.trim();
      if (!content) throw new BadRequestException('内容不能为空');
      data.content = content;
    }
    if (body.tags) data.tags = [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 10);
    else if (body.addTags?.length) {
      const merged = [...sop.tags, ...body.addTags.map((t) => t.trim()).filter(Boolean)];
      data.tags = [...new Set(merged)].slice(0, 10);
    }
    if (body.status) {
      data.status = body.status;
      if (body.status === SopStatus.APPROVED) {
        data.confirmedById = userId;
        data.confirmedAt = new Date();
      }
    }
    return this.prisma.sop.update({
      where: { id },
      data,
      include: {
        project: { select: { id: true, name: true } },
        retro: { select: { id: true, title: true } },
        proposer: { select: { id: true, name: true } },
        confirmedBy: { select: { id: true, name: true } },
      },
    });
  }

  /** 删除（ADMIN 或来源项目负责人） */
  async remove(id: string, userId: string) {
    const sop = await this.prisma.sop.findUnique({ where: { id } });
    if (!sop) throw new NotFoundException('SOP 不存在');
    if (!(await this.canManage(sop, userId)))
      throw new ForbiddenException('仅管理员或该 SOP 来源项目负责人可删除');
    await this.prisma.sop.delete({ where: { id } });
    return { ok: true };
  }
}
