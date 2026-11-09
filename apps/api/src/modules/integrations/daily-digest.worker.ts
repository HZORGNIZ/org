import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DailyDigestService } from './daily-digest.service';

/** BullMQ Worker：消费每日团队进展总结任务（digest，时间见管理后台设置，默认每天 20:00） */
@Injectable()
export class DailyDigestWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DailyDigestWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private digest: DailyDigestService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'daily-digest',
      async (job) => {
        // 项目群发 tick：逐个按各项目 digestTime/digestEveryDays 判定到期并发送
        if (job.name === 'groups-tick') {
          const r = await this.digest.runGroupTick();
          if (r.sent) this.logger.log(`项目群发 tick：候选 ${r.checked} 个，实际发送 ${r.sent} 个`);
          return;
        }
        if (job.name !== 'digest') return;
        // 全局定时任务只做私聊汇总（群发已下沉到按项目 digest:groups tick，避免重复发群）
        const r: any = await this.digest.run({ onlyDm: true });
        if (r?.skipped) {
          this.logger.warn(`每日总结跳过: ${r.reason}`);
          return;
        }
        this.logger.log(
          `每日总结私聊「${r.dm?.to}」${r.dm?.sent ? '已发送' : '未发送'}`,
        );
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`每日总结任务失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('每日团队进展总结 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
