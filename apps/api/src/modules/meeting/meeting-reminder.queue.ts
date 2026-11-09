import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from '../../common/beijing-time';

/**
 * 会议提醒队列（meeting-reminder）
 * - tick：每 5 分钟扫一遍「到点的开始提醒」与「会前材料缺交催办」
 * - daily：每日 08:00 给自动创建但尚未发布的周会负责人发「本周周会待发布」（冷启动首场）
 * - send：业务动作（发布/取消/纪要）异步投递的一次性通知，避免接口被 dws 子进程拖住
 * - cron 一律带 tz: 'Asia/Shanghai'（否则 BullMQ 按 UTC 解释会偏 8 小时）
 */
@Injectable()
export class MeetingReminderQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(MeetingReminderQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('meeting-reminder', { connection });
  }

  /** 注册到点提醒扫描（每 5 分钟一次；开始提醒的时效要求高于每日总结） */
  async scheduleTick(cron: string) {
    if (!cron || !cron.trim()) throw new Error('会议提醒 tick cron 为空');
    await this.queue.upsertJobScheduler('meeting-reminder:tick', { pattern: cron, tz: 'Asia/Shanghai' }, { name: 'tick' });
    this.logger.log(`会议到点提醒已注册（cron: ${cron}）｜${await this.describeSchedulers()}`);
  }

  /** 注册每日草稿周会待发布提醒（默认 08:00 北京时间，落在可发送窗口内） */
  async scheduleDaily(cron: string) {
    if (!cron || !cron.trim()) throw new Error('会议草稿提醒 cron 为空');
    await this.queue.upsertJobScheduler('meeting-reminder:daily', { pattern: cron, tz: 'Asia/Shanghai' }, { name: 'daily' });
    this.logger.log(`周会待发布提醒已注册（cron: ${cron}）`);
  }

  /** 投递一次性通知（发布/取消/纪要）；kind 见 MeetingNotifyKind */
  async pushSend(meetingId: string, kind: string, delayMs = 0) {
    return this.queue.add('send', { meetingId, kind }, { delay: delayMs, removeOnComplete: 200, removeOnFail: 1000 });
  }

  /** 手动触发一次 tick / daily（管理员验证用，delayMs=0 立即执行） */
  async trigger(name: 'tick' | 'daily', delayMs = 0) {
    return this.queue.add(name, {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 });
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
}
