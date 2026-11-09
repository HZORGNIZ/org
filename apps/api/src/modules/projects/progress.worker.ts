import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ProjectsService } from './projects.service';

/** BullMQ Worker：消费项目进展生成任务（scan） */
@Injectable()
export class ProgressWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProgressWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private projects: ProjectsService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'progress',
      async (job) => {
        if (job.name === 'scan') {
          // job.data 可携带 { projectId, lookbackHours }：单项目手动总结（详情页按钮）
          await this.projects.generateProgress(
            job.data as { projectId?: string; lookbackHours?: number } | undefined,
          );
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`进展任务失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('项目进展 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
