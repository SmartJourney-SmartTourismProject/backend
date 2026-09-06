import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';

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

  // Chat-saved trips never get one (TripPlanResponse only returns
  // estimated_cost, not the budget the traveler asked for) - this is what
  // lets the Budget Tracker have a real target to track against.
  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;
}
