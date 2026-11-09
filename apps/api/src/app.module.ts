import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from './modules/agent/agent.module';
import { AiModule } from './modules/ai/ai.module';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { AuthModule } from './modules/auth/auth.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FilesModule } from './modules/files/files.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { IdeasModule } from './modules/ideas/ideas.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { IntakeModule } from './modules/intake/intake.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { MeetingModule } from './modules/meeting/meeting.module';
import { MembersModule } from './modules/members/members.module';
import { NewsModule } from './modules/news/news.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PbcModule } from './modules/pbc/pbc.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { RetrospectivesModule } from './modules/retrospectives/retrospectives.module';
import { SopsModule } from './modules/sops/sops.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    UsersModule,
    DepartmentsModule,
    ProjectsModule,
    TasksModule,
    AnnouncementsModule,
    ReportsModule,
    PbcModule,
    RetrospectivesModule,
    SopsModule,
    KnowledgeModule,
    DocumentsModule,
    ResourcesModule,
    NewsModule,
    MeetingModule,
    MembersModule,
    NotificationsModule,
    IntegrationsModule,
    FilesModule,
    FeedbackModule,
    AiModule,
    IdeasModule,
    IntakeModule,
    InventoryModule,
    AgentModule,
  ],
})
export class AppModule {}
