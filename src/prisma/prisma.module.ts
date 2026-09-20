import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * @Global so every feature module (auth, chat, explore, admin, ...) can
 * inject PrismaService without importing PrismaModule everywhere - the
 * same "one connection pool for the app" pattern the AI backend's
 * app/utils/db_pool.py uses on its own side.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
