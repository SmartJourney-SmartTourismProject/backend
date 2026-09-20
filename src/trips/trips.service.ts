import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SaveTripDto } from './dto/save-trip.dto.js';
import { TripsQueryDto } from './dto/trips-query.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';

// district.osm_relation_id is a BigInt - see explore.service.ts for the same
// fix. Selecting only what callers need avoids the JSON.stringify crash.
const DISTRICT_SUMMARY_SELECT = { id: true, name: true, province: true } as const;

/** "09:00" -> a Date Prisma can write to a `Time` column (base date is
 * irrelevant, Postgres only stores the time-of-day part). Returns null for
 * anything missing or unparseable rather than throwing - a saved trip
 * shouldn't fail over one stop lacking a time. */
function parseTimeOfDay(time?: string): Date | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const [, hours, minutes] = match;
  return new Date(Date.UTC(1970, 0, 1, Number(hours), Number(minutes)));
}

@Injectable()
export class TripsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveDistrictId(destination?: string): Promise<string | null> {
    if (!destination) return null;
    const district = await this.prisma.district.findFirst({
      where: { name: { contains: destination, mode: 'insensitive' } },
      select: { id: true },
    });
    return district?.id ?? null;
  }

  async saveTrip(userId: string, dto: SaveTripDto) {
    const district_id = await this.resolveDistrictId(dto.destination);

    return this.prisma.itinerary.create({
      data: {
        user_id: userId,
        district_id,
        title: dto.title ?? dto.destination ?? null,
        travelers: dto.travelers ?? 1,
        budget: dto.budget ?? null,
        estimated_cost: dto.estimated_cost ?? null,
        currency: dto.currency ?? 'LKR',
        status: 'draft',
        itinerary_day: {
          create: dto.itinerary.map((day) => ({
            day_number: day.day,
            date: day.date ? new Date(day.date) : null,
            itinerary_item: {
              create: day.items.map((item, index) => ({
                item_type: item.type,
                name: item.name,
                latitude: item.lat,
                longitude: item.lon,
                start_time: parseTimeOfDay(item.time),
                notes: item.notes ?? null,
                order_index: index,
              })),
            },
          })),
        },
      },
      include: { itinerary_day: { include: { itinerary_item: true } } },
    });
  }

  listTrips(userId: string, query: TripsQueryDto) {
    return this.prisma.itinerary.findMany({
      where: {
        user_id: userId,
        ...(query.status && { status: query.status }),
      },
      orderBy: { updated_at: 'desc' },
      include: { district: { select: DISTRICT_SUMMARY_SELECT } },
    });
  }

  async getTripById(userId: string, id: string) {
    const trip = await this.prisma.itinerary.findFirst({
      where: { id, user_id: userId },
      include: {
        district: { select: DISTRICT_SUMMARY_SELECT },
        itinerary_day: {
          orderBy: { day_number: 'asc' },
          include: { itinerary_item: { orderBy: { order_index: 'asc' } } },
        },
      },
    });
    if (!trip) {
      throw new NotFoundException(`Trip ${id} not found`);
    }
    return trip;
  }

  async updateTrip(userId: string, id: string, dto: UpdateTripDto) {
    await this.getTripById(userId, id);
    return this.prisma.itinerary.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.start_date !== undefined && { start_date: new Date(dto.start_date) }),
        ...(dto.end_date !== undefined && { end_date: new Date(dto.end_date) }),
        ...(dto.budget !== undefined && { budget: dto.budget }),
        updated_at: new Date(),
      },
    });
  }

  async deleteTrip(userId: string, id: string) {
    await this.getTripById(userId, id);
    await this.prisma.itinerary.delete({ where: { id } });
    return { deleted: true };
  }
}
