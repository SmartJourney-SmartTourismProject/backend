import { IsBoolean, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

// Identity fields (name, email) are Keycloak's: the JIT sync mirrors them
// from the token on every request, so anything written here would be
// overwritten within minutes. Users change those in Keycloak's account
// console. This DTO is only the app-level extras the token doesn't carry.
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsBoolean()
  location_enabled?: boolean;

  // A small inline image (the web app downsizes it before upload); null
  // removes it. Limited to raster data URLs so nothing else is stored here.
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @MaxLength(60000)
  @Matches(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, {
    message: 'avatar_url must be a base64 jpeg, png or webp data URL',
  })
  avatar_url?: string | null;
}
