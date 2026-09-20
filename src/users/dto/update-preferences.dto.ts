import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

// Matches the comment on traveler_profile.travel_style in
// db/migrations/0002_identity_planning.sql and what the AI backend's
// planner expects.
export const TRAVEL_STYLES = ['budget', 'balanced', 'luxury'] as const;

export class UpdatePreferencesDto {
  // Each entry must be a tag_vocabulary.tag - checked against the DB in
  // UsersService (the vocabulary is data, not code, see GET /tags), so a
  // typo can't silently neutralise the recommendation scorer
  // (docs/BACKEND_ALIGNMENT.md §4).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  travel_interests?: string[];

  @IsOptional()
  @IsIn(TRAVEL_STYLES)
  travel_style?: (typeof TRAVEL_STYLES)[number] | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  default_budget?: number | null;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;
}
