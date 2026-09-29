import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminContentService } from './admin-content.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makePrisma() {
  return {
    travel_listing: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    local_event: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    activity_log: { create: vi.fn() },
    $queryRaw: vi.fn(),
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

/**
 * CREATE / UPDATE — the write path an admin drives from the content form.
 *
 * Until now this was the only part of the admin module with real logic and no
 * tests, and it is the part that actually mutates the catalogue travellers see.
 * The cases below pin the three things that can go wrong quietly: a duplicate
 * upsert key, a row written without going through validation, and a value pair
 * that no single-field validator can reject.
 */
describe('AdminContentService.createListing', () => {
  const DTO = {
    name: 'Temple of the Tooth',
    district_id: 'd-1',
    category_id: 'c-1',
    latitude: 7.2936,
    longitude: 80.6413,
  };

  function prismaForCreate() {
    const prisma = makePrisma();
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ id: 'new-listing' }]);
    prisma.travel_listing.findUnique.mockResolvedValue({
      id: 'new-listing',
      is_verified: true,
      is_active: true,
    });
    return prisma;
  }

  it('inserts through parameterised SQL and returns the row it just wrote', async () => {
    const prisma = prismaForCreate();
    const service = new AdminContentService(prisma as unknown as PrismaService);

    const result = await service.createListing('admin-1', DTO as never);

    // A tagged-template call hands Prisma the SQL and the values separately;
    // the coordinates must never arrive as interpolated text.
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(Array.isArray(strings)).toBe(true);
    expect(values).toContain(7.2936);
    expect(values).toContain(80.6413);
    expect(result).toMatchObject({ id: 'new-listing', state: 'approved' });
  });

  it('gives every row a unique external_ref, so two creates in the same millisecond cannot collide', async () => {
    // travel_listing carries @@unique([source, external_ref]). A timestamp key
    // would make a double-click a 500; this asserts the key is not time-based.
    const service = new AdminContentService(prismaForCreate() as unknown as PrismaService);
    const other = prismaForCreate();
    const serviceB = new AdminContentService(other as unknown as PrismaService);

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const prismaA = (service as unknown as { prisma: { $queryRaw: ReturnType<typeof vi.fn> } }).prisma;
    await service.createListing('admin-1', DTO as never);
    await serviceB.createListing('admin-1', DTO as never);
    now.mockRestore();

    const refOf = (calls: unknown[][]) =>
      calls[0].slice(1).find((v) => typeof v === 'string' && v.startsWith('admin:'));
    expect(refOf(prismaA.$queryRaw.mock.calls)).not.toBe(refOf(other.$queryRaw.mock.calls));
  });

  it('records the creation in activity_log against the acting admin', async () => {
    const prisma = prismaForCreate();
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await service.createListing('admin-7', DTO as never);

    expect(prisma.activity_log.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: 'admin-7', action: 'listing.create' }),
      }),
    );
  });
});

describe('AdminContentService.updateListing', () => {
  it('404s before writing anything when the listing does not exist', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findUnique.mockResolvedValue(null);
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(service.updateListing('admin-1', 'ghost', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.travel_listing.update).not.toHaveBeenCalled();
  });

  it('writes only the patched fields and stamps updated_at', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.findUnique.mockResolvedValue(APPROVED_ROW);
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await service.updateListing('admin-1', 'row-1', { name: 'Renamed' });

    const { data } = prisma.travel_listing.update.mock.calls[0][0];
    expect(data.name).toBe('Renamed');
    expect(data.updated_at).toBeInstanceOf(Date);
    // location is geography(Point,4326) and latitude/longitude are generated
    // from it, so none of the three may ever appear in a Prisma update.
    expect(data).not.toHaveProperty('location');
    expect(data).not.toHaveProperty('latitude');
    expect(data).not.toHaveProperty('longitude');
  });
});

describe('AdminContentService event create/update guards', () => {
  const EVENT_DTO = {
    name: 'Kandy Esala Perahera',
    district_id: 'd-1',
    start_datetime: '2026-08-01T18:00:00.000Z',
  };

  function prismaForEvent() {
    const prisma = makePrisma();
    prisma.local_event.create = vi.fn().mockResolvedValue({ id: 'new-event', name: EVENT_DTO.name });
    prisma.local_event.findUnique.mockResolvedValue({
      id: 'new-event',
      is_verified: true,
      is_active: true,
      start_datetime: new Date(EVENT_DTO.start_datetime),
      end_datetime: null,
      price_min: null,
      price_max: null,
    });
    return prisma;
  }

  it('creates an event with a unique external_ref and logs it', async () => {
    const prisma = prismaForEvent();
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await service.createEvent('admin-1', EVENT_DTO as never);

    const { data } = prisma.local_event.create.mock.calls[0][0];
    expect(data.external_ref).toMatch(/^admin:[0-9a-f-]{36}$/);
    expect(data.source).toBe('admin');
    expect(prisma.activity_log.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'event.create' }) }),
    );
  });

  it('rejects an event that ends before it starts', async () => {
    const prisma = prismaForEvent();
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(
      service.createEvent('admin-1', {
        ...EVENT_DTO,
        end_datetime: '2026-07-01T18:00:00.000Z',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.local_event.create).not.toHaveBeenCalled();
  });

  it('rejects a price band whose maximum is below its minimum', async () => {
    const prisma = prismaForEvent();
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(
      service.createEvent('admin-1', { ...EVENT_DTO, price_min: 5000, price_max: 100 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.local_event.create).not.toHaveBeenCalled();
  });

  it('checks a patched date against the value already stored, not just the patch', async () => {
    // Patching only end_datetime must still be compared with the start date on
    // the row, or half a pair can be moved past the other unchecked.
    const prisma = prismaForEvent();
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(
      service.updateEvent('admin-1', 'new-event', { end_datetime: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.local_event.update).not.toHaveBeenCalled();
  });
});

describe('AdminContentService bulk verify', () => {
  const IDS = ['id-1', 'id-2', 'id-3'];

  it('approves the given rows in a single statement and reports how many changed', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.updateMany.mockResolvedValue({ count: 3 });
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(service.verifyListingsBulk('admin-1', IDS)).resolves.toEqual({ verified: 3 });
    expect(prisma.travel_listing.updateMany).toHaveBeenCalledTimes(1);
  });

  it('only touches rows that are still pending, so a concurrent approval is not re-stamped', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.updateMany.mockResolvedValue({ count: 2 });
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await service.verifyListingsBulk('admin-1', IDS);

    const { where, data } = prisma.travel_listing.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({ id: { in: IDS }, is_verified: false });
    expect(data).toMatchObject({ is_verified: true, is_active: true });
  });

  it('writes one audit entry per row, so bulk approval is not an audit blind spot', async () => {
    const prisma = makePrisma();
    prisma.travel_listing.updateMany.mockResolvedValue({ count: 3 });
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await service.verifyListingsBulk('admin-9', IDS);

    expect(prisma.activity_log.create).toHaveBeenCalledTimes(IDS.length);
    expect(prisma.activity_log.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: 'admin-9', action: 'listing.verify' }),
      }),
    );
  });

  it('does the same for events', async () => {
    const prisma = makePrisma();
    prisma.local_event.updateMany.mockResolvedValue({ count: 1 });
    const service = new AdminContentService(prisma as unknown as PrismaService);

    await expect(service.verifyEventsBulk('admin-1', ['e-1'])).resolves.toEqual({ verified: 1 });
    expect(prisma.activity_log.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'event.verify' }) }),
    );
  });
});
