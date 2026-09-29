import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

// Only the fields an admin should curate by hand. Deliberately not editable:
// - source / external_ref: the ingest job's identity for the row (upsert key)
// - is_verified / is_active: moved through the verify & reject endpoints, so
//   every state change goes through activity_log
// - latitude / longitude: generated from `location` by Postgres
export class UpdateListingDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @IsOptional()
  @IsUUID()
  district_id?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  // Bounded deliberately: an unbounded string[] lets one request write an
  // arbitrary amount of data into the row.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  tags?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  price_level?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price_per_night?: number | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code, e.g. LKR' })
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number | null;

  // http(s) only. A bare @IsString() would accept `javascript:...` or a
  // `data:text/html,...` URI, which becomes stored XSS the moment the value is
  // rendered into an href rather than an <img src>.
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  photo_url?: string | null;

  @IsOptional()
  @IsBoolean()
  has_public_transit?: boolean;
}
