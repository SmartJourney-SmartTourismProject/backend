import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { JwtStrategy } from './jwt.strategy.js';
import { RolesGuard } from './roles.guard.js';

/**
 * Keycloak bearer-token auth for the whole API. There are no login/register/
 * refresh endpoints here on purpose: Keycloak hosts those (BACKEND_PLAN.md
 * §5.1), the frontends obtain tokens from it, and this module only verifies
 * them. Guards are global: JwtAuthGuard first (populates request.user),
 * RolesGuard second.
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'keycloak-jwt' }), UsersModule],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
