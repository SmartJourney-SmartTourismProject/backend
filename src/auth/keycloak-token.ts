/**
 * The claims we read from a Keycloak access token. Keycloak puts realm roles
 * under `realm_access.roles`; the `smartjourney-api` audience comes from the
 * "smartjourney-api audience" protocol mapper on the smartjourney-web client
 * (backend/keycloak/realm-export.json) - without it every token would carry
 * only `aud: account` and the strategy would reject it.
 */
export interface KeycloakTokenClaims {
  /** Keycloak user id - stored as app_user.keycloak_id. */
  sub: string;
  iss: string;
  aud: string | string[];
  /** Client the token was issued to (smartjourney-web, later smartjourney-mobile). */
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
}

// Roles every Keycloak realm assigns automatically; not meaningful to the app.
const KEYCLOAK_BUILTIN_ROLES = new Set(['offline_access', 'uma_authorization', 'default-roles-smartjourney']);

/** App realm roles (`traveler`, `admin`), built-ins filtered out. */
export function appRoles(claims: KeycloakTokenClaims): string[] {
  return (claims.realm_access?.roles ?? []).filter((r) => !KEYCLOAK_BUILTIN_ROLES.has(r));
}
