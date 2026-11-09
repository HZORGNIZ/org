/**
 * 任务健康度：仅对未完成任务评估紧迫程度，用蓝色系由浅到深表示（深=延期/紧迫）。
 * 等级 0..3：0 浅（>7 天或无截止）｜1 中浅（≤7 天）｜2 中深（≤2 天，或 URGENT/HIGH 且 ≤5 天）｜3 深（已逾期）
 * 已完成任务归为「弱化」灰，不参与紧迫配色。
 */

export type HealthLevel = 0 | 1 | 2 | 3;

/** 与任务健康度深浅对应的蓝色系（索引即等级：浅→深） */
export const HEALTH_COLORS: Record<HealthLevel, { bar: string; bg: string; text: string }> = {
  0: { bar: '#b3d8ff', bg: '#f2f8ff', text: '#5a8bc4' }, // 浅
  1: { bar: '#7fb2f0', bg: '#e6f1ff', text: '#2f6fc0' }, // 中浅
  2: { bar: '#428bff', bg: '#d3e6ff', text: '#1b4fa8' }, // 中深
  3: { bar: '#1b4fa8', bg: '#c2d7f5', text: '#0f3d80' }, // 深（延期/紧迫）
};

/** 已完成：弱化灰 */
export const DONE_COLOR = { bar: '#c9ccd1', bg: '#f5f6f8', text: '#9aa0a6' };

/** 一天的毫秒数 */
const DAY = 86400000;

/** 取北京的“今天”零点时间戳（与后端 dueDate 通常存当日 00:00 对齐，避免时区误判逾期） */
function todayStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** 距离截止还有几天（负数=已逾期；无截止返回 null） */
export function daysToDue(dueDate?: string | Date | null): number | null {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return null;
  const dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  return Math.round((dueStart - todayStartMs()) / DAY);
}

/**
 * 计算任务健康度等级。已完成（status=DONE）返回 -1 表示弱化。
 * task 需含 status/dueDate/priority。
 */
export function taskHealth(task: {
  status?: string;
  dueDate?: string | Date | null;
  priority?: string;
}): number {
  if ((task.status ?? '').toUpperCase() === 'DONE') return -1;
  const d = daysToDue(task.dueDate);
  if (d === null) return 0; // 无截止 → 浅
  if (d < 0) return 3; // 已逾期 → 深
  const urgent = task.priority === 'URGENT' || task.priority === 'HIGH';
  if (d <= 2) return 2;
  if (urgent && d <= 5) return 2;
  if (d <= 7) return 1;
  return 0;
}

/** 等级对应的样式（含已完成弱化）：返回 left-bar 色、背景色、文字色 */
export function healthStyle(level: number): { bar: string; bg: string; text: string } {
  if (level < 0) return DONE_COLOR;
  return HEALTH_COLORS[(Math.max(0, Math.min(3, level)) as HealthLevel)];
}

/** 供 el-table row-class-name / class 绑定使用的健康度类名 */
export function healthClass(level: number): string {
  if (level < 0) return 'th-done';
  return `th-${level}`;
}
