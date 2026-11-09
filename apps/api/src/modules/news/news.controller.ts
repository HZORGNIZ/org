import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NewsSourceType } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { NewsService } from './news.service';

@Controller('news')
@UseGuards(JwtAuthGuard)
export class NewsController {
  constructor(private news: NewsService) {}

  // ---- 资讯源 ----
  @Get('sources')
  listSources(@CurrentUser('id') userId: string) {
    return this.news.listSources(userId);
  }

  @Post('sources')
  createSource(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      name: string;
      url: string;
      type?: NewsSourceType;
      category?: string;
      fetchIntervalMin?: number;
    },
  ) {
    return this.news.createSource(user.id, body, user.role === 'ADMIN');
  }

  @Patch('sources/:id')
  updateSource(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      url?: string;
      category?: string;
      fetchIntervalMin?: number;
      enabled?: boolean;
    },
  ) {
    return this.news.updateSource(id, body);
  }

  @Delete('sources/:id')
  removeSource(@Param('id') id: string) {
    return this.news.removeSource(id);
  }

  @Post('sources/:id/fetch')
  fetchNow(@Param('id') id: string) {
    return this.news.fetchNow(id);
  }

  // ---- 订阅 ----
  @Post('sources/:id/subscribe')
  subscribe(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.news.subscribe(userId, id);
  }

  @Delete('sources/:id/subscribe')
  unsubscribe(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.news.unsubscribe(userId, id);
  }

  // ---- 资讯条目 ----
  @Get()
  listItems(
    @CurrentUser('id') userId: string,
    @Query('keyword') keyword?: string,
    @Query('tag') tag?: string,
    @Query('sourceId') sourceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.news.listItems(userId, {
      keyword,
      tag,
      sourceId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ---- 资讯展示规则 / 精选 feed（注意：静态路由需在 @Get(':id') 之前声明） ----

  /** 项目展示规则（项目负责人设定，成员可读） */
  @Get('rule/project/:projectId')
  getProjectRule(@Param('projectId') projectId: string, @CurrentUser('id') userId: string) {
    return this.news.getProjectRule(projectId, userId);
  }

  @Put('rule/project/:projectId')
  saveProjectRule(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { guideText: string },
  ) {
    return this.news.saveProjectRule(projectId, userId, body.guideText ?? '');
  }

  /** 个人资讯兴趣 */
  @Get('rule/me')
  getMyInterest(@CurrentUser('id') userId: string) {
    return this.news.getMyInterest(userId);
  }

  @Put('rule/me')
  saveMyInterest(@CurrentUser('id') userId: string, @Body() body: { interestText: string }) {
    return this.news.saveMyInterest(userId, body.interestText ?? '');
  }

  /** 资讯 feed：?view=all|project:<projectId>|interest&limit=（项目/个人规则 AI 精选，10 分钟缓存） */
  @Get('feed')
  feed(
    @CurrentUser('id') userId: string,
    @Query('view') view?: string,
    @Query('limit') limit?: string,
  ) {
    return this.news.listFeed(userId, view ?? 'all', limit ? Number(limit) : undefined);
  }

  @Get(':id')
  getItem(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.news.getItem(id, userId);
  }
}
