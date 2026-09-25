import { UsersService } from './users.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const claims = {
  sub: 'kc-sub-1',
  iss: 'http://kc/realms/smartjourney',
  aud: 'smartjourney-api',
  email: 'ann@example.com',
  email_verified: true,
  name: 'Ann Example',
  realm_access: { roles: ['traveler', 'offline_access'] },
};

function makePrisma() {
  return {
    app_user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    traveler_profile: { upsert: vi.fn() },
  };
}

describe('UsersService.ensureFromToken', () => {
  it('creates app_user + traveler_profile on first sign-in', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(null); // by keycloak_id, then by email
    prisma.app_user.create.mockResolvedValue({ id: 'db-1', email: claims.email, name: claims.name });
    const service = new UsersService(prisma as unknown as PrismaService);

    const user = await service.ensureFromToken(claims);

    expect(prisma.app_user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        keycloak_id: 'kc-sub-1',
        email: 'ann@example.com',
        role: 'traveler',
        traveler_profile: { create: {} },
      }),
    });
    expect(user).toEqual({
      id: 'db-1',
      keycloakId: 'kc-sub-1',
      email: 'ann@example.com',
      name: 'Ann Example',
      roles: ['traveler'],
    });
  });

  it('links a pre-existing row with the same email instead of failing on UNIQUE(email)', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique
      .mockResolvedValueOnce(null) // no keycloak_id match
      .mockResolvedValueOnce({ id: 'legacy-1', email: claims.email, name: null });
    prisma.app_user.update.mockResolvedValue({ id: 'legacy-1', email: claims.email, name: claims.name });
    const service = new UsersService(prisma as unknown as PrismaService);

    const user = await service.ensureFromToken(claims);

    expect(prisma.app_user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'legacy-1' }, data: expect.objectContaining({ keycloak_id: 'kc-sub-1' }) }),
    );
    expect(prisma.traveler_profile.upsert).toHaveBeenCalled();
    expect(prisma.app_user.create).not.toHaveBeenCalled();
    expect(user.id).toBe('legacy-1');
  });

  it('mirrors the admin role and serves repeat calls from cache with fresh roles', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue({ id: 'db-1', email: claims.email, name: claims.name });
    prisma.app_user.update.mockResolvedValue({ id: 'db-1', email: claims.email, name: claims.name });
    const service = new UsersService(prisma as unknown as PrismaService);

    const first = await service.ensureFromToken({ ...claims, realm_access: { roles: ['traveler', 'admin'] } });
    expect(prisma.app_user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'admin' }) }),
    );
    expect(first.roles).toEqual(['traveler', 'admin']);

    // Second call within the TTL: no DB round-trip, but roles come from this token.
    const second = await service.ensureFromToken(claims);
    expect(prisma.app_user.update).toHaveBeenCalledTimes(1);
    expect(second.roles).toEqual(['traveler']);
  });
});

describe('UsersService concurrent first sign-in', () => {
  it('provisions once when several requests arrive together', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(null);
    let created = 0;
    prisma.app_user.create.mockImplementation(async () => {
      created += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { id: 'db-1', email: claims.email, name: claims.name };
    });
    const service = new UsersService(prisma as unknown as PrismaService);

    const users = await Promise.all([
      service.ensureFromToken(claims),
      service.ensureFromToken(claims),
      service.ensureFromToken(claims),
    ]);

    expect(created).toBe(1);
    expect(users.map((u) => u.id)).toEqual(['db-1', 'db-1', 'db-1']);
  });

  it('recovers when another instance wins the insert (P2002)', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(null);
    prisma.app_user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    prisma.app_user.findFirst.mockResolvedValue({ id: 'winner-1', email: claims.email, name: claims.name });
    const service = new UsersService(prisma as unknown as PrismaService);

    const user = await service.ensureFromToken(claims);

    expect(user.id).toBe('winner-1');
    expect(prisma.app_user.findFirst).toHaveBeenCalled();
  });

  it('rethrows a P2002 that is not a provisioning race', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(null);
    prisma.app_user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    prisma.app_user.findFirst.mockResolvedValue(null);
    const service = new UsersService(prisma as unknown as PrismaService);

    await expect(service.ensureFromToken(claims)).rejects.toThrow('unique');
  });
});
