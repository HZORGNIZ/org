import { TASK_PRIORITY, TASK_STATUS, fmt } from './format';

/** 任务活动共享文案：详情抽屉「更新记录」与任务悬停浮窗复用（输出与历史一致） */

/** 单条活动动作中文（简短标题用） */
export const ACTION_TEXT: Record<string, string> = {
  created: '创建了任务',
  updated: '更新了任务',
  status_changed: '变更了状态',
  moved: '移动了任务',
  commented: '评论了任务',
  completed: '完成了任务',
};

/** 变更字段中文名 */
const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  status: '状态',
  priority: '优先级',
  assigneeId: '负责人',
  dueDate: '截止时间',
  startDate: '起始时间',
  progress: '进度',
  tags: '标签',
  columnId: '所属看板列',
  estimateHours: '预估工时',
};

export function actionLabel(a: any): string {
  return ACTION_TEXT[a.action] || a.action;
}

/** 值可读化：时间 ISO、百分比、枚举、用户 id（userMap 供 id→姓名）、空值 */
export function prettyVal(field: string, v: any, userMap?: Map<string, string>): string {
  if (v === null || v === undefined) return '未设置';
  if (field === 'progress') return `${v}%`;
  if (field === 'status') return TASK_STATUS[v]?.label ?? String(v);
  if (field === 'priority') return TASK_PRIORITY[v]?.label ?? String(v);
  if (field === 'assigneeId') {
    const name = userMap?.get(v);
    return name ?? (typeof v === 'string' && v.length > 12 ? `${v.slice(0, 6)}…` : String(v));
  }
  if (field === 'tags') return Array.isArray(v) && v.length ? v.join('、') : '无标签';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmt(v);
  return String(v);
}

/** 单条活动的明细行：逐字段“把什么从 A 改为 B”；进展说明（note）独立一行 */
export function activityLines(a: any, userMap?: Map<string, string>): { text: string; note?: boolean }[] {
  const d = a.detail || {};
  if (a.action === 'created') {
    return [{ text: `创建了任务「${d.title ?? ''}」` }];
  }
  if (a.action === 'commented') {
    return [{ text: `评论了任务：「${d.content ?? ''}」` }];
  }
  if (a.action === 'moved') {
    const col = d.columnName ? `「${d.columnName}」` : '（列表任务区）';
    return [{ text: `将任务移动到看板列 ${col}` }];
  }
  // updated：遍历后端记录的字段差异，逐个展示具体变更内容
  const lines: { text: string; note?: boolean }[] = [];
  for (const key of Object.keys(d)) {
    if (key === 'note') continue;
    const chg = d[key];
    if (!chg || typeof chg !== 'object' || !('from' in chg)) continue;
    const label = FIELD_LABELS[key] ?? key;
    const from = prettyVal(key, chg.from, userMap);
    const to = prettyVal(key, chg.to, userMap);
    if (from === to) continue;
    lines.push({ text: `将${label}由「${from}」改为「${to}」` });
  }
  if (d.note) lines.push({ text: `进展说明：${d.note}`, note: true });
  return lines;
}
