import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { IntakeService } from './intake.service';

@Controller('intake')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntakeController {
  constructor(private intake: IntakeService) {}

  /** 首页录入：AI 判别类别并直接落库，返回处理详情（可撤销） */
  @Post()
  submit(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { text: string; category?: string },
  ) {
    return this.intake.submit(user, { text: body?.text, category: body?.category });
  }

  /** 任务待归属项目场景：选定项目后创建 */
  @Post('task')
  createTask(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: { projectId: string; title: string; dueDate?: string | null; startDate?: string | null; priority?: string },
  ) {
    return this.intake.createTaskWithProject(user, body);
  }

  /** 撤销本次录入（删除刚落库的日报/周报/任务/灵感） */
  @Post('undo')
  undo(@CurrentUser() user: CurrentUserPayload, @Body() body: { type: string; id: string }) {
    return this.intake.undo(user, { type: body?.type, id: body?.id });
  }
}
