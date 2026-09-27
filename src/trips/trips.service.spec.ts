import { NotFoundException } from '@nestjs/common';
import { TripsService } from './trips.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

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
  };
}

describe('TripsService.saveTrip', () => {
  it('resolves destination to a district and creates nested days/items', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null); // no chat_message_id dedupe hit
    prisma.district.findFirst.mockResolvedValue({ id: 'district-1' });
    prisma.itinerary.create.mockResolvedValue({ id: 'trip-1' });
    const service = new TripsService(prisma as unknown as PrismaService);

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
    const service = new TripsService(prisma as unknown as PrismaService);

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
    const service = new TripsService(prisma as unknown as PrismaService);

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
  it('scopes the query to the caller and applies an optional status filter', () => {
    const prisma = makePrisma();
    prisma.itinerary.findMany.mockReturnValue([]);
    const service = new TripsService(prisma as unknown as PrismaService);

    service.listTrips('user-1', { status: 'upcoming' });

    expect(prisma.itinerary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'user-1', status: 'upcoming' } }),
    );
  });
});

describe('TripsService ownership', () => {
  it('getTripById throws NotFound for a trip that belongs to someone else', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null);
    const service = new TripsService(prisma as unknown as PrismaService);

    await expect(service.getTripById('user-1', 'someone-elses-trip')).rejects.toThrow(NotFoundException);
  });

  it('updateTrip and deleteTrip both reject a foreign trip before touching it', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null);
    const service = new TripsService(prisma as unknown as PrismaService);

    await expect(service.updateTrip('user-1', 'foreign-trip', { title: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.deleteTrip('user-1', 'foreign-trip')).rejects.toThrow(NotFoundException);
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
    expect(prisma.itinerary.delete).not.toHaveBeenCalled();
  });
});
