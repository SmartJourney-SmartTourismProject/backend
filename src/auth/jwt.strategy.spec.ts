import { UnauthorizedException } from '@nestjs/common';
import type { UsersService } from '../users/users.service.js';

// The strategy's constructor reads KEYCLOAK_ISSUER from process.env and
// throws if it is unset (see jwt.strategy.ts) - set it before importing so
// module-level instantiation elsewhere in the suite is unaffected.
process.env.KEYCLOAK_ISSUER ??= 'http://kc-test/realms/smartjourney';

const { JwtStrategy } = await import('./jwt.strategy.js');

describe('JwtStrategy.validate', () => {
  it('rejects a token with no subject before ever touching the database', async () => {
    const users = { ensureFromToken: vi.fn() };
    const strategy = new JwtStrategy(users as unknown as UsersService);

    await expect(
      strategy.validate({ sub: '', iss: 'i', aud: 'a' } as Parameters<typeof strategy.validate>[0]),
    ).rejects.toThrow(UnauthorizedException);
    expect(users.ensureFromToken).not.toHaveBeenCalled();
  });

  it('provisions/loads the app_user for a valid token and returns it', async () => {
    const provisioned = { id: 'db-1', keycloakId: 'kc-1', email: 'a@b.com', name: 'A', roles: ['traveler'] };
    const users = { ensureFromToken: vi.fn().mockResolvedValue(provisioned) };
    const strategy = new JwtStrategy(users as unknown as UsersService);
    const claims = { sub: 'kc-1', iss: 'i', aud: 'smartjourney-api', realm_access: { roles: ['traveler'] } };

    const result = await strategy.validate(claims);

    expect(users.ensureFromToken).toHaveBeenCalledWith(claims);
    expect(result).toEqual(provisioned);
  });
});
