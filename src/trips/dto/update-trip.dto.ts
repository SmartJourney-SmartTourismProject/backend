import { IsIn, IsOptional, IsString } from 'class-validator';

// Status vocabulary is not yet finalized project-wide (tracked in
// PROJECT_MASTER_PLAN.md) - "draft"/"upcoming"/"past" are the three tabs the
// Saved Itineraries mockup shows, so those are what's enforced for now.
const TRIP_STATUSES = ['draft', 'upcoming', 'past'] as const;

export class UpdateTripDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsIn(TRIP_STATUSES)
  status?: (typeof TRIP_STATUSES)[number];

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;
}
