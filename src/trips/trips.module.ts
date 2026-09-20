import { Module } from '@nestjs/common';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

@Module({
  controllers: [TripsController],
  providers: [TripsService],
})
export class TripsModule {}
