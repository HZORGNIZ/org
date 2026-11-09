import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { fmtBeijing } from '../../common/beijing-time';
import { MeetingNotifyKind, MeetingNotifyService, NotifyReport } from './meeting-notify.service';

/** 已经开始超过这个时长的会议不再补发开始提醒（避免翻历史数据时群发轰炸） */
const START_GRACE_MS = 2 * 3600_000;
/** 会前多久开始催办缺交材料 */
const MATERIAL_LEAD_MS = 2 * 3600_000;
/** 会议结束后多久仍未写纪要 → 提醒纪要撰写人（需求：1 小时） */
const WRAP_UP_DELAY_MS = 60 * 60_000;
/** 单轮最多处理的会议数 */
const BATCH = 30;

/**
 * 会议到点提醒（BullMQ 消费端，见 MeetingReminderQueue / MeetingReminderWorker）
 * - tick（每 5 分钟）：
 *   1) 开始提醒：remindAt 到点且未发过的 SCHEDULED 会议 → 私聊全体参会人 + 站内信（Q3 已定稿：豁免禁发窗口）
 *   2) 材料催办：2 小时内开会且存在 MISSING 材料的会议 → 私聊缺交人（守 20:00–07:00 窗口，每人每北京日 1 条）
 *   3) 状态推进：到点且未结束的 SCHEDULED 自动置 IN_PROGRESS（必须在 1/2 之后，否则会抢掉它们的查询）
 *   4) 会后引导：结束超过 1 小时仍挂「进行中」且纪要未写 → 私聊纪要撰写人（默认主持人；守窗口，每场会 1 次）
 * - daily（每日 08:00）：自动创建但负责人还没点发布的周会 → 私聊负责人「本周周会待发布」（冷启动首场，守窗口）
 * - 幂等：Meeting.startNotifiedAt / draftNudgeSentAt / wrapUpNotifiedAt、MeetingMaterial.lastRemindAt（均在 NotifyService 内维护）
 * - dryRun 只解析目标并返回文案，不发送、不置幂等位、不改状态（管理员验收用）
 */
@Injectable()
export class MeetingReminderService {
  private readonly logger = new Logger(MeetingReminderService.name);
  private readonly enabled: boolean;

  constructor(
    private prisma: PrismaService,
    private notify: MeetingNotifyService,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('MEETING_REMINDER_ENABLED', 'true') === 'true';
  }

  /** 到点扫描：开始提醒 + 材料催办 + 状态推进 + 会后引导 */
  async runTick(opts: { dryRun?: boolean; force?: boolean } = {}) {
    const now = new Date();
    const base = { now: fmtBeijing(now), dryRun: !!opts.dryRun, enabled: this.enabled };
    if (!this.enabled && !opts.dryRun) return { ...base, skipped: true, reason: 'MEETING_REMINDER_ENABLED=false' };

    // 1) 开始提醒
    const startList = await this.prisma.meeting.findMany({
      where: {
        deletedAt: null,
        status: 'SCHEDULED',
        remindEnabled: true,
        remindAt: { not: null, lte: now },
        startNotifiedAt: null,
        startAt: { gte: new Date(now.getTime() - START_GRACE_MS) },
      },
      select: { id: true, title: true },
      orderBy: { remindAt: 'asc' },
      take: BATCH,
    });
    const startReports: NotifyReport[] = [];
    for (const m of startList) {
      startReports.push(await this.notify.onStart(m.id, opts));
    }

    // 2) 会前材料催办（仅还没开会、且要求材料的会议）
    const nudgeList = await this.prisma.meeting.findMany({
      where: {
        deletedAt: null,
        status: 'SCHEDULED',
        materialType: { not: null },
        startAt: { gt: now, lte: new Date(now.getTime() + MATERIAL_LEAD_MS) },
      },
      select: { id: true, title: true },
      orderBy: { startAt: 'asc' },
      take: BATCH,
    });
    const materialReports: NotifyReport[] = [];
    for (const m of nudgeList) {
      materialReports.push(await this.notify.onMaterialNudge(m.id, opts));
    }

    // 3) 状态推进：已进入会议时段但未结束 → 自动置「进行中」（放在最后，避免抢跑上面两个 SCHEDULED 查询）
    let moved = 0;
    if (!opts.dryRun) {
      const res = await this.prisma.meeting.updateMany({
        where: { deletedAt: null, status: 'SCHEDULED', startAt: { lte: now }, endAt: { gt: now } },
        data: { status: 'IN_PROGRESS' },
      });
      moved = res.count;
    }

    // 4) 会后引导：结束满 1 小时仍挂「进行中」且纪要未写 → 私聊纪要撰写人整理纪要
    const wrapList = await this.prisma.meeting.findMany({
      where: {
        deletedAt: null,
        status: 'IN_PROGRESS',
        endAt: { lte: new Date(now.getTime() - WRAP_UP_DELAY_MS) },
        OR: [{ minutes: null }, { minutes: '' }], // 纪要写了就不提醒（空字符串也算没写）
        ...(opts.force ? {} : { wrapUpNotifiedAt: null }),
      },
      select: { id: true, title: true },
      orderBy: { endAt: 'asc' },
      take: BATCH,
    });
    const wrapReports: NotifyReport[] = [];
    for (const m of wrapList) {
      wrapReports.push(await this.notify.onWrapUp(m.id, opts));
    }

    const sent = (list: NotifyReport[]) => list.filter((r) => !r.skipped).reduce((n, r) => n + r.notified, 0);
    this.logger.log(
      `会议到点扫描完成：开始提醒 ${startList.length} 场（发出 ${sent(startReports)} 条），材料催办 ${nudgeList.length} 场（发出 ${sent(materialReports)} 条），转入进行中 ${moved} 场，会后引导 ${wrapList.length} 场（发出 ${sent(wrapReports)} 条）`,
    );
    return {
      ...base,
      movedToProgress: moved,
      startMeetings: startReports,
      materialMeetings: materialReports,
      wrapUpMeetings: wrapReports,
      startNotified: sent(startReports),
      materialNotified: sent(materialReports),
      wrapUpNotified: sent(wrapReports),
    };
  }

  /** 每日：自动创建的待发布周会 → 提醒负责人点发布（冷启动首场；已 autoPilot 的会议不会走到这里） */
  async runDaily(opts: { dryRun?: boolean; force?: boolean } = {}) {
    const now = new Date();
    const base = { now: fmtBeijing(now), dryRun: !!opts.dryRun, enabled: this.enabled };
    if (!this.enabled && !opts.dryRun) return { ...base, skipped: true, reason: 'MEETING_REMINDER_ENABLED=false' };

    const drafts = await this.prisma.meeting.findMany({
      where: { deletedAt: null, status: 'DRAFT', autoCreated: true, slotId: { not: null }, startAt: { gt: now } },
      select: { id: true, title: true },
      orderBy: { startAt: 'asc' },
      take: 50,
    });
    const reports: NotifyReport[] = [];
    for (const m of drafts) {
      reports.push(await this.notify.onDraftNudge(m.id, opts));
    }
    const sent = reports.filter((r) => !r.skipped).reduce((n, r) => n + r.notified, 0);
    this.logger.log(`周会待发布提醒完成：草稿 ${drafts.length} 场，发出 ${sent} 条`);
    return { ...base, drafts: reports, notified: sent };
  }

  /** 单场会议立即通知（队列 send 任务与管理员手动接口共用） */
  async sendOne(meetingId: string, kind: MeetingNotifyKind, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    return this.notify.dispatch(kind, meetingId, opts);
  }
}
