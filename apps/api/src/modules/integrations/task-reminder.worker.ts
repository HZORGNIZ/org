import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { TaskReminderService } from './task-reminder.service';

/** BullMQ Worker：消费任务逾期提醒检查任务（check；cron 见 TaskReminderQueue） */
@Injectable()
export class TaskReminderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TaskReminderWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private reminder: TaskReminderService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'task-reminder',
      async (job) => {
        if (job.name !== 'check') return;
        const r: any = await this.reminder.run();
        if (r.skipped) {
          this.logger.warn(`任务逾期提醒跳过: ${r.reason}`);
          return;
        }
        this.logger.log(
          `任务逾期提醒完成：逾期候选 ${r.candidates} 个，已提醒 ${r.items.filter((i: any) => i.sent).length}/${r.items.length} 人`,
        );
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`任务逾期提醒失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('任务逾期提醒 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
