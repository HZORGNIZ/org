import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FeedbackStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { CurrentUserPayload } from '../../common/current-user.decorator';
import { fmtBeijing } from '../../common/beijing-time';
import { AiService } from '../ai/ai.service';
import { DingtalkFetchService } from '../integrations/dingtalk-fetch.service';
import { DingtalkDmService } from '../integrations/dingtalk-dm.service';
import { COMPANY_GROUP_NAME } from '../agent/agent.service';

/**
 * 使用体验反馈服务
 * - create：全员提交一条反馈，落库后尽力同步到公司全员大群（复用 Agent「发到公司群」的同一个群）；
 *   发送失败不回滚反馈，只回传 sent:false，保证「先收下、再补发」
 * - list / setStatus：管理后台「用户反馈」按状态管理（未受理 PENDING / 已受理 ACCEPTED），仅 ADMIN
 * - summarize：勾选若干（或全部未受理）反馈，交 AI 归纳成一份可直接交付开发的需求清单（Markdown，便于复制）
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  /** 公司群 conversationId 解析缓存（与 agent.service 同款：10 分钟，失败也缓存避免频繁跑 dws） */
  private groupCache: { at: number; value: { conversationId: string; name: string } | null } | null = null;

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private dingtalkFetch: DingtalkFetchService,
    private dm: DingtalkDmService,
  ) {}

  /** 解析公司全员大群 conversationId（按固定群名走 dws 查一次，内存缓存 10 分钟；查不到返回 null） */
  private async resolveGroup(): Promise<{ conversationId: string; name: string } | null> {
    const now = Date.now();
    if (this.groupCache && now - this.groupCache.at < 10 * 60 * 1000) return this.groupCache.value;
    let value: { conversationId: string; name: string } | null = null;
    try {
      const r = await this.dingtalkFetch.resolveGroupByName(COMPANY_GROUP_NAME);
      if (r.ok) value = { conversationId: r.conversationId, name: r.name || COMPANY_GROUP_NAME };
      else this.logger.warn(`反馈同步公司群「${COMPANY_GROUP_NAME}」解析失败：${r.reason}`);
    } catch (e: any) {
      this.logger.warn(`反馈同步公司群「${COMPANY_GROUP_NAME}」解析异常：${e?.message ?? e}`);
    }
    this.groupCache = { at: now, value };
    return value;
  }

  /** 反馈正文：公司群里一条消息（姓名 + 北京时间 + 原文） */
  private composeText(name: string, content: string): string {
    return [`【使用体验反馈】`, `来自：${name}`, `时间：${fmtBeijing(new Date()).slice(0, 16)}`, `内容：${content}`].join('\n');
  }

  /** 全员提交反馈：落库 + 尽力同步到公司群（发送失败不影响已入库结果） */
  async create(me: CurrentUserPayload, content: unknown) {
    const text = String(content ?? '').trim();
    if (!text) throw new BadRequestException('反馈内容不能为空');
    if (text.length > 2000) throw new BadRequestException('反馈内容请控制在 2000 字以内');
    const row = await this.prisma.feedback.create({ data: { userId: me.id, content: text } });

    let sent = false;
    let group: string | undefined;
    let error: string | undefined;
    try {
      const g = await this.resolveGroup();
      if (g) {
        group = g.name;
        const r = await this.dm.sendGroup(g.conversationId, this.composeText(me.name, text));
        sent = !!r.ok;
        if (!r.ok) error = r.error;
      } else {
        error = `未解析到公司群「${COMPANY_GROUP_NAME}」`;
      }
    } catch (e: any) {
      error = String(e?.message ?? e);
      this.logger.warn(`反馈同步公司群失败（id=${row.id}）：${error}`);
    }
    return { id: row.id, sent, group, error };
  }

  /** 管理后台列表（仅 ADMIN 路由可达）：按状态过滤，带提交人姓名/角色，最新在前 */
  async list(status: string) {
    const where =
      status === 'ALL' ? {} : { status: status === 'ACCEPTED' ? FeedbackStatus.ACCEPTED : FeedbackStatus.PENDING };
    const rows = await this.prisma.feedback.findMany({
      where,
      include: { user: { select: { name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows;
  }

  /** 切换受理状态（仅 ADMIN）：受理时记录受理人与时间，回退未受理时清空 */
  async setStatus(me: CurrentUserPayload, id: string, status: string) {
    const next = status === 'ACCEPTED' ? FeedbackStatus.ACCEPTED : FeedbackStatus.PENDING;
    const row = await this.prisma.feedback.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('反馈不存在');
    return this.prisma.feedback.update({
      where: { id },
      data:
        next === FeedbackStatus.ACCEPTED
          ? { status: next, handledById: me.id, handledAt: new Date() }
          : { status: next, handledById: null, handledAt: null },
    });
  }

  /** AI 总结：ids 非空则总结选中的，否则总结全部未受理；返回可直接复制的 Markdown 需求清单 */
  async summarize(me: CurrentUserPayload, ids: string[] | undefined) {
    const cleanIds = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
    const rows = cleanIds.length
      ? await this.prisma.feedback.findMany({
          where: { id: { in: cleanIds } },
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        })
      : await this.prisma.feedback.findMany({
          where: { status: FeedbackStatus.PENDING },
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
    if (!rows.length) return { ok: false, message: '没有可总结的反馈' };
    const items = rows.map((r, i) => `[${i + 1}] 提交人：${r.user?.name ?? '匿名'}\n内容：${r.content}`).join('\n\n');
    const text = await this.ai.generate('feedback.summary', { count: rows.length, items });
    if (!text) return { ok: false, message: 'AI 暂时不可用，请稍后重试', count: rows.length };
    return { ok: true, text: text.trim(), count: rows.length };
  }
}
