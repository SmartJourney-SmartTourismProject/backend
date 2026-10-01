import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Liveness + database check for the container healthcheck and the CD
 * pipeline's post-deploy probe (deploy/deploy.sh rolls back when this fails).
 * Public: it reveals nothing but "ok" / 503, and a probe has no token.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
    return { status: 'ok' };
  }
}
