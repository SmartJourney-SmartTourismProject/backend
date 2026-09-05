import { IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class ItineraryItemDto {
  @IsOptional()
  @IsString()
  time?: string;

  @IsString()
  @MinLength(1)
  type!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsNumber()
  lat!: number;

  @IsNumber()
  lon!: number;
}
