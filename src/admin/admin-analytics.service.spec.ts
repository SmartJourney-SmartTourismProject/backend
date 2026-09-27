import { AdminAnalyticsService } from './admin-analytics.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makePrisma() {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $queryRaw: vi.fn().mockResolvedValue([]),
    travel_listing: { groupBy: vi.fn().mockResolvedValue([]) },
    category: { findMany: vi.fn().mockResolvedValue([]) },
    district: { findMany: vi.fn().mockResolvedValue([]) },
    itinerary: { groupBy: vi.fn().mockResolvedValue([]) },
    app_user: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('AdminAnalyticsService.getAnalytics', () => {
  it('gap-fills every day of the trend window with 0 instead of skipping quiet days', async () => {
    const prisma = makePrisma();
    const service = new AdminAnalyticsService(prisma as unknown as PrismaService);

    const result = await service.getAnalytics();

    expect(result.trends.itineraries).toHaveLength(30);
    expect(result.trends.itineraries.every((d) => d.count === 0)).toBe(true);
    expect(result.range.days).toBe(30);
  });

  it('reports subscription_revenue as null rather than inventing a number', async () => {
    const prisma = makePrisma();
    const service = new AdminAnalyticsService(prisma as unknown as PrismaService);

    const result = await service.getAnalytics();

    expect(result.subscription_revenue).toBeNull();
  });
});
