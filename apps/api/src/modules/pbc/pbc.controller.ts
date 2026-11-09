import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { PbcItem, PbcScoreInput, PbcService, PbcTaskPreview } from './pbc.service';

@Controller('pbc')
@UseGuards(JwtAuthGuard)
export class PbcController {
  constructor(private pbc: PbcService) {}

  /** 我某月 PBC：?month=YYYY-MM，无记录返回空计划 */
  @Get()
  get(@CurrentUser('id') userId: string, @Query('month') month: string) {
    return this.pbc.getMine(userId, month);
  }

  /** 成员月度 PBC 概览（仅部门负责人/管理员使用）：?month=YYYY-MM */
  @Get('team')
  team(@CurrentUser() user: CurrentUserPayload, @Query('month') month: string) {
    return this.pbc.listForViewer({ id: user.id, role: user.role }, month);
  }

  /** 部门内成员 PBC 互看（DepartmentView「PBC」标签）：?departmentId=&month=YYYY-MM */
  @Get('dept')
  dept(@CurrentUser() user: CurrentUserPayload, @Query('departmentId') departmentId: string, @Query('month') month: string) {
    return this.pbc.listForDepartment({ id: user.id, role: user.role, departmentId: user.departmentId }, departmentId, month);
  }

  /** 待我审核清单（工作管理 → PBC → 待我审核）：?month=YYYY-MM，省略则返回所有有待处理的月份 */
  @Get('review-queue')
  reviewQueue(@CurrentUser() user: CurrentUserPayload, @Query('month') month?: string) {
    return this.pbc.reviewQueue({ id: user.id, role: user.role }, month);
  }

  /** 有定稿评分的月份（降序）：排行榜默认月与月份下拉用 */
  @Get('ranking/months')
  rankingMonths() {
    return this.pbc.rankingMonths();
  }

  /** 月度 PBC 排行（仅上级评分定稿、按 leaderTotal）：?month=YYYY-MM；返回总排行 + 按部门排行 */
  @Get('ranking')
  ranking(@CurrentUser() user: CurrentUserPayload, @Query('month') month: string) {
    return this.pbc.ranking({ id: user.id, role: user.role, departmentId: user.departmentId }, month);
  }

  /** 首页：最近一次有上级评分定稿的月份的全公司 PBC 排行（不分部门、全员可见） */
  @Get('latest-ranking')
  latestRanking() {
    return this.pbc.latestOverallRanking();
  }

  /** 保存我某月 PBC（事项+分值，合计须=100；可反复编辑覆盖；已审批通过则锁定） */
  @Post()
  save(
    @CurrentUser('id') userId: string,
    @Body() body: { month: string; items: PbcItem[] },
  ) {
    return this.pbc.saveMine(userId, body?.month, body?.items ?? []);
  }

  /** 审批通过某成员某月 PBC（负责人审批本部门成员 / 管理员审批任意） */
  @Post('approve')
  approve(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string },
  ) {
    return this.pbc.approve({ id: user.id, role: user.role, name: user.name }, body?.userId, body?.month);
  }

  /** 允许修改（撤回审批）：解除锁定，成员可再次编辑 */
  @Post('revoke')
  revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string },
  ) {
    return this.pbc.revoke({ id: user.id, role: user.role, name: user.name }, body?.userId, body?.month);
  }

  /** 退回修改：负责人/管理员退回成员本月 PBC 并附修改意见，钉钉私聊通知成员 */
  @Post('reject')
  reject(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string; comment: string },
  ) {
    return this.pbc.reject({ id: user.id, role: user.role, name: user.name }, body?.userId, body?.month, body?.comment);
  }

  /** 催一下：钉钉私聊提醒成员尽快提交本月 PBC（供未写成员催办） */
  @Post('remind')
  remind(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string },
  ) {
    return this.pbc.remind({ id: user.id, role: user.role, name: user.name }, body?.userId, body?.month);
  }

  /** PBC 任务分解预览：发给 DeepSeek 拆为多条带建议截止日的任务 + 可承接项目清单 */
  @Post('decompose')
  decompose(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string },
  ) {
    return this.pbc.decompose({ id: user.id, role: user.role, name: user.name }, body?.userId, body?.month);
  }

  /** 提交自评：本人本月已提交/已批计划的逐事项自评分 + 整月总述 + 选定打分上级 */
  @Post('self-review')
  selfReview(
    @CurrentUser('id') userId: string,
    @Body() body: { month: string; items?: PbcScoreInput[]; selfSummary?: string; pbcLeaderId?: string | null },
  ) {
    return this.pbc.selfReview(userId, body?.month, { items: body?.items, selfSummary: body?.selfSummary, pbcLeaderId: body?.pbcLeaderId });
  }

  /** 上级评分定稿：打分上级/管理员对已自评成员本月逐条评分 + 整月总评 */
  @Post('leader-review')
  leaderReview(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string; items?: PbcScoreInput[]; leaderComment?: string },
  ) {
    return this.pbc.leaderReview(
      { id: user.id, role: user.role, name: user.name },
      body?.userId,
      body?.month,
      { items: body?.items, leaderComment: body?.leaderComment },
    );
  }

  /** 撤销定稿（仅 ADMIN）：LEADER_DONE → SELF_DONE，保留分数，写留痕并通知成员与上级 */
  @Post('leader-review/revoke')
  revokeLeaderReview(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string; note?: string },
  ) {
    return this.pbc.revokeLeaderReview(
      { id: user.id, role: user.role, name: user.name },
      body?.userId,
      body?.month,
      body?.note,
    );
  }

  /** 确认创建：把分解任务建为项目任务（每条可各自指定关联项目），自动带负责人与截止时间 */
  @Post('create-tasks')
  createTasks(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; month: string; projectId?: string; tasks: PbcTaskPreview[] },
  ) {
    return this.pbc.createTasksFromPbc(
      { id: user.id, role: user.role, name: user.name },
      body?.userId,
      body?.month,
      body?.tasks ?? [],
      body?.projectId,
    );
  }
}
