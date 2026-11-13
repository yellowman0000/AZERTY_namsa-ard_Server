import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

export const INVALID_MONTH_MESSAGE =
  'month must be in YYYY-MM format (e.g. 2026-10)';

const normaliseQueryString = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Query parameters for GET /api/kiosk/analytics/stakeholder (Story 09).
 */
export class StakeholderAnalyticsQueryDto {
  /** Target month in YYYY-MM format. If omitted, defaults to the current UTC month. */
  @Transform(normaliseQueryString)
  @IsOptional()
  @Matches(/^(\d{4})-(0[1-9]|1[0-2])$/, {
    message: INVALID_MONTH_MESSAGE,
  })
  month?: string;

  /** Optional kioskId filter. */
  @Transform(normaliseQueryString)
  @IsOptional()
  @IsString()
  kioskId?: string;
}
