import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { MeetingReminderQueue } from './meeting-reminder.queue';
import { MeetingReminderService } from './meeting-reminder.service';

/**
 * 会议提醒运维接口（仅管理员）
 * - run：立即执行一轮 tick（到点提醒 + 材料催办）或 daily（周会待发布提醒），支持 dryRun 预览
 * - status：查看已注册的调度器与下次触发时间（北京时间），部署后自检用
 */
@Controller('meeting-reminder')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MeetingReminderController {
  constructor(
    private reminder: MeetingReminderService,
    private queue: MeetingReminderQueue,
  ) {}

  /** 手动跑一轮：body.name='tick'|'daily'（默认 tick）；dryRun=true 只预览不发送 */
  @Post('run')
  @Roles(Role.ADMIN)
  run(@Body() body: { name?: string; dryRun?: boolean; force?: boolean }, @Query('name') name?: string) {
    const which = (body?.name ?? name ?? 'tick').toLowerCase();
    const opts = { dryRun: body?.dryRun === true, force: body?.force === true };
    if (which === 'daily') return this.reminder.runDaily(opts);
    return this.reminder.runTick(opts);
  }

  /** 队列与调度器状态 */
  @Get('status')
  @Roles(Role.ADMIN)
  async status() {
    return { schedulers: await this.queue.describeSchedulers() };
  }
}
