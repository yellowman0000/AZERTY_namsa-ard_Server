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

@Injectable()
export class GoogleSheetsSyncScheduler {
  private readonly logger = new Logger(GoogleSheetsSyncScheduler.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: GoogleSheetsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async syncApprovedLogs(): Promise<void> {
    if (!this.sheets.isEnabled || this.running) return;

    this.running = true;
    try {
      await this.processDueRetries();
      await this.enqueueApprovedLogs();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown synchronization error';
      this.logger.error(`Google Sheets sync cycle failed: ${message}`);
    } finally {
      this.running = false;
    }
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
          isReadByManager: true,
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
        isReadByManager: true,
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
