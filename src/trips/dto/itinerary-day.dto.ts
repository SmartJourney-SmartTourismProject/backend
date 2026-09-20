import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { ItineraryItemDto } from './itinerary-item.dto.js';

export class ItineraryDayDto {
  @IsInt()
  @Min(1)
  day!: number;

  @IsOptional()
  @IsString()
  date?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => ItineraryItemDto)
  items!: ItineraryItemDto[];
}
