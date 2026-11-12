import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { requestMeta } from '../../common/access-log';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { ProjectHealthService } from './project-health.service';
import { ProjectCreatePayload, ProjectsService } from './projects.service';

@Controller('projects')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProjectsController {
  constructor(
    private projects: ProjectsService,
    private health: ProjectHealthService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('archived') archived?: string,
  ) {
    // ?archived=true 返回已存档项目（供恢复）；默认返回进行中的项目
    return this.projects.list(user.id, user.role, archived === 'true');
  }

  /** 已知钉钉群列表（来自已落库消息，用于项目关联群） */
  @Get('dingtalk-groups')
  dingtalkGroups() {
    return this.projects.listDingtalkGroups();
  }

  /** 按群名验证钉钉群并返回会话 ID（唯一命中才返回，不泄露群列表） */
  @Post('dingtalk-group/resolve')
  async resolveDingtalkGroup(@Body() body: { name: string }) {
    const r = await this.projects.resolveDingtalkGroup(body?.name);
    if (!r.ok) {
      const msg =
        r.reason === 'AMBIGUOUS'
          ? '存在多个同名钉钉群，请填写更精确的群名'
          : r.reason === 'NOT_FOUND'
            ? '未找到该钉钉群，请确认群名准确，且 dws 账号/机器人已在该群'
            : '钉钉群校验服务不可用（dws 未启用或未登录）';
      throw new BadRequestException(msg);
    }
    return r;
  }

  /** 我参与的项目 + 每个项目最新进展（首页）；管理员可见全部 */
  @Get('my-updates')
  myUpdates(@CurrentUser() user: CurrentUserPayload) {
    return this.projects.myUpdates(user.id, user.role);
  }

  /** 首页项目展示设置（管理员）：{ count } — 每项目展示进展条数 0~10 */
  @Get('home-display')
  @Roles(Role.ADMIN)
  homeDisplay() {
    return this.projects.getHomeDisplay();
  }

  /** 修改首页展示条数（管理员；body.count=0~10，保存后首页立即生效） */
  @Put('home-display')
  @Roles(Role.ADMIN)
  saveHomeDisplay(@Body() body: { count?: number }) {
    if (typeof body?.count !== 'number' || !Number.isFinite(body.count)) {
      throw new BadRequestException('count 须为 0~10 的整数');
    }
    return this.projects.saveHomeDisplay(body.count);
  }

  /** 手动触发 AI 群聊进展总结（管理员调试用） */
  @Post('updates/generate')
  @Roles(Role.ADMIN)
  generateUpdates() {
    return this.projects.generateProgress();
  }

  /** 进展 → 任务回链（从进展创建/关联任务后调用；标记进展为「已转任务」） */
  @Post('updates/link-task')
  linkUpdateTask(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { updateId?: string; taskId?: string },
  ) {
    if (!body?.updateId || !body?.taskId) {
      throw new BadRequestException('缺少 updateId 或 taskId');
    }
    return this.projects.linkUpdateTask(body.updateId, body.taskId, user.id, user.role);
  }

  /** 合并两条项目进展（同一项目内拖拽合并；目标保留，源删除） */
  @Post('updates/merge')
  mergeUpdates(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { sourceId?: string; targetId?: string },
  ) {
    if (!body?.sourceId || !body?.targetId) {
      throw new BadRequestException('缺少 sourceId 或 targetId');
    }
    return this.projects.mergeUpdates(body.sourceId, body.targetId, user.id, user.role);
  }

  /** 当前生效的保密协议正文（系统设置里编辑用） */
  @Get('nda/template')
  ndaTemplate() {
    return this.projects.currentNda();
  }

  /** 改写保密协议（仅系统管理员）：正文有变化才升一个版本 */
  @Put('nda/template')
  @Roles(Role.ADMIN)
  saveNdaTemplate(@CurrentUser() user: CurrentUserPayload, @Body() body: { content?: string }) {
    return this.projects.saveNdaTemplate(user.id, user.role, body?.content ?? '');
  }

  /** 保密项目访问留痕（仅系统管理员）：?days=&limit=&projectId=&userId= */
  @Get('access-logs')
  @Roles(Role.ADMIN)
  accessLogs(
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('projectId') projectId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.projects.accessLogs({ days, limit, projectId, userId });
  }

  /** 回收站（已软删除项目）：仅系统管理员；需声明在 @Get(':id') 之前避免被参数路由吞掉 */
  @Get('trash')
  @Roles(Role.ADMIN)
  trash(@CurrentUser() user: CurrentUserPayload) {
    return this.projects.trash(user.id, user.role);
  }

  /** 待我审批的项目列表：approverId=me 且 status=PENDING；ADMIN 兜底看全部 PENDING */
  @Get('pending')
  pending(@CurrentUser() user: CurrentUserPayload) {
    return this.projects.pendingForReview(user.id, user.role);
  }

  /** 我提交的申请中/被驳回的项目（owner=me 且 status!=ACTIVE） */
  @Get('my-applications')
  myApplications(@CurrentUser() user: CurrentUserPayload) {
    return this.projects.myApplications(user.id);
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: any,
  ) {
    const project = await this.projects.get(id, user.id, user.role, {
      name: user.name,
      ...requestMeta(req),
    });
    // 命中缓存超过 24h（或从未分析）时后台异步补算，不阻塞响应
    // 保密项目未签协议时只回锁定壳（无看板/任务），不能拿去算健康度
    if (!project.locked) this.health.maybeRefreshAsync(project);
    return project;
  }

  /** 拨保密开关（仅系统管理员）；首次开启时给负责人与全部成员发站内信提醒签署 */
  @Put(':id/confidential')
  @Roles(Role.ADMIN)
  setConfidential(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { confidential?: boolean },
  ) {
    if (typeof body?.confidential !== 'boolean') throw new BadRequestException('confidential 须为 true/false');
    return this.projects.setConfidential(user.id, user.role, id, body.confidential);
  }

  /** 在线签署当前版本保密协议（项目成员；签完立即可看项目内容） */
  @Post(':id/nda-sign')
  signNda(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.signNda(id, user.id, user.role);
  }

  // ---- 项目规则与已阅（F5）----

  /** 发布项目规则（ADMIN 或项目负责人）：落库后给未阅成员发站内信 */
  @Post(':id/rules')
  publishRule(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { title?: string; content?: string },
  ) {
    return this.projects.publishRule(user.id, user.role, id, body ?? {});
  }

  /** 项目会议列表（详情页卡片）：已召开会议 + 即将召开 3 场 */
  @Get(':id/meetings')
  meetings(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.projectMeetings(user.id, user.role, id);
  }

  // ---- 项目排期计划（详情页「排期计划」页签）----

  /** 排期总览：阶段列表（需求评审/开发/测试/联调/上线/验收…）+ 项目计划期 + 是否可编辑 */
  @Get(':id/schedule')
  schedule(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.schedule(id, user.id, user.role);
  }

  /** 保存排期（全量替换阶段；仅项目负责人或系统管理员） */
  @Put(':id/schedule')
  saveSchedule(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      items?: { name?: string; startDate?: string; endDate?: string; status?: string; note?: string | null }[];
    },
  ) {
    return this.projects.saveSchedule(id, user.id, user.role, body?.items ?? []);
  }

  // ---- 硬件资产（项目设置开启 hasHardware 后，详情页「硬件」TAB）----

  /** 硬件清单（项目成员/负责人/关联部门负责人可见；保密项目需先签协议） */
  @Get(':id/hardware')
  hardwareList(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.hardwareList(id, user.id, user.role);
  }

  /** 新增硬件条目（仅项目负责人/系统管理员）；保管人不传默认项目组长 */
  @Post(':id/hardware')
  async hardwareCreate(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: { name?: string; model?: string; desc?: string; status?: string; keeperId?: string | null; remark?: string | null; fee?: number | null },
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    return this.projects.hardwareCreate(id, user.id, user.role, body ?? {});
  }

  /** 修改硬件条目（仅项目负责人/系统管理员） */
  @Patch(':id/hardware/:itemId')
  async hardwareUpdate(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: { name?: string; model?: string; desc?: string; status?: string; keeperId?: string | null; remark?: string | null; fee?: number | null },
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    return this.projects.hardwareUpdate(id, itemId, user.id, user.role, body ?? {});
  }

  /** 删除硬件条目（仅项目负责人/系统管理员） */
  @Delete(':id/hardware/:itemId')
  async hardwareRemove(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    return this.projects.hardwareRemove(id, itemId, user.id, user.role);
  }

  /** 项目周报聚合视图（F27）：?periodStart= 任意日期归一到该北京自然周，默认本周 */
  @Get(':id/weekly-report')
  weeklyReport(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query('periodStart') periodStart?: string,
  ) {
    return this.projects.projectWeeklyReport(user.id, user.role, id, periodStart);
  }

  /** 项目周报 AI 总结（读 Setting 缓存，?refresh=1 强制重算）；AI 不可用返回 {ok:false} 非 500 */
  @Post(':id/weekly-report/summary')
  weeklySummary(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query('periodStart') periodStart?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.projects.weeklySummary(user.id, user.role, id, periodStart, refresh === '1' || refresh === 'true');
  }

  /** 应阅/已阅/未阅名单（催办用） */
  @Get(':id/rules/roster')
  ruleRoster(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.ruleRoster(id, user.id, user.role);
  }

  /** 修订规则正文（不清空已阅、不做历史版本） */
  @Put('rules/:ruleId')
  updateRule(
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { title?: string; content?: string },
  ) {
    return this.projects.updateRule(user.id, user.role, ruleId, body ?? {});
  }

  /** 删除规则 */
  @Delete('rules/:ruleId')
  deleteRule(@Param('ruleId') ruleId: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.deleteRule(user.id, user.role, ruleId);
  }

  /** 点「我已阅」（可附一句话）；幂等，已阅后不报错也不覆盖 */
  @Post('rules/:ruleId/ack')
  ackRule(
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { note?: string },
  ) {
    return this.projects.ackRule(user.id, user.role, ruleId, body?.note);
  }

  /** 项目审批历史（时间倒序）；owner/approver/ADMIN 可查 */
  @Get(':id/approvals')
  approvals(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.projects.approvals(id, user.id, user.role);
  }

  /** 审批通过：仅 approver 或 ADMIN；status=PENDING 才有效 */
  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { note?: string } = {},
  ) {
    return this.projects.approve(id, user.id, user.role, body?.note);
  }

  /** 审批驳回：仅 approver 或 ADMIN；note 必填 */
  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { note?: string } = {},
  ) {
    return this.projects.reject(id, user.id, user.role, String(body?.note ?? '').trim());
  }

  /** 加签：主审批人或 ADMIN 邀请其他人共同审批（仅 PENDING 期间） */
  @Post(':id/co-reviewers')
  addCoReviewers(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { reviewerIds?: string[] },
  ) {
    return this.projects.addCoReviewers(id, user.id, user.role, body?.reviewerIds ?? []);
  }

  /** 加签人给出审批结论（APPROVED / REJECTED，驳回需附意见） */
  @Post(':id/co-review/decide')
  decideCoReview(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { decision?: string; note?: string },
  ) {
    return this.projects.decideCoReview(id, user.id, user.role, body ?? {});
  }

  /** 移除尚未处理的加签人（仅主审批人或 ADMIN） */
  @Delete(':id/co-reviewers/:coReviewId')
  removeCoReviewer(
    @Param('id') id: string,
    @Param('coReviewId') coReviewId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.projects.removeCoReviewer(id, user.id, user.role, coReviewId);
  }

  /** 被驳回后修改并重新提交（仅 owner 或 ADMIN；status=REJECTED 才有效） */
  @Post(':id/resubmit')
  resubmit(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: Partial<ProjectCreatePayload>,
  ) {
    return this.projects.resubmit(id, user.id, user.role, body || {});
  }

  /** 项目完成度/健康度 AI 分析（手动重算）；AI 不可用返回 {ok:false} 非 500 */
  @Post(':id/health/analyze')
  analyzeHealth(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.health.analyze({ id: user.id, role: user.role }, id);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() body: ProjectCreatePayload) {
    return this.projects.create(userId, body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      name?: string;
      description?: string;
      color?: string;
      archived?: boolean;
      departmentIds?: string[];
      dingtalkConversationId?: string | null;
      dingtalkGroupName?: string | null;
      dailyDigestEnabled?: boolean;
      digestTime?: string;
      digestEveryDays?: number;
      startDate?: string | null;
      endDate?: string | null;
      requirementDocIds?: string[];
      milestones?: { name: string; dueDate: string; description?: string | null }[];
      skipMilestone?: boolean;
      skipRequirementDoc?: boolean;
      hasHardware?: boolean;
    },
  ) {
    // 仅管理员或项目 OWNER/ADMIN 可修改项目设置（含钉钉群关联）
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    return this.projects.update(id, body);
  }

  /** 删除项目（仅系统管理员）：移入回收站（软删除，可恢复） */
  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }

  /** 从回收站恢复项目（仅系统管理员） */
  @Patch(':id/restore')
  @Roles(Role.ADMIN)
  restore(@Param('id') id: string) {
    return this.projects.restore(id);
  }

  /** 彻底删除项目（不可恢复）：仅系统管理员，物理级联清除 */
  @Delete(':id/purge')
  @Roles(Role.ADMIN)
  purge(@Param('id') id: string) {
    return this.projects.purge(id);
  }

  /** 拉取项目关联群最近 N 天消息并触发 AI 进展总结（项目负责人或管理员）；默认 2 天，最长 92 天 */
  @Post(':id/summarize')
  async summarize(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { days?: number } = {},
  ) {
    // 拉取消息 + AI 总结有外部调用成本，仅负责人/管理员可触发
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    const days = Math.min(Math.max(Math.round(Number(body?.days) || 2), 1), 92);
    return this.projects.summarizeForProject(id, { lookbackHours: days * 24 });
  }

  /** 立即把本项目最近进展发到本项目绑钉钉群（负责人或管理员） */
  @Post(':id/digest-now')
  async digestNow(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    return this.projects.sendDigestNow(id);
  }

  @Post(':id/members')
  async addMember(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string },
  ) {
    // 负责人/政委及以上可添加成员
    if (user.role !== Role.ADMIN) await this.projects.assertCanManageMembers(id, user.id);
    return this.projects.addMember(id, user.id, body.userId, user.role === Role.ADMIN);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManageMembers(id, user.id);
    return this.projects.removeMember(id, user.id, userId, user.role === Role.ADMIN);
  }

  /** 设置项目成员岗位（产品经理/工程师/运维等；负责人、部门负责人或系统管理员） */
  @Patch(':id/members/:userId/position')
  async memberPosition(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { position: string | null },
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManageMembers(id, user.id);
    return this.projects.setMemberPosition(id, user.id, userId, body?.position ?? null, user.role === Role.ADMIN);
  }

  /** 转让项目负责人（仅当前负责人或系统管理员） */
  @Patch(':id/owner')
  async transferOwner(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string },
  ) {
    if (user.role !== Role.ADMIN) await this.projects.assertCanManage(id, user.id);
    return this.projects.transferOwner(id, user.id, body.userId, user.role === Role.ADMIN);
  }

  @Post(':id/boards')
  createBoard(@Param('id') id: string, @Body() body: { name: string }) {
    return this.projects.createBoard(id, body.name);
  }

  @Post('columns')
  createColumn(@Body() body: { boardId: string; name: string }) {
    return this.projects.createColumn(body.boardId, body.name);
  }

  @Patch('columns/:id')
  updateColumn(
    @Param('id') id: string,
    @Body() body: { name?: string; sortOrder?: number; wipLimit?: number | null },
  ) {
    return this.projects.updateColumn(id, body);
  }

  @Delete('columns/:id')
  deleteColumn(@Param('id') id: string) {
    return this.projects.deleteColumn(id);
  }
}
