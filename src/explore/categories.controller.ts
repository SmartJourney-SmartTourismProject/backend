import { Controller, Get } from '@nestjs/common';
import { ExploreService } from './explore.service.js';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly exploreService: ExploreService) {}

  @Get()
  findAll() {
    return this.exploreService.getCategories();
  }
}
