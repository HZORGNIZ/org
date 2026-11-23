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

  /** 部门复盘列表：可见部门的全部复盘（管理员全部 / 负责人·共管人·成员可见相关部门）
   *  注意：必须声明在 @Get(':id') 之前，否则会被通配参数路由遮蔽 */
  @Get('departments/retros')
  deptList(@CurrentUser('id') userId: string) {
    return this.retrospectives.deptList(userId);
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

  /** 项目复盘定稿：保存管理员结论（可改 AI 稿或自行输入） */
  @Put(':id/conclusion')
  saveConclusion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { content: string },
  ) {
    return this.retrospectives.saveConclusion(userId, id, body?.content);
  }

  // ======== 部门复盘（部门管理 · 复盘 tab）========

  /** 发起部门复盘（部门负责人/共管人/管理员）：period=YYYY-MM，同部门同周期不可重复 */
  @Post('departments/:departmentId/retros')
  deptCreate(
    @Param('departmentId') departmentId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { period: string; title?: string },
  ) {
    return this.retrospectives.deptCreate(userId, { departmentId, ...body });
  }

  /** AI 生成部门复盘（聚合周期内任务/工时/日报周报/PBC + 项目进展） */
  @Post('dept-retros/:id/ai')
  deptAiGenerate(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.retrospectives.deptAiGenerate(userId, id);
  }

  /** 部门复盘定稿：保存管理员结论（定稿后部门成员可见） */
  @Put('dept-retros/:id/conclusion')
  deptSaveConclusion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { content: string },
  ) {
    return this.retrospectives.deptSaveConclusion(userId, id, body?.content);
  }
}
