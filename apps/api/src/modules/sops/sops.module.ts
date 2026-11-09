import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { SopsController } from './sops.controller';
import { SopsService } from './sops.service';

@Module({
  imports: [AiModule],
  controllers: [SopsController],
  providers: [SopsService, PrismaService],
  exports: [SopsService],
})
export class SopsModule {}
