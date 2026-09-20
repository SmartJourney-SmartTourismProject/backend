import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { appRoles, KeycloakTokenClaims } from '../auth/keycloak-token.js';

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

  constructor(private readonly prisma: PrismaService) {}

  async ensureFromToken(claims: KeycloakTokenClaims): Promise<AuthenticatedUser> {
    const roles = appRoles(claims);
    const cached = this.synced.get(claims.sub);
    if (cached && Date.now() - cached.at < SYNC_TTL_MS) {
      // Roles always reflect the current token, never the cached copy.
      return { ...cached.user, roles };
    }

    const user = await this.upsert(claims, roles);
    this.synced.set(claims.sub, { user, at: Date.now() });
    return user;
  }

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
  }

  private toAuthenticated(
    row: { id: string; email: string; name: string | null },
    keycloakId: string,
    roles: string[],
  ): AuthenticatedUser {
    return { id: row.id, keycloakId, email: row.email, name: row.name, roles };
  }
}
