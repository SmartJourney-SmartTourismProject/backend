import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { CreateListingDto } from './dto/create-listing.dto.js';
import { ModerationQueryDto, ModerationState } from './dto/moderation-query.dto.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { UpdateListingDto } from './dto/update-listing.dto.js';

const PAGE_SIZE = 20;

const DISTRICT_SUMMARY_SELECT = { id: true, name: true, province: true } as const;

/**
 * Both content tables carry @@unique([source, external_ref]). A timestamp is
 * not unique enough: two rows created in the same millisecond - a double-click
 * on the form, or two admins working at once - collide, and with no global
 * Prisma exception filter that surfaces as a 500 rather than anything the
 * admin can act on. A UUID removes the race instead of narrowing it.
 */
function adminExternalRef(): string {
  return `admin:${randomUUID()}`;
}

/** end must not precede start; the DTO cannot check one field against another. */
function assertDateOrder(start?: string, end?: string | null) {
  if (!start || !end) return;
  if (new Date(end).getTime() < new Date(start).getTime()) {
    throw new BadRequestException('end_datetime must not be before start_datetime');
  }
}

/**
 * Same for the price band. The stored columns are Prisma `Decimal`, not number,
 * so both sides are coerced explicitly rather than left to `<`, which would
 * compare a Decimal through its string form.
 */
function assertPriceOrder(min?: unknown, max?: unknown) {
  if (min === null || min === undefined || max === null || max === undefined) return;
  const lo = Number(min);
  const hi = Number(max);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return;
  if (hi < lo) {
    throw new BadRequestException('price_max must not be less than price_min');
  }
}

/**
 * pending / approved / rejected expressed over the (is_verified, is_active)
 * pair both tables carry. A row the ingest jobs re-upsert keeps whatever an
 * admin decided, because those jobs never write these two columns.
 */
function stateFilter(status?: ModerationState) {
  switch (status) {
    case 'approved':
      return { is_verified: true, is_active: true };
    case 'rejected':
      return { is_active: false };
    case 'pending':
      return { is_verified: false, is_active: true };
    default:
      return {};
  }
}

/** The label the UI shows, derived from the same pair. */
function stateOf(row: { is_verified: boolean; is_active: boolean }): ModerationState {
  if (!row.is_active) return 'rejected';
  return row.is_verified ? 'approved' : 'pending';
}

