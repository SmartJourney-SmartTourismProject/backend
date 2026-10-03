import { NotFoundException } from '@nestjs/common';
import { TripsService, effectiveStatus, todayInSriLanka } from './trips.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';

const NOTIFICATIONS = { tripSaved: vi.fn().mockResolvedValue(false) } as unknown as NotificationsService;

function makePrisma() {
  return {
    district: { findFirst: vi.fn() },
    itinerary: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    itinerary_day: { update: vi.fn() },
    $transaction: vi.fn(),
  };
}

describe('TripsService.saveTrip', () => {
  it('resolves destination to a district and creates nested days/items', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null); // no chat_message_id dedupe hit
    prisma.district.findFirst.mockResolvedValue({ id: 'district-1' });
    prisma.itinerary.create.mockResolvedValue({ id: 'trip-1' });
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const dto = {
      destination: 'Kandy',
      itinerary: [
        {
          day: 1,
          items: [{ type: 'sight', name: 'Temple of the Tooth', lat: 7.29, lon: 80.64, time: '09:30' }],
        },
      ],
    } as Parameters<TripsService['saveTrip']>[1];

    await service.saveTrip('user-1', dto);

    expect(prisma.district.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: { contains: 'Kandy', mode: 'insensitive' } } }),
    );
    expect(prisma.itinerary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: 'user-1',
          district_id: 'district-1',
          currency: 'LKR',
          status: 'draft',
          itinerary_day: {
            create: [
              expect.objectContaining({
                day_number: 1,
                itinerary_item: {
                  create: [
                    expect.objectContaining({
                      item_type: 'sight',
                      name: 'Temple of the Tooth',
                      order_index: 0,
                    }),
                  ],
                },
              }),
            ],
          },
        }),
      }),
    );
  });

  it('returns the existing trip instead of creating a duplicate when chat_message_id already saved', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue({ id: 'existing-trip' });
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.saveTrip('user-1', {
      chat_message_id: 'msg-1',
      itinerary: [{ day: 1, items: [] }],
    } as Parameters<TripsService['saveTrip']>[1]);

    expect(result).toEqual({ id: 'existing-trip' });
    expect(prisma.itinerary.create).not.toHaveBeenCalled();
  });

  it('leaves district_id null when no destination is given, without querying district', async () => {
    const prisma = makePrisma();
    prisma.itinerary.create.mockResolvedValue({ id: 'trip-2' });
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.saveTrip('user-1', { itinerary: [{ day: 1, items: [] }] } as Parameters<
      TripsService['saveTrip']
    >[1]);

    expect(prisma.district.findFirst).not.toHaveBeenCalled();
    expect(prisma.itinerary.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ district_id: null }) }),
    );
  });
});

describe('TripsService.listTrips', () => {
  const TODAY = todayInSriLanka();
  const YESTERDAY = new Date(TODAY.getTime() - 24 * 60 * 60 * 1000);

  it('scopes Drafts/Upcoming to the caller and to trips that have not ended', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findMany.mockResolvedValue([]);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.listTrips('user-1', { status: 'upcoming' });

    expect(prisma.itinerary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user_id: 'user-1',
          status: 'upcoming',
          OR: [{ end_date: null }, { end_date: { gte: TODAY } }],
        },
      }),
    );
  });

  it('Past includes trips whose last day is over, whatever their stored status', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findMany.mockResolvedValue([{ id: 't1', status: 'upcoming', end_date: YESTERDAY }]);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const trips = await service.listTrips('user-1', { status: 'past' });

    expect(prisma.itinerary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id: 'user-1', OR: [{ status: 'past' }, { end_date: { lt: TODAY } }] },
      }),
    );
    expect(trips[0].status).toBe('past');
  });

  it('a trip ending today is not past yet', () => {
    expect(effectiveStatus({ status: 'upcoming', end_date: TODAY }).status).toBe('upcoming');
    expect(effectiveStatus({ status: 'draft', end_date: YESTERDAY }).status).toBe('past');
    expect(effectiveStatus({ status: 'draft', end_date: null }).status).toBe('draft');
  });
});

