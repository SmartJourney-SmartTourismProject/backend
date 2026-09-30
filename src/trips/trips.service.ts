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

const DAY_MS = 24 * 60 * 60 * 1000;

/** A 'YYYY-MM-DD' (or ISO) string as a UTC-midnight Date - the same shape
 * Prisma returns for a `@db.Date` column, so comparisons line up. */
function toDateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/** Today's calendar date in Sri Lanka (the app's timezone - the AI backend
 * plans in Asia/Colombo too), as a UTC-midnight Date. */
export function todayInSriLanka(now: Date = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(now);
  return toDateOnly(ymd);
}

/**
 * The status a trip is SHOWN with: 'past' once its last day is over,
 * otherwise whatever the traveller set. Derived at read time rather than
 * written by a nightly job, so a trip moves to Past the moment it ends with
 * nothing to schedule, and the stored column keeps the traveller's own
 * choice (draft/upcoming) intact.
 */
export function effectiveStatus<T extends { status: string; end_date: Date | null }>(
  trip: T,
  today: Date = todayInSriLanka(),
): T {
  return trip.end_date && trip.end_date < today ? { ...trip, status: 'past' } : trip;
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
    // Idempotent on chat_message_id: the chat's "Save itinerary" button
    // doesn't track across a page refresh whether it already saved this
    // card, so a re-click (or the same request replayed) returns the
    // existing trip rather than tripping the unique constraint or creating
    // a duplicate.
    if (dto.chat_message_id) {
      const existing = await this.prisma.itinerary.findFirst({
        where: { chat_message_id: dto.chat_message_id, user_id: userId },
        include: { itinerary_day: { include: { itinerary_item: true } } },
      });
      if (existing) return effectiveStatus(existing);
    }

    const district_id = await this.resolveDistrictId(dto.destination);
    // The trip's own date range, from its days - without it the Saved
    // Itineraries card read "Dates not set" and nothing could ever tell the
    // trip had ended.
    const dayDates = dto.itinerary
      .map((day) => day.date)
      .filter((d): d is string => !!d)
      .map(toDateOnly)
      .sort((a, b) => a.getTime() - b.getTime());

    const created = await this.prisma.itinerary.create({
      data: {
        user_id: userId,
        district_id,
        title: dto.title ?? dto.destination ?? null,
        start_date: dayDates[0] ?? null,
        end_date: dayDates[dayDates.length - 1] ?? null,
        travelers: dto.travelers ?? 1,
        budget: dto.budget ?? null,
        estimated_cost: dto.estimated_cost ?? null,
        currency: dto.currency ?? 'LKR',
        status: 'draft',
        chat_message_id: dto.chat_message_id ?? null,
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
    return effectiveStatus(created);
  }

  async listTrips(userId: string, query: TripsQueryDto) {
    const today = todayInSriLanka();
    // Filtered by the EFFECTIVE status (see effectiveStatus): a trip whose
    // last day has passed belongs under Past whatever its stored status,
    // and never under Drafts/Upcoming.
    const statusFilter =
      query.status === 'past'
        ? { OR: [{ status: 'past' }, { end_date: { lt: today } }] }
        : query.status
          ? { status: query.status, OR: [{ end_date: null }, { end_date: { gte: today } }] }
          : {};
    const trips = await this.prisma.itinerary.findMany({
      where: { user_id: userId, ...statusFilter },
      orderBy: { updated_at: 'desc' },
      include: { district: { select: DISTRICT_SUMMARY_SELECT } },
    });
    return trips.map((trip) => effectiveStatus(trip, today));
  }

  async getTripById(userId: string, id: string) {
    return effectiveStatus(await this.findOwnedTrip(userId, id));
  }

  /** The trip as STORED (its own status, not the displayed one). */
  private async findOwnedTrip(userId: string, id: string) {
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
    const current = await this.findOwnedTrip(userId, id);

    // Picking a start date moves the whole trip: every day is re-dated
    // (day N = start + N-1) and the end date follows, unless one is given.
    // It also commits a draft - choosing when you'll go is what makes a
    // trip "upcoming" - unless the request sets a status explicitly.
    let start_date: Date | undefined;
    let end_date: Date | undefined = dto.end_date !== undefined ? toDateOnly(dto.end_date) : undefined;
    let status = dto.status;
    const dayUpdates = [];
    if (dto.start_date !== undefined) {
      start_date = toDateOnly(dto.start_date);
      const lastDay = Math.max(1, ...current.itinerary_day.map((d) => d.day_number));
      end_date ??= new Date(start_date.getTime() + (lastDay - 1) * DAY_MS);
      for (const day of current.itinerary_day) {
        dayUpdates.push(
          this.prisma.itinerary_day.update({
            where: { id: day.id },
            data: { date: new Date(start_date.getTime() + (day.day_number - 1) * DAY_MS) },
          }),
        );
      }
      if (status === undefined && current.status === 'draft') status = 'upcoming';
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.itinerary.update({
        where: { id },
        data: {
          ...(dto.title !== undefined && { title: dto.title }),
          ...(status !== undefined && { status }),
          ...(start_date !== undefined && { start_date }),
          ...(end_date !== undefined && { end_date }),
          ...(dto.budget !== undefined && { budget: dto.budget }),
          updated_at: new Date(),
        },
      }),
      ...dayUpdates,
    ]);
    return effectiveStatus(updated);
  }

  async deleteTrip(userId: string, id: string) {
    await this.getTripById(userId, id);
    await this.prisma.itinerary.delete({ where: { id } });
    return { deleted: true };
  }
}
