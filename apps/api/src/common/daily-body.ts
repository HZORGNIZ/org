/**
 * 日报正文取值的唯一口径：AI 修正稿 > 手写原文 > 人工补充。
 * 部门详情的「最近进展」、日报看板、成员画像时间轴都要读同一份正文，
 * 各处自己写一遍容易漂移（比如漏掉 correctedContent），所以集中在这里。
 */
export function dailyBodyOf(
  r: { correctedContent?: string | null; rawContent?: string | null; manualContent?: string | null } | null | undefined,
): string {
  return String(r?.correctedContent || r?.rawContent || r?.manualContent || '').trim();
}

/** 正文摘要：压掉换行后截断，用于列表行内一行展示 */
export function dailyExcerpt(r: Parameters<typeof dailyBodyOf>[0], max = 80): string {
  const text = dailyBodyOf(r).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
