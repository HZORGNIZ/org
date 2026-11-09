import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CN_OFFSET_MS, fmtBeijing, fmtBeijingDate } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';
import { DingtalkDmService } from './dingtalk-dm.service';
import { DailyGroupSummaryQueue } from './daily-group-summary.queue';

/** Setting 表 key：每日小组小结开关（value: { enabled: boolean }） */
export const DAILY_SUMMARY_ENABLED_KEY = 'dailySummary.enabled';
/** Setting 表 key：每日小组小结发送时间（value: { time: 'HH:mm' }，北京时间，每天） */
export const DAILY_SUMMARY_SCHEDULE_KEY = 'dailySummary.schedule';

/** 单个项目（群）的每日小结 */
export interface GroupSummaryItem {
  projectId: string;
  projectName: string;
  conversationId: string;
  groupName: string;
  /** 未完成任务总数 */
  totalIncomplete: number;
  overdueCount: number;
  dueTodayCount: number;
  /** 项目成员 + 负责人（日报口径名单） */
  rosterCount: number;
  submittedCount: number;
  missingCount: number;
  submittedNames: string[];
  missingNames: string[];
  /** 群消息正文 */
  text: string;
}

/**
 * 每日小组小结（发到各项目绑定的钉钉群）
 * - 内容两块：① 本项目「任务预期」= 逾期未完成 + 今日到期 + 未完成总数；② 本项目「今日日报」= 成员+负责人里谁已交/未交
 * - 分群隔离：每个群只发它自己项目相关的人与任务（取数按 projectId 天然隔离），绝不跨项目混入他人
 * - 全局开关与发送时间存 Setting（管理后台设置，DB 优先；未设置回退 env DAILY_SUMMARY_ENABLED / DAILY_SUMMARY_TIME），默认每天 18:00 北京时间
 * - 保密项目 / 软删除(回收站)项目 / 未绑定钉钉群 / 已归档项目一律跳过（与每日进展总结群发口径一致）
 * - 发送走 DingtalkDmService.sendGroup（dws 个人身份，与工时排名同一路径）；管理后台「预览」与「立即发送」不受开关限制
 */
@Injectable()
export class DailyGroupSummaryService {
  private readonly logger = new Logger(DailyGroupSummaryService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private dm: DingtalkDmService,
    private queue: DailyGroupSummaryQueue,
  ) {}

  /** 环境变量默认发送时间（每天 18:00） */
  private envTime(): string {
    return (this.config.get<string>('DAILY_SUMMARY_TIME', '18:00') || '18:00').trim();
  }

  /** 环境变量默认开关（默认关闭，需管理员在后台开启，避免上线即群发） */
  private envEnabled(): boolean {
    return this.config.get<string>('DAILY_SUMMARY_ENABLED', 'false') === 'true';
  }

