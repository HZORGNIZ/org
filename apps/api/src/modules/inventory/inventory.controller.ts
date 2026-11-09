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
import { DomainNature, Role } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { InventoryService } from './inventory.service';

/**
 * 项目资源盘点：所有登录成员均可新增、编辑、删除；非管理员只能看到并操作自己上传的记录
 * （取数按 creatorId 隔离，见 InventoryService.scope/assertOwner），管理员可查看全部并操作任意记录。
 */
@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.MEMBER)
export class InventoryController {
  constructor(private inventory: InventoryService) {}

  // ---------- 服务器台账 ----------
  @Get('servers')
  listServers(@CurrentUser() user: CurrentUserPayload) {
    return this.inventory.listServers(user);
  }

  @Post('servers')
  createServer(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      ip: string;
      label?: string;
      provider: string;
      region?: string;
      spec?: string;
      usage?: string;
      expireAt?: string | null;
      ownerId?: string | null;
      remark?: string;
    },
  ) {
    return this.inventory.createServer(user, body);
  }

  @Patch('servers/:id')
  updateServer(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      ip: string;
      label: string;
      provider: string;
      region: string;
      spec: string;
      usage: string;
      expireAt: string | null;
      ownerId: string | null;
      remark: string;
    }>,
  ) {
    return this.inventory.updateServer(user, id, body);
  }

  @Delete('servers/:id')
  removeServer(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.inventory.removeServer(user, id);
  }

  // ---------- 域名台账 ----------
  @Get('domains')
  listDomains(@CurrentUser() user: CurrentUserPayload) {
    return this.inventory.listDomains(user);
  }

  @Post('domains')
  createDomain(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      domain: string;
      nature?: DomainNature;
      registrar?: string;
      filing?: string;
      expireAt?: string | null;
      ownerId?: string | null;
      remark?: string;
      serverIds?: string[];
    },
  ) {
    return this.inventory.createDomain(user, body);
  }

  @Patch('domains/:id')
  updateDomain(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      domain: string;
      nature: DomainNature;
      registrar: string;
      filing: string;
      expireAt: string | null;
      ownerId: string | null;
      remark: string;
      serverIds: string[];
    }>,
  ) {
    return this.inventory.updateDomain(user, id, body);
  }

  @Put('domains/:id/servers')
  setDomainServers(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() body: { serverIds: string[] },
  ) {
    return this.inventory.setDomainServers(user, id, body?.serverIds ?? []);
  }

  @Delete('domains/:id')
  removeDomain(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.inventory.removeDomain(user, id);
  }

  // ---------- 项目盘点条目 ----------
  @Get()
  listInventories(@CurrentUser() user: CurrentUserPayload) {
    return this.inventory.listInventories(user);
  }

  @Get('pickable-projects')
  pickableProjects(@CurrentUser() user: CurrentUserPayload) {
    return this.inventory.pickableProjects(user);
  }

  @Post()
  createInventory(
    @CurrentUser() user: CurrentUserPayload,
    @Body()
    body: {
      title: string;
      projectId?: string | null;
      forms?: string[];
      websiteUrl?: string;
      hasMiniProgram?: boolean;
      miniProgramName?: string;
      githubUrl?: string;
      githubAccount?: string;
      admin?: string;
      ownerId?: string | null;
      remark?: string;
      serverIds?: string[];
      domainIds?: string[];
    },
  ) {
    return this.inventory.createInventory(user, body);
  }

  @Patch(':id')
  updateInventory(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      title: string;
      projectId: string | null;
      forms: string[];
      websiteUrl: string;
      hasMiniProgram: boolean;
      miniProgramName: string;
      githubUrl: string;
      githubAccount: string;
      admin: string;
      ownerId: string | null;
      remark: string;
      serverIds: string[];
      domainIds: string[];
    }>,
  ) {
    return this.inventory.updateInventory(user, id, body);
  }

  @Delete(':id')
  removeInventory(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.inventory.removeInventory(user, id);
  }
}
