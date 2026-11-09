import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AiModule } from '../ai/ai.module';
import { PbcController } from './pbc.controller';
import { PbcService } from './pbc.service';

@Module({
  imports: [IntegrationsModule, AiModule],
  controllers: [PbcController],
  providers: [PbcService, PrismaService],
  exports: [PbcService],
})
export class PbcModule {}
