import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class EventsQueryDto {
  @IsOptional()
  @IsUUID()
  district?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
