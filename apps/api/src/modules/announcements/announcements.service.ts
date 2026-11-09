import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class AnnouncementsService {
  constructor(private prisma: PrismaService) {}

  /** 公告列表（含重点工作任务聚合，供公告栏首页展示） */
  async list(options: { keyword?: string; activeOnly?: boolean }) {
    const now = new Date();
    const announcements = await this.prisma.announcement.findMany({
      where: {
        ...(options.keyword
          ? { title: { contains: options.keyword } }
          : {}),
        ...(options.activeOnly
          ? { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }
          : {}),
      },
      include: {
        author: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });

    // 重点工作任务：进行中的高优先级任务（公告栏聚合展示；回收站项目下的任务不展示，与首页待办同口径）
    const keyTasks = await this.prisma.task.findMany({
      where: {
        status: { not: 'DONE' },
        project: { deletedAt: null },
        OR: [{ priority: 'URGENT' }, { priority: 'HIGH' }],
      },
      include: {
        project: { select: { id: true, name: true, color: true } },
        assignee: { select: { id: true, name: true } },
      },
      orderBy: [{ priority: 'asc' }, { dueDate: 'asc' }],
      take: 10,
    });

    return { announcements, keyTasks };
  }

  async get(id: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
    if (!announcement) throw new NotFoundException('公告不存在');
    return announcement;
  }

  async create(
    userId: string,
    data: { title: string; content: string; pinned?: boolean; expiresAt?: string | null },
  ) {
    return this.prisma.announcement.create({
      data: {
        title: data.title,
        content: data.content,
        authorId: userId,
        pinned: data.pinned ?? false,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
  }

  async update(
    id: string,
    data: {
      title?: string;
      content?: string;
      pinned?: boolean;
      expiresAt?: string | null;
    },
  ) {
    return this.prisma.announcement.update({
      where: { id },
      data: {
        ...data,
        expiresAt:
          data.expiresAt !== undefined
            ? data.expiresAt
              ? new Date(data.expiresAt)
              : null
            : undefined,
      },
      include: { author: { select: { id: true, name: true, avatar: true } } },
    });
  }

  async remove(id: string) {
    return this.prisma.announcement.delete({ where: { id } });
  }
}
