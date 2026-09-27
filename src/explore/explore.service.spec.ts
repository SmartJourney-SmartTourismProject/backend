import { NotFoundException } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makePrisma() {
  return {
    district: { findMany: vi.fn() },
    category: { findMany: vi.fn() },
    tag_vocabulary: { findMany: vi.fn() },
    travel_listing: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findFirst: vi.fn() },
    local_event: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
  };
}

describe('ExploreService.searchListings', () => {
  it('only ever returns verified, active listings, regardless of filters requested', async () => {
    const prisma = makePrisma();
    const service = new ExploreService(prisma as unknown as PrismaService);

    await service.searchListings({ district: 'd1', category: 'c1', q: 'beach' });

    const { where } = prisma.travel_listing.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ is_verified: true, is_active: true, district_id: 'd1', category_id: 'c1' });
    expect(where.name).toEqual({ contains: 'beach', mode: 'insensitive' });
  });

  it('paginates from page 1 by default, 20 per page', async () => {
    const prisma = makePrisma();
    const service = new ExploreService(prisma as unknown as PrismaService);

    await service.searchListings({});

    expect(prisma.travel_listing.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });

  it('computes totalPages from the count, not the page size returned', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.count.mockResolvedValue(45);
    const service = new ExploreService(prisma as unknown as PrismaService);

    const result = await service.searchListings({ page: 2 });

    expect(result).toMatchObject({ page: 2, total: 45, totalPages: 3 });
    expect(prisma.travel_listing.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
  });
});

describe('ExploreService.searchEvents', () => {
  it('applies the district and date-window filters together', () => {
    const prisma = makePrisma();
    const service = new ExploreService(prisma as unknown as PrismaService);

    service.searchEvents({ district: 'd1', from: '2026-01-01', to: '2026-01-31' });

    const { where } = prisma.local_event.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      is_verified: true,
      is_active: true,
      district_id: 'd1',
      start_datetime: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
    });
  });
});

describe('ExploreService public reads only surface verified content', () => {
  it('getListingById 404s on an unverified listing rather than exposing it', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findFirst.mockResolvedValue(null);
    const service = new ExploreService(prisma as unknown as PrismaService);

    await expect(service.getListingById('pending-listing')).rejects.toThrow(NotFoundException);
    expect(prisma.travel_listing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pending-listing', is_verified: true, is_active: true } }),
    );
  });

  it('getEventById 404s the same way', async () => {
    const prisma = makePrisma();
    prisma.local_event.findFirst.mockResolvedValue(null);
    const service = new ExploreService(prisma as unknown as PrismaService);

    await expect(service.getEventById('pending-event')).rejects.toThrow(NotFoundException);
  });
});
