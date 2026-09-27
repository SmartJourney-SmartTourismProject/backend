import { NotFoundException } from '@nestjs/common';
import { AdminContentService } from './admin-content.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makePrisma() {
  return {
    travel_listing: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn() },
    local_event: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn() },
    activity_log: { create: vi.fn() },
  };
}

const APPROVED_ROW = { id: 'row-1', is_verified: true, is_active: true };
const PENDING_ROW = { id: 'row-1', is_verified: false, is_active: true };

describe('AdminContentService listing moderation', () => {
  it('verifyListing flips a pending row to verified+active and logs the action', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findUnique.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(APPROVED_ROW);
    const service = new AdminContentService(prisma as unknown as PrismaService);

    const result = await service.verifyListing('admin-1', 'row-1');

    expect(prisma.travel_listing.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-1' }, data: expect.objectContaining({ is_verified: true, is_active: true }) }),
    );
    expect(prisma.activity_log.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ user_id: 'admin-1', action: 'listing.verify' }) }),
    );
    expect(result.state).toBe('approved');
  });

  it('rejectListing sets is_verified and is_active both false, so it disappears from public search', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findUnique.mockResolvedValueOnce(APPROVED_ROW).mockResolvedValueOnce({ ...APPROVED_ROW, is_verified: false, is_active: false });
    const service = new AdminContentService(prisma as unknown as PrismaService);

    const result = await service.rejectListing('admin-1', 'row-1', 'duplicate listing');

    expect(prisma.travel_listing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ is_verified: false, is_active: false }) }),
    );
    expect(result.state).toBe('rejected');
  });

  it('404s on a listing id that does not exist rather than moderating nothing', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findUnique.mockResolvedValue(null);
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(service.verifyListing('admin-1', 'missing')).rejects.toThrow(NotFoundException);
    expect(prisma.travel_listing.update).not.toHaveBeenCalled();
  });
});

describe('AdminContentService.stateOf / stateFilter (via listListings)', () => {
  it('labels rows pending/approved/rejected from the is_verified/is_active pair', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findMany.mockResolvedValue([
      { id: '1', is_verified: false, is_active: true },
      { id: '2', is_verified: true, is_active: true },
      { id: '3', is_verified: false, is_active: false },
    ]);
    prisma.travel_listing.count.mockResolvedValue(3);
    const service = new AdminContentService(prisma as unknown as PrismaService);

    const result = await service.listListings({});

    expect(result.items.map((r) => r.state)).toEqual(['pending', 'approved', 'rejected']);
  });

  it('filters to the pending shape (unverified but still active) when asked for the pending queue', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findMany.mockResolvedValue([]);
    prisma.travel_listing.count.mockResolvedValue(0);
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await service.listListings({ status: 'pending' });

    expect(prisma.travel_listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ is_verified: false, is_active: true }) }),
    );
  });
});

describe('AdminContentService audit logging', () => {
  it('swallows an activity_log write failure rather than failing the moderation action', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findUnique.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(APPROVED_ROW);
    prisma.activity_log.create.mockRejectedValue(new Error('db down'));
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(service.verifyListing('admin-1', 'row-1')).resolves.toMatchObject({ state: 'approved' });
  });
});
