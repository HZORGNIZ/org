import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ReportsModule } from '../reports/reports.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [ReportsModule], // 日报时间轴复用 ReportsService.personTimeline，避免两套正文口径
  controllers: [MembersController],
  providers: [MembersService, PrismaService],
})
export class MembersModule {}
