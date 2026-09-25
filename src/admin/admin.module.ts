import { Module } from '@nestjs/common';
import { AdminContentService } from './admin-content.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { AdminController } from './admin.controller.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';

@Module({
  controllers: [AdminController],
  providers: [AdminContentService, AdminUsersService, KeycloakAdminService],
})
export class AdminModule {}
