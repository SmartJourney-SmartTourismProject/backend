import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { BudgetController } from './budget.controller.js';
import { BudgetService } from './budget.service.js';
import { ExpensesController } from './expenses.controller.js';
import { TripExpensesController } from './trip-expenses.controller.js';

@Module({
  imports: [NotificationsModule],
  controllers: [TripExpensesController, ExpensesController, BudgetController],
  providers: [BudgetService],
})
export class BudgetModule {}
