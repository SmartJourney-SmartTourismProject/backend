import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller.js';
import { BudgetService } from './budget.service.js';
import { ExpensesController } from './expenses.controller.js';
import { TripExpensesController } from './trip-expenses.controller.js';

@Module({
  controllers: [TripExpensesController, ExpensesController, BudgetController],
  providers: [BudgetService],
})
export class BudgetModule {}
