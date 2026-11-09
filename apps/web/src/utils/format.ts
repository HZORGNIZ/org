import dayjs from 'dayjs';

/** 相对时间：刚刚 / x分钟前 / x小时前 / 日期 */
export function timeAgo(input: string | Date): string {
  const t = dayjs(input);
  const diff = dayjs().diff(t, 'minute');
  if (diff < 1) return '刚刚';
  if (diff < 60) return `${diff} 分钟前`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return t.format('MM-DD');
}

export function fmt(input: string | Date | null | undefined, template = 'MM-DD HH:mm'): string {
  if (!input) return '-';
  return dayjs(input).format(template);
}

/** 简写时间：同年 M.D HH:mm（如 9.8 14:30，不带前导零/中文月日），跨年带年份 YYYY.M.D HH:mm */
export function fmtShort(input: string | Date | null | undefined): string {
  if (!input) return '-';
  const t = dayjs(input);
  return t.format(t.year() === dayjs().year() ? 'M.D HH:mm' : 'YYYY.M.D HH:mm');
}

/** 简写日期（无时分）：同年 M.D（如 9.8），跨年 YYYY.M.D；用于进展前缀日期展示 */
export function fmtDay(input: string | Date | null | undefined): string {
  if (!input) return '-';
  const t = dayjs(input);
  return t.format(t.year() === dayjs().year() ? 'M.D' : 'YYYY.M.D');
}

/** 进展日期基准（Date）：群聊来源（AI_GROUP）取消息窗口止 periodEnd（消息日），其余来源无消息窗口用创建日；非法/缺失返回 null */
export function updateDay(u: { source?: string; periodEnd?: string | Date | null; createdAt?: string | Date | null } | null | undefined): Date | null {
  if (!u) return null;
  if (u.source === 'AI_GROUP') {
    // 群聊进展的消息窗口时间按「北京墙钟字面量」存储（见后端 dingtalk-fetch.service.ts 时间口径约定），
    // 这里直接取字面量的日期部分（不做时区换算），避免晚间消息的日期滚到次日
    let wall = '';
    if (typeof u.periodEnd === 'string') wall = u.periodEnd.slice(0, 10);
    else if (u.periodEnd) {
      const t = dayjs(u.periodEnd);
      if (!t.isValid()) return null;
      wall = t.toISOString().slice(0, 10);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wall)) return null;
    const d = dayjs(`${wall}T00:00:00`);
    return d.isValid() ? d.toDate() : null;
  }
  if (!u.createdAt) return null;
  const t = dayjs(u.createdAt);
  return t.isValid() ? t.toDate() : null;
}

/** 进展展示日期（简写）：群聊来源（AI_GROUP）取消息窗口止 periodEnd（消息日），其余来源无消息窗口用创建日 */
export function updateDate(u: { source?: string; periodEnd?: string | Date | null; createdAt?: string | Date | null } | null | undefined): string {
  const d = updateDay(u);
  return d ? fmtDay(d) : '-';
}

/** 该进展的日期基准是否为今天（AI_GROUP 看消息日，其余看创建日） */
export function isUpdateToday(u: { source?: string; periodEnd?: string | Date | null; createdAt?: string | Date | null } | null | undefined): boolean {
  const d = updateDay(u);
  return !!d && dayjs(d).isSame(dayjs(), 'day');
}

/** 是否为今天（用于“当天生成”高亮） */
export function isToday(input: string | Date | null | undefined): boolean {
  if (!input) return false;
  return dayjs(input).isSame(dayjs(), 'day');
}

/** 文件大小可读化：B / KB / MB / GB（保留 1 位小数，整数量级不带小数） */
export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 任务状态中文 */
export const TASK_STATUS: Record<string, { label: string; type: 'info' | 'primary' | 'warning' | 'danger' | 'success' }> = {
  TODO: { label: '待办', type: 'info' },
  IN_PROGRESS: { label: '进行中', type: 'primary' },
  REVIEW: { label: '待评审', type: 'warning' },
  DONE: { label: '已完成', type: 'success' },
};

export const TASK_PRIORITY: Record<string, { label: string; type: 'info' | 'primary' | 'warning' | 'danger' }> = {
  LOW: { label: '低', type: 'info' },
  MEDIUM: { label: '中', type: 'primary' },
  HIGH: { label: '高', type: 'warning' },
  URGENT: { label: '紧急', type: 'danger' },
};

export const REPORT_TYPE: Record<string, string> = {
  DAILY: '日报',
  WEEKLY: '周报',
};

/** 文档空间文件可见范围（对齐后端 FileVisibility；PUBLIC 需管理员审批后才生效；EXTERNAL 面向外部游客凭密码访问） */
export const FILE_VIS: Record<string, { label: string; short: string; type: 'info' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  DEPARTMENT: { label: '本部门所有人可见', short: '部门', type: 'success' },
  PROJECT: { label: '本项目所有人可见', short: '项目', type: 'primary' },
  PRIVATE: { label: '仅自己可见', short: '私有', type: 'warning' },
  PUBLIC: { label: '全员可见', short: '全员', type: 'info' },
  EXTERNAL: { label: '对外部可见（需密码）', short: '外部', type: 'danger' },
};

/** 文档空间审批状态（NONE 不展示标签） */
export const FILE_APPROVAL: Record<string, { label: string; type: 'info' | 'success' | 'danger' | 'warning' } | undefined> = {
  NONE: undefined,
  PENDING: { label: '待审批', type: 'warning' },
  APPROVED: { label: '已同意', type: 'success' },
  REJECTED: { label: '已驳回', type: 'danger' },
};

export const BOOKING_STATUS: Record<string, { label: string; type: 'info' | 'primary' | 'success' | 'danger' | 'warning' }> = {
  PENDING: { label: '待审批', type: 'warning' },
  APPROVED: { label: '已通过', type: 'success' },
  REJECTED: { label: '已拒绝', type: 'danger' },
  CANCELLED: { label: '已取消', type: 'info' },
  FINISHED: { label: '已完成', type: 'primary' },
};
