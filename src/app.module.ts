import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ExploreModule } from './explore/explore.module.js';
import { ChatModule } from './chat/chat.module.js';
import { TripsModule } from './trips/trips.module.js';
import { BudgetModule } from './budget/budget.module.js';
import { AdminModule } from './admin/admin.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    // Registers the global JwtAuthGuard + RolesGuard - every route needs a
    // Keycloak token unless marked @Public().
    AuthModule,
    ExploreModule,
    ChatModule,
    TripsModule,
    BudgetModule,
    AdminModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
