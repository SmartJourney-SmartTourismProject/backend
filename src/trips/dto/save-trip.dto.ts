import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { ItineraryDayDto } from './itinerary-day.dto.js';

export class SaveTripDto {
  @IsOptional()
  @IsString()
  title?: string;

  // The chat message the itinerary card was rendered from. Lets the save be
  // idempotent (re-clicking "Save itinerary" on the same card, e.g. after a
  // refresh, returns the existing trip instead of creating a duplicate) - see
  // itinerary.chat_message_id's unique constraint.
  @IsOptional()
  @IsUUID()
  chat_message_id?: string;

  // Free-text place name from the AI backend's `destination` field (e.g.
  // "Kandy") - resolved against `district.name` (e.g. "Kandy District") on
  // a best-effort basis. Left unresolved (district_id stays null) rather
  // than guessing, matching this project's established degrade-gracefully
  // pattern (see ai-backend's own district resolution).
  @IsOptional()
  @IsString()
  destination?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  travelers?: number;

  @IsOptional()
  @IsNumber()
  budget?: number;

  @IsOptional()
  @IsNumber()
  estimated_cost?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ItineraryDayDto)
  itinerary!: ItineraryDayDto[];
}
