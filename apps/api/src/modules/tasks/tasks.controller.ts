import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { TasksService } from './tasks.service';

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('projectId') projectId?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('status') status?: TaskStatus,
    @Query('keyword') keyword?: string,
  ) {
    return this.tasks.list({ projectId, assigneeId, status, keyword }, user);
  }

  @Get('my')
  myTasks(@CurrentUser() user: CurrentUserPayload) {
    return this.tasks.myTasks(user);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.tasks.get(id, user);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: any) {
    return this.tasks.create(user, body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: any,
  ) {
    return this.tasks.update(id, user, body);
  }

  @Patch(':id/move')
  move(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { columnId: string | null; sortOrder: number },
  ) {
    return this.tasks.move(id, body.columnId, body.sortOrder, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.tasks.remove(id, user);
  }

  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { content: string },
  ) {
    return this.tasks.addComment(id, user, body.content);
  }

  @Get(':id/activities')
  activities(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.tasks.activities(id, user);
  }

  /** 删除单条活动记录（项目负责人 / 政委 / 系统管理员；记录不可编辑） */
  @Delete(':id/activities/:activityId')
  removeActivity(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @CurrentUser() me: { id: string; role: string },
  ) {
    return this.tasks.removeActivity(id, activityId, me);
  }
}
