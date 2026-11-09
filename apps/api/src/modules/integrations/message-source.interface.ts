/**
 * 消息源适配器接口：系统与外部 IM/办公平台解耦的核心抽象
 * - 钉钉是第一个实现（Stream 订阅 + Webhook 推送）
 * - 未来可扩展企微/飞书/邮件等，业务层只依赖本接口
 */
export interface MessageSourceAdapter {
  /** 来源标识：dingtalk / wecom / feishu / email ... */
  readonly source: string;
  /** 是否已配置启用 */
  readonly enabled: boolean;
  /** 启动监听（如钉钉 Stream 长连接） */
  start(): void;
  /** 停止监听 */
  stop(): void;
  /** 向指定频道推送文本消息（channel 由实现方解释，如群名/群 ID） */
  send(channel: string, content: string): Promise<{ ok: boolean; error?: string }>;
}

/** 收到的外部消息（统一结构后落库 MessageInbox） */
export interface InboundMessage {
  /** 平台消息 ID（用于去重，如钉钉 msgId） */
  msgId?: string;
  conversationId?: string;
  conversationName?: string;
  senderExternalId?: string;
  senderName?: string;
  messageType: 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'LINK' | 'OTHER';
  content?: string;
  raw?: unknown;
  receivedAt: Date;
}
