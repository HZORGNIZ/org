import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReportStatus, ReportType } from '@prisma/client';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { ReportsService } from './reports.service';
import { WorkScheduleService } from './work-schedule.service';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private reports: ReportsService,
    private workSchedule: WorkScheduleService,
  ) {}

  @Get()
  list(
    @CurrentUser() me: { id: string; role: string },
    @Query('type') type?: ReportType,
  ) {
    return this.reports.list(me, type);
  }

  /**
   * 按日期聚合某范围所有人的日报（工作管理「日报看板」与项目详情共用）：默认今日。
   * 范围：projectId（项目成员+负责人）/ departmentId（部门成员）/ 不传（登录人可见范围，管理员=全体）
   */
  @Get('daily-overview')
  dailyOverview(
    @CurrentUser() me: { id: string; role: string },
    @Query('date') date?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.reports.dailyOverview(me, { date, projectId, departmentId });
  }

  /** 某成员日报时间轴（按天倒序，含每日工时与区间累计工时）；默认最近 30 天 */
  @Get('person-timeline')
  personTimeline(
    @CurrentUser() me: { id: string; role: string },
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.personTimeline(me, { userId, from, to });
  }

  /** 我的工时卡（首页顶部横幅）：本人本周/本月/累计工时（已发布日报 hours 求和） */
  @Get('my-hours')
  myHours(@CurrentUser('id') userId: string) {
    return this.reports.myHoursSummary(userId);
  }

  /** 工时排行：scope=week（本周）/ month（本月）/ cumulative（累计），按工时高到低；可限定项目/部门 */
  @Get('hours-ranking')
  hoursRanking(
    @CurrentUser() me: { id: string; role: string },
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('date') date?: string,
    @Query('all') all?: string,
  ) {
    return this.reports.hoursRanking(me, { scope, projectId, departmentId, date, all: all === '1' });
  }

  /** 日报数量排行：scope=week 本周 / 默认本月；?all=1 取全公司口径 */
  @Get('report-count-ranking')
  reportCountRanking(
    @CurrentUser() me: { id: string; role: string },
    @Query('all') all?: string,
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.reports.reportCountRanking(me, { scope, all: all === '1', projectId, departmentId });
  }

  /** 手写周报弹窗的下拉数据源：可归属的项目/部门 + 本周周次标注 */
  @Get('weekly-compose-options')
  weeklyComposeOptions(@CurrentUser() me: { id: string; role: string }) {
    return this.reports.weeklyComposeOptions(me);
  }

  /**
   * 我的工作时间安排（计划页周视图）：周一~周日 × 预设时间段，可随时改。
   * 返回 { presets, slots, totalSlots, totalHours, todayWeekday, todayLabel, todaySlots, todayHours }
   */
  @Get('work-slots')
  getWorkSlots(@CurrentUser('id') userId: string) {
    return this.workSchedule.getMine(userId);
  }

  /** 保存我的工作时间安排（整表覆盖）：slots=[{ weekday 0=周一…6=周日, startMin, endMin }] */
  @Put('work-slots')
  saveWorkSlots(@CurrentUser('id') userId: string, @Body() body: { slots?: unknown }) {
    return this.workSchedule.saveMine(userId, body?.slots);
  }

  /** 公司/部门周报聚合：勾选参会人（不传=可见范围全部），取其本周各归属周报直排 */
  @Get('weekly-aggregate')
  weeklyAggregate(
    @CurrentUser() me: { id: string; role: string },
    @Query('periodStart') periodStart?: string,
    @Query('participantIds') participantIds?: string,
  ) {
    const ids = (participantIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.reports.weeklyAggregate(me, { periodStart, participantIds: ids.length ? ids : undefined });
  }

  /** 公司/部门周报 AI 总结（refresh=1 重新生成） */
  @Post('weekly-aggregate/summary')
  weeklyAggregateSummary(
    @CurrentUser() me: { id: string; role: string },
    @Body() body: { periodStart?: string; participantIds?: string[] },
    @Query('refresh') refresh?: string,
  ) {
    return this.reports.weeklyAggregateSummary(
      me,
      { periodStart: body?.periodStart, participantIds: body?.participantIds },
      refresh === '1' || refresh === 'true',
    );
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() me: { id: string; role: string }) {
    return this.reports.get(id, me);
  }

  /** 生成日报/周报：periodStart 必须传，periodEnd 默认 periodStart+1天(日报)/+7天(周报) */
  @Post('generate')
  generate(
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      type: ReportType;
      periodStart: string;
      periodEnd?: string;
      manualContent?: string;
      scope?: 'me' | 'team';
    },
  ) {
    const start = new Date(body.periodStart);
    const end = body.periodEnd
      ? new Date(body.periodEnd)
      : new Date(start.getTime() + (body.type === ReportType.DAILY ? 86400000 : 7 * 86400000));
    return this.reports.generate(userId, {
      type: body.type,
      periodStart: start,
      periodEnd: end,
      manualContent: body.manualContent,
      scope: body.scope,
    });
  }

  /**
   * 提交手写日报（首页快速日报，直接提交无需确认）：同日重复提交自动追加合并
   * hours 可选：填了以人工工时为准（0~24，一位小数），不填则由 AI 从正文提取
   */
  @Post('daily')
  submitDaily(
    @CurrentUser('id') userId: string,
    @Body() body: { rawContent: string; hours?: number | string | null },
  ) {
    return this.reports.submitDaily(userId, body.rawContent ?? '', body.hours);
  }

  /** 提交手写周报（三段式，直接提交即发布）：同周·同归属重复提交自动追加合并；北京周一为周期起点，支持归属项目/部门与补发往期 */
  @Post('weekly')
  submitWeekly(
    @CurrentUser('id') userId: string,
    @Body()
    body: { rawContent: string; groupIds?: string[]; projectId?: string; departmentId?: string; periodStart?: string },
  ) {
    return this.reports.submitWeekly(
      userId,
      body.rawContent ?? '',
      body.groupIds,
      { projectId: body.projectId, departmentId: body.departmentId },
      body.periodStart,
    );
  }

  /** 周报草稿：把本周（或补发周）已提交日报聚合成三段式草稿，只回填表单不落库，人工可改后再提交 */
  @Post('weekly-draft')
  weeklyDraft(
    @CurrentUser('id') userId: string,
    @Body()
    body: { periodStart?: string; projectId?: string; departmentId?: string },
  ) {
    return this.reports.generateWeeklyDraft(userId, {
      periodStart: body?.periodStart,
      projectId: body?.projectId,
      departmentId: body?.departmentId,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { manualContent?: string; rawContent?: string; status?: ReportStatus; hours?: number | null | string },
    @CurrentUser() me: { id: string; role: string },
  ) {
    return this.reports.update(id, body, me);
  }
}
