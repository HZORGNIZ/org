import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { CN_OFFSET_MS, fmtBeijing, fmtBeijingDate } from '../../common/beijing-time';
import { DingtalkDmService } from '../integrations/dingtalk-dm.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * 通知类别
 * - INVITE 发布邀请（私聊参会人 + 站内信）
 * - GROUP 发布群通知（钉钉群）
 * - START 会议开始提醒（私聊 + 站内信）
 * - CANCEL 会议取消（私聊 + 群 + 站内信）
 * - MINUTES 纪要发布（群摘要 + 站内信）
 * - MATERIAL 会前材料缺交催办（私聊）
 * - WRAP_UP 会后引导（私聊主持人整理纪要）
 * - DRAFT_NUDGE 周会待发布提醒（冷启动首场，私聊负责人）
 */
export type MeetingNotifyKind = 'INVITE' | 'GROUP' | 'START' | 'CANCEL' | 'MINUTES' | 'MATERIAL' | 'WRAP_UP' | 'DRAFT_NUDGE';

/** 强时效类别：任何时候都发（Q3 批复：开始提醒与会议群通知豁免禁发窗口，否则深夜会议形同虚设） */
const ALWAYS_SEND: MeetingNotifyKind[] = ['INVITE', 'GROUP', 'START', 'CANCEL', 'MINUTES'];
/** 常规类别的禁发窗口 [7:00, 20:00)：与任务逾期提醒同口径 */
const SEND_HOUR_FROM = 7;
const SEND_HOUR_TO = 20;

/** 单条群/私聊发送结果 */
export interface NotifyItem {
  userId?: string;
  name?: string;
  to: string;
  via: string;
  sent: boolean;
  text: string;
  error?: string;
}

/** 一次通知的执行报告（供接口返回与日志核对） */
export interface NotifyReport {
  kind: MeetingNotifyKind;
  meetingId: string;
  title: string;
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
  group?: NotifyItem;
  dms: NotifyItem[];
  notified: number;
}

/** 通知所需的会议字段（由 loadMeeting 加载，显式声明以免依赖生成类型） */
interface NotifyMeeting {
  id: string;
  title: string;
  status: string;
  agenda: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date;
  ownerId: string;
  minutes: string | null;
  cancelledReason: string | null;
  materialType: string | null;
  materialRequirement: string | null;
  materialDeadline: Date | null;
  groupConversationId: string | null;
  groupName: string | null;
  notifyMode: string; // BOTH / GROUP / DM（只约束钉钉，站内信始终写）
  minutesWriterId: string | null;
  autoCreated: boolean;
  draftNudgeSentAt: Date | null;
  startNotifiedAt: Date | null;
  groupNotifiedAt: Date | null;
  minutesSentAt: Date | null;
  minutesEditedAt: Date | null;
  wrapUpNotifiedAt: Date | null;
  owner: { id: string; name: string } | null;
  minutesWriter: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

/**
 * 会议通知编排（钉钉群 + 钉钉私聊 + 站内信 + 文案）
 * - 一律「通知失败不阻断业务」：所有外部调用 try/catch，只写日志与报告，绝不向调用方抛错
 * - 幂等：GROUP 看 groupNotifiedAt、START 看 startNotifiedAt、MINUTES 看 minutesSentAt（force 可重发）
 * - 实际发送由 MeetingReminderWorker 消费队列执行，避免发布接口被 dws 子进程拖住
 */
@Injectable()
export class MeetingNotifyService {
  private readonly logger = new Logger(MeetingNotifyService.name);
  /** 站内信/消息里的会议详情链接前缀（默认生产域名，可用 MEETING_SITE_URL 覆盖） */
  private readonly siteUrl: string;

  constructor(
    private prisma: PrismaService,
    private dm: DingtalkDmService,
    private notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.siteUrl = (config.get<string>('MEETING_SITE_URL', 'https://hzai.work') || 'https://hzai.work').replace(/\/+$/, '');
  }

