import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { DateRangeQueryDto } from './date-range.dto';

export const DEFAULT_LOG_PAGE_SIZE = 20;
export const MAX_LOG_PAGE_SIZE = 100;

/** Query for `GET /api/kiosk/logs` – newest first, cursor-paginated. */
export class ListLogsQueryDto extends DateRangeQueryDto {
  /** Only return logs from this kiosk. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kioskId?: string;

  /** `nextCursor` from the previous page (a log ID). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(MAX_LOG_PAGE_SIZE, {
    message: `limit must not exceed ${MAX_LOG_PAGE_SIZE}`,
  })
  limit?: number;

  /** Filter unread dashboard logs when true (Story 08). */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true || value === 1 || value === '1')
      return true;
    if (value === 'false' || value === false || value === 0 || value === '0')
      return false;
    return value;
  })
  @IsBoolean({ message: 'unseenOnly must be a boolean' })
  unseenOnly?: boolean;
}
