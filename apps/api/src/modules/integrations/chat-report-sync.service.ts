import { Injectable, Logger } from '@nestjs/common';
import { ReportStatus, ReportType } from '@prisma/client';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../../common/prisma.service';
import { InboundMessage } from './message-source.interface';
import { DingtalkFetchService } from './dingtalk-fetch.service';
import { isSelfDigestMessage } from '../../common/self-digest';
import { beijingMondayOf } from '../../common/beijing-time';

/** 无意义占位消息（图片/文件/语音等），与进展生成共用同一口径 */
const PLACEHOLDER_RE = /^\[(图片|文件|语音|视频|链接|消息)\]/;

/** 报告识别启发式预筛：命中关键词或足够长的消息才调 AI 判定是否为日报/周报（省钱，普通短句直接走碎片） */
const REPORT_KEYWORD_RE = /(日报|周报|今日|今天|本周|这周|已完成|工作总结|计划)/;

/**
 * 群聊 → 个人日报段落同步：
 * 每次钉钉群消息拉取落库后，把「能绑定到系统用户的真人发言」按人/自然日聚合，
 * 调 AI 提炼为该成员当日工作记录一段，追加到其当日日报 rawContent
 * （标注【来自钉钉群聊·群名 时间】；当天无日报则自动创建）。
 * - 落库时同步 correctedContent（纯文本追加同一段落），保证群聊日报在列表/详情可见；
 *   correctedContent 仅服务展示层，不触发 processDaily AI 三段式整理、不触碰 ProjectUpdate
 * - 防重依赖 MessageInbox.msgId 唯一：只处理当批新增消息，重复拉取 added=0 自然跳过
 * - 不调用 processDaily/AI 修正，不触碰 ProjectUpdate（项目进展归 22 点批次）
 * - 任何单点异常不外抛，拉取主流程不受影响
 */
@Injectable()
export class ChatReportSyncService {
  private readonly logger = new Logger(ChatReportSyncService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private fetch: DingtalkFetchService,
  ) {}

