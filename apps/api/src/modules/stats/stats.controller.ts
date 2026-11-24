import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { StatsService } from './stats.service';

@Controller('stats')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private stats: StatsService) {}

  /**
   * 数据看板：按部门 / 按项目 / 按人员三个视角的聚合排行。
   * period: week 本周 / month 本月 / quarter 本季度（约束日报工时等过程指标；任务完成率/逾期为全量口径）
   */
  @Get('dashboard')
  dashboard(
    @CurrentUser() me: { id: string; role: string },
    @Query('scope') scope?: string,
    @Query('period') period?: string,
  ) {
    return this.stats.dashboard(me, scope, period);
  }
}
