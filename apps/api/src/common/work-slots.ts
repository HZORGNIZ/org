/**
 * 个人工作时间安排（工作管理页右侧「我的工作时间安排」）的公共口径：
 * - 时间段为固定预设（上午 / 下午 / 晚上），前端只做勾选，不做自由拖拽
 * - 周一~周日为一周循环模板（不是按日历日期排），改了就长期生效
 * - 「应发日报人员」= 当天（北京周几）至少排了一个时间段的人（见 ReportReminderService）
 */
export type WorkSlotPreset = { key: string; label: string; range: string; startMin: number; endMin: number };

/** 预设时间段（分钟数自北京时间 00:00 起算） */
export const WORK_SLOT_PRESETS: WorkSlotPreset[] = [
  { key: 'AM', label: '上午', range: '10:00-12:00', startMin: 10 * 60, endMin: 12 * 60 },
  { key: 'PM', label: '下午', range: '14:00-18:00', startMin: 14 * 60, endMin: 18 * 60 },
  { key: 'EVE', label: '晚上', range: '18:00-20:00', startMin: 18 * 60, endMin: 20 * 60 },
];

/** 周几标签（0=周一 … 6=周日，与 UserWorkSlot.weekday 一致） */
export const WORK_WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 分钟数 → 'HH:mm' */
export function fmtMinuteOfDay(min: number): string {
  const m = Math.max(0, Math.min(24 * 60, Math.trunc(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 单个时间段的可读标签，如 '10:00-12:00' */
export function slotRangeLabel(startMin: number, endMin: number): string {
  return `${fmtMinuteOfDay(startMin)}-${fmtMinuteOfDay(endMin)}`;
}

/** 一组时间段的总时长（小时，保留一位小数） */
export function slotsHours(slots: { startMin: number; endMin: number }[]): number {
  const total = slots.reduce((sum, s) => sum + Math.max(0, s.endMin - s.startMin), 0);
  return Math.round((total / 60) * 10) / 10;
}

/** 周几标签，越界回退空串 */
export function weekdayLabel(weekday: number): string {
  return WORK_WEEKDAY_LABELS[weekday] ?? '';
}
