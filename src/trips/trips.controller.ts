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
import { SaveTripDto } from './dto/save-trip.dto.js';
import { TripsQueryDto } from './dto/trips-query.dto.js';
import { UpdateTripDto } from './dto/update-trip.dto.js';
import { TripsService } from './trips.service.js';

@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  save(@Body() dto: SaveTripDto) {
    return this.tripsService.saveTrip(dto);
  }

  @Get()
  findAll(@Query() query: TripsQueryDto) {
    return this.tripsService.listTrips(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tripsService.getTripById(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTripDto) {
    return this.tripsService.updateTrip(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tripsService.deleteTrip(id);
  }
}
