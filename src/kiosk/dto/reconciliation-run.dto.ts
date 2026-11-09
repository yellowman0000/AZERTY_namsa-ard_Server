import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Largest baseline window the batch engine will accept (one year of days). */
export const MAX_RECONCILIATION_WINDOW = 365;

/**
 * Request body for `POST /api/kiosk/reconciliation/run` (Story ID 04).
 *
 * Every field is optional: an empty body reconciles every stored log. Dates
 * are ISO-8601 strings; a date-only value is interpreted at UTC boundaries
 * (`endDate`/`date` expand to the end of that UTC day, see the controller).
 */
export class RunReconciliationDto {
  /** Restrict the batch to a single kiosk (e.g. "KIOSK-001"). */
  @IsOptional()
  @IsString({ message: 'kioskId must be a string' })
  kioskId?: string;

  /** First day (inclusive) of the reconciliation period, e.g. "2026-10-01". */
  @IsOptional()
  @IsDateString(
    {},
    { message: 'startDate must be a valid ISO-8601 date string' },
  )
  startDate?: string;

  /**
   * Last day (inclusive) of the reconciliation period. A date-only value
   * covers the whole UTC day, e.g. "2026-10-31" ends at 23:59:59.999Z.
   */
  @IsOptional()
  @IsDateString({}, { message: 'endDate must be a valid ISO-8601 date string' })
  endDate?: string;

  /** Shorthand for a single whole UTC day, e.g. "2026-10-31". */
  @IsOptional()
  @IsDateString({}, { message: 'date must be a valid ISO-8601 date string' })
  date?: string;

  /** Number of previous daily logs used as the moving-average baseline. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'window must be an integer' })
  @Min(1, { message: 'window must be at least 1' })
  @Max(MAX_RECONCILIATION_WINDOW, {
    message: `window must not exceed ${MAX_RECONCILIATION_WINDOW}`,
  })
  window?: number;

  /** Price per litre override; defaults to the server-side WATER_UNIT_PRICE. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'unitPrice must be a number' })
  @IsPositive({ message: 'unitPrice must be positive' })
  unitPrice?: number;

  /** Compute and report the batch without persisting anything. */
  @IsOptional()
  @IsBoolean({ message: 'dryRun must be a boolean' })
  dryRun?: boolean;
}
