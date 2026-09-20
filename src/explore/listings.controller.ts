import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { Public } from '../auth/index.js';
import { ListingsQueryDto } from './dto/listings-query.dto.js';

// Public per SRS §3.1.7 ("any user can explore"); reads stay filtered
// to verified rows inside ExploreService.
@Public()
@Controller('listings')
export class ListingsController {
  constructor(private readonly exploreService: ExploreService) {}

  @Get()
  search(@Query() query: ListingsQueryDto) {
    return this.exploreService.searchListings(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.exploreService.getListingById(id);
  }
}
