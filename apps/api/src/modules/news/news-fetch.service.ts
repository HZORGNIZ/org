import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NewsItemStatus } from '@prisma/client';
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import Parser from 'rss-parser';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { NewsQueue } from './news-queue.service';

const parser = new Parser({ timeout: 15000 });

export interface NewsPushPort {
  pushNews(item: { title: string; summary?: string | null; url: string; tags?: string[] }): Promise<void>;
}

/** 资讯抓取与摘要（供 BullMQ worker 调用） */
@Injectable()
export class NewsFetchService {
  private readonly logger = new Logger(NewsFetchService.name);
  private pushPort: NewsPushPort | null = null;

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private queue: NewsQueue,
  ) {}

  /** 注册推送端口（由集成模块在启用时注入） */
  setPushPort(port: NewsPushPort | null) {
    this.pushPort = port;
  }

  /** 启动时恢复所有启用源的定时抓取 */
  async restoreSchedules() {
    const sources = await this.prisma.newsSource.findMany({ where: { enabled: true } });
    for (const s of sources) {
      await this.queue.scheduleFetch(s.id, s.fetchIntervalMin);
    }
    this.logger.log(`已恢复 ${sources.length} 个资讯源的定时抓取`);
  }

  /** 抓取单个资讯源：解析 RSS/网页 -> 去重入库 -> 入队摘要 */
  async fetchSource(sourceId: string) {
    const source = await this.prisma.newsSource.findUnique({ where: { id: sourceId } });
    if (!source || !source.enabled) return { added: 0 };

    let items: Parser.Item[] = [];
    try {
      const feed = await parser.parseURL(source.url);
      items = feed.items ?? [];
    } catch (e) {
      // RSS 解析失败，尝试把网页本身当 HTML 抓取，提取标题与正文片段
      this.logger.warn(`RSS 解析失败 ${source.url}: ${(e as Error).message}`);
      try {
        const res = await fetch(source.url, { signal: AbortSignal.timeout(15000) });
        const html = await res.text();
        const $ = cheerio.load(html);
        const title = $('h1').first().text().trim() || $('title').first().text().trim();
        const content = $('article, main, .content').first().text().trim().slice(0, 2000);
        if (title) {
          items = [{ title, link: source.url, contentSnippet: content, isoDate: new Date().toISOString() }];
        }
      } catch (e2) {
        this.logger.error(`网页抓取失败 ${source.url}: ${(e2 as Error).message}`);
      }
    }

    let added = 0;
    for (const item of items) {
      const title = (item.title ?? '').trim();
      const link = (item.link ?? '').trim();
      if (!title) continue;
      const hash = createHash('md5').update(link || title).digest('hex');
      const exists = await this.prisma.newsItem.findUnique({ where: { contentHash: hash } });
      if (exists) continue;
      try {
        await this.prisma.newsItem.create({
          data: {
            sourceId,
            title,
            url: link || source.url,
            content: (item.contentSnippet ?? '').slice(0, 2000),
            publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
            contentHash: hash,
          },
        });
        added += 1;
      } catch (e: any) {
        // 并发抓取时唯一约束冲突：视为已存在，跳过
        if (e?.code === 'P2002') continue;
        throw e;
      }
    }
    await this.prisma.newsSource.update({
      where: { id: sourceId },
      data: { lastFetchedAt: new Date() },
    });
    if (added > 0) {
      const newItems = await this.prisma.newsItem.findMany({
        where: { sourceId, status: NewsItemStatus.FETCHED },
        orderBy: { publishedAt: 'desc' },
        take: added,
      });
      await this.queue.triggerSummarize(newItems.map((i) => i.id));
    }
    this.logger.log(`资讯源「${source.name}」抓取完成，新增 ${added} 条`);
    return { added };
  }

  /** AI 摘要 + 打标签 + 站内通知/推送 */
  async summarizeItems(itemIds: string[]) {
    for (const id of itemIds) {
      try {
        const item = await this.prisma.newsItem.findUnique({ where: { id } });
        if (!item || item.status !== NewsItemStatus.FETCHED) continue;
        const aiResult = await this.ai.generateJson<{ summary: string; tags: string[] }>(
          'news.summary',
          { title: item.title, content: item.content ?? '', url: item.url },
        );
        const summary = aiResult?.summary ?? item.content?.slice(0, 200) ?? '';
        const tags = aiResult?.tags?.slice(0, 5) ?? [];
        await this.prisma.newsItem.update({
          where: { id },
          data: { summary, tags, status: NewsItemStatus.SUMMARIZED },
        });

        // 资讯不再产生站内消息通知（用户要求仅进展/日报周报类提示）；仅保留可选推送（钉钉群等）
        const source = await this.prisma.newsSource.findUnique({ where: { id: item.sourceId } });
        if (!source) continue;
        if (this.pushPort && source.isTeamWide) {
          await this.pushPort.pushNews({ title: item.title, summary, url: item.url, tags });
        }
      } catch (e) {
        this.logger.error(`资讯摘要失败 ${id}: ${(e as Error).message}`);
      }
    }
  }
}
