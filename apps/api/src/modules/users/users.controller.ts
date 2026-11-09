import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { AllowNoOrg } from '../../common/no-org.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private users: UsersService) {}

  /** 我的资料：等待加入组织的用户也要能读到自己的信息（缺省页展示用） */
  @Get('me')
  @AllowNoOrg()
  me(@CurrentUser('id') id: string) {
    return this.users.me(id);
  }

  @Patch('me')
  @AllowNoOrg()
  updateProfile(
    @CurrentUser('id') id: string,
    @Body() body: { name?: string; avatar?: string },
  ) {
    return this.users.updateProfile(id, body);
  }

  @Get()
  list() {
    return this.users.list();
  }

  /** 管理员创建用户（用户名/真实姓名/手机号必填，默认密码，首次登录强制改密） */
  @Post()
  @Roles(Role.ADMIN)
  createUser(@Body() body: { username: string; name: string; phone: string; departmentId?: string | null; additionalDepartmentIds?: string[] }) {
    return this.users.createByAdmin(body);
  }

  @Patch(':id/role')
  @Roles(Role.ADMIN)
  updateRole(@Param('id') id: string, @Body() body: { role: 'ADMIN' | 'DEPT_LEADER' | 'PROJECT_LEADER' | 'MEMBER' }) {
    return this.users.updateRole(id, body.role);
  }

  @Patch(':id/active')
  @Roles(Role.ADMIN)
  toggleActive(@Param('id') id: string, @Body() body: { active: boolean }) {
    return this.users.toggleActive(id, body.active);
  }

  /** 管理员编辑用户资料（用户名/真实姓名/手机号/部门） */
  @Patch(':id')
  @Roles(Role.ADMIN)
  updateUser(@Param('id') id: string, @Body() body: { username?: string; name?: string; phone?: string; departmentId?: string | null; additionalDepartmentIds?: string[] }) {
    return this.users.updateByAdmin(id, body);
  }

  /** 管理员重置用户密码（重置为默认密码 + 下次登录强制修改） */
  @Post(':id/reset-password')
  @Roles(Role.ADMIN)
  resetPassword(@CurrentUser('id') me: string, @Param('id') id: string) {
    return this.users.resetPasswordByAdmin(me, id);
  }

  /** 管理员删除用户（可删除任意用户；其名下项目/任务/文档等转移给操作管理员，个人数据级联删除） */
  @Delete(':id')
  @Roles(Role.ADMIN)
  deleteUser(@CurrentUser('id') me: string, @Param('id') id: string) {
    if (me === id) throw new BadRequestException('不能删除当前登录账号');
    return this.users.deleteByAdmin(me, id);
  }
}
