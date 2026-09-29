import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * The rows an admin is approving in one action.
 *
 * Ids are explicit rather than "verify everything matching this filter" on
 * purpose: the admin approves the rows they are actually looking at, so the
 * review gate still means something. A filter-based bulk verify would let one
 * click approve thousands of rows nobody has seen - which is exactly what
 * `is_verified` exists to prevent.
 */
export class BulkVerifyDto {
  @IsArray()
  @ArrayNotEmpty()
  // One screenful is 20 rows; 100 leaves room without turning this into a
  // "verify the whole table" endpoint by another name.
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}
