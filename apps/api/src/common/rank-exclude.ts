import type { PrismaService } from './prisma.service';

/**
 * 不参与各类排行榜的成员（老板/管理层只看不排）
 *
 * 覆盖的排行榜：首页「PBC 排行」「本周工时排行」、工时排行页、项目/报表里的工时排行、
 * 每周工时排名（管理后台预览 + 周日发钉钉群）。
 * 排除后：不进名次、不计入合计工时、不计入填报人数（避免「全公司填报 x/y 人」失真）。
 *
 * 按邮箱或姓名任一命中即排除（姓名兜底，换邮箱也不影响）。
 * 以后新增「只看不排」的人：往下面两个数组追加即可，各排行榜逻辑无需再改。
 */
const EXCLUDED_EMAILS = ['walkup@local.myorgniz', 'shushu@local.myorgniz'];
const EXCLUDED_NAMES = ['杨力', '书书'];

/** 不参与排行的成员 id 集合（排行榜取数时按此过滤） */
export async function rankExcludedUserIds(prisma: Pick<PrismaService, 'user'>): Promise<Set<string>> {
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { in: EXCLUDED_EMAILS } }, { name: { in: EXCLUDED_NAMES } }] },
    select: { id: true },
  });
  return new Set(users.map((u) => u.id));
}
