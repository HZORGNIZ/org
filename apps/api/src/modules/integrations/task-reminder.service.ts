import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { CN_OFFSET_MS, fmtBeijing, fmtBeijingDate } from '../../common/beijing-time';
import { webLink } from '../../common/web-link';
import { DingtalkDmService, ReminderCcItem } from './dingtalk-dm.service';

/** 允许发送的北京时间窗口 [7:00, 20:00)：要求不在晚 8 点到次日早 7 点之间发送提醒 */
const SEND_HOUR_FROM = 7;
const SEND_HOUR_TO = 20; // 不含

/** 单条消息最多列出的任务数（超出折叠为「等共 N 个」） */
const MAX_LISTED = 10;

/** 逾期任务条目（含负责人与项目，供分组提醒） */
interface OverdueTask {
  id: string;
  title: string;
  dueDate: Date | null;
  lastRemindAt: Date | null;
  assignee: { id: string; name: string; phone: string | null; active: boolean } | null;
  project: { id: string; name: string };
}

/**
 * 任务逾期提醒（每小时定时检查，见 TaskReminderQueue）
 * - 规则：任务超过截止日期仍未完成（状态非 DONE；截止日当天不算逾期），
 *   钉钉私聊提醒任务负责人尽快完成并更新状态
 * - 禁发时段：晚 20:00 ~ 次日 07:00 不发送（cron 只落在 8-19 点，服务内再校验一次）
 * - 频控：每个逾期任务每个北京日最多提醒一次（Task.lastRemindAt 记录上次发送时间）
 * - 发送目标解析：优先钉钉 userId（UserIdentity，纯数字可唯一解析）→ 手机号反查 orgUserId → 姓名兜底
 * - 抄送：每轮成功提醒的成员汇总后，同时发给其主部门负责人与全部管理员（见 DingtalkDmService.ccReminders）
 * - force=true 仅管理员手动验证用：绕过发送时段限制（每日一次频控仍生效）
 */
@Injectable()
export class TaskReminderService {
  private readonly logger = new Logger(TaskReminderService.name);
  private readonly enabled: boolean;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private dm: DingtalkDmService,
  ) {
    this.enabled = this.config.get<string>('TASK_REMINDER_ENABLED', 'true') === 'true';
  }

  /** 北京时间小时（0-23；不依赖容器时区） */
  private bjHour(now: Date): number {
    return Number(fmtBeijing(now).slice(11, 13));
  }

  /** 北京时间今天 0 点对应的绝对时刻（dueDate 早于此即截止日在昨天或更早 → 已逾期） */
  private bjDayStart(now: Date): Date {
    const bj = new Date(now.getTime() + CN_OFFSET_MS);
    return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - CN_OFFSET_MS);
  }

  /** 「M.D」北京日期标签（dueDate 为真实时刻，需 +8h 换算北京墙钟） */
  private md(d: Date): string {
    const b = new Date(d.getTime() + CN_OFFSET_MS).toISOString();
    return `${Number(b.slice(5, 7))}.${Number(b.slice(8, 10))}`;
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
      return { ...base, skipped: true, reason: 'TASK_REMINDER_ENABLED=false' };
    }
    // 禁发时段保护：晚 20:00 ~ 次日 07:00 不发送（force 仅供管理员手动验证用）
    const hour = this.bjHour(now);
    if (!force && (hour < SEND_HOUR_FROM || hour >= SEND_HOUR_TO)) {
      return {
        ...base,
        skipped: true,
        reason: `当前北京时间 ${fmtBeijing(now)} 处于禁发时段（晚 8 点至次日早 7 点不发送）`,
      };
    }

    // 逾期未完成任务：截止日早于今天（北京口径，当天到期不算逾期），且未完成
    // 回收站（软删除）项目下的任务不再提醒：人在任务列表里看不到也打不开，发钉钉只会造成困扰
    const candidates = await this.prisma.task.findMany({
      where: {
        status: { not: 'DONE' },
        assigneeId: { not: null },
        dueDate: { lt: this.bjDayStart(now) },
        project: { deletedAt: null },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        lastRemindAt: true,
        assignee: { select: { id: true, name: true, phone: true, active: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ dueDate: 'asc' }],
    });
    const today = fmtBeijingDate(now);
    // 频控：每个任务每个北京日最多提醒一次；负责人已停用的跳过
    const due = (candidates as OverdueTask[]).filter(
      (t) => !!t.assignee?.active && (!t.lastRemindAt || fmtBeijingDate(t.lastRemindAt) !== today),
    );
    if (!due.length) {
      return { ...base, candidates: candidates.length, users: 0, items: [] };
    }

    // 按负责人分组：一人一条消息，避免同一人多任务时刷屏
    const byUser = new Map<string, OverdueTask[]>();
    for (const t of due) {
      const arr = byUser.get(t.assignee!.id) ?? [];
      arr.push(t);
      byUser.set(t.assignee!.id, arr);
    }

    const items: {
      userId: string;
      name: string;
      to: string;
      via: string;
      taskCount: number;
      text: string;
      sent: boolean;
      error?: string;
    }[] = [];
    /** 已成功提醒的成员（本轮结束后汇总抄送负责人与管理员） */
    const ccItems: ReminderCcItem[] = [];
    for (const [userId, list] of byUser) {
      const user = list[0].assignee!;
      const text = this.buildText(list, now);
      if (dryRun) {
        const target = await this.dm.resolveTarget(user);
        items.push({ userId, name: user.name, to: target.to, via: target.via, taskCount: list.length, text, sent: false });
        ccItems.push({ userId, name: user.name, summary: `${list.length} 个任务逾期未完成` });
        continue;
      }
      const target = await this.dm.resolveTarget(user);
      const r = await this.dm.sendDm(target.to, text);
      if (r.ok) {
        // 仅成功的任务更新提醒时间（发送失败不做频控，下一轮自动重试）
        await this.prisma.task.updateMany({
          where: { id: { in: list.map((t) => t.id) } },
          data: { lastRemindAt: now },
        });
        ccItems.push({ userId, name: user.name, summary: `${list.length} 个任务逾期未完成` });
        this.logger.log(`逾期提醒已私聊「${user.name}」（${list.length} 个任务，via ${target.via}）`);
      } else {
        this.logger.error(`逾期提醒发送失败（${user.name} → ${target.to}）: ${r.error}`);
      }
      items.push({ userId, name: user.name, to: target.to, via: target.via, taskCount: list.length, text, sent: r.ok, error: r.error });
    }
    const cc = await this.dm.ccReminders(ccItems, { dryRun, title: '任务逾期提醒' });
    return { ...base, candidates: candidates.length, users: items.length, items, cc };
  }

  /** 组装提醒文本：标题 + 逾期任务清单（最多 10 条，每条带可点击深链）+ 统一入口 */
  private buildText(list: OverdueTask[], now: Date): string {
    const shown = list
      .slice(0, MAX_LISTED)
      .map(
        (t, i) =>
          `${i + 1}. 【${t.project.name}】${t.title}（截止 ${t.dueDate ? this.md(t.dueDate) : '-'}）\n   处理：${webLink(`/tasks?open=${t.id}`)}`,
      );
    if (list.length > shown.length) shown.push(`… 等共 ${list.length} 个任务`);
    return [
      `⏰ 任务逾期提醒（${this.md(now)}）`,
      `你有 ${list.length} 个任务已超过截止时间，请尽快完成并在系统中更新任务状态：`,
      ...shown,
      '',
      `全部待办：${webLink('/tasks')}`,
      '—— 来自 MyOrgniz 团队协作系统',
    ].join('\n');
  }
}
