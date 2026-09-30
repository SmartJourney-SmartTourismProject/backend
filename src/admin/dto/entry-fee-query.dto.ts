import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

// listing_entry_fee has a real status column (unlike travel_listing/
// local_event's is_verified+is_active pair, db/migrations/0012) - no
// stateFilter() translation needed, so this mirrors ModerationQueryDto's
// shape without importing its is_verified/is_active-specific helpers.
export const ENTRY_FEE_STATES = ['pending', 'approved', 'rejected'] as const;
export type EntryFeeState = (typeof ENTRY_FEE_STATES)[number];

export class EntryFeeQueryDto {
  @IsOptional()
  @IsIn(ENTRY_FEE_STATES)
  status?: EntryFeeState;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;
}

export class RelinkEntryFeeDto {
  // Nullable: an admin can also unlink a wrong auto-match without approving
  // or rejecting the fee itself.
  @IsOptional()
  @IsUUID()
  listing_id?: string | null;
}
