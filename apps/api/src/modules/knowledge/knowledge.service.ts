import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DocPermission, DocVisibility, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { deptOfProjectAuthority } from '../../common/dept-authority';
import { writeAccessLog } from '../../common/access-log';

/** 文档操作人（带部门上下文，由 controller 从 JWT 载荷传入） */
export type DocUser = { id: string; role: string; departmentId?: string | null; name?: string };

/** 文档授权入参：把查看/编辑权限授予指定成员 */
export type DocShareInput = { userId: string; permission?: 'VIEW' | 'EDIT' };

@Injectable()
export class KnowledgeService {
  constructor(private prisma: PrismaService) {}

  // ---- 分类 ----

  async listCategories() {
    return this.prisma.knowledgeCategory.findMany({
      include: { _count: { select: { docs: true } } },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createCategory(name: string, projectId?: string) {
    const count = await this.prisma.knowledgeCategory.count();
    return this.prisma.knowledgeCategory.create({
      data: { name, projectId, sortOrder: count },
    });
  }

  async removeCategory(id: string) {
    return this.prisma.knowledgeCategory.delete({ where: { id } });
  }

  // ---- 文档 ----

  /**
   * 可见性过滤：
   * - 团队文档（PUBLIC）全员可见
   * - 部门文档（DEPARTMENT）本部门成员可见
   * - 项目文档（PROJECT）项目成员可见；项目主要关联部门的负责人也可见
   * - 个人文档（PRIVATE）仅作者可见，可授权他人查看
   */
  private async visibleWhere(user: DocUser): Promise<Prisma.KnowledgeDocWhereInput> {
    if (user.role === 'ADMIN') return {};
    const userId = user.id;
    return {
      OR: [
        { visibility: DocVisibility.PUBLIC },
        ...(user.departmentId
          ? [{ visibility: DocVisibility.DEPARTMENT, departmentId: user.departmentId }]
          : []),
        {
          visibility: DocVisibility.PROJECT,
          OR: [
            { project: { members: { some: { userId } } } },
            // 保密项目的知识库文档对「关联部门管理者」彻底不可见
            { project: { confidential: false, departments: deptOfProjectAuthority(userId) } },
          ],
        },
        { authorId: userId },
        { shares: { some: { userId } } },
      ],
    };
  }

  /** 文档列表（按可见性过滤，支持分类/项目/部门/关键词筛选） */
  async listDocs(
    user: DocUser,
    query?: { keyword?: string; categoryId?: string; projectId?: string; departmentId?: string },
  ) {
    const visibleWhere = await this.visibleWhere(user);
    const where: Prisma.KnowledgeDocWhereInput = {
      AND: [
        visibleWhere,
        ...(query?.categoryId ? [{ categoryId: query.categoryId }] : []),
        ...(query?.projectId ? [{ projectId: query.projectId }] : []),
        ...(query?.departmentId ? [{ departmentId: query.departmentId }] : []),
        ...(query?.keyword
          ? [
              {
                OR: [
                  { title: { contains: query.keyword } },
                  { content: { contains: query.keyword } },
                ],
              } as Prisma.KnowledgeDocWhereInput,
            ]
          : []),
      ],
    };
    const docs = await this.prisma.knowledgeDoc.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        author: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return docs;
  }

  /** 单个可见文档（含授权列表与 canEdit） */
  private async findVisibleDoc(id: string, user: DocUser) {
    const doc = await this.prisma.knowledgeDoc.findFirst({
      where: { id, AND: [await this.visibleWhere(user)] },
      include: {
        category: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, confidential: true } },
        department: { select: { id: true, name: true } },
        author: { select: { id: true, name: true } },
        shares: { include: { user: { select: { id: true, name: true } } } },
        attachments: true,
      },
    });
    // 保密项目的知识库文档：未签署保密协议一律不得阅读（管理员不受限，但会留痕）
    if (doc?.project?.confidential && user.role !== 'ADMIN') {
      const sign = await this.prisma.ndaSign.findFirst({
        where: { projectId: doc.project.id, userId: user.id },
        select: { id: true },
      });
      if (!sign) throw new ForbiddenException('请先在项目页签署保密协议');
    }
    return doc;
  }

  /** 可编辑：管理员 / 作者 / 被授权 EDIT */
  private hasEditPermission(
    doc: { authorId: string; shares: { userId: string; permission: DocPermission }[] },
    user: DocUser,
  ) {
    return (
      user.role === 'ADMIN' ||
      doc.authorId === user.id ||
      doc.shares.some((s) => s.userId === user.id && s.permission === DocPermission.EDIT)
    );
  }

  async getDoc(
    id: string,
    user: DocUser,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const doc = await this.findVisibleDoc(id, user);
    if (!doc) throw new NotFoundException('文档不存在或无权限');
    if (doc.project?.confidential) {
      // 保密项目文档阅读留痕（含管理员），写失败不阻断响应
      writeAccessLog(this.prisma, {
        userId: user.id,
        userName: user.name || user.id,
        action: 'VIEW',
        resType: 'KNOWLEDGE_DOC',
        resId: doc.id,
        resName: doc.title,
        projectId: doc.project.id,
        ip: meta?.ip,
        userAgent: meta?.userAgent,
      });
    }
    return { ...doc, canEdit: this.hasEditPermission(doc, user) };
  }

  async createDoc(
    user: DocUser,
    data: {
      title: string;
      content: string;
      categoryId?: string;
      projectId?: string;
      departmentId?: string;
      visibility?: DocVisibility;
      shares?: DocShareInput[];
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.knowledgeDoc.create({
        data: {
          title: data.title,
          content: data.content,
          categoryId: data.categoryId,
          projectId: data.projectId,
          departmentId: data.departmentId,
          visibility: data.visibility ?? DocVisibility.PUBLIC,
          authorId: user.id,
          updatedById: user.id,
          shares: {
            create: (data.shares ?? []).map((s) => ({
              userId: s.userId,
              permission: s.permission === 'EDIT' ? DocPermission.EDIT : DocPermission.VIEW,
            })),
          },
        },
      });
      await tx.knowledgeVersion.create({
        data: { docId: doc.id, version: 1, content: data.content, editorId: user.id },
      });
      return doc;
    });
  }

