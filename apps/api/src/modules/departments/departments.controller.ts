import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { DepartmentsService } from './departments.service';

@Controller('departments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DepartmentsController {
  constructor(private departments: DepartmentsService) {}

  @Get()
  list() {
    return this.departments.list();
  }

  /** 首页「我的部门情况」：当前用户所在部门概况 */
  @Get('my')
  myStatus(@CurrentUser() user: CurrentUserPayload) {
    return this.departments.myStatus(user.id);
  }

  /** 岗位清单（所有登录用户可读，用于项目成员岗位下拉） */
  @Get('positions')
  getPositions() {
    return this.departments.getPositions();
  }

  /** 修改岗位清单（仅管理员） */
  @Put('positions')
  @Roles(Role.ADMIN)
  savePositions(@Body() body: { positions: string[] }) {
    return this.departments.savePositions(body?.positions ?? []);
  }

  /** 汇报树（管理员看全量并可改任意人；部门负责人/共管人可读全树、只可改本部门名册）：{ roots, flat, canEditIds } */
  @Get('report-tree')
  reportTree(@CurrentUser() user: CurrentUserPayload) {
    return this.departments.getReportTree({ id: user.id, role: user.role });
  }

  /** 设置某人直属上级：管理员任意；部门管理者（含共管人）限本部门名册，parentId 为空即置为根 */
  @Put('report-to')
  setReportsTo(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string; parentId: string | null },
  ) {
    return this.departments.setReportsTo({ id: user.id, role: user.role }, body?.userId, body?.parentId ?? null);
  }

  /** 回填默认汇报对象（仅系统管理员）：把未设置/失效上级的成员按「主部门负责人(含共管人)→在职管理员」写入直属上级，幂等且只补空值不覆盖手动 */
  @Post('backfill-reports-to')
  @Roles(Role.ADMIN)
  backfillReportsTo(@CurrentUser() user: CurrentUserPayload) {
    return this.departments.backfillReportsTo({ id: user.id, role: user.role });
  }

  /** 部门详情：基本信息 + 成员（含备注与最近进展） + 部门在跑的项目（含成员名单） */
  @Get(':id')
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.departments.detail(id, { id: user.id, role: user.role, departmentId: user.departmentId });
  }

  /** 编辑/删除部门成员备注（仅系统管理员或该部门负责人） */
  @Put(':id/members/:userId/note')
  setNote(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { note: string },
  ) {
    return this.departments.setNote(id, { id: user.id, role: user.role }, userId, body?.note ?? '');
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: { name: string; description?: string; sortOrder?: number }) {
    return this.departments.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { name?: string; description?: string; sortOrder?: number },
  ) {
    return this.departments.update(id, { id: user.id, role: user.role }, body);
  }

  /** 设置/取消部门负责人（管理员或该部门管理者） */
  @Patch(':id/leader')
  setLeader(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userId: string | null },
  ) {
    return this.departments.setLeader(id, { id: user.id, role: user.role }, body?.userId ?? null);
  }

  /** 设置部门共管人名单（管理员或该部门管理者）：与负责人同权限、管整个部门；body { userIds: string[] } */
  @Put(':id/managers')
  setManagers(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { userIds: string[] },
  ) {
    return this.departments.setManagers(id, { id: user.id, role: user.role }, body?.userIds ?? []);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.departments.remove(id);
  }

  /** 部门日报规则（仅管理员/该部门负责人）：reportFrequency / reportWeeklyCount / reportRemindTime / reportNotifyLeader */
  @Get(':id/report-setting')
  getReportSetting(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.departments.getReportSetting(id, { id: user.id, role: user.role });
  }

  /** 更新部门日报规则（仅管理员/该部门负责人），保存后立即生效 */
  @Put(':id/report-setting')
  updateReportSetting(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: { reportFrequency?: string; reportWeeklyCount?: number | null; reportRemindTime?: string; reportNotifyLeader?: boolean },
  ) {
    return this.departments.updateReportSetting(id, { id: user.id, role: user.role }, body ?? {});
  }

  /** 部门本周成员日报完成情况（仅管理员/该部门负责人） */
  @Get(':id/report-status')
  reportStatus(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.departments.reportStatus(id, { id: user.id, role: user.role });
  }
}
