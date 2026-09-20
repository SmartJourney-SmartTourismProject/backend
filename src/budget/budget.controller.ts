import { Controller, Get } from '@nestjs/common';
import { BudgetService } from './budget.service.js';

@Controller('budget')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Get('summary')
  getSummary() {
    return this.budgetService.getAllTripsSummary();
  }
}
