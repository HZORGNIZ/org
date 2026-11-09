import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { AgentService } from './agent.service';

/**
 * 项目小助手（悬浮窗 Agent）后端
 * - config：前端据此决定是否渲染悬浮窗（总闸 ∧（管理者 ∨ 员工档）），并告知档位 tier
 * - chat：无状态对话循环（历史由前端携带），只读查询直接执行；写操作返回「动作计划」，
 *   用户确认后由前端调现有接口执行（权限天然按本人收敛）
 * - chase-weekly/notify/tasks/chase-overdue/weekly-to-group/chase-daily/risk-alert：带对外发送副作用的执行路由，必须管理者档（服务端二次校验与重扫）
 * - overview：首屏今日速览（确定性拼数据，不走大模型）
 */
@Controller('agent')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentController {
  constructor(private agent: AgentService) {}

  /** 悬浮窗可见性配置（所有登录用户可查；非管理者在员工档关闭时 visible=false） */
  @Get('config')
  config(@CurrentUser() me: CurrentUserPayload) {
    return this.agent.config(me);
  }

  /** 开关：总闸 + 员工档（仅系统管理员，存 Setting） */
  @Put('config')
  @Roles(Role.ADMIN)
  async saveConfig(@Body() body: { enabled?: boolean; memberEnabled?: boolean }) {
    if (typeof body?.enabled !== 'boolean' && typeof body?.memberEnabled !== 'boolean') {
      throw new BadRequestException('enabled / memberEnabled 至少一项须为布尔值');
    }
    // 两个开关共用这一个接口：后台一次提交哪项就存哪项
    const out: any = { ok: true };
    if (typeof body.enabled === 'boolean') Object.assign(out, await this.agent.saveEnabled(body.enabled));
    if (typeof body.memberEnabled === 'boolean') Object.assign(out, await this.agent.saveMemberEnabled(body.memberEnabled));
    return out;
  }

  @Post('chat')
  chat(
    @CurrentUser() me: CurrentUserPayload,
    @Body() body: { messages?: { role?: string; content?: string }[]; pageContext?: { projectId?: string; projectName?: string; route?: string } },
  ) {
    return this.agent.chat(me, body ?? {});
  }

  /** 催交周报（确认后执行）：只给「仍在缺交名单」的人发站内提醒 */
  @Post('chase-weekly')
  chaseWeekly(@CurrentUser() me: CurrentUserPayload, @Body() body: { periodStart?: string; names?: string[] }) {
    return this.agent.chaseWeekly(me, body ?? {});
  }

  /** 周报发群（确认后执行）：把已存在的本周某归属周报原文再发一次到指定群（不修改记录） */
  @Post('weekly-to-group')
  weeklyToGroup(@CurrentUser() me: CurrentUserPayload, @Body() body: { periodStart?: string; scopeKey?: string; groupIds?: string[] }) {
    return this.agent.weeklyToGroup(me, body ?? {});
  }

  /** 任务下发（确认后执行）：批量建任务并给被指派人推站内信+钉钉私聊 */
  @Post('tasks')
  createTasks(@CurrentUser() me: CurrentUserPayload, @Body() body: { tasks?: any[] }) {
    return this.agent.createTasks(me, body ?? {});
  }

  /** 逾期催办发群（确认后执行）：重扫仍逾期的人，成文后一次发到多个勾选群 */
  @Post('chase-overdue')
  chaseOverdue(@CurrentUser() me: CurrentUserPayload, @Body() body: { groupIds?: string[]; names?: string[] }) {
    return this.agent.chaseOverdue(me, body ?? {});
  }

  /** 催今日日报（确认后执行）：重扫「今天排了班 ∧ 还没写」的人，分群点名 + 站内信 */
  @Post('chase-daily')
  chaseDaily(
    @CurrentUser() me: CurrentUserPayload,
    @Body() body: { projectName?: string; groupIds?: string[]; personIds?: string[] },
  ) {
    return this.agent.chaseDaily(me, body ?? {});
  }

  /** 风险项目提醒（确认后执行）：重扫风险名单，按负责人分组发站内信与对应项目群 */
  @Post('risk-alert')
  riskAlert(@CurrentUser() me: CurrentUserPayload, @Body() body: { userIds?: string[]; includeAttention?: boolean }) {
    return this.agent.riskAlert(me, body ?? {});
  }

  /** 统一通知下发（确认后执行）：一次发到多个群 + 通知多个人（私聊+站内信） */
  @Post('notify')
  broadcastNotify(@CurrentUser() me: CurrentUserPayload, @Body() body: { content?: string; groupIds?: string[]; personIds?: string[] }) {
    return this.agent.broadcastNotify(me, body ?? {});
  }

  /** 移动助手入口（/mobile）打开时的主动播报：待办明细 + 能力引导（确定性拼文案，不走大模型） */
  @Get('mobile-greet')
  mobileGreet(@CurrentUser() me: CurrentUserPayload) {
    return this.agent.mobileGreet(me);
  }

  /** 首屏今日速览：待办/逾期、今日会议、今日日报、我的排名、今天是否排班（三档同一接口，只回自己相关数据） */
  @Get('overview')
  overview(@CurrentUser() me: CurrentUserPayload) {
    return this.agent.overview(me);
  }

  /** 会话历史：列表（轻量）/读取/保存(upsert)/删除（均按本人收敛，需管理者 Agent 可见） */
  @Get('sessions')
  listSessions(@CurrentUser() me: CurrentUserPayload) {
    return this.agent.listSessions(me);
  }

  @Get('sessions/:id')
  getSession(@CurrentUser() me: CurrentUserPayload, @Param('id') id: string) {
    return this.agent.getSession(me, id);
  }

  @Post('sessions')
  saveSession(@CurrentUser() me: CurrentUserPayload, @Body() body: { id?: string; title?: string; messages?: any[] }) {
    return this.agent.saveSession(me, body ?? {});
  }

  @Delete('sessions/:id')
  deleteSession(@CurrentUser() me: CurrentUserPayload, @Param('id') id: string) {
    return this.agent.deleteSession(me, id);
  }
}
