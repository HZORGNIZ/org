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
import { BookingStatus, Role } from '@prisma/client';
import { CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/roles.decorator';
import { ResourcesService } from './resources.service';

@Controller('resources')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ResourcesController {
  constructor(private resources: ResourcesService) {}

  // ---- 资源 ----
  @Get()
  listResources(@Query('type') type?: string) {
    return this.resources.listResources(type);
  }

  @Post()
  @Roles(Role.ADMIN)
  createResource(
    @Body()
    body: { name: string; type: string; location?: string; capacity?: number; description?: string },
  ) {
    return this.resources.createResource(body);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  updateResource(
    @Param('id') id: string,
    @Body()
    body: Partial<{ name: string; location: string; capacity: number; description: string; enabled: boolean }>,
  ) {
    return this.resources.updateResource(id, body);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  removeResource(@Param('id') id: string) {
    return this.resources.removeResource(id);
  }

  // ---- 预约 ----
  @Get('bookings')
  listBookings(
    @Query('resourceId') resourceId?: string,
    @Query('status') status?: BookingStatus,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.resources.listBookings({ resourceId, status, start, end });
  }

  @Post('bookings')
  createBooking(
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      resourceId: string;
      title: string;
      purpose?: string;
      startAt: string;
      endAt: string;
      participants?: string[];
    },
  ) {
    return this.resources.createBooking(userId, body);
  }

  @Patch('bookings/:id/status')
  @Roles(Role.ADMIN)
  updateBookingStatus(
    @Param('id') id: string,
    @Body() body: { status: BookingStatus; cancelReason?: string },
  ) {
    return this.resources.updateBookingStatus(id, body.status, body.cancelReason);
  }

  @Patch('bookings/:id/cancel')
  cancelBooking(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { cancelReason?: string },
  ) {
    return this.resources.cancelBooking(id, userId, body.cancelReason);
  }
}
