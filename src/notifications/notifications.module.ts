import { Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { NotificationSchedulerService } from './notification-scheduler.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [MailService, NotificationsService, NotificationSchedulerService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
