import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { MeetingReminderService } from './meeting-reminder.service';
import { MeetingNotifyKind } from './meeting-notify.service';

/** BullMQ Worker：消费会议提醒任务（tick / daily / send；cron 见 MeetingReminderQueue） */
@Injectable()
export class MeetingReminderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeetingReminderWorker.name);
  private worker: Worker | null = null;

  constructor(
    private config: ConfigService,
    private reminder: MeetingReminderService,
  ) {}

  onApplicationBootstrap() {
    const redisUrl = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      'meeting-reminder',
      async (job) => {
        if (job.name === 'tick') {
          const r: any = await this.reminder.runTick();
          if (r.skipped) this.logger.warn(`会议到点提醒跳过: ${r.reason}`);
          return;
        }
        if (job.name === 'daily') {
          const r: any = await this.reminder.runDaily();
          if (r.skipped) this.logger.warn(`周会待发布提醒跳过: ${r.reason}`);
          return;
        }
        if (job.name === 'send') {
          const { meetingId, kind } = job.data as { meetingId: string; kind: MeetingNotifyKind };
          if (!meetingId || !kind) return;
          const r = await this.reminder.sendOne(meetingId, kind);
          if (r.skipped) {
            this.logger.warn(`会议通知跳过 [${kind}] 《${r.title}》: ${r.reason}`);
            return;
          }
          this.logger.log(
            `会议通知完成 [${kind}] 《${r.title}》：私聊 ${r.notified}/${r.dms.length} 人${r.group ? `，群${r.group.sent ? '已发' : `未发(${r.group.error ?? '未知'})`}` : ''}`,
          );
        }
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`会议提醒任务失败 [${job?.name}]: ${err.message}`);
    });
    this.logger.log('会议提醒 Worker 已启动');
  }

  onModuleDestroy() {
    this.worker?.close();
  }
}
