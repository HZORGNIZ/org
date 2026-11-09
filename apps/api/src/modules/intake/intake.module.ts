import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { ReportsModule } from '../reports/reports.module';
import { TasksModule } from '../tasks/tasks.module';
import { IdeasModule } from '../ideas/ideas.module';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

@Module({
  imports: [AiModule, ReportsModule, TasksModule, IdeasModule],
  controllers: [IntakeController],
  providers: [IntakeService, PrismaService],
})
export class IntakeModule {}
