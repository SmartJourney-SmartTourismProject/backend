import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { UpdateExpenseDto } from './dto/update-expense.dto.js';

type BudgetStatus = 'on_track' | 'watch' | 'over_budget' | 'no_budget';

// Thresholds match the three status badges the Budget Tracker mockup shows
// (ON TRACK / WATCH / OVER BUDGET) - a judgment call in the absence of a
// spec'd number, not derived from anything in BACKEND_PLAN.md.
const WATCH_THRESHOLD = 0.8;

function toNumber(decimal: unknown): number {
  return decimal == null ? 0 : Number(decimal);
}

function computeStatus(budget: number | null, spent: number): BudgetStatus {
  if (budget == null || budget === 0) return 'no_budget';
  if (spent >= budget) return 'over_budget';
  if (spent >= budget * WATCH_THRESHOLD) return 'watch';
  return 'on_track';
}

@Injectable()
export class BudgetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ownership check shared by every route here - a user may only touch
   * expenses on their own itineraries. NotFoundException (not Forbidden),
   * matching the pattern already used in chat/trips. */
  private async getOwnedItinerary(userId: string, tripId: string) {
    const itinerary = await this.prisma.itinerary.findFirst({
      where: { id: tripId, user_id: userId },
      select: {
        id: true,
        title: true,
        budget: true,
        estimated_cost: true,
        currency: true,
        district: { select: { name: true } },
      },
    });
    if (!itinerary) {
      throw new NotFoundException(`Trip ${tripId} not found`);
    }
    return itinerary;
  }

  private async getOwnedExpense(userId: string, expenseId: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id: expenseId, itinerary: { user_id: userId } },
    });
    if (!expense) {
      throw new NotFoundException(`Expense ${expenseId} not found`);
    }
    return expense;
  }

  async listExpenses(userId: string, tripId: string) {
    await this.getOwnedItinerary(userId, tripId);
    return this.prisma.expense.findMany({
      where: { itinerary_id: tripId },
      orderBy: { occurred_at: 'desc' },
    });
  }

  async addExpense(userId: string, tripId: string, dto: CreateExpenseDto) {
    await this.getOwnedItinerary(userId, tripId);
    return this.prisma.expense.create({
      data: {
        itinerary_id: tripId,
        category: dto.category,
        amount: dto.amount,
        currency: dto.currency ?? 'LKR',
        description: dto.description ?? null,
        ...(dto.occurred_at && { occurred_at: new Date(dto.occurred_at) }),
      },
    });
  }

  async updateExpense(userId: string, expenseId: string, dto: UpdateExpenseDto) {
    await this.getOwnedExpense(userId, expenseId);
    return this.prisma.expense.update({
      where: { id: expenseId },
      data: {
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.occurred_at !== undefined && { occurred_at: new Date(dto.occurred_at) }),
      },
    });
  }

  async deleteExpense(userId: string, expenseId: string) {
    await this.getOwnedExpense(userId, expenseId);
    await this.prisma.expense.delete({ where: { id: expenseId } });
    return { deleted: true };
  }

  async getTripBudget(userId: string, tripId: string) {
    const itinerary = await this.getOwnedItinerary(userId, tripId);

    const [spentAgg, byCategory, plannedDays] = await Promise.all([
      this.prisma.expense.aggregate({
        where: { itinerary_id: tripId },
        _sum: { amount: true },
      }),
      this.prisma.expense.groupBy({
        by: ['category'],
        where: { itinerary_id: tripId },
        _sum: { amount: true },
      }),
      this.prisma.itinerary_day.count({ where: { itinerary_id: tripId } }),
    ]);

    const spent = toNumber(spentAgg._sum.amount);
    const budgetTotal = itinerary.budget != null ? toNumber(itinerary.budget) : itinerary.estimated_cost != null ? toNumber(itinerary.estimated_cost) : null;
    const remaining = budgetTotal != null ? budgetTotal - spent : null;
    const dailyAverage = plannedDays > 0 ? spent / plannedDays : spent;

    return {
      trip: {
        id: itinerary.id,
        title: itinerary.title ?? itinerary.district?.name ?? null,
        budget: itinerary.budget != null ? toNumber(itinerary.budget) : null,
        estimated_cost: itinerary.estimated_cost != null ? toNumber(itinerary.estimated_cost) : null,
        currency: itinerary.currency,
      },
      total: budgetTotal,
      spent,
      remaining,
      daily_average: dailyAverage,
      planned_days: plannedDays,
      status: computeStatus(budgetTotal, spent),
      by_category: byCategory.map((row) => ({
        category: row.category,
        amount: toNumber(row._sum.amount),
        percentage: spent > 0 ? Math.round((toNumber(row._sum.amount) / spent) * 100) : 0,
      })),
    };
  }

  /** Powers the "Budgets by trip" panel - one query for all of the user's
   * trips' spend, not N+1. */
  async getAllTripsSummary(userId: string) {
    const itineraries = await this.prisma.itinerary.findMany({
      where: { user_id: userId },
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        title: true,
        budget: true,
        estimated_cost: true,
        currency: true,
        district: { select: { name: true } },
      },
    });
    if (itineraries.length === 0) return [];

    const spentByTrip = await this.prisma.expense.groupBy({
      by: ['itinerary_id'],
      where: { itinerary_id: { in: itineraries.map((i) => i.id) } },
      _sum: { amount: true },
    });
    const spentMap = new Map(spentByTrip.map((row) => [row.itinerary_id, toNumber(row._sum.amount)]));

    return itineraries.map((itinerary) => {
      const spent = spentMap.get(itinerary.id) ?? 0;
      const budgetTotal =
        itinerary.budget != null
          ? toNumber(itinerary.budget)
          : itinerary.estimated_cost != null
            ? toNumber(itinerary.estimated_cost)
            : null;
      return {
        id: itinerary.id,
        title: itinerary.title ?? itinerary.district?.name ?? null,
        budget: budgetTotal,
        currency: itinerary.currency,
        spent,
        status: computeStatus(budgetTotal, spent),
      };
    });
  }
}
