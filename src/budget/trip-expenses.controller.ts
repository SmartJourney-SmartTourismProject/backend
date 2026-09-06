import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
  listExpenses(@Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.budgetService.listExpenses(tripId);
  }

  @Post(':tripId/expenses')
  addExpense(@Param('tripId', ParseUUIDPipe) tripId: string, @Body() dto: CreateExpenseDto) {
    return this.budgetService.addExpense(tripId, dto);
  }

  @Get(':tripId/budget')
  getTripBudget(@Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.budgetService.getTripBudget(tripId);
  }
}
