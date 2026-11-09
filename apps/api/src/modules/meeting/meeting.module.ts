import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MeetingController } from './meeting.controller';
import { MeetingActivityService } from './meeting-activity.service';
import { MeetingPublicController } from './meeting-public.controller';
import { MeetingReminderController } from './meeting-reminder.controller';
import { MeetingReminderQueue } from './meeting-reminder.queue';
import { MeetingReminderService } from './meeting-reminder.service';
import { MeetingReminderWorker } from './meeting-reminder.worker';
import { MeetingNotifyService } from './meeting-notify.service';
import { MeetingService } from './meeting.service';

/**
 * 会议管理模块
 * - MeetingService：会议/材料/条目/纪要的数据与规则
 * - MeetingNotifyService：钉钉群 + 钉钉私聊 + 站内信的发送与文案（复用 Integrations 的通用发送能力）
 * - MeetingReminderQueue/Worker：meeting-reminder 队列（tick 到点提醒、daily 周会待发布、send 业务动作异步通知）
 */
@Module({
  imports: [IntegrationsModule, NotificationsModule, FilesModule],
  controllers: [MeetingController, MeetingPublicController, MeetingReminderController],
  providers: [
    MeetingService,
    MeetingActivityService,
    MeetingNotifyService,
    MeetingReminderService,
    MeetingReminderQueue,
    MeetingReminderWorker,
    PrismaService,
    ConfigService,
  ],
  exports: [MeetingService],
})
export class MeetingModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(MeetingModule.name);

  constructor(
    private queue: MeetingReminderQueue,
    private config: ConfigService,
  ) {}

  /**
   * 注册会议提醒定时任务
   * - tick：每 5 分钟（开始提醒要足够准点；Q3 已定稿开始提醒与群通知豁免 20:00–07:00 禁发窗口）
   * - daily：每日 08:00 北京时间（周会待发布提醒，落在可发送窗口内）
   * - MEETING_REMINDER_ENABLED=false 只关自动调度，手动 run 接口仍可发（便于验收）
   */
  async onApplicationBootstrap() {
    if (this.config.get<string>('MEETING_REMINDER_ENABLED', 'true') !== 'true') {
      this.logger.warn('MEETING_REMINDER_ENABLED=false，会议到点提醒与周会待发布提醒的自动调度未注册');
      return;
    }
    try {
      await this.queue.scheduleTick(this.config.get<string>('MEETING_REMINDER_TICK_CRON', '*/5 * * * *'));
    } catch (e) {
      this.logger.error(`注册会议到点提醒失败: ${(e as Error).message}`);
    }
    try {
      await this.queue.scheduleDaily(this.config.get<string>('MEETING_REMINDER_DAILY_CRON', '0 8 * * *'));
    } catch (e) {
      this.logger.error(`注册周会待发布提醒失败: ${(e as Error).message}`);
    }
  }
}
