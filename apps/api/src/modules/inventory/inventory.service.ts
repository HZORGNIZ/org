import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DomainNature, Prisma, Role } from '@prisma/client';
import { CurrentUserPayload } from '../../common/current-user.decorator';
import { PrismaService } from '../../common/prisma.service';

/** 负责人/创建人的通用展示投影 */
const userSelect = { id: true, name: true, avatar: true } satisfies Prisma.UserSelect;

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  private isAdmin(actor: CurrentUserPayload) {
    return actor.role === Role.ADMIN;
  }

  /** 列表可见范围：管理员全部，其他人仅自己创建 */
  private scope(actor: CurrentUserPayload) {
    return this.isAdmin(actor) ? {} : { creatorId: actor.id };
  }

  /** 校验记录归属：非管理员只能操作自己上传的记录 */
  private assertOwner(actor: CurrentUserPayload, creatorId: string | null) {
    if (this.isAdmin(actor)) return;
    if (creatorId !== actor.id) {
      throw new ForbiddenException('你只能修改自己上传的记录');
    }
  }

  /** 过滤出当前用户有权关联的 id（非管理员仅能关联自己创建的台账） */
  private async filterOwnedIds(
    actor: CurrentUserPayload,
    model: 'inventoryServer' | 'inventoryDomain',
    ids: string[] | undefined,
  ): Promise<string[]> {
    if (!ids?.length) return [];
    if (this.isAdmin(actor)) return ids;
    const where = { id: { in: ids }, creatorId: actor.id };
    const rows =
      model === 'inventoryServer'
        ? await this.prisma.inventoryServer.findMany({ where, select: { id: true } })
        : await this.prisma.inventoryDomain.findMany({ where, select: { id: true } });
    return rows.map((r: { id: string }) => r.id);
  }

  // ---------- 服务器台账 ----------

  listServers(actor: CurrentUserPayload) {
    return this.prisma.inventoryServer.findMany({
      where: this.scope(actor),
      include: {
        owner: { select: userSelect },
        creator: { select: userSelect },
        _count: { select: { projects: true, domains: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  createServer(
    actor: CurrentUserPayload,
    data: {
      name?: string;
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
    return this.prisma.inventoryServer.create({
      data: { ...this.trimServer(data), creatorId: actor.id },
    });
  }

  async updateServer(
    actor: CurrentUserPayload,
    id: string,
    data: Partial<Parameters<InventoryService['createServer']>[1]>,
  ) {
    const cur = await this.prisma.inventoryServer.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('服务器不存在');
    this.assertOwner(actor, cur.creatorId);
    return this.prisma.inventoryServer.update({ where: { id }, data: this.trimServer(data) });
  }

  async removeServer(actor: CurrentUserPayload, id: string) {
    const cur = await this.prisma.inventoryServer.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('服务器不存在');
    this.assertOwner(actor, cur.creatorId);
    return this.prisma.inventoryServer.delete({ where: { id } });
  }

  // ---------- 域名台账 ----------

  listDomains(actor: CurrentUserPayload) {
    return this.prisma.inventoryDomain.findMany({
      where: this.scope(actor),
      include: {
        owner: { select: userSelect },
        creator: { select: userSelect },
        servers: { include: { server: { select: { id: true, name: true, ip: true, label: true, provider: true } } } },
        _count: { select: { projects: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createDomain(
    actor: CurrentUserPayload,
    data: {
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
    const { serverIds, ...rest } = data;
    const allowedServers = await this.filterOwnedIds(actor, 'inventoryServer', serverIds);
    return this.prisma.$transaction(async (tx) => {
      const domain = await tx.inventoryDomain.create({
        data: {
          domain: rest.domain,
          nature: rest.nature ?? DomainNature.ENTERPRISE,
          registrar: rest.registrar ?? undefined,
          filing: rest.filing ?? undefined,
          expireAt: rest.expireAt ? new Date(rest.expireAt) : undefined,
          ownerId: rest.ownerId || undefined,
          creatorId: actor.id,
          remark: rest.remark ?? undefined,
        },
      });
      if (allowedServers.length) {
        await tx.inventoryDomainServer.createMany({
          data: allowedServers.map((serverId) => ({ domainId: domain.id, serverId })),
        });
      }
      return domain;
    });
  }

  async updateDomain(
    actor: CurrentUserPayload,
    id: string,
    data: Partial<{
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
    const cur = await this.prisma.inventoryDomain.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('域名不存在');
    this.assertOwner(actor, cur.creatorId);
    const { serverIds, ...rest } = data;
    const allowedServers =
      serverIds !== undefined
        ? await this.filterOwnedIds(actor, 'inventoryServer', serverIds)
        : undefined;
    return this.prisma.$transaction(async (tx) => {
      await tx.inventoryDomain.update({
        where: { id },
        data: {
          ...(rest.domain !== undefined ? { domain: rest.domain } : {}),
          ...(rest.nature !== undefined ? { nature: rest.nature } : {}),
          ...(rest.registrar !== undefined ? { registrar: rest.registrar } : {}),
          ...(rest.filing !== undefined ? { filing: rest.filing } : {}),
          ...(rest.expireAt !== undefined
            ? { expireAt: rest.expireAt ? new Date(rest.expireAt) : null }
            : {}),
          ...(rest.ownerId !== undefined ? { ownerId: rest.ownerId || null } : {}),
          ...(rest.remark !== undefined ? { remark: rest.remark } : {}),
        },
      });
      if (allowedServers !== undefined) {
        await tx.inventoryDomainServer.deleteMany({ where: { domainId: id } });
        if (allowedServers.length) {
          await tx.inventoryDomainServer.createMany({
            data: allowedServers.map((serverId) => ({ domainId: id, serverId })),
          });
        }
      }
      return tx.inventoryDomain.findUnique({ where: { id } });
    });
  }

  /** 单独设置域名 ↔ 服务器关联 */
  async setDomainServers(actor: CurrentUserPayload, id: string, serverIds: string[]) {
    const cur = await this.prisma.inventoryDomain.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('域名不存在');
    this.assertOwner(actor, cur.creatorId);
    const allowedServers = await this.filterOwnedIds(actor, 'inventoryServer', serverIds);
    return this.prisma.$transaction(async (tx) => {
      await tx.inventoryDomainServer.deleteMany({ where: { domainId: id } });
      if (allowedServers.length) {
        await tx.inventoryDomainServer.createMany({
          data: allowedServers.map((serverId) => ({ domainId: id, serverId })),
        });
      }
      return tx.inventoryDomain.findUnique({ where: { id } });
    });
  }

  async removeDomain(actor: CurrentUserPayload, id: string) {
    const cur = await this.prisma.inventoryDomain.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('域名不存在');
    this.assertOwner(actor, cur.creatorId);
    return this.prisma.inventoryDomain.delete({ where: { id } });
  }

  // ---------- 项目盘点条目 ----------

  listInventories(actor: CurrentUserPayload) {
    return this.prisma.projectInventory.findMany({
      where: this.scope(actor),
      include: {
        project: { select: { id: true, name: true } },
        owner: { select: userSelect },
        creator: { select: userSelect },
        servers: { include: { server: { select: { id: true, name: true, ip: true, label: true, provider: true } } } },
        domains: { include: { domain: { select: { id: true, domain: true, nature: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createInventory(
    actor: CurrentUserPayload,
    data: {
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
    const { serverIds, domainIds, projectId, ...rest } = data;
    if ((rest.githubUrl ?? '').trim() && !(rest.githubAccount ?? '').trim()) {
      throw new BadRequestException('已填写 GitHub 链接时，必须填写 GitHub 账号');
    }
    const allowedServers = await this.filterOwnedIds(actor, 'inventoryServer', serverIds);
    const allowedDomains = await this.filterOwnedIds(actor, 'inventoryDomain', domainIds);
    const scopedProject = await this.resolveProjectForActor(actor, projectId);
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.projectInventory.create({
        data: {
          title: rest.title,
          projectId: scopedProject,
          forms: rest.forms ?? [],
          websiteUrl: rest.websiteUrl ?? undefined,
          hasMiniProgram: rest.hasMiniProgram ?? false,
          miniProgramName: rest.miniProgramName ?? undefined,
          githubUrl: rest.githubUrl ?? undefined,
          githubAccount: rest.githubAccount ?? undefined,
          admin: rest.admin ?? undefined,
          ownerId: rest.ownerId || undefined,
          creatorId: actor.id,
          remark: rest.remark ?? undefined,
        },
      });
      await this.relink(tx, inv.id, allowedServers, allowedDomains);
      return inv;
    });
  }

  async updateInventory(
    actor: CurrentUserPayload,
    id: string,
    data: Partial<{
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
    const cur = await this.prisma.projectInventory.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('盘点条目不存在');
    this.assertOwner(actor, cur.creatorId);
    // GitHub 链接与账号条件必填：以「改动后的最终值」判定（本次未传则沿用库里已有值）
    const effGithubUrl = data.githubUrl !== undefined ? data.githubUrl : cur.githubUrl;
    const effGithubAccount = data.githubAccount !== undefined ? data.githubAccount : cur.githubAccount;
    if ((effGithubUrl ?? '').trim() && !(effGithubAccount ?? '').trim()) {
      throw new BadRequestException('已填写 GitHub 链接时，必须填写 GitHub 账号');
    }
    const { serverIds, domainIds, projectId, ...rest } = data;
    const allowedServers =
      serverIds !== undefined
        ? await this.filterOwnedIds(actor, 'inventoryServer', serverIds)
        : undefined;
    const allowedDomains =
      domainIds !== undefined
        ? await this.filterOwnedIds(actor, 'inventoryDomain', domainIds)
        : undefined;
    const scopedProject =
      projectId !== undefined ? await this.resolveProjectForActor(actor, projectId) : undefined;
    return this.prisma.$transaction(async (tx) => {
      await tx.projectInventory.update({
        where: { id },
        data: {
          ...(rest.title !== undefined ? { title: rest.title } : {}),
          ...(scopedProject !== undefined ? { projectId: scopedProject } : {}),
          ...(rest.forms !== undefined ? { forms: rest.forms } : {}),
          ...(rest.websiteUrl !== undefined ? { websiteUrl: rest.websiteUrl } : {}),
          ...(rest.hasMiniProgram !== undefined ? { hasMiniProgram: rest.hasMiniProgram } : {}),
          ...(rest.miniProgramName !== undefined ? { miniProgramName: rest.miniProgramName } : {}),
          ...(rest.githubUrl !== undefined ? { githubUrl: rest.githubUrl } : {}),
          ...(rest.githubAccount !== undefined ? { githubAccount: rest.githubAccount } : {}),
          ...(rest.admin !== undefined ? { admin: rest.admin } : {}),
          ...(rest.ownerId !== undefined ? { ownerId: rest.ownerId || null } : {}),
          ...(rest.remark !== undefined ? { remark: rest.remark } : {}),
        },
      });
      await this.relink(tx, id, allowedServers, allowedDomains);
      return tx.projectInventory.findUnique({ where: { id } });
    });
  }

  async removeInventory(actor: CurrentUserPayload, id: string) {
    const cur = await this.prisma.projectInventory.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('盘点条目不存在');
    this.assertOwner(actor, cur.creatorId);
    return this.prisma.projectInventory.delete({ where: { id } });
  }

  /** 可筛选的已有项目：管理员看全部；组长只看自己负责或参与的项目（含归档，排除软删除） */
  async pickableProjects(actor: CurrentUserPayload) {
    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      ...(this.isAdmin(actor)
        ? {}
        : {
            OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }],
          }),
    };
    return this.prisma.project.findMany({
      where,
      select: { id: true, name: true, archived: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 校验并返回可关联到盘点条目的 projectId：
   * 空 → null；管理员直接用；组长须在自己可盘点的项目范围内，否则忽略（落 null，避免越权关联）。
   */
  private async resolveProjectForActor(
    actor: CurrentUserPayload,
    projectId?: string | null,
  ): Promise<string | null> {
    if (!projectId) return null;
    if (this.isAdmin(actor)) return projectId;
    const allowed = await this.pickableProjects(actor);
    return allowed.some((p) => p.id === projectId) ? projectId : null;
  }

  // ---------- 内部辅助 ----------

  /** 重设盘点条目与服务器/域名的多对多关联（传 undefined 表示不改动） */
  private async relink(
    tx: Prisma.TransactionClient,
    inventoryId: string,
    serverIds?: string[],
    domainIds?: string[],
  ) {
    if (serverIds !== undefined) {
      await tx.inventoryProjectServer.deleteMany({ where: { inventoryId } });
      if (serverIds.length) {
        await tx.inventoryProjectServer.createMany({
          data: serverIds.map((serverId) => ({ inventoryId, serverId })),
        });
      }
    }
    if (domainIds !== undefined) {
      await tx.inventoryProjectDomain.deleteMany({ where: { inventoryId } });
      if (domainIds.length) {
        await tx.inventoryProjectDomain.createMany({
          data: domainIds.map((domainId) => ({ inventoryId, domainId })),
        });
      }
    }
  }

  /** 规整服务器入参：日期转 Date、空字符串负责人转 null */
  private trimServer(data: {
    name?: string;
    ip?: string;
    label?: string;
    provider?: string;
    region?: string;
    spec?: string;
    usage?: string;
    expireAt?: string | null;
    ownerId?: string | null;
    remark?: string;
  }): Prisma.InventoryServerUncheckedCreateInput & Record<string, any> {
    const out: Record<string, any> = {};
    if (data.name !== undefined) out.name = data.name;
    if (data.ip !== undefined) out.ip = data.ip;
    if (data.label !== undefined) out.label = data.label;
    if (data.provider !== undefined) out.provider = data.provider;
    if (data.region !== undefined) out.region = data.region;
    if (data.spec !== undefined) out.spec = data.spec;
    if (data.usage !== undefined) out.usage = data.usage;
    if (data.expireAt !== undefined) out.expireAt = data.expireAt ? new Date(data.expireAt) : null;
    if (data.ownerId !== undefined) out.ownerId = data.ownerId || null;
    if (data.remark !== undefined) out.remark = data.remark;
    return out as Prisma.InventoryServerUncheckedCreateInput & Record<string, any>;
  }
}
