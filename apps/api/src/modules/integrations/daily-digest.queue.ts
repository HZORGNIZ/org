import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';

/** Setting 表中存每日总结推送时间的 key（value: { time: 'HH:mm' }，北京时间） */
export const DIGEST_SCHEDULE_KEY = 'digest.schedule';

/** 'HH:mm' → 每日 cron（如 '20:00' → '0 20 * * *'）；非法格式抛错 */
export function timeToCron(time: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim());
  if (!m) throw new Error('时间格式须为 HH:mm（北京时间）');
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

/** 简单 cron（m h * * *）→ 'HH:mm'；含列表/步长等复杂形式返回 null */
export function cronToTime(cron: string): string | null {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec((cron ?? '').trim());
  if (!m) return null;
  const min = Number(m[1]);
  const hour = Number(m[2]);
  if (min > 59 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * 每日团队进展总结队列（daily-digest）
 * - digest：生成并发送当日总结（私聊杨力 + 各项目群）
 * - 定时时间可在管理后台设置（存 Setting 表 digest.schedule，北京时间 HH:mm）；
 *   未设置时回退 DINGTALK_DIGEST_CRON（默认每天 20:00）
 */
@Injectable()
export class DailyDigestQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(DailyDigestQueue.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('daily-digest', { connection });
  }

  /** 注册每日定时触发（幂等；tz 固定 Asia/Shanghai，避免 BullMQ 按 UTC 解释偏 8 小时） */
  async scheduleDaily(cron: string) {
    if (!cron || !cron.trim()) throw new Error('每日总结 cron 为空');
    await this.queue.upsertJobScheduler(
      'digest:daily',
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'digest' },
    );
    this.logger.log(`每日总结已注册（cron: ${cron}）｜${await this.describeSchedulers()}`);
  }

  /**
   * 注册项目群发 tick（幂等；tz Asia/Shanghai）：每 15 分钟扫一次各项目自己的发送时刻/频率
   * - 与全局私聊汇总（digest:daily）解耦：群发完全由每个项目的 digestTime/digestEveryDays 决定
   */
  async scheduleGroupsTick(cron = '*/15 * * * *') {
    if (!cron || !cron.trim()) throw new Error('群发 tick cron 为空');
    await this.queue.upsertJobScheduler(
      'digest:groups',
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'groups-tick' },
    );
    this.logger.log(`项目群发 tick 已注册（cron: ${cron}）`);
  }

  /** 读取 Setting 表中的推送时间（'HH:mm'）；未设置或读取失败返回 null */
  private async loadStoredTime(): Promise<string | null> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: DIGEST_SCHEDULE_KEY } });
      const time = (row?.value as any)?.time;
      if (typeof time === 'string' && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(time.trim())) {
        return time.trim();
      }
    } catch (e) {
      this.logger.error(`读取推送时间设置失败: ${(e as Error).message}`);
    }
    return null;
  }

  /**
   * 启动注册：优先用管理后台设置的时间，未设置时用环境变量 cron
   * - DB 中存有 HH:mm → 转 cron 注册
   * - DB 无值 → 直接用 env cron 原文注册（兼容复杂 cron，如多批次）
   */
  async bootstrapSchedule(envCron: string) {
    const stored = await this.loadStoredTime();
    if (stored) {
      await this.scheduleDaily(timeToCron(stored));
      this.logger.log(`推送时间取自管理后台设置（${stored}）`);
      return;
    }
    await this.scheduleDaily(envCron);
  }

  /** 当前推送时间设置（管理后台用）：包含来源与下次触发时间（北京时间） */
  async getSchedule() {
    const envCron = this.config.get<string>('DINGTALK_DIGEST_CRON', '0 20 * * *');
    const stored = await this.loadStoredTime();
    const time = stored ?? cronToTime(envCron);
    return {
      time, // 'HH:mm'；env cron 为复杂形式且未在后台设置过时为 null
      source: stored ? 'db' : 'env', // db=管理后台设置；env=环境变量默认
      cron: stored ? timeToCron(stored) : envCron,
      next: await this.nextRunAt(),
    };
  }

  /** 保存推送时间并立即重新注册调度（'HH:mm' 北京时间） */
  async saveScheduleTime(time: string) {
    let cron: string;
    try {
      cron = timeToCron(time); // 非法格式抛 400
    } catch {
      throw new BadRequestException('时间格式须为 HH:mm（北京时间，如 20:00）');
    }
    await this.prisma.setting.upsert({
      where: { key: DIGEST_SCHEDULE_KEY },
      create: { key: DIGEST_SCHEDULE_KEY, value: { time: time.trim() } },
      update: { value: { time: time.trim() } },
    });
    await this.scheduleDaily(cron);
    this.logger.log(`推送时间已更新为每天 ${time.trim()}（北京时间，cron: ${cron}）`);
    return this.getSchedule();
  }

  /** 下次触发时间（北京时间字符串；查询失败返回 null） */
  async nextRunAt(): Promise<string | null> {
    try {
      const items = (await this.queue.getJobSchedulers()) as any[];
      const item = items?.find((s) => (s?.key ?? s?.id ?? s?.name) === 'digest:daily');
      const next = typeof item?.next === 'number' ? item.next : null;
      return next ? fmtBeijing(new Date(next)) : null;
    } catch {
      return null;
    }
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

  /** 手动触发一次总结（delayMs 可选延迟） */
  async trigger(delayMs = 0) {
    return this.queue.add('digest', {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 });
  }
}
