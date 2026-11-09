import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * 项目进展队列
 * - scan：扫描所有关联钉钉群的项目，AI 总结增量群消息为项目进展
 * 通过 JobScheduler 按 PROGRESS_INTERVAL_MIN（默认 60 分钟）定时触发
 */
@Injectable()
export class ProgressQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(ProgressQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('progress', { connection });
  }

  /** 注册定时扫描（幂等：同一 schedulerId 重复注册会更新间隔） */
  async scheduleScan(intervalMin: number) {
    const every = Math.max(intervalMin, 5) * 60 * 1000;
    await this.queue.upsertJobScheduler(
      'progress:scan',
      { every },
      { name: 'scan' },
    );
    this.logger.log(`项目进展扫描已注册（每 ${intervalMin} 分钟）`);
  }

  /** 手动触发一次扫描（可指定单项目；lookbackHours = 无历史总结时回看小时数） */
  async triggerScan(projectId?: string, lookbackHours = 24) {
    return this.queue.add(
      'scan',
      { projectId: projectId ?? null, lookbackHours },
      { removeOnComplete: 100, removeOnFail: 1000 },
    );
  }
}
