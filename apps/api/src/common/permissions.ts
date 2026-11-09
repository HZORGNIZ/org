import { Role } from '@prisma/client';

/**
 * 角色层级序（权限上限，越大越高）：
 * ADMIN(3) > DEPT_LEADER(2) > PROJECT_LEADER(1) > MEMBER(0)
 * 未知/空角色按 0（最低）处理。
 */
const ROLE_RANK: Record<string, number> = {
  [Role.ADMIN]: 3,
  [Role.DEPT_LEADER]: 2,
  [Role.PROJECT_LEADER]: 1,
  [Role.MEMBER]: 0,
};

export function roleRank(role?: string | null): number {
  if (!role) return 0;
  return ROLE_RANK[role] ?? 0;
}

/** 用户角色是否达到所需最低层级（按角色序，而非精确匹配） */
export function hasAtLeast(userRole: string | null | undefined, requiredRole: string): boolean {
  return roleRank(userRole) >= roleRank(requiredRole);
}
