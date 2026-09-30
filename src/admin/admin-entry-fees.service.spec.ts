import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminEntryFeesService } from './admin-entry-fees.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makePrisma() {
  return {
    listing_entry_fee: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    activity_log: { create: vi.fn() },
  };
}

const LINKED_PENDING = { id: 'fee-1', status: 'pending', listing_id: 'listing-1' };
const UNLINKED_PENDING = { id: 'fee-1', status: 'pending', listing_id: null };
const APPROVED = { id: 'fee-1', status: 'approved', listing_id: 'listing-1' };

describe('AdminEntryFeesService', () => {
  it('approve flips a linked pending fee to approved and logs the action', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique.mockResolvedValueOnce(LINKED_PENDING).mockResolvedValueOnce(APPROVED);
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    const result = await service.approve('admin-1', 'fee-1');

    expect(prisma.listing_entry_fee.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fee-1' },
        data: expect.objectContaining({ status: 'approved', reviewed_by: 'admin-1' }),
      }),
    );
    expect(prisma.activity_log.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'entry_fee.approve' }) }),
    );
    expect(result.status).toBe('approved');
  });

  it('approve refuses an unlinked fee rather than approving something that can never reach a budget', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique.mockResolvedValueOnce(UNLINKED_PENDING);
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    await expect(service.approve('admin-1', 'fee-1')).rejects.toThrow(NotFoundException);
    expect(prisma.listing_entry_fee.update).not.toHaveBeenCalled();
  });

  it('approve surfaces the one-approved-fee-per-listing unique violation as a 409', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique.mockResolvedValueOnce(LINKED_PENDING);
    prisma.listing_entry_fee.update.mockRejectedValueOnce({ code: 'P2002' });
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    await expect(service.approve('admin-1', 'fee-1')).rejects.toThrow(ConflictException);
  });

  it('reject sets status to rejected and logs the action', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique
      .mockResolvedValueOnce(LINKED_PENDING)
      .mockResolvedValueOnce({ ...LINKED_PENDING, status: 'rejected' });
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    const result = await service.reject('admin-1', 'fee-1');

    expect(prisma.listing_entry_fee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) }),
    );
    expect(result.status).toBe('rejected');
  });

  it('relink corrects the auto-matched listing without touching status', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique
      .mockResolvedValueOnce(LINKED_PENDING)
      .mockResolvedValueOnce({ ...LINKED_PENDING, listing_id: 'listing-2' });
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    const result = await service.relink('admin-1', 'fee-1', 'listing-2');

    expect(prisma.listing_entry_fee.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { listing_id: 'listing-2' } }),
    );
    expect(result.listing_id).toBe('listing-2');
  });

  it('relink with null unlinks a wrong auto-match', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique.mockResolvedValueOnce(LINKED_PENDING).mockResolvedValueOnce(UNLINKED_PENDING);
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    await service.relink('admin-1', 'fee-1', null);

    expect(prisma.listing_entry_fee.update).toHaveBeenCalledWith(expect.objectContaining({ data: { listing_id: null } }));
  });

  it('get throws NotFoundException for a missing fee', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findUnique.mockResolvedValueOnce(null);
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    await expect(service.get('missing')).rejects.toThrow(NotFoundException);
  });

  it('list filters by status when given', async () => {
    const prisma = makePrisma();
    prisma.listing_entry_fee.findMany.mockResolvedValueOnce([]);
    prisma.listing_entry_fee.count.mockResolvedValueOnce(0);
    const service = new AdminEntryFeesService(prisma as unknown as PrismaService);

    await service.list({ status: 'pending', page: 1 });

    expect(prisma.listing_entry_fee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' } }),
    );
  });
});
