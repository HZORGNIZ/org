import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files/files.module';
import { SopsModule } from '../sops/sops.module';
import { RetrospectivesController } from './retrospectives.controller';
import { RetrospectivesService } from './retrospectives.service';

@Module({
  imports: [AiModule, FilesModule, SopsModule],
  controllers: [RetrospectivesController],
  providers: [RetrospectivesService, PrismaService],
  exports: [RetrospectivesService],
})
export class RetrospectivesModule {}
