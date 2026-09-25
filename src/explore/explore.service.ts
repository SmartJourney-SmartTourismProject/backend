import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ListingsQueryDto } from './dto/listings-query.dto.js';
import { EventsQueryDto } from './dto/events-query.dto.js';

const PAGE_SIZE = 20;

// district.osm_relation_id is a BigInt, which JSON.stringify can't
// serialize - select only the fields callers actually need instead of
// including the full relation.
const DISTRICT_SUMMARY_SELECT = { id: true, name: true, province: true } as const;

@Injectable()
export class ExploreService {
  constructor(private readonly prisma: PrismaService) {}

  getDistricts() {
    return this.prisma.district.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, province: true },
    });
  }

  getCategories() {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
  }

  getTags() {
    return this.prisma.tag_vocabulary.findMany({
      orderBy: { tag: 'asc' },
      select: { tag: true, label: true, is_outdoor: true },
    });
  }

  async searchListings(query: ListingsQueryDto) {
    const page = query.page ?? 1;

    const where = {
      is_verified: true,
      // Rejected/retired rows keep is_verified = false, but an admin can also
      // deactivate a previously approved one - that must disappear from
      // public reads too (see admin-content.service.ts).
      is_active: true,
      ...(query.district && { district_id: query.district }),
      ...(query.category && { category_id: query.category }),
      ...(query.minRating && { rating: { gte: query.minRating } }),
      ...(query.q && {
        name: { contains: query.q, mode: 'insensitive' as const },
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.travel_listing.findMany({
        where,
        orderBy: { rating: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          category: true,
          district: { select: DISTRICT_SUMMARY_SELECT },
          listing_image: true,
        },
      }),
      this.prisma.travel_listing.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async getListingById(id: string) {
    const listing = await this.prisma.travel_listing.findFirst({
      where: { id, is_verified: true, is_active: true },
      include: {
        category: true,
        district: { select: DISTRICT_SUMMARY_SELECT },
        listing_image: true,
      },
    });
    if (!listing) {
      throw new NotFoundException(`Listing ${id} not found`);
    }
    return listing;
  }

  searchEvents(query: EventsQueryDto) {
    return this.prisma.local_event.findMany({
      where: {
        is_verified: true,
        is_active: true,
        ...(query.district && { district_id: query.district }),
        ...(query.from && { start_datetime: { gte: new Date(query.from) } }),
        ...(query.to && { start_datetime: { lte: new Date(query.to) } }),
      },
      orderBy: { start_datetime: 'asc' },
      include: { district: { select: DISTRICT_SUMMARY_SELECT } },
    });
  }

  async getEventById(id: string) {
    const event = await this.prisma.local_event.findFirst({
      where: { id, is_verified: true, is_active: true },
      include: { district: { select: DISTRICT_SUMMARY_SELECT } },
    });
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    return event;
  }
}
