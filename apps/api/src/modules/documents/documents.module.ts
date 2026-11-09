import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DocumentsController } from './documents.controller';
import { PublicDocumentsController } from './public-documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [FilesModule, NotificationsModule],
  controllers: [DocumentsController, PublicDocumentsController],
  providers: [DocumentsService, PrismaService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
