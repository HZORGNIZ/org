import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards';
import { AllowNoOrg } from '../../common/no-org.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@AllowNoOrg() // 站内信只含自己的消息，未加入组织也可收发（MainLayout 每 30s 轮询未读数，不豁免会反复弹 403）
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notifications.list(userId, unreadOnly === 'true');
  }

  @Get('unread-count')
  unreadCount(@CurrentUser('id') userId: string) {
    return this.notifications.unreadCount(userId);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notifications.markRead(id, userId);
  }
}
