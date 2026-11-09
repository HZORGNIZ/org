import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * 资讯任务队列：抓取 + AI 摘要
 * - fetch：抓取 RSS/网页并去重入库
 * - summarize：AI 摘要与打标签
 * 每个资讯源按 fetchIntervalMin 定时重复入队
 */
@Injectable()
export class NewsQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(NewsQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('news', { connection });
  }

  /** 注册资讯源的定时抓取（JobScheduler 重复任务，按源更新周期） */
  async scheduleFetch(sourceId: string, intervalMin: number) {
    const schedulerId = `fetch:${sourceId}`;
    await this.queue.upsertJobScheduler(
      schedulerId,
      { every: Math.max(intervalMin, 5) * 60 * 1000 },
      { name: 'fetch', data: { sourceId } },
    );
    this.logger.log(`资讯源 ${sourceId} 已注册定时抓取（${intervalMin} 分钟）`);
  }

  async unscheduleFetch(sourceId: string) {
    await this.queue.removeJobScheduler(`fetch:${sourceId}`);
  }

  async triggerFetch(sourceId: string) {
    return this.queue.add('fetch', { sourceId }, { removeOnComplete: 100, removeOnFail: 1000 });
  }

  async triggerSummarize(itemIds: string[]) {
    return this.queue.add('summarize', { itemIds }, { removeOnComplete: 100, removeOnFail: 1000 });
  }
}
