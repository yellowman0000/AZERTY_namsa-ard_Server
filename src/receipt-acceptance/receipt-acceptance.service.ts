import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  type AcceptedLogSheetResult,
  GoogleSheetsSyncScheduler,
} from '../google-sheets/google-sheets-sync.scheduler';

export interface AcceptReceiptResult {
  logId: string;
  transactionId: string;
  acceptedAt: Date;
  acceptedBy: string | null;
  /** True when the receipt had been accepted before this call. */
  alreadyAccepted: boolean;
  /** What happened with the Google Sheets row. */
  sheet: AcceptedLogSheetResult;
}

/**
 * Manager review flow: the manager opens an operator receipt on the dashboard
 * and clicks Accept. Accepting stamps the log and writes it to Google Sheets
 * straight away. Accepting twice is safe and never adds a second row.
 */
@Injectable()
export class ReceiptAcceptanceService {
  private readonly logger = new Logger(ReceiptAcceptanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheetsSync: GoogleSheetsSyncScheduler,
  ) {}

  async accept(logId: string, managerId?: string): Promise<AcceptReceiptResult> {
    const select = {
      id: true,
      transactionId: true,
      acceptedAt: true,
      acceptedBy: true,
    } as const;

    const existing = await this.prisma.dailyLog.findUnique({
      where: { id: logId },
      select,
    });
    if (!existing) {
      throw new NotFoundException(`Log "${logId}" not found.`);
    }

    let log = existing;
    const alreadyAccepted = existing.acceptedAt !== null;
    if (!alreadyAccepted) {
      // `acceptedAt: null` in the filter keeps the first acceptance if two
      // managers click at the same moment.
      await this.prisma.dailyLog.updateMany({
        where: { id: logId, acceptedAt: null },
        data: {
          acceptedAt: new Date(),
          acceptedBy: managerId?.trim() || null,
          isReadByManager: true,
        },
      });
      const updated = await this.prisma.dailyLog.findUnique({
        where: { id: logId },
        select,
      });
      if (!updated) throw new NotFoundException(`Log "${logId}" not found.`);
      log = updated;
      this.logger.log(
        `Receipt ${log.transactionId} (log ${log.id}) accepted by ${log.acceptedBy ?? 'manager'}`,
      );
    }

    const sheet = await this.sheetsSync.syncAcceptedLog(logId);

    return {
      logId: log.id,
      transactionId: log.transactionId,
      acceptedAt: log.acceptedAt as Date,
      acceptedBy: log.acceptedBy,
      alreadyAccepted,
      sheet,
    };
  }
}