  /** 'HH:mm' → 每天 cron（'0 18 * * *'）；非法格式抛错 */
  private timeToCron(time: string): string {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim());
    if (!m) throw new BadRequestException('时间格式须为 HH:mm（北京时间）');
    return `${Number(m[2])} ${Number(m[1])} * * *`;
  }

  /** 读 Setting 里的布尔开关；未设置返回 null */
  private async loadStoredEnabled(): Promise<boolean | null> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: DAILY_SUMMARY_ENABLED_KEY } });
      const enabled = (row?.value as any)?.enabled;
      return typeof enabled === 'boolean' ? enabled : null;
    } catch (e) {
      this.logger.error(`读取每日小组小结开关设置失败: ${(e as Error).message}`);
      return null;
    }
  }

  /** 后台设置（Setting 优先，未设置回退环境变量）+ 下次触发时间 */
  async getSettings() {
    const stored = await this.loadStoredEnabled();
    let time = this.envTime();
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: DAILY_SUMMARY_SCHEDULE_KEY } });
      const t = (row?.value as any)?.time;
      if (typeof t === 'string' && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(t.trim())) time = t.trim();
    } catch {
      // 读取失败回退环境变量默认
    }
    return {
      enabled: stored ?? this.envEnabled(),
      source: stored === null ? 'env' : 'db',
      time,
      cron: this.timeToCron(time),
      next: await this.queue.nextRunAt(),
    };
  }

  /** 保存开关：同时重新注册/移除定时，保存后立即生效 */
  async saveEnabled(enabled: boolean) {
    await this.prisma.setting.upsert({
      where: { key: DAILY_SUMMARY_ENABLED_KEY },
      create: { key: DAILY_SUMMARY_ENABLED_KEY, value: { enabled } } as any,
      update: { value: { enabled } } as any,
    });
    await this.bootstrapSchedule();
    return { ok: true, enabled };
  }

  /** 保存发送时间（'HH:mm' 北京时间，每天）：重注册定时，保存后立即生效 */
  async saveScheduleTime(time: string) {
    const cron = this.timeToCron(time); // 非法格式抛 400
    const value = cron.split(' ');
    const normalized = `${String(Number(value[1])).padStart(2, '0')}:${String(Number(value[0])).padStart(2, '0')}`;
    await this.prisma.setting.upsert({
      where: { key: DAILY_SUMMARY_SCHEDULE_KEY },
      create: { key: DAILY_SUMMARY_SCHEDULE_KEY, value: { time: normalized } } as any,
      update: { value: { time: normalized } } as any,
    });
    await this.bootstrapSchedule();
    return { ok: true, time: normalized, cron };
  }

  /**
   * 按当前设置注册/移除每日定时（启动自检与保存开关/时间后调用）
   * - 关闭时移除调度，避免无谓触发；开启时按后台时间（未设置则 DAILY_SUMMARY_CRON / 每天 18:00）注册
   */
  async bootstrapSchedule() {
    const enabled = (await this.loadStoredEnabled()) ?? this.envEnabled();
    if (!enabled) {
      await this.queue.removeSchedule();
      return { ok: true, enabled: false };
    }
    const settings = await this.getSettings();
    const cron = this.config.get<string>('DAILY_SUMMARY_CRON', '').trim() || settings.cron;
    await this.queue.schedule(cron);
    return { ok: true, enabled: true, cron };
  }

  /** 北京时间今天 0 点对应的绝对时刻（dueDate 早于此即已过今日；当天到期不算逾期） */
  private bjDayStart(now: Date): Date {
    const bj = new Date(now.getTime() + CN_OFFSET_MS);
    return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - CN_OFFSET_MS);
  }

  /** 单个任务行 →「• 姓名｜任务标题｜M.D」一行 */
  private taskLine(
    t: { title: string; dueDate: Date | null; assignee: { name: string } | null },
    md: (d: Date) => string,
  ): string {
    return `• ${t.assignee?.name ?? '未指派'}｜${t.title}${t.dueDate ? `｜${md(t.dueDate)}` : ''}`;
  }

  /**
   * 生成全部已绑定钉钉群的活跃项目当日小结（不发群，dryRun 预览与实发共用）
   * - 一次批量取数按 projectId 分组，逐项目组装，保证每个群只看到自己项目的人和任务
   */
  async buildAll(): Promise<{ date: string; time: string; items: GroupSummaryItem[] }> {
    const now = new Date();
    const dayStart = this.bjDayStart(now);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    // 与 submitDaily 存 periodStart（服务器本地零点）口径一致，判定「今日是否已交」用本地零点
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const md = (d: Date) => {
      const b = new Date(d.getTime() + CN_OFFSET_MS).toISOString();
      return `${Number(b.slice(5, 7))}.${Number(b.slice(8, 10))}`;
    };
    const dateLabel = fmtBeijingDate(now);

    const projects = await this.prisma.project.findMany({
      where: {
        archived: false,
        deletedAt: null,
        confidential: false,
        dingtalkConversationId: { not: null },
      },
      select: {
        id: true,
        name: true,
        dingtalkConversationId: true,
        dingtalkGroupName: true,
        ownerId: true,
        members: { select: { userId: true } },
      },
      orderBy: { name: 'asc' },
    });
    if (!projects.length) return { date: dateLabel, time: fmtBeijing(now).slice(11, 16), items: [] };

    const ids = projects.map((p) => p.id);
    const rosterIdsByProject = new Map<string, string[]>();
    const allRosterIds = new Set<string>();
    for (const p of projects) {
      const set = new Set<string>([p.ownerId, ...p.members.map((m) => m.userId)]);
      rosterIdsByProject.set(p.id, [...set]);
      for (const id of set) allRosterIds.add(id);
    }

    const [overdue, dueToday, incompleteGroups, names, reportsToday] = await Promise.all([
      this.prisma.task.findMany({
        where: { projectId: { in: ids }, status: { not: 'DONE' }, dueDate: { lt: dayStart }, project: { deletedAt: null } },
        select: { projectId: true, title: true, dueDate: true, assignee: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.task.findMany({
        where: { projectId: { in: ids }, status: { not: 'DONE' }, dueDate: { gte: dayStart, lt: dayEnd }, project: { deletedAt: null } },
        select: { projectId: true, title: true, dueDate: true, assignee: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.task.groupBy({
        by: ['projectId'],
        where: { projectId: { in: ids }, status: { not: 'DONE' }, project: { deletedAt: null } },
        _count: { _all: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [...allRosterIds] } },
        select: { id: true, name: true },
      }),
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: { in: [...allRosterIds] }, periodStart: { gte: todayStart, lt: new Date(todayStart.getTime() + 86400000) } },
        select: { ownerId: true },
      }),
    ]);

    const nameById = new Map(names.map((u) => [u.id, u.name]));
    const submittedSet = new Set(reportsToday.map((r) => r.ownerId).filter(Boolean) as string[]);
    const incompleteBy = new Map(incompleteGroups.map((g) => [g.projectId, g._count._all]));
    const overdueBy = new Map<string, typeof overdue>();
    const dueBy = new Map<string, typeof dueToday>();
    for (const t of overdue) {
      if (!overdueBy.has(t.projectId)) overdueBy.set(t.projectId, []);
      overdueBy.get(t.projectId)!.push(t);
    }
    for (const t of dueToday) {
      if (!dueBy.has(t.projectId)) dueBy.set(t.projectId, []);
      dueBy.get(t.projectId)!.push(t);
    }

    const items: GroupSummaryItem[] = projects.map((p) => {
      const ov = overdueBy.get(p.id) ?? [];
      const dt = dueBy.get(p.id) ?? [];
      const roster = rosterIdsByProject.get(p.id) ?? [];
      const submittedNames: string[] = [];
      const missingNames: string[] = [];
      for (const uid of roster) {
        const nm = nameById.get(uid) ?? '未知成员';
        if (submittedSet.has(uid)) submittedNames.push(nm);
        else missingNames.push(nm);
      }
      const totalIncomplete = incompleteBy.get(p.id) ?? 0;
      const text = this.buildText(p, dateLabel, totalIncomplete, ov, dt, roster.length, submittedNames, missingNames, md);
      return {
        projectId: p.id,
        projectName: p.name,
        conversationId: p.dingtalkConversationId as string,
        groupName: p.dingtalkGroupName || p.dingtalkConversationId || p.name,
        totalIncomplete,
        overdueCount: ov.length,
        dueTodayCount: dt.length,
        rosterCount: roster.length,
        submittedCount: submittedNames.length,
        missingCount: missingNames.length,
        submittedNames,
        missingNames,
        text,
      };
    });
    return { date: dateLabel, time: fmtBeijing(now).slice(11, 16), items };
  }

  /** 组装某项目群消息正文：任务预期（逾期/今日到期）+ 今日日报（已交/未交） */
  private buildText(
    p: { name: string },
    dateLabel: string,
    totalIncomplete: number,
    ov: { title: string; dueDate: Date | null; assignee: { name: string } | null }[],
    dt: { title: string; dueDate: Date | null; assignee: { name: string } | null }[],
    rosterCount: number,
    submittedNames: string[],
    missingNames: string[],
    md: (d: Date) => string,
  ): string {
    const lines: string[] = [];
    lines.push(`📋 每日小组小结（${p.name} · ${dateLabel}）`);
    lines.push('');
    lines.push(`【任务预期】未完成 ${totalIncomplete} 项，其中逾期 ${ov.length} 项、今日到期 ${dt.length} 项`);
    if (ov.length) {
      lines.push(`⚠️ 逾期未完成：`);
      for (const t of ov.slice(0, 15)) lines.push(this.taskLine(t, md));
      if (ov.length > 15) lines.push(`…另有 ${ov.length - 15} 项逾期`);
    }
    if (dt.length) {
      lines.push(`⏳ 今日到期：`);
      for (const t of dt.slice(0, 15)) lines.push(this.taskLine(t, md));
      if (dt.length > 15) lines.push(`…另有 ${dt.length - 15} 项今日到期`);
    }
    if (!ov.length && !dt.length) lines.push('今日无逾期、无今日到期任务，进展顺利 👍');
    lines.push('');
    lines.push(`【今日日报】已提交 ${submittedNames.length}/${rosterCount} 人`);
    if (submittedNames.length) lines.push(`✅ 已交：${submittedNames.join('、')}`);
    if (missingNames.length) lines.push(`📝 待补：${missingNames.join('、')}`);
    if (!rosterCount) lines.push('（本项目暂无成员名单）');
    lines.push('');
    lines.push('—— 来自 MyOrgniz 团队协作系统');
    return lines.join('\n');
  }

  /**
   * 生成并（可选）发送全部项目小结
   * - dryRun=true：只返回各群正文，不发群（管理后台预览用）
   * - manual=true：管理后台「立即发送」，不受开关限制
   */
  async publish(opts: { dryRun?: boolean; manual?: boolean } = {}): Promise<{
    ok: boolean;
    skipped?: boolean;
    reason?: string;
    date: string;
    groups: { projectId: string; projectName: string; conversationId: string; groupName: string; ok: boolean; error?: string }[];
  }> {
    const { date, items } = await this.buildAll();
    if (opts.dryRun) return { ok: true, date, groups: [] };
    if (!items.length) return { ok: false, skipped: true, reason: '没有已绑定钉钉群的活跃项目', date, groups: [] };

    const groups: { projectId: string; projectName: string; conversationId: string; groupName: string; ok: boolean; error?: string }[] = [];
    for (const it of items) {
      try {
        const r = await this.dm.sendGroup(it.conversationId, it.text);
        groups.push({ projectId: it.projectId, projectName: it.projectName, conversationId: it.conversationId, groupName: it.groupName, ok: r.ok, error: r.error });
        if (!r.ok) this.logger.warn(`每日小组小结发群失败（${it.groupName}）: ${r.error ?? '未知'}`);
      } catch (e) {
        groups.push({ projectId: it.projectId, projectName: it.projectName, conversationId: it.conversationId, groupName: it.groupName, ok: false, error: (e as Error).message });
        this.logger.warn(`每日小组小结发群异常（${it.groupName}）: ${(e as Error).message}`);
      }
    }
    const okCount = groups.filter((g) => g.ok).length;
    this.logger.log(`每日小组小结发送完成 date=${date} 成功 ${okCount}/${groups.length} 群`);
    return { ok: okCount > 0, date, groups };
  }

  /** 定时任务入口：未开启或 dws 不可用时跳过（管理后台「立即发送」走 publish(manual=true) 不受此限制） */
  async runScheduled() {
    const stored = await this.loadStoredEnabled();
    const enabled = stored ?? this.envEnabled();
    if (!enabled) return { ok: false, skipped: true, reason: '每日小组小结开关已关闭' };
    if (!this.dm.available) return { ok: false, skipped: true, reason: 'dws CLI 不可用，无法发群' };
    const r = await this.publish({});
    return { ...r, skipped: !!r.skipped, reason: r.reason };
  }
}
