import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ReportReminderService } from './report-reminder.service';

/** BullMQ Worker：消费日报未写提醒检查任务（check；cron 见 ReportReminderQueue） */
@Injectable()
export class ReportReminderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReportReminderWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private reminder: ReportReminderService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'report-reminder',
      async (job) => {
        if (job.name !== 'check') return;
        const r: any = await this.reminder.run();
        if (r.skipped) {
          this.logger.warn(`日报未写提醒跳过: ${r.reason}`);
          return;
        }
        this.logger.log(
          `日报未写提醒完成：涉及 ${r.departments} 个部门规则，已提醒 ${r.reminded}/${r.items.length} 人`,
        );
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`日报未写提醒失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('日报未写提醒 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
