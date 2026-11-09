import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DingtalkFetchService } from './dingtalk-fetch.service';
import { ChatReportSyncService } from './chat-report-sync.service';

/**
 * BullMQ Worker：消费钉钉群消息抓取任务（fetch-recent）
 * - 拉取落库后：把当批新增消息同步为个人日报段落（每次批次都执行）
 * - 夜间批次（job.data.updateProgress=true，22:00）：额外向 progress 队列投递一次
 *   'scan' 任务触发项目进展 AI 总结（直接裸 Queue 连接，避免模块循环依赖）
 */
@Injectable()
export class DingtalkFetchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DingtalkFetchWorker.name);
  private worker: Worker | null = null;
  private progressQueue: Queue | null = null;

  constructor(
    private config: ConfigService,
    private fetch: DingtalkFetchService,
    private chatReportSync: ChatReportSyncService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.progressQueue = new Queue('progress', { connection });
    this.worker = new Worker(
      'dingtalk-fetch',
      async (job) => {
        if (job.name !== 'fetch-recent') return;
        const stats = await this.fetch.fetchRecentAll();
        this.logger.log(
          `钉钉群消息抓取完成: 群 ${stats.groups} 个，拉取 ${stats.fetched} 条，新增 ${stats.added} 条，去重 ${stats.skipped} 条`,
        );
        // 1. 新增消息 → 个人日报段落（所有批次都做；added=0 跳过）
        if (stats.added > 0 && stats.addedMessages.length > 0) {
          await this.chatReportSync.syncDailyFragments(stats.addedMessages);
        }
        // 2. 新增消息 → 投递一次项目进展 AI 扫描（12/17/22 任一调度批次抓到新消息都会总结；
        //    generateProgress 只处理「上次总结之后有新消息」的项目，无新增时不会调 AI）
        if (stats.added > 0) {
          await this.progressQueue?.add('scan', {}, { removeOnComplete: 100, removeOnFail: 1000 });
          this.logger.log(`抓取到 ${stats.added} 条新增消息，已投递项目进展扫描任务（progress/scan）`);
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`抓取任务失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('钉钉群消息抓取 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
