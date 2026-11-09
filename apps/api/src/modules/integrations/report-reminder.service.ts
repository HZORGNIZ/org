import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { CN_OFFSET_MS, fmtBeijing, fmtBeijingDate } from '../../common/beijing-time';
import { webLink } from '../../common/web-link';
import { DingtalkDmService, ReminderCcItem } from './dingtalk-dm.service';
import { slotRangeLabel } from '../../common/work-slots';

/**
 * 日报未写提醒（每小时定时检查，见 ReportReminderQueue）
 * 规则口径（按部门设定，部门负责人在「部门 → 日报规则」配置 Department 上的字段）：
 * - reportFrequency：NONE 不要求 / DAILY 每天 / WORKDAY 每个工作日(周一~周五) / WEEKLY_COUNT 每周至少 reportWeeklyCount 篇
 * - 应发日报人员：当天（北京周几）在工作管理「我的工作时间安排」里至少排了一个时间段；没排就不提醒（不论是否写过）
 * - reportRemindTime：每日检查提醒时间（北京时间 HH:mm），当前北京时间未到该点不提醒（force 绕过，仅管理员手动验证用）
 * - 频控：每人每个北京日最多提醒一次（User.lastReportRemindAt）
 * - WEEKLY_COUNT「未及时写」判定：本周已写 < 目标 且「含今天在内本周剩余天数 < 尚缺篇数」（即再不写就来不及）才提醒
 * - 抄送：每轮成功提醒的成员汇总后，同时发给其主部门负责人与全部管理员（见 DingtalkDmService.ccReminders）
 * - 发送目标解析与私聊能力复用 DingtalkDmService
 */
