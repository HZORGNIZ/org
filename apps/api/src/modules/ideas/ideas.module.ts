import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { IdeasController } from './ideas.controller';
import { IdeasService } from './ideas.service';

@Module({
  imports: [AiModule, ProjectsModule, TasksModule],
  controllers: [IdeasController],
  providers: [IdeasService, PrismaService],
  exports: [IdeasService],
})
export class IdeasModule {}
