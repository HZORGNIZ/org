import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { PrismaService } from '../../common/prisma.service';
import { fmtBeijingDate } from '../../common/beijing-time';

/**
 * 大模型调用记录（「大模型调用」页，仅管理员）
 * - 数据由 AiService 在每次实际调用（含重试）后异步写入 AiCallLog
 * - 时间口径：AiCallLog.createdAt 存【北京墙钟字面量】（与 MessageInbox.receivedAt 相同），
 *   因此按天查询直接取字面量区间、展示直接切 ISO 字符串，两端均不做时区换算
 */
@Controller('ai-calls')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AiCallController {
  constructor(private prisma: PrismaService) {}

  /** 某天（北京时间，默认今天）全部调用的概览列表（不含提示词/返回全文，详情按 id 取） */
  @Get()
  async list(@Query('date') date?: string) {
    const day = this.normalizeDate(date);
    const gte = new Date(`${day}T00:00:00.000Z`);
    const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
    const rows = await this.prisma.aiCallLog.findMany({
      where: { createdAt: { gte, lt } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        promptName: true,
        description: true,
        caller: true,
        model: true,
        attempt: true,
        status: true,
        durationMs: true,
        finishReason: true,
        promptTokens: true,
        completionTokens: true,
        error: true,
      },
    });
    return {
      date: day,
      total: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        time: wallClock(r.createdAt),
        promptName: r.promptName,
        description: r.description,
        caller: r.caller,
        model: r.model,
        attempt: r.attempt,
        status: r.status,
        durationMs: r.durationMs,
        finishReason: r.finishReason,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        error: r.error,
      })),
    };
  }

  /** 单条调用详情（含完整提示词与大模型返回结果） */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const row = await this.prisma.aiCallLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('调用记录不存在');
    return {
      id: row.id,
      time: wallClock(row.createdAt),
      promptName: row.promptName,
      description: row.description,
      caller: row.caller,
      model: row.model,
      attempt: row.attempt,
      status: row.status,
      durationMs: row.durationMs,
      finishReason: row.finishReason,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      error: row.error,
      promptText: row.promptText,
      response: row.response,
    };
  }

  /** 校验并规整 date（YYYY-MM-DD，北京时间）；缺省为今天 */
  private normalizeDate(date?: string) {
    if (!date) return fmtBeijingDate(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date 格式应为 YYYY-MM-DD');
    return date;
  }
}

/** 北京墙钟字面量 Date → 'YYYY-MM-DD HH:mm:ss'（直接切 ISO，不做时区换算） */
function wallClock(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
