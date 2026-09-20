import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { BudgetService } from './budget.service.js';

@Controller('budget')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get('summary')
  getSummary(@CurrentUser('id') userId: string) {
    return this.budgetService.getAllTripsSummary(userId);
  }
}
