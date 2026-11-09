import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';

@Module({
  controllers: [ResourcesController],
  providers: [ResourcesService, PrismaService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
