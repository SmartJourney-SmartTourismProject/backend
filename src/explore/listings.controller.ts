import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { ListingsQueryDto } from './dto/listings-query.dto.js';

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
