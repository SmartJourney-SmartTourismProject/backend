import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { UpdatePreferencesDto } from './dto/update-preferences.dto.js';
import { UsersService } from './users.service.js';

/**
 * The signed-in user's own record (BACKEND_PLAN.md §5.2). There is no
 * `/users/:id` here - other users' data is an admin concern (§5.7).
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  getMe(@CurrentUser('id') userId: string) {
    return this.users.getMe(userId);
  }

  @Patch('me')
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(userId, dto);
  }

  @Get('me/preferences')
  getPreferences(@CurrentUser('id') userId: string) {
    return this.users.getPreferences(userId);
  }

  @Patch('me/preferences')
  updatePreferences(@CurrentUser('id') userId: string, @Body() dto: UpdatePreferencesDto) {
    return this.users.updatePreferences(userId, dto);
  }
}
