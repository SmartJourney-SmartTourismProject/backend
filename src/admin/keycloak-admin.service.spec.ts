import { InternalServerErrorException } from '@nestjs/common';
import { KeycloakAdminService } from './keycloak-admin.service.js';

// Keycloak's Admin REST API is stubbed at the fetch level, so these check the
// requests this service sends - URL, method, body, bearer token - without a
// running Keycloak.

const ISSUER = 'http://kc.test/realms/smartjourney';
const ADMIN_BASE = 'http://kc.test/admin/realms/smartjourney';
const TOKEN_URL = `${ISSUER}/protocol/openid-connect/token`;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function emptyResponse(status = 204) {
  return { ok: status >= 200 && status < 300, status, json: async () => null, text: async () => '' };
}

const tokenResponse = () => jsonResponse({ access_token: 'sa-token', expires_in: 300 });

let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.KEYCLOAK_ISSUER = ISSUER;
  process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'smartjourney-backend';
  process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'sa-secret';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

describe('KeycloakAdminService', () => {
  it('logs in with client credentials, then disables the user with a PUT', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(emptyResponse());
    const service = new KeycloakAdminService();

    await service.setEnabled('kc-1', false);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe(TOKEN_URL);
    const form = new URLSearchParams(tokenInit.body as URLSearchParams);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('smartjourney-backend');
    expect(form.get('client_secret')).toBe('sa-secret');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${ADMIN_BASE}/users/kc-1`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
    expect(init.headers.Authorization).toBe('Bearer sa-token');
  });

  it('reuses the service-account token instead of logging in on every call', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    const service = new KeycloakAdminService();

    await service.setEnabled('kc-1', false);
    await service.setEnabled('kc-1', true);

    const tokenCalls = fetchMock.mock.calls.filter(([url]) => url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });

  it('grants admin by looking the role up by name and POSTing the mapping', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'role-uuid', name: 'admin' }))
      .mockResolvedValueOnce(emptyResponse());
    const service = new KeycloakAdminService();

    await service.setAdminRole('kc-1', true);

    expect(fetchMock.mock.calls[1][0]).toBe(`${ADMIN_BASE}/roles/admin`);
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe(`${ADMIN_BASE}/users/kc-1/role-mappings/realm`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual([{ id: 'role-uuid', name: 'admin' }]);
  });

  it('revokes admin with a DELETE on the same mapping', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'role-uuid', name: 'admin' }))
      .mockResolvedValueOnce(emptyResponse());
    const service = new KeycloakAdminService();

    await service.setAdminRole('kc-1', false);

    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
  });

  it('turns a rejected Keycloak call into a 500 rather than reporting success', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
    const service = new KeycloakAdminService();

    await expect(service.setEnabled('kc-1', false)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('fails when the service account cannot log in', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized_client' }, 401));
    const service = new KeycloakAdminService();

    await expect(service.setEnabled('kc-1', false)).rejects.toThrow('Could not authenticate against Keycloak');
  });

  it('reports itself unconfigured and refuses to call Keycloak without a client secret', async () => {
    delete process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
    const service = new KeycloakAdminService();

    expect(service.configured).toBe(false);
    await expect(service.setEnabled('kc-1', false)).rejects.toThrow(/KEYCLOAK_ADMIN_CLIENT_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an issuer that is not a realm URL', async () => {
    process.env.KEYCLOAK_ISSUER = 'http://kc.test/not-a-realm';
    fetchMock.mockResolvedValueOnce(tokenResponse());
    const service = new KeycloakAdminService();

    await expect(service.setEnabled('kc-1', false)).rejects.toThrow('KEYCLOAK_ISSUER is not a realm URL');
  });
});