describe('TripsService dates', () => {
  it('saveTrip sets the trip dates from its first and last day', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null);
    prisma.district.findFirst.mockResolvedValue(null);
    prisma.itinerary.create.mockResolvedValue({ id: 'trip-1', status: 'draft', end_date: null });
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.saveTrip('user-1', {
      destination: 'Kandy',
      itinerary: [
        { day: 2, date: '2026-12-02', items: [] },
        { day: 1, date: '2026-12-01', items: [] },
      ],
    } as Parameters<TripsService['saveTrip']>[1]);

    const data = prisma.itinerary.create.mock.calls[0][0].data;
    expect(data.start_date).toEqual(new Date('2026-12-01T00:00:00.000Z'));
    expect(data.end_date).toEqual(new Date('2026-12-02T00:00:00.000Z'));
    expect(data.status).toBe('draft');
  });

  function tripWithDays(status = 'draft') {
    return {
      id: 'trip-1', status, end_date: null,
      itinerary_day: [
        { id: 'd1', day_number: 1 },
        { id: 'd2', day_number: 2 },
        { id: 'd3', day_number: 3 },
      ],
    };
  }

  it('picking a start date re-dates every day, sets the end date and makes a draft upcoming', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(tripWithDays('draft'));
    prisma.itinerary.update.mockReturnValue('trip-update');
    prisma.itinerary_day.update.mockImplementation((args) => args);
    prisma.$transaction.mockResolvedValue([{ id: 'trip-1', status: 'upcoming', end_date: null }]);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.updateTrip('user-1', 'trip-1', { start_date: '2026-12-10' });

    const tripData = prisma.itinerary.update.mock.calls[0][0].data;
    expect(tripData.start_date).toEqual(new Date('2026-12-10T00:00:00.000Z'));
    expect(tripData.end_date).toEqual(new Date('2026-12-12T00:00:00.000Z'));
    expect(tripData.status).toBe('upcoming');
    const dayDates = prisma.itinerary_day.update.mock.calls.map((c) => c[0].data.date.toISOString().slice(0, 10));
    expect(dayDates).toEqual(['2026-12-10', '2026-12-11', '2026-12-12']);
  });

  it('an explicit status wins over the automatic draft -> upcoming', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(tripWithDays('draft'));
    prisma.itinerary_day.update.mockImplementation((args) => args);
    prisma.$transaction.mockResolvedValue([{ id: 'trip-1', status: 'draft', end_date: null }]);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.updateTrip('user-1', 'trip-1', { start_date: '2026-12-10', status: 'draft' });

    expect(prisma.itinerary.update.mock.calls[0][0].data.status).toBe('draft');
  });

  it('a date change leaves an already-upcoming trip upcoming', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(tripWithDays('upcoming'));
    prisma.itinerary_day.update.mockImplementation((args) => args);
    prisma.$transaction.mockResolvedValue([{ id: 'trip-1', status: 'upcoming', end_date: null }]);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.updateTrip('user-1', 'trip-1', { start_date: '2026-12-10' });

    expect(prisma.itinerary.update.mock.calls[0][0].data.status).toBeUndefined();
  });
});

describe('TripsService ownership', () => {
  it('getTripById throws NotFound for a trip that belongs to someone else', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await expect(service.getTripById('user-1', 'someone-elses-trip')).rejects.toThrow(NotFoundException);
  });

  it('updateTrip and deleteTrip both reject a foreign trip before touching it', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null);
    const service = new TripsService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await expect(service.updateTrip('user-1', 'foreign-trip', { title: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.deleteTrip('user-1', 'foreign-trip')).rejects.toThrow(NotFoundException);
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
    expect(prisma.itinerary.delete).not.toHaveBeenCalled();
  });
});
