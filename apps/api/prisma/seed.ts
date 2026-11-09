import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** 组织架构：部门（名称可增删改），及其明确命名的项目 */
const DEPARTMENTS: { name: string; description?: string; projects: string[] }[] = [
  {
    name: 'AI教育研发部',
    description: 'AI 教育后端与硬件产品开发',
    projects: [],
  },
  {
    name: '互联网软件研发部',
    description: '互联网软件产品研发（项目待定）',
    projects: [],
  },
  {
    name: '机器人研发部',
    description: '管道机器人研发，以及其他机器人硬件产品研发',
    projects: ['管道机器人'],
  },
  {
    name: '探索研发部',
    description: '支持大学生团队参加竞赛、探索性产品研发；对其他部门提供技术支撑',
    projects: ['AI赋能大学生产品', '2026月球基地挑战杯', '2026工业环境感知挑战杯'],
  },
  {
    name: '研究生部',
    description: '长三角基金项目 2026、MIVLAB 研究生',
    projects: ['长三角基金项目2026', 'MIVLAB研究生'],
  },
];

const DEFAULT_POSITIONS = ['产品经理', '工程师', '运维'];

async function main() {
  const password = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@myorgniz.local' },
    create: {
      name: '管理员',
      email: 'admin@myorgniz.local',
      password,
      role: 'ADMIN',
    },
    update: {},
  });
  console.log('种子完成，管理员账号: admin@myorgniz.local / admin123');

  // 岗位清单（Setting key=positions）：不存在则初始化，存在则保留管理员自定义值
  await prisma.setting.upsert({
    where: { key: 'positions' },
    create: { key: 'positions', value: DEFAULT_POSITIONS },
    update: {},
  });

  // 部门与明确命名的项目（幂等：按名称 upsert）
  for (let i = 0; i < DEPARTMENTS.length; i++) {
    const d = DEPARTMENTS[i];
    const dept = await prisma.department.upsert({
      where: { name: d.name },
      create: { name: d.name, description: d.description, sortOrder: i },
      update: { description: d.description, sortOrder: i },
    });
    for (const pName of d.projects) {
      const exists = await prisma.project.findFirst({
        where: { name: pName },
        include: { departments: { where: { departmentId: dept.id } } },
      });
      if (!exists) {
        await prisma.project.create({
          data: { name: pName, ownerId: admin.id, departments: { create: [{ departmentId: dept.id }] } },
        });
      } else if (!exists.departments.length) {
        await prisma.projectDepartment.create({ data: { projectId: exists.id, departmentId: dept.id } });
      }
    }
  }
  console.log(`已预置 ${DEPARTMENTS.length} 个部门与岗位清单`);

  // 示例：默认项目 + 看板
  const existing = await prisma.project.count();
  if (existing === 0) {
    const project = await prisma.project.create({
      data: { name: '示例项目', description: '首个项目，用于熟悉系统', color: '#409eff', ownerId: admin.id },
    });
    const board = await prisma.kanbanBoard.create({
      data: {
        projectId: project.id,
        name: '任务看板',
        columns: {
          create: [
            { name: '待办', sortOrder: 0 },
            { name: '进行中', sortOrder: 1 },
            { name: '已完成', sortOrder: 2 },
          ],
        },
      },
    });
    const columns = await prisma.kanbanColumn.findMany({ where: { boardId: board.id } });
    await prisma.task.create({
      data: {
        projectId: project.id,
        boardId: board.id,
        columnId: columns[0].id,
        title: '欢迎使用 MyOrgniz',
        description: '试试拖拽卡片、创建任务、生成日报。',
        creatorId: admin.id,
        assigneeId: admin.id,
        priority: 'HIGH',
        tags: { create: [{ name: '入门' }] },
      },
    });
    console.log('已创建示例项目与看板');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
