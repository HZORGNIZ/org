import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ReportType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { ReportsService } from '../reports/reports.service';
import { TasksService } from '../tasks/tasks.service';
import { IdeasService } from '../ideas/ideas.service';

type IntakeCategory = 'DAILY' | 'WEEKLY' | 'TASK' | 'IDEA';
const CATEGORIES: IntakeCategory[] = ['DAILY', 'WEEKLY', 'TASK', 'IDEA'];

/** AI 抽取结果（home.intake 输出） */
interface IntakeExtract {
  category?: string;
  title?: string;
  projectHint?: string;
  startDate?: string;
  dueDate?: string;
  priority?: string;
  ideaContent?: string;
  reportText?: string;
}

const CN_TZ_OFFSET_MIN = 480; // 北京时间 UTC+8

/**
 * 首页 AI 录入：把一段自然语言直接落库（日报/周报/任务/灵感），返回类别判别与处理详情，支持撤销。
 * - 类别由预设按钮给定，或未给定时调用 home.intake 让 AI 判别并抽取字段
 * - DAILY/WEEKLY/TASK/IDEA 分别路由到 ReportsService / TasksService / IdeasService
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private reports: ReportsService,
    private tasks: TasksService,
    private ideas: IdeasService,
  ) {}

  async submit(
    me: { id: string; role: string; name: string },
    input: { text: string; category?: string },
  ) {
    const raw = (input.text ?? '').trim();
    if (!raw) throw new BadRequestException('请输入内容');

    let category = this.normalizeCategory(input.category);
    let extract: IntakeExtract = {};

    if (category) {
      // 按钮已指定类别：仍剥离可能存在的关键词前缀，取正文
      extract = { reportText: this.stripPrefix(raw), ideaContent: this.stripPrefix(raw), title: this.stripPrefix(raw) };
    } else {
      const aiOut = await this.ai.generateJson<IntakeExtract>('home.intake', { text: raw });
      category = this.normalizeCategory(aiOut?.category);
      extract = aiOut ?? {};
      if (!category) category = 'IDEA'; // AI 不可用/无法判定 → 兜底存灵感，不丢内容
    }

    switch (category) {
      case 'DAILY':
        return this.submitReport(me, raw, extract, ReportType.DAILY);
      case 'WEEKLY':
        return this.submitReport(me, raw, extract, ReportType.WEEKLY);
      case 'TASK':
        return this.submitTask(me, raw, extract);
      case 'IDEA':
      default:
        return this.submitIdea(me, raw, extract);
    }
  }

  // ---------- 分类落库 ----------

  private async submitIdea(me: { id: string }, raw: string, extract: IntakeExtract) {
    const content = (extract.ideaContent ?? '').trim() || this.stripPrefix(raw);
    const idea = await this.ideas.create(me, { content, source: 'HOME_INTAKE' });
    return {
      category: 'IDEA',
      created: { type: 'IDEA', id: idea.id },
      summary: '已记为灵感/需求',
      detail: `内容已存入「灵感」页，可稍后与团队一起规划为项目或任务。`,
      undoable: true,
    };
  }

  private async submitReport(
    me: { id: string },
    raw: string,
    extract: IntakeExtract,
    type: ReportType,
  ) {
    const text = (extract.reportText ?? '').trim() || this.stripPrefix(raw);
    if (!text) throw new BadRequestException('日报/周报内容不能为空');
    // 提交前判断今天/本周是否已有报告（决定能否撤销：并入已有则不可撤销）
    const existedBefore = await this.hasReportForPeriod(me.id, type);
    const report: any =
      type === ReportType.DAILY
        ? await this.reports.submitDaily(me.id, text)
        : await this.reports.submitWeekly(me.id, text);
    const label = type === ReportType.DAILY ? '日报' : '周报';
    const undoable = !existedBefore;
    return {
      category: type,
      created: { type: 'REPORT', id: report?.id },
      // 日报的当日工时（AI 从正文提取的值，可能为 null）：前端据此预填「保存工时」输入框
      hours: type === ReportType.DAILY && typeof report?.hours === 'number' ? report.hours : null,
      summary: `已提交${label}`,
      detail: undoable
        ? `${label}已直接发布${report?.project?.name ? `，归属项目「${report.project.name}」` : ''}。可撤销。`
        : `已并入今天的${label}（同周期追加合并），不可单独撤销。`,
      undoable,
    };
  }

  private async submitTask(
    me: { id: string; role: string },
    raw: string,
    extract: IntakeExtract,
  ) {
    const title = (extract.title ?? '').trim() || this.stripPrefix(raw);
    if (!title) throw new BadRequestException('任务标题不能为空');
    const project = await this.matchProject(me, extract.projectHint);
    if (!project) {
      // 无法匹配项目：返回 needProject，由前端一键选择（仅此边界需轻量确认）
      const candidates = await this.myProjectOptions(me);
      return {
        category: 'TASK',
        created: { type: 'TASK', id: null },
        summary: '任务待归属项目',
        detail: `已识别为任务「${title}」，但无法确定归属项目，请选择一个项目后创建。`,
        undoable: false,
        needProject: true,
        pendingTask: {
          title,
          dueDate: this.normDate(extract.dueDate),
          startDate: this.normDate(extract.startDate),
          priority: this.normalizePriority(extract.priority),
        },
        projectOptions: candidates,
      };
    }
    const task = await this.tasks.create(me, {
      projectId: project.id,
      title,
      description: undefined,
      priority: this.normalizePriority(extract.priority),
      dueDate: this.normDate(extract.dueDate),
      startDate: this.normDate(extract.startDate),
    });
    return {
      category: 'TASK',
      created: { type: 'TASK', id: task.id },
      summary: '已创建任务',
      detail: `任务「${task.title}」已创建到项目「${project.name}」${task.dueDate ? `，截止 ${this.fmtDate(task.dueDate)}` : ''}。`,
      undoable: true,
    };
  }

  /** 供前端"任务待归属项目"场景一键创建 */
  async createTaskWithProject(
    me: { id: string; role: string },
    data: { projectId: string; title: string; dueDate?: string | null; startDate?: string | null; priority?: string },
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: data.projectId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!project) throw new NotFoundException('项目不存在');
    const task = await this.tasks.create(me, {
      projectId: project.id,
      title: data.title,
      priority: this.normalizePriority(data.priority),
      dueDate: this.normDate(data.dueDate),
      startDate: this.normDate(data.startDate),
    });
    return {
      category: 'TASK',
      created: { type: 'TASK', id: task.id },
      summary: '已创建任务',
      detail: `任务「${task.title}」已创建到项目「${project.name}」。`,
      undoable: true,
    };
  }

  // ---------- 撤销 ----------

  async undo(me: { id: string; role: string }, input: { type: string; id: string }) {
    const { type, id } = input;
    if (!id) throw new BadRequestException('缺少撤销目标');
    if (type === 'TASK') {
      const task = await this.prisma.task.findUnique({
        where: { id },
        select: { id: true, creatorId: true, _count: { select: { comments: true } } },
      });
      if (!task) return { ok: false, message: '任务不存在，可能已被删除' };
      if (task.creatorId !== me.id && me.role !== 'ADMIN') return { ok: false, message: '仅创建者可撤销该任务' };
      if (task._count.comments > 0) return { ok: false, message: '任务已有评论，无法撤销' };
      await this.prisma.task.delete({ where: { id } }); // 级联删除活动/标签/附件
      return { ok: true };
    }
    if (type === 'IDEA') {
      const idea = await this.prisma.idea.findUnique({ where: { id }, select: { id: true, authorId: true, status: true } });
      if (!idea) return { ok: false, message: '灵感不存在' };
      if (idea.authorId !== me.id && me.role !== 'ADMIN') return { ok: false, message: '仅作者可撤销该灵感' };
      if (idea.status === 'CONVERTED') return { ok: false, message: '灵感已转为项目/任务，无法撤销' };
      await this.prisma.idea.delete({ where: { id } });
      return { ok: true };
    }
    if (type === 'REPORT') {
      const report = await this.prisma.report.findUnique({
        where: { id },
        select: { id: true, ownerId: true, type: true, createdAt: true, periodStart: true },
      });
      if (!report) return { ok: false, message: '报告不存在' };
      if (report.ownerId !== me.id && me.role !== 'ADMIN') return { ok: false, message: '仅本人可撤销该报告' };
      // 仅撤销本次新建：若该周期内除本报告外无其它来源，则删除本报告及其关联项目进展
      await this.prisma.projectUpdate.deleteMany({ where: { reportId: id } });
      await this.prisma.report.delete({ where: { id } });
      return { ok: true };
    }
    return { ok: false, message: '不支持撤销的类型' };
  }

  // ---------- 辅助 ----------

  private normalizeCategory(c?: string): IntakeCategory | null {
    const up = (c ?? '').toString().trim().toUpperCase();
    return (CATEGORIES as string[]).includes(up) ? (up as IntakeCategory) : null;
  }

  private normalizePriority(p?: string) {
    const up = (p ?? '').toString().trim().toUpperCase();
    return ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(up) ? up : 'MEDIUM';
  }

  /** 剥离行首的关键词前缀（含标点后），用于按钮指定类别时取正文 */
  private stripPrefix(text: string): string {
    return text.replace(/^\s*(日报|周报|任务|灵感)\s*[：:，,、.\-]?\s*/, '').trim();
  }

  /** YYYY-MM-DD 归一化：无效或空返回 null */
  private normDate(d?: string | null): string | null {
    if (!d) return null;
    const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  }

  private fmtDate(dt: Date): string {
    const bj = new Date(dt.getTime() + CN_TZ_OFFSET_MIN * 60000);
    return bj.toISOString().slice(0, 10);
  }

  /** 今天(北京)是否已有该类型报告 */
  private async hasReportForPeriod(userId: string, type: ReportType): Promise<boolean> {
    const { start } = this.periodBounds(type);
    const count = await this.prisma.report.count({
      where: { ownerId: userId, type, periodStart: start },
    });
    return count > 0;
  }

  /** 复用 reports 服务的周期口径：日报=今天 00:00（本地），周报=本周一 00:00（本地） */
  private periodBounds(type: ReportType): { start: Date } {
    const now = new Date();
    if (type === ReportType.DAILY) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { start };
    }
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const weekday = (today.getDay() + 6) % 7;
    const monday = new Date(today);
    monday.setDate(today.getDate() - weekday);
    return { start: monday };
  }

  /** 在我参与/负责的项目内匹配 projectHint（名称包含关键词，或关键词包含于名称） */
  private async matchProject(me: { id: string; role: string }, hint?: string) {
    const kw = (hint ?? '').trim();
    const projects = await this.prisma.project.findMany({
      where: { deletedAt: null, OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
      select: { id: true, name: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!projects.length) return null;
    if (!kw) return projects.length === 1 ? projects[0] : null; // 无关键词且仅一个项目才自动归属
    const hit = projects.find((p) => p.name.includes(kw) || kw.includes(p.name));
    return hit ?? null;
  }

  private async myProjectOptions(me: { id: string; role: string }) {
    return this.prisma.project.findMany({
      where: { deletedAt: null, OR: [{ ownerId: me.id }, { members: { some: { userId: me.id } } }] },
      select: { id: true, name: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
