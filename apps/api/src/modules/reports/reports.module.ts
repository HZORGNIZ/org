import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { WorkScheduleService } from './work-schedule.service';

@Module({
  imports: [AiModule, NotificationsModule, IntegrationsModule],
  controllers: [ReportsController],
  providers: [ReportsService, WorkScheduleService, PrismaService],
  exports: [ReportsService, WorkScheduleService],
})
export class ReportsModule {}
