import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { ledDeptWhere, pickDefaultManager } from '../../common/dept-authority';
import { nextEmployeeNo } from '../../common/employee-no';

/** 管理员创建用户的默认初始密码（首次登录强制修改） */
export const DEFAULT_USER_PASSWORD = 'Org123456';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async list() {
    // 管理后台需看到全部用户（含已禁用），active/username/phone 字段必须返回供前端展示与编辑
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        phone: true,
        employeeNo: true, // 工号：按注册时间顺序，列表右侧直接展示
        avatar: true,
        role: true,
        departmentId: true,
        // 人员列表要能一眼看出「一人属于哪几个部门 + 向谁汇报」，所以部门与上级都带名字返回（只返回 id 前端得再查一轮）
        // 额外带主部门的负责人/共管人，供「未设置汇报对象」时实时算默认展示（口径与回填/汇报树一致）
        department: { select: { id: true, name: true, leaderId: true, managerIds: true } },
        extraDepartments: { select: { id: true, name: true } }, // 额外加入的部门（主部门之外）
        reportsToId: true,
        reportsTo: { select: { id: true, name: true } },
        active: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    // 汇报对象兜底展示：未手动设置上级的成员，按「主部门负责人(含共管人) → 在职管理员」实时算默认，供「汇报给」列占位（回填后一般已有 reportsToId，本字段仅兜底）
    const activeSet = new Set(users.filter((u) => u.active).map((u) => u.id));
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const adminIds = users.filter((u) => u.active && u.role === 'ADMIN').map((u) => u.id);
    return users.map((u) => {
      const defId = u.reportsToId ? null : pickDefaultManager(u.id, u.role, u.department, adminIds, (id) => activeSet.has(id));
      return { ...u, defaultReportsToId: defId, defaultReportsToName: defId ? nameById.get(defId) ?? null : null };
    });
  }

  async me(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        phone: true,
        avatar: true,
        role: true,
        departmentId: true,
        mustChangePassword: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  async updateProfile(id: string, data: { name?: string; avatar?: string }) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        role: true,
      },
    });
  }

  /**
   * 管理员调整全局角色（权限上限），并与部门/项目归属做一致性校验：
   * - DEPT_LEADER 必须是某部门负责人或共管人；PROJECT_LEADER 必须是某项目负责人
   * - 降为 MEMBER 时，若仍领导部门（含共管）或负责项目则拒绝（应先取消对应归属）
   */
  async updateRole(id: string, role: 'ADMIN' | 'DEPT_LEADER' | 'PROJECT_LEADER' | 'MEMBER') {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('用户不存在');
    if (role === 'DEPT_LEADER') {
      const leading = await this.prisma.department.count({ where: ledDeptWhere(id) });
      if (!leading) throw new BadRequestException('该用户不是任何部门的管理者，请先在部门管理中指定负责人或共管人');
    } else if (role === 'PROJECT_LEADER') {
      const owning = await this.prisma.project.count({ where: { ownerId: id, archived: false } });
      if (!owning) throw new BadRequestException('该用户不是任何项目负责人，请先创建或接手项目');
    } else if (role === 'MEMBER') {
      const [leading, owning] = await Promise.all([
        this.prisma.department.count({ where: ledDeptWhere(id) }),
        this.prisma.project.count({ where: { ownerId: id, archived: false } }),
      ]);
      if (leading > 0) throw new BadRequestException('该用户仍是部门负责人或共管人，请先在部门管理中取消其管理');
      if (owning > 0) throw new BadRequestException('该用户仍负责项目，请先转让其负责的项目');
    }
    return this.prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, name: true, role: true },
    });
  }

  async toggleActive(id: string, active: boolean) {
    return this.prisma.user.update({
      where: { id },
      data: { active },
      select: { id: true, name: true, active: true },
    });
  }

  /** 管理员创建用户：用户名/手机号必填；邮箱用 {username}@local.myorgniz 占位；默认密码 + 首次登录强制改密 */
  async createByAdmin(data: { username: string; name: string; phone: string; departmentId?: string | null; additionalDepartmentIds?: string[] }) {
    const username = data.username.trim();
    const phone = data.phone?.trim();
    if (!phone) throw new BadRequestException('手机号必填');
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) throw new ConflictException('用户名已存在');
    const email = `${username}@local.myorgniz`;
    const emailExists = await this.prisma.user.findUnique({ where: { email } });
    if (emailExists) throw new ConflictException('用户名已存在');
    const departmentId = data.departmentId || null;
    const extras = this.normalizeExtras(data.additionalDepartmentIds, departmentId);
    const user = await this.prisma.user.create({
      data: {
        username,
        name: data.name.trim(),
        phone,
        email,
        employeeNo: await nextEmployeeNo(this.prisma),
        password: await bcrypt.hash(DEFAULT_USER_PASSWORD, 10),
        role: 'MEMBER',
        departmentId,
        active: true,
        mustChangePassword: true,
        extraDepartments: { connect: extras.map((id) => ({ id })) },
      },
      select: { id: true, username: true, name: true, phone: true, email: true, employeeNo: true, role: true, departmentId: true, active: true, createdAt: true, extraDepartments: { select: { id: true } } },
    });
    return user;
  }

  /** 归一化额外部门：去重、排除主部门（主部门不应同时作为额外部门） */
  private normalizeExtras(ids: string[] | undefined, primaryId: string | null): string[] {
    if (!Array.isArray(ids)) return [];
    const uniq = [...new Set(ids.map((s) => String(s || '').trim()).filter(Boolean))];
    return primaryId ? uniq.filter((d) => d !== primaryId) : uniq;
  }

  /** 管理员编辑用户资料：用户名唯一；管理员创建用户的占位邮箱随用户名同步更新 */
  async updateByAdmin(id: string, data: { username?: string; name?: string; phone?: string; departmentId?: string | null; additionalDepartmentIds?: string[] }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    const patch: { username?: string; email?: string; name?: string; phone?: string | null; departmentId?: string | null } = {};
    if (data.username !== undefined) {
      const username = data.username.trim();
      const dup = await this.prisma.user.findFirst({ where: { username, NOT: { id } } });
      if (dup) throw new ConflictException('用户名已存在');
      patch.username = username;
      // 管理员创建的用户 email 为 {username}@local.myorgniz 占位，随用户名同步
      if (user.username && user.email === `${user.username}@local.myorgniz`) {
        patch.email = `${username}@local.myorgniz`;
      }
    }
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.phone !== undefined) patch.phone = data.phone?.trim() || null;
    if (data.departmentId !== undefined) patch.departmentId = data.departmentId || null;
    // 额外部门（多对多）：仅当显式传入时 set（去重 + 排除主部门）；否则不动
    const updateData: typeof patch & { extraDepartments?: { set: { id: string }[] } } = { ...patch };
    if (data.additionalDepartmentIds !== undefined) {
      const extras = this.normalizeExtras(data.additionalDepartmentIds, patch.departmentId ?? user.departmentId ?? null);
      updateData.extraDepartments = { set: extras.map((id) => ({ id })) };
    }
    return this.prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, username: true, name: true, phone: true, email: true, employeeNo: true, role: true, departmentId: true, active: true, createdAt: true, extraDepartments: { select: { id: true } } },
    });
  }

  /** 管理员重置用户密码：重置为默认初始密码并强制下次登录改密（不能重置自己） */
  async resetPasswordByAdmin(operatorId: string, id: string) {
    if (operatorId === id) throw new BadRequestException('不能重置当前登录账号的密码');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    return this.prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(DEFAULT_USER_PASSWORD, 10), mustChangePassword: true },
      select: { id: true, username: true, name: true, role: true, active: true },
    });
  }

  /**
   * 管理员删除用户：可删除任意用户。
   * 团队共享数据（其负责的项目/创建的任务/上传附件/知识文档/公告/复盘/SOP 等）转移给操作管理员保留；
   * 个人痕迹（身份绑定/成员关系/通知/日报/评论/任务动态/复盘提交/预约等）随 Cascade 删除。
   */
  async deleteByAdmin(operatorId: string, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    try {
      return await this.prisma.$transaction(async (tx) => {
        // ---- 转移团队共享数据（Restrict FK：项目归属/任务创建/附件上传/文档作者等） ----
        const [tProjects, tTasks, tAttachments, tDocs, tDocVersions, tAnn, tRetro, tSop, tFiles, tFileVersions, tFolders] = await Promise.all([
          tx.project.updateMany({ where: { ownerId: id }, data: { ownerId: operatorId } }),
          tx.task.updateMany({ where: { creatorId: id }, data: { creatorId: operatorId } }),
          tx.attachment.updateMany({ where: { uploaderId: id }, data: { uploaderId: operatorId } }),
          tx.knowledgeDoc.updateMany({ where: { authorId: id }, data: { authorId: operatorId } }),
          // 其编辑过的文档历史版本一并转移，避免随账号 Cascade 误删团队文档快照
          tx.knowledgeVersion.updateMany({ where: { editorId: id }, data: { editorId: operatorId } }),
          tx.announcement.updateMany({ where: { authorId: id }, data: { authorId: operatorId } }),
          tx.projectRetro.updateMany({ where: { createdById: id }, data: { createdById: operatorId } }),
          // 其触发的 SOP 转移给操作管理员，保住团队经验库（proposerId 非空不可置空）
          tx.sop.updateMany({ where: { proposerId: id }, data: { proposerId: operatorId } }),
          // 文档空间（上传文件/版本快照/文件夹）转移给操作管理员，避免随账号 Cascade 删除团队文件
          tx.documentFile.updateMany({ where: { uploaderId: id }, data: { uploaderId: operatorId } }),
          tx.documentFileVersion.updateMany({ where: { uploaderId: id }, data: { uploaderId: operatorId } }),
          tx.documentFolder.updateMany({ where: { creatorId: id }, data: { creatorId: operatorId } }),
        ]);
        // 其余关联（身份/成员/通知/日报/评论/任务动态/复盘提交/预约/资讯订阅等）按 schema Cascade/SetNull 自动清理
        await tx.user.delete({ where: { id } });
        return {
          ok: true,
          transferred: {
            projects: tProjects.count,
            tasks: tTasks.count,
            attachments: tAttachments.count,
            docs: tDocs.count + tDocVersions.count,
            announcements: tAnn.count,
            retros: tRetro.count,
            sops: tSop.count,
            files: tFiles.count + tFileVersions.count,
            folders: tFolders.count,
          },
        };
      });
    } catch (e: any) {
      if (e?.code === 'P2003') {
        throw new BadRequestException('该用户仍存在无法转移的关联数据，删除失败');
      }
      throw e;
    }
  }
}
