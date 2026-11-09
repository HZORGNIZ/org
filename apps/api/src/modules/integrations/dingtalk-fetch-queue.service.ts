import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { fmtBeijing } from './dingtalk-fetch.service';

/**
 * 钉钉群消息抓取队列
 * - fetch-recent：抓取所有关联群最近两天的消息（JobScheduler 定时触发）
 * - 调度批次（白天 DINGTALK_FETCH_CRON / 夜间 DINGTALK_FETCH_CRON_NIGHT）：
 *   只要抓到新增消息，由 DingtalkFetchWorker 自动投递一次 progress/scan 做 AI 进展总结
 */
@Injectable()
export class DingtalkFetchQueue {
  readonly queue: Queue;
  private readonly logger = new Logger(DingtalkFetchQueue.name);

  constructor(config: ConfigService) {
    const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('dingtalk-fetch', { connection });
  }

  /** 注册两个定时抓取批次（幂等：同一 schedulerId 重复注册会更新）
   * 注意：BullMQ cron pattern 默认按 UTC 解释，必须显式指定 tz 否则会偏 8 小时
   * day/night 分别注册并各自容错：任一 cron 异常（如环境变量为空）不影响另一个批次 */
  async scheduleDailyAndNight(cronDay: string, cronNight: string) {
    const registered: string[] = [];
    const batches: [string, string][] = [
      ['dingtalk-fetch:day', cronDay],
      ['dingtalk-fetch:night', cronNight],
    ];
    for (const [schedulerId, cron] of batches) {
      try {
        await this.upsertScheduler(schedulerId, cron);
        registered.push(`${schedulerId}=${cron}`);
      } catch (e) {
        this.logger.error(`注册定时抓取失败 ${schedulerId}（cron: ${cron}）: ${(e as Error).message}`);
      }
    }
    // 清理旧的单 cron scheduler（防止残留重复触发）
    await this.queue.removeJobScheduler('dingtalk-fetch:recent').catch(() => undefined);
    if (registered.length) {
      this.logger.log(
        `钉钉群消息抓取已注册（${registered.join('，')}）｜${await this.describeSchedulers()}`,
      );
    }
  }

  /** 注册/更新单个 cron 调度器（tz 固定 Asia/Shanghai；cron 为空则跳过不注册） */
  private async upsertScheduler(schedulerId: string, cron: string) {
    if (!cron || !cron.trim()) {
      throw new Error('cron 为空，请检查 DINGTALK_FETCH_CRON / DINGTALK_FETCH_CRON_NIGHT');
    }
    await this.queue.upsertJobScheduler(
      schedulerId,
      { pattern: cron, tz: 'Asia/Shanghai' },
      { name: 'fetch-recent' },
    );
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

  /** 注册单个 cron 定时抓取（历史接口，保留兼容；tz 固定 Asia/Shanghai） */
  async scheduleFetch(cron: string) {
    await this.upsertScheduler('dingtalk-fetch:recent', cron);
    this.logger.log(`钉钉群消息抓取已注册（cron: ${cron}）`);
  }

  /** 手动触发一次抓取（有新增消息将自动投递项目进展扫描）；delayMs 用于启动补抓错峰 */
  async triggerFetch(delayMs = 0) {
    return this.queue.add(
      'fetch-recent',
      {},
      { delay: delayMs, removeOnComplete: 100, removeOnFail: 1000 },
    );
  }
}