  /** 保存文档：内容变化时创建新版本快照；仅管理员/作者/被授权 EDIT 可编辑 */
  async updateDoc(
    id: string,
    user: DocUser,
    data: {
      title?: string;
      content?: string;
      categoryId?: string | null;
      projectId?: string | null;
      departmentId?: string | null;
      visibility?: DocVisibility;
      shares?: DocShareInput[];
    },
  ) {
    const prev = await this.prisma.knowledgeDoc.findUnique({
      where: { id },
      include: { shares: true },
    });
    if (!prev) throw new NotFoundException('文档不存在');
    if (!this.hasEditPermission(prev, user)) {
      throw new ForbiddenException('无该文档编辑权限（仅管理员/作者/被授权编辑者）');
    }
    const { shares, ...patch } = data;
    return this.prisma.$transaction(async (tx) => {
      if (shares !== undefined) {
        // 授权名单全量替换（作者本人的隐式权限不入库）
        await tx.docShare.deleteMany({ where: { docId: id } });
        const uniq = shares.filter((s) => s.userId && s.userId !== prev.authorId);
        if (uniq.length) {
          await tx.docShare.createMany({
            data: uniq.map((s) => ({
              docId: id,
              userId: s.userId,
              permission: s.permission === 'EDIT' ? DocPermission.EDIT : DocPermission.VIEW,
            })),
            skipDuplicates: true,
          });
        }
      }
      const doc = await tx.knowledgeDoc.update({
        where: { id },
        data: {
          ...patch,
          updatedById: user.id,
          version: prev.version + 1,
        },
      });
      if (data.content !== undefined && data.content !== prev.content) {
        await tx.knowledgeVersion.create({
          data: { docId: id, version: doc.version, content: data.content, editorId: user.id },
        });
      }
      return doc;
    });
  }

  /** 删除文档：仅管理员/作者 */
  async removeDoc(id: string, user: DocUser) {
    const prev = await this.prisma.knowledgeDoc.findUnique({
      where: { id },
      include: { shares: true },
    });
    if (!prev) throw new NotFoundException('文档不存在');
    if (user.role !== 'ADMIN' && prev.authorId !== user.id) {
      throw new ForbiddenException('仅文档作者或管理员可删除该文档');
    }
    return this.prisma.knowledgeDoc.delete({ where: { id } });
  }

  async versions(docId: string) {
    return this.prisma.knowledgeVersion.findMany({
      where: { docId },
      include: { editor: { select: { id: true, name: true } } },
      orderBy: { version: 'desc' },
      take: 50,
    });
  }

  async getVersion(docId: string, version: number) {
    const v = await this.prisma.knowledgeVersion.findUnique({
      where: { docId_version: { docId, version } },
    });
    if (!v) throw new NotFoundException('版本不存在');
    return v;
  }
}
