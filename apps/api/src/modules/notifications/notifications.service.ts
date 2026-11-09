import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async create(
    userId: string,
    data: {
      type: NotificationType;
      title: string;
      content?: string;
      link?: string;
    },
  ) {
    return this.prisma.notification.create({
      data: { userId, ...data },
    });
  }

  async createMany(userIds: string[], data: Omit<Parameters<NotificationsService['create']>[1], 'title'> & { title: string }) {
    if (!userIds.length) return;
    return this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, ...data })),
    });
  }

  async list(userId: string, unreadOnly = false, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unreadCount(userId: string) {
    return this.prisma.notification.count({
      where: { userId, read: false },
    });
  }

  async markRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }
}
