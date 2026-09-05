import { IsNumber } from 'class-validator';

export class ClientGpsDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lon!: number;
}
