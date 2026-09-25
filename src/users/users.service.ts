import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { appRoles, KeycloakTokenClaims } from '../auth/keycloak-token.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { UpdatePreferencesDto } from './dto/update-preferences.dto.js';

/** What every authenticated request gets as `request.user`. */
export interface AuthenticatedUser {
  /** app_user.id - the id chat/trips/budget and the AI backend key on. */
  id: string;
  /** Keycloak `sub`. */
  keycloakId: string;
  email: string;
  name: string | null;
  /** Realm roles from the token, e.g. ['traveler'] or ['traveler', 'admin']. */
  roles: string[];
}

// Re-syncing the mirror row on literally every request would be one extra
// write per API call; the profile fields it mirrors (email, name, role)
// change rarely, so a short cache is plenty. Authorization never reads this
// cache - roles come straight from the (5-minute) token.
const SYNC_TTL_MS = 5 * 60 * 1000;

// Never expose keycloak_id or is_active here - the client has its own id
// from the token, and account status is an admin concern.
const ME_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  email_verified: true,
  location_enabled: true,
  created_at: true,
} as const;

// home_location is a PostGIS geography (Unsupported in Prisma) - not
// readable through the client, and nothing sets it yet. Left out until a
// "home city" feature needs it (then: $queryRaw with ST_X/ST_Y).
const PREFERENCES_SELECT = {
  travel_interests: true,
  travel_style: true,
  default_budget: true,
  currency: true,
  updated_at: true,
} as const;

/** Prisma Decimal -> number, and a stable empty shape when no row exists. */
function toPreferences(
  row: { travel_interests: string[]; travel_style: string | null; default_budget: unknown; currency: string; updated_at: Date } | null,
) {
  return {
    travel_interests: row?.travel_interests ?? [],
    travel_style: row?.travel_style ?? null,
    default_budget: row?.default_budget == null ? null : Number(row.default_budget),
    currency: row?.currency ?? 'LKR',
    updated_at: row?.updated_at ?? null,
  };
}

