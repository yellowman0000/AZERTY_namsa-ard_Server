import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { GoogleSheetsSyncError } from './google-sheets.errors';
import {
  GoogleSheetsService,
  MAX_ROWS_PER_APPEND,
} from './google-sheets.service';

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1_000;
const JOB_TYPE = 'GOOGLE_SHEETS_SYNC';

/** Only logs a manager accepted on the dashboard are written to Google Sheets. */
const ACCEPTED = { acceptedAt: { not: null } } as const;

export type AcceptedLogSheetStatus =
  /** The row was written to Google Sheets by this call. */
  | 'SYNCED'
  /** The row was already in Google Sheets. */
  | 'ALREADY_SYNCED'
  /** Google Sheets did not take the row yet; the scheduled job retries it. */
  | 'PENDING'
  /** Google Sheets is not configured on this server. */
  | 'DISABLED';

export interface AcceptedLogSheetResult {
  status: AcceptedLogSheetStatus;
  updatedRange?: string | null;
  message?: string;
}

@Injectable()
export class GoogleSheetsSyncScheduler {
  private readonly logger = new Logger(GoogleSheetsSyncScheduler.name);
  private cycleRunning = false;
  /**
   * Serialises Sheets writes: the scheduled cycle and an on-accept push must
   * never append the same log twice, so every write runs one after another and
   * re-reads `isSynced` inside the lock.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: GoogleSheetsService,
  ) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Safety net for accepted logs: retries rows whose on-accept push failed and
   * picks up any accepted row that is still not in the sheet.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async syncApprovedLogs(): Promise<void> {
    if (!this.sheets.isEnabled || this.cycleRunning) return;

    this.cycleRunning = true;
    try {
      await this.exclusive(async () => {
        await this.processDueRetries();
        await this.enqueueApprovedLogs();
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown synchronization error';
      this.logger.error(`Google Sheets sync cycle failed: ${message}`);
    } finally {
      this.cycleRunning = false;
    }
  }

  /**
   * Writes one accepted log to Google Sheets right away (manager clicked
   * Accept). A failure is not thrown: the log stays accepted and unsynced, so
   * the scheduled cycle retries it with the usual backoff and audit trail.
   */
  async syncAcceptedLog(logId: string): Promise<AcceptedLogSheetResult> {
    if (!this.sheets.isEnabled) {
      return {
        status: 'DISABLED',
        message:
          'Google Sheets is not configured on the server. The receipt is accepted and will be added once Sheets sync is set up.',
      };
    }

    return this.exclusive(async () => {
      const log = await this.prisma.dailyLog.findFirst({
        where: { id: logId, ...ACCEPTED },
      });
      if (!log) {
        return { status: 'PENDING', message: 'The log is not accepted.' };
      }
      if (log.isSynced) return { status: 'ALREADY_SYNCED' };

      try {
        const result = await this.sheets.appendDailyLogs([log]);
        await this.prisma.dailyLog.updateMany({
          where: { id: { in: result.syncedLogIds }, isSynced: false },
          data: { isSynced: true },
        });
        return { status: 'SYNCED', updatedRange: result.updatedRange };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown Google Sheets error';
        this.logger.warn(
          `Accepted log ${logId} was not written to Google Sheets yet: ${message}`,
        );
        return {
          status: 'PENDING',
          message: `Google Sheets did not take the row yet (${message}). The server retries automatically.`,
        };
      }
    });
  }

  private async processDueRetries(): Promise<void> {
    const dueItems = await this.prisma.syncRetryQueue.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: 20,
    });

    for (const item of dueItems) {
      const logs = await this.prisma.dailyLog.findMany({
        where: {
          id: { in: item.logIds },
          isSynced: false,
          ...ACCEPTED,
        },
        orderBy: { recordedAt: 'asc' },
      });

      if (logs.length === 0) {
        await this.prisma.syncRetryQueue.delete({ where: { id: item.id } });
        continue;
      }

      try {
        const result = await this.sheets.appendDailyLogs(logs);
        await this.prisma.dailyLog.updateMany({
          where: { id: { in: result.syncedLogIds }, isSynced: false },
          data: { isSynced: true },
        });
        await this.prisma.syncRetryQueue.delete({ where: { id: item.id } });
      } catch (error) {
        const syncError =
          error instanceof GoogleSheetsSyncError
            ? error
            : new GoogleSheetsSyncError(
                error instanceof Error
                  ? error.message
                  : 'Unknown Google Sheets error',
                {
                  kind: 'UNKNOWN',
                  retryable: false,
                  rowIds: logs.map((log) => log.id),
                },
              );
        const failedRowIds =
          syncError.rowIds.length > 0
            ? [...syncError.rowIds]
            : logs.map((log) => log.id);
        const retryCount = item.retryCount + 1;

        await this.prisma.systemAuditLog.create({
          data: {
            jobType: JOB_TYPE,
            failedRowIds,
            errorMessage: syncError.message.slice(0, 4_000),
            retryCount,
          },
        });

        if (syncError.retryable) {
          const delay = Math.min(
            RETRY_BASE_MS * 2 ** (retryCount - 1),
            RETRY_MAX_MS,
          );
          await this.prisma.syncRetryQueue.update({
            where: { id: item.id },
            data: {
              retryCount,
              nextAttemptAt: new Date(Date.now() + delay),
              errorMessage: syncError.message.slice(0, 4_000),
            },
          });
        } else {
          await this.prisma.syncRetryQueue.update({
            where: { id: item.id },
            data: {
              status: 'FAILED',
              retryCount,
              errorMessage: syncError.message.slice(0, 4_000),
            },
          });
        }

        this.logger.error(
          `Google Sheets sync failed for ${failedRowIds.length} row(s); ` +
            `kind=${syncError.kind}, retryable=${syncError.retryable}, attempt=${retryCount}`,
        );
      }
    }
  }

  private async enqueueApprovedLogs(): Promise<void> {
    const activeItems = await this.prisma.syncRetryQueue.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] } },
      select: { logIds: true },
    });
    const queuedIds = new Set(activeItems.flatMap((item) => item.logIds));
    const logs = await this.prisma.dailyLog.findMany({
      where: {
        isSynced: false,
        ...ACCEPTED,
        ...(queuedIds.size > 0 ? { id: { notIn: [...queuedIds] } } : {}),
      },
      orderBy: { recordedAt: 'asc' },
      take: MAX_ROWS_PER_APPEND,
    });

    if (logs.length > 0) {
      await this.prisma.syncRetryQueue.create({
        data: { logIds: logs.map((log) => log.id) },
      });
    }
  }
}
