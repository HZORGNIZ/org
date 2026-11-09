import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HealthLevel, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';

/** AI 输出契约（与 prompts/PROMPTS.md `project.health` 保持一致） */
interface HealthOutput {
  completionPercent?: number;
  healthPercent?: number;
  level?: string;
  summary?: string;
  risks?: string[];
  suggestions?: string[];
}

/** 项目分析快照（既写入 Prompt 输入，也在 AI 不可用时作为兜底返回给前端） */
export interface ProjectSnapshot {
  projectName: string;
  startDate: string;
  endDate: string;
  today: string;
  remainingDays: number;
  totalTasks: number;
  doneTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  overdueTasks: number;
  milestonesTotal: number;
  milestonesDue: number;
  requirementDocs: string[];
  recentUpdates: { date: string; content: string }[];
  completionPercent: number;
  healthPercent: number;
  /** 规则默认判定（AI 缺席时兜底；不写库） */
  ruleLevel: 'GREEN' | 'YELLOW' | 'RED';
}

@Injectable()
export class ProjectHealthService {
  private readonly logger = new Logger(ProjectHealthService.name);
  /** 缓存陈旧阈值：命中则后台异步补算 */
  private static readonly STALE_MS = 24 * 3600 * 1000;

  constructor(private prisma: PrismaService, private ai: AiService) {}

