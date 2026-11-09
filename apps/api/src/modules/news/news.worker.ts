import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { NewsFetchService } from './news-fetch.service';

/** BullMQ Worker：消费资讯抓取/摘要任务 */
@Injectable()
export class NewsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NewsWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private fetchService: NewsFetchService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'news',
      async (job) => {
        if (job.name === 'fetch') {
          await this.fetchService.fetchSource(job.data.sourceId);
        } else if (job.name === 'summarize') {
          await this.fetchService.summarizeItems(job.data.itemIds);
        }
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`资讯任务失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('资讯 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
