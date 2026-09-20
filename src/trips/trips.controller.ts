import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { SaveTripDto } from './dto/save-trip.dto.js';
import { TripsQueryDto } from './dto/trips-query.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { TripsService } from './trips.service.js';

@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  save(@CurrentUser('id') userId: string, @Body() dto: SaveTripDto) {
    return this.tripsService.saveTrip(userId, dto);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string, @Query() query: TripsQueryDto) {
    return this.tripsService.listTrips(userId, query);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tripsService.getTripById(userId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTripDto,
  ) {
    return this.tripsService.updateTrip(userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tripsService.deleteTrip(userId, id);
  }
}
