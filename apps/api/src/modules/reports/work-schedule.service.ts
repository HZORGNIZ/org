import { BadRequestException, Injectable } from '@nestjs/common';
import { CN_OFFSET_MS } from '../../common/beijing-time';
import { PrismaService } from '../../common/prisma.service';
import { WORK_SLOT_PRESETS, WORK_WEEKDAY_LABELS, slotsHours, weekdayLabel } from '../../common/work-slots';

/** 提交上来的时间段（宽松入参，服务层统一校验/收敛） */
type SlotInput = { weekday?: number | string; startMin?: number | string; endMin?: number | string };
type SlotRow = { weekday: number; startMin: number; endMin: number };

/**
 * 个人工作时间安排（工作管理页右侧「我的工作时间安排」）
 * - 每周循环模板：周一~周日 × 预设时间段（上午 10-12 / 下午 14-18 / 晚上 18-20）
 * - 保存为整表覆盖（先删本人的再插入），前端一次提交整周勾选结果
 * - 供 ReportReminderService 判定「当天是否属于应发日报人员」与 DepartmentsService 展示今日排班
 */
@Injectable()
export class WorkScheduleService {
  constructor(private prisma: PrismaService) {}

  /** 北京时间的周几（0=周一 … 6=周日） */
  bjWeekday(now: Date = new Date()): number {
    const bj = new Date(now.getTime() + CN_OFFSET_MS);
    return (bj.getUTCDay() + 6) % 7;
  }

  /** 统一返回结构：预设 + 我的整周时间段 + 今日口径 */
  private shape(rows: SlotRow[]) {
    const todayWeekday = this.bjWeekday();
    const todaySlots = rows.filter((r) => r.weekday === todayWeekday);
    return {
      todayWeekday,
      todayLabel: weekdayLabel(todayWeekday),
      weekdayLabels: WORK_WEEKDAY_LABELS,
      presets: WORK_SLOT_PRESETS,
      slots: rows,
      totalSlots: rows.length,
      totalHours: slotsHours(rows),
      todaySlots,
      todayHours: slotsHours(todaySlots),
    };
  }

  /** 读取我的整周工作时间安排 */
  async getMine(userId: string) {
    const rows = await this.prisma.userWorkSlot.findMany({
      where: { userId },
      orderBy: [{ weekday: 'asc' }, { startMin: 'asc' }],
      select: { weekday: true, startMin: true, endMin: true },
    });
    return this.shape(rows);
  }

  /**
   * 批量读取若干成员的整周工作时间安排（项目详情页「成员工作时间」只读展示用）。
   * 返回 { presets, weekdayLabels, todayWeekday, todayLabel, users:[{ userId, slots, totalSlots, totalHours, todaySlots, todayHours }] }
   * - 顺序与传入 userIds 一致（前端二级 TAB 顺序不被打乱）
   * - 没有任何排班的成员也会返回一条空记录，前端据此显示「未排班」
   */
  async getMany(userIds: string[]) {
    const ids = [...new Set((userIds ?? []).filter(Boolean))].slice(0, 200);
    const todayWeekday = this.bjWeekday();
    const rows = ids.length
      ? await this.prisma.userWorkSlot.findMany({
          where: { userId: { in: ids } },
          orderBy: [{ weekday: 'asc' }, { startMin: 'asc' }],
          select: { userId: true, weekday: true, startMin: true, endMin: true },
        })
      : [];
    const byUser = new Map<string, SlotRow[]>();
    for (const r of rows) {
      const list = byUser.get(r.userId) ?? [];
      list.push({ weekday: r.weekday, startMin: r.startMin, endMin: r.endMin });
      byUser.set(r.userId, list);
    }
    return {
      todayWeekday,
      todayLabel: weekdayLabel(todayWeekday),
      weekdayLabels: WORK_WEEKDAY_LABELS,
      presets: WORK_SLOT_PRESETS,
      users: ids.map((userId) => {
        const list = byUser.get(userId) ?? [];
        const todaySlots = list.filter((r) => r.weekday === todayWeekday);
        return {
          userId,
          slots: list,
          totalSlots: list.length,
          totalHours: slotsHours(list),
          todaySlots,
          todayHours: slotsHours(todaySlots),
        };
      }),
    };
  }

  /** 校验 + 去重：weekday 0~6、时间在一天内、结束晚于开始、同一天不重叠 */
  private normalize(slots: unknown): SlotRow[] {
    if (slots === undefined || slots === null) return [];
    if (!Array.isArray(slots)) throw new BadRequestException('时间段须为数组');
    if (slots.length > 56) throw new BadRequestException('时间段过多（上限 56 段）');
    const picked = new Map<string, SlotRow>();
    for (const raw of slots as SlotInput[]) {
      const weekday = Number(raw?.weekday);
      const startMin = Number(raw?.startMin);
      const endMin = Number(raw?.endMin);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new BadRequestException('周几参数非法（0=周一 … 6=周日）');
      if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) throw new BadRequestException('时间段参数非法');
      if (startMin < 0 || endMin > 24 * 60 || endMin <= startMin) throw new BadRequestException('时间段须在 00:00-24:00 内且结束晚于开始');
      picked.set(`${weekday}-${startMin}-${endMin}`, { weekday, startMin, endMin });
    }
    const rows = [...picked.values()].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (prev.weekday === cur.weekday && cur.startMin < prev.endMin) {
        throw new BadRequestException('同一天的时间段不能重叠');
      }
    }
    return rows;
  }

  /** 保存我的整周工作时间安排（整表覆盖，返回保存后的最新状态） */
  async saveMine(userId: string, slots: unknown) {
    const rows = this.normalize(slots);
    await this.prisma.$transaction([
      this.prisma.userWorkSlot.deleteMany({ where: { userId } }),
      this.prisma.userWorkSlot.createMany({ data: rows.map((r) => ({ userId, ...r })) }),
    ]);
    return { ...this.shape(rows), saved: rows.length };
  }

  /**
   * 批量取「某天（北京周几）有排班」的成员集合，供日报提醒/部门视图复用。
   * 返回 Map<userId, 当天时间段[]>；没有排班的人不在 Map 里。
   */
  async plannedOn(userIds: string[], weekday: number): Promise<Map<string, SlotRow[]>> {
    const out = new Map<string, SlotRow[]>();
    if (!userIds.length) return out;
    const rows = await this.prisma.userWorkSlot.findMany({
      where: { userId: { in: userIds }, weekday },
      orderBy: [{ startMin: 'asc' }],
      select: { userId: true, weekday: true, startMin: true, endMin: true },
    });
    for (const r of rows) {
      const list = out.get(r.userId) ?? [];
      list.push({ weekday: r.weekday, startMin: r.startMin, endMin: r.endMin });
      out.set(r.userId, list);
    }
    return out;
  }
}
