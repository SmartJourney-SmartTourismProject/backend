import { Type } from 'class-transformer';
import { IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { ClientGpsDto } from './client-gps.dto.js';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ClientGpsDto)
  client_gps?: ClientGpsDto;
}
