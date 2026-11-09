import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { MeetingActivityService } from './meeting-activity.service';

/**
 * 活动对外页（陌生人免登录）：
 * 每场会议活动可生成一条对外开放链接（meeting.publicToken），持有链接的人无需登录即可：
 * - 看活动信息、签到名单、各小组实时得分
 * - 填姓名 + 手机号签到（陌生人考勤）
 * - 答对题目后提交加分申请，等待组织者 / 助教审批
 * - 自己拉小组（建组 / 加入 / 退出 / 改组名 / 选组长 / 摆座位），用签到时拿到的 guestId 认人
 * - 也可以把自己的头像拖到某个小组上直接加入（groups/assign，只能拖动自己）
 * 发起人可设访问密码（meeting.publicPassword）：设了密码的活动，先调 unlock 换票据，
 * 后续请求带 pwdTicket（body）或 ?pwdTicket=（query）才能访问。
 * 本控制器不加 JwtAuthGuard；只按 token 返回该场活动，标准答案与手机号不外泄。
 */
@Controller('public/meetings')
export class MeetingPublicController {
  constructor(private activity: MeetingActivityService) {}

  /** 入口探测：活动是否设了访问密码、本机票据是否仍有效（不泄露活动信息） */
  @Get(':token/access')
  access(@Param('token') token: string, @Query('pwdTicket') pwdTicket?: string) {
    return this.activity.publicAccess(token, pwdTicket);
  }

  /** 输入访问密码换解锁票据：body { password }；未设密码直接返回空头票 */
  @Post(':token/unlock')
  unlock(@Param('token') token: string, @Body() body: { password?: string }) {
    return this.activity.publicUnlock(token, body?.password);
  }

  /** 对外看板：活动信息 + 参与情况 + 个人/小组得分 + 近期加分（不含标准答案） */
  @Get(':token')
  view(@Param('token') token: string, @Query('pwdTicket') pwdTicket?: string) {
    return this.activity.publicBoard(token, pwdTicket);
  }

  /** 陌生人签到：body { name, phone, gender?, pwdTicket? }，gender 为 MALE / FEMALE 二选一 */
  @Post(':token/checkin')
  checkin(
    @Param('token') token: string,
    @Body() body: { name?: string; phone?: string; gender?: string; pwdTicket?: string },
  ) {
    return this.activity.guestCheckin(token, body ?? {});
  }

  /** 签到信息填错了改一下：body { guestId, name, phone, gender?, pwdTicket? }，改对就重新匹配注册用户 */
  @Post(':token/checkin/update')
  updateCheckin(
    @Param('token') token: string,
    @Body() body: { guestId?: string; name?: string; phone?: string; gender?: string; pwdTicket?: string },
  ) {
    return this.activity.guestUpdate(token, body ?? {});
  }

  /** 答题加分申请：body { phone, answer, reason?, pwdTicket? }，答案正确则进入待审批 */
  @Post(':token/quiz')
  quiz(
    @Param('token') token: string,
    @Body() body: { phone?: string; answer?: string; reason?: string; pwdTicket?: string },
  ) {
    return this.activity.guestQuiz(token, body ?? {});
  }

  /** 自己建组：body { guestId, name, pwdTicket? }，建的人默认当组长 */
  @Post(':token/groups')
  createGroup(@Param('token') token: string, @Body() body: { guestId?: string; name?: string; pwdTicket?: string }) {
    return this.activity.guestGroupCreate(token, body ?? {});
  }

  /** 加入小组：body { guestId, pwdTicket? }，自动从原组退出 */
  @Post(':token/groups/:groupId/join')
  joinGroup(
    @Param('token') token: string,
    @Param('groupId') groupId: string,
    @Body() body: { guestId?: string; pwdTicket?: string },
  ) {
    return this.activity.guestGroupJoin(token, { guestId: body?.guestId, groupId, pwdTicket: body?.pwdTicket });
  }

  /** 拖自己的头像入组：body { guestId, groupId?, name?, pwdTicket? }，groupId 为空就是新建一个组 */
  @Post(':token/groups/assign')
  assignGroup(
    @Param('token') token: string,
    @Body() body: { guestId?: string; groupId?: string; name?: string; pwdTicket?: string },
  ) {
    return this.activity.guestGroupAssign(token, body ?? {});
  }

  /** 退出小组：body { guestId, pwdTicket? } */
  @Post(':token/groups/:groupId/leave')
  leaveGroup(
    @Param('token') token: string,
    @Param('groupId') groupId: string,
    @Body() body: { guestId?: string; pwdTicket?: string },
  ) {
    return this.activity.guestGroupLeave(token, { guestId: body?.guestId, groupId, pwdTicket: body?.pwdTicket });
  }

  /** 改组名 / 选组长 / 摆座位：body { guestId, name?, leaderGuestId?, seatRow?, seatCol?, pwdTicket? } */
  @Patch(':token/groups/:groupId')
  updateGroup(
    @Param('token') token: string,
    @Param('groupId') groupId: string,
    @Body()
    body: { guestId?: string; name?: string; leaderGuestId?: string | null; seatRow?: number; seatCol?: number; pwdTicket?: string },
  ) {
    return this.activity.guestGroupUpdate(token, { ...(body ?? {}), groupId });
  }

  /** 解散小组：只有组长能解散，guestId 与 pwdTicket 放在查询参数上 */
  @Delete(':token/groups/:groupId')
  removeGroup(
    @Param('token') token: string,
    @Param('groupId') groupId: string,
    @Query('guestId') guestId?: string,
    @Query('pwdTicket') pwdTicket?: string,
  ) {
    return this.activity.guestGroupRemove(token, { guestId, groupId, pwdTicket });
  }
}
