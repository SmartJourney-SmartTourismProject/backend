import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ExploreModule } from './explore/explore.module.js';

@Module({
  imports: [PrismaModule, ExploreModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
