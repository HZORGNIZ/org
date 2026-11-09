import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProgressQueue } from './progress-queue.service';
import { ProgressWorker } from './progress.worker';
import { ProjectHealthService } from './project-health.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * 项目管理模块
 * - 项目进展扫描不再自动定时（60 分钟 repeat 已移除）：由钉钉抓取夜间批次（22:00）
 *   经 progress 队列投递 'scan' 触发，每天一次；手动触发 POST /api/projects/updates/generate 保留
 */
@Module({
  imports: [AiModule, NotificationsModule, IntegrationsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectHealthService, PrismaService, ProgressQueue, ProgressWorker, ConfigService],
  exports: [ProjectsService, ProjectHealthService],
})
export class ProjectsModule {}