/** Prisma's "unique constraint failed" - here, two requests provisioning at once. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Just-in-time provisioning. Keycloak is the source of truth for identity;
 * this keeps one `app_user` row per Keycloak user so the NOT NULL user_id
 * foreign keys (chat_session, itinerary, ai_session) have a target, and so
 * the AI backend can read traveler_profile for that user (BACKEND_PLAN.md
 * §2). Called by JwtStrategy on every authenticated request.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly synced = new Map<string, { user: AuthenticatedUser; at: number }>();
  // A page load fires several API calls at once, and on a user's very first
  // request none of them finds a row yet - without this they would all try to
  // INSERT and all but one would fail on app_user_email_key. Collapsing them
  // onto one promise also saves the duplicate work on every later sync.
  private readonly inFlight = new Map<string, Promise<AuthenticatedUser>>();

  constructor(private readonly prisma: PrismaService) {}

  async ensureFromToken(claims: KeycloakTokenClaims): Promise<AuthenticatedUser> {
    const roles = appRoles(claims);
    const cached = this.synced.get(claims.sub);
    if (cached && Date.now() - cached.at < SYNC_TTL_MS) {
      // Roles always reflect the current token, never the cached copy.
      return { ...cached.user, roles };
    }

    let pending = this.inFlight.get(claims.sub);
    if (!pending) {
      pending = this.upsert(claims, roles)
        .then((user) => {
          this.synced.set(claims.sub, { user, at: Date.now() });
          return user;
        })
        .finally(() => this.inFlight.delete(claims.sub));
      this.inFlight.set(claims.sub, pending);
    }
    // Roles come from *this* request's token even when another request did the write.
    return { ...(await pending), roles };
  }

  // ---- /users/me -------------------------------------------------------

  /** Account + travel preferences in one call (what the Account tab needs). */
  async getMe(userId: string) {
    const row = await this.prisma.app_user.findUnique({
      where: { id: userId },
      select: {
        ...ME_SELECT,
        traveler_profile: { select: PREFERENCES_SELECT },
      },
    });
    if (!row) throw new NotFoundException('User not found');
    const { traveler_profile, ...account } = row;
    return { ...account, preferences: toPreferences(traveler_profile) };
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    return this.prisma.app_user.update({
      where: { id: userId },
      data: {
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.location_enabled !== undefined && { location_enabled: dto.location_enabled }),
        updated_at: new Date(),
      },
      select: ME_SELECT,
    });
  }

  /** The traveler_profile row the AI backend reads (db_tool.get_user_profile). */
  async getPreferences(userId: string) {
    const profile = await this.prisma.traveler_profile.findUnique({
      where: { user_id: userId },
      select: PREFERENCES_SELECT,
    });
    return toPreferences(profile);
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    if (dto.travel_interests) {
      await this.assertKnownTags(dto.travel_interests);
    }
    const data = {
      ...(dto.travel_interests !== undefined && { travel_interests: dto.travel_interests }),
      ...(dto.travel_style !== undefined && { travel_style: dto.travel_style }),
      ...(dto.default_budget !== undefined && { default_budget: dto.default_budget }),
      ...(dto.currency !== undefined && { currency: dto.currency.toUpperCase() }),
      updated_at: new Date(),
    };
    // upsert: a row normally exists from JIT provisioning, but a user linked
    // from a pre-Keycloak app_user may not have one yet.
    const profile = await this.prisma.traveler_profile.upsert({
      where: { user_id: userId },
      create: { user_id: userId, ...data },
      update: data,
      select: PREFERENCES_SELECT,
    });
    return toPreferences(profile);
  }

  /** travel_interests must be tag_vocabulary.tag values - see GET /tags. */
  private async assertKnownTags(tags: string[]) {
    const unique = [...new Set(tags)];
    const known = await this.prisma.tag_vocabulary.findMany({
      where: { tag: { in: unique } },
      select: { tag: true },
    });
    const knownSet = new Set(known.map((t) => t.tag));
    const unknown = unique.filter((t) => !knownSet.has(t));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown travel_interests: ${unknown.join(', ')}. Use values from GET /tags.`,
      );
    }
  }

  // ---- JIT provisioning helpers ----------------------------------------

  private async upsert(claims: KeycloakTokenClaims, roles: string[]): Promise<AuthenticatedUser> {
    // Keycloak guarantees an email for our realm (registration requires it,
    // Google always supplies one); fall back defensively so a token can
    // never fail provisioning over a missing claim.
    const email = claims.email ?? `${claims.sub}@keycloak.local`;
    const name = claims.name ?? claims.preferred_username ?? null;
    const role = roles.includes('admin') ? 'admin' : 'traveler';
    const profile = { email, name, role, email_verified: claims.email_verified ?? false };

    const byKeycloakId = await this.prisma.app_user.findUnique({ where: { keycloak_id: claims.sub } });
    if (byKeycloakId) {
      const row = await this.prisma.app_user.update({
        where: { id: byKeycloakId.id },
        data: { ...profile, updated_at: new Date() },
      });
      return this.toAuthenticated(row, claims.sub, roles);
    }

    // First sign-in. An app_user with this email may already exist from
    // before Keycloak (or from an admin-created row) - link it rather than
    // tripping the email UNIQUE constraint.
    const byEmail = await this.prisma.app_user.findUnique({ where: { email } });
    if (byEmail) {
      this.logger.log(`Linking existing app_user ${byEmail.id} to Keycloak user ${claims.sub}`);
      const row = await this.prisma.app_user.update({
        where: { id: byEmail.id },
        data: { ...profile, keycloak_id: claims.sub, updated_at: new Date() },
      });
      await this.prisma.traveler_profile.upsert({
        where: { user_id: row.id },
        create: { user_id: row.id },
        update: {},
      });
      return this.toAuthenticated(row, claims.sub, roles);
    }

    this.logger.log(`Provisioning app_user for Keycloak user ${claims.sub} (${email})`);
    try {
      const row = await this.prisma.app_user.create({
        data: {
          ...profile,
          keycloak_id: claims.sub,
          // Empty profile so the AI backend's get_user_profile() finds a row;
          // the user fills it in later via PATCH /users/me/preferences.
          traveler_profile: { create: {} },
        },
      });
      return this.toAuthenticated(row, claims.sub, roles);
    } catch (error) {
      // Another request (or another instance - inFlight is per-process) won the
      // race and inserted the row between our lookups and this INSERT. That is
      // the expected outcome of a tie, not an error: read back what it wrote.
      if (!isUniqueConstraintViolation(error)) throw error;
      const existing = await this.prisma.app_user.findFirst({
        where: { OR: [{ keycloak_id: claims.sub }, { email }] },
      });
      if (!existing) throw error;
      return this.toAuthenticated(existing, claims.sub, roles);
    }
  }

  private toAuthenticated(
    row: { id: string; email: string; name: string | null },
    keycloakId: string,
    roles: string[],
  ): AuthenticatedUser {
    return { id: row.id, keycloakId, email: row.email, name: row.name, roles };
  }
}
