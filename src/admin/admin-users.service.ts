import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { AdminUpdateUserDto } from './dto/update-user.dto.js';
import { AdminUsersQueryDto } from './dto/users-query.dto.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';

const PAGE_SIZE = 20;

// password_hash and google_id are gone (migration 0007) and keycloak_id is an
// internal join key, so there is nothing sensitive left to strip - but list
// explicitly anyway, so a future column is not exposed by accident.
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  is_active: true,
  email_verified: true,
  location_enabled: true,
  created_at: true,
  updated_at: true,
  // Not returned as-is: the client only needs to know *whether* the account
  // is backed by Keycloak, so role/status controls can be disabled for rows
  // that predate it (the seeded demo user). See `managed` below.
  keycloak_id: true,
} as const;

/** Strips keycloak_id, replacing it with the boolean the admin UI needs. */
function present<T extends { keycloak_id: string | null }>(row: T) {
  const { keycloak_id, ...rest } = row;
  return { ...rest, managed: keycloak_id !== null };
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  async list(query: AdminUsersQueryDto) {
    const page = query.page ?? 1;
    const where: Prisma.app_userWhereInput = {
      ...(query.role && { role: query.role }),
      ...(query.status && { is_active: query.status === 'active' }),
      ...(query.q && {
        OR: [
          { email: { contains: query.q, mode: 'insensitive' } },
          { name: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.app_user.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          ...USER_SELECT,
          _count: { select: { itinerary: true, chat_session: true } },
        },
      }),
      this.prisma.app_user.count({ where }),
    ]);

    return {
      items: items.map(present),
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async getById(id: string) {
    const user = await this.prisma.app_user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        traveler_profile: {
          select: { travel_interests: true, travel_style: true, default_budget: true, currency: true },
        },
        _count: { select: { itinerary: true, chat_session: true } },
      },
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return {
      ...present(user),
      traveler_profile: user.traveler_profile
        ? {
            ...user.traveler_profile,
            default_budget:
              user.traveler_profile.default_budget == null ? null : Number(user.traveler_profile.default_budget),
          }
        : null,
    };
  }

  /** SRS §3.1.13 - what this user (or an admin acting on them) has done. */
  async getActivity(id: string) {
    await this.getById(id);
    return this.prisma.activity_log.findMany({
      where: { user_id: id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  /**
   * Role and account status live in Keycloak; app_user only mirrors them so
   * the admin list can filter without calling Keycloak per row. Keycloak is
   * written first - if that fails nothing is mirrored, leaving the two in
   * step. The user's own token keeps its old roles until it refreshes
   * (5 minutes at most), which is inherent to stateless JWT auth.
   */
  async update(actingAdminId: string, id: string, dto: AdminUpdateUserDto) {
    const target = await this.prisma.app_user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException(`User ${id} not found`);
    if (!target.keycloak_id) {
      throw new BadRequestException('This user has never signed in through Keycloak and cannot be managed here');
    }
    if (target.id === actingAdminId && (dto.role === 'traveler' || dto.is_active === false)) {
      // Cheap guard against an admin locking themselves out mid-session.
      throw new BadRequestException('You cannot remove your own admin role or deactivate your own account');
    }

    const changes: Prisma.app_userUpdateInput = {};
    if (dto.role !== undefined && dto.role !== target.role) {
      await this.keycloak.setAdminRole(target.keycloak_id, dto.role === 'admin');
      changes.role = dto.role;
    }
    if (dto.is_active !== undefined && dto.is_active !== target.is_active) {
      await this.keycloak.setEnabled(target.keycloak_id, dto.is_active);
      changes.is_active = dto.is_active;
    }
    if (Object.keys(changes).length === 0) return this.getById(id);

    changes.updated_at = new Date();
    await this.prisma.app_user.update({ where: { id }, data: changes });
    await this.log(actingAdminId, 'user.update', { target_user_id: id, ...dto });
    return this.getById(id);
  }

  private async log(adminId: string, action: string, detail: Prisma.InputJsonValue) {
    try {
      await this.prisma.activity_log.create({ data: { user_id: adminId, action, detail } });
    } catch (error) {
      this.logger.error(`Failed to write activity_log for ${action}: ${String(error)}`);
    }
  }
}
