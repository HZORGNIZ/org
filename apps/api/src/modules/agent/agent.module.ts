import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { ReportsModule } from '../reports/reports.module';
import { ProjectsModule } from '../projects/projects.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SopsModule } from '../sops/sops.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

/**
 * 管理者 Agent 模块（悬浮窗对话助手）
 * - 只读工具一律复用各模块 service（Projects/Reports/Tasks/Knowledge/Sops），可见性口径不在本模块重写
 *   （历史上重写过一次，就出现过“首页看得到待办、任务页找不到”这种分叉）
 * - 写操作只产出「动作计划」，由前端确认卡片调现有接口；催交/发群/下发/广播走本模块执行路由
 * - 员工档（tier=member）只能用只读自己数据的工具与自己的日报/任务动作，执行路由全部走 assertManager
 */
@Module({
  imports: [AiModule, ReportsModule, ProjectsModule, NotificationsModule, TasksModule, KnowledgeModule, SopsModule, IntegrationsModule],
  controllers: [AgentController],
  providers: [AgentService, PrismaService],
})
export class AgentModule {}
