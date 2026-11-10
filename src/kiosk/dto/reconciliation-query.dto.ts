import { IsOptional, IsString } from 'class-validator';
import { DateRangeQueryDto } from './date-range.dto';

/**
 * Query for `GET /api/kiosk/reconciliation` (Story 04 records + Story 06 date
 * filters). `isAnomaly` is parsed by the controller so it keeps its own
 * `"true" | "false"` error message.
 */
export class ReconciliationQueryDto extends DateRangeQueryDto {
  /** Only return records for this kiosk. */
  @IsOptional()
  @IsString()
  kioskId?: string;

  /** `true` or `false`; parsed by the controller. */
  @IsOptional()
  @IsString()
  isAnomaly?: string;
}
