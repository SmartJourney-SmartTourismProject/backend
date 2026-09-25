import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

/**
 * Thin client for Keycloak's Admin REST API, used only by the admin
 * endpoints. Keycloak owns identity, so anything an admin changes about a
 * *user* (their realm roles, whether their account is enabled) has to be
 * written here - writing it only into app_user would be undone by the next
 * JIT sync, which mirrors the token (UsersService.ensureFromToken).
 *
 * Authenticates as the `smartjourney-backend` service account, which holds
 * three realm-management roles and no more: view-users, manage-users (to
 * enable/disable accounts and map roles) and view-realm (to look the `admin`
 * realm role up by name).
 */
@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private readonly issuer = process.env.KEYCLOAK_ISSUER!;
  private readonly clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'smartjourney-backend';
  private readonly clientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? '';
  private token: { value: string; expiresAt: number } | null = null;

  /** `<issuer>/realms/<realm>` -> `<base>/admin/realms/<realm>`. */
  private get adminBase(): string {
    const match = /^(.*)\/realms\/([^/]+)$/.exec(this.issuer);
    if (!match) throw new InternalServerErrorException('KEYCLOAK_ISSUER is not a realm URL');
    return `${match[1]}/admin/realms/${match[2]}`;
  }

  get configured(): boolean {
    return Boolean(this.clientSecret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.configured) {
      throw new InternalServerErrorException(
        'KEYCLOAK_ADMIN_CLIENT_SECRET is not set - user administration is unavailable (see backend/.env.example)',
      );
    }
    const res = await fetch(`${this.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      this.logger.error(`Keycloak service-account login failed: ${res.status}`);
      throw new InternalServerErrorException('Could not authenticate against Keycloak');
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh a minute early rather than racing the expiry.
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const res = await fetch(`${this.adminBase}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Keycloak ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      throw new InternalServerErrorException(`Keycloak rejected the request (${res.status})`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }

  /** Enable or disable the account - a disabled user cannot obtain tokens. */
  async setEnabled(keycloakId: string, enabled: boolean): Promise<void> {
    await this.call(`/users/${keycloakId}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
  }

  /**
   * Grant or revoke the realm role `admin`. Every user keeps `traveler`
   * (it is a default realm role), so this only adds/removes the elevation.
   */
  async setAdminRole(keycloakId: string, isAdmin: boolean): Promise<void> {
    const role = await this.call<{ id: string; name: string }>('/roles/admin');
    if (!role) throw new InternalServerErrorException('Realm role "admin" not found');
    const body = JSON.stringify([{ id: role.id, name: role.name }]);
    await this.call(`/users/${keycloakId}/role-mappings/realm`, {
      method: isAdmin ? 'POST' : 'DELETE',
      body,
    });
  }
}
