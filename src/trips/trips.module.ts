import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [TripsController],
  providers: [TripsService],
})
export class TripsModule {}
