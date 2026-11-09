import { PrismaClient } from '@prisma/client';

/**
 * 下一个工号：工号按注册时间顺序分配（1 起，只增不复用），注册与管理员建用户走同一口径。
 * 取「当前最大工号 + 1」而不是 count()+1，避免删除用户后新成员与老成员工号重叠。
 */
export async function nextEmployeeNo(prisma: PrismaClient): Promise<number> {
  const max = await prisma.user.aggregate({ _max: { employeeNo: true } });
  return (max._max.employeeNo ?? 0) + 1;
}
