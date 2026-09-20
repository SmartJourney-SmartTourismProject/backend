import { Body, Controller, Delete, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { BudgetService } from './budget.service.js';
import { UpdateExpenseDto } from './dto/update-expense.dto.js';

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly budgetService: BudgetService) {}

  @Patch(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.budgetService.updateExpense(userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgetService.deleteExpense(userId, id);
  }
}