  /** 把 YYYY-MM-DD 或 ISO 字符串解析为 UTC 午夜（仅日期部分） */
  private parseDateOrNull(input?: string | Date | null): Date | null {
    if (!input) return null;
    if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input).trim());
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** 北京墙钟日期字符串（YYYY-MM-DD） */
  private beijingDate(d: Date): string {
    const t = d.getTime() + 8 * 3600 * 1000;
    return new Date(t).toISOString().slice(0, 10);
  }

  /** 收集项目当前数据快照（不含 AI）；供 prompt 变量注入 + AI 不可用时兜底返回 */
  async computeSnapshot(projectId: string): Promise<ProjectSnapshot> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        requirementDocIds: true,
      },
    });
    if (!project) throw new NotFoundException('项目不存在');
    const [taskGroups, overdueCount, milestonesTotal, milestonesDue, docs, updates] = await Promise.all([
      this.prisma.task.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } }),
      this.prisma.task.count({
        where: { projectId, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
      }),
      this.prisma.projectMilestone.count({ where: { projectId } }),
      this.prisma.projectMilestone.count({ where: { projectId, dueDate: { lte: new Date() } } }),
      project.requirementDocIds.length
        ? this.prisma.documentFile.findMany({
            where: { id: { in: project.requirementDocIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as { id: string; name: string }[]),
      this.prisma.projectUpdate.findMany({
        where: { projectId },
        orderBy: { periodEnd: 'desc' },
        take: 20,
        select: { content: true, periodEnd: true },
      }),
    ]);
    const total = taskGroups.reduce((s, g) => s + g._count._all, 0);
    const done = taskGroups.find((g) => g.status === 'DONE')?._count._all ?? 0;
    const inProgress = taskGroups.find((g) => g.status === 'IN_PROGRESS')?._count._all ?? 0;
    const todo = taskGroups.find((g) => g.status === 'TODO')?._count._all ?? 0;
    const completion = total > 0 ? Math.round((done / total) * 100) : 0;
    const today = new Date();
    const end = this.parseDateOrNull(project.endDate);
    const start = this.parseDateOrNull(project.startDate);
    const remainingDays = end ? Math.max(-9999, Math.floor((end.getTime() - today.getTime()) / 86400000)) : 9999;
    const remainingRatio = total > 0 ? (total - done) / total : 0;
    let ruleLevel: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN';
    if (overdueCount > 0 || remainingDays < 0 || (remainingDays <= 3 && remainingRatio > 0.5)) ruleLevel = 'RED';
    else if (remainingDays <= 7 && remainingRatio > 0.3) ruleLevel = 'YELLOW';
    // 健康度具体数值（0-100）：从 100 扣分——逆期任务、进度落后于时间、过期/临期
    let timeProgress = 0;
    if (start && end && end.getTime() > start.getTime()) {
      timeProgress = Math.max(0, Math.min(1, (today.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
    }
    const lag = timeProgress - completion / 100;
    let healthScore = 100;
    healthScore -= Math.min(40, overdueCount * 8);
    if (lag > 0) healthScore -= Math.min(30, Math.round(lag * 100 * 0.6));
    if (remainingDays < 0) healthScore -= 25;
    else if (remainingDays <= 3 && completion < 80) healthScore -= 15;
    else if (remainingDays <= 7 && completion < 60) healthScore -= 8;
    const healthPercent = Math.max(0, Math.min(100, healthScore));
    return {
      projectName: project.name,
      startDate: project.startDate ? this.beijingDate(project.startDate) : '（未设定）',
      endDate: project.endDate ? this.beijingDate(project.endDate) : '（未设定）',
      today: this.beijingDate(today),
      remainingDays,
      totalTasks: total,
      doneTasks: done,
      inProgressTasks: inProgress,
      todoTasks: todo,
      overdueTasks: overdueCount,
      milestonesTotal,
      milestonesDue,
      requirementDocs: docs.map((d) => d.name),
      recentUpdates: updates.map((u) => ({
        date: this.beijingDate(u.periodEnd),
        content: String(u.content || '').slice(0, 140),
      })),
      completionPercent: completion,
      healthPercent,
      ruleLevel,
    };
  }

  /** 计算并写回 Project 上的 AI 分析快照；返回本次分析结果（AI 不可用时 degraded:true） */
  async analyze(me: { id: string; role: string }, projectId: string) {
    await this.assertVisible(projectId, me.id, me.role);
    const snap = await this.computeSnapshot(projectId);
    const out = await this.ai.generateJson<HealthOutput>('project.health', {
      projectName: snap.projectName,
      startDate: snap.startDate,
      endDate: snap.endDate,
      today: snap.today,
      remainingDays: snap.remainingDays,
      totalTasks: snap.totalTasks,
      doneTasks: snap.doneTasks,
      inProgressTasks: snap.inProgressTasks,
      todoTasks: snap.todoTasks,
      overdueTasks: snap.overdueTasks,
      milestonesTotal: snap.milestonesTotal,
      milestonesDue: snap.milestonesDue,
      requirementDocs: snap.requirementDocs.length ? snap.requirementDocs.join('、') : '（无）',
      recentUpdates: snap.recentUpdates.length
        ? snap.recentUpdates.map((u) => `[${u.date}] ${u.content}`).join('\n')
        : '（无进展记录）',
    });
    if (!out) {
      // AI 不可用：不落库，只回快照 + 规则默认判定，让前端提示"AI 暂不可用"
      return {
        ok: false as const,
        message: 'AI 服务暂不可用，本次未更新缓存',
        snapshot: snap,
        completionPercent: snap.completionPercent,
        healthPercent: snap.healthPercent,
        level: snap.ruleLevel,
        summary: '',
        risks: [] as string[],
        suggestions: [] as string[],
        analyzedAt: null as Date | null,
      };
    }
    const completion = this.clampPercent(out.completionPercent ?? snap.completionPercent);
    const healthPercent = this.clampPercent(out.healthPercent ?? snap.healthPercent);
    const level = this.normalizeLevel(out.level) ?? snap.ruleLevel;
    const summary = String(out.summary ?? '').trim();
    const risks = this.normalizeList(out.risks);
    const suggestions = this.normalizeList(out.suggestions);
    const now = new Date();
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        completionPercent: completion,
        healthLevel: level as HealthLevel,
        healthPercent,
        healthSummary: summary || null,
        healthRisks: risks.join('\n') || null,
        healthSuggestions: suggestions.join('\n') || null,
        healthAnalyzedAt: now,
      },
    });
    return {
      ok: true as const,
      completionPercent: completion,
      healthPercent,
      level,
      summary,
      risks,
      suggestions,
      analyzedAt: now,
      snapshot: snap,
    };
  }

  /** GET /projects/:id 命中缓存 >24h 或从未分析过时，后台异步补算一次（不阻塞响应） */
  maybeRefreshAsync(project: {
    id: string;
    status: ProjectStatus;
    healthAnalyzedAt: Date | null;
    ownerId: string;
    approverId: string | null;
  }) {
    if (project.status !== ProjectStatus.ACTIVE) return; // 审批前不做 AI 分析
    if (project.healthAnalyzedAt && Date.now() - project.healthAnalyzedAt.getTime() < ProjectHealthService.STALE_MS) return;
    // 后台异步执行；异常吞掉并记日志，避免污染响应
    setImmediate(() => {
      this.analyze(
        { id: project.ownerId, role: 'ADMIN' }, // 内部上下文：以 owner 身份绕过 visFilter（项目已确认可见）
        project.id,
      ).catch((e) => this.logger.warn(`项目 ${project.id} 后台分析失败: ${(e as Error).message}`));
    });
  }

  /** 校验：非成员但 owner/approver/ADMIN 也可访问分析接口 */
  private async assertVisible(projectId: string, userId: string, role: string) {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, approverId: true, deletedAt: true },
    });
    if (!p || p.deletedAt) throw new NotFoundException('项目不存在或无权限');
    if (role === 'ADMIN' || p.ownerId === userId || p.approverId === userId) return;
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { id: true },
    });
    if (!member) throw new BadRequestException('无权限访问该项目');
  }

  private clampPercent(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private normalizeLevel(v: unknown): 'GREEN' | 'YELLOW' | 'RED' | null {
    const s = String(v ?? '').trim().toUpperCase();
    if (s === 'GREEN' || s === 'YELLOW' || s === 'RED') return s;
    return null;
  }

  private normalizeList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, 5);
  }
}
