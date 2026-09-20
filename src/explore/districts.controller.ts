import { Controller, Get } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { Public } from '../auth/index.js';

// Public per SRS §3.1.7 ("any user can explore"); reads stay filtered
// to verified rows inside ExploreService.
@Public()
@Controller('districts')
export class DistrictsController {
  constructor(private readonly exploreService: ExploreService) {}

  @Get()
  findAll() {
    return this.exploreService.getDistricts();
  }
}