  /** 加载会议（含主持人/部门/项目名）；不存在返回 null */
  async loadMeeting(id: string): Promise<NotifyMeeting | null> {
    return this.prisma.meeting.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true } },
        minutesWriter: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        slot: { select: { id: true, name: true } },
      },
    });
  }

  /** 北京时间小时（0-23；不依赖容器时区） */
  private bjHour(now: Date): number {
    return Number(fmtBeijing(now).slice(11, 13));
  }

  /** 禁发窗口判定：强时效 kind 永远放行，其余落在 [7,20) 之外才允许发 */
  private allowed(kind: MeetingNotifyKind, now = new Date()): { ok: boolean; reason?: string } {
    if (ALWAYS_SEND.includes(kind)) return { ok: true };
    const h = this.bjHour(now);
    if (h < SEND_HOUR_FROM || h >= SEND_HOUR_TO) {
      return { ok: false, reason: `当前北京时间 ${fmtBeijing(now)} 处于禁发时段（晚 8 点至次日早 7 点不发${kind === 'MATERIAL' ? '材料催办' : '提醒'}）` };
    }
    return { ok: true };
  }

  /** 钉钉消息里的会议详情绝对地址（站内信不适用，外部点开才能直达） */
  private siteLink(id: string): string {
    return `${this.siteUrl}/meetings/${id}`;
  }

  /** 站内信 link 字段必须是前端路由（NotificationsView 直接 router.push） */
  private routeLink(id: string): string {
    return `/meetings/${id}`;
  }

  /** 时间标签：'10-22 15:00 - 16:00'（北京墙钟，钉钉消息不依赖收件人时区） */
  private timeLabel(m: { startAt: Date; endAt: Date }): string {
    const s = fmtBeijing(m.startAt);
    return `${s.slice(5, 16)} - ${fmtBeijing(m.endAt).slice(11, 16)}`;
  }

  /** 材料要求标签 */
  private materialLabel(m: { materialType: string | null; materialRequirement: string | null; materialDeadline: Date | null }): string {
    if (!m.materialType || m.materialType === 'NONE') return '无';
    const base = m.materialRequirement?.trim()
      || (m.materialType === 'REPORT_WEEKLY' ? '本周周报' : m.materialType === 'REPORT_DAILY' ? '最近日报' : '会议文字材料');
    return m.materialDeadline ? `${base}（截止 ${fmtBeijing(m.materialDeadline).slice(5, 16)}）` : base;
  }

  /** 尾部：来源署名 */
  private tail(id: string): string[] {
    return ['', `进入系统查看会议详情 → ${this.siteLink(id)}`, '—— 来自 MyOrgniz 团队协作系统'];
  }

  /** 组装邀请正文（私聊） */
  private textInvite(m: NotifyMeeting): string {
    return [
      '📅 会议邀请',
      `《${m.title}》`,
      `时间：${this.timeLabel(m)}（北京时间）`,
      m.location ? `地点：${m.location}` : null,
      `主持人：${m.owner?.name ?? '-'}`,
      `议题：${(m.agenda ?? '').trim() || '-'}`,
      `会前材料：${this.materialLabel(m)}`,
      ...this.tail(m.id),
    ].filter(Boolean).join('\n');
  }

  /** 组装发布群通知（群） */
  private textGroup(m: NotifyMeeting, names: string[]): string {
    const shown = names.slice(0, 12).join('、');
    return [
      '📣 会议通知',
      `《${m.title}》`,
      `时间：${this.timeLabel(m)}（北京时间）${m.location ? `｜地点：${m.location}` : ''}`,
      `主持人：${m.owner?.name ?? '-'}`,
      `议题：${(m.agenda ?? '').trim() || '-'}`,
      `参会 ${names.length} 人：${names.length > 12 ? `${shown}…` : shown || '-'}`,
      `会前材料：${this.materialLabel(m)}`,
      ...this.tail(m.id),
    ].join('\n');
  }

  /** 组装开始提醒正文（私聊） */
  private textStart(m: NotifyMeeting, ready: number, missing: number): string {
    return [
      '📅 会议提醒',
      `《${m.title}》即将开始（${this.timeLabel(m)}）`,
      m.location ? `地点：${m.location}` : null,
      `议题：${(m.agenda ?? '').trim() || '-'}`,
      `材料：${ready}人已就绪${missing ? ` / ${missing}人未提交` : ''}`,
      ...this.tail(m.id),
    ].filter(Boolean).join('\n');
  }

  /** 组装取消正文（私聊/群共用） */
  private textCancel(m: NotifyMeeting): string {
    return [
      '⚠️ 会议取消',
      `《${m.title}》（${this.timeLabel(m)}）已取消`,
      m.cancelledReason ? `原因：${m.cancelledReason}` : null,
      '',
      '（已取消会议不影响此前生成的任务）',
      ...this.tail(m.id),
    ].filter(Boolean).join('\n');
  }

  /** 组装纪要摘要（群，截断 1200 字） */
  private textMinutes(m: NotifyMeeting): string {
    const body = (m.minutes ?? '').trim();
    const cut = body.length > 1200 ? `${body.slice(0, 1200)}…` : body;
    return [`📝 会议纪要｜《${m.title}》`, `会议时间：${this.timeLabel(m)}`, '', cut || '（纪要为空）', ...this.tail(m.id)].join('\n');
  }

  /** 组装材料催办正文（私聊） */
  private textMaterial(m: NotifyMeeting, name: string): string {
    return [
      '📎 会前材料提醒',
      `你好${name}，《${m.title}》将于 ${this.timeLabel(m)} 开始`,
      `会前材料：${this.materialLabel(m)}，目前尚未收到你的材料`,
      '请在会前于系统中提交，或补齐本周周报',
      ...this.tail(m.id),
    ].join('\n');
  }

  /** 组装会后引导正文（私聊纪要撰写人；非主持人时点名是谁派的活） */
  private textWrapUp(m: NotifyMeeting, itemCount: number): string {
    const writerId = m.minutesWriterId ?? m.ownerId;
    const toWriter = writerId !== m.ownerId && m.minutesWriter ? `受 ${m.owner?.name ?? '主持人'} 指派，` : '';
    return [
      '📝 会议已结束 1 小时，请整理纪要',
      `《${m.title}》已于 ${fmtBeijing(m.endAt).slice(5, 16)} 结束${toWriter ? `，本场纪要由你负责撰写` : ''}`,
      `当前条目 ${itemCount} 条${itemCount ? '（待办与风险将随纪要一并确认）' : '，可补录待办 / 风险 / 会后待处理'}`,
      ...this.tail(m.id),
    ].join('\n');
  }

  /** 组装周会待发布提醒（冷启动首场，私聊负责人） */
  private textDraftNudge(m: NotifyMeeting): string {
    return [
      '🗓 本周周会待发布',
      `《${m.title}》已由系统按周期位自动创建（${this.timeLabel(m)}），尚未发布`,
      `会前材料：${this.materialLabel(m)}`,
      '确认无误后点「发布」，系统即通知全体参会人并发送钉钉群；此后本部门的周会将自动生成并直接发群',
      ...this.tail(m.id),
    ].join('\n');
  }

  /** 参会人（活跃账号）；主持人默认也在名册内 */
  private async attendees(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id }, select: { participantIds: true, ownerId: true } });
    const ids = Array.from(new Set([...(m?.participantIds ?? []), ...(m?.ownerId ? [m.ownerId] : [])]));
    if (!ids.length) return [];
    return this.prisma.user.findMany({
      where: { id: { in: ids }, active: true },
      select: { id: true, name: true, phone: true },
    });
  }

  /** 私聊一批收件人（dryRun 只解析目标）；返回逐人结果 */
  private async sendDms(
    users: { id: string; name: string; phone: string | null }[],
    textFor: (u: { id: string; name: string; phone: string | null }) => string,
    dryRun: boolean,
  ): Promise<NotifyItem[]> {
    const out: NotifyItem[] = [];
    for (const u of users) {
      const text = textFor(u);
      const target = await this.dm.resolveTarget(u);
      if (dryRun) {
        out.push({ userId: u.id, name: u.name, to: target.to, via: target.via, sent: false, text });
        continue;
      }
      const r = await this.dm.sendDm(target.to, text);
      out.push({ userId: u.id, name: u.name, to: target.to, via: target.via, sent: r.ok, text, error: r.error });
      if (!r.ok) this.logger.warn(`会议私聊通知发送失败（${u.name} → ${target.to}）: ${r.error ?? '未知'}`);
    }
    return out;
  }

  /** 站内信（type=MEETING）；失败只记日志 */
  private async notifyInApp(userIds: string[], title: string, content: string, linkUrl: string): Promise<void> {
    if (!userIds.length) return;
    try {
      await this.notifications.createMany(userIds, { type: NotificationType.MEETING, title, content, link: linkUrl });
    } catch (e) {
      this.logger.error(`会议站内信写入失败（已忽略）: ${(e as Error).message}`);
    }
  }

  /** 会议名册就绪度：已就绪材料数 / 未交数（开始提醒文案用）；状态口径同 schema：PENDING/SUBMITTED/MISSING */
  private async readiness(meetingId: string) {
    const [ready, missing] = await Promise.all([
      this.prisma.meetingMaterial.count({ where: { meetingId, status: 'SUBMITTED' } }),
      this.prisma.meetingMaterial.count({ where: { meetingId, status: { in: ['PENDING', 'MISSING'] } } }),
    ]);
    return { ready, missing };
  }

  /**
   * 发布通知：群（若配了群）+ 逐人私聊邀请 + 站内信
   * - 群通知幂等看 groupNotifiedAt；邀请无独立幂等字段，由调用方「仅 DRAFT→SCHEDULED 时触发」保证一次
   * - notifyMode：GROUP 只发群不私聊、DM 只私聊不发群、BOTH 为默认（保持历史行为）；站内信不受此影响
   */
  async onPublish(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('GROUP', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const attendees = await this.attendees(id);
    const names = attendees.map((a) => a.name);
    const mode = (m.notifyMode || 'BOTH').toUpperCase();

    const report: NotifyReport = { kind: 'GROUP', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };

    // 1) 群通知（mode=DM 时跳过）
    if (m.groupConversationId && mode !== 'DM') {
      if (m.groupNotifiedAt && !opts.force) {
        report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: false, text: '', error: '本会议群通知已发送过' };
      } else {
        const text = this.textGroup(m, names);
        if (dryRun) {
          report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: false, text };
        } else {
          const r = await this.dm.sendGroup(m.groupConversationId, text);
          report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: r.ok, text, error: r.error };
          if (r.ok) {
            await this.prisma.meeting.update({ where: { id }, data: { groupNotifiedAt: new Date() } });
            this.logger.log(`会议通知已发群「${m.groupName || m.groupConversationId}」（${m.title}）`);
          } else {
            this.logger.warn(`会议通知群发失败（${m.groupName || m.groupConversationId}）: ${r.error}`);
          }
        }
      }
    }

    // 2) 邀请私聊（除主持人本人；mode=GROUP 时跳过）
    const invitees = mode === 'GROUP' ? [] : attendees.filter((a) => a.id !== m.ownerId);
    report.dms = await this.sendDms(invitees, (u) => this.textInvite(m), dryRun);
    report.notified = report.dms.filter((d) => d.sent).length;

    // 3) 站内信（含主持人自己，便于列表跳转）
    if (!dryRun) {
      await this.notifyInApp(
        attendees.map((a) => a.id),
        `会议邀请：《${m.title}》`,
        `时间 ${this.timeLabel(m)}｜主持人 ${m.owner?.name ?? '-'}｜会前材料 ${this.materialLabel(m)}`,
        this.routeLink(id),
      );
    }
    this.logger.log(`会议发布通知${dryRun ? '预览' : '完成'}「${m.title}」私聊 ${report.notified}/${invitees.length} 人${report.group ? `，群${report.group.sent ? '已发' : '未发'}` : '，无群'}`);
    return report;
  }

  /** 开始提醒：逐人私聊 + 站内信；幂等看 startNotifiedAt（Q3 已定稿：豁免禁发窗口，任何时候都发） */
  async onStart(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('START', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const report: NotifyReport = { kind: 'START', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };
    if (m.status === 'CANCELLED') return { ...report, skipped: true, reason: '会议已取消，不发开始提醒' };
    if (m.startNotifiedAt && !opts.force) return { ...report, skipped: true, reason: '开始提醒已发送过' };

    const { ready, missing } = await this.readiness(id);
    const attendees = await this.attendees(id);
    report.dms = await this.sendDms(attendees, () => this.textStart(m, ready, missing), dryRun);
    report.notified = report.dms.filter((d) => d.sent).length;
    if (!dryRun) {
      await this.notifyInApp(attendees.map((a) => a.id), `会议即将开始：《${m.title}》`, `${this.timeLabel(m)}｜材料 ${ready} 人已就绪`, this.routeLink(id));
      // 开始提醒是一次性事件：本轮跑过就置位，避免钉钉整体不可用时每 5 分钟给全员重复推；
      // 逐人失败已记入报告与日志，主持人可在会议详情手动补发
      await this.prisma.meeting.update({ where: { id }, data: { startNotifiedAt: new Date() } });
    }
    const failed = report.dms.filter((d) => !d.sent && d.error);
    this.logger.log(`会议开始提醒${dryRun ? '预览' : '发出'}「${m.title}」${report.notified}/${attendees.length} 人${failed.length ? `，失败 ${failed.length} 人` : ''}`);
    return report;
  }

  /** 取消通知：群 + 私聊 + 站内信 */
  async onCancel(id: string, opts: { dryRun?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('CANCEL', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const report: NotifyReport = { kind: 'CANCEL', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };
    if (m.groupConversationId) {
      const text = this.textCancel(m);
      if (dryRun) report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: false, text };
      else {
        const r = await this.dm.sendGroup(m.groupConversationId, text);
        report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: r.ok, text, error: r.error };
      }
    }
    const attendees = await this.attendees(id);
    report.dms = await this.sendDms(attendees.filter((a) => a.id !== m.ownerId), () => this.textCancel(m), dryRun);
    report.notified = report.dms.filter((d) => d.sent).length;
    if (!dryRun) {
      await this.notifyInApp(attendees.map((a) => a.id), `会议已取消：《${m.title}》`, `${this.timeLabel(m)}${m.cancelledReason ? `｜原因：${m.cancelledReason}` : ''}`, this.routeLink(id));
    }
    return report;
  }

  /** 纪要发群 + 站内信；幂等看 minutesSentAt，但「纪要改过」自动解锁（下一版本可再发） */
  async onMinutes(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('MINUTES', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const report: NotifyReport = { kind: 'MINUTES', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };
    if (!(m.minutes ?? '').trim()) return { ...report, skipped: true, reason: '纪要正文为空，未发送' };
    // 已发过且自那以后没改过纪要 → 不重推；改过纪要（minutesEditedAt 更新）则视为新版本，允许再发
    const alreadySent = !!m.minutesSentAt && !opts.force && (!m.minutesEditedAt || m.minutesSentAt >= m.minutesEditedAt);
    if (alreadySent) return { ...report, skipped: true, reason: `纪要已于 ${fmtBeijing(m.minutesSentAt!)} 发过，修改后才可再发（或用重发按钮）` };
    if (!m.groupConversationId) return { ...report, skipped: true, reason: '本会议未配置通知群，纪要未群发' };

    const text = this.textMinutes(m);
    if (dryRun) {
      report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: false, text };
      return report;
    }
    const r = await this.dm.sendGroup(m.groupConversationId, text);
    report.group = { to: m.groupName || m.groupConversationId, via: 'group', sent: r.ok, text, error: r.error };
    if (r.ok) {
      await this.prisma.meeting.update({ where: { id }, data: { minutesSentAt: new Date() } });
      const attendees = await this.attendees(id);
      await this.notifyInApp(attendees.map((a) => a.id), `会议纪要发布：《${m.title}》`, '纪要与待办已生成，点击查看完成进度', this.routeLink(id));
      this.logger.log(`会议纪要已发群「${m.groupName || m.groupConversationId}」（${m.title}）`);
    } else {
      this.logger.warn(`会议纪要群发失败（${m.groupName || m.groupConversationId}）: ${r.error}`);
    }
    return report;
  }

  /** 材料缺交催办（守禁发窗口；每人每北京日最多 1 条，看 MeetingMaterial.lastRemindAt） */
  async onMaterialNudge(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('MATERIAL', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const report: NotifyReport = { kind: 'MATERIAL', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };
    if (!m.materialType && !m.materialRequirement) return { ...report, skipped: true, reason: '本次会议不要求会前材料' };
    const gate = this.allowed('MATERIAL');
    if (!gate.ok && !opts.force) return { ...report, skipped: true, reason: gate.reason };

    const today = fmtBeijingDate(new Date());
    // 未交 = PENDING（发布时建档但还没交）+ MISSING（P0-c 读不到周报）
    const pending = await this.prisma.meetingMaterial.findMany({
      where: { meetingId: id, status: { in: ['PENDING', 'MISSING'] } },
      include: { user: { select: { id: true, name: true, phone: true, active: true } } },
    });
    const due = pending.filter((x) => x.user?.active && (!x.lastRemindAt || fmtBeijingDate(x.lastRemindAt) !== today));
    if (!due.length) return { ...report, skipped: true, reason: pending.length ? '今日已催办过' : '无缺交材料' };

    const now = new Date();
    report.dms = await this.sendDms(due.map((x) => x.user!), (u) => this.textMaterial(m, u.name), dryRun);
    report.notified = report.dms.filter((d) => d.sent).length;
    if (!dryRun) {
      // 本轮尝试过的都记提醒时间（含发送失败），保证「每人每北京日最多 1 条」硬承诺，不会每隔 5 分钟重推
      const triedIds = report.dms.filter((d) => d.userId).map((d) => d.userId!);
      if (triedIds.length) {
        await this.prisma.meetingMaterial.updateMany({ where: { meetingId: id, userId: { in: triedIds } }, data: { lastRemindAt: now } });
      }
    }
    return report;
  }

  /** 周会待发布提醒（冷启动首场；守禁发窗口，每会议每北京日最多 1 条） */
  async onDraftNudge(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('DRAFT_NUDGE', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const report: NotifyReport = { kind: 'DRAFT_NUDGE', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };
    if (m.status !== 'DRAFT' || !m.autoCreated) return { ...report, skipped: true, reason: '仅自动创建的待发布周会需要提醒' };
    const gate = this.allowed('DRAFT_NUDGE');
    if (!gate.ok && !opts.force) return { ...report, skipped: true, reason: gate.reason };
    if (m.draftNudgeSentAt && fmtBeijingDate(m.draftNudgeSentAt) === fmtBeijingDate(new Date()) && !opts.force) {
      return { ...report, skipped: true, reason: '今日已提醒过负责人' };
    }

    const owner = await this.prisma.user.findUnique({
      where: { id: m.ownerId },
      select: { id: true, name: true, phone: true, active: true },
    });
    if (!owner?.active) return { ...report, skipped: true, reason: '主持人账号已停用' };
    report.dms = await this.sendDms([owner], () => this.textDraftNudge(m), dryRun);
    report.notified = report.dms.filter((d) => d.sent).length;
    if (!dryRun && report.notified) {
      await this.prisma.meeting.update({ where: { id }, data: { draftNudgeSentAt: new Date() } });
      await this.notifyInApp([owner.id], `本周周会待发布：《${m.title}》`, '系统已按周期位创建，确认无误后点发布即通知全员', this.routeLink(id));
    }
    return report;
  }

  /**
   * 会后引导：只私聊纪要撰写人（默认主持人）；幂等看 wrapUpNotifiedAt（守禁发窗口，每会议一次）
   * - 纪要已有内容则不提醒（写了就不骚扰）
   */
  async onWrapUp(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    const m = await this.loadMeeting(id);
    if (!m) return this.empty('WRAP_UP', id, '(会议不存在)', opts);
    const dryRun = !!opts.dryRun;
    const report: NotifyReport = { kind: 'WRAP_UP', meetingId: id, title: m.title, dryRun, dms: [], notified: 0 };
    if (m.status !== 'IN_PROGRESS') return { ...report, skipped: true, reason: '仅已结束但仍标记进行中的会议需要引导' };
    if ((m.minutes ?? '').trim()) return { ...report, skipped: true, reason: '纪要已填写，不再提醒' };
    const gate = this.allowed('WRAP_UP');
    if (!gate.ok && !opts.force) return { ...report, skipped: true, reason: gate.reason };
    if (m.wrapUpNotifiedAt && !opts.force) return { ...report, skipped: true, reason: '已提醒过纪要撰写人' };

    const writerId = m.minutesWriterId ?? m.ownerId;
    const writer = await this.prisma.user.findUnique({
      where: { id: writerId },
      select: { id: true, name: true, phone: true, active: true },
    });
    if (!writer?.active) return { ...report, skipped: true, reason: '纪要撰写人账号已停用' };
    const itemCount = await this.prisma.meetingItem.count({ where: { meetingId: id } });
    report.dms = await this.sendDms([writer], () => this.textWrapUp(m, itemCount), dryRun);
    report.notified = report.dms.filter((d) => d.sent).length;
    if (!dryRun) {
      // 跑过就置位：同一场会只引导一次，避免钉钉发送失败时反复骚扰撰写人
      await this.prisma.meeting.update({ where: { id }, data: { wrapUpNotifiedAt: new Date() } });
      await this.notifyInApp([writer.id, m.ownerId], `请整理会议纪要：《${m.title}》`, `条目 ${itemCount} 条，会后待处理与纪要在此确认`, this.routeLink(id));
    }
    return report;
  }

  /** 统一入口：按 kind 分派（队列消费与手动接口共用）；报告里的 kind 以请求类型为准（INVITE 与 GROUP 共用 onPublish） */
  async dispatch(kind: MeetingNotifyKind, id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<NotifyReport> {
    if (kind === 'INVITE' || kind === 'GROUP') return { ...(await this.onPublish(id, opts)), kind };
    if (kind === 'START') return this.onStart(id, opts);
    if (kind === 'CANCEL') return this.onCancel(id, opts);
    if (kind === 'MINUTES') return this.onMinutes(id, opts);
    if (kind === 'MATERIAL') return this.onMaterialNudge(id, opts);
    if (kind === 'WRAP_UP') return this.onWrapUp(id, opts);
    return this.onDraftNudge(id, opts);
  }

  private empty(kind: MeetingNotifyKind, meetingId: string, title: string, opts: { dryRun?: boolean }): NotifyReport {
    return { kind, meetingId, title, dryRun: !!opts.dryRun, dms: [], notified: 0 };
  }

  /** 距北京某时刻的分钟差（用于按 remindAt 判定；纯墙钟换算，不依赖容器时区） */
  minutesToStart(startAt: Date, beforeMinutes: number, now = new Date()): number {
    const target = startAt.getTime() - beforeMinutes * 60_000;
    return Math.round((target - now.getTime()) / 60_000);
  }

  /** 'M.D' 北京日期标签（沿用既有提醒文案风格） */
  md(d: Date): string {
    const b = new Date(d.getTime() + CN_OFFSET_MS).toISOString();
    return `${Number(b.slice(5, 7))}.${Number(b.slice(8, 10))}`;
  }
}
