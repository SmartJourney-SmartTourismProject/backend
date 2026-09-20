import { Controller, Get } from '@nestjs/common';
import { ExploreService } from './explore.service.js';

@Controller('districts')
export class DistrictsController {
  constructor(private readonly exploreService: ExploreService) {}

  @Get()
  findAll() {
    return this.exploreService.getDistricts();
  }
}
