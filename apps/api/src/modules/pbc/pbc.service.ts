import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { DingtalkDmService } from '../integrations/dingtalk-dm.service';
import { AiService } from '../ai/ai.service';
import { rankExcludedUserIds } from '../../common/rank-exclude';
import { deptAuthorityIds, deptRosterWhere, isDeptAuthority, ledDeptWhere } from '../../common/dept-authority';
import { webLink } from '../../common/web-link';

/** 一条 PBC 计划事项：内容 + 分值；考核阶段追加逐条自评/上级评分字段（旧数据无这些字段即视为未评） */
export interface PbcItem {
  content: string;
  score: number;
  selfScore?: number | null; // 自评得分（0..score）
  selfReason?: string | null; // 自评理由
  leaderScore?: number | null; // 上级评分（0..score）
  leaderComment?: string | null; // 上级对该条的评语
}

/** 提交自评/上级评分时逐条传入的评分项（按 items 下标对齐） */
export interface PbcScoreInput {
  index: number;
  selfScore?: number;
  selfReason?: string;
  leaderScore?: number;
  leaderComment?: string;
}

/** PBC 审批状态 */
export type PbcStatusLite = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

/** 'YYYY-MM'（北京口径自然月）格式校验 */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 组装行所需的归属成员信息 */
interface OwnerLite {
  id: string;
  name: string;
  role: string;
  departmentId: string | null;
  department: { name: string; leaderId: string | null; managerIds: string[] } | null;
}

/** 前端展示的统一 PBC 行 */
export interface PbcViewRow {
  userId: string;
  name: string;
  department: string | null;
  hasPbc: boolean;
  total: number;
  itemCount: number;
  items: PbcItem[];
  status: PbcStatusLite;
  approverName: string | null;
  approvedAt: Date | null;
  reviewComment: string | null;
  canApprove: boolean;
  isSelf: boolean;
  updatedAt: Date | null;
  decomposedAt: Date | null;
  /** 是否已确认创建过分解任务（供列表「已分解/未分解」标识） */
  decomposed: boolean;
  // ---- 考核轴（与上方计划审批 status 独立） ----
  reviewStatus: 'NOT_STARTED' | 'SELF_DONE' | 'LEADER_DONE';
  selfTotal: number | null;
  leaderTotal: number | null;
  selfSummary: string | null;
  leaderComment: string | null;
  pbcLeaderId: string | null;
  pbcLeaderName: string | null;
  /** 自评提交时间 / 上级复核定稿时间 */
  selfAt: Date | null;
  leaderAt: Date | null;
  /** 当前查看者（本人）能否提交自评：计划已提交/已批 且尚未定稿 */
  canSelfReview: boolean;
  /** 当前查看者能否提交上级评分：我是其打分上级/管理员 且成员已自评待评 */
  canLeaderReview: boolean;
}

/** PBC 分解出的任务（预览 / 确认建任务共用；dueDate 为 'YYYY-MM-DD'；projectId 为该条任务选定的关联项目） */
export interface PbcTaskPreview {
  title: string;
  description: string;
  dueDate: string;
  projectId?: string;
}

/** 排行榜条目（仅统计上级评分已定稿 LEADER_DONE 的成员，按 leaderTotal 降序） */
export interface PbcRankEntry {
  rank: number;
  userId: string;
  name: string;
  department: string;
  leaderTotal: number;
  selfTotal: number | null;
}

@Injectable()
export class PbcService {
  private readonly logger = new Logger(PbcService.name);