@Injectable()
export class ReportReminderService {
  private readonly logger = new Logger(ReportReminderService.name);
  private readonly enabled: boolean;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private dm: DingtalkDmService,
  ) {
    this.enabled = this.config.get<string>('REPORT_REMINDER_ENABLED', 'true') === 'true';
  }

  /** 北京时间「当日分钟数」(0-1439)，用于与 reportRemindTime 比较；不依赖容器时区 */
  private bjMinutesOfDay(now: Date): number {
    const s = fmtBeijing(now); // 'YYYY-MM-DD HH:mm:ss'
    return Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
  }

  /** 北京时间星期序号（0=周一 … 5=周六 6=周日） */
  private bjDow(now: Date): number {
    const bj = new Date(now.getTime() + CN_OFFSET_MS);
    return (bj.getUTCDay() + 6) % 7;
  }

  /** 'HH:mm' → 分钟数；非法回退 20:00 */
  private parseTimeToMinutes(time: string): number {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((time ?? '').trim());
    if (!m) return 20 * 60;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /** 'M.D' 北京日期标签（now 为真实时刻，需 +8h 换算北京墙钟） */
  private md(d: Date): string {
    const b = new Date(d.getTime() + CN_OFFSET_MS).toISOString();
    return `${Number(b.slice(5, 7))}.${Number(b.slice(8, 10))}`;
  }

  /**
   * 计算某成员在给定部门规则下「今天/本周是否应写且欠写」，返回提醒文本；无需提醒返回 null。
   * 与 ReportReminderService.run、DepartmentsService.reportStatus 共用同一判定口径。
   */
  private evaluateMissing(
    dept: { reportFrequency: string; reportWeeklyCount: number | null },
    ctx: { weekCount: number; wroteToday: boolean; bjDow: number },
  ): string | null {
    const freq = dept.reportFrequency;
    if (freq === 'NONE' || !freq) return null;
    if (freq === 'DAILY') {
      return ctx.wroteToday ? null : 'missing-today';
    }
    if (freq === 'WORKDAY') {
      const isWorkday = ctx.bjDow <= 4; // 周一~周五
      if (!isWorkday) return null;
      return ctx.wroteToday ? null : 'missing-today';
    }
    if (freq === 'WEEKLY_COUNT') {
      const target = dept.reportWeeklyCount ?? 0;
      if (target <= 0) return null;
      const deficit = target - ctx.weekCount;
      if (deficit <= 0) return null; // 本周已达标
      const daysLeftInclToday = 7 - ctx.bjDow; // 含今天在内的本周剩余自然日
      if (daysLeftInclToday < deficit) return `at-risk-weekly:${deficit}`; // 再不写就来不及
      return null;
    }
    return null;
  }

  /** 组装未写提醒文本（slots = 当天排的工作时间段，用于在提醒里告知“你今天本来要上班”） */
  private buildText(
    kind: string,
    now: Date,
    deptName: string,
    target?: number,
    weekCount?: number,
    slots?: { startMin: number; endMin: number }[],
  ): string {
    const planLine = slots?.length ? `今日工作安排：${slots.map((s) => slotRangeLabel(s.startMin, s.endMin)).join('、')}` : '';
    if (kind.startsWith('at-risk-weekly')) {
      const deficit = Number(kind.split(':')[1] ?? 0);
      return [
        `📝 日报进度提醒（${this.md(now)}）`,
        `你所在的「${deptName}」要求每周至少写 ${target} 篇日报，本周已写 ${weekCount} 篇，还差 ${deficit} 篇且即将到周末。`,
        ...(planLine ? [planLine] : []),
        '请尽快补写，避免影响部门日报统计。',
        '',
        `去写日报：${webLink('/reports')}`,
        '—— 来自 MyOrgniz 团队协作系统',
      ].join('\n');
    }
    return [
      `📝 日报提醒（${this.md(now)}）`,
      '你今天安排了工作时间，日报还没有提交，请尽快到系统「工作管理」页面补写。',
      ...(planLine ? [planLine] : []),
      '',
      `点此直接填写：${webLink('/reports')}`,
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
  }

  /** 批量取“今天（北京周几）排了工作时间”的成员 → 当天时间段（没排的人不在 Map 里） */
  private async plannedSlotsToday(userIds: string[], weekday: number) {
    const out = new Map<string, { startMin: number; endMin: number }[]>();
    if (!userIds.length) return out;
    const rows = await this.prisma.userWorkSlot.findMany({
      where: { userId: { in: userIds }, weekday },
      orderBy: [{ startMin: 'asc' }],
      select: { userId: true, startMin: true, endMin: true },
    });
    for (const r of rows) {
      const list = out.get(r.userId) ?? [];
      list.push({ startMin: r.startMin, endMin: r.endMin });
      out.set(r.userId, list);
    }
    return out;
  }

  async run(opts: { dryRun?: boolean; force?: boolean } = {}) {
    const dryRun = !!opts.dryRun;
    const force = !!opts.force;
    const now = new Date();
    const base = {
      now: fmtBeijing(now),
      dryRun,
      force,
      enabled: this.enabled,
      dwsAvailable: this.dm.available,
    };
    if (!this.enabled && !dryRun) {
      return { ...base, skipped: true, reason: 'REPORT_REMINDER_ENABLED=false' };
    }

    const today = fmtBeijingDate(now);
    const nowMin = this.bjMinutesOfDay(now);
    const bjDow = this.bjDow(now);

    // 本地自然日/本周一（与 submitDaily/submitWeekly 存 periodStart 的口径一致：服务器本地零点）
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const dayIdx = (todayStart.getDay() + 6) % 7;
    const mondayLocal = new Date(todayStart);
    mondayLocal.setDate(todayStart.getDate() - dayIdx);

    const depts = await this.prisma.department.findMany({
      where: { reportFrequency: { not: 'NONE' } },
      select: { id: true, name: true, reportFrequency: true, reportWeeklyCount: true, reportRemindTime: true },
    });

    const items: {
      userId: string;
      name: string;
      deptName: string;
      to: string;
      via: string;
      reason: string;
      text: string;
      sent: boolean;
      error?: string;
    }[] = [];
    /** 本轮被提醒的成员（结束后汇总抄送负责人与管理员） */
    const ccItems: ReminderCcItem[] = [];
    /** 今日没排工作时间、因此不算应发日报而跳过的人数 */
    let noPlanToday = 0;

    for (const dept of depts) {
      // 未到该部门的提醒时间点则跳过（force 绕过，仅管理员手动验证用）
      if (!force && nowMin < this.parseTimeToMinutes(dept.reportRemindTime)) continue;

      const members = await this.prisma.user.findMany({
        where: { departmentId: dept.id, active: true },
        select: { id: true, name: true, phone: true, lastReportRemindAt: true },
      });
      if (!members.length) continue;

      const memberIds = members.map((m) => m.id);
      // 今日排班（北京周几）：当天没排工作时间的人不属于应发日报人员，不进入提醒
      const plannedToday = await this.plannedSlotsToday(memberIds, bjDow);
      // 本周日报（DAILY）批量取回，在内存判定今日是否已写/本周篇数
      const reports = await this.prisma.report.findMany({
        where: { type: 'DAILY', ownerId: { in: memberIds }, periodStart: { gte: mondayLocal } },
        select: { ownerId: true, periodStart: true },
      });
      const weekCount = new Map<string, number>();
      const wroteTodaySet = new Set<string>();
      const todayKey = todayStart.getTime();
      for (const r of reports) {
        if (!r.ownerId) continue;
        weekCount.set(r.ownerId, (weekCount.get(r.ownerId) ?? 0) + 1);
        if (r.periodStart && r.periodStart.getTime() === todayKey) wroteTodaySet.add(r.ownerId);
      }

      for (const m of members) {
        const missing = this.evaluateMissing(dept, {
          weekCount: weekCount.get(m.id) ?? 0,
          wroteToday: wroteTodaySet.has(m.id),
          bjDow,
        });
        if (!missing) continue;
        // 应发日报口径：当天没排工作时间就不提醒（含从没去填过安排的人，一律按排班判定）
        const daySlots = plannedToday.get(m.id) ?? [];
        if (!daySlots.length) {
          noPlanToday += 1;
          continue;
        }
        // 频控：每人每个北京日最多提醒一次
        if (m.lastReportRemindAt && fmtBeijingDate(m.lastReportRemindAt) === today) continue;

        const text = this.buildText(
          missing,
          now,
          dept.name,
          dept.reportWeeklyCount ?? undefined,
          weekCount.get(m.id) ?? 0,
          daySlots,
        );
        const target = await this.dm.resolveTarget(m);
        if (dryRun) {
          items.push({ userId: m.id, name: m.name, deptName: dept.name, to: target.to, via: target.via, reason: missing, text, sent: false });
          ccItems.push({ userId: m.id, name: m.name, summary: this.ccSummary(missing) });
          continue;
        }
        const r = await this.dm.sendDm(target.to, text);
        if (r.ok) {
          await this.prisma.user.update({ where: { id: m.id }, data: { lastReportRemindAt: now } });
          ccItems.push({ userId: m.id, name: m.name, summary: this.ccSummary(missing) });
          this.logger.log(`日报提醒已私聊「${m.name}」（${dept.name}，via ${target.via}，${missing}）`);
        } else {
          this.logger.error(`日报提醒发送失败（${m.name} → ${target.to}）: ${r.error}`);
        }
        items.push({ userId: m.id, name: m.name, deptName: dept.name, to: target.to, via: target.via, reason: missing, text, sent: r.ok, error: r.error });
      }
    }

    const cc = await this.dm.ccReminders(ccItems, { dryRun, title: '日报未写提醒' });
    return { ...base, departments: depts.length, reminded: items.filter((i) => i.sent).length, noPlanToday, items, cc };
  }

  /** 抄送摘要：把内部提醒原因转为负责人/管理员可读的一句话 */
  private ccSummary(missing: string): string {
    if (missing.startsWith('at-risk-weekly')) {
      return `本周日报还差 ${Number(missing.split(':')[1] ?? 0)} 篇`;
    }
    return '今日日报未提交';
  }
}
