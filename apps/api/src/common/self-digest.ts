/**
 * 判断是否「系统自身每日群发的团队工作进展总结」消息。
 *
 * 背景：daily-digest 用个人身份（dws send-to-group）把各项目「📣 …团队工作进展…」总结发到项目群后，
 * dingtalk-fetch 会把这条自发消息当普通群消息抓回 MessageInbox；若不从进展提取 / 日报碎片输入中剔除，
 * AI 会把它再次浓缩成该项目的进展，形成「发群 → 抓回 → 再提取」的自反馈回灌（回音壁），
 * 使无关/跨项目内容在项目中反复固化。
 *
 * 判据取稳定签名：私聊汇总与项目群发两种正文都以 `📣` 开头，且标题含「团队工作进展」；
 * 金句可通过 DINGTALK_DIGEST_MOTTO_DEFAULT 配置，故不作为判据。
 */
export function isSelfDigestMessage(content?: string | null): boolean {
  if (!content) return false;
  const c = content.trim();
  return c.startsWith('📣') || c.includes('团队工作进展');
}
