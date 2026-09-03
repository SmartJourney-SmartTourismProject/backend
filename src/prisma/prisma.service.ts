import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The single PrismaClient instance for the whole app - inject this
 * anywhere data access is needed, never construct PrismaClient directly.
 *
 * Requires a driver adapter as of Prisma 7 (decision, this session,
 * 2026-09-03) - constructing PrismaClient with no options throws
 * PrismaClientInitializationError, verified live against the real
 * database. DATABASE_URL is the same one the AI backend's asyncpg pool
 * reads (see ai-backend/app/utils/db_pool.py) - both point at the one
 * schema `backend/db/migrate.py` owns (decision D13,
 * docs/BACKEND_ALIGNMENT.md §1: Prisma introspects via `prisma db pull`,
 * it does not own migrations here).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to Postgres via Prisma.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
