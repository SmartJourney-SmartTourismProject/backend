import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AdminAnalyticsService } from './admin-analytics.service.js';
import { AdminContentService } from './admin-content.service.js';
import { AdminEntryFeesService } from './admin-entry-fees.service.js';
import { AdminLlmService } from './admin-llm.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminController } from './admin.controller.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';

@Module({
  imports: [HttpModule],
  controllers: [AdminController],
  providers: [
    AdminAnalyticsService,
    AdminContentService,
    AdminEntryFeesService,
    AdminLlmService,
    AdminUsersService,
    KeycloakAdminService,
  ],
})
export class AdminModule {}
