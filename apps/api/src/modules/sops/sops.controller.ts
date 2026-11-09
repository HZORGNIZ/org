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
import { SopStatus } from '@prisma/client';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { SopsService } from './sops.service';

@Controller('sops')
@UseGuards(JwtAuthGuard)
export class SopsController {
  constructor(private sops: SopsService) {}

  /** SOP 列表：?status=CANDIDATE|APPROVED &tag=&keyword=（默认 CANDIDATE+APPROVED） */
  @Get()
  list(@Query('status') status?: string, @Query('tag') tag?: string, @Query('keyword') keyword?: string) {
    return this.sops.list({ status, tag, keyword });
  }

  /** 人工新增 SOP（管理员/项目负责人，新增即生效） */
  @Post()
  createManual(
    @CurrentUser('id') userId: string,
    @Body() body: { title: string; content: string; tags?: string[]; projectId?: string },
  ) {
    return this.sops.createManual(userId, body);
  }

  /** 从复盘汇总报告提取 SOP 候选（该复盘项目负责人/管理员；AI 去重 + 同源同名兜底） */
  @Post('extract')
  extractFromRetro(@CurrentUser('id') userId: string, @Body() body: { retroId: string }) {
    return this.sops.extractFromRetro(userId, body.retroId);
  }

  /** 从团队记录（群聊/日报/周报）提取 SOP 候选（管理员可全团队/任意项目，负责人限自己项目；默认近 30 天，最长 92 天） */
  @Post('extract-team')
  extractFromTeam(@CurrentUser('id') userId: string, @Body() body: { days?: number; projectId?: string }) {
    return this.sops.extractFromTeam(userId, body);
  }

  /** 确认/拒绝/编辑/打标签（管理员或来源项目负责人） */
  @Patch(':id')
  patch(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body()
    body: { status?: SopStatus; title?: string; content?: string; tags?: string[]; addTags?: string[] },
  ) {
    return this.sops.patch(id, userId, body);
  }

  /** 删除（管理员或来源项目负责人） */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.sops.remove(id, userId);
  }
}
