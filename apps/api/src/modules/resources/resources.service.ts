import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class ResourcesService {
  constructor(private prisma: PrismaService) {}

  // ---- 资源 ----

  async listResources(type?: string) {
    return this.prisma.resource.findMany({
      where: { enabled: true, ...(type ? { type } : {}) },
      include: { _count: { select: { bookings: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createResource(data: {
    name: string;
    type: string;
    location?: string;
    capacity?: number;
    description?: string;
  }) {
    return this.prisma.resource.create({ data });
  }

  async updateResource(id: string, data: Partial<{ name: string; location: string; capacity: number; description: string; enabled: boolean }>) {
    return this.prisma.resource.update({ where: { id }, data });
  }

  async removeResource(id: string) {
    const bookings = await this.prisma.resourceBooking.count({ where: { resourceId: id } });
    if (bookings > 0) {
      // 有历史预约的资源仅停用，不物理删除
      return this.prisma.resource.update({ where: { id }, data: { enabled: false } });
    }
    return this.prisma.resource.delete({ where: { id } });
  }

  // ---- 预约 ----

  async listBookings(query: { resourceId?: string; status?: BookingStatus; start?: string; end?: string }) {
    const where: Prisma.ResourceBookingWhereInput = {
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.start || query.end
        ? {
            AND: [
              ...(query.start ? [{ endAt: { gte: new Date(query.start) } }] : []),
              ...(query.end ? [{ startAt: { lt: new Date(query.end) } }] : []),
            ],
          }
        : {}),
    };
    return this.prisma.resourceBooking.findMany({
      where,
      include: {
        resource: { select: { id: true, name: true, type: true, location: true } },
        booker: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { startAt: 'asc' },
      take: 200,
    });
  }

  /** 创建预约：时间段冲突检测（同资源重叠时间拒绝） */
  async createBooking(
    userId: string,
    data: {
      resourceId: string;
      title: string;
      purpose?: string;
      startAt: string;
      endAt: string;
      participants?: string[];
    },
  ) {
    const start = new Date(data.startAt);
    const end = new Date(data.endAt);
    if (end <= start) throw new BadRequestException('结束时间必须晚于开始时间');

    const conflict = await this.prisma.resourceBooking.findFirst({
      where: {
        resourceId: data.resourceId,
        status: { in: [BookingStatus.PENDING, BookingStatus.APPROVED] },
        AND: [{ startAt: { lt: end } }, { endAt: { gt: start } }],
      },
    });
    if (conflict) {
      throw new BadRequestException(
        `该资源在所选时间段已被预约（${conflict.title}，${conflict.startAt.toISOString().slice(0, 16)} ~ ${conflict.endAt.toISOString().slice(0, 16)}）`,
      );
    }
    return this.prisma.resourceBooking.create({
      data: {
        resourceId: data.resourceId,
        bookerId: userId,
        title: data.title,
        purpose: data.purpose,
        startAt: start,
        endAt: end,
        participants: data.participants ?? [],
      },
      include: {
        resource: { select: { id: true, name: true } },
        booker: { select: { id: true, name: true } },
      },
    });
  }

  async updateBookingStatus(id: string, status: BookingStatus, cancelReason?: string) {
    const booking = await this.prisma.resourceBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('预约不存在');
    if (booking.status === BookingStatus.CANCELLED) {
      throw new BadRequestException('已取消的预约不能修改状态');
    }
    return this.prisma.resourceBooking.update({
      where: { id },
      data: { status, ...(cancelReason ? { cancelReason } : {}) },
    });
  }

  /** 取消预约：仅预约人或管理员可操作 */
  async cancelBooking(id: string, userId: string, cancelReason?: string) {
    const booking = await this.prisma.resourceBooking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('预约不存在');
    if (booking.bookerId !== userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user?.role !== 'ADMIN') throw new BadRequestException('只能取消自己的预约');
    }
    return this.prisma.resourceBooking.update({
      where: { id },
      data: { status: BookingStatus.CANCELLED, cancelReason },
    });
  }
}
