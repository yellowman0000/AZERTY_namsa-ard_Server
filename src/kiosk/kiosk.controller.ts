import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
  BadRequestException,
  Optional,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { KioskService } from './kiosk.service';
import { ReconciliationService } from './reconciliation.service';
import { IngestLogDto } from './dto/ingest-log.dto';
import { MarkSeenDto } from './dto/mark-seen.dto';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import { RunReconciliationDto } from './dto/reconciliation-run.dto';
import {
  calculateReconciliation,
  resolveUnitPrice,
} from './reconciliation';
import { ANOMALY_THRESHOLD } from './volume-anomaly';

const MAX_EVIDENCE_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_EVIDENCE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Controller(['api/kiosk', 'kiosk', 'api', ''])
export class KioskController {
  constructor(
    private readonly kioskService: KioskService,
    // Optional so light-weight controller unit tests can instantiate the
    // controller without the batch engine; KioskModule always provides it.
    @Optional()
    private readonly reconciliationService?: ReconciliationService,
  ) {}

  // ───────────────────────────────────────────────────────────
  //  Story 02 – Ingest daily-log / meter-volume
  //  POST /api/kiosk/logs (or /daily-submission)
  //
  //  Story 14-3 – answers with a server ACK (see `sync-ack.ts`):
  //  201 for a new record, 200 when re-acknowledging a stored one.
  //  Returns tamper-evident signed receipt with SHA-256 checksum.
  // ───────────────────────────────────────────────────────────

  @Post(['logs', 'daily-submission'])
  async ingestLog(
    @Body() dto: IngestLogDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ack = await this.kioskService.ingestLog(dto);
    if (ack.duplicate) res.status(HttpStatus.OK);
    return ack;
  }

  @Post('logs/:transactionId/evidence')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_EVIDENCE_FILE_SIZE, files: 1 },
      fileFilter: (_request, file, callback) => {
        if (!ALLOWED_EVIDENCE_TYPES.has(file.mimetype)) {
          callback(
            new BadRequestException(
              'Evidence must be a JPEG, PNG, or WebP image.',
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  async uploadEvidence(
    @Param('transactionId') transactionId: string,
    @UploadedFile()
    file:
      { buffer: Buffer; mimetype: string; originalname: string } | undefined,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Attach an image file in the "file" field.',
      );
    }

    return this.kioskService.uploadEvidence(transactionId, file);
  }

  // ───────────────────────────────────────────────────────────
  //  Story 08 – Mark unseen logs as seen by Operation Manager
  //  PATCH /api/kiosk/logs/mark-seen
  // ───────────────────────────────────────────────────────────

  @Patch(['logs/mark-seen', 'mark-seen'])
  async markSeen(@Body() dto?: MarkSeenDto) {
    return this.kioskService.markLogsAsSeen(dto);
  }

  // ───────────────────────────────────────────────────────────
  //  Story 04 – Get interpreted daily-log records
  //  GET /api/kiosk/reconciliation
  //
  //  Optional query params:
  //    kioskId     e.g. KIOSK-001
  //    isAnomaly   true | false
  //    startDate   ISO-8601 (2026-11-01 or 2026-11-01T00:00:00Z)
  //    endDate     ISO-8601 (a date-only value includes the whole day)
  //
  //  Every record is enriched with server-computed discrepancy metrics
  //  (never the stored/client-supplied revenue values) and the response
  //  advertises the effective unit price and anomaly threshold.
  // ───────────────────────────────────────────────────────────

  @Get('reconciliation')
  async getReconciliation(@Query() query: ReconciliationQueryDto) {
    // `startDate`/`endDate` format and ordering are enforced by the DTO;
    // parseDate still converts them and widens a date-only endDate.
    const filters = {
      kioskId: query.kioskId?.trim() || undefined,
      isAnomaly: this.parseBoolean('isAnomaly', query.isAnomaly),
      startDate: this.parseDate('startDate', query.startDate),
      endDate: this.parseDate('endDate', query.endDate, true),
    };

    const records = await this.kioskService.getReconciliationRecords(filters);
    const unitPrice = resolveUnitPrice();

    return {
      count: records.length,
      unitPrice,
      anomalyThreshold: ANOMALY_THRESHOLD,
      records: records.map((record) => {
        const metrics = calculateReconciliation({
          meterVolume: record.meterVolume,
          reportedCash: record.reportedCash,
          unitPrice,
        });
        return {
          ...record,
          discrepancyRatio: metrics.discrepancyRatio,
          discrepancyPercentage: metrics.discrepancyPercentage,
          hasVariance: metrics.hasVariance,
          isCashShortfall: metrics.isCashShortfall,
        };
      }),
    };
  }

  // ───────────────────────────────────────────────────────────
  //  Story 04 – Run the daily batch reconciliation engine
  //  POST /api/kiosk/reconciliation/run
  //
  //  Body (all optional): kioskId, startDate, endDate, date (single UTC
  //  day), window (baseline size, 1…365), unitPrice, dryRun.
  //  Returns the BatchSummary (counts, totals, per-record metrics and the
  //  flagged anomaly list). 201 Created is the Nest default.
  // ───────────────────────────────────────────────────────────

  @Post('reconciliation/run')
  async runReconciliation(@Body() dto: RunReconciliationDto) {
    if (!this.reconciliationService) {
      throw new ServiceUnavailableException(
        'Reconciliation batch engine is not available.',
      );
    }

    const startDate = this.parseDate('startDate', dto.startDate);
    const endDate = this.parseDate('endDate', dto.endDate, true);
    const date = this.parseDate('date', dto.date);

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must not be after endDate');
    }

    return this.reconciliationService.runBatch({
      kioskId: dto.kioskId?.trim() || undefined,
      startDate,
      endDate,
      date,
      window: dto.window,
      unitPrice: dto.unitPrice,
      dryRun: dto.dryRun,
    });
  }

  private parseBoolean(name: string, value?: string): boolean | undefined {
    if (value === undefined || value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(`${name} must be "true" or "false"`);
  }

  private parseDate(
    name: string,
    value?: string,
    endOfDay = false,
  ): Date | undefined {
    if (value === undefined || value === '') return undefined;

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${name} must be a valid ISO-8601 date string (e.g. 2026-11-01)`,
      );
    }

    // A date-only endDate should include that whole day, not stop at 00:00
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date;
  }

  // ───────────────────────────────────────────────────────────
  //  Existing endpoints
  // ───────────────────────────────────────────────────────────

  // POST http://localhost:3001/api/kiosk/heartbeat
  // for Ball to send Heartbeat to Server
  @Post('heartbeat')
  async receiveHeartbeat(@Body('kioskId') kioskId: string) {
    return this.kioskService.handleHeartbeat(kioskId || 'KIOSK-001');
  }

  // GET http://localhost:3001/api/kiosk/status/KIOSK-001
  // for check kiosk status or Earn to send the test
  @Get('status/:id')
  async checkStatus(@Param('id') id: string) {
    return this.kioskService.getKioskStatus(id);
  }
}
