import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { EventsQueryDto } from './dto/events-query.dto.js';

@Controller('events')
export class EventsController {
  constructor(private readonly exploreService: ExploreService) {}

  @Get()
  search(@Query() query: EventsQueryDto) {
    return this.exploreService.searchEvents(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.exploreService.getEventById(id);
  }
}
