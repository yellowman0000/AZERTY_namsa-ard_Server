import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional body for `POST /api/kiosk/logs/:id/accept`. */
export class AcceptReceiptDto {
  /** Who accepted the receipt (stored on the log for the audit trail). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  managerId?: string;
}
