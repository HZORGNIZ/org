import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { InboxMessageType } from '@prisma/client';
import { DWClient } from 'dingtalk-stream';
import { PrismaService } from '../../common/prisma.service';
import { NewsPushPort } from '../news/news-fetch.service';
import { InboundMessage, MessageSourceAdapter } from './message-source.interface';

/**
 * 钉钉集成（不深度绑定，通过 MessageSourceAdapter 抽象）
 * - 接收：企业内部应用机器人 + Stream 模式长连接订阅群消息（无需公网入站端口）
 * - 发送：群自定义机器人 Webhook（加签模式）
 * - 所有钉钉字段只出现在本文件与 MessageInbox 原始数据中，业务层不感知
 */
@Injectable()
export class DingTalkService implements MessageSourceAdapter, OnModuleInit, OnModuleDestroy, NewsPushPort {
  readonly source = 'dingtalk';
  readonly enabled: boolean;
  private readonly logger = new Logger(DingTalkService.name);
  private bot: DWClient | null = null;
  private webhookUrl = '';
  private webhookSecret = '';
  private clientId = '';
  private clientSecret = '';
  private subscribedGroups: string[] = [];

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.enabled =
      this.config.get<string>('DINGTALK_ENABLED', 'false') === 'true' &&
      !!this.config.get<string>('DINGTALK_CLIENT_ID') &&
      !!this.config.get<string>('DINGTALK_CLIENT_SECRET');
    this.clientId = this.config.get<string>('DINGTALK_CLIENT_ID', '');
    this.clientSecret = this.config.get<string>('DINGTALK_CLIENT_SECRET', '');
    this.webhookUrl = this.config.get<string>('DINGTALK_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('DINGTALK_WEBHOOK_SECRET', '');
    this.subscribedGroups = (this.config.get<string>('DINGTALK_GROUPS', '') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('钉钉集成未启用（DINGTALK_ENABLED=false 或未配置凭证）');
      return;
    }
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  async start() {
    if (!this.enabled || this.bot) return;
    try {
      this.bot = new DWClient({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });

      // v2 协议（dingtalk-stream 2.x）：机器人消息（群聊/私聊/@）统一走 TOPIC_ROBOT
      // 注意：v2 网关只接受该 topic，混入 v1 旧 topic（GROUP_MESSAGE 等）会导致连接被拒（400）
      const topics = ['/v1.0/im/bot/messages/get'];
      for (const topic of topics) {
        this.bot.registerCallbackListener(topic, (message: any) => {
          this.onGroupMessage(this.normalize(message)).catch((e) =>
            this.logger.error('处理钉钉消息失败', e),
          );
        });
      }
      this.bot.on('error', (e: any) => this.logger.error('钉钉 Stream 异常', e));

      await this.bot.connect();
      this.logger.log(
        `钉钉 Stream 已连接，订阅群: ${this.subscribedGroups.length ? this.subscribedGroups.join(', ') : '全部'}`,
      );
    } catch (e) {
      this.logger.error('钉钉 Stream 启动失败', e as Error);
    }
  }

  /** 新 SDK 回调包装为 { headers, data }，data 为 JSON 字符串，这里归一化为消息体 */
  private normalize(message: any): any {
    if (!message) return {};
    let data = message.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = {};
      }
    }
    return data?.eventPayload ?? data ?? message;
  }

  stop() {
    try {
      this.bot?.disconnect();
    } catch {
      /* ignore */
    }
    this.bot = null;
  }

  /** 群消息落库（供日报/周报 AI 聚合使用） */
  private async onGroupMessage(message: any) {
    this.logger.log(
      `收到钉钉消息事件: type=${message.msgtype ?? message.type ?? '?'} sender=${message.senderNick ?? message.senderStaffId ?? '?'} conv=${message.conversationId ?? '?'} content=${String(this.extractText(message) ?? '').slice(0, 30)}`,
    );
    const conversationId: string | undefined = message.conversationId;
    if (this.subscribedGroups.length && conversationId && !this.subscribedGroups.includes(conversationId)) {
      return; // 只订阅配置中的群
    }
    const msgType = (message.msgtype ?? 'text').toUpperCase() as InboxMessageType;
    const inbound: InboundMessage = {
      msgId: message.msgId,
      conversationId,
      conversationName: message.conversationTitle ?? message.title ?? undefined,
      senderExternalId: message.senderStaffId,
      senderName: message.senderNick,
      messageType: this.mapType(msgType),
      content: this.extractText(message),
      raw: message,
      receivedAt: message.createAt ? new Date(message.createAt) : new Date(),
    };
    await this.persist(inbound);
  }

  /** 落库一条消息（msgId 唯一约束去重：已存在返回 false，重放/重复拉取直接跳过） */
  async persist(inbound: InboundMessage): Promise<boolean> {
    try {
      await this.prisma.messageInbox.create({ data: this.toDb(inbound) });
      return true;
    } catch (e: any) {
      // 平台重放/定时抓取重复拉取同一消息时 msgId 唯一约束冲突，视为已存在（去重）
      if (e?.code === 'P2002') return false;
      throw e;
    }
  }

  private mapType(t: InboxMessageType): InboundMessage['messageType'] {
    return ['TEXT', 'IMAGE', 'FILE', 'AUDIO', 'VIDEO', 'LINK', 'OTHER'].includes(t) ? (t as any) : 'OTHER';
  }

  private extractText(message: any): string | undefined {
    if (message.text?.content) return message.text.content;
    if (message.content) return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (message.msgtype === 'picture') return '[图片]';
    if (message.msgtype === 'file') return `[文件] ${message.file?.fileName ?? ''}`;
    if (message.msgtype === 'audio') return '[语音]';
    return `[${message.msgtype ?? '消息'}]`;
  }

  private toDb(m: InboundMessage) {
    return {
      source: this.source,
      msgId: m.msgId,
      conversationId: m.conversationId,
      conversationName: m.conversationName,
      senderExternalId: m.senderExternalId,
      senderName: m.senderName,
      messageType: m.messageType as InboxMessageType,
      content: m.content,
      raw: m.raw as any,
      receivedAt: m.receivedAt,
    };
  }

  /** 发送：群自定义机器人 Webhook（加签模式） */
  async send(channel: string, content: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.webhookUrl) return { ok: false, error: '未配置 DINGTALK_WEBHOOK_URL' };
    try {
      const timestamp = Date.now();
      const sign = createHmac('sha256', this.webhookSecret)
        .update(`${timestamp}\n${this.webhookSecret}`)
        .digest('base64');
      const url = `${this.webhookUrl}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title: 'MyOrgniz', text: content },
        }),
      });
      const data = (await res.json()) as any;
      if (data.errcode !== 0) return { ok: false, error: data.errmsg };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 资讯推送（NewsPushPort 实现）：推送到配置的推送群 */
  async pushNews(item: { title: string; summary?: string | null; url: string; tags?: string[] }): Promise<void> {
    const text = `### 📰 ${item.title}\n\n${item.summary ?? ''}\n\n[查看原文](${item.url})\n\n> ${(item.tags ?? []).map((t) => `#${t}`).join(' ')}`;
    const result = await this.send('push', text);
    if (!result.ok) this.logger.warn(`资讯推送失败: ${result.error}`);
  }

  status() {
    return {
      source: this.source,
      enabled: this.enabled,
      stream: !!this.bot,
      webhook: !!this.webhookUrl,
      subscribedGroups: this.subscribedGroups,
    };
  }
}
