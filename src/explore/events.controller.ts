import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ExploreService } from './explore.service.js';
import { Public } from '../auth/index.js';
import { EventsQueryDto } from './dto/events-query.dto.js';

// Public per SRS §3.1.7 ("any user can explore"); reads stay filtered
// to verified rows inside ExploreService.
@Public()
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
