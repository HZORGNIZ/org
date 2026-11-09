import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { MeetingActivityService } from './meeting-activity.service';
import { MeetingInput, MeetingService } from './meeting.service';

@Controller('meetings')
@UseGuards(JwtAuthGuard)
export class MeetingController {
  constructor(
    private meeting: MeetingService,
    private activity: MeetingActivityService,
  ) {}

  private actor(user: CurrentUserPayload) {
    return { id: user.id, name: user.name, role: user.role, departmentId: user.departmentId ?? null };
  }

  /** 发起表单预填：按层级带出名称/时间/参会人/材料要求/钉钉群（?scope=DEPT&deptId=&projectId=） */
  @Get('template')
  template(@CurrentUser() user: CurrentUserPayload, @Query('scope') scope: string, @Query('deptId') deptId: string, @Query('projectId') projectId: string) {
    return this.meeting.template(this.actor(user), { scope, deptId, projectId });
  }

  /** 可选钉钉群候选（各项目已绑定的群 + 周期位上的群） */
  @Get('group-options')
  groupOptions(@CurrentUser() user: CurrentUserPayload) {
    return this.meeting.groupOptions(this.actor(user));
  }

  /** 关联群配置读取：{ canManageCompany, company, departments[] } */
  @Get('group-config')
  groupConfig(@CurrentUser() user: CurrentUserPayload) {
    return this.meeting.groupConfig(this.actor(user));
  }

  /** 设置公司会议默认关联群（仅管理员；conversationId 为空即清除） */
  @Put('group-config/company')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  saveCompanyGroup(@Body() body: { conversationId?: string | null; name?: string | null }) {
    return this.meeting.saveCompanyGroup(body ?? {});
  }

