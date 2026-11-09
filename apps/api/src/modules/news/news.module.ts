import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { AiModule } from '../ai/ai.module';
import { NewsController } from './news.controller';
import { NewsFetchService } from './news-fetch.service';
import { NewsQueue } from './news-queue.service';
import { NewsService } from './news.service';
import { NewsWorker } from './news.worker';

/** 资讯模块：启动时注册资讯源定时抓取 */
@Module({
  imports: [AiModule],
  controllers: [NewsController],
  providers: [NewsService, NewsFetchService, NewsQueue, NewsWorker, PrismaService, ConfigService],
  exports: [NewsFetchService, NewsService],
})
export class NewsModule implements OnApplicationBootstrap {
  constructor(private fetchService: NewsFetchService) {}

  onApplicationBootstrap() {
    // 恢复全部启用资讯源的定时抓取（幂等）
    this.fetchService.restoreSchedules().catch(() => undefined);
  }
}
