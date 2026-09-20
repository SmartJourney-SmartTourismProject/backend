import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
