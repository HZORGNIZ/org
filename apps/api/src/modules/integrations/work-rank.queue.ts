import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from '../../common/beijing-time';

/**
 * 每周工时排名队列（work-rank）
 * - weekly：汇总本周日报工时生成 Top 榜并发到管理后台勾选的钉钉群（见 WorkRankService）
 * - 默认每周日 21:00 北京时间（cron `0 21 * * 0`），可用 WORK_RANK_CRON 调整
 * - tz 固定 Asia/Shanghai，避免 BullMQ 按 UTC 解释偏 8 小时
 */
@Injectable()
export class WorkRankQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(WorkRankQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('work-rank', { connection });
  }

  /** 注册每周定时（幂等） */
  async schedule(cron: string) {
    if (!cron || !cron.trim()) throw new Error('每周工时排名 cron 为空');
    await this.queue.upsertJobScheduler(
      'work-rank:weekly',
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'weekly' },
    );
    this.logger.log(`每周工时排名已注册（cron: ${cron}）｜下次 ${await this.nextRunAt()}`);
  }

  /** 移除定时（总闸关闭时调用） */
  async removeSchedule() {
    try {
      await this.queue.removeJobScheduler('work-rank:weekly');
    } catch {
      // 未注册过则忽略
    }
  }

  /** 当前已注册的调度器与下次触发时间（管理后台展示用；查询失败返回 null） */
  async nextRunAt(): Promise<string | null> {
    try {
      const items = (await this.queue.getJobSchedulers()) as any[];
      const hit = items?.find((s) => (s?.key ?? s?.id ?? s?.name) === 'work-rank:weekly');
      const next = typeof hit?.next === 'number' ? fmtBeijing(new Date(hit.next)) : null;
      return next;
    } catch {
      return null;
    }
  }

  /** 手动触发一次（delayMs 可选延迟） */
  async trigger(delayMs = 0) {
    return this.queue.add('weekly', {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 });
  }
}
