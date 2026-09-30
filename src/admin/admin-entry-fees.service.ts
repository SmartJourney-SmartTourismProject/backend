import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { EntryFeeQueryDto } from './dto/entry-fee-query.dto.js';

const PAGE_SIZE = 20;

/** Prisma's "unique constraint failed" - entry_fee_one_approved_per_listing
 * (0012): two fees approved for the same listing. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Review queue for scraped heritage-site entry fees (db/migrations/0012,
 * ai-backend's entry_fees_ccf connector). Separate from AdminContentService:
 * listing_entry_fee has its own `status` column rather than the
 * is_verified/is_active pair travel_listing and local_event share, and
 * reviewing a fee is "confirm this price and this listing match", not
 * "publish or don't" - a different enough shape to not force into
 * stateFilter()/stateOf().
 *
 * Only an 'approved' row is ever read by the AI backend's budget
 * (app/tools/db_tool.py's listing_entry_fee LEFT JOIN) - everything here is
 * staging until an admin acts on it.
 */
@Injectable()
export class AdminEntryFeesService {
  private readonly logger = new Logger(AdminEntryFeesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(query: EntryFeeQueryDto) {
    const page = query.page ?? 1;
    const where: Prisma.listing_entry_feeWhereInput = query.status ? { status: query.status } : {};

    const [rows, total] = await Promise.all([
      this.prisma.listing_entry_fee.findMany({
        where,
        orderBy: [{ status: 'asc' }, { fetched_at: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          // The admin reviews a suggested match against the real listing,
          // not just its id - name/district make the suggestion legible.
          travel_listing: { select: { id: true, name: true, district: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.listing_entry_fee.count({ where }),
    ]);

    return { items: rows, page, pageSize: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE) };
  }

  async get(id: string) {
    const row = await this.prisma.listing_entry_fee.findUnique({
      where: { id },
      include: { travel_listing: { select: { id: true, name: true, district: { select: { id: true, name: true } } } } },
    });
    if (!row) throw new NotFoundException(`Entry fee ${id} not found`);
    return row;
  }

  /**
   * Approving with no listing_id (the connector found no confident match,
   * or an admin unlinked one) is refused rather than silently accepted: an
   * approved-but-unlinked fee can never reach a budget anyway
   * (db_tool.py's join is ON f.listing_id = l.id), so it would sit in the
   * "approved" filter looking done while doing nothing. Re-link it first.
   */
  async approve(adminId: string, id: string) {
    const current = await this.get(id);
    if (!current.listing_id) {
      throw new NotFoundException(`Entry fee ${id} has no linked listing - re-link it before approving`);
    }
    try {
      await this.prisma.listing_entry_fee.update({
        where: { id },
        data: { status: 'approved', reviewed_at: new Date(), reviewed_by: adminId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Listing ${current.listing_id} already has an approved entry fee - reject or relink the other one first`,
        );
      }
      throw error;
    }
    await this.log(adminId, 'entry_fee.approve', { entry_fee_id: id, listing_id: current.listing_id });
    return this.get(id);
  }

  async reject(adminId: string, id: string) {
    await this.get(id);
    await this.prisma.listing_entry_fee.update({
      where: { id },
      data: { status: 'rejected', reviewed_at: new Date(), reviewed_by: adminId },
    });
    await this.log(adminId, 'entry_fee.reject', { entry_fee_id: id });
    return this.get(id);
  }

  /** Corrects or clears the connector's auto-match; does not itself change status. */
  async relink(adminId: string, id: string, listingId: string | null | undefined) {
    await this.get(id);
    await this.prisma.listing_entry_fee.update({
      where: { id },
      data: { listing_id: listingId ?? null },
    });
    await this.log(adminId, 'entry_fee.relink', { entry_fee_id: id, listing_id: listingId ?? null });
    return this.get(id);
  }

  private async log(adminId: string, action: string, detail: Prisma.InputJsonValue) {
    try {
      await this.prisma.activity_log.create({ data: { user_id: adminId, action, detail } });
    } catch (error) {
      this.logger.error(`Failed to write activity_log for ${action}: ${String(error)}`);
    }
  }
}
