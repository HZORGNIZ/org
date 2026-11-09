import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from '../../common/beijing-time';

/**
 * 每日小组小结队列（daily-group-summary）
 * - daily：为每个已绑定钉钉群的活跃项目生成「任务预期 + 今日日报」小结并发到各自群（见 DailyGroupSummaryService）
 * - 默认每天 18:00 北京时间（cron `0 18 * * *`），可用 DAILY_SUMMARY_CRON 调整；时间可在管理后台设置（存 Setting dailySummary.schedule）
 * - tz 固定 Asia/Shanghai，避免 BullMQ 按 UTC 解释偏 8 小时
 */
@Injectable()
export class DailyGroupSummaryQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(DailyGroupSummaryQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('daily-group-summary', { connection });
  }

  /** 注册每天定时（幂等） */
  async schedule(cron: string) {
    if (!cron || !cron.trim()) throw new Error('每日小组小结 cron 为空');
    await this.queue.upsertJobScheduler(
      'daily-group-summary:daily',
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'daily' },
    );
    this.logger.log(`每日小组小结已注册（cron: ${cron}）｜下次 ${await this.nextRunAt()}`);
  }

  /** 移除定时（总闸关闭时调用） */
  async removeSchedule() {
    try {
      await this.queue.removeJobScheduler('daily-group-summary:daily');
    } catch {
      // 未注册过则忽略
    }
  }

  /** 当前已注册的调度器与下次触发时间（管理后台展示用；查询失败返回 null） */
  async nextRunAt(): Promise<string | null> {
    try {
      const items = (await this.queue.getJobSchedulers()) as any[];
      const hit = items?.find((s) => (s?.key ?? s?.id ?? s?.name) === 'daily-group-summary:daily');
      const next = typeof hit?.next === 'number' ? fmtBeijing(new Date(hit.next)) : null;
      return next;
    } catch {
      return null;
    }
  }

  /** 手动触发一次（delayMs 可选延迟） */
  async trigger(delayMs = 0) {
    return this.queue.add('daily', {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 });
  }
}
