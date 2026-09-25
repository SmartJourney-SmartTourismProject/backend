import { IsDateString, IsNotEmpty, IsString, IsUUID, Length } from 'class-validator';
import { UpdateEventDto } from './update-event.dto.js';

export class CreateEventDto extends UpdateEventDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  declare name: string;

  @IsUUID()
  declare district_id: string;

  @IsDateString()
  declare start_datetime: string;
}