  async syncDailyFragments(messages: InboundMessage[]): Promise<{ users: number; appended: number; skipped: number }> {
    const list = (messages ?? [])
      .filter((m) => typeof m.content === 'string' && m.content.trim())
      .filter((m) => !PLACEHOLDER_RE.test(m.content!) && m.content !== '[非文本消息]')
      .filter((m) => !isSelfDigestMessage(m.content)) // 剔除系统自身群发的「📣 团队工作进展」总结，避免被抓回后当作成员发言进日报再反哺
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    if (!list.length) return { users: 0, appended: 0, skipped: 0 };

    // 1. 群成员画像（10 分钟缓存）：按群过滤机器人，真人 openDingtalkId → 钉钉名
    const botsByCid = new Map<string, Set<string>>();
    const namesByCid = new Map<string, Map<string, string>>();
    for (const cid of [...new Set(list.map((m) => m.conversationId).filter(Boolean))] as string[]) {
      try {
        const members = await this.fetch.listGroupMembers(cid);
        botsByCid.set(cid, new Set(members.bots));
        namesByCid.set(cid, new Map(members.users.map((u) => [u.openDingtalkId, u.name])));
      } catch {
        botsByCid.set(cid, new Set());
        namesByCid.set(cid, new Map());
      }
    }

    // 2. 解析发送人 → 系统用户（跳过机器人/未绑定，逐条强验证后缓存命中）
    const userBySender = new Map<string, string>();
    const botSenders = new Set<string>();
    const senders = [...new Set(list.map((m) => m.senderExternalId).filter((x): x is string => Boolean(x)))];
    for (const sid of senders) {
      try {
        const cid = list.find((m) => m.senderExternalId === sid)?.conversationId;
        const botIds = cid ? botsByCid.get(cid) : undefined;
        if (botIds?.has(sid)) {
          botSenders.add(sid);
          continue;
        }
        const name = cid ? namesByCid.get(cid)?.get(sid) : undefined;
        const r = await this.fetch.resolveSenderIdentity(sid, name);
        if (r && 'userId' in r) userBySender.set(sid, r.userId);
        else if (r && 'bot' in r) botSenders.add(sid);
      } catch {
        // 身份解析失败跳过该发送人（不影响其他消息）
      }
    }

    // 3. 报告识别：真人发言中「本身就是一篇日报/周报」的消息 → 直接录入为报告，并从碎片流程剔除
    const nameByUserId = new Map<string, string>();
    for (const uid of new Set(userBySender.values())) {
      const u = await this.prisma.user.findUnique({ where: { id: uid }, select: { name: true } });
      if (u) nameByUserId.set(uid, u.name);
    }
    const consumed = await this.detectAndRecordReports(list, userBySender, nameByUserId);

    // 4. 按 (userId, 自然日) 分组（剔除已录入为报告的消息）
    const groups = new Map<string, { userId: string; date: string; msgs: InboundMessage[] }>();
    for (const m of list) {
      if (!m.senderExternalId) continue;
      if (consumed.has(m)) continue;
      const userId = userBySender.get(m.senderExternalId);
      if (!userId) continue;
      const key = `${userId}|${this.dayKey(m.receivedAt)}`;
      const g = groups.get(key) ?? { userId, date: this.dayKey(m.receivedAt), msgs: [] };
      g.msgs.push(m);
      groups.set(key, g);
    }
    if (!groups.size) return { users: 0, appended: 0, skipped: groups.size };

    let appended = 0;
    for (const g of groups.values()) {
      try {
        const ok = await this.appendFragment(g.userId, g.date, g.msgs);
        if (ok) appended++;
      } catch (e) {
        this.logger.warn(`同步群聊日报段落失败 userId=${g.userId} date=${g.date}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`群聊日报段落同步完成：${groups.size} 人·天分组，追加 ${appended} 条`);
    return { users: groups.size, appended, skipped: groups.size - appended };
  }

  /** 单个用户单日：AI 提炼发言 → 定位/创建当日日报 → rawContent 追加标注段落 */
  private async appendFragment(userId: string, date: string, msgs: InboundMessage[]): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    if (!user) return false;
    const groupNames = [...new Set(msgs.map((m) => m.conversationName ?? '钉钉群').filter(Boolean))];
    const lines = msgs.map((m) => {
      const t = m.receivedAt;
      const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return `[${hhmm}] ${m.content}`;
    });
    const ai = await this.ai.generateJson<{ ok?: boolean; fragment?: string }>('chat.report.fragment', {
      userName: user.name,
      groupName: groupNames.join('、') || '钉钉群',
      date,
      messages: lines.join('\n'),
    });
    const fragment = ai?.ok ? String(ai.fragment ?? '').trim() : '';
    if (!fragment) return false; // 无有效工作内容 → 不追加

    // 定位/创建该用户当日 DAILY 报告
    const [y, mo, d] = date.split('-').map(Number);
    const periodStart = new Date(y, mo - 1, d, 0, 0, 0, 0);
    const periodEnd = new Date(y, mo - 1, d + 1, 0, 0, 0, 0);
    const last = msgs[msgs.length - 1]?.receivedAt ?? periodStart;
    const hhmm = `${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}`;
    const tag = `【来自钉钉群聊·${groupNames.join('、')} ${hhmm}】`;
    const block = `${tag}\n${fragment}`;

    const existing = await this.prisma.report.findUnique({
      where: { type_ownerId_periodStart_scopeKey: { type: ReportType.DAILY, ownerId: userId, periodStart, scopeKey: '' } },
    });
    if (existing) {
      const raw = (existing.rawContent ?? '').replace(/\s+/g, '');
      const key = `${tag}\n${fragment}`.replace(/\s+/g, '');
      if (raw.includes(key)) return false; // 防重兜底
      await this.prisma.report.update({
        where: { id: existing.id },
        data: {
          rawContent: existing.rawContent ? `${existing.rawContent}\n${block}` : block,
          // 展示层同步：已有修正正文继续追加；否则以现有原文为底接续（防止纯群聊日报列表不可见）
          correctedContent: existing.correctedContent
            ? `${existing.correctedContent}\n${block}`
            : `${existing.rawContent ?? ''}\n${block}`,
          status: ReportStatus.PUBLISHED,
        },
      });
    } else {
      await this.prisma.report.create({
        data: {
          type: ReportType.DAILY,
          ownerId: userId,
          periodStart,
          periodEnd,
          rawContent: block,
          correctedContent: block, // 展示层同步，见类注释
          status: ReportStatus.PUBLISHED,
        },
      });
    }
    this.logger.log(`已为 ${user.name} 追加 ${date} 日报段落（${groupNames.join('、')}）`);
    return true;
  }

  /** 北京墙钟自然日键 'YYYY-MM-DD'（以服务器本地时区为准，与碎片口径一致） */
  private dayKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * 逐条识别“本身就是一篇日报/周报”的真人消息并录入为报告。
   * - 启发式预筛（长度/关键词）后才调 AI，控制成本
   * - 录入成功返回该消息集合（从碎片流程剔除）；单条异常吞掉不影响其他
   */
  private async detectAndRecordReports(
    list: InboundMessage[],
    userBySender: Map<string, string>,
    nameByUserId: Map<string, string>,
  ): Promise<Set<InboundMessage>> {
    const consumed = new Set<InboundMessage>();
    for (const m of list) {
      const userId = m.senderExternalId ? userBySender.get(m.senderExternalId) : undefined;
      if (!userId || !m.content) continue;
      const c = m.content.trim();
      if (c.length < 20 && !REPORT_KEYWORD_RE.test(c)) continue; // 预筛：短且无关键词直接走碎片
      try {
        const ai = await this.ai.generateJson<{ isReport?: boolean; type?: string; text?: string }>(
          'chat.detect.report',
          {
            userName: nameByUserId.get(userId) ?? '成员',
            date: this.dayKey(m.receivedAt),
            content: c.slice(0, 2000),
          },
        );
        if (!ai?.isReport) continue;
        const type = ai.type === 'WEEKLY' ? ReportType.WEEKLY : ReportType.DAILY;
        const text = String(ai.text ?? '').trim() || c;
        const ok = await this.recordReport(userId, type, m, text);
        if (ok) consumed.add(m);
      } catch (e) {
        this.logger.warn(`识别群消息是否为报告失败 msgId=${m.msgId ?? '-'}: ${(e as Error).message}`);
      }
    }
    if (consumed.size) this.logger.log(`群消息自动录入报告：识别并录入 ${consumed.size} 条`);
    return consumed;
  }

  /** 定位/创建该用户对应周期报告（DAILY=自然日 / WEEKLY=本周周一）；已存在则换行追加（同块去重） */
  private async recordReport(
    userId: string,
    type: ReportType,
    m: InboundMessage,
    text: string,
  ): Promise<boolean> {
    const { periodStart, periodEnd } = this.reportBounds(type, m.receivedAt);
    const t = m.receivedAt;
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const tag = `【来自钉钉群·自动录入 ${this.dayKey(t)} ${hhmm}】`;
    const block = `${tag}\n${text}`;
    const existing = await this.prisma.report.findUnique({
      where: { type_ownerId_periodStart_scopeKey: { type, ownerId: userId, periodStart, scopeKey: '' } },
    });
    if (existing) {
      const raw = (existing.rawContent ?? '').replace(/\s+/g, '');
      if (raw.includes(block.replace(/\s+/g, ''))) return false; // 防重兵底
      await this.prisma.report.update({
        where: { id: existing.id },
        data: {
          rawContent: existing.rawContent ? `${existing.rawContent}\n${block}` : block,
          correctedContent: existing.correctedContent
            ? `${existing.correctedContent}\n${block}`
            : `${existing.rawContent ?? ''}\n${block}`,
          status: ReportStatus.PUBLISHED,
        },
      });
    } else {
      await this.prisma.report.create({
        data: {
          type,
          ownerId: userId,
          periodStart,
          periodEnd,
          rawContent: block,
          correctedContent: block,
          status: ReportStatus.PUBLISHED,
        },
      });
    }
    const name = (await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? '成员';
    this.logger.log(`已为 ${name} 自动录入${type === ReportType.WEEKLY ? '周报' : '日报'}（${this.dayKey(t)}）`);
    return true;
  }

  /** 报告周期边界：DAILY=当日 00:00~+1天；WEEKLY=本周北京周一 00:00~+7天（与写入/读取侧统一） */
  private reportBounds(type: ReportType, at: Date): { periodStart: Date; periodEnd: Date } {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    if (type === ReportType.DAILY) {
      return { periodStart: d, periodEnd: new Date(d.getTime() + 86_400_000) };
    }
    const monday = beijingMondayOf(at);
    return { periodStart: monday, periodEnd: new Date(monday.getTime() + 7 * 86_400_000) };
  }
}
