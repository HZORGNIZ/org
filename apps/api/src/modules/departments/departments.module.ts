import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService, PrismaService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
