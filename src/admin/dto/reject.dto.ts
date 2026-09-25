import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectDto {
  // Free text, stored on the activity_log entry so a later reviewer can see
  // why something was refused. Optional - a rejection without a note is still
  // better than none.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
