import { Body, Controller, Delete, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { BudgetService } from './budget.service.js';
import { UpdateExpenseDto } from './dto/update-expense.dto.js';

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly budgetService: BudgetService) {}

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseDto) {
    return this.budgetService.updateExpense(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.budgetService.deleteExpense(id);
  }
}
