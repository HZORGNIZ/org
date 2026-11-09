import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { NewsFetchService } from '../news/news-fetch.service';
import { NewsModule } from '../news/news.module';
import { DingTalkService } from './dingtalk.service';
import { ChatReportSyncService } from './chat-report-sync.service';
import { DingtalkFetchQueue } from './dingtalk-fetch-queue.service';
import { DingtalkFetchService } from './dingtalk-fetch.service';
import { DingtalkFetchWorker } from './dingtalk-fetch.worker';
import { DailyDigestQueue } from './daily-digest.queue';
import { DailyDigestService } from './daily-digest.service';
import { DailyDigestWorker } from './daily-digest.worker';
import { AiLogSenderQueue } from './ai-log-sender.queue';
import { AiLogSenderService } from './ai-log-sender.service';
import { AiLogSenderWorker } from './ai-log-sender.worker';
import { TaskReminderQueue } from './task-reminder.queue';
import { TaskReminderService } from './task-reminder.service';
import { TaskReminderWorker } from './task-reminder.worker';
import { DingtalkDmService } from './dingtalk-dm.service';
import { ReportReminderQueue } from './report-reminder.queue';
import { ReportReminderService } from './report-reminder.service';
import { ReportReminderWorker } from './report-reminder.worker';
import { WorkRankQueue } from './work-rank.queue';
import { WorkRankService } from './work-rank.service';
import { WorkRankWorker } from './work-rank.worker';
import { DailyGroupSummaryQueue } from './daily-group-summary.queue';
import { DailyGroupSummaryService } from './daily-group-summary.service';
import { DailyGroupSummaryWorker } from './daily-group-summary.worker';
import { IntegrationsController } from './integrations.controller';

/**
 * 集成模块：钉钉等外部平台（通过 MessageSourceAdapter 解耦）
 * - 接收：Stream 长连接（@机器人 消息实时）+ dws CLI 定时拉取（群内全部消息）
 * - 发送：群自定义机器人 Webhook；启用时把钉钉推送能力注入资讯模块
 */
