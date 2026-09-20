import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Require one of the given Keycloak realm roles, e.g. `@Roles('admin')` on
 * the admin controllers. Checked by RolesGuard after JwtAuthGuard has
 * populated request.user.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
