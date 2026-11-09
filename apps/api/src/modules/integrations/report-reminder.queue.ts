import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from '../../common/beijing-time';

/**
 * 日报未写提醒队列（report-reminder）
 * - check：按各部门「日报规则」检查未写日报的成员并钉钉私聊提醒（见 ReportReminderService）
 * - 默认 cron `0 8-21 * * *`（北京时间每天 8-21 点整点各检查一次），实际提醒时点由
 *   部门 reportRemindTime 在服务内二次 gating；每人每北京日最多提醒一次
 */
@Injectable()
export class ReportReminderQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(ReportReminderQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('report-reminder', { connection });
  }

  /** 注册定时检查（幂等；tz 固定 Asia/Shanghai，避免 BullMQ 按 UTC 解释偏 8 小时） */
  async schedule(cron: string) {
    if (!cron || !cron.trim()) throw new Error('日报提醒 cron 为空');
    await this.queue.upsertJobScheduler(
      'report-reminder:check',
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'check' },
    );
    this.logger.log(`日报未写提醒已注册（cron: ${cron}）｜${await this.describeSchedulers()}`);
  }

  /** 当前已注册的调度器与下次触发时间（北京时间；启动自检日志用） */
  async describeSchedulers(): Promise<string> {
    try {
      const items = (await this.queue.getJobSchedulers()) as any[];
      if (!items?.length) return '当前无调度器';
      return items
        .map((s) => {
          const id = s?.key ?? s?.id ?? s?.name ?? '?';
          const next = typeof s?.next === 'number' ? fmtBeijing(new Date(s.next)) : '未知';
          return `${id} 下次 ${next}`;
        })
        .join('；');
    } catch {
      return '调度器查询失败';
    }
  }

  /** 手动触发一次检查（delayMs 可选延迟） */
  async trigger(delayMs = 0) {
    return this.queue.add('check', {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 });
  }
}