  /** 设置某部门会议默认关联群（管理员或该部门负责人） */
  @Put('group-config/department/:deptId')
  saveDeptGroup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('deptId') deptId: string,
    @Body() body: { conversationId?: string | null; name?: string | null },
  ) {
    return this.meeting.saveDeptGroup(this.actor(user), deptId, body ?? {});
  }

  /** 会议活动列表：?view=mine|owned|all&scope=&status=&type=&kind=ACTIVITY|MEETING&keyword= */
  @Get()
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('view') view: string,
    @Query('scope') scope: string,
    @Query('status') status: string,
    @Query('type') type: string,
    @Query('kind') kind: string,
    @Query('keyword') keyword: string,
    @Query('take') take: string,
  ) {
    return this.meeting.list(this.actor(user), { view, scope, status, type, kind, keyword, take });
  }

  /** 团队公告卡片：今天 ± 3 天的会议活动通知（含我的打卡状态），全员可见；必须声明在 :id 详情路由之前 */
  @Get('announce-board')
  announceBoard(@CurrentUser() user: CurrentUserPayload) {
    return this.meeting.announceBoard(this.actor(user));
  }

  /** 我的活跃度与近期出勤（参加次数 × 高/中/低 = 3/2/1） */
  @Get('stats/me')
  myStats(@CurrentUser() user: CurrentUserPayload) {
    return this.meeting.myStats(this.actor(user));
  }

  /** 全组织（或本部门）出勤与活跃度总览：?from=&to=&deptId= */
  @Get('stats/overview')
  overview(
    @CurrentUser() user: CurrentUserPayload,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('deptId') deptId: string,
  ) {
    return this.meeting.attendanceOverview(this.actor(user), { from, to, deptId });
  }

  /** 某人所有参加过的会议活动 + 出勤概况 */
  @Get('stats/member/:userId')
  memberStats(@CurrentUser() user: CurrentUserPayload, @Param('userId') userId: string) {
    return this.meeting.memberStats(this.actor(user), userId);
  }

  /** 会议详情：基础信息 + 会前材料清单 + 条目清单（正文聚合走 /materials） */
  @Get(':id')
  detail(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.detail(this.actor(user), id);
  }

  /** 会前材料聚合直排视图：姓名 · 部门 · 正文 + 逐人点评（单页返回，不逐条点开） */
  @Get(':id/materials')
  materials(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.materialsView(this.actor(user), id);
  }

  /** 读取/重新读取参会人周报（仅主持人/管理员）：body.userIds 为空则处全体 */
  @Post(':id/materials/read')
  readMaterials(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { userIds?: string[] }) {
    return this.meeting.readReports(this.actor(user), id, Array.isArray(body?.userIds) ? body.userIds : []);
  }

  /** 提交/更新自己的会前材料（body.userId 仅主持人可传，用于代交） */
  @Post(':id/materials/submit')
  submitMaterial(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { content: string; userId?: string }) {
    return this.meeting.submitMaterial(this.actor(user), id, body?.content ?? '', body?.userId);
  }

  /** 会中修改某人材料正文（写 editedContent，原文保留） */
  @Patch('materials/:id')
  editMaterial(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { content: string }) {
    return this.meeting.editMaterial(this.actor(user), id, body?.content ?? '');
  }

  /** 点评材料（独立留痕，不覆盖原文） */
  @Post('materials/:id/reviews')
  addReview(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { content: string }) {
    return this.meeting.addReview(this.actor(user), id, body?.content ?? '');
  }

  /** 删除点评（仅本人或会议主持人/管理员） */
  @Delete('reviews/:id')
  deleteReview(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.deleteReview(this.actor(user), id);
  }

  /** 自主签到（会议开始 ~ 开始后 1 小时内） */
  @Post(':id/checkin')
  checkin(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.checkin(this.actor(user), id);
  }

  /** 团队公告卡片打卡：开始后 3 天内全员可打（不要求参会名册） */
  @Post(':id/board-checkin')
  boardCheckin(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.boardCheckin(this.actor(user), id);
  }

  /** 全员补签矩阵取数：全体在职成员 + 本场签到状态 + 逐人可否补签（发起人/管理员/助教/部门主管） */
  @Get(':id/checkin/candidates')
  checkinCandidates(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.checkinCandidates(this.actor(user), id);
  }

  /** 补签：body.userId + body.reason（发起人/管理员/本场助教/对方部门主管；reason 留空则自动记矩阵补签） */
  @Post(':id/checkin/makeup')
  makeupCheckin(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { userId: string; reason?: string }) {
    return this.meeting.makeupCheckin(this.actor(user), id, body?.userId, body?.reason);
  }

  /** 撤销考勤（误签，仅发起人/管理员） */
  @Delete(':id/checkin/:userId')
  removeAttendance(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Param('userId') userId: string) {
    return this.meeting.removeAttendance(this.actor(user), id, userId);
  }

  /** 会中表现点赞：body.userId + body.reason（理由可选） */
  @Post(':id/praise')
  addPraise(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { userId: string; reason?: string }) {
    return this.meeting.addPraise(this.actor(user), id, body?.userId, body?.reason);
  }

  /** 撤销点赞 */
  @Delete('praises/:id')
  removePraise(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.removePraise(this.actor(user), id);
  }

  /** 保存会议/活动文档的在线文字记录 */
  @Post(':id/doc')
  saveDoc(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { text: string }) {
    return this.meeting.saveDoc(this.actor(user), id, body?.text ?? '');
  }

  /** 上传会议/活动文档附件（multipart: file） */
  @Post(':id/files')
  @UseInterceptors(FileInterceptor('file'))
  addFile(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.meeting.addFile(this.actor(user), id, file);
  }

  /** 删除会议/活动文档附件 */
  @Delete('files/:id')
  removeFile(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.removeFile(this.actor(user), id);
  }

  /** 创建会议（body.publish=true 时创建即发布） */
  @Post()
  create(@CurrentUser() user: CurrentUserPayload, @Body() body: MeetingInput) {
    return this.meeting.create(this.actor(user), body ?? {});
  }

  /** 编辑会议（仅 DRAFT/SCHEDULED） */
  @Patch(':id')
  update(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: MeetingInput) {
    return this.meeting.update(this.actor(user), id, body ?? {});
  }

  /** 发布：草稿 → 已安排（自动生成的部门周会首次由负责人点发布，此后该周期位置为自动发群） */
  @Post(':id/publish')
  publish(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.publish(this.actor(user), id);
  }

  /** 状态流转：开会 / 整理纪要 / 完成（?status=IN_PROGRESS|MINUTING|DONE） */
  @Post(':id/status')
  setStatus(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Query('status') status: string, @Body() body: { status?: string }) {
    return this.meeting.setStatus(this.actor(user), id, status ?? body?.status);
  }

  /** 保存会议纪要正文（body.send=true 时同时投递「纪要发到钉钉群」） */
  @Post(':id/minutes')
  saveMinutes(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { minutes: string; send?: boolean }) {
    return this.meeting.saveMinutes(this.actor(user), id, body?.minutes ?? '', { send: body?.send === true });
  }

  /** 手动补发通知（?kind=INVITE|GROUP|START|CANCEL|MINUTES|MATERIAL|WRAP_UP&dryRun=true 可先预览正文与收件人） */
  @Post(':id/notify')
  notify(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Query('kind') kind: string,
    @Query('dryRun') dryRun: string,
    @Query('force') force: string,
    @Body() body: { kind?: string; dryRun?: boolean; force?: boolean },
  ) {
    return this.meeting.notify(this.actor(user), id, kind ?? body?.kind ?? 'INVITE', {
      dryRun: dryRun === 'true' || body?.dryRun === true,
      force: force === 'true' || body?.force === true,
    });
  }

  /** 取消会议 */
  @Post(':id/cancel')
  cancel(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.meeting.cancel(this.actor(user), id, body?.reason);
  }

  /** 删除会议（软删除，仅发起人/管理员） */
  @Delete(':id')
  remove(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.meeting.remove(this.actor(user), id);
  }

  // ===== 活动互动：对外链接 / 助教 / 答题加分 / 加分审批 / 自主分组 / 实时看板 =====

  /** 取（或首次生成）对外开放链接：陌生人凭链接免登录看活动与得分、签到、答题加分 */
  @Get(':id/public-link')
  publicLink(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.activity.publicLink(this.actor(user), id);
  }

  /** 任命 / 卸任助教（body.enable=false 为卸任）；助教可审核加分与管理活动 */
  @Post(':id/assistants')
  setAssistant(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { userId: string; enable?: boolean }) {
    return this.activity.setAssistant(this.actor(user), id, body?.userId, body?.enable !== false);
  }

  /** 卸任助教 */
  @Delete(':id/assistants/:userId')
  removeAssistant(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Param('userId') userId: string) {
    return this.activity.setAssistant(this.actor(user), id, userId, false);
  }

  /** 设置答题加分（题目 + 标准答案 + 分值；都留空为关闭） */
  @Post(':id/quiz')
  saveQuiz(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { question?: string; answer?: string; points?: number }) {
    return this.activity.saveQuiz(this.actor(user), id, body ?? {});
  }

  /** 设置 / 清除活动访问密码（body.password 留空即取消；设了密码后对外页需先输密码才能进） */
  @Post(':id/public-password')
  savePublicPassword(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Body() body: { password?: string }) {
    return this.activity.setPublicPassword(this.actor(user), id, body?.password);
  }

  /** 实时看板：签到情况 / 个人得分 / 各组得分 / 待审批明细 */
  @Get(':id/board')
  board(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.activity.board(this.actor(user), id);
  }

  /** 组织者或助教直接加分：body.targetType=USER|GUEST，配 userId 或 guestId */
  @Post(':id/scores')
  addScore(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { targetType?: string; userId?: string; guestId?: string; points?: number; reason?: string },
  ) {
    return this.activity.addScore(this.actor(user), id, body ?? {});
  }

  /** 审批答题加分（body.approve=false 为驳回） */
  @Post(':id/scores/:scoreId/review')
  reviewScore(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Param('scoreId') scoreId: string,
    @Body() body: { approve?: boolean },
  ) {
    return this.activity.reviewScore(this.actor(user), id, scoreId, body?.approve !== false);
  }

  /** 撤销一条加分 */
  @Delete(':id/scores/:scoreId')
  removeScore(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Param('scoreId') scoreId: string) {
    return this.activity.removeScore(this.actor(user), id, scoreId);
  }

  /** 建组（座位相邻的人抱团，自己起组名、选组长） */
  @Post(':id/groups')
  createGroup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { name?: string; leaderId?: string; memberIds?: string[] },
  ) {
    return this.activity.createGroup(this.actor(user), id, body ?? {});
  }

  /** 拖头像入组：管理层把任意成员 / 来宾分进小组或新建小组；本人也可拖自己加入 */
  @Post(':id/groups/assign')
  assignGroup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { groupId?: string; name?: string; userId?: string; guestId?: string },
  ) {
    return this.activity.assignGroup(this.actor(user), id, body ?? {});
  }

  /** 加入小组 / 改组名与组长 / 解散 */
  @Post(':id/groups/:groupId/join')
  joinGroup(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Param('groupId') groupId: string) {
    return this.activity.joinGroup(this.actor(user), id, groupId);
  }

  @Delete(':id/groups/:groupId/leave')
  leaveGroup(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Param('groupId') groupId: string) {
    return this.activity.leaveGroup(this.actor(user), id, groupId);
  }

  /** 把人移出小组（拖到「移出小组」区）：管理层可移任何人，body { userId? / guestId? } */
  @Post(':id/groups/leave')
  leaveMember(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { userId?: string; guestId?: string },
  ) {
    return this.activity.leaveMember(this.actor(user), id, body ?? {});
  }

  @Patch(':id/groups/:groupId')
  updateGroup(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Body() body: { name?: string; leaderId?: string | null; seatRow?: number; seatCol?: number },
  ) {
    return this.activity.updateGroup(this.actor(user), id, groupId, body ?? {});
  }

  @Delete(':id/groups/:groupId')
  removeGroup(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string, @Param('groupId') groupId: string) {
    return this.activity.removeGroup(this.actor(user), id, groupId);
  }
}
