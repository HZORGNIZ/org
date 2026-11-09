import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { DingTalkService } from './dingtalk.service';
import { DingtalkFetchService } from './dingtalk-fetch.service';
import { DailyDigestService } from './daily-digest.service';
import { DailyDigestQueue } from './daily-digest.queue';
import { AiLogSenderService } from './ai-log-sender.service';
import { AiLogSenderQueue } from './ai-log-sender.queue';
import { TaskReminderService } from './task-reminder.service';
import { ReportReminderService } from './report-reminder.service';
import { WorkRankService } from './work-rank.service';
import { DailyGroupSummaryService } from './daily-group-summary.service';

@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntegrationsController {
  constructor(
    private dingtalk: DingTalkService,
    private fetch: DingtalkFetchService,
    private prisma: PrismaService,
    private ai: AiService,
    private digest: DailyDigestService,
    private digestQueue: DailyDigestQueue,
    private aiLog: AiLogSenderService,
    private aiLogQueue: AiLogSenderQueue,
    private taskReminder: TaskReminderService,
    private reportReminder: ReportReminderService,
    private workRank: WorkRankService,
    private dailySummary: DailyGroupSummaryService,
  ) {}

  /** 集成状态总览 */
  @Get('status')
  status() {
    return {
      messageSources: [this.dingtalk.status()],
      ai: { enabled: this.ai.enabled },
    };
  }

  /**
   * 手动触发抓取最近两天群消息（dws CLI，普通消息也能拿到）
   * - body.projectId：只拉该项目关联群（项目负责人或管理员）
   * - 不传 projectId：拉取所有关联群（仅管理员）
   */
  @Post('dingtalk/fetch')
  async fetchRecent(@CurrentUser('id') userId: string, @Body() body: { projectId?: string }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    const isAdmin = user?.role === Role.ADMIN;
    if (body.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: body.projectId },
        select: { ownerId: true },
      });
      if (!project) throw new NotFoundException('项目不存在');
      if (!isAdmin && project.ownerId !== userId) {
        throw new ForbiddenException('仅项目负责人或管理员可拉取');
      }
      return this.fetch.fetchRecentForProject(body.projectId);
    }
    if (!isAdmin) throw new ForbiddenException('仅管理员可拉取全部群');
    return this.fetch.fetchRecentAll();
  }

  /** 测试钉钉推送 */
  @Post('dingtalk/test-push')
  testPush(@Body() body: { content?: string }) {
    return this.dingtalk.send('push', body.content ?? '✅ MyOrgniz 集成测试：连接正常');
  }

  /**
   * 手动触发每日团队进展总结（管理员）
   * - body.dryRun=true：只生成文本不发送（预览效果）
   * - body.onlyDm=true：只发私聊（群消息仅生成供预览）
   * - 不传参数：完整发送（私聊杨力 + 各项目群）
   */
  @Post('dingtalk/digest')
  @Roles(Role.ADMIN)
  runDigest(@Body() body: { dryRun?: boolean; onlyDm?: boolean }) {
    return this.digest.run({ dryRun: !!body?.dryRun, onlyDm: !!body?.onlyDm });
  }

  /**
   * 手动发送某天的 AI 提示词日志文件到钉钉（管理员）
   * - 不等同自动任务：不受「每天自动发送」开关限制，随时可发
   * - body.date：'YYYY-MM-DD'（北京时间），默认前一天
   * - body.dryRun=true：只预览不发送
   */
  @Post('dingtalk/ai-log')
  @Roles(Role.ADMIN)
  sendAiLog(@Body() body: { date?: string; dryRun?: boolean }) {
    return this.aiLog.run({ date: body?.date, dryRun: !!body?.dryRun, manual: true });
  }

  /** AI 日志「每天自动发送」设置（管理员）：{ enabled, source: 'db'|'env', cron, next } */
  @Get('ai-log/settings')
  @Roles(Role.ADMIN)
  aiLogSettings() {
    return this.aiLogQueue.getSettings();
  }

  /** 修改 AI 日志「每天自动发送」开关（管理员；保存后立即注册/移除定时，无需重启） */
  @Put('ai-log/settings')
  @Roles(Role.ADMIN)
  saveAiLogSettings(@Body() body: { enabled?: boolean }) {
    if (typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('enabled 须为布尔值');
    }
    return this.aiLogQueue.saveEnabled(body.enabled);
  }

  /** 每日总结推送时间（管理员）：{ time: 'HH:mm', source: 'db'|'env', cron, next } */
  @Get('digest/schedule')
  @Roles(Role.ADMIN)
  digestSchedule() {
    return this.digestQueue.getSchedule();
  }

  /** 修改每日总结推送时间（管理员）：body.time='HH:mm'（北京时间），保存后立即重新注册调度 */
  @Put('digest/schedule')
  @Roles(Role.ADMIN)
  saveDigestSchedule(@Body() body: { time?: string }) {
    return this.digestQueue.saveScheduleTime(String(body?.time ?? ''));
  }

  /**
   * 手动触发任务逾期提醒（管理员）
   * - body.dryRun=true：只生成预览不发送
   * - body.force=true：绕过禁发时段限制（验证用；每日一次频控仍生效）
   * - 不传参数：按正常规则检查并发送（自动任务每小时一次，见 TaskReminderQueue）
   */
  @Post('task-reminder/run')
  @Roles(Role.ADMIN)
  runTaskReminder(@Body() body: { dryRun?: boolean; force?: boolean }) {
    return this.taskReminder.run({ dryRun: !!body?.dryRun, force: !!body?.force });
  }

  /**
   * 手动触发日报未写提醒（管理员）
   * - body.dryRun=true：只生成预览不发送
   * - body.force=true：绕过各部门提醒时点限制（验证用；每人每日一次频控仍生效）
   */
  @Post('report-reminder/run')
  @Roles(Role.ADMIN)
  runReportReminder(@Body() body: { dryRun?: boolean; force?: boolean }) {
    return this.reportReminder.run({ dryRun: !!body?.dryRun, force: !!body?.force });
  }

  /** 每周工时排名设置（管理员）：{ enabled, time, cron, groups[], next } */
  @Get('work-rank/settings')
  @Roles(Role.ADMIN)
  workRankSettings() {
    return this.workRank.getSettings();
  }

  /** 修改每周工时排名设置（管理员）：开关 / 发送时间 HH:mm / 发送群，传哪项改哪项，保存后立即生效 */
  @Put('work-rank/settings')
  @Roles(Role.ADMIN)
  async saveWorkRankSettings(@Body() body: { enabled?: boolean; time?: string; groupIds?: string[] }) {
    const out: any = { ok: true };
    if (Array.isArray(body?.groupIds)) out.groups = await this.workRank.saveGroups(body.groupIds!);
    if (typeof body?.time === 'string' && body.time.trim()) Object.assign(out, await this.workRank.saveScheduleTime(body.time.trim()));
    if (typeof body?.enabled === 'boolean') Object.assign(out, await this.workRank.saveEnabled(body.enabled));
    return out;
  }

  /** 工时排名预览（管理员）：不落库不发群，返回榜单与群消息正文；periodStart 可传往周日期 */
  @Get('work-rank/preview')
  @Roles(Role.ADMIN)
  workRankPreview(@Query('periodStart') periodStart?: string) {
    return this.workRank.rank(periodStart);
  }

  /** 立即发送工时排名到后台勾选的群（管理员；不受开关限制，可临时指定群） */
  @Post('work-rank/publish')
  @Roles(Role.ADMIN)
  publishWorkRank(@Body() body: { periodStart?: string; groupIds?: string[] }) {
    return this.workRank.publish({ manual: true, periodStart: body?.periodStart, groupIds: body?.groupIds });
  }

  /** 每日小组小结设置（管理员）：{ enabled, time, cron, next } */
  @Get('daily-summary/settings')
  @Roles(Role.ADMIN)
  dailySummarySettings() {
    return this.dailySummary.getSettings();
  }

  /** 修改每日小组小结设置（管理员）：开关 / 发送时间 HH:mm，传哪项改哪项，保存后立即生效 */
  @Put('daily-summary/settings')
  @Roles(Role.ADMIN)
  async saveDailySummarySettings(@Body() body: { enabled?: boolean; time?: string }) {
    const out: any = { ok: true };
    if (typeof body?.time === 'string' && body.time.trim()) Object.assign(out, await this.dailySummary.saveScheduleTime(body.time.trim()));
    if (typeof body?.enabled === 'boolean') Object.assign(out, await this.dailySummary.saveEnabled(body.enabled));
    return out;
  }

  /** 每日小组小结预览（管理员）：逐项目生成当日小结正文，不发群（不受开关限制） */
  @Get('daily-summary/preview')
  @Roles(Role.ADMIN)
  dailySummaryPreview() {
    return this.dailySummary.buildAll();
  }

  /** 立即发送每日小组小结到各项目绑定群（管理员；不受开关限制） */
  @Post('daily-summary/publish')
  @Roles(Role.ADMIN)
  publishDailySummary() {
    return this.dailySummary.publish({ manual: true });
  }

  /** 消息落地列表（管理员） */
  @Get('messages')
  @Roles(Role.ADMIN)
  messages(
    @Query('conversationId') conversationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.prisma.messageInbox.findMany({
      where: conversationId ? { conversationId } : {},
      orderBy: { receivedAt: 'desc' },
      take: Number(limit ?? 100),
      skip: Number(offset ?? 0),
    });
  }

  /** 群消息统计（按天，管理员） */
  @Get('messages/stats')
  @Roles(Role.ADMIN)
  async messageStats(@Query('days') days?: string) {
    const n = Number(days ?? 7);
    const since = new Date(Date.now() - n * 86400000);
    const messages = await this.prisma.messageInbox.findMany({
      where: { receivedAt: { gte: since } },
      select: { receivedAt: true, conversationName: true, content: true },
      orderBy: { receivedAt: 'asc' },
    });
    const byDay = new Map<string, number>();
    for (const m of messages) {
      const key = m.receivedAt.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    return { total: messages.length, byDay: [...byDay.entries()] };
  }
}
