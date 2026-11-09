import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { beijingMondayOf, cnWeekLabel, fmtBeijingDate, isoWeekOf } from '../../common/beijing-time';
import { rankExcludedUserIds } from '../../common/rank-exclude';
import { DingtalkDmService } from './dingtalk-dm.service';
import { WorkRankQueue } from './work-rank.queue';

/** Setting 表 key：每周工时排名开关（value: { enabled: boolean }） */
export const WORK_RANK_ENABLED_KEY = 'workRank.enabled';
/** Setting 表 key：排名发送的钉钉群（value: { groups: [{ conversationId }] }） */
export const WORK_RANK_GROUPS_KEY = 'workRank.groups';
/** Setting 表 key：排名发送时间（value: { time: 'HH:mm' }，北京时间，每周日） */
export const WORK_RANK_SCHEDULE_KEY = 'workRank.schedule';

/** 榜单展示条数（全公司 Top N） */
const TOP_N = 10;

export interface WorkRankItem {
  rank: number;
  userId: string;
  name: string;
  /** 项目组：本周日报归属最多的项目名；无项目归属时回落部门名 */
  groupName: string;
  hours: number;
  days: number;
  /** 跨多个项目时为 true，groupName 以「/」连接 */
  multiProject: boolean;
}

export interface WorkRankResult {
  /** 统计周周一（北京口径）日期串，用于缓存键与前端 */
  weekDate: string;
  weekLabel: string;
  isoWeek: string;
  /** 统计区间展示（M.D ~ M.D） */
  rangeText: string;
  /** 全公司在职成员数 */
  totalMembers: number;
  /** 填报了工时的成员数 */
  reportedMembers: number;
  /** 未填报工时的成员数 */
  missing: number;
  /** 全公司本周工时合计 */
  totalHours: number;
  /** 降序榜单（截取前 TOP_N） */
  top: WorkRankItem[];
  /** 榜单总人数（有工时的人数，可能大于 top.length） */
  rankedCount: number;
  /** 群消息正文 */
  text: string;
}

/**
 * 每周工时排名（每天写日报时顺带说明当日工时 → 周日 21:00 汇总排名发大群）
 * - 取数口径：本周（北京周一 00:00 起 7 个自然日）DAILY 日报的 Report.hours 求和
 *   hours 由 report.daily.analyze 从日报正文提取（「今天干了 8 小时」），详情里可人工修正
 * - 项目组：一人本周可能跨多个项目，取工时最多的项目作主归属；无项目归属回落其部门名
 * - 发送目标群在管理后台勾选（存 Setting workRank.groups，可多选），走 DingtalkDmService.sendGroup（dws 个人身份）
 * - 定时：默认每周日 21:00 北京时间发当周（见 WorkRankQueue）；管理后台「立即发送」不受开关限制
 */
@Injectable()
export class WorkRankService {
  private readonly logger = new Logger(WorkRankService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private dm: DingtalkDmService,
    private queue: WorkRankQueue,
  ) {}

  /** 环境变量默认发送时间（周日 21:00） */
  private envTime(): string {
    return (this.config.get<string>('WORK_RANK_TIME', '21:00') || '21:00').trim();
  }

  /** 环境变量默认开关 */
  private envEnabled(): boolean {
    return this.config.get<string>('WORK_RANK_ENABLED', 'true') === 'true';
  }

