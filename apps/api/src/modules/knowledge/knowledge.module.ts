import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, PrismaService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
