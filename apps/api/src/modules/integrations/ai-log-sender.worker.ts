import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { AiLogSenderService } from './ai-log-sender.service';

/** BullMQ Worker：消费每日 AI 提示词日志发送任务（ai-log，默认每天 08:00 北京时间发前一天日志） */
@Injectable()
export class AiLogSenderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AiLogSenderWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private aiLog: AiLogSenderService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'ai-log-send',
      async (job) => {
        if (job.name !== 'ai-log') return;
        const r: any = await this.aiLog.run();
        if (r?.skipped) {
          this.logger.warn(`AI 日志发送跳过: ${r.reason}`);
          return;
        }
        const result = r.sent ? '已发送' : `发送失败（${r.error ?? '未知错误'}）`;
        this.logger.log(
          r.exists
            ? `AI 日志发送完成（${r.date}）：私聊「${r.to}」${result}`
            : `AI 日志发送完成（${r.date}）：无日志文件，已发文本告知（${result}）`,
        );
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`AI 日志发送任务失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('AI 提示词日志发送 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