@Module({
  imports: [AiModule, NewsModule],
  controllers: [IntegrationsController],
  providers: [
    DingTalkService,
    DingtalkFetchService,
    DingtalkFetchQueue,
    DingtalkFetchWorker,
    ChatReportSyncService,
    DailyDigestService,
    DailyDigestQueue,
    DailyDigestWorker,
    AiLogSenderService,
    AiLogSenderQueue,
    AiLogSenderWorker,
    TaskReminderService,
    TaskReminderQueue,
    TaskReminderWorker,
    DingtalkDmService,
    ReportReminderService,
    ReportReminderQueue,
    ReportReminderWorker,
    WorkRankService,
    WorkRankQueue,
    WorkRankWorker,
    DailyGroupSummaryService,
    DailyGroupSummaryQueue,
    DailyGroupSummaryWorker,
    PrismaService,
    ConfigService,
  ],
  exports: [DingTalkService, DingtalkFetchService, DingtalkDmService, DailyDigestService, WorkRankService, DailyGroupSummaryService],
})
export class IntegrationsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntegrationsModule.name);

  constructor(
    private dingtalk: DingTalkService,
    private newsFetch: NewsFetchService,
    private fetchQueue: DingtalkFetchQueue,
    private digestQueue: DailyDigestQueue,
    private aiLogQueue: AiLogSenderQueue,
    private taskReminderQueue: TaskReminderQueue,
    private reportReminderQueue: ReportReminderQueue,
    private workRank: WorkRankService,
    private dailySummary: DailyGroupSummaryService,
    private config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    // 资讯摘要完成后推送到钉钉群（仅当钉钉启用时）
    this.newsFetch.setPushPort(this.dingtalk.enabled ? this.dingtalk : null);
    void this.bootstrapFetchSchedules();
    void this.bootstrapDigestSchedule();
    void this.bootstrapAiLogSchedule();
    void this.bootstrapTaskReminder();
    void this.bootstrapReportReminder();
    void this.bootstrapWorkRank();
    void this.bootstrapDailySummary();
  }

  /**
   * 定时抓取注册 + 启动补抓
   * - 注册：白天/夜间两个 cron 批次（见 DingtalkFetchQueue，内部已分开容错）
   * - 补抓：BullMQ 的 JobScheduler 只维护"下一次"触发，错过的批次不会补跑，
   *   容器在 12/17/22 点前后重启或部署会静默跳过该批次，因此启动后补抓一次兜底
   *   （窗口固定 [now-48h, now)，msgId 唯一约束去重，重复抓取无副作用）
   */
  private async bootstrapFetchSchedules() {
    const cronDay = this.config.get<string>('DINGTALK_FETCH_CRON', '0 12,17,19 * * *');
    const cronNight = this.config.get<string>('DINGTALK_FETCH_CRON_NIGHT', '0 22 * * *');
    try {
      await this.fetchQueue.scheduleDailyAndNight(cronDay, cronNight);
    } catch (e) {
      // Redis 未就绪时仅记录，不阻塞启动
      this.logger.error(`注册钉钉群消息抓取定时失败: ${(e as Error).message}`);
    }
    if (this.config.get<string>('DINGTALK_FETCH_ENABLED', 'true') !== 'true') return;
    try {
      await this.fetchQueue.triggerFetch(20_000);
      this.logger.log('已安排启动补抓：20 秒后执行一次全量抓取（兜底错过的定时批次）');
    } catch (e) {
      this.logger.error(`安排启动补抓失败: ${(e as Error).message}`);
    }
  }

  /**
   * 每日团队进展总结注册
   * - 时间优先取管理后台设置（Setting 表 digest.schedule），未设置时回退 DINGTALK_DIGEST_CRON（默认 20:00）
   * - 私聊汇总（杨力）+ 各项目群消息，见 DailyDigestService
   * - 抓取批次含 19:00 轮：让 20:00 的总结能覆盖当天 19:00 前的新进展
   */
  private async bootstrapDigestSchedule() {
    if (this.config.get<string>('DINGTALK_DIGEST_ENABLED', 'true') !== 'true') return;
    const envCron = this.config.get<string>('DINGTALK_DIGEST_CRON', '0 20 * * *');
    try {
      await this.digestQueue.bootstrapSchedule(envCron);
    } catch (e) {
      this.logger.error(`注册每日团队进展总结失败: ${(e as Error).message}`);
    }
    // 项目群发 tick（每 15 分钟）：按每个项目自定义的时间/频率发到各自绑定群
    try {
      await this.digestQueue.scheduleGroupsTick(
        this.config.get<string>('DINGTALK_DIGEST_GROUPS_TICK_CRON', '*/15 * * * *'),
      );
    } catch (e) {
      this.logger.error(`注册项目群发 tick 失败: ${(e as Error).message}`);
    }
  }

  /**
   * 每日 AI 提示词日志发送注册（默认每天 08:00 北京时间）
   * - 把前一天的 ai-prompts-YYYY-MM-DD.log 私聊发给负责人（见 AiLogSenderService）
   * - 「每天自动发送」开关可在管理后台设置（存 Setting 表，DB 优先；未设置时回退 DINGTALK_AI_LOG_ENABLED）
   * - 时间可用 DINGTALK_AI_LOG_CRON 调整
   */
  private async bootstrapAiLogSchedule() {
    const envEnabled = this.config.get<string>('DINGTALK_AI_LOG_ENABLED', 'true') === 'true';
    const cron = this.config.get<string>('DINGTALK_AI_LOG_CRON', '0 8 * * *');
    try {
      await this.aiLogQueue.bootstrap(cron, envEnabled);
    } catch (e) {
      this.logger.error(`注册 AI 提示词日志发送失败: ${(e as Error).message}`);
    }
  }

  /**
   * 任务逾期提醒注册（默认每天 8-19 点整点检查一次）
   * - 逾期的未完成任务钉钉私聊负责人（见 TaskReminderService）
   * - cron 只落在 8-19 点，确保不落在晚 8 点至次日早 7 点禁发时段（服务内还有第二道窗口校验）
   * - 可用 TASK_REMINDER_CRON 调整、TASK_REMINDER_ENABLED=false 关闭
   */
  private async bootstrapTaskReminder() {
    if (this.config.get<string>('TASK_REMINDER_ENABLED', 'true') !== 'true') return;
    const cron = this.config.get<string>('TASK_REMINDER_CRON', '0 8-19 * * *');
    try {
      await this.taskReminderQueue.schedule(cron);
    } catch (e) {
      this.logger.error(`注册任务逾期提醒失败: ${(e as Error).message}`);
    }
  }

  /**
   * 日报未写提醒注册（默认每天 8-21 点整点检查一次，实际提醒时点按各部门 reportRemindTime 二次 gating）
   * - 按部门「日报规则」提醒未按时写日报的成员（见 ReportReminderService）
   * - 可用 REPORT_REMINDER_CRON 调整、REPORT_REMINDER_ENABLED=false 关闭
   */
  private async bootstrapReportReminder() {
    if (this.config.get<string>('REPORT_REMINDER_ENABLED', 'true') !== 'true') return;
    const cron = this.config.get<string>('REPORT_REMINDER_CRON', '0 8-21 * * *');
    try {
      await this.reportReminderQueue.schedule(cron);
    } catch (e) {
      this.logger.error(`注册日报未写提醒失败: ${(e as Error).message}`);
    }
  }

  /**
   * 每周工时排名发群注册（默认每周日 21:00 北京时间，统计本周日报工时）
   * - 开关与时间存 Setting 表（管理后台「每周工时排名」），未设置回退 WORK_RANK_ENABLED / WORK_RANK_TIME
   * - 关闭时移除调度；可用 WORK_RANK_CRON 强制覆盖 cron
   */
  private async bootstrapWorkRank() {
    try {
      await this.workRank.bootstrapSchedule();
    } catch (e) {
      this.logger.error(`注册每周工时排名失败: ${(e as Error).message}`);
    }
  }

  /**
   * 每日小组小结发群注册（默认每天 18:00 北京时间，逐项目发到各自绑定群）
   * - 开关与时间存 Setting 表（管理后台「每日小组小结」），未设置回退 DAILY_SUMMARY_ENABLED(默认 false) / DAILY_SUMMARY_TIME
   * - 关闭时移除调度；可用 DAILY_SUMMARY_CRON 强制覆盖 cron
   */
  private async bootstrapDailySummary() {
    try {
      await this.dailySummary.bootstrapSchedule();
    } catch (e) {
      this.logger.error(`注册每日小组小结失败: ${(e as Error).message}`);
    }
  }
}
