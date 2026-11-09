/** 北京时间相对 UTC 的固定偏移（中国无夏令时） */
export const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 格式化为北京时间的墙钟字符串（YYYY-MM-DD HH:mm:ss）
 * 时间口径约定：钉钉窗口、AI 提示词日志等一律用北京墙钟显式生成，
 * 绝不依赖容器时区（线上 api 容器为 UTC，曾因此让钉钉抓取窗口少 8 小时）
 */
export function fmtBeijing(d: Date): string {
  const b = new Date(d.getTime() + CN_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ` +
    `${p(b.getUTCHours())}:${p(b.getUTCMinutes())}:${p(b.getUTCSeconds())}`
  );
}

/** 北京时间的日期部分（YYYY-MM-DD），用于按天分文件的日志命名 */
export function fmtBeijingDate(d: Date): string {
  return fmtBeijing(d).slice(0, 10);
}

/**
 * ISO 周标签：'2026-W42'（按北京墙钟日期计算，用于自动生成幂等键与周次展示）
 */
export function isoWeekOf(d: Date): string {
  const bj = new Date(d.getTime() + CN_OFFSET_MS);
  // 取北京日期部分的年/月/日，按 ISO 规则以周四所在周定年
  const y = bj.getUTCFullYear();
  const m = bj.getUTCMonth();
  const day = bj.getUTCDate();
  const local = new Date(Date.UTC(y, m, day));
  const dow = (local.getUTCDay() + 6) % 7; // 0=周一
  const thursday = new Date(local.getTime() - dow * 86400000 + 3 * 86400000);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.floor((thursday.getTime() - yearStart.getTime()) / 604800000) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 该时刻所在北京周的周一 00:00（绝对时刻），与周报 periodStart 对齐
 * 注意：返回的是绝对时刻，其 toISOString() 前缀为前一天（-8h 偏移），
 * 展示/缓存日期串请用 beijingMondayOf 结果再取北京时间日期。
 */
export function beijingMondayOf(d: Date): Date {
  const bj = new Date(d.getTime() + CN_OFFSET_MS);
  const dow = (bj.getUTCDay() + 6) % 7; // 0=周一
  const monday = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - dow * 86400000;
  return new Date(monday - CN_OFFSET_MS);
}

/** 北京周一的日期串（YYYY-MM-DD），用于周次标签与 Setting 缓存键 */
export function beijingMondayDate(d: Date): string {
  return fmtBeijingDate(beijingMondayOf(d));
}

/**
 * 中文周次标注：'{M}月第{N}周'，按北京墙钟计算
 * N = 该 ISO 周周一所在自然月的第几个自然周（周一日期落在哪个月就是哪月）
 */
export function cnWeekLabel(d: Date): string {
  const monday = beijingMondayOf(d);
  const bj = new Date(monday.getTime() + CN_OFFSET_MS);
  const month = bj.getUTCMonth() + 1;
  const dayOfMonth = bj.getUTCDate();
  // 该周一是本月第几天 → 落在第几个 7 天段
  const nth = Math.floor((dayOfMonth - 1) / 7) + 1;
  return `${month}月第${nth}周`;
}
