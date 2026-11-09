/**
 * 站外可点击链接（钉钉群/私聊、站内信正文里用）
 *
 * 钉钉消息里的纯相对路径点不开，必须给完整 URL。基址优先取 APP_WEB_BASE_URL，
 * 未配置时回落到对外域名（生产入口 https://hzai.work）。换域名只需改这一处或环境变量。
 */
export function webBaseUrl(): string {
  const raw = (process.env.APP_WEB_BASE_URL || 'https://hzai.work').trim();
  return raw.replace(/\/+$/, '');
}

/** 相对路径 → 完整可点击链接（'/tasks?open=xx' → 'http://host/tasks?open=xx'） */
export function webLink(path: string): string {
  const p = String(path ?? '').trim();
  if (!p) return webBaseUrl();
  if (/^https?:\/\//i.test(p)) return p;
  return `${webBaseUrl()}${p.startsWith('/') ? p : `/${p}`}`;
}
