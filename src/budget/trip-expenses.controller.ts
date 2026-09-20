import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { BudgetService } from './budget.service.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';

// Separate controller from TripsController (also @Controller('trips')) so
// the budget domain stays in its own module - NestJS allows this as long as
// the path+method combinations don't collide, and they don't (trip CRUD
// lives at '' / ':id'; this only adds ':tripId/expenses' and ':tripId/budget').
@Controller('trips')
export class TripExpensesController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get(':tripId/expenses')
  listExpenses(@CurrentUser('id') userId: string, @Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.budgetService.listExpenses(userId, tripId);
  }

  @Post(':tripId/expenses')
  addExpense(
    @CurrentUser('id') userId: string,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.budgetService.addExpense(userId, tripId, dto);
  }

  @Get(':tripId/budget')
  getTripBudget(@CurrentUser('id') userId: string, @Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.budgetService.getTripBudget(userId, tripId);
  }
}
