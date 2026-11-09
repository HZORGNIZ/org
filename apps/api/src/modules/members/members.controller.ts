import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { MembersService } from './members.service';

/**
 * 成员画像：任何登录用户都可读「自己看得见的同事」的公开块（同部门互看是刻意放开的透明度），
 * 私有块（PBC 得分与意见、部门成员备注）由服务端按档位裁剪，因此这里不加 @Roles 硬闸。
 */
@Controller('members')
@UseGuards(JwtAuthGuard)
export class MembersController {
  constructor(private members: MembersService) {}

  /** 人名模糊搜索（姓名/用户名），供「人名可点」入口与页内切换 */
  @Get()
  search(@CurrentUser() user: CurrentUserPayload, @Query('q') q?: string) {
    return this.members.search({ id: user.id, role: user.role }, q ?? '');
  }

  /** 成员画像聚合 */
  @Get(':id')
  profile(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.members.profile(id, { id: user.id, role: user.role });
  }
}
