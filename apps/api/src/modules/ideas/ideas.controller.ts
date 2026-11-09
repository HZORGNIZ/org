import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { IdeasService } from './ideas.service';

@Controller('ideas')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IdeasController {
  constructor(private ideas: IdeasService) {}

  /** 灵感列表：我的 / 同项目组 / 同部门 三组 */
  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.ideas.list(user);
  }

  /** 手动记一条灵感 */
  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: { content: string; projectId?: string | null }) {
    return this.ideas.create(user, { content: body?.content, projectId: body?.projectId ?? null });
  }

  /** AI 规划（仅出提议，不落库） */
  @Post('plan')
  plan(@CurrentUser() user: CurrentUserPayload, @Body() body: { ideaIds: string[] }) {
    return this.ideas.plan(user, { ideaIds: body?.ideaIds ?? [] });
  }

  /** 人工确认后落库 */
  @Post('commit')
  commit(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { projects?: any[]; tasks?: any[] },
  ) {
    return this.ideas.commit(user, { projects: body?.projects, tasks: body?.tasks });
  }

  /** 删除灵感（作者或管理员） */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.ideas.remove(user, id);
  }
}
