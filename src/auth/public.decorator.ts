import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt a route (or whole controller) out of the global JwtAuthGuard. Used for
 * the health check and the explore endpoints, which SRS §3.1.7 makes public
 * ("any user can explore"). Everything else needs a Keycloak token.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
