import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FileApproval, FileVisibility, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { Readable } from 'stream';
import { PrismaService } from '../../common/prisma.service';
import { deptAuthorityIds, deptOfProjectAuthority, isDeptAuthority } from '../../common/dept-authority';
import { writeAccessLog, type AccessAction } from '../../common/access-log';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { buildDocxFromHtml, docxToHtml, isEditableDocx } from './docx.util';

/** 操作人（含部门上下文，由 controller 从 JWT 载荷传入） */
export type SpaceUser = { id: string; role: string; departmentId?: string | null; name?: string };
export type SpaceScope = 'department' | 'project';
export type ConflictPolicy = 'version' | 'overwrite' | 'rename';

/** 保密文件留痕上下文：由 controller 从请求上取（inline=1 记预览，否则记下载） */
export type FileAccessMeta = { action: AccessAction; ip?: string; userAgent?: string };

type ResolvedSpace = {
  departmentId: string | null;
  projectId: string | null;
  name: string;
  canManage: boolean;
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  /** 在线编辑的 docx 上限（超出仅可下载，避免服务端内存/耗时失控） */
  private readonly maxEditBytes = 20 * 1024 * 1024;

  constructor(
    private prisma: PrismaService,
    private files: FilesService,
    private notifications: NotificationsService,
  ) {}

  // ---------------- 权限 ----------------

  /** 空间可见性：部门空间=本部门成员/该部门管理者（负责人 ∪ 共管人）/管理员；项目空间=项目成员/负责人/主要关联部门管理者/管理员 */
  async resolveSpace(user: SpaceUser, scope: SpaceScope, targetId: string): Promise<ResolvedSpace> {
    if (scope === 'department') {
      const dept = await this.prisma.department.findUnique({
        where: { id: targetId },
        select: { id: true, name: true, leaderId: true, managerIds: true },
      });
      if (!dept) throw new NotFoundException('部门不存在');
      const canManage = user.role === Role.ADMIN || isDeptAuthority(dept, user.id);
      if (!canManage && user.departmentId !== dept.id) {
        // 主部门未命中时，回退查“额外部门”成员资格（一人可属多部门）
        const extraMember = await this.prisma.user.count({
          where: { id: user.id, extraDepartments: { some: { id: dept.id } } },
        });
        if (!extraMember) throw new ForbiddenException('仅可查看本部门文档空间');
      }
      return { departmentId: dept.id, projectId: null, name: dept.name, canManage };
    }
    const project = await this.prisma.project.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        confidential: true,
        members: { select: { userId: true } },
        departments: { select: { department: { select: { id: true, leaderId: true, managerIds: true } } } },
      },
    });
    if (!project) throw new NotFoundException('项目不存在');
    const canManage = user.role === Role.ADMIN || project.ownerId === user.id;
    const isMember = project.members.some((m) => m.userId === user.id);
    // 保密项目：主要关联部门管理者不再默认可进文档空间（只认 owner + 已签协议的成员）
    const isLinkedDeptLeader =
      !project.confidential && project.departments.some((l) => isDeptAuthority(l.department, user.id));
    if (project.confidential && user.role !== Role.ADMIN && isMember) {
      const sign = await this.prisma.ndaSign.findFirst({
        where: { projectId: project.id, userId: user.id },
        select: { id: true },
      });
      if (!sign) throw new ForbiddenException('请先在项目页签署保密协议，再访问该项目文档空间');
    }
    if (!(canManage || isMember || isLinkedDeptLeader)) {
      throw new ForbiddenException('仅项目成员或主要关联部门负责人可访问该项目文档空间');
    }
    return { departmentId: null, projectId: project.id, name: project.name, canManage };
  }

  /** 单个文件的空间归属与可管理判定（管理员/空间负责人） */
  private async spaceOfFile(file: { departmentId: string | null; projectId: string | null }) {
    if (file.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: file.projectId },
        select: {
          id: true,
          name: true,
          ownerId: true,
          confidential: true,
          members: { select: { userId: true } },
          departments: { select: { department: { select: { id: true, leaderId: true, managerIds: true } } } },
        },
      });
      if (!project) return null;
      return {
        scope: 'project' as SpaceScope,
        targetId: project.id,
        name: project.name,
        // 保密项目的文件管理权收到最小：只留项目负责人（关联部门管理者不再可管）
        managers: (
          project.confidential
            ? [project.ownerId]
            : [project.ownerId, ...project.departments.flatMap((l) => deptAuthorityIds(l.department))]
        ).filter((v): v is string => !!v),
      };
    }
    if (file.departmentId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: file.departmentId },
        select: { id: true, name: true, leaderId: true, managerIds: true },
      });
      if (!dept) return null;
      return {
        scope: 'department' as SpaceScope,
        targetId: dept.id,
        name: dept.name,
        managers: deptAuthorityIds(dept),
      };
    }
    return { scope: 'department' as SpaceScope, targetId: null, name: '个人文件', managers: [] };
  }

  /** 可见性过滤：已审批的全员文件 / 本部门文件 / 可见项目的文件 / 自己上传的 */
  private visibleWhere(user: SpaceUser): Prisma.DocumentFileWhereInput {
    if (user.role === Role.ADMIN) return {};
    return {
      OR: [
        { visibility: FileVisibility.PUBLIC, approval: FileApproval.APPROVED },
        { uploaderId: user.id },
        ...(user.departmentId
          ? [{ visibility: FileVisibility.DEPARTMENT, departmentId: user.departmentId } as const]
          : []),
        {
          visibility: { in: [FileVisibility.PROJECT, FileVisibility.EXTERNAL] },
          OR: [
            { project: { members: { some: { userId: user.id } } } },
            { project: { ownerId: user.id } },
            // 保密项目的文件对「关联部门管理者」彻底不可见（不是成员就看不到）
            { project: { confidential: false, departments: deptOfProjectAuthority(user.id) } },
          ],
        },
      ],
    };
  }

  private spaceWhere(sp: ResolvedSpace): Prisma.DocumentFileWhereInput {
    return sp.projectId ? { projectId: sp.projectId } : { departmentId: sp.departmentId };
  }

  /** 文件可管理（改名/备注/可见范围/移动/删除/覆盖编辑）：管理员、上传者、空间负责人 */
  private canManageFile(file: { uploaderId: string }, user: SpaceUser, managers: string[]) {
    return (
      user.role === Role.ADMIN || file.uploaderId === user.id || managers.includes(user.id)
    );
  }

  private async findVisibleFile(id: string, user: SpaceUser) {
    const file = await this.prisma.documentFile.findFirst({
      where: { id, AND: [this.visibleWhere(user)] },
      include: {
        uploader: { select: { id: true, name: true } },
        folder: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, confidential: true } },
      },
    });
    if (!file) throw new NotFoundException('文件不存在或无权限');
    // 保密项目的文件：未签协议的成员（含 ADMIN 之外的任何人）不得预览与下载
    if (file.project?.confidential && user.role !== Role.ADMIN) {
      const inProject = file.projectId
        ? await this.prisma.project.count({
            where: {
              id: file.projectId,
              OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
            },
          })
        : 0;
      if (inProject) {
        const sign = await this.prisma.ndaSign.findFirst({
          where: { projectId: file.projectId as string, userId: user.id },
          select: { id: true },
        });
        if (!sign) throw new ForbiddenException('请先在项目页签署保密协议');
      }
    }
    return file;
  }

  /** 保密项目文件的预览/下载留痕（非保密项目一律不写；写失败不阻断响应） */
  private logFileAccess(
    user: SpaceUser,
    file: {
      id: string;
      name: string;
      projectId?: string | null;
      project?: { id: string; name: string; confidential: boolean } | null;
    },
    meta?: FileAccessMeta,
  ) {
    if (!meta || !file.project?.confidential) return;
    writeAccessLog(this.prisma, {
      userId: user.id,
      userName: user.name || user.id,
      action: meta.action,
      resType: 'DOCFILE',
      resId: file.id,
      resName: file.name,
      projectId: file.project.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ---------------- 空间浏览 ----------------

  /** 文档空间：当前层级文件夹 + 文件（含上传时间/上传者/大小/备注/可见范围/版本/可编辑与可管理标记） */
  async space(
    user: SpaceUser,
    query: { scope: SpaceScope; targetId: string; folderId?: string; keyword?: string },
  ) {
    const sp = await this.resolveSpace(user, query.scope, query.targetId);
    const keyword = query.keyword?.trim();
    const folderWhere: Prisma.DocumentFileWhereInput = keyword
      ? {}
      : { folderId: query.folderId ?? null };
    const files = await this.prisma.documentFile.findMany({
      where: {
        AND: [
          this.spaceWhere(sp),
          this.visibleWhere(user),
          folderWhere,
          ...(keyword
            ? [{ OR: [{ name: { contains: keyword } }, { note: { contains: keyword } }] } as Prisma.DocumentFileWhereInput]
            : []),
        ],
      },
      include: {
        uploader: { select: { id: true, name: true } },
        folder: { select: { id: true, name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
    });
    const folders = await this.prisma.documentFolder.findMany({
      where: { ...(sp.projectId ? { projectId: sp.projectId } : { departmentId: sp.departmentId }), parentId: keyword ? undefined : query.folderId ?? null },
      select: {
        id: true,
        name: true,
        parentId: true,
        createdAt: true,
        creator: { select: { id: true, name: true } },
        _count: { select: { files: true, children: true } },
      },
      orderBy: { name: 'asc' },
    });
    const managers = (await this.spaceOfFile({ departmentId: sp.departmentId, projectId: sp.projectId }))?.managers ?? [];
    const decorate = (f: (typeof files)[number]) => ({
      ...f,
      editable: isEditableDocx(f.name, f.mimeType),
      canManage: this.canManageFile(f, user, managers),
    });
    return {
      scope: query.scope,
      targetId: query.targetId,
      spaceName: sp.name,
      canManage: sp.canManage,
      currentFolderId: keyword ? null : query.folderId ?? null,
      folders,
      files: files.map(decorate),
    };
  }

  /** 面包屑：从给定文件夹向上回溯到空间根 */
  async breadcrumb(user: SpaceUser, folderId: string) {
    const chain: { id: string; name: string }[] = [];
    let cursor: string | null = folderId;
    while (cursor && chain.length < 20) {
      const folder = await this.prisma.documentFolder.findUnique({
        where: { id: cursor },
        select: { id: true, name: true, parentId: true },
      });
      if (!folder) break;
      chain.unshift({ id: folder.id, name: folder.name });
      cursor = folder.parentId;
    }
    return chain;
  }

  // ---------------- 文件夹 ----------------

  async createFolder(
    user: SpaceUser,
    data: { scope: SpaceScope; targetId: string; name: string; parentId?: string },
  ) {
    const sp = await this.resolveSpace(user, data.scope, data.targetId);
    const name = (data.name || '').trim();
    if (!name) throw new BadRequestException('文件夹名称必填');
    if (name.includes('/')) throw new BadRequestException('文件夹名称不能包含 /');
    if (data.parentId) await this.assertFolderInSpace(data.parentId, sp);
    const dup = await this.prisma.documentFolder.findFirst({
      where: {
        ...(sp.projectId ? { projectId: sp.projectId } : { departmentId: sp.departmentId }),
        parentId: data.parentId ?? null,
        name,
      },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('同级已有同名文件夹');
    return this.prisma.documentFolder.create({
      data: {
        name,
        parentId: data.parentId,
        creatorId: user.id,
        departmentId: sp.departmentId,
        projectId: sp.projectId,
      },
    });
  }

  async renameFolder(user: SpaceUser, id: string, name: string) {
    const folder = await this.prisma.documentFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('文件夹不存在');
    const sp = await this.resolveSpace(
      user,
      folder.projectId ? 'project' : 'department',
      (folder.projectId || folder.departmentId) as string,
    );
    if (!this.canManageFolder(folder.creatorId, user, sp)) {
      throw new ForbiddenException('仅文件夹创建者、空间负责人或管理员可重命名');
    }
    const trimmed = (name || '').trim();
    if (!trimmed) throw new BadRequestException('文件夹名称必填');
    return this.prisma.documentFolder.update({ where: { id }, data: { name: trimmed } });
  }

  async deleteFolder(user: SpaceUser, id: string) {
    const folder = await this.prisma.documentFolder.findUnique({
      where: { id },
      include: { _count: { select: { files: true, children: true } } },
    });
    if (!folder) throw new NotFoundException('文件夹不存在');
    const sp = await this.resolveSpace(
      user,
      folder.projectId ? 'project' : 'department',
      (folder.projectId || folder.departmentId) as string,
    );
    if (!this.canManageFolder(folder.creatorId, user, sp)) {
      throw new ForbiddenException('仅文件夹创建者、空间负责人或管理员可删除');
    }
    if (folder._count.files > 0 || folder._count.children > 0) {
      throw new BadRequestException('文件夹非空，请先移动或删除其中的文件与子文件夹');
    }
    return this.prisma.documentFolder.delete({ where: { id } });
  }

  private canManageFolder(creatorId: string, user: SpaceUser, sp: ResolvedSpace) {
    return user.role === Role.ADMIN || creatorId === user.id || sp.canManage;
  }

  /** 校验文件夹属于该空间（防止跨空间移动） */
  private async assertFolderInSpace(folderId: string, sp: ResolvedSpace) {
    const folder = await this.prisma.documentFolder.findUnique({
      where: { id: folderId },
      select: { id: true, projectId: true, departmentId: true },
    });
    if (!folder) throw new NotFoundException('文件夹不存在');
    if (sp.projectId && folder.projectId !== sp.projectId) {
      throw new BadRequestException('该文件夹不属于此项目空间');
    }
    if (sp.departmentId && folder.departmentId !== sp.departmentId) {
      throw new BadRequestException('该文件夹不属于此部门空间');
    }
    return folder;
  }

  // ---------------- 上传 ----------------

  /** 上传前重名探测：前端据此提示「保留版本 / 删除历史版本 / 另存为新名」 */
  async conflict(
    user: SpaceUser,
    query: { scope: SpaceScope; targetId: string; folderId?: string; name: string },
  ) {
    const sp = await this.resolveSpace(user, query.scope, query.targetId);
    const dup = await this.prisma.documentFile.findFirst({
      where: { AND: [this.spaceWhere(sp), { folderId: query.folderId ?? null, name: query.name.trim() }] },
      select: { id: true, name: true, version: true, size: true, updatedAt: true, uploader: { select: { name: true } } },
    });
    return { exists: !!dup, file: dup };
  }

  async upload(
    user: SpaceUser,
    input: {
      scope: SpaceScope;
      targetId: string;
      folderId?: string;
      name: string;
      mimeType: string;
      size: number;
      path?: string;
      buffer?: Buffer;
      visibility?: FileVisibility;
      externalPassword?: string;
      externalValidDays?: number | string;
      note?: string;
      conflict?: ConflictPolicy;
    },
  ) {
    const sp = await this.resolveSpace(user, input.scope, input.targetId);
    const name = sanitizeFileName(input.name);
    if (!name) throw new BadRequestException('文件名无效');
    const size = Number(input.size);
    if (!(size > 0)) throw new BadRequestException('空文件不可上传');
    if (input.folderId) await this.assertFolderInSpace(input.folderId, sp);

    const visibility = this.normalizeVisibility(input.visibility, sp);
    const externalPassword = await this.hashExternalPassword(visibility, input.externalPassword);
    const externalExpiresAt =
      visibility === FileVisibility.EXTERNAL ? this.computeExternalExpiresAt(input.externalValidDays) : null;
    const existing = await this.prisma.documentFile.findFirst({
      where: { AND: [this.spaceWhere(sp), { folderId: input.folderId ?? null, name }] },
    });
    const policy: ConflictPolicy = input.conflict ?? 'version';
    // 上传响应统一带上「可编辑 / 可管理」标记，前端上传后无需再请求列表即可渲染操作
    const owner = await this.spaceOfFile({ departmentId: sp.departmentId, projectId: sp.projectId });
    const managers = owner?.managers ?? [];
    const decorate = (r: { name: string; mimeType: string; uploaderId: string }) => ({
      ...r,
      editable: isEditableDocx(r.name, r.mimeType),
      canManage: this.canManageFile({ uploaderId: r.uploaderId }, user, managers),
    });

    const run = async () => {
      if (existing && policy === 'overwrite') return this.overwriteFile(user, existing, input, visibility, input.note, externalPassword, externalExpiresAt);
      if (existing && policy === 'rename') {
        const uniq = await this.uniqueName(sp, input.folderId ?? null, name);
        return this.createFile(user, sp, input, uniq, visibility, input.note, externalPassword, externalExpiresAt);
      }
      if (existing) return this.addVersion(user, existing, input, '同名重新上传');
      return this.createFile(user, sp, input, name, visibility, input.note, externalPassword, externalExpiresAt);
    };

    if (!input.path) return decorate(await run());
    try {
      return decorate(await run());
    } finally {
      // 磁盘暂存文件用完即删（由 multer diskStorage 写入）
      await unlink(input.path).catch(() => undefined);
    }
  }

  private normalizeVisibility(v: FileVisibility | undefined, sp: ResolvedSpace): FileVisibility {
    const scopeDefault = sp.projectId ? FileVisibility.PROJECT : FileVisibility.DEPARTMENT;
    if (!v || v === scopeDefault) return scopeDefault;
    if (v === FileVisibility.PRIVATE || v === FileVisibility.PUBLIC) return v;
    // 对外部可见仅适用于项目空间（需项目生成分享链接）
    if (v === FileVisibility.EXTERNAL) {
      if (!sp.projectId) throw new BadRequestException('对外部可见仅适用于项目文档空间');
      return v;
    }
    // 项目空间里不允许标为部门可见（反之亦然），避免归属与可见范围矛盾
    throw new BadRequestException('可见范围与所在空间不匹配，可选：空间内可见 / 仅自己 / 对外部可见 / 全员可见（需审批）');
  }

  /** 「对外部可见」必须设置非空访问密码并存 bcrypt hash；其他可见性返回 null */
  private async hashExternalPassword(
    visibility: FileVisibility,
    password?: string | null,
  ): Promise<string | null> {
    if (visibility !== FileVisibility.EXTERNAL) return null;
    const pwd = (password ?? '').trim();
    if (!pwd) throw new BadRequestException('设为对外部可见必须设置访问密码（至少 4 位）');
    if (pwd.length < 4) throw new BadRequestException('访问密码至少 4 位');
    return bcrypt.hash(pwd, 10);
  }

  /**
   * 计算「对外部可见」分享到期时间：validDays 默认 3 天，允许范围 1-30 天（超过则分享自动失效）。
   * 非 EXTERNAL 可见性由调用方保证不进入此方法。
   */
  private computeExternalExpiresAt(validDays?: number | string | null): Date {
    const raw = validDays === undefined || validDays === null || validDays === '' ? 3 : Number(validDays);
    if (!Number.isFinite(raw) || raw < 1 || raw > 30) {
      throw new BadRequestException('对外可见有效期需 1-30 天（默认 3 天）');
    }
    return new Date(Date.now() + Math.floor(raw) * 24 * 60 * 60 * 1000);
  }

  private async readInput(input: { path?: string; buffer?: Buffer; size: number }): Promise<Readable> {
    if (input.path) return createReadStream(input.path);
    if (input.buffer) return Readable.from(input.buffer);
    throw new BadRequestException('缺少文件内容');
  }

  private async store(name: string, mimeType: string, input: { path?: string; buffer?: Buffer; size: number }) {
    const key = this.files.buildSpaceKey(name);
    const stream = await this.readInput(input);
    try {
      await this.files.putStream(key, stream, input.size, mimeType || 'application/octet-stream');
    } catch (e) {
      await this.files.removeObject(key);
      throw e;
    }
    return key;
  }

  /** 新建文件（含 v1 版本快照），全员可见时进入待审批 */
  private async createFile(
    user: SpaceUser,
    sp: ResolvedSpace,
    input: { mimeType: string; size: number; path?: string; buffer?: Buffer; folderId?: string },
    name: string,
    visibility: FileVisibility,
    note?: string,
    externalPassword?: string | null,
    externalExpiresAt?: Date | null,
  ) {
    const mimeType = input.mimeType || guessMime(name);
    const key = await this.store(name, mimeType, input);
    const approval = visibility === FileVisibility.PUBLIC ? FileApproval.PENDING : FileApproval.NONE;
    const file = await this.prisma.documentFile.create({
      data: {
        name,
        fileKey: key,
        mimeType,
        size: input.size,
        folderId: input.folderId ?? null,
        departmentId: sp.departmentId,
        projectId: sp.projectId,
        uploaderId: user.id,
        note: note?.trim() || null,
        visibility,
        approval,
        externalPassword: externalPassword ?? null,
        externalExpiresAt: externalExpiresAt ?? null,
        version: 1,
        versions: {
          create: {
            version: 1,
            fileKey: key,
            mimeType,
            size: input.size,
            note: '首次上传',
            uploaderId: user.id,
          },
        },
      },
      include: { uploader: { select: { id: true, name: true } } },
    });
    if (approval === FileApproval.PENDING) await this.notifyAdmins(file, '待审批：文件申请全员可见');
    return { ...file, editable: isEditableDocx(file.name, file.mimeType), approval };
  }

  /** 同名保留版本：追加新版本快照，当前指针前移 */
  private async addVersion(
    user: SpaceUser,
    existing: { id: string; name: string; version: number },
    input: { mimeType: string; size: number; path?: string; buffer?: Buffer; folderId?: string },
    note?: string,
  ) {
    const mimeType = input.mimeType || guessMime(existing.name);
    const key = await this.store(existing.name, mimeType, input);
    const version = existing.version + 1;
    const file = await this.prisma.documentFile.update({
      where: { id: existing.id },
      data: {
        fileKey: key,
        mimeType,
        size: input.size,
        version,
        versions: {
          create: { version, fileKey: key, mimeType, size: input.size, note: note ?? null, uploaderId: user.id },
        },
      },
      include: { uploader: { select: { id: true, name: true } }, folder: { select: { id: true, name: true } } },
    });
    return { ...file, editable: isEditableDocx(file.name, file.mimeType) };
  }

  /** 同名删除历史版本：清掉旧版本对象与快照，内容替换为 v1 */
  private async overwriteFile(
    user: SpaceUser,
    existing: { id: string; name: string; version: number; note: string | null },
    input: { mimeType: string; size: number; path?: string; buffer?: Buffer; folderId?: string },
    visibility: FileVisibility,
    note?: string,
    externalPassword?: string | null,
    externalExpiresAt?: Date | null,
  ) {
    const oldVersions = await this.prisma.documentFileVersion.findMany({
      where: { fileId: existing.id },
      select: { fileKey: true },
    });
    const mimeType = input.mimeType || guessMime(existing.name);
    const key = await this.store(existing.name, mimeType, input);
    for (const v of oldVersions) await this.files.removeObject(v.fileKey);
    await this.prisma.documentFileVersion.deleteMany({ where: { fileId: existing.id } });
    const file = await this.prisma.documentFile.update({
      where: { id: existing.id },
      data: {
        fileKey: key,
        mimeType,
        size: input.size,
        version: 1,
        visibility,
        approval: visibility === FileVisibility.PUBLIC ? FileApproval.PENDING : FileApproval.NONE,
        externalPassword: externalPassword ?? null,
        externalExpiresAt: externalExpiresAt ?? null,
        note: note !== undefined ? note.trim() || null : existing.note,
        versions: {
          create: { version: 1, fileKey: key, mimeType, size: input.size, note: '覆盖上传（历史版本已删除）', uploaderId: user.id },
        },
      },
      include: { uploader: { select: { id: true, name: true } } },
    });
    if (file.approval === FileApproval.PENDING) await this.notifyAdmins(file, '待审批：文件申请全员可见');
    return { ...file, editable: isEditableDocx(file.name, file.mimeType) };
  }

  private async uniqueName(sp: ResolvedSpace, folderId: string | null, name: string) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let i = 2; i <= 50; i++) {
      const dup = await this.prisma.documentFile.findFirst({
        where: { AND: [this.spaceWhere(sp), { folderId, name: candidate }] },
        select: { id: true },
      });
      if (!dup) return candidate;
      candidate = `${base}(${i})${ext}`;
    }
    throw new BadRequestException('重名文件过多，请换个文件名');
  }

  // ---------------- 下载 / 预览 ----------------

  /** 下载代理（MinIO 浏览器侧不可达，统一走 API 流式输出） */
  async content(user: SpaceUser, id: string, meta?: FileAccessMeta) {
    const file = await this.findVisibleFile(id, user);
    const stream = await this.files.getStream(file.fileKey);
    if (!stream) throw new NotFoundException('文件内容不存在或对象存储不可用');
    this.logFileAccess(user, file, meta);
    return { stream, name: file.name, mimeType: file.mimeType, size: file.size, version: file.version };
  }

  /** 指定历史版本下载 */
  async versionContent(user: SpaceUser, id: string, version: number, meta?: FileAccessMeta) {
    const file = await this.findVisibleFile(id, user);
    const v = await this.prisma.documentFileVersion.findUnique({
      where: { fileId_version: { fileId: id, version } },
    });
    if (!v) throw new NotFoundException('版本不存在');
    const stream = await this.files.getStream(v.fileKey);
    if (!stream) throw new NotFoundException('版本内容不存在或对象存储不可用');
    this.logFileAccess(user, file, meta);
    return { stream, name: file.name, mimeType: v.mimeType, size: v.size, version };
  }

  // ---------------- 编辑元信息 ----------------

  async patchFile(
    user: SpaceUser,
    id: string,
    data: {
      name?: string;
      note?: string | null;
      visibility?: FileVisibility;
      externalPassword?: string;
      externalValidDays?: number | string | null;
      folderId?: string | null;
    },
  ) {
    const file = await this.findVisibleFile(id, user);
    const owner = await this.spaceOfFile({ departmentId: file.departmentId, projectId: file.projectId });
    const sp = owner?.targetId
      ? await this.resolveSpace(user, owner.scope, owner.targetId)
      : ({ departmentId: file.departmentId, projectId: file.projectId, name: file.name, canManage: false } as ResolvedSpace);
    if (!this.canManageFile(file, user, owner?.managers ?? [])) {
      throw new ForbiddenException('仅上传者、空间负责人或管理员可修改该文件');
    }
    const patch: Prisma.DocumentFileUpdateInput = {};
    if (data.name !== undefined) {
      const name = sanitizeFileName(data.name);
      if (!name) throw new BadRequestException('文件名无效');
      if (name !== file.name) {
        const dup = await this.prisma.documentFile.findFirst({
          where: {
            AND: [
              file.projectId ? { projectId: file.projectId } : { departmentId: file.departmentId },
              { folderId: file.folderId, name, NOT: { id } },
            ],
          },
          select: { id: true },
        });
        if (dup) throw new BadRequestException('同目录已有同名文件');
      }
      patch.name = name;
    }
    if (data.note !== undefined) patch.note = data.note?.trim() || null;
    if (data.folderId !== undefined) {
      if (data.folderId === null) {
        patch.folder = { disconnect: true };
      } else {
        await this.assertFolderInSpace(data.folderId, sp);
        patch.folder = { connect: { id: data.folderId } };
      }
    }
    if (data.visibility !== undefined) {
      const visibility = this.normalizeVisibility(data.visibility, sp);
      if (visibility !== file.visibility) {
        patch.visibility = visibility;
        patch.approval = visibility === FileVisibility.PUBLIC ? FileApproval.PENDING : FileApproval.NONE;
        patch.reviewNote = null;
        patch.reviewedAt = null;
        patch.reviewedBy = { disconnect: true };
      }
      // 对外部可见：进入时必带密码，离开时清空密码；已为 EXTERNAL 且未传新密码则保持原密码不变
      if (visibility === FileVisibility.EXTERNAL) {
        if (data.externalPassword?.trim()) {
          patch.externalPassword = await this.hashExternalPassword(visibility, data.externalPassword);
        } else if (file.visibility !== FileVisibility.EXTERNAL) {
          // 首次设为对外可见必须设置密码（为空时 hashExternalPassword 抛错）
          patch.externalPassword = await this.hashExternalPassword(visibility, data.externalPassword);
        }
        // 有效期：传了天数就重算；首次进入且未传则默认 3 天；已 EXTERNAL 且未传则保持原到期时间
        const daysProvided =
          data.externalValidDays !== undefined && data.externalValidDays !== null && `${data.externalValidDays}` !== '';
        if (daysProvided) {
          patch.externalExpiresAt = this.computeExternalExpiresAt(data.externalValidDays);
        } else if (file.visibility !== FileVisibility.EXTERNAL) {
          patch.externalExpiresAt = this.computeExternalExpiresAt(3);
        }
      } else if (file.visibility === FileVisibility.EXTERNAL) {
        patch.externalPassword = null;
        patch.externalExpiresAt = null;
      }
    }
    const saved = await this.prisma.documentFile.update({
      where: { id },
      data: patch,
      include: { uploader: { select: { id: true, name: true } }, folder: { select: { id: true, name: true } } },
    });
    if (saved.approval === FileApproval.PENDING && file.approval !== FileApproval.PENDING) {
      await this.notifyAdmins(saved, '待审批：文件申请全员可见');
    }
    return { ...saved, editable: isEditableDocx(saved.name, saved.mimeType) };
  }

  async removeFile(user: SpaceUser, id: string) {
    const file = await this.findVisibleFile(id, user);
    const owner = await this.spaceOfFile({ departmentId: file.departmentId, projectId: file.projectId });
    if (!this.canManageFile(file, user, owner?.managers ?? [])) {
      throw new ForbiddenException('仅上传者、空间负责人或管理员可删除该文件');
    }
    const rows = await this.prisma.documentFileVersion.findMany({
      where: { fileId: id },
      select: { fileKey: true },
    });
    const keys = new Set<string>([file.fileKey, ...rows.map((r) => r.fileKey)]);
    await this.prisma.documentFile.delete({ where: { id } });
    for (const key of keys) await this.files.removeObject(key);
    return { ok: true };
  }

  // ---------------- 版本 ----------------

  async listVersions(user: SpaceUser, id: string) {
    const file = await this.findVisibleFile(id, user);
    const owner = await this.spaceOfFile({ departmentId: file.departmentId, projectId: file.projectId });
    const versions = await this.prisma.documentFileVersion.findMany({
      where: { fileId: id },
      include: { uploader: { select: { id: true, name: true } } },
      orderBy: { version: 'desc' },
      take: 100,
    });
    return {
      current: file.version,
      canManage: this.canManageFile(file, user, owner?.managers ?? []),
      versions,
    };
  }

  /** 删除历史版本（不可删当前版本，当前内容始终保留） */
  async removeVersion(user: SpaceUser, id: string, version: number) {
    const file = await this.findVisibleFile(id, user);
    const owner = await this.spaceOfFile({ departmentId: file.departmentId, projectId: file.projectId });
    if (!this.canManageFile(file, user, owner?.managers ?? [])) {
      throw new ForbiddenException('仅上传者、空间负责人或管理员可删除版本');
    }
    if (version === file.version) throw new BadRequestException('当前版本不可删除');
    const v = await this.prisma.documentFileVersion.findUnique({
      where: { fileId_version: { fileId: id, version } },
    });
    if (!v) throw new NotFoundException('版本不存在');
    await this.prisma.documentFileVersion.delete({ where: { id: v.id } });
    if (v.fileKey !== file.fileKey) await this.files.removeObject(v.fileKey);
    return { ok: true };
  }

  // ---------------- docx 在线编辑 ----------------

  /** 读取 docx 为可编辑 HTML（mammoth 解析；图片以 data URI 内联） */
  async editableHtml(user: SpaceUser, id: string) {
    const file = await this.findVisibleFile(id, user);
    if (!isEditableDocx(file.name, file.mimeType)) {
      throw new BadRequestException('仅 .docx 文档支持在线编辑，其他格式请下载后编辑再上传');
    }
    if (file.size > this.maxEditBytes) {
      throw new BadRequestException('文档过大（超过 20MB），请下载后编辑再上传');
    }
    const buf = await this.files.download(file.fileKey);
    if (!buf) throw new NotFoundException('文件内容不存在或对象存储不可用');
    const { html, messages } = await docxToHtml(buf);
    const owner = await this.spaceOfFile({ departmentId: file.departmentId, projectId: file.projectId });
    return {
      file: {
        id: file.id,
        name: file.name,
        version: file.version,
        size: file.size,
        updatedAt: file.updatedAt,
      },
      canEdit: this.canManageFile(file, user, owner?.managers ?? []),
      html,
      warnings: messages,
    };
  }

  /** 保存在线编辑：HTML 重新生成 docx 并作为新版本归档 */
  async saveEditable(user: SpaceUser, id: string, html: string, note?: string) {
    const file = await this.findVisibleFile(id, user);
    const owner = await this.spaceOfFile({ departmentId: file.departmentId, projectId: file.projectId });
    if (!this.canManageFile(file, user, owner?.managers ?? [])) {
      throw new ForbiddenException('仅上传者、空间负责人或管理员可编辑该文档');
    }
    if (!isEditableDocx(file.name, file.mimeType)) throw new BadRequestException('仅 .docx 文档支持在线编辑');
    const buffer = buildDocxFromHtml(html || '<p></p>', { title: file.name });
    const key = this.files.buildSpaceKey(file.name);
    await this.files.putStream(key, Readable.from(buffer), buffer.length, DOCX_MIME);
    const version = file.version + 1;
    try {
      const saved = await this.prisma.documentFile.update({
        where: { id },
        data: {
          fileKey: key,
          mimeType: DOCX_MIME,
          size: buffer.length,
          version,
          versions: {
            create: {
              version,
              fileKey: key,
              mimeType: DOCX_MIME,
              size: buffer.length,
              note: note?.trim() || '在线编辑保存',
              uploaderId: user.id,
            },
          },
        },
        include: { uploader: { select: { id: true, name: true } }, folder: { select: { id: true, name: true } } },
      });
      return { ...saved, editable: true };
    } catch (e) {
      // 元数据写入失败时清掉孤立对象，避免垃圾文件
      await this.files.removeObject(key);
      throw e;
    }
  }

  // ---------------- 全员可见审批 ----------------

  /** 待审批/已审批列表（仅管理员） */
  async approvals(user: SpaceUser, status?: FileApproval) {
    if (user.role !== Role.ADMIN) throw new ForbiddenException('仅管理员可查看审批列表');
    const where: Prisma.DocumentFileWhereInput = {
      approval: status && status !== FileApproval.NONE ? status : FileApproval.PENDING,
    };
    const [list, pending] = await Promise.all([
      this.prisma.documentFile.findMany({
        where,
        include: {
          uploader: { select: { id: true, name: true, department: { select: { id: true, name: true } } } },
          reviewedBy: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      this.prisma.documentFile.count({ where: { approval: FileApproval.PENDING } }),
    ]);
    return { pending, files: list };
  }

  /** 审批（仅管理员）：同意后全员可见生效，驳回则维持受限可见并通知上传者 */
  async review(user: SpaceUser, id: string, decision: 'APPROVE' | 'REJECT', note?: string) {
    if (user.role !== Role.ADMIN) throw new ForbiddenException('仅管理员可审批');
    const file = await this.prisma.documentFile.findUnique({
      where: { id },
      include: { uploader: { select: { id: true, name: true } } },
    });
    if (!file) throw new NotFoundException('文件不存在');
    if (file.approval !== FileApproval.PENDING) throw new BadRequestException('该文件不在待审批状态');
    const approval = decision === 'APPROVE' ? FileApproval.APPROVED : FileApproval.REJECTED;
    const saved = await this.prisma.documentFile.update({
      where: { id },
      data: {
        approval,
        visibility: decision === 'APPROVE' ? FileVisibility.PUBLIC : file.visibility === FileVisibility.PUBLIC ? FileVisibility.PRIVATE : file.visibility,
        reviewNote: note?.trim() || null,
        reviewedById: user.id,
        reviewedAt: new Date(),
      },
      include: { uploader: { select: { id: true, name: true } } },
    });
    await this.notifications.create(saved.uploaderId, {
      type: 'SYSTEM',
      title: approval === FileApproval.APPROVED ? `全员共享已同意：${saved.name}` : `全员共享被驳回：${saved.name}`,
      content: note?.trim() || (approval === FileApproval.APPROVED ? '该文件现已对全员可见' : '该文件仍按原范围可见，可修改可见范围后再申请'),
      link: saved.projectId ? `/projects/${saved.projectId}` : saved.departmentId ? `/departments?id=${saved.departmentId}` : '/knowledge',
    });
    return saved;
  }

  private async notifyAdmins(file: { id: string; name: string; uploaderId: string }, title: string) {
    try {
      const admins = await this.prisma.user.findMany({ where: { role: Role.ADMIN, active: true }, select: { id: true } });
      await this.notifications.createMany(admins.map((a) => a.id), {
        type: 'SYSTEM',
        title: `${title}：${file.name}`,
        content: '请到「管理后台 - 文档审批」处理',
        link: '/admin?tab=approvals',
      });
    } catch (e) {
      this.logger.warn(`审批通知发送失败：${(e as Error).message}`);
    }
  }

  // ---------------- 对外部可见（游客分享页，免登录） ----------------

  /** 分享页项目基础信息：仅暴露名称与对外文件数，校验项目存在且未归档 */
  async publicProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, archived: true },
    });
    if (!project || project.archived) throw new NotFoundException('项目不存在或已归档');
    const externalCount = await this.prisma.documentFile.count({
      where: { projectId, visibility: FileVisibility.EXTERNAL, externalExpiresAt: { gt: new Date() } },
    });
    return { id: project.id, name: project.name, externalCount };
  }

  /** 校验访问密码，返回该项目中密码匹配的「对外部可见」文件列表（逐个 bcrypt 比对） */
  async matchExternalFiles(projectId: string, password: string) {
    const pwd = (password ?? '').trim();
    if (!pwd) return { total: 0, files: [] };
    const candidates = await this.prisma.documentFile.findMany({
      where: {
        projectId,
        visibility: FileVisibility.EXTERNAL,
        externalPassword: { not: null },
        externalExpiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        note: true,
        version: true,
        updatedAt: true,
        externalExpiresAt: true,
        externalPassword: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    const files: Omit<(typeof candidates)[number], 'externalPassword'>[] = [];
    for (const f of candidates) {
      if (f.externalPassword && (await bcrypt.compare(pwd, f.externalPassword))) {
        const { externalPassword: _omit, ...rest } = f;
        files.push(rest);
      }
    }
    return { total: files.length, files };
  }

  /**
   * 全局访客入口：在所有项目中找出「对外部可见」且密码匹配的文件（逐个 bcrypt 比对）。
   * 与按项目匹配不同，这里不带 projectId，登录页访客只输密码即可；返回项附带所属项目名。
   * 注意：若不同项目使用了相同密码，会一并展示（设计如此）。
   */
  async searchExternalByPassword(password: string) {
    const pwd = (password ?? '').trim();
    if (!pwd) return { total: 0, files: [] };
    const candidates = await this.prisma.documentFile.findMany({
      where: {
        visibility: FileVisibility.EXTERNAL,
        externalPassword: { not: null },
        externalExpiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        note: true,
        version: true,
        updatedAt: true,
        externalExpiresAt: true,
        externalPassword: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    const files: Omit<(typeof candidates)[number], 'externalPassword'>[] = [];
    for (const f of candidates) {
      if (f.externalPassword && (await bcrypt.compare(pwd, f.externalPassword))) {
        const { externalPassword: _omit, ...rest } = f;
        files.push(rest);
      }
    }
    return { total: files.length, files };
  }

  /** 游客下载：校验文件为对外可见且密码匹配后返回内容流 */
  async publicContent(fileId: string, password: string) {
    const file = await this.prisma.documentFile.findUnique({ where: { id: fileId } });
    if (!file || file.visibility !== FileVisibility.EXTERNAL || !file.externalPassword) {
      throw new NotFoundException('文件不存在或未对外开放');
    }
    if (!password || !(await bcrypt.compare(password, file.externalPassword))) {
      throw new ForbiddenException('访问密码错误');
    }
    if (!file.externalExpiresAt || file.externalExpiresAt <= new Date()) {
      throw new NotFoundException('分享链接已过期或不存在');
    }
    const stream = await this.files.getStream(file.fileKey);
    if (!stream) throw new NotFoundException('文件内容不存在或对象存储不可用');
    return { stream, name: file.name, mimeType: file.mimeType, size: file.size, version: file.version };
  }
}

/** 文件名清洗：去路径、控制字符，并把 multer/busboy 以 latin1 解出的中文名还原为 UTF-8 */
export function sanitizeFileName(raw: string) {
  const base = (raw || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  if (!cleaned) return '';
  // 典型 mojibake：包含带重音的拉丁扩展字符且不含 CJK，尝试按 latin1 -> utf8 还原
  const looksMojibake = /[À-ÿÐÞß-ÿ]/.test(cleaned) && !/[\u4e00-\u9fa5]/.test(cleaned);
  if (looksMojibake) {
    const restored = Buffer.from(cleaned, 'latin1').toString('utf8');
    if (!restored.includes('\uFFFD')) return restored;
  }
  return cleaned.slice(0, 180);
}

const MIME_BY_EXT: Record<string, string> = {
  docx: DOCX_MIME,
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  stl: 'model/stl',
  mp4: 'video/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
};

function guessMime(name: string) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
