import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

// The /users/me and /users/me/preferences half of UsersService. Provisioning
// (ensureFromToken) has its own spec in users.service.spec.ts.

function makePrisma() {
  return {
    app_user: { findUnique: vi.fn(), update: vi.fn() },
    traveler_profile: { findUnique: vi.fn(), upsert: vi.fn() },
    tag_vocabulary: { findMany: vi.fn() },
  };
}

function makeService() {
  const prisma = makePrisma();
  const service = new UsersService(prisma as unknown as PrismaService);
  return { prisma, service };
}

const updatedAt = new Date('2026-10-01T00:00:00Z');

describe('UsersService.getMe', () => {
  it('returns the account with its preferences, Decimal budget as a number', async () => {
    const { prisma, service } = makeService();
    prisma.app_user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'ann@example.com',
      name: 'Ann',
      traveler_profile: {
        travel_interests: ['beach'],
        travel_style: 'budget',
        // Prisma hands Decimal columns back as an object, not a number.
        default_budget: { toString: () => '15000.50', valueOf: () => 15000.5 },
        currency: 'LKR',
        updated_at: updatedAt,
      },
    });

    const me = await service.getMe('u1');

    expect(me).toEqual({
      id: 'u1',
      email: 'ann@example.com',
      name: 'Ann',
      preferences: {
        travel_interests: ['beach'],
        travel_style: 'budget',
        default_budget: 15000.5,
        currency: 'LKR',
        updated_at: updatedAt,
      },
    });
    // keycloak_id / is_active are never selected for the user's own view.
    const select = prisma.app_user.findUnique.mock.calls[0][0].select;
    expect(select.keycloak_id).toBeUndefined();
    expect(select.is_active).toBeUndefined();
  });

  it('gives a stable empty preferences shape when no profile row exists', async () => {
    const { prisma, service } = makeService();
    prisma.app_user.findUnique.mockResolvedValue({ id: 'u1', email: 'ann@example.com', traveler_profile: null });

    const me = await service.getMe('u1');

    expect(me.preferences).toEqual({
      travel_interests: [],
      travel_style: null,
      default_budget: null,
      currency: 'LKR',
      updated_at: null,
    });
  });

  it('throws 404 for an unknown user', async () => {
    const { prisma, service } = makeService();
    prisma.app_user.findUnique.mockResolvedValue(null);

    await expect(service.getMe('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('UsersService.updateMe', () => {
  it('writes only the fields that were sent', async () => {
    const { prisma, service } = makeService();
    prisma.app_user.update.mockResolvedValue({ id: 'u1' });

    await service.updateMe('u1', { location_enabled: false });

    const { where, data } = prisma.app_user.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'u1' });
    expect(data.location_enabled).toBe(false);
    expect(data).not.toHaveProperty('phone');
    expect(data).not.toHaveProperty('avatar_url');
    expect(data.updated_at).toBeInstanceOf(Date);
  });

  it('passes an explicit null through, so the avatar can be removed', async () => {
    const { prisma, service } = makeService();
    prisma.app_user.update.mockResolvedValue({ id: 'u1' });

    await service.updateMe('u1', { avatar_url: null });

    expect(prisma.app_user.update.mock.calls[0][0].data.avatar_url).toBeNull();
  });
});

describe('UsersService.getPreferences', () => {
  it('returns the defaults when the profile row is missing', async () => {
    const { prisma, service } = makeService();
    prisma.traveler_profile.findUnique.mockResolvedValue(null);

    await expect(service.getPreferences('u1')).resolves.toEqual({
      travel_interests: [],
      travel_style: null,
      default_budget: null,
      currency: 'LKR',
      updated_at: null,
    });
  });
});

describe('UsersService.updatePreferences', () => {
  it('rejects interests that are not in tag_vocabulary and writes nothing', async () => {
    const { prisma, service } = makeService();
    prisma.tag_vocabulary.findMany.mockResolvedValue([{ tag: 'beach' }]);

    const attempt = service.updatePreferences('u1', { travel_interests: ['beach', 'beachs'] });

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/beachs/);
    expect(prisma.traveler_profile.upsert).not.toHaveBeenCalled();
  });

  it('checks each tag once, however often it was sent', async () => {
    const { prisma, service } = makeService();
    prisma.tag_vocabulary.findMany.mockResolvedValue([{ tag: 'beach' }]);
    prisma.traveler_profile.upsert.mockResolvedValue({ travel_interests: ['beach'], currency: 'LKR' });

    await service.updatePreferences('u1', { travel_interests: ['beach', 'beach'] });

    expect(prisma.tag_vocabulary.findMany.mock.calls[0][0].where).toEqual({ tag: { in: ['beach'] } });
  });

  it('upserts known values and normalises the currency to upper case', async () => {
    const { prisma, service } = makeService();
    prisma.tag_vocabulary.findMany.mockResolvedValue([{ tag: 'beach' }, { tag: 'culture' }]);
    prisma.traveler_profile.upsert.mockResolvedValue({
      travel_interests: ['beach', 'culture'],
      travel_style: 'luxury',
      default_budget: '50000',
      currency: 'USD',
      updated_at: updatedAt,
    });

    const result = await service.updatePreferences('u1', {
      travel_interests: ['beach', 'culture'],
      travel_style: 'luxury',
      default_budget: 50000,
      currency: 'usd',
    });

    const call = prisma.traveler_profile.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ user_id: 'u1' });
    expect(call.update).toMatchObject({ travel_style: 'luxury', default_budget: 50000, currency: 'USD' });
    // A user linked from a pre-Keycloak row may have no profile yet.
    expect(call.create).toMatchObject({ user_id: 'u1', currency: 'USD' });
    expect(result.default_budget).toBe(50000);
  });

  it('skips the vocabulary lookup when interests are not being changed', async () => {
    const { prisma, service } = makeService();
    prisma.traveler_profile.upsert.mockResolvedValue({ travel_interests: [], currency: 'LKR' });

    await service.updatePreferences('u1', { travel_style: 'balanced' });

    expect(prisma.tag_vocabulary.findMany).not.toHaveBeenCalled();
    expect(prisma.traveler_profile.upsert.mock.calls[0][0].update).not.toHaveProperty('travel_interests');
  });
});
