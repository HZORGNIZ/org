import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';

/** Setting 表中存「每天自动发送」开关的 key（value: { enabled: boolean }） */
export const AI_LOG_ENABLED_KEY = 'aiLog.enabled';

/**
 * 每日 AI 提示词日志发送队列（ai-log-send）
 * - ai-log：把前一天（北京时间）的 ai-prompts-YYYY-MM-DD.log 私聊发给负责人（见 AiLogSenderService）
 * - 默认每天 08:00 触发（DINGTALK_AI_LOG_CRON 可调）
 * - 「每天自动发送」开关可在管理后台设置（存 Setting 表 aiLog.enabled，保存后立即注册/移除定时）；
 *   未设置时回退 DINGTALK_AI_LOG_ENABLED（默认 true）
 */
@Injectable()
export class AiLogSenderQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(AiLogSenderQueue.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('ai-log-send', { connection });
  }

  private envCron() {
    return this.config.get<string>('DINGTALK_AI_LOG_CRON', '0 8 * * *');
  }

  private envEnabled() {
    return this.config.get<string>('DINGTALK_AI_LOG_ENABLED', 'true') === 'true';
  }

  /** 读取 Setting 表中的开关（boolean）；未设置或读取失败返回 null */
  private async loadStoredEnabled(): Promise<boolean | null> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: AI_LOG_ENABLED_KEY } });
      const enabled = (row?.value as any)?.enabled;
      if (typeof enabled === 'boolean') return enabled;
    } catch (e) {
      this.logger.error(`读取 AI 日志开关设置失败: ${(e as Error).message}`);
    }
    return null;
  }

  /**
   * 启动注册：开关 DB 优先（管理后台），未设置时回退环境变量；关闭时不注册并清掉残留调度
   */
  async bootstrap(envCron: string, envEnabled: boolean) {
    const stored = await this.loadStoredEnabled();
    const enabled = stored ?? envEnabled;
    if (!enabled) {
      await this.removeDailySchedule();
      this.logger.log(
        `AI 提示词日志自动发送处于关闭状态（${stored === null ? 'DINGTALK_AI_LOG_ENABLED=false' : '管理后台设置'}），未注册定时`,
      );
      return;
    }
    await this.scheduleDaily(envCron);
  }

  /** 当前设置（管理后台用）：开关、来源、cron 与下次触发时间（北京时间） */
  async getSettings() {
    const stored = await this.loadStoredEnabled();
    return {
      enabled: stored ?? this.envEnabled(),
      source: stored === null ? 'env' : 'db', // db=管理后台设置；env=环境变量默认
      cron: this.envCron(),
      next: await this.nextRunAt(),
    };
  }

  /** 保存「每天自动发送」开关并立即生效（开启则注册调度，关闭则移除调度） */
  async saveEnabled(enabled: boolean) {
    await this.prisma.setting.upsert({
      where: { key: AI_LOG_ENABLED_KEY },
      create: { key: AI_LOG_ENABLED_KEY, value: { enabled } },
      update: { value: { enabled } },
    });
    if (enabled) await this.scheduleDaily(this.envCron());
    else await this.removeDailySchedule();
    return this.getSettings();
  }

  /** 注册每日定时触发（幂等；tz 固定 Asia/Shanghai，避免 BullMQ 按 UTC 解释偏 8 小时） */
  async scheduleDaily(cron: string) {
    if (!cron || !cron.trim()) throw new Error('AI 日志发送 cron 为空');
    await this.queue.upsertJobScheduler(
      'ai-log:daily',
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'ai-log' },
    );
    this.logger.log(`AI 提示词日志发送已注册（cron: ${cron}）｜下次 ${await this.nextRunAt()}`);
  }

  /** 移除每日定时触发（关闭自动发送时调用；幂等，无调度器时静默） */
  async removeDailySchedule() {
    await this.queue.removeJobScheduler('ai-log:daily');
    this.logger.log('AI 提示词日志自动发送已关闭（定时注册已移除）');
  }

  /** 下次触发时间（北京时间字符串；查询失败返回 null） */
  async nextRunAt(): Promise<string | null> {
    try {
      const items = (await this.queue.getJobSchedulers()) as any[];
      const item = items?.find((s) => (s?.key ?? s?.id ?? s?.name) === 'ai-log:daily');
      const next = typeof item?.next === 'number' ? item.next : null;
      return next ? fmtBeijing(new Date(next)) : null;
    } catch {
      return null;
    }
  }

  /** 手动触发一次发送（delayMs 可选延迟） */
  async trigger(delayMs = 0) {
    return this.queue.add('ai-log', {}, { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 });
  }
}
