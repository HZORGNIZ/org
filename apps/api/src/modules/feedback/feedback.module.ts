import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

/**
 * 使用体验反馈模块
 * - 全员提交入口在首页顶部，落库后复用 Integrations 的钉钉能力同步到公司全员大群
 * - AI 总结复用 AiModule（feedback.summary 提示词），仅管理后台调用
 */
@Module({
  imports: [AiModule, IntegrationsModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, PrismaService],
})
export class FeedbackModule {}
