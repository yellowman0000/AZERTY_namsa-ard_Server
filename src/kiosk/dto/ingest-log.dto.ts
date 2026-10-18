import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsDateString,
  IsOptional,
} from 'class-validator';

/**
 * DTO for ingesting a daily log / meter-volume reading from a kiosk.
 *
 * Validated automatically by NestJS's global ValidationPipe.
 */
export class IngestLogDto {
  /** Unique transaction ID – used for idempotency checks. */
  @IsString()
  @IsNotEmpty({ message: 'transactionId is required' })
  transactionId!: string;

  /** ID of the kiosk that produced the reading (e.g. "KIOSK-001"). */
  @IsString()
  @IsNotEmpty({ message: 'kioskId is required' })
  kioskId!: string;

  /** Meter volume reading – must be a positive number. */
  @IsNumber({}, { message: 'meterVolume must be a number' })
  @IsPositive({ message: 'meterVolume must be positive' })
  meterVolume!: number;

  /** ISO-8601 timestamp of when the reading was recorded on the kiosk. */
  @IsDateString({}, { message: 'recordedAt must be a valid ISO-8601 date string' })
  @IsNotEmpty({ message: 'recordedAt is required' })
  recordedAt!: string;

  /** Optional SHA-256 checksum for data-integrity verification (Story 14-2). */
  @IsOptional()
  @IsString()
  checksum?: string;
}