  /** 补录期「上级+日期」汇总通知去重表：key=`leaderId:YYYY-MM-DD`，value=当天已发生的补录次数 */
  private readonly reviewNoticeSent = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private dm: DingtalkDmService,
    private ai: AiService,
  ) {}

  /** 当前用户某月 PBC：无记录返回空计划（items: [], total: 0, status: DRAFT）；附带考核轴与自评可用信息 */
  async getMine(userId: string, month: string) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const row = await this.prisma.pbc.findUnique({ where: { ownerId_month: { ownerId: userId, month: m } } });
    const items = (row?.items as unknown as PbcItem[]) ?? [];
    const status = (row?.status as PbcStatusLite) ?? 'DRAFT';
    const reviewStatus = (row?.reviewStatus as 'NOT_STARTED' | 'SELF_DONE' | 'LEADER_DONE') ?? 'NOT_STARTED';
    const planReady = status === 'SUBMITTED' || status === 'APPROVED';
    const user = (await this.prisma.user.findUnique({ where: { id: userId }, select: this.ownerSelect() })) as unknown as OwnerLite | null;
    const leaderOptions = await this.leaderOptions(userId);
    // ---- 时间窗口（固定 PBC 节奏：计划=当月1~10号；自评=月末3天~次月5号；ADMIN 豁免） ----
    const winAdmin = user?.role === 'ADMIN';
    const planWin = this.planWindow(m, winAdmin);
    const selfWin = this.selfReviewWindow(m, winAdmin);
    const defaultLeaderId = await this.resolveDefaultLeaderId(userId);
    return {
      month: m,
      items,
      total: row?.total ?? 0,
      status,
      locked: status === 'APPROVED',
      approverName: row?.approvedById ? await this.userName(row.approvedById) : null,
      approvedAt: row?.approvedAt ?? null,
      reviewComment: row?.reviewComment ?? null,
      reviewerName: row?.reviewedById ? await this.userName(row.reviewedById) : null,
      updatedAt: row?.updatedAt ?? null,
      // ---- 考核轴 ----
      reviewStatus,
      selfTotal: row?.selfTotal ?? null,
      leaderTotal: row?.leaderTotal ?? null,
      selfSummary: row?.selfSummary ?? null,
      leaderComment: row?.leaderComment ?? null,
      selfAt: row?.selfAt ?? null,
      leaderAt: row?.leaderAt ?? null,
      pbcLeaderId: row?.pbcLeaderId ?? null,
      pbcLeaderName: row?.pbcLeaderId ? await this.userName(row.pbcLeaderId) : null,
      defaultLeaderId,
      leaderOptions,
      // 本人：计划已提交/已批 且已有事项 且尚未定稿 → 可提交/修改自评
      // 不限时间：自评窗口只是「原定节奏」，历史月份随时可以补录/修改（仅定稿后锁定）
      canSelfReview: planReady && items.length > 0 && reviewStatus !== 'LEADER_DONE',
      selfReviewEditable: planReady && items.length > 0 && reviewStatus !== 'LEADER_DONE',
      // 本人就是自己的打分上级（且已自评）→ 可自评后评分（如 ADMIN 自己）
      canLeaderReview: reviewStatus === 'SELF_DONE' && (row?.pbcLeaderId === userId || user?.role === 'ADMIN'),
      // ---- 时间窗口标志（仅供前端做参考提示，不再阻断自评） ----
      planWindowOpen: planWin.open,
      planWindowHint: planWin.hint,
      selfReviewWindowOpen: selfWin.open,
      selfReviewWindow: selfWin.windowText,
      // 最近一次「撤销定稿」留痕（有则展示给本人，说明分数为何回到待审核）
      lastRevoke: await this.lastRevokeOf(userId, m),
    };
  }

  /**
   * 默认打分上级：直属上级（reportsToId、启用）→ 主部门负责人（非本人）→ 部门共管人（非本人）→ 最早注册的 ADMIN（非本人）→ null
   */
  async resolveDefaultLeaderId(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { departmentId: true, reportsTo: { select: { id: true, active: true } } },
    });
    if (!u) return null;
    if (u.reportsTo?.active) return u.reportsTo.id;
    if (u.departmentId) {
      // 负责人不在/就是本人时依次回退共管人（大部门常设多人），最后才是 ADMIN；都要求在职
      const dept = await this.prisma.department.findUnique({
        where: { id: u.departmentId },
        select: { leaderId: true, managerIds: true },
      });
      for (const candId of deptAuthorityIds(dept)) {
        if (candId === userId) continue;
        const cand = await this.prisma.user.findUnique({ where: { id: candId }, select: { active: true } });
        if (cand?.active) return candId;
      }
    }
    const admin = await this.prisma.user.findFirst({
      where: { role: 'ADMIN', active: true, id: { not: userId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return admin?.id ?? null;
  }

  /**
   * 打分上级候选下拉：默认上级 + 各部门负责人/共管人 + 管理员（去重、排除本人），附来源标签
   */
  async leaderOptions(userId: string): Promise<{ id: string; name: string; label: string }[]> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { reportsToId: true, departmentId: true, role: true },
    });
    const out: { id: string; name: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = async (id: string | null | undefined, label: string) => {
      if (!id || id === userId || seen.has(id)) return;
      const person = await this.prisma.user.findUnique({ where: { id }, select: { id: true, name: true, active: true } });
      if (!person?.active) return;
      seen.add(id);
      out.push({ id: person.id, name: person.name, label });
    };
    await push(u?.reportsToId, '直属上级');
    if (u?.departmentId) {
      const dept = await this.prisma.department.findUnique({
        where: { id: u.departmentId },
        select: { leaderId: true, managerIds: true },
      });
      for (const id of deptAuthorityIds(dept)) await push(id, '部门负责人');
    }
    const depts = await this.prisma.department.findMany({
      where: { OR: [{ leaderId: { not: null } }, { managerIds: { isEmpty: false } }] },
      select: { leaderId: true, managerIds: true },
    });
    for (const d of depts) for (const id of deptAuthorityIds(d)) await push(id, '部门负责人');
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    for (const a of admins) await push(a.id, '管理员');
    return out;
  }

  /**
   * 保存当前用户某月 PBC（反复编辑覆盖）
   * - 去掉内容为空的行；若仍有事项则分值合计必须恰为 100
   * - 全部为空视为清空该月计划（status=DRAFT）；有内容即视为「提交审批」（status=SUBMITTED）
   * - 审批通过（APPROVED）后锁定，成员不可再改，除非审批人「允许修改」（撤回）
   */
  async saveMine(userId: string, month: string, items: PbcItem[]) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    if (!Array.isArray(items)) throw new BadRequestException('计划事项格式错误');
    const m = month.trim();
    const existing = await this.prisma.pbc.findUnique({ where: { ownerId_month: { ownerId: userId, month: m } } });
    if (existing?.status === 'APPROVED') {
      const approver = existing.approvedById ? await this.userName(existing.approvedById) : null;
      throw new BadRequestException(`该月 PBC 已由${approver ? `「${approver}」` : '负责人'}审批通过并锁定，如需修改请让对方「允许修改」`);
    }
    // 计划填写窗口：只能在当月 1~10 号填写/提交本月计划（ADMIN 豁免）
    const planActor = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    const pw = this.planWindow(m, planActor?.role === 'ADMIN');
    if (!pw.open) throw new BadRequestException(pw.hint);
    const cleaned: PbcItem[] = items
      .map((it) => ({ content: String(it?.content ?? '').trim(), score: Number(it?.score ?? 0) }))
      .filter((it) => it.content);
    for (const it of cleaned) {
      if (!Number.isFinite(it.score) || it.score < 0 || it.score > 100) {
        throw new BadRequestException('每项分值须为 0-100 之间的数字');
      }
    }
    const total = cleaned.reduce((s, it) => s + it.score, 0);
    if (cleaned.length && total !== 100) {
      throw new BadRequestException(`所有事项分值合计须等于 100，当前为 ${total}`);
    }
    const status: PbcStatusLite = cleaned.length ? 'SUBMITTED' : 'DRAFT';
    const row = await this.prisma.pbc.upsert({
      where: { ownerId_month: { ownerId: userId, month: m } },
      create: { ownerId: userId, month: m, items: cleaned as any, total, status },
      // 重新提交（含被退回后修改重提）：清空上一次的退回意见与审批痕迹，回到待审批
      update: { items: cleaned as any, total, status, reviewComment: null, reviewedById: null, reviewedAt: null, approvedById: null, approvedAt: null },
    });
    // 成员写完（非清空）PBC 后实时钉钉私聊部门负责人（与日报/周报同一 reportNotifyLeader 开关 gating，fire-and-forget）
    if (cleaned.length) {
      const excerpt = [
        `${m} 月度 PBC（合计 ${total} 分，${cleaned.length} 项）· 待审批`,
        ...cleaned.map((it) => `· ${it.content}（${it.score}分）`),
      ].join('\n');
      void this.dm.notifyDeptLeader(userId, { kind: '月度 PBC', excerpt });
    }
    return {
      month: m,
      items: (row.items as unknown as PbcItem[]) ?? [],
      total: row.total,
      status: row.status as PbcStatusLite,
      locked: row.status === 'APPROVED',
      updatedAt: row.updatedAt,
    };
  }

  /**
   * 组装 PBC 展示行（供团队概览 / 部门互看共用）
   * - 以成员为行（含未填者），附审批状态、审批人名、当前查看者能否审批
   */
  private async assemble(viewer: { id: string; role: string }, owners: OwnerLite[], month: string): Promise<PbcViewRow[]> {
    const rows = await this.prisma.pbc.findMany({
      where: { month, ownerId: { in: owners.map((o) => o.id) } },
      select: { ownerId: true, items: true, total: true, status: true, approvedById: true, approvedAt: true, reviewComment: true, updatedAt: true, decomposedAt: true, reviewStatus: true, pbcLeaderId: true, selfSummary: true, selfTotal: true, leaderTotal: true, leaderComment: true, selfAt: true, leaderAt: true },
    });
    const byOwner = new Map(rows.map((r) => [r.ownerId, r]));
    // 批量解析审批人姓名
    const approverIds = [...new Set(rows.filter((r) => r.status === 'APPROVED' && r.approvedById).map((r) => r.approvedById as string))];
    const nameMap = new Map<string, string>();
    if (approverIds.length) {
      const users = await this.prisma.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } });
      for (const u of users) nameMap.set(u.id, u.name);
    }
    // 批量解析打分上级姓名（考核轴）
    const leaderIds = [...new Set(rows.filter((r) => r.pbcLeaderId).map((r) => r.pbcLeaderId as string))];
    const leaderNameMap = new Map<string, string>();
    if (leaderIds.length) {
      const lus = await this.prisma.user.findMany({ where: { id: { in: leaderIds } }, select: { id: true, name: true } });
      for (const u of lus) leaderNameMap.set(u.id, u.name);
    }
    return owners.map((o) => {
      const r = byOwner.get(o.id);
      const items = (r?.items as unknown as PbcItem[]) ?? [];
      const status = (r?.status as PbcStatusLite) ?? 'DRAFT';
      const reviewStatus = (r?.reviewStatus as 'NOT_STARTED' | 'SELF_DONE' | 'LEADER_DONE') ?? 'NOT_STARTED';
      const planReady = status === 'SUBMITTED' || status === 'APPROVED';
      const isLeader = !!r?.pbcLeaderId && r.pbcLeaderId === viewer.id;
      return {
        userId: o.id,
        name: o.name,
        department: o.department?.name ?? null,
        hasPbc: items.length > 0,
        total: r?.total ?? 0,
        itemCount: items.length,
        items,
        status,
        approverName: status === 'APPROVED' && r?.approvedById ? nameMap.get(r.approvedById) ?? null : null,
        approvedAt: status === 'APPROVED' ? r?.approvedAt ?? null : null,
        reviewComment: r?.reviewComment ?? null,
        canApprove: this.canViewerApprove(viewer, o),
        isSelf: o.id === viewer.id,
        updatedAt: r?.updatedAt ?? null,
        decomposedAt: r?.decomposedAt ?? null,
        decomposed: !!r?.decomposedAt,
        reviewStatus,
        selfTotal: r?.selfTotal ?? null,
        leaderTotal: r?.leaderTotal ?? null,
        selfSummary: r?.selfSummary ?? null,
        leaderComment: r?.leaderComment ?? null,
        pbcLeaderId: r?.pbcLeaderId ?? null,
        pbcLeaderName: r?.pbcLeaderId ? leaderNameMap.get(r.pbcLeaderId) ?? null : null,
        selfAt: r?.selfAt ?? null,
        leaderAt: r?.leaderAt ?? null,
        canSelfReview: o.id === viewer.id && planReady && items.length > 0 && reviewStatus !== 'LEADER_DONE',
        canLeaderReview: reviewStatus === 'SELF_DONE' && (isLeader || viewer.role === 'ADMIN'),
      };
    });
  }

  /**
   * 当前查看者能否审批该归属成员的 PBC
   * - 不能审批自己；ADMIN 的 PBC 不被审批（无上级）
   * - ADMIN 可审批除自己外任何人（含部门负责人）
   * - 部门负责人/共管人自己的 PBC 仅 ADMIN 可批（此处查看者非 ADMIN → false）
   * - 其余成员由其所在部门的管理者（负责人 ∪ 共管人）审批
   */
  private canViewerApprove(viewer: { id: string; role: string }, owner: OwnerLite): boolean {
    if (viewer.id === owner.id) return false;
    if (owner.role === 'ADMIN') return false;
    if (viewer.role === 'ADMIN') return true;
    if (owner.role === 'DEPT_LEADER') return false;
    return isDeptAuthority(owner.department, viewer.id);
  }

  /** 归属成员查询投影（含其所在部门的负责人与共管人，用于审批判定） */
  private ownerSelect() {
    return {
      id: true,
      name: true,
      role: true,
      departmentId: true,
      department: { select: { name: true, leaderId: true, managerIds: true } },
    } as const;
  }

  /**
   * 成员月度 PBC 概览（部门管理者/管理员在「工作管理 → PBC」团队视角查看）
   * - ADMIN：全体启用成员
   * - 部门管理者（负责人 ∪ 共管人）：其所管辖部门的成员（含额外加入本部门的）
   * - 额外补充：本月「我是其打分上级」的成员（跨部门也能看到，避免选了别部门上级就查不到人）
   * - 以成员为行（含本月未填 PBC 者），附审批状态与可操作性
   */
  async listForViewer(viewer: { id: string; role: string }, month: string): Promise<PbcViewRow[]> {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const isAdmin = viewer.role === 'ADMIN';
    let memberWhere: Prisma.UserWhereInput = { active: true };
    if (!isAdmin) {
      const led = await this.prisma.department.findMany({ where: ledDeptWhere(viewer.id), select: { id: true } });
      const ledIds = led.map((d) => d.id);
      // 我是其打分上级的成员（本月），跨部门可见
      const asLeader = await this.prisma.pbc.findMany({
        where: { month: m, pbcLeaderId: viewer.id },
        select: { ownerId: true },
      });
      const ownerIds = [...new Set(asLeader.map((r) => r.ownerId))];
      const ors: Prisma.UserWhereInput[] = [];
      if (ledIds.length) ors.push(deptRosterWhere(ledIds));
      if (ownerIds.length) ors.push({ id: { in: ownerIds } });
      if (!ors.length) return [];
      memberWhere = { active: true, OR: ors };
    }
    const owners = (await this.prisma.user.findMany({
      where: memberWhere,
      select: this.ownerSelect(),
      orderBy: { name: 'asc' },
    })) as unknown as OwnerLite[];
    return this.assemble(viewer, owners, m);
  }

  /**
   * 待我审核清单（「工作管理 → PBC → 待我审核」工作台取数）
   * - 非 ADMIN：本月/各月中 pbcLeaderId = 我 的记录
   * - ADMIN：全部已自评待复核 + 已定稿（便于抽查；也允许管理员代打分）
   * - month 省略时返回所有相关月份（补录会让老月份一起涌进来）
   */
  async reviewQueue(
    me: { id: string; role: string },
    month?: string,
  ): Promise<{ months: string[]; pending: number; rows: (PbcViewRow & { month: string })[] }> {
    const m = String(month ?? '').trim();
    if (m && !MONTH_RE.test(m)) throw new BadRequestException('月份格式须为 YYYY-MM');
    const where: Prisma.PbcWhereInput = { reviewStatus: { in: ['SELF_DONE', 'LEADER_DONE'] } };
    if (me.role !== 'ADMIN') where.pbcLeaderId = me.id;
    if (m) where.month = m;
    const found = await this.prisma.pbc.findMany({
      where,
      select: { month: true, ownerId: true, reviewStatus: true },
      orderBy: { month: 'desc' },
    });
    const months = [...new Set(found.map((r) => r.month))].sort((a, b) => b.localeCompare(a));
    const out: (PbcViewRow & { month: string })[] = [];
    for (const mm of months) {
      const ids = found.filter((r) => r.month === mm).map((r) => r.ownerId);
      const owners = (await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: this.ownerSelect(),
      })) as unknown as OwnerLite[];
      const rows = await this.assemble(me, owners, mm);
      out.push(...rows.map((r) => ({ ...r, month: mm })));
    }
    // 待审核优先，其次月份新→旧，最后按成员名
    const order: Record<string, number> = { SELF_DONE: 0, LEADER_DONE: 1 };
    out.sort(
      (a, b) =>
        (order[a.reviewStatus] ?? 9) - (order[b.reviewStatus] ?? 9) ||
        b.month.localeCompare(a.month) ||
        a.name.localeCompare(b.name, 'zh'),
    );
    return { months, pending: out.filter((r) => r.reviewStatus === 'SELF_DONE').length, rows: out };
  }

  /** 有定稿评分的月份清单（降序），供排行榜月份下拉与默认「上个月」判断 */
  async rankingMonths(): Promise<string[]> {
    const rows = await this.prisma.pbc.findMany({
      where: { reviewStatus: 'LEADER_DONE' },
      select: { month: true },
      distinct: ['month'],
      orderBy: { month: 'desc' },
    });
    return rows.map((r) => r.month);
  }

  /**
   * 部门内 PBC 互看（DepartmentView「PBC」标签）
   * - 可见者：本部门成员（主 ∪ 额外，互相可看）、部门管理者（负责人 ∪ 共管人）、ADMIN
   * - 返回本部门全体启用成员的 PBC 行，附审批可操作性
   */
  async listForDepartment(me: { id: string; role: string; departmentId?: string | null }, departmentId: string, month: string): Promise<PbcViewRow[]> {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const dept = await this.prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, leaderId: true, managerIds: true } });
    if (!dept) throw new ForbiddenException('部门不存在');
    const isMember = (await this.prisma.user.count({ where: { id: me.id, ...deptRosterWhere(departmentId) } })) > 0;
    const canView = me.role === 'ADMIN' || isDeptAuthority(dept, me.id) || isMember;
    if (!canView) throw new ForbiddenException('仅可查看自己所在部门或所管理部门的成员 PBC');
    const owners = (await this.prisma.user.findMany({
      where: deptRosterWhere(departmentId),
      select: this.ownerSelect(),
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    })) as unknown as OwnerLite[];
    return this.assemble(me, owners, month.trim());
  }

  /**
   * 月度 PBC 排行：仅统计「上级评分已定稿」(LEADER_DONE) 的成员，按上级最终得分 leaderTotal 降序。
   * - 可见范围随查看者角色：ADMIN 全体；部门负责人=其所领导的部门；普通成员=本部门
   * - overall：可见范围内总排行（带名次）；byDepartment：按部门分组的部门内排行
   */
  async ranking(
    viewer: { id: string; role: string; departmentId?: string | null },
    month: string,
  ): Promise<{ month: string; overall: PbcRankEntry[]; byDepartment: { department: string; list: PbcRankEntry[] }[] }> {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const isAdmin = viewer.role === 'ADMIN';
    let memberWhere: Prisma.UserWhereInput = { active: true };
    if (!isAdmin) {
      const led = await this.prisma.department.findMany({ where: ledDeptWhere(viewer.id), select: { id: true } });
      const ids = led.map((d) => d.id);
      const mine = await this.prisma.user.findUnique({
        where: { id: viewer.id },
        select: { departmentId: true, extraDepartments: { select: { id: true } } },
      });
      if (mine?.departmentId) ids.push(mine.departmentId);
      for (const d of mine?.extraDepartments ?? []) ids.push(d.id);
      const uniq = [...new Set(ids)];
      if (!uniq.length) return { month: m, overall: [], byDepartment: [] };
      memberWhere = deptRosterWhere(uniq);
    }
    // 杨力/书书等「只看不排」的成员不上榜（PBC 记录本身保留，只是不参与名次）
    const excluded = await rankExcludedUserIds(this.prisma);
    const owners = (
      (await this.prisma.user.findMany({
        where: memberWhere,
        select: this.ownerSelect(),
        orderBy: { name: 'asc' },
      })) as unknown as OwnerLite[]
    ).filter((o) => !excluded.has(o.id));
    if (!owners.length) return { month: m, overall: [], byDepartment: [] };
    const rows = await this.prisma.pbc.findMany({
      where: { month: m, ownerId: { in: owners.map((o) => o.id) }, reviewStatus: 'LEADER_DONE' },
      select: { ownerId: true, leaderTotal: true, selfTotal: true },
    });
    const byId = new Map(rows.map((r) => [r.ownerId, r]));
    const entries = owners
      .filter((o) => byId.has(o.id))
      .map((o) => {
        const r = byId.get(o.id)!;
        return {
          userId: o.id,
          name: o.name,
          department: o.department?.name ?? '未分配部门',
          leaderTotal: r.leaderTotal ?? 0,
          selfTotal: r.selfTotal ?? null,
        };
      });
    entries.sort(
      (a, b) => b.leaderTotal - a.leaderTotal || (b.selfTotal ?? -1) - (a.selfTotal ?? -1) || a.name.localeCompare(b.name, 'zh'),
    );
    const overall: PbcRankEntry[] = entries.map((e, i) => ({ rank: i + 1, ...e }));
    const deptMap = new Map<string, typeof entries>();
    for (const e of entries) {
      const arr = deptMap.get(e.department) ?? [];
      arr.push(e);
      deptMap.set(e.department, arr);
    }
    const byDepartment = [...deptMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([department, list]) => ({
        department,
        list: list.map((e, i) => ({ rank: i + 1, ...e })),
      }));
    return { month: m, overall, byDepartment };
  }

  /**
   * 首页「PBC 排行」：默认展示【上个月】的排行（如 11 月展示 10 月），
   * 上月没有任何定稿时，回退到最近一个有定稿的月份。无任何定稿 → month=null、overall=[]。
   * 返回全公司总排行（不分部门、不随查看者角色收窄）。
   */
  async latestOverallRanking(): Promise<{ month: string | null; overall: PbcRankEntry[] }> {
    const t = this.beijingToday();
    const py = t.mo === 1 ? t.y - 1 : t.y;
    const pmo = t.mo === 1 ? 12 : t.mo - 1;
    const prevMonth = `${py}-${String(pmo).padStart(2, '0')}`;
    const prevDone = await this.prisma.pbc.count({ where: { month: prevMonth, reviewStatus: 'LEADER_DONE' } });
    let m = prevMonth;
    if (!prevDone) {
      const latest = await this.prisma.pbc.findFirst({
        where: { reviewStatus: 'LEADER_DONE' },
        orderBy: { month: 'desc' },
        select: { month: true },
      });
      if (!latest?.month) return { month: null, overall: [] };
      m = latest.month;
    }
    // 杨力/书书等「只看不排」的成员不上榜（同上）
    const excluded = await rankExcludedUserIds(this.prisma);
    const owners = (
      (await this.prisma.user.findMany({
        where: { active: true },
        select: this.ownerSelect(),
        orderBy: { name: 'asc' },
      })) as unknown as OwnerLite[]
    ).filter((o) => !excluded.has(o.id));
    if (!owners.length) return { month: m, overall: [] };
    const rows = await this.prisma.pbc.findMany({
      where: { month: m, ownerId: { in: owners.map((o) => o.id) }, reviewStatus: 'LEADER_DONE' },
      select: { ownerId: true, leaderTotal: true, selfTotal: true },
    });
    const byId = new Map(rows.map((r) => [r.ownerId, r]));
    const entries = owners
      .filter((o) => byId.has(o.id))
      .map((o) => {
        const r = byId.get(o.id)!;
        return {
          userId: o.id,
          name: o.name,
          department: o.department?.name ?? '未分配部门',
          leaderTotal: r.leaderTotal ?? 0,
          selfTotal: r.selfTotal ?? null,
        };
      });
    entries.sort(
      (a, b) => b.leaderTotal - a.leaderTotal || (b.selfTotal ?? -1) - (a.selfTotal ?? -1) || a.name.localeCompare(b.name, 'zh'),
    );
    return { month: m, overall: entries.map((e, i) => ({ rank: i + 1, ...e })) };
  }

  /** 加载某成员某月 PBC 行（校验查看者是否在其可见范围内），供详情弹窗使用 */
  async detailForViewer(viewer: { id: string; role: string; departmentId?: string | null }, ownerId: string, month: string) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const owner = (await this.prisma.user.findUnique({ where: { id: ownerId }, select: this.ownerSelect() })) as unknown as OwnerLite | null;
    if (!owner) throw new ForbiddenException('成员不存在');
    // 可见性：本人 / ADMIN / 同部门 / 部门管理者（负责人 ∪ 共管人）
    const deptLeaderOfViewer = isDeptAuthority(owner.department, viewer.id);
    const canView =
      viewer.id === ownerId ||
      viewer.role === 'ADMIN' ||
      deptLeaderOfViewer ||
      (viewer.departmentId && viewer.departmentId === owner.departmentId);
    if (!canView) throw new ForbiddenException('无权查看该成员的 PBC');
    const rows = await this.assemble(viewer, [owner], month.trim());
    return rows[0];
  }

  /** 审批通过某成员某月 PBC（锁定，成员不可再改） */
  async approve(me: { id: string; role: string; name: string }, ownerId: string, month: string) {
    const { owner, row } = await this.loadApprovable(me, ownerId, month);
    const updated = await this.prisma.pbc.update({
      where: { id: row.id },
      data: { status: 'APPROVED', approvedById: me.id, approvedAt: new Date(), reviewComment: null, reviewedById: null, reviewedAt: null },
    });
    void this.notifyDecision(owner, me.name, month.trim(), true);
    return { userId: ownerId, month: month.trim(), status: updated.status as PbcStatusLite, approverName: me.name, approvedAt: updated.approvedAt };
  }

  /** 允许修改（撤回审批）：APPROVED → SUBMITTED，清空审批信息，成员可再次编辑 */
  async revoke(me: { id: string; role: string; name: string }, ownerId: string, month: string) {
    const { owner, row } = await this.loadApprovable(me, ownerId, month);
    const updated = await this.prisma.pbc.update({
      where: { id: row.id },
      data: { status: 'SUBMITTED', approvedById: null, approvedAt: null },
    });
    void this.notifyDecision(owner, me.name, month.trim(), false);
    return { userId: ownerId, month: month.trim(), status: updated.status as PbcStatusLite };
  }

  /**
   * 退回修改：负责人/管理员将成员本月 PBC 退回并附修改意见
   * - 仅可退回已填写的 PBC（SUBMITTED 或 APPROVED）；退回后状态置 REJECTED，解除锁定供成员修改重提
   * - 修改意见非空；退回后钉钉私聊通知成员（fire-and-forget）
   */
  async reject(me: { id: string; role: string; name: string }, ownerId: string, month: string, comment: string) {
    const { owner, row } = await this.loadApprovable(me, ownerId, month);
    const text = (comment ?? '').trim();
    if (!text) throw new BadRequestException('请填写退回修改意见');
    const updated = await this.prisma.pbc.update({
      where: { id: row.id },
      data: {
        status: 'REJECTED',
        reviewComment: text,
        reviewedById: me.id,
        reviewedAt: new Date(),
        approvedById: null,
        approvedAt: null,
      },
    });
    void this.notifyReject(owner, me.name, month.trim(), text);
    return { userId: ownerId, month: month.trim(), status: updated.status as PbcStatusLite };
  }

  /**
   * 催一下：负责人/管理员钉钉私聊提醒某成员尽快提交本月 PBC
   * - 仅需审批权校验（不要求已填写），供「未写 PBC」成员催办
   * - 发送成功后同时抄送该成员主部门负责人与管理员（排除操作人自己，无需给自己发副本）
   */
  async remind(me: { id: string; role: string; name: string }, ownerId: string, month: string) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const owner = (await this.prisma.user.findUnique({ where: { id: ownerId }, select: this.ownerSelect() })) as unknown as OwnerLite | null;
    if (!owner) throw new ForbiddenException('成员不存在');
    if (!this.canViewerApprove(me, owner)) throw new ForbiddenException('无权催办该成员');
    const u = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true, phone: true } });
    if (!u) throw new ForbiddenException('成员不存在');
    const text = [
      `⏰ ${me.name} 提醒你尽快提交 ${m} 的月度 PBC（个人业务承诺）。`,
      '登录 MyOrgniz →「工作管理」→ PBC，填写事项与分值（合计 100）后保存即提交审批。',
      '',
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
    const r = await this.dm.notifyUser(u, text);
    const cc = r.sent
      ? await this.dm.ccReminders([{ userId: u.id, name: u.name, summary: `${m} 月度 PBC 未提交` }], {
          title: 'PBC 催办',
          excludeUserIds: [me.id],
        })
      : [];
    return { sent: r.sent, to: r.to, error: r.error ?? null, cc };
  }

  /**
   * PBC 任务分解预览：把成员本月 PBC 事项发给 DeepSeek 拆为多条带建议截止日的任务
   * - 仅审批人可用，且必须先「审批通过」（操作顺序：先审批 → 再分解建任务）
   * - 返回拆好的任务 + 该成员可承接任务的项目清单（供前端选择目标项目）
   * - AI 不可用/失败时降级：按事项逐条生成本月分散截止日的任务，不阻断人工确认
   */
  async decompose(me: { id: string; role: string; name: string }, ownerId: string, month: string) {
    const { owner, row } = await this.loadApprovable(me, ownerId, month);
    if (row.status !== 'APPROVED') throw new BadRequestException('请先审批通过该成员本月 PBC，再进行任务分解');
    if (row.decomposedAt) throw new BadRequestException('该成员本月 PBC 已分解，不能再次分解');
    const m = month.trim();
    const items = (row.items as unknown as PbcItem[]) ?? [];
    const range = this.monthRange(m);
    const itemsText = items.map((it, i) => `${i + 1}. ${it.content}（${it.score}分）`).join('\n');
    let tasks: PbcTaskPreview[] = [];
    let degraded = false;
    const ai = await this.ai.generateJson<{ tasks?: Array<{ title?: string; description?: string; dueDate?: string; fromItem?: string }> }>(
      'pbc.tasks',
      { memberName: owner.name, month: m, items: itemsText },
    );
    const aiTasks = ai?.tasks;
    if (aiTasks && aiTasks.length) {
      tasks = aiTasks
        .map((t, i) => ({
          title: String(t?.title ?? '').trim() || String(t?.fromItem ?? '').trim() || `任务${i + 1}`,
          description: String(t?.description ?? '').trim(),
          dueDate: this.normalizeDue(t?.dueDate, m, range, i, aiTasks.length),
        }))
        .filter((t) => t.title);
    }
    if (!tasks.length) {
      degraded = true;
      tasks = items.map((it, i) => ({
        title: it.content,
        description: `PBC 事项（分值 ${it.score}）自动生成的任务，请按需调整。`,
        dueDate: this.spreadDue(range, i, items.length),
      }));
    }
    const projects = await this.memberProjects(ownerId);
    return {
      month: m,
      memberName: owner.name,
      items,
      tasks,
      projects,
      // 建议默认项目：有项目则取第一个（前端每条任务预填，可逐条改），无项目为 null
      defaultProjectId: projects.length ? projects[0].id : null,
      degraded,
    };
  }

  /**
   * 确认创建：把（经人工编辑的）分解任务落为项目任务，每条任务可各自指定关联项目
   * - 仅审批人可用，且须先「审批通过」；每条任务的目标项目须未归档且该成员为其成员/负责人
   * - 负责人=该成员、截止时间=建议日期、自动落入目标项目首个看板首列（无看板则列表任务）
   * - fallbackProjectId：任务未带 projectId 时的兵底项目（兼容旧调用）
   */
  async createTasksFromPbc(
    me: { id: string; role: string; name: string },
    ownerId: string,
    month: string,
    tasks: PbcTaskPreview[],
    fallbackProjectId?: string,
  ) {
    const { row } = await this.loadApprovable(me, ownerId, month);
    if (row.status !== 'APPROVED') throw new BadRequestException('请先审批通过该成员本月 PBC，再创建任务');
    if (row.decomposedAt) throw new BadRequestException('该成员本月 PBC 已分解，不能再次分解');
    if (!Array.isArray(tasks) || !tasks.length) throw new BadRequestException('没有可创建的任务');
    const m = (month ?? '').trim();
    const range = this.monthRange(m);
    const startDate = range.start ? new Date(`${m}-01T00:00:00`) : null;
    // 每个目标项目的校验与看板首列缓存，避免多任务重复查库
    const projCache = new Map<string, { id: string; name: string; boardId: string | null; columnId: string | null }>();
    const resolveProject = async (pid: string) => {
      const hit = projCache.get(pid);
      if (hit) return hit;
      const project = await this.prisma.project.findUnique({
        where: { id: pid },
        select: { id: true, name: true, archived: true, ownerId: true, members: { select: { userId: true } } },
      });
      if (!project || project.archived) throw new BadRequestException('目标项目不存在或已归档');
      const canAssign = project.ownerId === ownerId || project.members.some((mm) => mm.userId === ownerId);
      if (!canAssign) throw new BadRequestException(`该成员不是项目「${project.name}」的成员，无法把任务指派到该项目`);
      const board = await this.prisma.kanbanBoard.findFirst({
        where: { projectId: pid },
        orderBy: { createdAt: 'asc' },
        include: { columns: { orderBy: { sortOrder: 'asc' }, take: 1 } },
      });
      const info = { id: project.id, name: project.name, boardId: board?.id ?? null, columnId: board?.columns?.[0]?.id ?? null };
      projCache.set(pid, info);
      return info;
    };
    const created: { id: string; title: string }[] = [];
    const usedProjects = new Map<string, string>();
    for (const t of tasks) {
      const title = String(t?.title ?? '').trim();
      if (!title) continue;
      const pid = String(t?.projectId ?? fallbackProjectId ?? '').trim();
      if (!pid) throw new BadRequestException('请为每条任务选择关联项目');
      const proj = await resolveProject(pid);
      const due = t?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(t.dueDate).slice(0, 10))
        ? new Date(`${String(t.dueDate).slice(0, 10)}T00:00:00`)
        : null;
      const task = await this.prisma.task.create({
        data: {
          projectId: proj.id,
          boardId: proj.boardId,
          columnId: proj.columnId,
          title,
          description: String(t?.description ?? '').trim() || null,
          assigneeId: ownerId,
          creatorId: me.id,
          status: 'TODO',
          priority: 'MEDIUM',
          dueDate: due,
          startDate,
        },
      });
      created.push({ id: task.id, title: task.title });
      usedProjects.set(proj.id, proj.name);
    }
    if (!created.length) throw new BadRequestException('没有有效任务（标题均为空）');
    // 首次成功创建分解任务：标记该月 PBC 为「已分解」（列表展示）
    if (!row.decomposedAt) {
      await this.prisma.pbc.update({ where: { id: row.id }, data: { decomposedAt: new Date() } });
    }
    return { created: created.length, projects: [...usedProjects.entries()].map(([id, name]) => ({ id, name })), tasks: created };
  }

  /**
   * 提交自评：将本月已提交/已批计划的逐事项写入 selfScore/selfReason + 整月 selfSummary
   * - 要求该月计划已存在且 status ∈ {SUBMITTED, APPROVED}；已有事项才可自评
   * - 逐条 0 ≤ selfScore ≤ 该条 score（缺省按 0）；selfTotal = 各条之和
   * - 写 reviewStatus=SELF_DONE、pbcLeaderId（缺省用默认上级解析）、selfAt；完成后钉钉私聊通知打分上级（fire-and-forget）
   */
  async selfReview(
    userId: string,
    month: string,
    payload: { items?: PbcScoreInput[]; selfSummary?: string; pbcLeaderId?: string | null },
  ) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const row = await this.prisma.pbc.findUnique({ where: { ownerId_month: { ownerId: userId, month: m } } });
    const items = (row?.items as unknown as PbcItem[]) ?? [];
    if (!row || !items.length) throw new BadRequestException('该月尚未填写 PBC 计划，无法自评');
    if (row.status !== 'SUBMITTED' && row.status !== 'APPROVED') {
      throw new BadRequestException('请先提交本月 PBC 计划并进入审批后再自评');
    }
    if (row.reviewStatus === 'LEADER_DONE') throw new BadRequestException('该月考核已由上级评分定稿，不能再修改自评');
    // 自评不限时：历史月份随时可补录、可修改（原「月末 3 天 ~ 次月 5 号」窗口只作提示，不再拦截）
    const selfActor = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    const sw = this.selfReviewWindow(m, selfActor?.role === 'ADMIN');
    const inputByIdx = new Map<number, PbcScoreInput>();
    for (const it of payload?.items ?? []) {
      const idx = Number(it?.index);
      if (Number.isInteger(idx)) inputByIdx.set(idx, it);
    }
    let selfTotal = 0;
    const merged: PbcItem[] = items.map((it, i) => {
      const inp = inputByIdx.get(i);
      const raw = Number(inp?.selfScore ?? 0);
      const selfScore = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), it.score) : 0;
      selfTotal += selfScore;
      const reason = String(inp?.selfReason ?? '').trim();
      return { ...it, selfScore, selfReason: reason || null };
    });
    // 选定打分上级：显式传入且合法则用之，否则回落默认解析
    let leaderId = String(payload?.pbcLeaderId ?? '').trim() || null;
    if (leaderId && leaderId !== userId) {
      const lv = await this.prisma.user.findUnique({ where: { id: leaderId }, select: { active: true } });
      if (!lv?.active) leaderId = null;
    } else if (leaderId === userId) {
      leaderId = null;
    }
    if (!leaderId) leaderId = await this.resolveDefaultLeaderId(userId);
    const selfSummary = String(payload?.selfSummary ?? '').trim() || null;
    const updated = await this.prisma.pbc.update({
      where: { id: row.id },
      data: { items: merged as any, selfSummary, selfTotal, pbcLeaderId: leaderId, reviewStatus: 'SELF_DONE', selfAt: new Date() },
    });
    if (leaderId) void this.notifySelfReviewToLeader(userId, leaderId, m, selfTotal, sw.open);
    return {
      month: m,
      reviewStatus: updated.reviewStatus as 'SELF_DONE',
      selfTotal,
      pbcLeaderId: leaderId,
      pbcLeaderName: leaderId ? await this.userName(leaderId) : null,
      items: merged,
    };
  }

  /**
   * 上级评分定稿：逐事项写 leaderScore/leaderComment + 整月 leaderComment，置 LEADER_DONE（锁定）
   * - 仅 pbcLeaderId===me 或 ADMIN（或上级的上级）可执行；需成员已自评（SELF_DONE）
   * - 逐条 0 ≤ leaderScore ≤ 该条 score；leaderTotal = 各条之和；定稿后通知成员
   */
  async leaderReview(
    me: { id: string; role: string; name: string },
    ownerId: string,
    month: string,
    payload: { items?: PbcScoreInput[]; leaderTotal?: number; leaderComment?: string },
  ) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const row = await this.prisma.pbc.findUnique({ where: { ownerId_month: { ownerId, month: m } } });
    const items = (row?.items as unknown as PbcItem[]) ?? [];
    if (!row || !items.length) throw new BadRequestException('该成员本月尚未填写 PBC，无法评分');
    if (row.reviewStatus !== 'SELF_DONE') throw new BadRequestException('该成员尚未提交自评，待其自评完成后你再评分');
    // 权限：被指定的打分上级本人，或管理员
    const canReview = row.pbcLeaderId === me.id || me.role === 'ADMIN';
    if (!canReview) throw new ForbiddenException('你不是该成员的打分上级，无权评分');
    const inputByIdx = new Map<number, PbcScoreInput>();
    for (const it of payload?.items ?? []) {
      const idx = Number(it?.index);
      if (Number.isInteger(idx)) inputByIdx.set(idx, it);
    }
    let leaderTotal = 0;
    const merged: PbcItem[] = items.map((it, i) => {
      const inp = inputByIdx.get(i);
      const raw = Number(inp?.leaderScore ?? 0);
      const leaderScore = Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), it.score) : 0;
      leaderTotal += leaderScore;
      const cmt = String(inp?.leaderComment ?? '').trim();
      return { ...it, leaderScore, leaderComment: cmt || null };
    });
    const leaderComment = String(payload?.leaderComment ?? '').trim() || null;
    const updated = await this.prisma.pbc.update({
      where: { id: row.id },
      data: { items: merged as any, leaderTotal, leaderComment, reviewStatus: 'LEADER_DONE', leaderAt: new Date() },
    });
    void this.notifyLeaderReviewed(ownerId, me.name, m, leaderTotal);
    return {
      month: m,
      userId: ownerId,
      reviewStatus: updated.reviewStatus as 'LEADER_DONE',
      leaderTotal,
      leaderComment,
      items: merged,
    };
  }

  /**
   * 撤销定稿（仅 ADMIN）：LEADER_DONE → SELF_DONE，保留已填分数供上级重新复核。
   * 每一次撤销都写一条 PbcReviewLog 留痕，并钉钉通知成员与打分上级。
   */
  async revokeLeaderReview(
    me: { id: string; role: string; name: string },
    ownerId: string,
    month: string,
    note?: string,
  ) {
    if (me.role !== 'ADMIN') throw new ForbiddenException('仅管理员可撤销已定稿的 PBC 考核');
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const m = month.trim();
    const row = await this.prisma.pbc.findUnique({ where: { ownerId_month: { ownerId, month: m } } });
    if (!row) throw new BadRequestException('该成员该月没有 PBC 记录');
    if (row.reviewStatus !== 'LEADER_DONE') throw new BadRequestException('该月尚未定稿，无需撤销');
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true } });
    if (!owner) throw new BadRequestException('成员不存在');
    await this.prisma.pbc.update({
      where: { id: row.id },
      data: { reviewStatus: 'SELF_DONE', leaderAt: null },
    });
    await this.prisma.pbcReviewLog.create({
      data: {
        month: m,
        ownerId,
        ownerName: owner.name,
        actorId: me.id,
        actorName: me.name,
        action: 'REVOKE_LEADER_REVIEW',
        fromStatus: 'LEADER_DONE',
        toStatus: 'SELF_DONE',
        leaderTotal: row.leaderTotal ?? null,
        note: String(note ?? '').trim() || null,
      },
    });
    void this.notifyRevoked(ownerId, row.pbcLeaderId, me.name, m, String(note ?? '').trim());
    return { userId: ownerId, month: m, reviewStatus: 'SELF_DONE' as const };
  }

  /** 最近一次撤销定稿留痕（供本人看到分数为何回到待审核） */
  private async lastRevokeOf(userId: string, month: string) {
    const log = await this.prisma.pbcReviewLog.findFirst({
      where: { ownerId: userId, month, action: 'REVOKE_LEADER_REVIEW' },
      orderBy: { createdAt: 'desc' },
    });
    return log ? { at: log.createdAt, byName: log.actorName, note: log.note } : null;
  }

  /** 撤销定稿后通知成员与打分上级（fire-and-forget） */
  private async notifyRevoked(ownerId: string, leaderId: string | null, actorName: string, month: string, note: string) {
    try {
      const ids = [...new Set([ownerId, leaderId].filter(Boolean) as string[])];
      const users = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, phone: true },
      });
      for (const u of users) {
        const isOwner = u.id === ownerId;
        const text = [
          `↩️ 管理员「${actorName}」撤销了 ${month} 月度 PBC 的定稿，考核回到「已自评·待复核」。`,
          isOwner ? '你的自评内容与分数保留不变，最终得分以复核后为准。' : '请重新打开该成员的复核页，确认分数后再定稿。',
          note ? `撤销说明：${note}` : '',
          '入口：工作管理 → PBC → 待我审核',
          webLink('/reports?tab=pbc&view=review'),
          '',
          '—— 来自 MyOrgniz 团队协作系统',
        ]
          .filter(Boolean)
          .join('\n');
        const r = await this.dm.notifyUser(u, text);
        if (!r.sent) this.logger.warn(`PBC 撤销定稿通知失败（${u.name} → ${r.to}）: ${r.error ?? '未知'}`);
      }
    } catch (e) {
      this.logger.error(`PBC 撤销定稿通知异常（已忽略）: ${(e as Error).message}`);
    }
  }

  /**
   * 自评完成后通知打分上级（fire-and-forget）
   * - 原定自评期（窗口）内：逐条即时通知
   * - 窗口外（补录）：按「上级 + 北京日期」每天只发 1 条，避免集中补录把上级钉钉刷爆
   */
  private async notifySelfReviewToLeader(ownerId: string, leaderId: string, month: string, selfTotal: number, inWindow = true) {
    try {
      const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true } });
      const leader = await this.prisma.user.findUnique({ where: { id: leaderId }, select: { id: true, name: true, phone: true } });
      if (!owner || !leader) return;
      const link = webLink('/reports?tab=pbc&view=review');
      const t = this.beijingToday();
      const dayKey = `${leaderId}:${t.y}-${String(t.mo).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
      if (!inWindow) {
        // 补录期：同一上级同一天只推一条汇总（后续成员不再逐条打扰）
        if (this.reviewNoticeSent.has(dayKey)) {
          this.reviewNoticeSent.set(dayKey, String(Number(this.reviewNoticeSent.get(dayKey)) + 1));
          return;
        }
        this.reviewNoticeSent.set(dayKey, '1');
        // 跨天清理，避免 Map 无限增长
        if (this.reviewNoticeSent.size > 500) {
          const today = dayKey.split(':')[1];
          for (const k of [...this.reviewNoticeSent.keys()]) {
            if (!k.endsWith(today)) this.reviewNoticeSent.delete(k);
          }
        }
      }
      const text = inWindow
        ? [
            `📝 ${owner.name} 已提交 ${month} 的月度 PBC 自评（自评分合计 ${selfTotal} 分），等你复核。`,
            '入口：工作管理 → PBC → 待我审核（可直接逐条改分并定稿）。',
            link,
            '',
            '—— 来自 MyOrgniz 团队协作系统',
          ].join('\n')
        : [
            `📝 ${owner.name} 补录了 ${month} 的月度 PBC 自评（${selfTotal} 分），等你复核。`,
            '补录期同一上级每天只提醒一次；今天可能还有其他人补录，请到「待我审核」统一处理。',
            `入口：工作管理 → PBC → 待我审核`,
            link,
            '',
            '—— 来自 MyOrgniz 团队协作系统',
          ].join('\n');
      const r = await this.dm.notifyUser(leader, text);
      if (!r.sent) this.logger.warn(`PBC 自评通知上级失败（${leader.name} → ${r.to}）: ${r.error ?? '未知'}`);
    } catch (e) {
      this.logger.error(`PBC 自评通知异常（已忽略）: ${(e as Error).message}`);
    }
  }

  /** 上级定稿后通知成员（fire-and-forget） */
  private async notifyLeaderReviewed(ownerId: string, leaderName: string, month: string, leaderTotal: number) {
    try {
      const u = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true, phone: true } });
      if (!u) return;
      const text = [
        `✅ ${leaderName} 已完成你 ${month} 月度 PBC 的复核，最终得分 ${leaderTotal} 分。`,
        '登录 MyOrgniz → 工作管理 → PBC → 我的计划，可查看自评分、最终得分与逐条评语。',
        webLink(`/reports?tab=pbc&view=mine`),
        '',
        '—— 来自 MyOrgniz 团队协作系统',
      ].join('\n');
      const r = await this.dm.notifyUser(u, text);
      if (!r.sent) this.logger.warn(`PBC 评分结果通知失败（${u.name} → ${r.to}）: ${r.error ?? '未知'}`);
    } catch (e) {
      this.logger.error(`PBC 评分结果通知异常（已忽略）: ${(e as Error).message}`);
    }
  }

  /** 月区间：返回该 'YYYY-MM' 的首日字符串与当月天数 */
  private monthRange(m: string): { start: string; lastDay: number } {
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    const lastDay = new Date(y, mo, 0).getDate();
    return { start: `${m}-01`, lastDay };
  }

  /** 北京口径「今天」的年/月/日 */
  private beijingToday(): { y: number; mo: number; d: number } {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t: Intl.DateTimeFormatPartTypes) => Number(p.find((x) => x.type === t)?.value);
    return { y: g('year'), mo: g('month'), d: g('day') };
  }

  /** 'YYYY-MM' → 年/月/当月天数 */
  private monthParts(m: string): { y: number; mo: number; lastDay: number } {
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    return { y, mo, lastDay: new Date(y, mo, 0).getDate() };
  }

  /**
   * 计划填写窗口：当月计划仅在该月 1~10 号可填写/提交（ADMIN 豁免）。
   * 历史月份（早于本月）不受限制——允许补填/补交，配合「历史月也能补自评」。
   */
  private planWindow(m: string, isAdmin: boolean): { open: boolean; hint: string } {
    if (isAdmin) return { open: true, hint: '' };
    const t = this.beijingToday();
    const mp = this.monthParts(m);
    // 早于本月 → 历史月，随时可补
    if (t.y * 12 + t.mo > mp.y * 12 + mp.mo) return { open: true, hint: '' };
    const open = t.y === mp.y && t.mo === mp.mo && t.d <= 10;
    const hint = `当月 PBC 计划只能在 ${mp.y} 年 ${mp.mo} 月的 1~10 号填写/提交；更早的历史月份可随时补录（管理员不受限）`;
    return { open, hint };
  }

  /**
   * 自评窗口（仅作参考提示，不再用于拦截）：某月 M 的「原定自评期」= M 的月末 3 天 ~ M+1 的前 5 天。
   * windowText 形如 '2026-1029 ~ 2026-1105'。自评已改为不限时，任何月份都能提交/修改。
   */
  private selfReviewWindow(m: string, isAdmin: boolean): { open: boolean; windowText: string } {
    const mp = this.monthParts(m);
    const startDay = Math.max(1, mp.lastDay - 2);
    const ny = mp.mo === 12 ? mp.y + 1 : mp.y;
    const nmo = mp.mo === 12 ? 1 : mp.mo + 1;
    const pad = (n: number) => String(n).padStart(2, '0');
    const windowText = `${mp.y}-${pad(mp.mo)}${pad(startDay)} ~ ${ny}-${pad(nmo)}05`;
    if (isAdmin) return { open: true, windowText };
    const t = this.beijingToday();
    const inMonthEnd = t.y === mp.y && t.mo === mp.mo && t.d >= startDay && t.d <= mp.lastDay;
    const inNextStart = t.y === ny && t.mo === nmo && t.d <= 5;
    return { open: inMonthEnd || inNextStart, windowText };
  }

  /** 校验/纠偏 AI 给出的 dueDate：须为该月内合法日期，否则按序号在当月分散兜底 */
  private normalizeDue(raw: unknown, m: string, range: { start: string; lastDay: number }, idx: number, total: number): string {
    const s = String(raw ?? '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && s.slice(0, 7) === m) {
      const day = Number(s.slice(8, 10));
      if (day >= 1 && day <= range.lastDay) return s;
    }
    return this.spreadDue(range, idx, total);
  }

  /** 按任务序号在当月均匀分散一个截止日（兜底排期） */
  private spreadDue(range: { start: string; lastDay: number }, idx: number, total: number): string {
    const t = Math.max(total, 1);
    let day = Math.round(((idx + 1) / (t + 1)) * range.lastDay);
    day = Math.min(Math.max(day, 1), range.lastDay);
    const mm = range.start.slice(0, 7);
    return `${mm}-${String(day).padStart(2, '0')}`;
  }

  /** 某成员可承接任务的项目（未归档；其为负责人或成员） */
  private async memberProjects(userId: string): Promise<{ id: string; name: string }[]> {
    const rows = await this.prisma.project.findMany({
      where: { archived: false, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((p) => ({ id: p.id, name: p.name }));
  }

  /** 审批/撤回公共校验：归属成员存在、查看者有审批权、该月 PBC 已填写 */
  private async loadApprovable(me: { id: string; role: string; name: string }, ownerId: string, month: string) {
    if (!MONTH_RE.test((month ?? '').trim())) throw new BadRequestException('月份格式须为 YYYY-MM');
    const owner = (await this.prisma.user.findUnique({ where: { id: ownerId }, select: this.ownerSelect() })) as unknown as OwnerLite | null;
    if (!owner) throw new ForbiddenException('成员不存在');
    if (!this.canViewerApprove(me, owner)) throw new ForbiddenException('无权审批该成员的 PBC');
    const row = await this.prisma.pbc.findUnique({ where: { ownerId_month: { ownerId, month: month.trim() } } });
    const items = (row?.items as unknown as PbcItem[]) ?? [];
    if (!row || !items.length) throw new BadRequestException('该成员本月尚未填写 PBC，无法审批');
    return { owner, row };
  }

  /** 审批结果钉钉私聊通知被审批人（fire-and-forget，失败仅记日志） */
  private async notifyDecision(owner: OwnerLite, approverName: string, month: string, approved: boolean) {
    try {
      const u = await this.prisma.user.findUnique({ where: { id: owner.id }, select: { id: true, name: true, phone: true } });
      if (!u) return;
      const text = approved
        ? [`✅ 你的 ${month} 月度 PBC 已通过审批。`, `审批人：${approverName}`, '通过后该月 PBC 将被锁定，如需修改请联系审批人「允许修改」。', '', '—— 来自 MyOrgniz 团队协作系统'].join('\n')
        : [`🔓 ${approverName} 允许你修改 ${month} 的月度 PBC。`, '你可以重新编辑并保存。', '', '—— 来自 MyOrgniz 团队协作系统'].join('\n');
      const r = await this.dm.notifyUser(u, text);
      if (!r.sent) this.logger.warn(`PBC 审批结果通知失败（${u.name} → ${r.to}）: ${r.error ?? '未知'}`);
    } catch (e) {
      this.logger.error(`PBC 审批结果通知异常（已忽略）: ${(e as Error).message}`);
    }
  }

  /** 退回修改后的钉钉私聊通知（附修改意见，fire-and-forget，失败仅记日志） */
  private async notifyReject(owner: OwnerLite, reviewerName: string, month: string, comment: string) {
    try {
      const u = await this.prisma.user.findUnique({ where: { id: owner.id }, select: { id: true, name: true, phone: true } });
      if (!u) return;
      const text = [
        `⚠️ ${reviewerName} 退回了你 ${month} 的月度 PBC，需修改后重新提交。`,
        `修改意见：${comment}`,
        '请回到系统修改并保存，保存后重新进入待审批。',
        '',
        '—— 来自 MyOrgniz 团队协作系统',
      ].join('\n');
      const r = await this.dm.notifyUser(u, text);
      if (!r.sent) this.logger.warn(`PBC 退回通知失败（${u.name} → ${r.to}）: ${r.error ?? '未知'}`);
    } catch (e) {
      this.logger.error(`PBC 退回通知异常（已忽略）: ${(e as Error).message}`);
    }
  }

  /** 单个用户名（找不到返回 null） */
  private async userName(id: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { name: true } });
    return u?.name ?? null;
  }
}
