import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { PromptService } from './prompt.service';
import { AiService } from './ai.service';
import { AiCallController } from './ai-call.controller';

@Module({
  controllers: [AiCallController],
  providers: [PromptService, AiService, PrismaService, ConfigService],
  exports: [PromptService, AiService],
})
export class AiModule {}
