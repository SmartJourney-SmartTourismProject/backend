import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNotEmpty, IsNumber, IsString, IsUUID, Length } from 'class-validator';
import { UpdateListingDto } from './update-listing.dto.js';

// An admin-created listing. Coordinates are required because `location` is
// NOT NULL and everything downstream (map, routing, distance scoring) needs
// them. source/external_ref are set by the service, not the client, so a
// hand-made row can never collide with an ingest job's upsert key.
export class CreateListingDto extends UpdateListingDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  declare name: string;

  @IsUUID()
  declare district_id: string;

  @IsUUID()
  declare category_id: string;

  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  longitude!: number;
}
