import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** How far back the trend charts look. */
const TREND_DAYS = 30;
/** Districts/categories shown in the breakdown lists. */
const TOP_N = 8;

export interface DayCount {
  day: string; // YYYY-MM-DD
  count: number;
}

/**
 * Midnight *UTC* today. Using local midnight instead would render as the
 * previous day's date once converted with toISOString(), shifting the whole
 * window by one and dropping today - the day an admin most wants to see.
 */
function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * SRS §3.1.14 - the analytics dashboard: headline counts plus the trend
 * charts ("AI itinerary generation trends and other platform usage
 * statistics").
 *
 * Counting is done in SQL (GROUP BY on a UTC day string), not by pulling rows
 * into Node, and every series is gap-filled so a day with no activity plots as
 * 0 rather than being skipped - a line chart that silently drops days misreads
 * as flat activity.
 *
 * Deliberately absent: subscription revenue, which SRS §3.1.14 also lists.
 * Subscriptions are out of scope this round (BACKEND_PLAN.md §1), the tables
 * do not exist, and inventing a number would be worse than omitting it - the
 * API reports it as unavailable so the UI can say so.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAnalytics() {
    const since = startOfTodayUtc();
    since.setUTCDate(since.getUTCDate() - (TREND_DAYS - 1));

    const [itineraries, chats, signups, moderation, byCategory, byDistrict, statusMix, topPlanners] =
      await Promise.all([
        this.dailyCounts('itinerary', since),
        this.dailyCounts('chat_session', since),
        this.dailyCounts('app_user', since),
        this.moderationByDay(since),
        this.listingsByCategory(),
        this.listingsByDistrict(),
        this.itineraryStatusMix(),
        this.topPlanners(),
      ]);

    return {
      range: { from: since.toISOString().slice(0, 10), days: TREND_DAYS },
      trends: {
        itineraries: this.fill(itineraries, since),
        chat_sessions: this.fill(chats, since),
        signups: this.fill(signups, since),
        moderation,
      },
      breakdowns: {
        listings_by_category: byCategory,
        listings_by_district: byDistrict,
        itinerary_status: statusMix,
        top_planners: topPlanners,
      },
      // SRS §3.1.14 asks for this; subscriptions are not built (see class doc).
      subscription_revenue: null,
    };
  }

  /** One row per day for a table with a created_at column. */
  private async dailyCounts(table: 'itinerary' | 'chat_session' | 'app_user', since: Date): Promise<DayCount[]> {
    // Table name is from a closed union above, never from user input. The day
    // comes back as a string so there is no Date -> ISO conversion that could
    // shift the key relative to the gap-fill below.
    const rows = await this.prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS count
         FROM ${table}
        WHERE created_at >= $1
        GROUP BY 1
        ORDER BY 1`,
      since,
    );
    return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
  }

  /** Approvals vs rejections per day, read back out of the audit log. */
  private async moderationByDay(since: Date) {
    const rows = await this.prisma.$queryRaw<{ day: string; action: string; count: bigint }[]>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, action, count(*) AS count
        FROM activity_log
       WHERE created_at >= ${since}
         AND action IN ('listing.verify', 'listing.reject', 'event.verify', 'event.reject')
       GROUP BY 1, 2
       ORDER BY 1`;
    const byDay = new Map<string, { day: string; approved: number; rejected: number }>();
    for (const r of rows) {
      const day = r.day;
      const entry = byDay.get(day) ?? { day, approved: 0, rejected: 0 };
      if (r.action.endsWith('.verify')) entry.approved += Number(r.count);
      else entry.rejected += Number(r.count);
      byDay.set(day, entry);
    }
    return this.fillPairs([...byDay.values()], since);
  }

  private async listingsByCategory() {
    const rows = await this.prisma.travel_listing.groupBy({
      by: ['category_id'],
      _count: { _all: true },
      where: { is_verified: true, is_active: true },
    });
    const categories = await this.prisma.category.findMany({ select: { id: true, name: true } });
    const names = new Map(categories.map((c) => [c.id, c.name]));
    return rows
      .map((r) => ({ label: names.get(r.category_id) ?? 'unknown', count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  private async listingsByDistrict() {
    const rows = await this.prisma.travel_listing.groupBy({
      by: ['district_id'],
      _count: { _all: true },
      where: { is_verified: true, is_active: true },
    });
    const districts = await this.prisma.district.findMany({ select: { id: true, name: true } });
    const names = new Map(districts.map((d) => [d.id, d.name]));
    return rows
      .map((r) => ({ label: names.get(r.district_id) ?? 'unknown', count: r._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N);
  }

  private async itineraryStatusMix() {
    const rows = await this.prisma.itinerary.groupBy({ by: ['status'], _count: { _all: true } });
    return rows.map((r) => ({ label: r.status, count: r._count._all })).sort((a, b) => b.count - a.count);
  }

  /** Who is generating the most trips - "other platform usage statistics". */
  private async topPlanners() {
    const rows = await this.prisma.itinerary.groupBy({
      by: ['user_id'],
      _count: { _all: true },
      orderBy: { _count: { user_id: 'desc' } },
      take: 5,
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.app_user.findMany({
      where: { id: { in: rows.map((r) => r.user_id) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      label: byId.get(r.user_id)?.name ?? byId.get(r.user_id)?.email ?? 'unknown',
      count: r._count._all,
    }));
  }

  /** Days with no rows must appear as 0, or the chart implies continuity. */
  private fill(rows: DayCount[], since: Date): DayCount[] {
    const found = new Map(rows.map((r) => [r.day, r.count]));
    return this.days(since).map((day) => ({ day, count: found.get(day) ?? 0 }));
  }

  private fillPairs(rows: { day: string; approved: number; rejected: number }[], since: Date) {
    const found = new Map(rows.map((r) => [r.day, r]));
    return this.days(since).map((day) => found.get(day) ?? { day, approved: 0, rejected: 0 });
  }

  /** The window's days as YYYY-MM-DD, in UTC to match the SQL above. */
  private days(since: Date): string[] {
    const out: string[] = [];
    for (let i = 0; i < TREND_DAYS; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
}
