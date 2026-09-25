import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

// The three states the admin panel filters by. They map onto the
// is_verified / is_active pair rather than a status column, because the
// ingest jobs (AI backend) own these rows too and only ever write the
// content columns - see db/migrations/0008_event_is_active.sql.
export const MODERATION_STATES = ['pending', 'approved', 'rejected'] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

export class ModerationQueryDto {
  @IsOptional()
  @IsIn(MODERATION_STATES)
  status?: ModerationState;

  @IsOptional()
  @IsUUID()
  district?: string;

  @IsOptional()
  @IsUUID()
  category?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;
}
