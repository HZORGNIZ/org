import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType, ProjectStatus, Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { deptAuthorityIds, deptOfProjectAuthority, ledDeptWhere } from '../../common/dept-authority';
import { isSelfDigestMessage } from '../../common/self-digest';
import { writeAccessLog } from '../../common/access-log';
import { CN_OFFSET_MS, beijingMondayOf, beijingMondayDate, isoWeekOf, cnWeekLabel } from '../../common/beijing-time';
import { AiService } from '../ai/ai.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DingtalkFetchService } from '../integrations/dingtalk-fetch.service';
import { DailyDigestService } from '../integrations/daily-digest.service';
import { ProgressQueue } from './progress-queue.service';

/** 新建项目时可选的时间计划与需求文档载荷（首页录入、直接建项目两个入口共用） */
export interface ProjectCreatePayload {
  name: string;
  description?: string;
  color?: string;
  departmentIds?: string[];
  dingtalkConversationId?: string | null;
  dingtalkGroupName?: string | null;
  dailyDigestEnabled?: boolean;
  digestTime?: string;
  digestEveryDays?: number;
  startDate?: string | null; // 'YYYY-MM-DD'（北京墙钟日期）
  endDate?: string | null;
  requirementDocIds?: string[];
  milestones?: { name: string; dueDate: string; description?: string | null }[];
  skipMilestone?: boolean; // 创建人确认「本项目确定不需要里程碑」
  skipRequirementDoc?: boolean; // 创建人确认「本项目确定不需要需求文档」
}

