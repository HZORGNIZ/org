import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { WorkRankService } from './work-rank.service';

/** BullMQ Worker：消费每周工时排名任务（weekly；cron 见 WorkRankQueue） */
@Injectable()
export class WorkRankWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkRankWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private rank: WorkRankService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'work-rank',
      async (job) => {
        if (job.name !== 'weekly') return;
        const r: any = await this.rank.runScheduled();
        if (r.skipped) {
          this.logger.warn(`每周工时排名跳过: ${r.reason}`);
          return;
        }
        this.logger.log(
          `每周工时排名完成 week=${r.result?.weekDate} 上榜 ${r.result?.rankedCount} 人，发群 ${r.groups.filter((g: any) => g.ok).length}/${r.groups.length}`,
        );
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`每周工时排名失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('每周工时排名 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
