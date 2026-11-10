import { Transform } from 'class-transformer';
import {
  IsOptional,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';

export const DATE_RANGE_ORDER_MESSAGE = 'startDate must not be after endDate';
export const INVALID_START_DATE = 'startDate must be a valid ISO-8601 date string';
export const INVALID_END_DATE = 'endDate must be a valid ISO-8601 date string';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * True for `YYYY-MM-DD` and full ISO-8601 timestamps. A date-only value is
 * checked against the calendar, so `2026-02-31` is rejected instead of silently
 * becoming 3 March.
 */
export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day)),
    );
    return (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
    );
  }

  return ISO_DATETIME.test(trimmed) && !Number.isNaN(new Date(trimmed).getTime());
}

/** Treats `?startDate=` as "not supplied" and trims surrounding spaces. */
const normaliseQueryDate = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

@ValidatorConstraint({ name: 'isoDate', async: false })
export class IsIsoDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isIsoDate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid ISO-8601 date string`;
  }
}

/**
 * True when both bounds parse and the range is ordered. A single bound (or an
 * unparsable one) is left to the format validators.
 */
export function datesAreOrdered(
  startDate?: string,
  endDate?: string,
): boolean {
  if (!startDate || !endDate) return true;
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return true;
  return start <= end;
}

@ValidatorConstraint({ name: 'dateRangeOrder', async: false })
export class DateRangeOrderConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const query = args.object as { startDate?: string; endDate?: string };
    return datesAreOrdered(query.startDate, query.endDate);
  }

  defaultMessage(): string {
    return DATE_RANGE_ORDER_MESSAGE;
  }
}

/**
 * Query fields shared by the metrics endpoints (Story 06): `startDate` and
 * `endDate` are validated as ISO-8601 here, and the range is rejected at the
 * DTO boundary when `startDate > endDate` (HTTP 400).
 */
export class DateRangeQueryDto {
  /** Inclusive lower bound on `recordedAt`, e.g. `2026-11-01`. */
  @Transform(normaliseQueryDate)
  @IsOptional()
  @Validate(IsIsoDateConstraint, { message: INVALID_START_DATE })
  startDate?: string;

  /** Inclusive upper bound on `recordedAt`; a date-only value covers that day. */
  @Transform(normaliseQueryDate)
  @IsOptional()
  @Validate(IsIsoDateConstraint, { message: INVALID_END_DATE })
  @Validate(DateRangeOrderConstraint)
  endDate?: string;
}
