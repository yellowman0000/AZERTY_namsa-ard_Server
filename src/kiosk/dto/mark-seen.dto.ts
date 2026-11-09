import { IsArray, IsDateString, IsOptional, IsString } from 'class-validator';

/** Payload for `PATCH /api/kiosk/logs/mark-seen` (Story 08). */
export class MarkSeenDto {
  /** Array of dailyLog IDs to mark as seen. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  logIds?: string[];

  /** Alias for logIds. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];

  /** Single dailyLog ID to mark as seen. */
  @IsOptional()
  @IsString()
  logId?: string;

  /** Single dailyLog ID (alias). */
  @IsOptional()
  @IsString()
  id?: string;

  /** Kiosk ID to mark logs as seen for. */
  @IsOptional()
  @IsString()
  kioskId?: string;

  /** Optional timestamp: mark logs recorded at or before this date. */
  @IsOptional()
  @IsDateString({}, { message: 'upTo must be a valid ISO-8601 date string' })
  upTo?: string;

  /** Optional manager ID tracking who marked the logs as seen. */
  @IsOptional()
  @IsString()
  managerId?: string;
}
