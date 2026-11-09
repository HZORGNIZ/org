import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NewsItemStatus, NewsSourceType, Prisma } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../../common/prisma.service';
import { NewsQueue } from './news-queue.service';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  /** feed AI 过滤内存缓存（10 分钟）；键=view+规则文本散列，规则文本变更即失效 */
  private readonly feedCache = new Map<
    string,
    { at: number; picks: { id: string; score: number; reason?: string }[] }
  >();
  private readonly FEED_CACHE_TTL = 10 * 60 * 1000;

  constructor(
    private prisma: PrismaService,
    private queue: NewsQueue,
    private ai: AiService,
  ) {}

  // ---- 资讯源 ----

  /** 可见资讯源：团队级源（全员可见）+ 个人源（自己/订阅的） */
  async listSources(userId: string) {
    const sources = await this.prisma.newsSource.findMany({
      where: {
        OR: [
          { isTeamWide: true },
          { ownerId: userId },
          { subs: { some: { userId, active: true } } },
        ],
      },
      include: {
        owner: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ isTeamWide: 'desc' }, { createdAt: 'asc' }],
    });
    // 附加当前用户订阅状态
    const subs = await this.prisma.newsSubscription.findMany({
      where: { userId, active: true },
      select: { sourceId: true },
    });
    const subSet = new Set(subs.map((s) => s.sourceId));
    return sources.map((s) => ({ ...s, subscribed: subSet.has(s.id) }));
  }

  async createSource(
    userId: string,
    data: {
      name: string;
      url: string;
      type?: NewsSourceType;
      category?: string;
      fetchIntervalMin?: number;
    },
    isAdmin: boolean,
  ) {
    const isTeam = data.type === NewsSourceType.TEAM || (isAdmin && data.type !== NewsSourceType.PERSONAL);
    if (isTeam && !isAdmin) {
      throw new BadRequestException('只有管理员可以创建团队级资讯源');
    }
    const source = await this.prisma.newsSource.create({
      data: {
        name: data.name,
        url: data.url,
        type: isTeam ? NewsSourceType.TEAM : NewsSourceType.PERSONAL,
        isTeamWide: isTeam,
        ownerId: isTeam ? null : userId,
        category: data.category,
        fetchIntervalMin: data.fetchIntervalMin ?? 60,
      },
    });
    await this.queue.scheduleFetch(source.id, source.fetchIntervalMin);
    return source;
  }

  async updateSource(
    id: string,
    data: {
      name?: string;
      url?: string;
      category?: string;
      fetchIntervalMin?: number;
      enabled?: boolean;
    },
  ) {
    const source = await this.prisma.newsSource.update({ where: { id }, data });
    if (data.enabled) await this.queue.scheduleFetch(id, source.fetchIntervalMin);
    if (data.enabled === false) await this.queue.unscheduleFetch(id);
    if (data.fetchIntervalMin) await this.queue.scheduleFetch(id, data.fetchIntervalMin);
    return source;
  }

  async removeSource(id: string) {
    await this.queue.unscheduleFetch(id);
    return this.prisma.newsSource.delete({ where: { id } });
  }

  // ---- 订阅 ----

  async subscribe(userId: string, sourceId: string) {
    const source = await this.prisma.newsSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException('资讯源不存在');
    if (source.isTeamWide) throw new BadRequestException('团队级资讯源全员可见，无需订阅');
    return this.prisma.newsSubscription.upsert({
      where: { userId_sourceId: { userId, sourceId } },
      create: { userId, sourceId, active: true },
      update: { active: true },
    });
  }

  async unsubscribe(userId: string, sourceId: string) {
    return this.prisma.newsSubscription.updateMany({
      where: { userId, sourceId },
      data: { active: false },
    });
  }

  // ---- 资讯条目 ----

  /** 可见资讯：团队源 + 我订阅的个人源 + 我的个人源；可指定 sourceId 只看某源（不可见源返回空） */
  async listItems(
    userId: string,
    query: { keyword?: string; tag?: string; sourceId?: string; limit?: number },
  ) {
    const visibleSourceIds = (
      await this.prisma.newsSource.findMany({
        where: {
          enabled: true,
          OR: [
            { isTeamWide: true },
            { ownerId: userId },
            { subs: { some: { userId, active: true } } },
          ],
        },
        select: { id: true },
      })
    ).map((s) => s.id);

    const where: Prisma.NewsItemWhereInput = {
      // 指定源时仅在其可见时生效，否则返回空
      sourceId: query.sourceId
        ? visibleSourceIds.includes(query.sourceId)
          ? query.sourceId
          : { in: [] }
        : { in: visibleSourceIds },
      ...(query.keyword
        ? { OR: [{ title: { contains: query.keyword } }, { summary: { contains: query.keyword } }] }
        : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
    };
    const [items, allTags] = await Promise.all([
      this.prisma.newsItem.findMany({
        where,
        include: { source: { select: { id: true, name: true, category: true } } },
        orderBy: { publishedAt: 'desc' },
        take: query.limit ?? 100,
      }),
      this.prisma.newsItem.findMany({
        where: { sourceId: { in: visibleSourceIds } },
        select: { tags: true },
        take: 500,
      }),
    ]);
    const tagSet = new Set<string>();
    allTags.forEach((i) => i.tags.forEach((t) => tagSet.add(t)));
    return { items, allTags: [...tagSet] };
  }

  async getItem(id: string, userId: string) {
    const item = await this.prisma.newsItem.findUnique({
      where: { id },
      include: { source: { select: { id: true, name: true, category: true, isTeamWide: true, ownerId: true } } },
    });
    if (!item) throw new NotFoundException('资讯不存在');
    const visible = item.source.isTeamWide || item.source.ownerId === userId;
    if (!visible) {
      const sub = await this.prisma.newsSubscription.findUnique({
        where: { userId_sourceId: { userId, sourceId: item.sourceId } },
      });
      if (!sub?.active) throw new NotFoundException('资讯不存在');
    }
    return item;
  }

  /** 手动触发抓取（管理员/源所有者） */
  async fetchNow(sourceId: string) {
    return this.queue.triggerFetch(sourceId);
  }

  // ---- 资讯展示规则（组长=项目负责人 / 个人兴趣） ----

  private async roleOf(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return u?.role ?? 'MEMBER';
  }

  private async isAdmin(userId: string) {
    return (await this.roleOf(userId)) === 'ADMIN';
  }

  /** 读取项目展示规则（项目成员及以上可读） */
  async getProjectRule(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: { select: { userId: true } } },
    });
    if (!project) throw new NotFoundException('项目不存在');
    const isMember = project.ownerId === userId || project.members.some((m) => m.userId === userId);
    if (!isMember && !(await this.isAdmin(userId))) throw new ForbiddenException('仅项目成员可查看展示规则');
    const rule = await this.prisma.projectNewsRule.findUnique({ where: { projectId } });
    return { projectId, projectName: project.name, guideText: rule?.guideText ?? '' };
  }

  /** 保存项目展示规则（该项目负责人/管理员）；空文本 = 清除规则 */
  async saveProjectRule(projectId: string, userId: string, guideText: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('项目不存在');
    if (!(await this.isAdmin(userId)) && project.ownerId !== userId)
      throw new ForbiddenException('仅项目负责人或管理员可设定展示规则');
    const text = (guideText ?? '').trim();
    if (!text) {
      await this.prisma.projectNewsRule.deleteMany({ where: { projectId } });
      return { projectId, guideText: '' };
    }
    const rule = await this.prisma.projectNewsRule.upsert({
      where: { projectId },
      create: { projectId, guideText: text },
      update: { guideText: text },
    });
    return rule;
  }

  /** 读取个人资讯兴趣 */
  async getMyInterest(userId: string) {
    const pref = await this.prisma.userNewsPref.findUnique({ where: { userId } });
    return { interestText: pref?.interestText ?? '' };
  }

  /** 保存个人资讯兴趣（空文本 = 清除） */
  async saveMyInterest(userId: string, interestText: string) {
    const text = (interestText ?? '').trim();
    if (!text) {
      await this.prisma.userNewsPref.deleteMany({ where: { userId } });
      return { interestText: '' };
    }
    const pref = await this.prisma.userNewsPref.upsert({
      where: { userId },
      create: { userId, interestText: text },
      update: { interestText: text },
    });
    return pref;
  }

  // ---- 团队资讯 feed（按规则 AI 精选） ----

  private simpleHash(text: string) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return h.toString(36);
  }

  /**
   * 资讯 feed：候选 = 团队级源 7 天内资讯（≤120 条，时间倒序）
   * - view=all → 原样返回（filteredBy=null）
   * - view=project:<projectId> / interest → 取规则文本，空规则降级 all；
   *   有规则则 AI 按 news.rule.filter 精选（10 分钟缓存；AI 失败降级前 30 条）
   */
  async listFeed(userId: string, view: string, limit = 30) {
    const take = Math.min(Math.max(limit || 30, 1), 50);
    const since = new Date(Date.now() - 7 * 86400 * 1000);
    const candidates = await this.prisma.newsItem.findMany({
      where: { publishedAt: { gte: since }, source: { isTeamWide: true, enabled: true } },
      include: { source: { select: { id: true, name: true, category: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 120,
    });

    let ruleText = '';
    if (view && view !== 'all' && view !== 'interest') {
      const projectId = view.startsWith('project:') ? view.slice('project:'.length) : '';
      if (!projectId) throw new BadRequestException('view 参数不合法');
      // 仅项目成员可用该项目精选
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        include: { members: { select: { userId: true } } },
      });
      if (!project) throw new NotFoundException('项目不存在');
      const isMember = project.ownerId === userId || project.members.some((m) => m.userId === userId);
      if (!isMember && !(await this.isAdmin(userId)))
        throw new ForbiddenException('仅项目成员可查看该项目资讯精选');
      const rule = await this.prisma.projectNewsRule.findUnique({ where: { projectId } });
      ruleText = rule?.guideText?.trim() ?? '';
    } else if (view === 'interest') {
      const pref = await this.prisma.userNewsPref.findUnique({ where: { userId } });
      ruleText = pref?.interestText?.trim() ?? '';
    }

    // 无规则文本（或 all）→ 降级为候选列表原样返回
    if (!ruleText) return { view: view || 'all', filteredBy: null, items: candidates.slice(0, take) };

    const cacheKey = `feed:${view}:${this.simpleHash(ruleText)}`;
    const cached = this.feedCache.get(cacheKey);
    let picks: { id: string; score: number; reason?: string }[] | null = null;
    if (cached && Date.now() - cached.at < this.FEED_CACHE_TTL) {
      picks = cached.picks;
    } else {
      const aiItems = candidates.map((i) => {
        const tag = [i.source.category, ...(i.tags ?? [])].filter(Boolean).join('/');
        return `- ${i.id} | ${tag ? `[${tag}] ` : ''}${i.title}${i.summary ? `（${i.summary.slice(0, 80)}）` : ''}`;
      });
      try {
        const ai = await this.ai.generateJson<{
          items?: { id?: string; score?: number; reason?: string }[];
        }>('news.rule.filter', { ruleText, items: aiItems.join('\n') });
        const validIds = new Set(candidates.map((c) => c.id));
        picks = (ai?.items ?? [])
          .filter((x) => typeof x.id === 'string' && validIds.has(x.id) && Number.isFinite(x.score))
          .map((x) => ({ id: x.id as string, score: Number(x.score), reason: x.reason }))
          .sort((a, b) => b.score - a.score)
          .slice(0, take);
      } catch (e) {
        this.logger.warn(`资讯规则筛选失败（降级）: ${(e as Error).message}`);
        picks = null;
      }
      if (picks && picks.length) this.feedCache.set(cacheKey, { at: Date.now(), picks });
      else picks = null;
    }

    if (!picks || !picks.length) {
      return { view, filteredBy: null, items: candidates.slice(0, take) };
    }
    const reasonBy = new Map(picks.map((p) => [p.id, p.reason]));
    const idOrder = new Map(picks.map((p, i) => [p.id, i]));
    const items = candidates
      .filter((c) => idOrder.has(c.id))
      .map((c) => ({ ...c, matchReason: reasonBy.get(c.id) ?? null }))
      .sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
    return { view, filteredBy: 'ai', items };
  }
}