/** 保密协议默认正文（首次使用时落为 v1；管理员可在系统设置里改写，改写即升版本号） */
const NDA_DEFAULT = `# 项目保密协议

本人在加入保密项目前，已完整阅读并理解以下条款：

## 一、保密信息范围

本项目项下的全部信息均属保密信息，包括但不限于：项目立项与审批材料、需求文档与设计方案、看板任务与排期、群聊进展与会议纪要、成员名单与分工、以及任何标注为内部数据的资料与其载体形式。

## 二、保密义务

1. 不以任何方式向本项目成员以外的任何个人或组织披露、转述、展示或传播保密信息；
2. 不复制、下载、截屏、外传保密信息至个人设备、私人网盘、外部邮箱或第三方工具；
3. 不在公司外部群聊、公开社区、社交媒体及对外分享材料中引用保密信息；
4. 发现保密信息可能泄露时，第一时间告知项目负责人或系统管理员。

## 三、保密期限

保密义务自本人签署本协议时生效，不因项目结束、岗位调整或本人离开项目而解除；直至该项目被取消保密标记，或相关信息已由权利人公开为止。

## 四、违约责任

本人违反上述条款的，同意接受公司的内部处理（含暂停项目权限、解除合作或劳动关系），并承担由此给公司造成的损失及相应法律责任。

## 五、确认

本人已完整阅读本协议全部条款，理解其含义，自愿遵守，并对点击确认后所产生的签署记录（签署人、签署时间、协议版本）予以认可。
`;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private notifications: NotificationsService,
    private fetch: DingtalkFetchService,
    private progressQueue: ProgressQueue,
    private digest: DailyDigestService,
  ) {}

  /** 可见项目过滤：
   * - ADMIN 全局可见（含 PENDING/REJECTED，便于兵底审批；保密项目照常可见，但进入详情会写访问留痕）
   * - 非 ADMIN：
   *   a) ACTIVE 项目沿原口径（owner / 项目成员 / 主要关联部门负责人）
   *   b) 自己创建的项目不限状态（PENDING/REJECTED 也可进入详情看审批进展）
   *   c) 自己为审批人的项目不限状态
   * 保密项目只认「owner + 项目成员」：上面 a) 里的部门负责人分支对 confidential 项目失效，
   * 首页进展示也因此一并收紧（myUpdates 复用本过滤）。
   */
  private visFilter(userId: string, role: string) {
    if (role === Role.ADMIN) return { deletedAt: null };
    return {
      deletedAt: null,
      OR: [
        { status: ProjectStatus.ACTIVE, ownerId: userId },
        { status: ProjectStatus.ACTIVE, members: { some: { userId } } },
        { status: ProjectStatus.ACTIVE, confidential: false, departments: deptOfProjectAuthority(userId) },
        { ownerId: userId },
        { approverId: userId },
        { coReviews: { some: { reviewerId: userId } } },
      ],
    };
  }

  /** 把 ProjectDepartment 连接记录压平为部门数组（前端直接用 p.departments = [{id,name}]） */
  private flatten(p: any) {
    if (Array.isArray(p.departments)) {
      p.departments = p.departments.map((l: any) => l.department).filter(Boolean);
    }
    // 加签人压平：reviewer 只留 id/name，前端直接渲染名单与状态
    if (Array.isArray(p.coReviews)) {
      p.coReviews = p.coReviews.map((c: any) => ({
        id: c.id,
        status: c.status,
        note: c.note,
        decidedAt: c.decidedAt,
        createdAt: c.createdAt,
        reviewer: c.reviewer ? { id: c.reviewer.id, name: c.reviewer.name } : null,
      }));
    }
    return p;
  }

  /** 立项确认强制项：里程碑与需求文档默认必填，只有创建人显式勾选「确定不需要」才豁免 */
  private assertKickoffConfirmations(opts: {
    milestoneCount: number;
    docCount: number;
    skipMilestone?: boolean;
    skipRequirementDoc?: boolean;
  }) {
    if (!opts.skipMilestone && opts.milestoneCount === 0) {
      throw new BadRequestException('请填写至少一个里程碑；确实不需要请勾选「本项目确定不需要里程碑」');
    }
    if (!opts.skipRequirementDoc && opts.docCount === 0) {
      throw new BadRequestException('请上传项目需求文档；确实不需要请勾选「本项目确定不需要需求文档」');
    }
  }

  /** 某人在给定项目里已签署保密协议的 projectId 集合（保密内容可见性的唯一判定依据） */
  private async signedNdaIds(userId: string, projectIds: string[]) {
    if (!projectIds.length) return new Set<string>();
    const rows = await this.prisma.ndaSign.findMany({
      where: { userId, projectId: { in: projectIds } },
      select: { projectId: true },
    });
    return new Set(rows.map((r) => r.projectId));
  }

  /** 可见的项目列表（含看板统计）；主列表只展 ACTIVE（PENDING/REJECTED 走 /projects/pending 或详情入口）
   *  archived=false 返回进行中的项目（默认）；archived=true 返回已存档项目（供恢复） */
  async list(userId: string, role: string, archived = false) {
    const projects = await this.prisma.project.findMany({
      where: {
        archived,
        status: ProjectStatus.ACTIVE,
        ...this.visFilter(userId, role),
      },
      include: {
        owner: { select: { id: true, name: true } },
        departments: { select: { department: { select: { id: true, name: true } } } },
        members: { select: { userId: true, role: true } },
        _count: { select: { tasks: true } },
        // 项目页与首页一致：按进展事件消息时间倒序取最近 6 条（条目式逐行展示）
        updates: {
          orderBy: { periodEnd: 'desc' },
          take: 6,
          select: {
            id: true,
            content: true,
            groupName: true,
            keyPoints: true,
            periodEnd: true,
            createdAt: true,
            source: true,
            taskId: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    // 保密项目：未签署协议者在列表里只看得到壳，进展正文必须剥掉（列表带了 updates，不剥等于绕过遮罩泄露）
    const confIds = projects.filter((p) => p.confidential).map((p) => p.id);
    const signedSet = await this.signedNdaIds(userId, confIds);
    return projects.map((raw) => {
      const p = this.flatten(raw);
      if (raw.confidential) {
        // 系统管理员不签协议也照常可见（批复：管理员照常可见，只留痕）
        p.ndaSigned = role === Role.ADMIN || signedSet.has(raw.id);
        if (!p.ndaSigned) p.updates = [];
      }
      return p;
    });
  }

  async get(
    projectId: string,
    userId: string,
    role: string,
    meta?: { name: string; ip?: string; userAgent?: string },
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...this.visFilter(userId, role),
      },
      include: {
        owner: { select: { id: true, name: true, avatar: true } },
        approver: { select: { id: true, name: true } },
        departments: { select: { department: { select: { id: true, name: true, leaderId: true, managerIds: true } } } },
        members: { include: { user: { select: { id: true, name: true, avatar: true } } } },
        boards: {
          include: {
            columns: {
              include: {
                tasks: {
                  include: {
                    assignee: { select: { id: true, name: true, avatar: true } },
                    tags: true,
                  },
                  orderBy: { sortOrder: 'asc' },
                },
              },
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
        // 全部进展（负责人/组员详情页时间线，按进展事件消息时间倒序；前端本地分页，每页 10 条）
        updates: { orderBy: { periodEnd: 'desc' } },
        milestones: { orderBy: { dueDate: 'asc' } },
        // 项目规则（F5）：按发布时间倒序；已阅回执带姓名，供详情页展进度条与已阅名单
        rules: {
          orderBy: { publishedAt: 'desc' },
          include: {
            createdBy: { select: { id: true, name: true } },
            acks: {
              orderBy: { createdAt: 'asc' },
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        approvals: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { reviewer: { select: { id: true, name: true } } },
        },
        // 加签审批人（审批联审卡片展示）
        coReviews: {
          orderBy: { createdAt: 'asc' },
          include: { reviewer: { select: { id: true, name: true } } },
        },
      },
    });
    if (!project) throw new NotFoundException('项目不存在或无权限');
    if (project.confidential && role !== Role.ADMIN) {
      const sign = await this.prisma.ndaSign.findFirst({
        where: { projectId: project.id, userId },
        select: { id: true },
      });
      if (!sign) {
        // 未签署保密协议：只回锁定标记与当前协议正文，绝不返回看板/任务/进展/成员等任何项目内容
        const nda = await this.currentNda();
        return {
          id: project.id,
          name: project.name,
          confidential: true,
          locked: 'NDA',
          nda: { required: true, signed: false, version: nda.version, content: nda.content },
        };
      }
    }
    if (project.confidential) {
      // 进入保密项目详情一律留痕（含管理员与已签署成员），发射后不管不影响响应
      writeAccessLog(this.prisma, {
        userId,
        userName: meta?.name || userId,
        action: 'ENTER',
        resType: 'PROJECT',
        resId: project.id,
        resName: project.name,
        projectId: project.id,
        ip: meta?.ip,
        userAgent: meta?.userAgent,
      });
    }
    const flat = this.flatten(project);
    // 规则压平：发布人与已阅人只留 id/name/note，并标出「我是否已阅」，前端不再猜 userId
    flat.rules = (project.rules || []).map((r: any) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
      author: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : null,
      acks: (r.acks || []).map((a: any) => ({
        id: a.userId,
        name: a.user?.name || '已注销用户',
        note: a.note,
        time: a.createdAt,
      })),
      ackedByMe: (r.acks || []).some((a: any) => a.userId === userId),
    }));
    if (project.confidential) {
      const nda = await this.currentNda();
      flat.nda = {
        // required：是否必须签署才能看（管理员不受限）；走到此处时一定已签或为管理员
        required: role !== Role.ADMIN,
        signed: true,
        version: nda.version,
        content: nda.content,
      };
    }
    return flat;
  }

  /** 当前生效的保密协议（无则把默认正文落为 v1）；返回 { version, content } */
  async currentNda() {
    const v1 = await this.prisma.ndaVersion.upsert({
      where: { version: 1 },
      update: {},
      create: { version: 1, content: NDA_DEFAULT },
    });
    const latest = await this.prisma.ndaVersion.findFirst({
      orderBy: { version: 'desc' },
      select: { id: true, version: true, content: true, createdAt: true, createdById: true },
    });
    return latest ?? {
      id: v1.id,
      version: v1.version,
      content: v1.content,
      createdAt: v1.createdAt,
      createdById: v1.createdById,
    };
  }

  /** 管理员改写协议正文：与当前版本内容一致则不加版（避免手滑点保存就制造新版本） */
  async saveNdaTemplate(userId: string, role: string, content: string) {
    if (role !== Role.ADMIN) throw new ForbiddenException('仅系统管理员可修改保密协议');
    const text = String(content ?? '').trim();
    if (text.length < 20) throw new BadRequestException('协议正文过短，请至少填写一段完整条款');
    const cur = await this.currentNda();
    if (text === cur.content.trim()) return { ok: true, changed: false, version: cur.version };
    const created = await this.prisma.ndaVersion.create({
      data: { version: cur.version + 1, content: text, createdById: userId },
      select: { version: true, content: true },
    });
    return { ok: true, changed: true, version: created.version, content: created.content };
  }

  /** 拨保密开关（仅系统管理员）：首次开启时给 owner + 全部项目成员发站内信，提醒签署协议 */
  async setConfidential(operatorId: string, role: string, projectId: string, confidential: boolean) {
    if (role !== Role.ADMIN) throw new ForbiddenException('仅系统管理员可设置保密项目');
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, confidential: true, ownerId: true, members: { select: { userId: true } } },
    });
    if (!project) throw new NotFoundException('项目不存在');
    if (project.confidential === confidential) {
      return { ok: true, confidential, notified: 0 };
    }
    await this.prisma.project.update({ where: { id: project.id }, data: { confidential } });
    let notified = 0;
    if (confidential) {
      const targets = [...new Set([project.ownerId, ...project.members.map((m) => m.userId)])].filter(
        (id) => id !== operatorId,
      );
      if (targets.length) {
        await this.notifications.createMany(targets, {
          type: NotificationType.ANNOUNCEMENT,
          title: `项目「${project.name}」已设为保密项目`,
          content: '该项目内容仅对已在线签署保密协议的成员开放，请进入项目页完成签署后查看。',
          link: `/projects/${project.id}`,
        });
        notified = targets.length;
      }
    }
    return { ok: true, confidential, notified };
  }

  /** 签署当前版本保密协议（项目成员或负责人；重复签署覆盖为最新版本） */
  async signNda(projectId: string, userId: string, role: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, confidential: true, ownerId: true, members: { select: { userId: true } } },
    });
    if (!project) throw new NotFoundException('项目不存在或无权限');
    if (!project.confidential) throw new BadRequestException('该项目不是保密项目');
    const isMember = project.ownerId === userId || project.members.some((m) => m.userId === userId);
    // ADMIN 无需签署即可见，但也不阻止其留档签署
    if (!isMember && role !== Role.ADMIN) throw new ForbiddenException('仅项目成员可签署该项目的保密协议');
    const nda = await this.currentNda();
    await this.prisma.ndaSign.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { ndaVersionId: nda.id },
      create: { projectId, userId, ndaVersionId: nda.id },
    });
    return { ok: true, version: nda.version };
  }

  /** 保密访问留痕（仅系统管理员）：默认拉近 7 天，可按项目/人过滤 */
  async accessLogs(query: { projectId?: string; userId?: string; days?: string; limit?: string }) {
    const days = Math.min(Math.max(Number(query.days) || 7, 1), 90);
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    // createdAt 存的是北京墙钟字面量，因此过滤阈值也按北京口径算（同写入口径：now + 8h）
    const since = new Date(Date.now() - days * 86_400_000 + CN_OFFSET_MS);
    const rows = await this.prisma.accessLog.findMany({
      where: {
        createdAt: { gte: since },
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        userId: true,
        userName: true,
        action: true,
        resType: true,
        resId: true,
        resName: true,
        projectId: true,
        ip: true,
        userAgent: true,
      },
    });
    // createdAt 存的是北京墙钟字面量：展示直接切 ISO，不做时区换算（与「大模型调用」页同一口径）
    return rows.map((r) => ({
      ...r,
      time: r.createdAt.toISOString().slice(0, 19).replace('T', ' '),
    }));
  }

  // ========== 项目规则与已阅（docs/guard-prd.md F5） ==========

  /** 规则发布/修改/删除：仅 ADMIN 或项目负责人（owner 或 ProjectMember.role=OWNER），部门负责人不含 */
  private async assertRuleManager(projectId: string, userId: string, role: string) {
    if (role === Role.ADMIN) return;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true, members: { where: { userId, role: 'OWNER' }, select: { id: true } } },
    });
    if (!project) throw new NotFoundException('项目不存在');
    if (project.ownerId !== userId && !project.members.length) {
      throw new ForbiddenException('仅系统管理员或项目负责人可发布项目规则');
    }
  }

  /** 规则查看/已阅：ADMIN 或项目成员；保密项目成员必须先签署保密协议（防止不签也能读规则） */
  private async assertRuleViewer(projectId: string, userId: string, role: string) {
    if (role === Role.ADMIN) return;
    if (!(await this.canView(projectId, userId))) {
      throw new ForbiddenException('仅项目负责人或项目成员可查看项目规则');
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { confidential: true },
    });
    if (!project?.confidential) return;
    const signed = await this.prisma.ndaSign.count({ where: { projectId, userId } });
    if (!signed) throw new ForbiddenException('请先在项目页签署保密协议，再查看项目规则');
  }

  /** 项目应阅名单：owner + 全部项目成员去重（owner 不一定在 ProjectMember 里） */
  private async ruleAudience(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, ownerId: true, members: { select: { userId: true } } },
    });
    if (!project) throw new NotFoundException('项目不存在');
    const roster = [...new Set([project.ownerId, ...project.members.map((m) => m.userId)])];
    return { projectId: project.id, projectName: project.name, roster };
  }

  /** 发布规则：写入后给「除发布人外」的应阅成员发站内信；发信失败不影响发布成功 */
  async publishRule(userId: string, role: string, projectId: string, data: { title?: string; content?: string }) {
    await this.assertRuleManager(projectId, userId, role);
    const title = String(data.title ?? '').trim();
    const content = String(data.content ?? '').trim();
    if (!title) throw new BadRequestException('请填写规则标题');
    if (content.length < 5) throw new BadRequestException('规则正文至少 5 个字');
    const { projectName, roster } = await this.ruleAudience(projectId);
    const rule = await this.prisma.projectRule.create({
      data: { projectId, title, content, createdById: userId },
    });
    const targets = roster.filter((id) => id !== userId);
    try {
      await this.notifications.createMany(targets, {
        type: NotificationType.ANNOUNCEMENT,
        title: `《${projectName}》新规则：${title}`,
        content: '请进入项目页查看规则并点击「我已阅」。',
        link: `/projects/${projectId}`,
      });
    } catch (e) {
      this.logger.warn(`规则站内信发送失败 rule=${rule.id}: ${(e as Error).message}`);
    }
    return { ok: true, notified: targets.length, rule };
  }

  /** 修订规则正文：只动 updatedAt，不清空已阅、不做历史版本（批复 9） */
  async updateRule(userId: string, role: string, ruleId: string, data: { title?: string; content?: string }) {
    const rule = await this.prisma.projectRule.findUnique({
      where: { id: ruleId },
      select: { id: true, projectId: true },
    });
    if (!rule) throw new NotFoundException('规则不存在');
    await this.assertRuleManager(rule.projectId, userId, role);
    const title = String(data.title ?? '').trim();
    const content = String(data.content ?? '').trim();
    if (!title) throw new BadRequestException('请填写规则标题');
    if (content.length < 5) throw new BadRequestException('规则正文至少 5 个字');
    const updated = await this.prisma.projectRule.update({
      where: { id: ruleId },
      data: { title, content, updatedAt: new Date() },
    });
    return { ok: true, rule: updated };
  }

  /** 删除规则（已阅回执随外键级联一并清除） */
  async deleteRule(userId: string, role: string, ruleId: string) {
    const rule = await this.prisma.projectRule.findUnique({
      where: { id: ruleId },
      select: { id: true, projectId: true },
    });
    if (!rule) throw new NotFoundException('规则不存在');
    await this.assertRuleManager(rule.projectId, userId, role);
    await this.prisma.projectRule.delete({ where: { id: ruleId } });
    return { ok: true };
  }

  /** 点「我已阅」（可附一句话）；upsert 幂等，已阅后不可撤回也不覆盖原说明 */
  async ackRule(userId: string, role: string, ruleId: string, note?: string) {
    const rule = await this.prisma.projectRule.findUnique({
      where: { id: ruleId },
      select: { id: true, projectId: true },
    });
    if (!rule) throw new NotFoundException('规则不存在');
    await this.assertRuleViewer(rule.projectId, userId, role);
    const text = String(note ?? '').trim().slice(0, 200) || null;
    const exists = await this.prisma.projectRuleAck.findUnique({
      where: { ruleId_userId: { ruleId, userId } },
      select: { id: true },
    });
    if (exists) return { ok: true, already: true };
    await this.prisma.projectRuleAck.create({ data: { ruleId, userId, note: text } });
    return { ok: true, already: false };
  }

  /** 某项目的应阅 / 已阅 / 未阅名单（负责人催办用；保密项目同样受协议约束） */
  async ruleRoster(projectId: string, userId: string, role: string) {
    await this.assertRuleViewer(projectId, userId, role);
    const { projectName, roster } = await this.ruleAudience(projectId);
    const [users, acks] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: roster } },
        select: { id: true, name: true, avatar: true },
      }),
      this.prisma.projectRuleAck.findMany({
        where: { rule: { projectId }, userId: { in: roster } },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);
    const acked = new Set(acks.map((a) => a.userId));
    const byName = (a: any, b: any) => a.name.localeCompare(b.name, 'zh-Hans-CN');
    const read = users.filter((u) => acked.has(u.id)).sort(byName);
    const unread = users.filter((u) => !acked.has(u.id)).sort(byName);
    return {
      ok: true,
      projectId,
      projectName,
      total: users.length,
      readCount: read.length,
      read: read.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar })),
      unread: unread.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar })),
    };
  }

  async create(
    userId: string,
    data: ProjectCreatePayload,
  ) {
    const creator = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, departmentId: true },
    });
    // 审批流强制项：至少 startDate/endDate 必须提供；里程碑/需求文档必填，除非创建人显式勾选豁免
    if (!data.startDate || !data.endDate) {
      throw new BadRequestException('请设定项目计划起止日期');
    }
    const startD = this.parseDateOrNull(data.startDate);
    const endD = this.parseDateOrNull(data.endDate);
    if (!startD || !endD) throw new BadRequestException('日期格式需为 YYYY-MM-DD');
    if (endD.getTime() < startD.getTime()) throw new BadRequestException('计划交付日不能早于开始日');
    const validMilestones = (data.milestones ?? []).filter(
      (ms) => String(ms.name ?? '').trim() && this.parseDateOrNull(ms.dueDate),
    );
    this.assertKickoffConfirmations({
      milestoneCount: validMilestones.length,
      docCount: (data.requirementDocIds ?? []).length,
      skipMilestone: !!data.skipMilestone,
      skipRequirementDoc: !!data.skipRequirementDoc,
    });

    const approverId = await this.resolveApprover(userId);
    // 无审批人（例如唯一 ADMIN 自己建项目）→ 直接 ACTIVE；否则 PENDING
    const initialStatus = approverId ? ProjectStatus.PENDING : ProjectStatus.ACTIVE;

    const { departmentIds, milestones, requirementDocIds, startDate, endDate, skipMilestone, skipRequirementDoc, ...rest } = data;
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          ...rest,
          ownerId: userId,
          status: initialStatus,
          startDate: startD,
          endDate: endD,
          approverId,
          requirementDocIds,
          approvalSubmittedAt: initialStatus === ProjectStatus.PENDING ? new Date() : null,
          skipMilestone: !!skipMilestone,
          skipRequirementDoc: !!skipRequirementDoc,
          departments: {
            create: [...new Set(departmentIds ?? [])].map((departmentId) => ({ departmentId })),
          },
          milestones:
            milestones && milestones.length
              ? {
                  create: milestones
                    .map((ms) => ({
                      name: String(ms.name ?? '').trim(),
                      dueDate: this.parseDateOrNull(ms.dueDate),
                      description: ms.description?.trim() || null,
                    }))
                    .filter((ms) => ms.name && ms.dueDate)
                    .map((ms) => ({ name: ms.name, dueDate: ms.dueDate as Date, description: ms.description })),
                }
              : undefined,
        },
      });
      // 默认创建一块看板「任务看板」，含 3 个标准列
      const board = await tx.kanbanBoard.create({
        data: {
          projectId: project.id,
          name: '任务看板',
          columns: {
            create: [
              { name: '待办', sortOrder: 0 },
              { name: '进行中', sortOrder: 1 },
              { name: '已完成', sortOrder: 2 },
            ],
          },
        },
      });
      // 创建者若为普通成员，升级为项目负责人
      if (creator?.role === Role.MEMBER) {
        await tx.user.update({ where: { id: userId }, data: { role: Role.PROJECT_LEADER } });
      }
      // 待审批项目时钉钉通知审批人（失败不阻断）
      if (approverId) {
        try {
          await this.notifications.createMany([approverId], {
            type: 'SYSTEM',
            title: `项目「${project.name}」等待你审批`,
            content: `由 ${creator?.role === Role.ADMIN ? '管理员' : '成员'}创建，请在项目详情页处理`,
            link: `/projects/${project.id}`,
          });
        } catch (e) {
          this.logger.warn(`审批人通知失败 approver=${approverId}: ${(e as Error).message}`);
        }
      }
      return { ...project, boardId: board.id };
    });
  }

  /** 将 'YYYY-MM-DD' 或 ISO 字符串解析为 UTC 午夜（只保留日期部分），不合法则 null */
  private parseDateOrNull(input?: string | null): Date | null {
    if (!input) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input).trim());
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** 解析项目创建人的默认审批人：
   * - 主部门负责人（非自己、在职、角色为部门负责人或管理员）；负责人不可用时依次取该部门共管人
   * - 均无合适候选时回退到最早注册的活跃 ADMIN（非自己）
   * - 无合适候选时返回 null（项目直接 ACTIVE） */
  private async resolveApprover(creatorId: string): Promise<string | null> {
    const creator = await this.prisma.user.findUnique({
      where: { id: creatorId },
      select: { departmentId: true, role: true },
    });
    if (creator?.departmentId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: creator.departmentId },
        select: { leaderId: true, managerIds: true },
      });
      // 负责人优先，负责人是自己/已停用/角色不够时依次问共管人（大部门多名管理者）
      for (const cand of deptAuthorityIds(dept)) {
        if (cand === creatorId) continue;
        const u = await this.prisma.user.findUnique({
          where: { id: cand },
          select: { id: true, active: true, role: true },
        });
        if (u?.active && (u.role === Role.DEPT_LEADER || u.role === Role.ADMIN)) return u.id;
      }
    }
    // 回退：最早注册的活跃 ADMIN（排除自己）
    const admin = await this.prisma.user.findFirst({
      where: { role: Role.ADMIN, active: true, id: { not: creatorId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return admin?.id ?? null;
  }

  /** 按群名验证钉钉群（唯一命中才返回会话 ID，不泄露群列表） */
  async resolveDingtalkGroup(name: string) {
    return this.fetch.resolveGroupByName(name);
  }

  // ============ 项目审批与重提交 ============

  /** 待我审批的项目（approverId=me 且 status=PENDING；ADMIN 兵底：看全部 PENDING） */
  async pendingForReview(userId: string, role: string) {
    const where: any =
      role === Role.ADMIN
        ? { status: ProjectStatus.PENDING, deletedAt: null, archived: false }
        : {
            status: ProjectStatus.PENDING,
            deletedAt: null,
            archived: false,
            OR: [{ approverId: userId }, { coReviews: { some: { reviewerId: userId, status: 'PENDING' } } }],
          };
    const projects = await this.prisma.project.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true } },
        approver: { select: { id: true, name: true } },
        departments: { select: { department: { select: { id: true, name: true } } } },
        milestones: { orderBy: { dueDate: 'asc' } },
        coReviews: { include: { reviewer: { select: { id: true, name: true } } } },
        _count: { select: { tasks: true } },
      },
      orderBy: { approvalSubmittedAt: 'desc' },
    });
    return projects.map((p) => this.flatten(p));
  }

  /** 我提交的项目申请（包含 PENDING/REJECTED/ACTIVE 自己创建的，方便列表展示状态） */
  async myApplications(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { ownerId: userId, deletedAt: null, status: { not: ProjectStatus.ACTIVE } },
      include: {
        owner: { select: { id: true, name: true } },
        approver: { select: { id: true, name: true } },
        departments: { select: { department: { select: { id: true, name: true } } } },
        coReviews: { include: { reviewer: { select: { id: true, name: true } } } },
        _count: { select: { tasks: true } },
      },
      orderBy: { approvalSubmittedAt: 'desc' },
    });
    return projects.map((p) => this.flatten(p));
  }

  /** 项目审批历史（owner / approver / ADMIN 可查） */
  async approvals(projectId: string, userId: string, role: string) {
    await this.assertVisible(projectId, userId, role);
    return this.prisma.projectApproval.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { reviewer: { select: { id: true, name: true } } },
    });
  }

  /** 同意审批（主审批人 approverId=me 或 ADMIN）：加签人全部同意后才 ACTIVE，否则记录意见保持 PENDING */
  async approve(projectId: string, userId: string, role: string, note?: string) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN && p.approverId !== userId) {
      throw new ForbiddenException('仅指定审批人或系统管理员可处理审批');
    }
    if (p.status !== ProjectStatus.PENDING) {
      throw new BadRequestException('项目当前不处于待审批状态');
    }
    const pendingCo = await this.prisma.projectCoReview.count({
      where: { projectId, status: 'PENDING' },
    });
    const finalApproved = pendingCo === 0;
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: finalApproved ? ProjectStatus.ACTIVE : ProjectStatus.PENDING, approvalNote: note?.trim() || null },
    });
    await this.prisma.projectApproval.create({
      data: { projectId, reviewerId: userId, decision: 'APPROVED', note: note?.trim() || null },
    });
    if (finalApproved) {
      try {
        await this.notifications.createMany([p.ownerId], {
          type: 'SYSTEM',
          title: `项目「${p.name}」审批已通过`,
          content: note?.trim() || '',
          link: `/projects/${p.id}`,
        });
      } catch (e) {
        this.logger.warn(`审批通过通知失败: ${(e as Error).message}`);
      }
    }
    return { project: updated, pendingCoReviewers: pendingCo };
  }

  /** 驳回审批（主审批人或加签人或 ADMIN）：PENDING → REJECTED（需附意见） */
  async reject(projectId: string, userId: string, role: string, note: string) {
    const trimmed = (note ?? '').trim();
    if (!trimmed) throw new BadRequestException('驳回必须填写审批意见');
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN && p.approverId !== userId) {
      // 被加签人也可驳回（任何一票驳回即退回发起人修改）
      const mine = await this.prisma.projectCoReview.findUnique({
        where: { projectId_reviewerId: { projectId, reviewerId: userId } },
        select: { id: true },
      });
      if (!mine) throw new ForbiddenException('仅指定审批人、加签人或系统管理员可处理审批');
    }
    if (p.status !== ProjectStatus.PENDING) {
      throw new BadRequestException('项目当前不处于待审批状态');
    }
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.REJECTED, approvalNote: trimmed },
    });
    await this.prisma.projectApproval.create({
      data: { projectId, reviewerId: userId, decision: 'REJECTED', note: trimmed },
    });
    // 项目已退回修改，清空本轮加签（重提交后审批人可重新加签）
    await this.prisma.projectCoReview.deleteMany({ where: { projectId } });
    try {
      await this.notifications.createMany([p.ownerId], {
        type: 'SYSTEM',
        title: `项目「${p.name}」被驳回修改`,
        content: trimmed,
        link: `/projects/${p.id}`,
      });
    } catch (e) {
      this.logger.warn(`驳回通知失败: ${(e as Error).message}`);
    }
    return updated;
  }

  // ---- 审批加签（主审批人邀请其他人共同审批；全部同意后才生效）----

  /** 加签：仅主审批人或 ADMIN，在 PENDING 期间邀请成员共同审批；已存在的加签人不重复发通知 */
  async addCoReviewers(projectId: string, userId: string, role: string, reviewerIds: string[]) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN && p.approverId !== userId) {
      throw new ForbiddenException('仅指定审批人或系统管理员可加签');
    }
    if (p.status !== ProjectStatus.PENDING) {
      throw new BadRequestException('项目当前不处于待审批状态，无法加签');
    }
    const ids = [...new Set((reviewerIds ?? []).map((x) => String(x).trim()).filter(Boolean))].filter(
      (id) => id !== p.approverId && id !== p.ownerId,
    );
    if (!ids.length) throw new BadRequestException('请选择要加签的审批人');
    const valid = await this.prisma.user.findMany({
      where: { id: { in: ids }, active: true },
      select: { id: true, name: true },
    });
    if (valid.length !== ids.length) throw new BadRequestException('存在无效或已停用的加签人');
    const existing = await this.prisma.projectCoReview.findMany({
      where: { projectId, reviewerId: { in: ids } },
      select: { reviewerId: true },
    });
    const existingSet = new Set(existing.map((e) => e.reviewerId));
    const fresh = valid.filter((u) => !existingSet.has(u.id));
    if (fresh.length) {
      await this.prisma.projectCoReview.createMany({
        data: fresh.map((u) => ({ projectId, reviewerId: u.id })),
      });
      try {
        await this.notifications.createMany(
          fresh.map((u) => u.id),
          {
            type: 'SYSTEM',
            title: `项目「${p.name}」请你参与审批`,
            content: `${p.name} 的审批人已将你加签，请进入项目页查看并审批`,
            link: `/projects/${p.id}`,
          },
        );
      } catch (e) {
        this.logger.warn(`加签通知失败: ${(e as Error).message}`);
      }
    }
    return { ok: true, added: fresh.length };
  }

  /** 加签人审批：同意保持 PENDING 等其余人；任一人驳回即退回发起人修改 */
  async decideCoReview(
    projectId: string,
    userId: string,
    role: string,
    data: { decision?: string; note?: string } = {},
  ) {
    const decision = String(data?.decision ?? '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw new BadRequestException('decision 须为 APPROVED 或 REJECTED');
    const trimmed = String(data?.note ?? '').trim();
    if (decision === 'REJECTED' && !trimmed) throw new BadRequestException('驳回必须填写审批意见');
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (p.status !== ProjectStatus.PENDING) throw new BadRequestException('项目当前不处于待审批状态');
    const mine = await this.prisma.projectCoReview.findUnique({
      where: { projectId_reviewerId: { projectId, reviewerId: userId } },
    });
    if (!mine) throw new ForbiddenException('你不在该项目的加签名单中');
    if (mine.status !== 'PENDING') throw new BadRequestException('你已处理过该项目的加签审批');
    await this.prisma.projectCoReview.update({
      where: { id: mine.id },
      data: { status: decision, note: trimmed || null, decidedAt: new Date() },
    });
    const remaining = await this.prisma.projectCoReview.count({ where: { projectId, status: 'PENDING' } });
    if (decision === 'REJECTED') {
      await this.reject(projectId, userId, role, trimmed);
      return { ok: true, decision, remaining: 0, rejected: true };
    }
    return { ok: true, decision, remaining, rejected: false };
  }

  /** 移除尚未处理的加签人（仅主审批人或 ADMIN；已出结论的不可移除，保留审批留痕） */
  async removeCoReviewer(projectId: string, userId: string, role: string, coReviewId: string) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN && p.approverId !== userId) {
      throw new ForbiddenException('仅指定审批人或系统管理员可移除加签人');
    }
    const row = await this.prisma.projectCoReview.findUnique({ where: { id: coReviewId } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('加签记录不存在');
    if (row.status !== 'PENDING') throw new BadRequestException('该加签人已给出审批结论，不可移除');
    await this.prisma.projectCoReview.delete({ where: { id: coReviewId } });
    return { ok: true };
  }

  /** 驳回后重新提交（仅 owner）：REJECTED → PENDING，同时可调整基本信息/时间计划/需求文档/里程碑 */
  async resubmit(projectId: string, userId: string, role: string, patch: Partial<ProjectCreatePayload>) {
    const p = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw new NotFoundException('项目不存在');
    if (p.ownerId !== userId && role !== Role.ADMIN) {
      throw new ForbiddenException('仅项目创建人可重新提交审批');
    }
    if (p.status !== ProjectStatus.REJECTED && p.status !== ProjectStatus.PENDING) {
      throw new BadRequestException('当前项目状态不允许重新提交');
    }
    const docIds = Array.isArray(patch.requirementDocIds) ? patch.requirementDocIds : p.requirementDocIds;
    const skipMs = patch.skipMilestone !== undefined ? !!patch.skipMilestone : p.skipMilestone;
    const skipDoc = patch.skipRequirementDoc !== undefined ? !!patch.skipRequirementDoc : p.skipRequirementDoc;
    const startD = patch.startDate !== undefined ? this.parseDateOrNull(patch.startDate) : p.startDate;
    const endD = patch.endDate !== undefined ? this.parseDateOrNull(patch.endDate) : p.endDate;
    if (!startD || !endD) throw new BadRequestException('请保留项目计划起止日期');
    if (endD.getTime() < startD.getTime()) throw new BadRequestException('计划交付日不能早于开始日');
    // 与创建同口径：里程碑/需求文档必填，除非发起人显式勾选豁免
    const msCountAfter = Array.isArray(patch.milestones)
      ? patch.milestones.filter((ms) => String(ms.name ?? '').trim() && this.parseDateOrNull(ms.dueDate)).length
      : await this.prisma.projectMilestone.count({ where: { projectId } });
    this.assertKickoffConfirmations({
      milestoneCount: msCountAfter,
      docCount: (docIds ?? []).length,
      skipMilestone: skipMs,
      skipRequirementDoc: skipDoc,
    });
    const approverId = await this.resolveApprover(p.ownerId);

    return this.prisma.$transaction(async (tx) => {
      // 重提交开启新一轮审批：清空上一轮加签
      await tx.projectCoReview.deleteMany({ where: { projectId } });
      // 里程碑全量替换（传 milestones 时）
      if (Array.isArray(patch.milestones)) {
        await tx.projectMilestone.deleteMany({ where: { projectId } });
        const rows = patch.milestones
          .map((ms) => ({
            name: String(ms.name ?? '').trim(),
            dueDate: this.parseDateOrNull(ms.dueDate),
            description: ms.description?.trim() || null,
          }))
          .filter((ms) => ms.name && ms.dueDate);
        if (rows.length) {
          await tx.projectMilestone.createMany({
            data: rows.map((r) => ({ projectId, name: r.name, dueDate: r.dueDate as Date, description: r.description })),
          });
        }
      }
      const updated = await tx.project.update({
        where: { id: projectId },
        data: {
          status: approverId ? ProjectStatus.PENDING : ProjectStatus.ACTIVE,
          approverId,
          startDate: startD,
          endDate: endD,
          requirementDocIds: docIds,
          skipMilestone: skipMs,
          skipRequirementDoc: skipDoc,
          approvalSubmittedAt: approverId ? new Date() : null,
          approvalNote: null,
          name: patch.name?.trim() || p.name,
          description: patch.description !== undefined ? patch.description : p.description,
          color: patch.color !== undefined ? patch.color : p.color,
        },
      });
      if (approverId && approverId !== p.approverId) {
        try {
          await this.notifications.createMany([approverId], {
            type: 'SYSTEM',
            title: `项目「${p.name}」重新提交等你审批`,
            content: `${p.name} 重新提交审批`,
            link: `/projects/${p.id}`,
          });
        } catch (e) {
          this.logger.warn(`重提交通知失败: ${(e as Error).message}`);
        }
      }
      return updated;
    });
  }

  /** 内部：验证项目对当前用户可见（非成员但 owner/approver/ADMIN 也可） */
  private async assertVisible(projectId: string, userId: string, role: string) {
    const hit = await this.prisma.project.findFirst({
      where: { id: projectId, ...this.visFilter(userId, role) },
      select: { id: true },
    });
    if (!hit) throw new NotFoundException('项目不存在或无权限');
  }

  async update(
    projectId: string,
    data: {
      name?: string;
      description?: string;
      color?: string;
      archived?: boolean;
      departmentIds?: string[];
      dingtalkConversationId?: string | null;
      dingtalkGroupName?: string | null;
      dailyDigestEnabled?: boolean;
      digestTime?: string;
      digestEveryDays?: number;
      startDate?: string | null;
      endDate?: string | null;
      requirementDocIds?: string[];
      milestones?: { name: string; dueDate: string; description?: string | null }[];
      skipMilestone?: boolean;
      skipRequirementDoc?: boolean;
    },
  ) {
    // 保密标记只能走 PUT /projects/:id/confidential（仅系统管理员）；通用改项目接口一律忽略传入的 confidential
    const { departmentIds, milestones, startDate, endDate, requirementDocIds, confidential, ...patch } =
      data as typeof data & { confidential?: unknown } & Record<string, any>;
    void confidential;
    return this.prisma.$transaction(async (tx) => {
      if (departmentIds !== undefined) {
        // 主要关联部门全量替换（多对多）
        await tx.projectDepartment.deleteMany({ where: { projectId } });
        const uniq = [...new Set(departmentIds)];
        if (uniq.length) {
          await tx.projectDepartment.createMany({
            data: uniq.map((departmentId) => ({ projectId, departmentId })),
            skipDuplicates: true,
          });
        }
      }
      // 时间计划：'YYYY-MM-DD'/ISO 同口径归一到 UTC 午夜
      const extra: Record<string, unknown> = {};
      if (startDate !== undefined) extra.startDate = this.parseDateOrNull(startDate as string | null);
      if (endDate !== undefined) extra.endDate = this.parseDateOrNull(endDate as string | null);
      if (requirementDocIds !== undefined) extra.requirementDocIds = requirementDocIds;
      // 里程碑全量替换（传 milestones 时才处理）
      if (Array.isArray(milestones)) {
        await tx.projectMilestone.deleteMany({ where: { projectId } });
        const rows = milestones
          .map((ms) => ({
            name: String(ms.name ?? '').trim(),
            dueDate: this.parseDateOrNull(ms.dueDate),
            description: ms.description?.trim() || null,
          }))
          .filter((ms) => ms.name && ms.dueDate);
        if (rows.length) {
          await tx.projectMilestone.createMany({
            data: rows.map((r) => ({ projectId, name: r.name, dueDate: r.dueDate as Date, description: r.description })),
          });
        }
      }
      return tx.project.update({ where: { id: projectId }, data: { ...patch, ...extra } as any });
    });
  }

  /** 立即把本项目最近进展发到本项目绑定的钉钉群（不依赖定时开关/时间） */
  async sendDigestNow(projectId: string) {
    return this.digest.sendProjectGroupNow(projectId);
  }

  /** 是否可管理项目（管理员 / 项目负责人 OWNER / 主要关联部门负责人或共管人） */
  async canManage(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { where: { userId, role: 'OWNER' } },
        departments: { where: { department: ledDeptWhere(userId) } },
      },
    });
    if (!project) return false;
    return (
      project.ownerId === userId ||
      project.members.length > 0 ||
      project.departments.length > 0
    );
  }

  /** 已知钉钉群列表（来自已落库消息，按最近消息排序） */
  async listDingtalkGroups() {
    const groups = await this.prisma.messageInbox.groupBy({
      by: ['conversationId', 'conversationName'],
      where: { conversationId: { not: null } },
      _count: { _all: true },
      _max: { receivedAt: true },
    });
    return groups
      .filter((g) => g.conversationId)
      .map((g) => ({
        conversationId: g.conversationId as string,
        conversationName: g.conversationName || '未命名群',
        messageCount: g._count._all,
        lastMessageAt: g._max.receivedAt,
      }))
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
  }

  /** 我参与的项目 + 每个项目最新多条进展（首页绿色条目列表）；主展 ACTIVE（PENDING/REJECTED 不参与首页） */
  async myUpdates(userId: string, role: string) {
    const count = await this.loadHomeProgressCount();
    const projects = await this.prisma.project.findMany({
      where: {
        archived: false,
        status: ProjectStatus.ACTIVE,
        ...this.visFilter(userId, role),
      },
      include: {
        // 首页按进展事件的消息时间倒序取最近 N 条（N 由管理后台设置，默认 3，0~10）
        updates: { orderBy: { periodEnd: 'desc' }, take: count },
      },
      orderBy: { updatedAt: 'desc' },
    });
    // 完成度/健康度：优先 Project 缓存列（AI 分析产物）；为空时用轻量规则实时算，保证首页始终有数值
    const ids = projects.map((p) => p.id);
    const [statusGroups, overdueGroups] = await Promise.all([
      ids.length
        ? this.prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: ids } }, _count: { _all: true } })
        : Promise.resolve([]),
      ids.length
        ? this.prisma.task.groupBy({
            by: ['projectId'],
            where: { projectId: { in: ids }, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const totalBy = new Map<string, number>();
    const doneBy = new Map<string, number>();
    for (const g of statusGroups) {
      totalBy.set(g.projectId, (totalBy.get(g.projectId) ?? 0) + g._count._all);
      if (g.status === 'DONE') doneBy.set(g.projectId, g._count._all);
    }
    const overdueBy = new Map<string, number>();
    for (const g of overdueGroups) overdueBy.set(g.projectId, g._count._all);
    // 保密项目且未签协议：首页不展进展（同列表口径，管理员不受限）
    const homeSigned = await this.signedNdaIds(
      userId,
      projects.filter((p) => p.confidential).map((p) => p.id),
    );
    const now = new Date();
    return projects.map((p) => {
      const total = totalBy.get(p.id) ?? 0;
      const done = doneBy.get(p.id) ?? 0;
      const ruleCompletion = total > 0 ? Math.round((done / total) * 100) : 0;
      const completionPercent = p.completionPercent ?? ruleCompletion;
      const healthPercent =
        p.healthPercent ?? this.ruleHealthPercent(p.startDate, p.endDate, completionPercent, overdueBy.get(p.id) ?? 0, now);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        dingtalkGroupName: p.dingtalkGroupName,
        confidential: p.confidential,
        completionPercent,
        healthPercent,
        updates: p.confidential && role !== Role.ADMIN && !homeSigned.has(p.id) ? [] : p.updates,
      };
    });
  }

  /** 健康度规则实时算（无 AI 缓存时）：与 project-health.service 同一扣分口径 */
  private ruleHealthPercent(
    startDate: Date | null,
    endDate: Date | null,
    completion: number,
    overdue: number,
    now: Date,
  ): number {
    const remainingDays = endDate ? Math.max(-9999, Math.floor((endDate.getTime() - now.getTime()) / 86_400_000)) : 9999;
    let timeProgress = 0;
    if (startDate && endDate && endDate.getTime() > startDate.getTime()) {
      timeProgress = Math.max(
        0,
        Math.min(1, (now.getTime() - startDate.getTime()) / (endDate.getTime() - startDate.getTime())),
      );
    }
    const lag = timeProgress - completion / 100;
    let s = 100;
    s -= Math.min(40, overdue * 8);
    if (lag > 0) s -= Math.min(30, Math.round(lag * 100 * 0.6));
    if (remainingDays < 0) s -= 25;
    else if (remainingDays <= 3 && completion < 80) s -= 15;
    else if (remainingDays <= 7 && completion < 60) s -= 8;
    return Math.max(0, Math.min(100, s));
  }

  // ============ 首页展示设置（Setting KV：home.progressCount，默认 3，0~10） ============

  private static readonly HOME_PROGRESS_COUNT_KEY = 'home.progressCount';

  /** 首页每项目进展展示条数（当前生效值，未设置回退默认 3） */
  async getHomeDisplay() {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: ProjectsService.HOME_PROGRESS_COUNT_KEY } });
      const c = (row?.value as { count?: unknown })?.count;
      if (typeof c === 'number' && Number.isFinite(c)) return { count: this.clampCount(c) };
    } catch {
      // 读取失败回退默认
    }
    return { count: 3 };
  }

  /** 保存首页展示条数（写库前 clamp 0~10） */
  async saveHomeDisplay(count: number) {
    const c = this.clampCount(count);
    await this.prisma.setting.upsert({
      where: { key: ProjectsService.HOME_PROGRESS_COUNT_KEY },
      create: { key: ProjectsService.HOME_PROGRESS_COUNT_KEY, value: { count: c } },
      update: { value: { count: c } },
    });
    return { count: c };
  }

  private async loadHomeProgressCount(): Promise<number> {
    const { count } = await this.getHomeDisplay();
    return count;
  }

  private clampCount(v: number): number {
    return Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  }

  /** 解析 AI 事件消息时间（消息行前缀为北京墙钟 YYYY-MM-DDTHH:mm，AI 要求原样引用；按库内墙钟口径构造）；不合法返回 null */
  private parseEventTime(input?: string): Date | null {
    if (!input) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(input.trim());
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * AI 从关联钉钉群消息提取项目进展事件（供定时 Worker 与手动触发调用）
   * - 每个关联了钉钉群的项目（或 opts.projectId 指定单项目），取「上次提取之后」的群消息，逐条识别进展事件
   * - 每条进展事件独立落库为一条进展：content=AI 浓缩结论；periodEnd=该事件最后相关消息时间
   *   （消息日，展示日期与增量窗口均以此为准）
   * - 无历史进展时回看 opts.lookbackHours（默认 24）小时，保证初次提取有内容
   * - 消息发送人自动解析身份（绑定系统用户）；机器人消息剔除；未绑定发送人按钉钉名展示
   * - AI 失败/不可用/无有效消息/窗口无进展事件时跳过该轮（since 不变，下轮自动重试）
   */
  async generateProgress(opts?: { projectId?: string; lookbackHours?: number }) {
    const projects = await this.prisma.project.findMany({
      where: {
        archived: false,
        deletedAt: null,
        dingtalkConversationId: { not: null },
        ...(opts?.projectId ? { id: opts.projectId } : {}),
      },
      include: {
        members: { select: { userId: true } },
        // 仅取时间与来源（轻量）：首条定增量窗口起点，最近 AI 事件定防重复剔除分钟
        updates: { orderBy: { periodEnd: 'desc' }, select: { periodEnd: true, source: true } },
      },
    });
    const results: { projectId: string; projectName: string; generated: boolean; reason?: string }[] = [];
    for (const project of projects) {
      const since = project.updates[0]?.periodEnd ?? new Date(Date.now() - (opts?.lookbackHours ?? 24) * 3600 * 1000);
      // 防重复：增量窗口起点若是 AI 事件时间（分钟精度），该事件消息自身（秒级 receivedAt）会再次落入窗口，
      // 导致同一事件被 AI 重复提取 → 剔除与起点同一分钟的消息；删除条目后的全量重扫（起点回退）不受影响
      const top = project.updates[0];
      const skipSinceMinute =
        top && top.source === 'AI_GROUP' ? Math.floor(top.periodEnd.getTime() / 60_000) : null;
      const messages = await this.prisma.messageInbox.findMany({
        where: {
          conversationId: project.dingtalkConversationId as string,
          receivedAt: { gte: since },
          content: { not: null },
        },
        // 窗口内取最新 200 条（回看窗口大时保证覆盖最新讨论，而非最早一批旧消息）
        orderBy: { receivedAt: 'desc' },
        take: 200,
      });
      messages.reverse(); // 恢复时间升序，供 AI 按讨论顺序阅读
      // 群成员画像：机器人 openDingtalkId（消息过滤）+ 真人 openDingtalkId -> 钉钉名（身份匹配）
      const members = await this.fetch.listGroupMembers(project.dingtalkConversationId as string);
      const memberNames = new Map(members.users.map((u) => [u.openDingtalkId, u.name]));
      // 解析发送人身份（去重后逐个解析；命中 UserIdentity 后后续直接查表）
      const senders = [...new Set(messages.map((m) => m.senderExternalId).filter((x): x is string => Boolean(x)))];
      const senderUsers = new Map<string, string>(); // externalId -> 系统用户名
      const senderBots = new Set<string>(); // 群画像中明确为机器人的 openDingtalkId
      for (const bid of members.bots) senderBots.add(bid);
      await Promise.all(
        senders.map(async (sid) => {
          if (senderBots.has(sid)) return;
          const r = await this.fetch.resolveSenderIdentity(sid, memberNames.get(sid));
          if (r && 'bot' in r) senderBots.add(sid);
          else if (r?.userId) {
            const u = await this.prisma.user.findUnique({ where: { id: r.userId }, select: { name: true } });
            if (u) senderUsers.set(sid, u.name);
          }
        }),
      );
      // 过滤无意义占位消息（图片/文件/语音等）、系统自身群发的进展总结（防回音壁二次提取）、机器人消息，以及增量起点分钟内的消息（已处理过）
      const meaningful = messages.filter((m) => {
        if (!m.content || /^\[(图片|文件|语音|视频|链接|消息)\]/.test(m.content)) return false;
        if (isSelfDigestMessage(m.content)) return false; // 剔除每日群发的「📣 团队工作进展」总结被抓回后二次提取
        if (m.senderExternalId && senderBots.has(m.senderExternalId)) return false;
        if (
          skipSinceMinute != null &&
          m.receivedAt &&
          Math.floor(m.receivedAt.getTime() / 60_000) === skipSinceMinute
        )
          return false;
        return true;
      });
      // 需求2：归属于本项目的近窗口内已发布日报/周报作为进展补充输入
      // 口径收紧：按「该日报归属本项目」(report.projectId = 本项目) 选取，而非按「作者是本项目成员」选取；
      // 否则共享成员（如负责人/管理员）在别的项目或自动群聊同步攒出的日报，会被反哺进本项目进展，
      // 导致同一条无关进展串到多个项目。projectId 为 null 的日报（未经归属判断/群聊自动段落）不纳入。
      const reports = await this.prisma.report.findMany({
        where: { projectId: project.id, periodStart: { gte: since }, status: 'PUBLISHED' },
        orderBy: { periodStart: 'desc' },
        take: 40,
        select: {
          type: true,
          periodStart: true,
          rawContent: true,
          correctedContent: true,
          content: true,
          manualContent: true,
          owner: { select: { name: true } },
        },
      });
      let reportsText = '';
      for (const r of reports) {
        let text = (r.rawContent ?? r.correctedContent ?? '').trim();
        if (!text) {
          const c =
            (r.content as { summary?: string; sections?: { title?: string; items?: string[] }[] } | null) ?? null;
          text = [c?.summary ?? '', ...(c?.sections ?? []).map((s) => `${s.title ?? ''} ${(s.items ?? []).join(' ')}`)]
            .filter(Boolean)
            .join(' ')
            .trim();
        }
        if (r.manualContent) text = `${text} ${r.manualContent}`.trim();
        if (!text) continue;
        const line = `[${r.periodStart.toISOString().slice(0, 10)}] 报告·${r.owner?.name ?? '成员'}（${
          r.type === 'WEEKLY' ? '周报' : '日报'
        }）: ${text.slice(0, 400)}`;
        if (reportsText.length >= 8000) break; // 总预算约 8000 字符，超限保留更新的
        reportsText = reportsText ? `${line}\n${reportsText}` : line;
      }
      if (meaningful.length < 1 && !reportsText) {
        results.push({ projectId: project.id, projectName: project.name, generated: false, reason: '无有效群消息与报告' });
        continue;
      }
      const lines = meaningful.map((m) => {
        const who = m.senderExternalId ? (senderUsers.get(m.senderExternalId) ?? m.senderName) : m.senderName;
        // 单条截断 90 字：输入过长会触发推理模型思考超限截断（同 sop.extract 经验），有效信息在短句内即可判断
        // 时间口径：receivedAt 存「北京墙钟字面量」，故 toISOString 前缀即北京时间（见 dingtalk-fetch.service.ts）
        return `[${m.receivedAt.toISOString().slice(0, 16)}] ${who ?? '未知'}: ${(m.content ?? '').slice(0, 90)}`;
      });
      const aiResult = await this.ai.generateJson<{
        events?: { time?: string; content?: string; keyPoints?: string[] }[];
      }>('project.progress', {
        projectName: project.name,
        groupName: project.dingtalkGroupName ?? '钉钉群',
        messages: lines.join('\n'),
        reports: reportsText || '（无）',
      });
      const rawEvents = (aiResult?.events ?? []).filter(
        (e): e is { time?: string; content: string; keyPoints?: string[] } =>
          !!e && typeof e.content === 'string' && e.content.trim().length > 0,
      );
      if (!rawEvents.length) {
        results.push({
          projectId: project.id,
          projectName: project.name,
          generated: false,
          reason: '窗口内未提取到进展事件',
        });
        continue;
      }
      // 逐条事件落库为一条进展：periodEnd = 该事件最后相关消息时间（消息日），超出窗口视为幻觉则回退
      const windowEnd = meaningful[meaningful.length - 1]?.receivedAt ?? new Date();
      let lastEventTime: Date | null = null;
      let created = 0;
      for (const ev of rawEvents) {
        const t = this.parseEventTime(ev.time);
        const periodEnd =
          t && t.getTime() >= since.getTime() - 60_000 && t.getTime() <= windowEnd.getTime() + 60_000
            ? t
            : (lastEventTime ?? windowEnd);
        lastEventTime = periodEnd;
        await this.prisma.projectUpdate.create({
          data: {
            projectId: project.id,
            content: ev.content.trim(),
            keyPoints: (ev.keyPoints ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, 3),
            source: 'AI_GROUP',
            groupName: project.dingtalkGroupName,
            periodStart: since,
            periodEnd,
          },
        });
        created += 1;
      }
      // 通知项目成员（整批合并为一条，避免刷屏）
      const memberIds = [...new Set([project.ownerId, ...project.members.map((m) => m.userId)])];
      await this.notifications.createMany(memberIds, {
        type: 'SYSTEM',
        title: `项目「${project.name}」进展已更新（${created} 条）`,
        content: rawEvents[rawEvents.length - 1].content.slice(0, 100),
        link: `/projects/${project.id}`,
      });
      results.push({ projectId: project.id, projectName: project.name, generated: true });
    }
    this.logger.log(`进展生成完成: ${JSON.stringify(results)}`);
    return results;
  }

  /**
   * 手动「拉取并总结」：拉取该项目关联群最近 lookbackHours 小时（默认 48h）消息并投递单项目 AI 总结
   * - 无论是否拉到新增消息都投递：项目首次拉消息后无历史总结时，generateProgress
   *   会回看最近 lookbackHours 的已落库消息完成首份总结；窗口与拉取窗口一致
   */
  async summarizeForProject(projectId: string, opts?: { lookbackHours?: number }) {
    const lookbackHours = opts?.lookbackHours ?? 48;
    const r = await this.fetch.fetchRecentForProject(projectId, lookbackHours);
    if (r.error) return r;
    await this.progressQueue.triggerScan(projectId, lookbackHours);
    return { ...r, scheduled: true };
  }

  /**
   * 项目详情页「项目会议」列表：已召开的会议倒序 + 即将召开的最近 3 场
   * - 口径：主关联项目是本项目的，或本项目被勾为「其他关联项目」的都算
   * - 保密项目：未签协议者不给取（与文档空间 /tasks 同一收口）
   */
  async projectMeetings(userId: string, role: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, confidential: true },
    });
    if (!project) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN && !(await this.canView(projectId, userId))) {
      throw new ForbiddenException('仅项目负责人或项目成员可查看项目会议');
    }
    if (project.confidential && role !== Role.ADMIN) {
      const signed = await this.prisma.ndaSign.count({ where: { projectId, userId } });
      if (!signed) throw new ForbiddenException('请先在项目页签署保密协议，再查看项目会议');
    }

    const rows = await this.prisma.meeting.findMany({
      where: {
        deletedAt: null,
        status: { not: 'CANCELLED' },
        OR: [{ projectId }, { extraProjectIds: { has: projectId } }],
      },
      orderBy: [{ startAt: 'desc' }],
      take: 60,
      select: {
        id: true, title: true, status: true, type: true, scope: true,
        startAt: true, endAt: true, ownerId: true, minutes: true,
        owner: { select: { id: true, name: true } },
      },
    });

    // 就绪度与条目数一次批量聚合，避免 N+1（与会议列表同口径）
    const ids = rows.map((r) => r.id);
    const [matAgg, itemAgg] = ids.length
      ? await Promise.all([
          this.prisma.meetingMaterial.groupBy({ by: ['meetingId', 'status'], where: { meetingId: { in: ids } }, _count: true }),
          this.prisma.meetingItem.groupBy({ by: ['meetingId'], where: { meetingId: { in: ids } }, _count: true }),
        ])
      : [[], []];
    const matMap = new Map<string, { total: number; submitted: number }>();
    for (const g of matAgg as Array<{ meetingId: string; status: string; _count: number }>) {
      const cur = matMap.get(g.meetingId) ?? { total: 0, submitted: 0 };
      cur.total += g._count;
      if (g.status === 'SUBMITTED') cur.submitted += g._count;
      matMap.set(g.meetingId, cur);
    }
    const itemMap = new Map<string, number>();
    for (const g of itemAgg as Array<{ meetingId: string; _count: number }>) itemMap.set(g.meetingId, g._count);

    const now = new Date();
    const mapped = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      type: r.type,
      scope: r.scope,
      startAt: r.startAt,
      endAt: r.endAt,
      ownerId: r.ownerId,
      ownerName: r.owner?.name ?? '',
      minutesReady: !!(r.minutes ?? '').trim(),
      materialReady: matMap.get(r.id) ?? { total: 0, submitted: 0 },
      itemCount: itemMap.get(r.id) ?? 0,
    }));
    const past = mapped.filter((x) => new Date(x.startAt).getTime() <= now.getTime()).slice(0, 30);
    const upcoming = mapped
      .filter((x) => new Date(x.startAt).getTime() > now.getTime())
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
      .slice(0, 3);
    return { ok: true, projectId, projectName: project.name, past, upcoming, total: mapped.length };
  }

  // ============ 项目周报聚合视图（F27 / docs/meeting-prd.md §6.12） ============

  /** 北京口径某时刻所在自然周的周一 00:00（绝对时刻），与周报 periodStart 完全对齐 */
  private mondayOf(d: Date): Date {
    return beijingMondayOf(d);
  }

  /** 某「绝对时刻的北京周一」对应的北京日期字符串（YYYY-MM-DD），用作周期标签与 Setting 缓存键 */
  private mondayBjDate(monday: Date): string {
    return beijingMondayDate(monday);
  }

  /** 周报正文取值优先级（§6.2 / §6.12.3，与会议材料一致）：correctedContent > rawContent > content JSON 结构化拼接 */
  private reportBody(r: any): string {
    if (!r) return '';
    const fixed = String(r.correctedContent ?? '').trim();
    if (fixed) return fixed;
    const raw = String(r.rawContent ?? '').trim();
    if (raw) return raw;
    const c: any = r.content;
    if (!c || typeof c !== 'object') return '';
    const parts: string[] = [];
    if (c.summary) parts.push(`摘要：${String(c.summary).trim()}`);
    for (const s of Array.isArray(c.sections) ? c.sections : []) {
      const t = String(s?.title ?? '').trim();
      const items = Array.isArray(s?.items)
        ? s.items.map((x: any) => `- ${typeof x === 'string' ? x : String(x?.text ?? x?.content ?? '')}`).filter((l: string) => l.length > 2).join('\n')
        : '';
      if (t || items) parts.push([t, items].filter(Boolean).join('\n'));
    }
    if (c.nextWeek) parts.push(`下周计划：\n${String(c.nextWeek).trim()}`);
    return parts.join('\n\n').trim();
  }

  /**
   * 一人一周多份周报时，为项目视图择一份：优先本项目归属 P:{projectId} → 回落个人周报 ''（标“个人（未分项目）”）→ 其他归属
   */
  private selectProjectWeekly(reports: any[], projectId: string): Map<string, { rep: any; scopeNote: string | null }> {
    const byOwner = new Map<string, any[]>();
    for (const r of reports) {
      const oid = r.ownerId as string;
      const arr = byOwner.get(oid);
      if (arr) arr.push(r);
      else byOwner.set(oid, [r]);
    }
    const projKey = `P:${projectId}`;
    const out = new Map<string, { rep: any; scopeNote: string | null }>();
    for (const [oid, list] of byOwner) {
      const inProj = list.find((r) => r.scopeKey === projKey);
      if (inProj) { out.set(oid, { rep: inProj, scopeNote: null }); continue; }
      const personal = list.find((r) => !r.scopeKey || r.scopeKey === '');
      if (personal) { out.set(oid, { rep: personal, scopeNote: '个人（未分项目）' }); continue; }
      out.set(oid, list[0] ? { rep: list[0], scopeNote: '其他归属' } : { rep: null, scopeNote: null });
    }
    return out;
  }

  /** 项目周报访问门槛：可见性 + 保密项目需先签 NDA（与 projectMeetings 同一收口） */
  private async loadProjectForWeekly(userId: string, role: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, name: true, confidential: true, ownerId: true,
        members: { select: { userId: true } },
        departments: { select: { department: { select: { id: true, name: true, leaderId: true, managerIds: true, sortOrder: true } } } },
      },
    });
    if (!project) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN && !(await this.canView(projectId, userId))) {
      throw new ForbiddenException('仅项目负责人或项目成员可查看项目周报');
    }
    if (project.confidential && role !== Role.ADMIN) {
      const signed = await this.prisma.ndaSign.count({ where: { projectId, userId } });
      if (!signed) throw new ForbiddenException('请先在项目页签署保密协议，再查看项目周报');
    }
    return project;
  }

  /**
   * 项目周报聚合视图（§6.12.2 排序：部门负责人 → 项目负责人 → 其余成员 → 无周报者置底）
   * - periodStart 传任意日期都归一到其所在北京自然周周一；不传取本周
   * - 取数严格走周报正文优先级；AI 总结读 Setting 缓存（无则 null，前端按需触发）
   */
  async projectWeeklyReport(userId: string, role: string, projectId: string, periodStart?: string) {
    const project = await this.loadProjectForWeekly(userId, role, projectId);
    const base = periodStart ? new Date(periodStart) : new Date();
    const monday = this.mondayOf(Number.isNaN(base.getTime()) ? new Date() : base);

    // 成员 = 项目成员 ∪ 负责人（去重）
    const memberIds = [...new Set([project.ownerId, ...project.members.map((m) => m.userId)])];
    const users = await this.prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, name: true, avatar: true, departmentId: true, department: { select: { name: true } } },
    });
    // 关联部门管理者（负责人 + 共管人）：userId -> { deptName, sortOrder }（同一人管多个关联部门时取 sortOrder 最小者代表其档位）
    const deptLeaders = new Map<string, { deptName: string; sortOrder: number }>();
    for (const pd of project.departments.map((x) => x.department).filter(Boolean)) {
      for (const aid of deptAuthorityIds(pd)) {
        if (!memberIds.includes(aid)) continue;
        const cur = deptLeaders.get(aid);
        if (!cur || pd.sortOrder < cur.sortOrder) deptLeaders.set(aid, { deptName: pd.name, sortOrder: pd.sortOrder });
      }
    }

    // 本周周报一次批量取（一人一周可多份：项目/部门/个人），按人择一：优先本项目归属，其次个人周报
    const reports = await this.prisma.report.findMany({
      where: { type: 'WEEKLY', ownerId: { in: memberIds }, periodStart: monday },
    });
    const picked = this.selectProjectWeekly(reports, projectId);

    const ranked = users
      .map((u) => {
        const { rep, scopeNote } = picked.get(u.id) ?? { rep: null, scopeNote: null };
        const content = this.reportBody(rep);
        const submitted = !!(rep && content);
        let tier = 3;
        let roleTag = 'MEMBER';
        let deptOrder = 9999;
        if (deptLeaders.has(u.id)) {
          tier = 1;
          roleTag = 'DEPT_LEADER';
          deptOrder = deptLeaders.get(u.id)!.sortOrder;
        } else if (u.id === project.ownerId) {
          tier = 2;
          roleTag = 'PROJ_OWNER';
        }
        return {
          userId: u.id,
          name: u.name,
          avatar: u.avatar ?? null,
          departmentName: u.department?.name ?? deptLeaders.get(u.id)?.deptName ?? null,
          roleTag,
          submitted,
          source: rep ? ((rep.correctedContent ?? '').trim() ? 'AI' : 'MANUAL') : null,
          reportId: rep?.id ?? null,
          scopeNote,
          content,
          isSelf: u.id === userId,
          _tier: tier,
          _deptOrder: deptOrder,
          _deptName: u.department?.name ?? '',
        };
      })
      .sort((a, b) => {
        if (a.submitted !== b.submitted) return a.submitted ? -1 : 1; // 无周报的人整体置底（第四档）
        if (a._tier !== b._tier) return a._tier - b._tier; // 部门负责人 > 项目负责人 > 成员
        if (a._tier === 1 && a._deptOrder !== b._deptOrder) return a._deptOrder - b._deptOrder; // 多部门负责人按 Department.sortOrder
        const d = String(a._deptName).localeCompare(String(b._deptName), 'zh-Hans-CN');
        return d !== 0 ? d : String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
      });

    const submitted = ranked.filter((s) => s.submitted).length;
    const total = ranked.length;
    const sections = ranked.map(({ _tier, _deptOrder, _deptName, ...rest }) => rest);
    const bjDate = this.mondayBjDate(monday);
    const summary = await this.getCachedWeeklySummary(projectId, bjDate);

    return {
      projectId,
      projectName: project.name,
      periodStart: monday,
      weekLabel: `${cnWeekLabel(monday)} · ${isoWeekOf(monday)}`,
      weekDate: bjDate,
      total,
      readiness: { total, submitted, missing: total - submitted },
      summary,
      sections,
    };
  }

  private weeklySummaryKey(projectId: string, bjDate: string) {
    return `projectWeeklySummary:${projectId}:${bjDate}`;
  }

  /** 读取 Setting 缓存的项目周报 AI 总结（key 带周期，缓存避重复计费） */
  private async getCachedWeeklySummary(projectId: string, bjDate: string) {
    const row = await this.prisma.setting.findUnique({ where: { key: this.weeklySummaryKey(projectId, bjDate) } });
    return (row?.value as { summary?: unknown } | undefined)?.summary ?? null;
  }

  /**
   * 生成 / 刷新项目周报 AI 总结（project.weekly.summary）
   * - refresh=false 且有缓存 → 直接返回缓存；AI 不可用/失败 → { ok:false, summary:null }（前端降级不阻断）
   * - 结果落 Setting KV：key=projectWeeklySummary:{projectId}:{北京周一}，不改 Project 表、零迁移
   */
  async weeklySummary(userId: string, role: string, projectId: string, periodStart?: string, refresh = false) {
    const project = await this.loadProjectForWeekly(userId, role, projectId);
    const base = periodStart ? new Date(periodStart) : new Date();
    const monday = this.mondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    const bjDate = this.mondayBjDate(monday);

    if (!refresh) {
      const cached = await this.getCachedWeeklySummary(projectId, bjDate);
      if (cached) return { ok: true, cached: true, summary: cached };
    }

    const memberIds = [...new Set([project.ownerId, ...project.members.map((m) => m.userId)])];
    const [users, reports] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, name: true, department: { select: { name: true } } },
      }),
      this.prisma.report.findMany({ where: { type: 'WEEKLY', ownerId: { in: memberIds }, periodStart: monday } }),
    ]);
    const userName = new Map(users.map((u) => [u.id, u]));
    const picked = this.selectProjectWeekly(reports, projectId);

    let reportsText = '';
    const missing: string[] = [];
    for (const id of memberIds) {
      const u = userName.get(id);
      if (!u) continue;
      const dept = u.department?.name ?? '未分组';
      const body = this.reportBody(picked.get(id)?.rep);
      if (!body) {
        missing.push(`${u.name}（${dept}）`);
        continue;
      }
      const line = `【${u.name}｜${dept}】\n${body.slice(0, 1200)}`;
      if (reportsText.length >= 9000) break; // 输入预算约 9000 字符，超限保留更靠前的
      reportsText = reportsText ? `${reportsText}\n\n${line}` : line;
    }
    if (!reportsText) {
      return { ok: false, summary: null, reason: missing.length ? '本周尚无人提交周报，无法总结' : '本周暂无周报' };
    }

    const ai = await this.ai.generateJson<{
      overview?: string;
      progress?: string[];
      nextWeek?: string[];
      risks?: string[];
      attention?: { name?: string; dept?: string; point?: string }[];
    }>('project.weekly.summary', {
      projectName: project.name,
      weekLabel: `${cnWeekLabel(monday)} · ${isoWeekOf(monday)}`,
      reports: reportsText,
      missing: missing.join('、') || '（无，全员已提交）',
    });
    if (!ai) return { ok: false, summary: null, reason: 'AI 总结生成失败，可直接阅读下方成员周报' };

    const key = this.weeklySummaryKey(projectId, bjDate);
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: { summary: ai, generatedAt: new Date().toISOString() } as any },
      update: { value: { summary: ai, generatedAt: new Date().toISOString() } as any },
    });
    this.logger.log(`项目周报 AI 总结完成 project=${projectId} week=${bjDate} 已交${memberIds.length - missing.length}/共${memberIds.length}`);
    return { ok: true, cached: false, summary: ai };
  }

  /** 是否可查看项目（管理员 / 负责人 / 项目成员） */
  private async canView(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: { where: { userId } } },
    });
    if (!project) return false;
    return project.ownerId === userId || project.members.length > 0;
  }

  /**
   * 进展 → 任务回链（从进展创建任务或关联已有任务后调用）
   * - 校验进展与任务存在、属于同一项目、操作者为项目成员/管理员
   * - 回链后前端进展条目以不同颜色标记为「已转任务」
   */
  async linkUpdateTask(updateId: string, taskId: string, userId: string, role: string) {
    const update = await this.prisma.projectUpdate.findUnique({
      where: { id: updateId },
      select: { id: true, projectId: true },
    });
    if (!update) throw new NotFoundException('进展不存在');
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true },
    });
    if (!task) throw new NotFoundException('任务不存在');
    if (task.projectId !== update.projectId) {
      throw new BadRequestException('任务与进展不在同一个项目');
    }
    if (role !== Role.ADMIN && !(await this.canView(update.projectId, userId))) {
      throw new ForbiddenException('仅项目成员可操作该项目进展');
    }
    return this.prisma.projectUpdate.update({
      where: { id: updateId },
      data: { taskId },
      select: { id: true, taskId: true },
    });
  }

  /**
   * 合并两条项目进展（同一项目内拖拽合并）
   * - 仅限同一项目；目标进展保留（id 不变），被拖动的源进展删除
   * - 正文按时间先后拼接；keyPoints 去重合并；消息窗口取并集（periodEnd 取较晚，保证 AI 增量窗口不回退）
   * - 已转任务标记保留（目标优先，目标未转任务时继承源）
   */
  async mergeUpdates(sourceId: string, targetId: string, userId: string, role: string) {
    if (!sourceId || !targetId || sourceId === targetId) {
      throw new BadRequestException('请选择两条不同的进展进行合并');
    }
    const [source, target] = await Promise.all([
      this.prisma.projectUpdate.findUnique({ where: { id: sourceId } }),
      this.prisma.projectUpdate.findUnique({ where: { id: targetId } }),
    ]);
    if (!source || !target) throw new NotFoundException('进展不存在');
    if (source.projectId !== target.projectId) {
      throw new BadRequestException('仅支持合并同一项目内的进展');
    }
    if (role !== Role.ADMIN && !(await this.canView(source.projectId, userId))) {
      throw new ForbiddenException('仅项目成员可操作该项目进展');
    }
    const [first, second] = source.periodEnd <= target.periodEnd ? [source, target] : [target, source];
    const content = [first.content.trim(), second.content.trim()].filter(Boolean).join('\n\n');
    const keyPoints = [...new Set([...first.keyPoints, ...second.keyPoints])].slice(0, 6);
    const periodStart = first.periodStart < second.periodStart ? first.periodStart : second.periodStart;
    const periodEnd = first.periodEnd > second.periodEnd ? first.periodEnd : second.periodEnd;
    return this.prisma.$transaction(async (tx) => {
      const merged = await tx.projectUpdate.update({
        where: { id: target.id },
        data: {
          content,
          keyPoints,
          periodStart,
          periodEnd,
          groupName: target.groupName ?? source.groupName,
          taskId: target.taskId ?? source.taskId,
        },
      });
      await tx.projectUpdate.delete({ where: { id: source.id } });
      return merged;
    });
  }

  // ============ 项目排期计划（详情页「排期计划」页签）============
  // 一个项目按阶段铺开：需求评审 → 开发 → 测试 → 联调 → 上线 → 验收（可自定义）。
  // 与里程碑的区别：里程碑只有单个到期日（审批/健康度用），排期阶段是「开始~结束」区间 + 状态。

  /** 阶段状态：未开始 / 进行中 / 已完成 */
  private static readonly SCHEDULE_STATUS = ['PLANNED', 'DOING', 'DONE'];
  /** 单项目阶段条数上限（防误提交把表撑爆） */
  private static readonly SCHEDULE_MAX = 30;

  /** Date → 北京墙钟日期串 'YYYY-MM-DD'（行内日期字段都存 UTC 午夜，故等价于 toISOString 前缀） */
  private bjDateStr(v: Date | null | undefined): string | null {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** 排期总览：阶段列表（按开始日排序）+ 项目计划期 + 是否可编辑 + 各状态计数 */
  async schedule(projectId: string, userId: string, role: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ...this.visFilter(userId, role) },
      select: {
        id: true,
        name: true,
        ownerId: true,
        status: true,
        startDate: true,
        endDate: true,
        schedule: { orderBy: [{ sortOrder: 'asc' }, { startDate: 'asc' }] },
      },
    });
    if (!project) throw new NotFoundException('项目不存在或无权限');
    const canEdit = role === Role.ADMIN || (await this.canManage(projectId, userId));
    const today = this.bjDateStr(new Date());
    const items = project.schedule.map((s) => {
      const start = this.bjDateStr(s.startDate)!;
      const end = this.bjDateStr(s.endDate)!;
      // 工期按「含首尾」算：9-01~9-03 = 3 天
      const days = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1);
      const overdue = s.status !== 'DONE' && today! > end;
      return {
        id: s.id,
        name: s.name,
        startDate: start,
        endDate: end,
        status: s.status,
        note: s.note,
        sortOrder: s.sortOrder,
        days,
        overdue,
      };
    });
    return {
      projectId: project.id,
      projectName: project.name,
      projectStatus: project.status,
      startDate: this.bjDateStr(project.startDate),
      endDate: this.bjDateStr(project.endDate),
      today,
      canEdit,
      items,
      summary: {
        total: items.length,
        done: items.filter((x) => x.status === 'DONE').length,
        doing: items.filter((x) => x.status === 'DOING').length,
        planned: items.filter((x) => x.status === 'PLANNED').length,
        overdue: items.filter((x) => x.overdue).length,
      },
    };
  }

  /** 保存排期（全量替换；仅项目负责人/管理员）：按传入顺序落 sortOrder，校验名称与起止日 */
  async saveSchedule(
    projectId: string,
    userId: string,
    role: string,
    items: { name?: string; startDate?: string; endDate?: string; status?: string; note?: string | null }[],
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('项目不存在');
    if (role !== Role.ADMIN) await this.assertCanManage(projectId, userId);
    if (!Array.isArray(items)) throw new BadRequestException('排期须为阶段数组');
    if (items.length > ProjectsService.SCHEDULE_MAX) {
      throw new BadRequestException(`阶段最多 ${ProjectsService.SCHEDULE_MAX} 条`);
    }
    const rows = items.map((it, i) => {
      const name = String(it?.name ?? '').trim();
      if (!name) throw new BadRequestException(`第 ${i + 1} 个阶段缺名称`);
      const startDate = this.parseDateOrNull(it?.startDate);
      const endDate = this.parseDateOrNull(it?.endDate);
      if (!startDate || !endDate) throw new BadRequestException(`阶段「${name}」的开始/结束日期格式需为 YYYY-MM-DD`);
      if (endDate.getTime() < startDate.getTime()) {
        throw new BadRequestException(`阶段「${name}」的结束日不能早于开始日`);
      }
      const status = String(it?.status ?? 'PLANNED').toUpperCase();
      if (!ProjectsService.SCHEDULE_STATUS.includes(status)) {
        throw new BadRequestException(`阶段「${name}」的状态不合法`);
      }
      return {
        projectId,
        name: name.slice(0, 40),
        startDate,
        endDate,
        status,
        note: (it?.note ?? '') ? String(it.note).trim().slice(0, 200) : null,
        sortOrder: i,
      };
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.projectScheduleItem.deleteMany({ where: { projectId } });
      if (rows.length) await tx.projectScheduleItem.createMany({ data: rows });
    });
    return this.schedule(projectId, userId, role);
  }

  /** 供 update/成员管理操作权限校验使用 */
  async assertCanManage(projectId: string, userId: string) {
    if (!(await this.canManage(projectId, userId))) {
      throw new ForbiddenException('仅管理员或项目负责人可执行该操作');
    }
  }

  /** 是否可管理成员（系统管理员 / 项目负责人 OWNER / 主要关联部门负责人或共管人） */
  async canManageMembers(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { where: { userId, role: 'OWNER' } },
        departments: { where: { department: ledDeptWhere(userId) } },
      },
    });
    if (!project) return false;
    return (
      project.ownerId === userId ||
      project.members.length > 0 ||
      project.departments.length > 0
    );
  }

  /** 供成员管理操作权限校验使用 */
  async assertCanManageMembers(projectId: string, userId: string) {
    if (!(await this.canManageMembers(projectId, userId))) {
      throw new ForbiddenException('仅管理员、项目负责人或部门负责人可管理成员');
    }
  }

  async addMember(projectId: string, operatorId: string, userId: string, isAdmin = false) {
    if (!isAdmin) await this.assertCanManageMembers(projectId, operatorId);
    const exists = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (exists) return exists;
    return this.prisma.projectMember.create({ data: { projectId, userId, role: 'MEMBER' } });
  }

  async removeMember(projectId: string, operatorId: string, userId: string, isAdmin = false) {
    if (!isAdmin) await this.assertCanManageMembers(projectId, operatorId);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) throw new NotFoundException('项目不存在');
    if (userId === project.ownerId) {
      throw new BadRequestException('不能移除项目负责人');
    }
    return this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
  }

  /** 设置项目成员岗位（产品经理/工程师/运维等；负责人、部门负责人或系统管理员） */
  async setMemberPosition(
    projectId: string,
    operatorId: string,
    memberUserId: string,
    position: string | null,
    isAdmin = false,
  ) {
    if (!isAdmin) await this.assertCanManageMembers(projectId, operatorId);
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: memberUserId } },
    });
    if (!member) throw new NotFoundException('成员不存在');
    return this.prisma.projectMember.update({
      where: { id: member.id },
      data: { position: position?.trim() || null },
    });
  }

  /** 项目负责人转让（仅当前负责人或系统管理员）；原负责人自动降为普通成员保持可见 */
  async transferOwner(projectId: string, operatorId: string, newOwnerId: string, isAdmin = false) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, ownerId: true } });
    if (!project) throw new NotFoundException('项目不存在');
    if (!isAdmin && project.ownerId !== operatorId) {
      throw new ForbiddenException('仅项目负责人或系统管理员可转让负责人');
    }
    if (newOwnerId === project.ownerId) {
      throw new BadRequestException('该项目负责人已经是该用户');
    }
    const newOwner = await this.prisma.user.findUnique({ where: { id: newOwnerId }, select: { id: true, role: true } });
    if (!newOwner) throw new NotFoundException('用户不存在');
    return this.prisma.$transaction(async (tx) => {
      // 原负责人降为普通成员（保持项目可见）
      const oldOwnerMember = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: project.ownerId } },
      });
      if (!oldOwnerMember) {
        await tx.projectMember.create({ data: { projectId, userId: project.ownerId, role: 'MEMBER' } });
      } else if (oldOwnerMember.role !== 'MEMBER') {
        await tx.projectMember.update({ where: { id: oldOwnerMember.id }, data: { role: 'MEMBER' } });
      }
      // 新负责人的成员记录删除（负责人身份由 ownerId 表达）
      await tx.projectMember.deleteMany({ where: { projectId, userId: newOwnerId } });
      const updated = await tx.project.update({ where: { id: projectId }, data: { ownerId: newOwnerId } });
      // 新负责人若为普通成员，升级为项目负责人
      if (newOwner.role === Role.MEMBER) {
        await tx.user.update({ where: { id: newOwnerId }, data: { role: Role.PROJECT_LEADER } });
      }
      return updated;
    }).then(async (p) => {
      // 原负责人不再负责任何项目且非部门负责人/管理员时降为普通成员
      await this.maybeDowngradeProjectLeader(project.ownerId);
      return p;
    });
  }

  /** 用户若不再负责任何未归档项目、且非部门负责人/管理员、当前为项目负责人，则降为普通成员 */
  private async maybeDowngradeProjectLeader(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || user.role !== Role.PROJECT_LEADER) return;
    const stillOwning = await this.prisma.project.count({ where: { ownerId: userId, archived: false } });
    if (stillOwning > 0) return;
    const stillLeading = await this.prisma.department.count({ where: ledDeptWhere(userId) });
    if (stillLeading > 0) return;
    await this.prisma.user.update({ where: { id: userId }, data: { role: Role.MEMBER } });
  }

  async createBoard(projectId: string, name: string) {
    // 与项目创建一致：新看板自动带 3 个标准列，建完即可使用
    return this.prisma.kanbanBoard.create({
      data: {
        projectId,
        name,
        columns: {
          create: [
            { name: '待办', sortOrder: 0 },
            { name: '进行中', sortOrder: 1 },
            { name: '已完成', sortOrder: 2 },
          ],
        },
      },
      include: { columns: true },
    });
  }

  async createColumn(boardId: string, name: string) {
    const count = await this.prisma.kanbanColumn.count({ where: { boardId } });
    return this.prisma.kanbanColumn.create({
      data: { boardId, name, sortOrder: count },
    });
  }

  async updateColumn(
    columnId: string,
    data: { name?: string; sortOrder?: number; wipLimit?: number | null },
  ) {
    return this.prisma.kanbanColumn.update({ where: { id: columnId }, data });
  }

  async deleteColumn(columnId: string) {
    const col = await this.prisma.kanbanColumn.findUnique({ where: { id: columnId } });
    if (!col) throw new NotFoundException('列不存在');
    const tasks = await this.prisma.task.count({ where: { columnId } });
    if (tasks > 0) {
      throw new BadRequestException('该列下还有任务，请先移动任务再删除');
    }
    return this.prisma.kanbanColumn.delete({ where: { id: columnId } });
  }

  /** 删除项目（仅管理员）：看板/任务/进展/复盘/文档/SOP 等子关联由 schema 级联清除，日报保留（projectId 置空） */
  async remove(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('项目不存在');
    // 软删除：移入回收站（不级联清除数据），可在回收站恢复
    await this.prisma.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
    return { ok: true };
  }

  /** 回收站：仅管理员，返回已软删除项目（含删除时间） */
  async trash(userId: string, role: string) {
    if (role !== Role.ADMIN) throw new ForbiddenException('仅系统管理员可查看回收站');
    const projects = await this.prisma.project.findMany({
      where: { deletedAt: { not: null } },
      include: { owner: { select: { id: true, name: true } } },
      orderBy: { deletedAt: 'desc' },
    });
    return projects.map((p) => this.flatten(p));
  }

  /** 从回收站恢复项目 */
  async restore(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('项目不存在');
    await this.prisma.project.update({ where: { id: projectId }, data: { deletedAt: null } });
    return { ok: true };
  }

  /** 彻底删除（不可恢复）：仅管理员，物理删除并级联清除看板/任务/进展/文档等 */
  async purge(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('项目不存在');
    await this.prisma.project.delete({ where: { id: projectId } });
    return { ok: true };
  }
}
