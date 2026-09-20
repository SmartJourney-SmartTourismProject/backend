import { IsIn, IsOptional } from 'class-validator';

const TRIP_STATUSES = ['draft', 'upcoming', 'past'] as const;

export class TripsQueryDto {
  @IsOptional()
  @IsIn(TRIP_STATUSES)
  status?: (typeof TRIP_STATUSES)[number];
}
