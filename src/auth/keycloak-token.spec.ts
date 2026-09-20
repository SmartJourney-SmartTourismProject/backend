import { appRoles } from './keycloak-token.js';

describe('appRoles', () => {
  it('drops Keycloak built-in roles and keeps app roles', () => {
    expect(
      appRoles({
        sub: 'x',
        iss: 'i',
        aud: 'a',
        realm_access: { roles: ['default-roles-smartjourney', 'offline_access', 'traveler', 'uma_authorization', 'admin'] },
      }),
    ).toEqual(['traveler', 'admin']);
  });

  it('returns [] when the claim is missing', () => {
    expect(appRoles({ sub: 'x', iss: 'i', aud: 'a' })).toEqual([]);
  });
});
