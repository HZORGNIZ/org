import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RetroKind } from '@prisma/client';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { RetrospectivesService } from './retrospectives.service';

@Controller('retrospectives')
@UseGuards(JwtAuthGuard)
export class RetrospectivesController {
  constructor(private retrospectives: RetrospectivesService) {}

  /** 我参与项目的全部复盘轮次（含成员进度与我的提交状态） */
  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.retrospectives.list(userId);
  }

  /** 复盘详情（含可提交成员列表与全部提交） */
  @Get(':id')
  getDetail(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.retrospectives.getDetail(id, userId);
  }

  /** 创建复盘轮次（项目负责人/管理员）；STRUCTURED 自动预置 5 问 */
  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() body: { projectId: string; kind: RetroKind; title?: string; deadline?: string | null },
  ) {
    return this.retrospectives.create(userId, body);
  }

  /** 修改复盘（负责人/管理员）：标题/截止日/状态 */
  @Put(':id')
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { title?: string; deadline?: string | null; status?: string },
  ) {
    return this.retrospectives.update(id, userId, body);
  }

  /** 提交/覆盖提交复盘（成员本人） */
  @Put(':id/submission')
  submit(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      answers?: Record<string, string>;
      content?: string;
      attachment?: { name?: string; key?: string };
    },
  ) {
    return this.retrospectives.submit(userId, id, body);
  }

  /** AI 汇总所有成员提交为复盘报告（负责人/管理员） */
  @Post(':id/summarize')
  summarize(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.retrospectives.summarize(userId, id);
  }
}
