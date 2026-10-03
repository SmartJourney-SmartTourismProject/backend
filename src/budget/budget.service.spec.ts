import { NotFoundException } from '@nestjs/common';
import { BudgetService } from './budget.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';

const NOTIFICATIONS = { budgetChanged: vi.fn().mockResolvedValue(false) } as unknown as NotificationsService;

function makePrisma() {
  return {
    itinerary: { findFirst: vi.fn(), findMany: vi.fn() },
    expense: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
    itinerary_day: { count: vi.fn() },
  };
}

const OWNED_TRIP = { id: 'trip-1', title: 'Kandy trip', budget: null, estimated_cost: null, currency: 'LKR', district: null };

describe('BudgetService ownership', () => {
  it('every read/write throws NotFound for a trip/expense that belongs to someone else', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(null);
    prisma.expense.findFirst.mockResolvedValue(null);
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await expect(service.listExpenses('user-1', 'foreign-trip')).rejects.toThrow(NotFoundException);
    await expect(service.getTripBudget('user-1', 'foreign-trip')).rejects.toThrow(NotFoundException);
    await expect(service.updateExpense('user-1', 'foreign-expense', {})).rejects.toThrow(NotFoundException);
    await expect(service.deleteExpense('user-1', 'foreign-expense')).rejects.toThrow(NotFoundException);
  });
});

describe('BudgetService.addExpense', () => {
  it('defaults currency to LKR and description to null', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue(OWNED_TRIP);
    prisma.expense.create.mockResolvedValue({ id: 'exp-1' });
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.addExpense('user-1', 'trip-1', { category: 'food', amount: 500 });

    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ itinerary_id: 'trip-1', category: 'food', amount: 500, currency: 'LKR', description: null }),
    });
  });
});

describe('BudgetService.updateExpense', () => {
  it('omits fields that were not provided, rather than nulling them out', async () => {
    const prisma = makePrisma();
    prisma.expense.findFirst.mockResolvedValue({ id: 'exp-1' });
    prisma.expense.update.mockResolvedValue({ id: 'exp-1' });
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    await service.updateExpense('user-1', 'exp-1', { amount: 750 });

    const { data } = prisma.expense.update.mock.calls[0][0];
    expect(data).toEqual({ amount: 750 });
  });
});

describe('BudgetService.getTripBudget', () => {
  function setup(overrides: { budget?: number | null; estimated_cost?: number | null; spent?: number; plannedDays?: number } = {}) {
    const prisma = makePrisma();
    prisma.itinerary.findFirst.mockResolvedValue({
      ...OWNED_TRIP,
      budget: overrides.budget ?? null,
      estimated_cost: overrides.estimated_cost ?? null,
    });
    prisma.expense.aggregate.mockResolvedValue({ _sum: { amount: overrides.spent ?? 0 } });
    prisma.expense.groupBy.mockResolvedValue([]);
    prisma.itinerary_day.count.mockResolvedValue(overrides.plannedDays ?? 0);
    return prisma;
  }

  it('reports no_budget when neither budget nor estimated_cost is set', async () => {
    const prisma = setup({ spent: 100 });
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getTripBudget('user-1', 'trip-1');

    expect(result.total).toBeNull();
    expect(result.status).toBe('no_budget');
  });

  it('falls back to estimated_cost when budget is not set', async () => {
    const prisma = setup({ estimated_cost: 1000, spent: 100 });
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getTripBudget('user-1', 'trip-1');

    expect(result.total).toBe(1000);
    expect(result.remaining).toBe(900);
  });

  it('reports on_track, watch, and over_budget at the right thresholds', async () => {
    const service = new BudgetService(setup({ budget: 1000, spent: 500 }) as unknown as PrismaService, NOTIFICATIONS);
    expect((await service.getTripBudget('user-1', 'trip-1')).status).toBe('on_track');

    const watchService = new BudgetService(setup({ budget: 1000, spent: 850 }) as unknown as PrismaService, NOTIFICATIONS);
    expect((await watchService.getTripBudget('user-1', 'trip-1')).status).toBe('watch');

    const overService = new BudgetService(setup({ budget: 1000, spent: 1000 }) as unknown as PrismaService, NOTIFICATIONS);
    expect((await overService.getTripBudget('user-1', 'trip-1')).status).toBe('over_budget');
  });

  it('uses total spend (not per-day) as the daily average when no days are planned', async () => {
    const prisma = setup({ budget: 1000, spent: 300, plannedDays: 0 });
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getTripBudget('user-1', 'trip-1');

    expect(result.daily_average).toBe(300);
  });

  it('divides spend across planned days when there are any', async () => {
    const prisma = setup({ budget: 1000, spent: 300, plannedDays: 3 });
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getTripBudget('user-1', 'trip-1');

    expect(result.daily_average).toBe(100);
  });

  it('computes by_category percentages against total spend, and 0% when nothing was spent', async () => {
    const prisma = setup({ budget: 1000, spent: 0 });
    prisma.expense.groupBy.mockResolvedValue([{ category: 'food', _sum: { amount: 0 } }]);
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getTripBudget('user-1', 'trip-1');

    expect(result.by_category).toEqual([{ category: 'food', amount: 0, percentage: 0 }]);
  });
});

describe('BudgetService.getAllTripsSummary', () => {
  it('returns [] without querying expenses when the user has no trips', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findMany.mockResolvedValue([]);
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getAllTripsSummary('user-1');

    expect(result).toEqual([]);
    expect(prisma.expense.groupBy).not.toHaveBeenCalled();
  });

  it('fetches every trip owner spend in one groupBy, not one query per trip', async () => {
    const prisma = makePrisma();
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 'trip-1', title: 'A', budget: 1000, estimated_cost: null, currency: 'LKR', district: null },
      { id: 'trip-2', title: 'B', budget: null, estimated_cost: null, currency: 'LKR', district: null },
    ]);
    prisma.expense.groupBy.mockResolvedValue([{ itinerary_id: 'trip-1', _sum: { amount: 200 } }]);
    const service = new BudgetService(prisma as unknown as PrismaService, NOTIFICATIONS);

    const result = await service.getAllTripsSummary('user-1');

    expect(prisma.expense.groupBy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { id: 'trip-1', title: 'A', budget: 1000, currency: 'LKR', spent: 200, status: 'on_track' },
      { id: 'trip-2', title: 'B', budget: null, currency: 'LKR', spent: 0, status: 'no_budget' },
    ]);
  });
});
