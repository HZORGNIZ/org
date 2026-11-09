import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { AnnouncementsService } from './announcements.service';

@Controller('announcements')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnnouncementsController {
  constructor(private announcements: AnnouncementsService) {}

  @Get()
  list(@Query('activeOnly') activeOnly?: string) {
    return this.announcements.list({ activeOnly: activeOnly === 'true' });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.announcements.get(id);
  }

  @Post()
  @Roles(Role.ADMIN)
  create(
    @CurrentUser('id') userId: string,
    @Body()
    body: { title: string; content: string; pinned?: boolean; expiresAt?: string | null },
  ) {
    return this.announcements.create(userId, body);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      content?: string;
      pinned?: boolean;
      expiresAt?: string | null;
    },
  ) {
    return this.announcements.update(id, body);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) {
    return this.announcements.remove(id);
  }
}