@Injectable()
export class AdminContentService {
  private readonly logger = new Logger(AdminContentService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---- dashboard -------------------------------------------------------

  async getStats() {
    const [
      travelers, admins, itineraries, chatSessions,
      listingsPending, listingsApproved, eventsPending, eventsApproved, entryFeesPending,
    ] = await Promise.all([
      this.prisma.app_user.count({ where: { role: 'traveler' } }),
      this.prisma.app_user.count({ where: { role: 'admin' } }),
      this.prisma.itinerary.count(),
      this.prisma.chat_session.count(),
      this.prisma.travel_listing.count({ where: stateFilter('pending') }),
      this.prisma.travel_listing.count({ where: stateFilter('approved') }),
      this.prisma.local_event.count({ where: stateFilter('pending') }),
      this.prisma.local_event.count({ where: stateFilter('approved') }),
      this.prisma.listing_entry_fee.count({ where: { status: 'pending' } }),
    ]);

    return {
      users: { travelers, admins, total: travelers + admins },
      itineraries,
      chat_sessions: chatSessions,
      listings: { pending: listingsPending, approved: listingsApproved },
      events: { pending: eventsPending, approved: eventsApproved },
      entry_fees: { pending: entryFeesPending },
      // What the dashboard's "needs attention" card counts.
      pending_verifications: listingsPending + eventsPending + entryFeesPending,
    };
  }

  // ---- listings --------------------------------------------------------

  async listListings(query: ModerationQueryDto) {
    const page = query.page ?? 1;
    const where: Prisma.travel_listingWhereInput = {
      ...stateFilter(query.status),
      ...(query.district && { district_id: query.district }),
      ...(query.category && { category_id: query.category }),
      ...(query.q && { name: { contains: query.q, mode: 'insensitive' } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.travel_listing.findMany({
        where,
        // Oldest unreviewed first: the moderation queue should drain in the
        // order things arrived, not by rating.
        orderBy: [{ is_verified: 'asc' }, { created_at: 'asc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          category: true,
          district: { select: DISTRICT_SUMMARY_SELECT },
          listing_image: { take: 1 },
        },
      }),
      this.prisma.travel_listing.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({ ...row, state: stateOf(row) })),
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async getListing(id: string) {
    const row = await this.prisma.travel_listing.findUnique({
      where: { id },
      include: {
        category: true,
        district: { select: DISTRICT_SUMMARY_SELECT },
        listing_image: true,
      },
    });
    if (!row) throw new NotFoundException(`Listing ${id} not found`);
    return { ...row, state: stateOf(row) };
  }

  async createListing(adminId: string, dto: CreateListingDto) {
    const { latitude, longitude, ...rest } = dto;
    // `location` is geography(Point,4326) - Unsupported by the Prisma client,
    // so the row is inserted with raw SQL and then read back normally.
    const externalRef = adminExternalRef();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO travel_listing
        (district_id, category_id, name, description, location, tags, price_level,
         price_per_night, currency, rating, photo_url, has_public_transit,
         source, external_ref, is_verified, is_active)
      VALUES (
        ${rest.district_id}::uuid, ${rest.category_id}::uuid, ${rest.name},
        ${rest.description ?? null}, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
        ${rest.tags ?? []}, ${rest.price_level ?? null}, ${rest.price_per_night ?? null},
        ${rest.currency ?? 'LKR'}, ${rest.rating ?? null}, ${rest.photo_url ?? null},
        ${rest.has_public_transit ?? false}, 'admin', ${externalRef}, true, true
      )
      RETURNING id`;
    const id = rows[0].id;
    // Created by a human reviewer, so it is verified on the spot - recorded
    // as such rather than silently.
    await this.log(adminId, 'listing.create', { listing_id: id, name: rest.name });
    return this.getListing(id);
  }

  async updateListing(adminId: string, id: string, dto: UpdateListingDto) {
    await this.getListing(id);
    await this.prisma.travel_listing.update({
      where: { id },
      data: { ...dto, updated_at: new Date() },
    });
    await this.log(adminId, 'listing.update', { listing_id: id, fields: Object.keys(dto) });
    return this.getListing(id);
  }

  async verifyListing(adminId: string, id: string) {
    await this.getListing(id);
    await this.prisma.travel_listing.update({
      where: { id },
      data: { is_verified: true, is_active: true, updated_at: new Date() },
    });
    await this.log(adminId, 'listing.verify', { listing_id: id });
    return this.getListing(id);
  }

  async rejectListing(adminId: string, id: string, reason?: string) {
    await this.getListing(id);
    await this.prisma.travel_listing.update({
      where: { id },
      data: { is_verified: false, is_active: false, updated_at: new Date() },
    });
    await this.log(adminId, 'listing.reject', { listing_id: id, reason: reason ?? null });
    return this.getListing(id);
  }

  async deleteListing(adminId: string, id: string) {
    await this.getListing(id);
    // Hard delete is the wrong default for a row an ingest job will simply
    // re-create on its next run; reject is what "remove from the app" means
    // here. Kept for genuinely bad rows (duplicates, test data).
    await this.prisma.travel_listing.delete({ where: { id } });
    await this.log(adminId, 'listing.delete', { listing_id: id });
    return { deleted: true };
  }

  // ---- events ----------------------------------------------------------

  async listEvents(query: ModerationQueryDto) {
    const page = query.page ?? 1;
    const where: Prisma.local_eventWhereInput = {
      ...stateFilter(query.status),
      ...(query.district && { district_id: query.district }),
      ...(query.q && { name: { contains: query.q, mode: 'insensitive' } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.local_event.findMany({
        where,
        orderBy: [{ is_verified: 'asc' }, { start_datetime: 'asc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { district: { select: DISTRICT_SUMMARY_SELECT } },
      }),
      this.prisma.local_event.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({ ...row, state: stateOf(row) })),
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async getEvent(id: string) {
    const row = await this.prisma.local_event.findUnique({
      where: { id },
      include: { district: { select: DISTRICT_SUMMARY_SELECT } },
    });
    if (!row) throw new NotFoundException(`Event ${id} not found`);
    return { ...row, state: stateOf(row) };
  }

  async createEvent(adminId: string, dto: CreateEventDto) {
    assertDateOrder(dto.start_datetime, dto.end_datetime);
    assertPriceOrder(dto.price_min, dto.price_max);
    const row = await this.prisma.local_event.create({
      data: {
        district_id: dto.district_id,
        name: dto.name,
        description: dto.description ?? null,
        start_datetime: new Date(dto.start_datetime),
        end_datetime: dto.end_datetime ? new Date(dto.end_datetime) : null,
        venue_name: dto.venue_name ?? null,
        tags: dto.tags ?? [],
        price_min: dto.price_min ?? null,
        price_max: dto.price_max ?? null,
        currency: dto.currency ?? 'LKR',
        source: 'admin',
        external_ref: adminExternalRef(),
        is_verified: true,
        is_active: true,
      },
    });
    await this.log(adminId, 'event.create', { event_id: row.id, name: row.name });
    return this.getEvent(row.id);
  }

  async updateEvent(adminId: string, id: string, dto: UpdateEventDto) {
    const current = await this.getEvent(id);
    // A patch may supply only one half of a pair, so validate the values the
    // row will actually end up with, not just the ones in this request.
    assertDateOrder(
      dto.start_datetime ?? current.start_datetime?.toISOString(),
      dto.end_datetime === undefined ? current.end_datetime?.toISOString() : dto.end_datetime,
    );
    assertPriceOrder(
      dto.price_min === undefined ? current.price_min : dto.price_min,
      dto.price_max === undefined ? current.price_max : dto.price_max,
    );
    const { start_datetime, end_datetime, ...rest } = dto;
    await this.prisma.local_event.update({
      where: { id },
      data: {
        ...rest,
        ...(start_datetime !== undefined && { start_datetime: new Date(start_datetime) }),
        ...(end_datetime !== undefined && { end_datetime: end_datetime ? new Date(end_datetime) : null }),
        updated_at: new Date(),
      },
    });
    await this.log(adminId, 'event.update', { event_id: id, fields: Object.keys(dto) });
    return this.getEvent(id);
  }

  /**
   * Approve several rows in one action, for a queue an admin has just read
   * through. `updateMany` is one statement rather than N round-trips, and the
   * `is_verified: false` guard means a row someone else approved in the
   * meantime is not counted twice or re-stamped.
   *
   * The audit trail stays per-row - one activity_log entry each, same action
   * name as the single-row route - so bulk approval is not a blind spot when
   * someone later asks who approved a given listing.
   */
  async verifyListingsBulk(adminId: string, ids: string[]) {
    const { count } = await this.prisma.travel_listing.updateMany({
      where: { id: { in: ids }, is_verified: false },
      data: { is_verified: true, is_active: true, updated_at: new Date() },
    });
    for (const id of ids) {
      await this.log(adminId, 'listing.verify', { listing_id: id, bulk: true });
    }
    return { verified: count };
  }

  async verifyEventsBulk(adminId: string, ids: string[]) {
    const { count } = await this.prisma.local_event.updateMany({
      where: { id: { in: ids }, is_verified: false },
      data: { is_verified: true, is_active: true, updated_at: new Date() },
    });
    for (const id of ids) {
      await this.log(adminId, 'event.verify', { event_id: id, bulk: true });
    }
    return { verified: count };
  }

  async verifyEvent(adminId: string, id: string) {
    await this.getEvent(id);
    await this.prisma.local_event.update({
      where: { id },
      data: { is_verified: true, is_active: true, updated_at: new Date() },
    });
    await this.log(adminId, 'event.verify', { event_id: id });
    return this.getEvent(id);
  }

  async rejectEvent(adminId: string, id: string, reason?: string) {
    await this.getEvent(id);
    await this.prisma.local_event.update({
      where: { id },
      data: { is_verified: false, is_active: false, updated_at: new Date() },
    });
    await this.log(adminId, 'event.reject', { event_id: id, reason: reason ?? null });
    return this.getEvent(id);
  }

  async deleteEvent(adminId: string, id: string) {
    await this.getEvent(id);
    await this.prisma.local_event.delete({ where: { id } });
    await this.log(adminId, 'event.delete', { event_id: id });
    return { deleted: true };
  }

  // ---- audit -----------------------------------------------------------

  /** SRS §3.1.13: every admin action is attributable and reviewable. */
  private async log(adminId: string, action: string, detail: Prisma.InputJsonValue) {
    try {
      await this.prisma.activity_log.create({ data: { user_id: adminId, action, detail } });
    } catch (error) {
      // An audit write must never fail the action the admin actually asked
      // for; losing one log line is better than a 500 mid-moderation.
      this.logger.error(`Failed to write activity_log for ${action}: ${String(error)}`);
    }
  }
}