  /** 'HH:mm' → 每周日 cron（'0 21 * * 0'）；非法格式抛错 */
  private timeToCron(time: string): string {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim());
    if (!m) throw new BadRequestException('时间格式须为 HH:mm（北京时间）');
    return `${Number(m[2])} ${Number(m[1])} * * 0`;
  }

  /** 读 Setting 里的布尔开关；未设置返回 null */
  private async loadStoredEnabled(): Promise<boolean | null> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: WORK_RANK_ENABLED_KEY } });
      const enabled = (row?.value as any)?.enabled;
      return typeof enabled === 'boolean' ? enabled : null;
    } catch (e) {
      this.logger.error(`读取工时排名开关设置失败: ${(e as Error).message}`);
      return null;
    }
  }

  /** 已勾选的发送群（conversationId 列表，保持后台勾选顺序） */
  async loadGroupIds(): Promise<string[]> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: WORK_RANK_GROUPS_KEY } });
      const groups = (row?.value as any)?.groups;
      if (!Array.isArray(groups)) return [];
      return Array.from(
        new Set(groups.map((g: any) => String(g?.conversationId ?? '').trim()).filter(Boolean)),
      ) as string[];
    } catch (e) {
      this.logger.error(`读取工时排名发送群失败: ${(e as Error).message}`);
      return [];
    }
  }

  /** 后台设置（Setting 优先，未设置回退环境变量）+ 群名解析 + 下次触发时间 */
  async getSettings() {
    const stored = await this.loadStoredEnabled();
    const ids = await this.loadGroupIds();
    const nameMap = await this.resolveGroupNames(ids);
    let time = this.envTime();
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: WORK_RANK_SCHEDULE_KEY } });
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
      groups: ids.map((conversationId) => ({ conversationId, groupName: nameMap.get(conversationId) || conversationId })),
      next: await this.queue.nextRunAt(),
    };
  }

  /** 保存开关：同时重新注册/移除定时，保存后立即生效 */
  async saveEnabled(enabled: boolean) {
    await this.prisma.setting.upsert({
      where: { key: WORK_RANK_ENABLED_KEY },
      create: { key: WORK_RANK_ENABLED_KEY, value: { enabled } } as any,
      update: { value: { enabled } } as any,
    });
    await this.bootstrapSchedule();
    return { ok: true, enabled };
  }

  /** 保存发送群（覆盖式；空数组=不发群） */
  async saveGroups(groupIds: string[]) {
    const ids = Array.from(new Set((groupIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean)));
    await this.prisma.setting.upsert({
      where: { key: WORK_RANK_GROUPS_KEY },
      create: { key: WORK_RANK_GROUPS_KEY, value: { groups: ids.map((conversationId) => ({ conversationId })) } } as any,
      update: { value: { groups: ids.map((conversationId) => ({ conversationId })) } } as any,
    });
    return { ok: true, groups: ids };
  }

  /** 保存发送时间（'HH:mm' 北京时间，每周日）：重注册定时，保存后立即生效 */
  async saveScheduleTime(time: string) {
    const cron = this.timeToCron(time); // 非法格式抛 400
    const value = cron.split(' ');
    const normalized = `${String(Number(value[1])).padStart(2, '0')}:${String(Number(value[0])).padStart(2, '0')}`;
    await this.prisma.setting.upsert({
      where: { key: WORK_RANK_SCHEDULE_KEY },
      create: { key: WORK_RANK_SCHEDULE_KEY, value: { time: normalized } } as any,
      update: { value: { time: normalized } } as any,
    });
    await this.bootstrapSchedule();
    return { ok: true, time: normalized, cron };
  }

  /**
   * 按当前设置注册/移除每周定时（启动自检与保存开关/时间后调用）
   * - 关闭时移除调度，避免无谓触发；开启时按后台时间（未设置则 WORK_RANK_CRON / 周日 21:00）注册
   */
  async bootstrapSchedule() {
    const enabled = (await this.loadStoredEnabled()) ?? this.envEnabled();
    if (!enabled) {
      await this.queue.removeSchedule();
      return { ok: true, enabled: false };
    }
    const settings = await this.getSettings();
    const cron = this.config.get<string>('WORK_RANK_CRON', '').trim() || settings.cron;
    await this.queue.schedule(cron);
    return { ok: true, enabled: true, cron };
  }

  /** 群名解析：优先项目上绑定过的钉钉群名，回落 MessageInbox 里的会话名 */
  private async resolveGroupNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const [projects, inboxes] = await Promise.all([
      this.prisma.project.findMany({
        where: { dingtalkConversationId: { in: ids } },
        select: { dingtalkConversationId: true, dingtalkGroupName: true, name: true },
        take: 300,
      }),
      this.prisma.messageInbox.findMany({
        where: { conversationId: { in: ids } },
        select: { conversationId: true, conversationName: true },
        take: 300,
      }),
    ]);
    for (const p of projects) {
      const cid = p.dingtalkConversationId!;
      if (!out.has(cid)) out.set(cid, p.dingtalkGroupName || p.name || cid);
    }
    for (const m of inboxes) {
      const cid = m.conversationId!;
      if (!out.has(cid) && m.conversationName) out.set(cid, m.conversationName);
    }
    return out;
  }

  /**
   * 统计某周工时排名（periodStart 传该周任意一天即可，内部归一到北京周一；不传=本周）
   * 口径与 weeklyAggregate 一致：全公司在职成员，不限发群可见范围
   */
  async rank(periodStart?: string): Promise<WorkRankResult> {
    const base = periodStart ? new Date(periodStart) : new Date();
    const monday = beijingMondayOf(Number.isNaN(base.getTime()) ? new Date() : base);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    const md = (d: Date) => `${Number(fmtBeijingDate(d).slice(5, 7))}.${Number(fmtBeijingDate(d).slice(8, 10))}`;

    // 杨力/书书等「只看不排」的成员整体排除：不进榜、不计入合计工时与「填报 x/y 人」
    const excluded = await rankExcludedUserIds(this.prisma);
    const [members, reports] = await Promise.all([
      this.prisma.user.findMany({
        where: excluded.size ? { active: true, id: { notIn: [...excluded] } } : { active: true },
        select: { id: true, name: true, department: { select: { name: true } } },
      }),
      this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: { not: null }, status: 'PUBLISHED', periodStart: { gte: monday, lt: new Date(monday.getTime() + 7 * 86400000) } },
        select: { ownerId: true, hours: true, projectId: true },
      }),
    ]);

    // 逐人累加：工时合计 / 填报天数 / 各项目工时（用于选主归属项目）
    const agg = new Map<string, { hours: number; days: number; byProject: Map<string, number> }>();
    const touch = (ownerId: string) => {
      let a = agg.get(ownerId);
      if (!a) {
        a = { hours: 0, days: 0, byProject: new Map<string, number>() };
        agg.set(ownerId, a);
      }
      return a;
    };
    for (const r of reports) {
      if (!r.ownerId || excluded.has(r.ownerId)) continue;
      const a = touch(r.ownerId);
      const h = typeof r.hours === 'number' && Number.isFinite(r.hours) ? Math.max(0, Math.min(r.hours, 24)) : 0;
      if (h > 0) {
        a.hours += h;
        a.days += 1;
        if (r.projectId) a.byProject.set(r.projectId, (a.byProject.get(r.projectId) ?? 0) + h);
      }
    }

    const projRows = agg.size
      ? await this.prisma.project.findMany({
          where: { id: { in: Array.from(new Set([...agg.values()].flatMap((a) => [...a.byProject.keys()]))) } },
          select: { id: true, name: true },
        })
      : [];
    const projName = new Map(projRows.map((p) => [p.id, p.name]));

    const items: WorkRankItem[] = [];
    for (const [userId, a] of agg) {
      if (a.hours <= 0) continue;
      const ordered = [...a.byProject.entries()].sort((x, y) => y[1] - x[1]);
      const names = ordered.map(([id]) => projName.get(id)).filter(Boolean) as string[];
      const member = members.find((m) => m.id === userId);
      items.push({
        rank: 0,
        userId,
        name: member?.name ?? '未知成员',
        groupName: names.length ? (names.length > 1 ? `${names[0]} 等${names.length}个项目` : names[0]) : member?.department?.name || '—',
        hours: Math.round(a.hours * 10) / 10,
        days: a.days,
        multiProject: names.length > 1,
      });
    }
    // 工时同分时，填报天数多者在前
    items.sort((x, y) => y.hours - x.hours || y.days - x.days || x.name.localeCompare(y.name, 'zh'));
    items.forEach((it, i) => (it.rank = i + 1));

    const totalHours = Math.round(items.reduce((s, it) => s + it.hours, 0) * 10) / 10;
    const result: WorkRankResult = {
      weekDate: fmtBeijingDate(monday),
      weekLabel: `${cnWeekLabel(monday)} · ${isoWeekOf(monday)}`,
      isoWeek: isoWeekOf(monday),
      rangeText: `${md(monday)} ~ ${md(sunday)}`,
      totalMembers: members.length,
      reportedMembers: items.length,
      missing: Math.max(0, members.length - items.length),
      totalHours,
      top: items.slice(0, TOP_N),
      rankedCount: items.length,
      text: '',
    };
    result.text = this.buildText(result);
    return result;
  }

  /** 组装群消息正文：姓名 · 项目组 · 时长 */
  private buildText(r: WorkRankResult): string {
    const lines = [
      `⏱ 本周工时 Top${TOP_N}（${r.weekLabel} ${r.rangeText}）`,
      '',
      `全公司填报 ${r.reportedMembers}/${r.totalMembers} 人 · 合计 ${r.totalHours} 小时`,
      '',
    ];
    if (!r.top.length) {
      lines.push('本周还没有人填报工时（在日报里写一句「今天干了 X 小时」即可自动统计）。');
    } else {
      r.top.forEach((it) => lines.push(`第${it.rank}名 ${it.name}｜${it.groupName}｜${it.hours} 小时`));
      if (r.rankedCount > r.top.length) lines.push(`……另有 ${r.rankedCount - r.top.length} 人上榜，明细见系统「每周工时排名」`);
    }
    lines.push('');
    if (r.missing > 0) lines.push(`本周 ${r.missing} 人未填报工时`);
    lines.push('（工时取自各人日报，如需修正请到「工作管理 → 日报」详情里改）');
    lines.push('', '—— 来自 MyOrgniz 团队协作系统');
    return lines.join('\n');
  }

  /**
   * 生成并发送本周工时排名到管理后台勾选的群
   * - dryRun=true：只返回榜单与正文，不发群（管理后台预览用）
   * - manual=true：管理后台「立即发送」，不受开关限制，且允许覆盖 groupIds
   */
  async publish(
    opts: { dryRun?: boolean; manual?: boolean; periodStart?: string; groupIds?: string[] } = {},
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string; result: WorkRankResult; groups: { conversationId: string; groupName: string; ok: boolean; error?: string }[] }> {
    const result = await this.rank(opts.periodStart);
    if (opts.dryRun) return { ok: true, result, groups: [] };

    const ids = (opts.manual && opts.groupIds?.length ? opts.groupIds : await this.loadGroupIds())
      .map((s) => String(s ?? '').trim())
      .filter(Boolean);
    if (!ids.length) {
      this.logger.warn('每周工时排名跳过：管理后台未勾选发送群');
      return { ok: false, skipped: true, reason: '未配置发送群（请到管理后台「每周工时排名」勾选）', result, groups: [] };
    }
    const nameMap = await this.resolveGroupNames(ids);
    const groups: { conversationId: string; groupName: string; ok: boolean; error?: string }[] = [];
    for (const cid of ids) {
      const groupName = nameMap.get(cid) ?? cid;
      try {
        const r = await this.dm.sendGroup(cid, result.text);
        groups.push({ conversationId: cid, groupName, ok: r.ok, error: r.error });
        if (!r.ok) this.logger.warn(`工时排名发群失败（群 ${groupName}）: ${r.error ?? '未知'}`);
      } catch (e) {
        groups.push({ conversationId: cid, groupName, ok: false, error: (e as Error).message });
        this.logger.warn(`工时排名发群异常（群 ${groupName}）: ${(e as Error).message}`);
      }
    }
    const okCount = groups.filter((g) => g.ok).length;
    this.logger.log(`每周工时排名发送完成 week=${result.weekDate} 成功 ${okCount}/${groups.length} 群`);
    return { ok: okCount > 0, result, groups };
  }

  /** 定时任务入口：未开启或 dws 不可用时跳过（管理后台「立即发送」走 publish(manual=true) 不受此限制） */
  async runScheduled() {
    const stored = await this.loadStoredEnabled();
    const enabled = stored ?? this.envEnabled();
    if (!enabled) return { ok: false, skipped: true, reason: '每周工时排名开关已关闭' };
    if (!this.dm.available) return { ok: false, skipped: true, reason: 'dws CLI 不可用，无法发群' };
    const r = await this.publish({});
    return { ...r, skipped: !!r.skipped, reason: r.reason };
  }
}
