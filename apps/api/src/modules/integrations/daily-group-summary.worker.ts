import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DailyGroupSummaryService } from './daily-group-summary.service';

/** BullMQ Worker：消费每日小组小结任务（daily；cron 见 DailyGroupSummaryQueue） */
@Injectable()
export class DailyGroupSummaryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DailyGroupSummaryWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private summary: DailyGroupSummaryService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'daily-group-summary',
      async (job) => {
        if (job.name !== 'daily') return;
        const r: any = await this.summary.runScheduled();
        if (r.skipped) {
          this.logger.warn(`每日小组小结跳过: ${r.reason}`);
          return;
        }
        this.logger.log(
          `每日小组小结完成 date=${r.date}，发群 ${r.groups.filter((g: any) => g.ok).length}/${r.groups.length}`,
        );
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`每日小组小结失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('每日小组小结 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
