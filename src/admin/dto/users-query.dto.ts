import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AdminUsersQueryDto {
  /** Matches email or name, case-insensitive. */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(['traveler', 'admin'])
  role?: 'traveler' | 'admin';

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;
}
