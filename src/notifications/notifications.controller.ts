import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto.js';
import { NotificationsService } from './notifications.service.js';

/** The Settings > Notifications tab. Lives under /users/me like the other
 * per-user settings, but in its own module so delivery code stays here. */
@Controller('users/me/notification-settings')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@CurrentUser('id') userId: string) {
    return this.notifications.getSettings(userId);
  }

  @Patch()
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateNotificationSettingsDto) {
    return this.notifications.updateSettings(userId, dto);
  }

  @Post('test')
  @HttpCode(200)
  sendTest(@CurrentUser('id') userId: string) {
    return this.notifications.sendTest(userId);
  }
}
