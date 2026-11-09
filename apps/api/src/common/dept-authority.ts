import { Prisma } from '@prisma/client';

/**
 * 部门管理权限的唯一判定入口（负责人 leaderId ∪ 共管人 managerIds）。
 * 大部门（如探索研发部 56 人）一个负责人管不过来，可增设多名共管人：
 * 共管人与负责人同权限，管的是整个部门（不是按项目切分）。
 *
 * 硬性约定：业务代码里不要再用裸 `leaderId: me.id` 判权限，一律走本文件，
 * 否则共管人会拿到界面入口却查不到数据（权限漂移）。
 */

/** 我管辖的部门 where 片段（喂 department.findMany / count / findFirst） */
export function ledDeptWhere(userId: string): Prisma.DepartmentWhereInput {
  return { OR: [{ leaderId: userId }, { managerIds: { has: userId } }] };
}

/** 项目「主要关联部门」里我有管理权限的关系过滤（喂 project.where.departments） */
export function deptOfProjectAuthority(userId: string): NonNullable<Prisma.ProjectWhereInput['departments']> {
  return { some: { department: ledDeptWhere(userId) } };
}

/** 单条部门记录上判定我是否有管理权限（需 select 出 leaderId + managerIds） */
export function isDeptAuthority(
  dept: { leaderId?: string | null; managerIds?: string[] } | null | undefined,
  userId: string,
): boolean {
  if (!dept) return false;
  return dept.leaderId === userId || (dept.managerIds ?? []).includes(userId);
}

/** 部门管理权限人员 id 列表（负责人 + 共管人，去重去空） */
export function deptAuthorityIds(dept: { leaderId?: string | null; managerIds?: string[] } | null | undefined): string[] {
  return [...new Set([dept?.leaderId, ...(dept?.managerIds ?? [])].filter((x): x is string => Boolean(x)))];
}

/**
 * 默认汇报对象（直属上级）推断：严格按「只向上」的层级，保证不成环：
 *  - 系统管理员：不分配上级（他们是顶层根）。
 *  - 其他人：主部门负责人 leaderId（非本人且在职）。
 *  - 负责人不可用（缺失 / 就是本人 / 已停用）时：
 *      · 部门管理者（DEPT_LEADER，含负责人与共管人）直接上指管理员，绝不横向指向同部门共管人（否则两人会互指成环）；
 *      · 普通成员（MEMBER/PROJECT_LEADER）可退到同部门在职共管人。
 *  - 最后兜底：首个在职 ADMIN（非本人）；仍无返回 null（保持为根）。
 * 回填、汇报树、列表、画像四处共用此唯一算法，避免口径漂移。
 */
export function pickDefaultManager(
  selfId: string,
  selfRole: string,
  mainDept: { leaderId?: string | null; managerIds?: string[] } | null | undefined,
  adminIds: readonly string[],
  isActive: (id: string) => boolean = () => true,
): string | null {
  if (selfRole === 'ADMIN') return null;
  const leader = mainDept?.leaderId;
  if (leader && leader !== selfId && isActive(leader)) return leader;
  // 负责人不可用：部门管理者不横向指共管人，直接走管理员；普通成员可退到在职共管人
  if (selfRole !== 'DEPT_LEADER') {
    for (const m of mainDept?.managerIds ?? []) {
      if (m && m !== selfId && isActive(m)) return m;
    }
  }
  for (const a of adminIds) {
    if (a !== selfId && isActive(a)) return a;
  }
  return null;
}

/**
 * 部门名册 where 片段：主部门成员 ∪ 额外部门成员，仅在职。
 * 一人可属多部门（User.departmentId 主部门 + UserDepartments 额外部门），
 * 只查 departmentId 会漏掉额外部门的人（历史遗漏，统一在这里补齐）。
 */
export function deptRosterWhere(deptIds: string | string[]): Prisma.UserWhereInput {
  const inIds = Array.isArray(deptIds) ? deptIds : [deptIds];
  return {
    active: true,
    OR: [{ departmentId: { in: inIds } }, { extraDepartments: { some: { id: { in: inIds } } } }],
  };
}
