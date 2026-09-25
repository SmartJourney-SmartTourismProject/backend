import { IsBoolean, IsIn, IsOptional } from 'class-validator';

// Both fields are written to Keycloak first (it owns identity) and mirrored
// into app_user - see AdminUsersService. Changing them here only would be
// undone by the next JIT sync, which reads the token.
export class AdminUpdateUserDto {
  @IsOptional()
  @IsIn(['traveler', 'admin'])
  role?: 'traveler' | 'admin';

  /** false disables the Keycloak account, so the user can no longer sign in. */
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
