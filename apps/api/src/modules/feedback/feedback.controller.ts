import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { FeedbackService } from './feedback.service';

/**
 * 使用体验反馈后端
 * - POST /feedback：所有登录用户提交一条反馈（落库 + 尽力同步公司全员大群）
 * - GET /feedback / PATCH /feedback/:id / POST /feedback/summarize：管理后台「用户反馈」，仅系统管理员
 */
@Controller('feedback')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FeedbackController {
  constructor(private feedback: FeedbackService) {}

  /** 全员提交反馈 */
  @Post()
  create(@CurrentUser() me: CurrentUserPayload, @Body() body: { content?: string }) {
    return this.feedback.create(me, body?.content);
  }

  /** 列表（仅管理员）：status = PENDING | ACCEPTED | ALL（默认 PENDING） */
  @Get()
  @Roles(Role.ADMIN)
  list(@Query('status') status?: string) {
    const s = status === 'ALL' || status === 'ACCEPTED' || status === 'PENDING' ? status : 'PENDING';
    return this.feedback.list(s);
  }

  /** 切换受理状态（仅管理员） */
  @Patch(':id')
  @Roles(Role.ADMIN)
  setStatus(@CurrentUser() me: CurrentUserPayload, @Param('id') id: string, @Body() body: { status?: string }) {
    return this.feedback.setStatus(me, id, body?.status === 'ACCEPTED' ? 'ACCEPTED' : 'PENDING');
  }

  /** AI 总结（仅管理员）：ids 为空则总结全部未受理 */
  @Post('summarize')
  @Roles(Role.ADMIN)
  summarize(@CurrentUser() me: CurrentUserPayload, @Body() body: { ids?: string[] }) {
    return this.feedback.summarize(me, body?.ids);
  }
}
