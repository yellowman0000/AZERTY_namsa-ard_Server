import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';

/** Query parameters for `GET /api/kiosk/reports/export` (Story 07). */
export class ExportReportQueryDto {
  /** Target export file format: 'csv' or 'pdf'. Defaults to 'csv'. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['csv', 'pdf'], {
    message: 'format must be "csv" or "pdf"',
  })
  format?: 'csv' | 'pdf';

  /** ISO-8601 start date string (e.g. 2026-10-01). */
  @IsOptional()
  @IsString()
  startDate?: string;

  /** ISO-8601 end date string (e.g. 2026-10-31). */
  @IsOptional()
  @IsString()
  endDate?: string;

  /** Optional kioskId filter. */
  @IsOptional()
  @IsString()
  kioskId?: string;
}
