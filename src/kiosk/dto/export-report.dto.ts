import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { DateRangeQueryDto } from './date-range.dto';

/** Query parameters for `GET /api/kiosk/reports/export` (Story 07). */
export class ExportReportQueryDto extends DateRangeQueryDto {
  /** Target export file format: 'csv' or 'pdf'. Defaults to 'csv'. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['csv', 'pdf'], {
    message: 'format must be "csv" or "pdf"',
  })
  format?: 'csv' | 'pdf';

  /** Optional kioskId filter. */
  @IsOptional()
  @IsString()
  kioskId?: string;
}
