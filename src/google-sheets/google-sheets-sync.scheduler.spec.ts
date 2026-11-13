import { GoogleSheetsSyncError } from './google-sheets.errors';
import { GoogleSheetsSyncScheduler } from './google-sheets-sync.scheduler';
import type { GoogleSheetsService } from './google-sheets.service';
import type { PrismaService } from '../prisma.service';

describe('GoogleSheetsSyncScheduler', () => {
  it('appends approved unsynced logs and marks them synced', async () => {
    const log = {
      id: 'log-1',
      transactionId: 'txn-1',
      kioskId: 'kiosk-1',
      meterVolume: 12,
      recordedAt: new Date(),
      createdAt: new Date(),
      isReadByManager: true,
      acceptedAt: new Date(),
      isSynced: false,
    };
    const prisma = {
      syncRetryQueue: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'retry-1', logIds: ['log-1'], retryCount: 0 }])
          .mockResolvedValueOnce([]),
        delete: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      dailyLog: {
        findMany: jest.fn().mockResolvedValueOnce([log]).mockResolvedValueOnce([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      systemAuditLog: {
        create: jest.fn(),
      },
    };
    const sheets = {
      isEnabled: true,
      appendDailyLogs: jest.fn().mockResolvedValue({
        appendedRows: 1,
        updatedRange: "'DailyLogs'!A2:O2",
        syncedLogIds: ['log-1'],
      }),
    };
    const scheduler = new GoogleSheetsSyncScheduler(
      prisma as unknown as PrismaService,
      sheets as unknown as GoogleSheetsService,
    );

    await scheduler.syncApprovedLogs();

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isSynced: false,
          acceptedAt: { not: null },
        }),
      }),
    );
    expect(sheets.appendDailyLogs).toHaveBeenCalledWith([log]);
    expect(prisma.dailyLog.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['log-1'] }, isSynced: false },
      data: { isSynced: true },
    });
    expect(prisma.syncRetryQueue.delete).toHaveBeenCalledWith({
      where: { id: 'retry-1' },
    });
    expect(prisma.syncRetryQueue.create).not.toHaveBeenCalled();
    expect(prisma.systemAuditLog.create).not.toHaveBeenCalled();
  });

  it('audits a failed batch and schedules retry with exponential backoff', async () => {
    const now = Date.now();
    const queueItem = {
      id: 'retry-1',
      logIds: ['log-1'],
      retryCount: 1,
    };
    const log = {
      id: 'log-1',
      transactionId: 'txn-1',
      kioskId: 'kiosk-1',
      meterVolume: 12,
      recordedAt: new Date(),
      createdAt: new Date(),
      isReadByManager: true,
      acceptedAt: new Date(),
      isSynced: false,
    };
    const prisma = {
      syncRetryQueue: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([queueItem])
          .mockResolvedValueOnce([{ logIds: ['log-1'] }]),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
      dailyLog: {
        findMany: jest.fn().mockResolvedValueOnce([log]).mockResolvedValueOnce([]),
        updateMany: jest.fn(),
      },
      systemAuditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const sheets = {
      isEnabled: true,
      appendDailyLogs: jest.fn().mockRejectedValue(
        new GoogleSheetsSyncError('rate limited', {
          kind: 'RATE_LIMITED',
          retryable: true,
          rowIds: ['log-1'],
        }),
      ),
    };
    const scheduler = new GoogleSheetsSyncScheduler(
      prisma as unknown as PrismaService,
      sheets as unknown as GoogleSheetsService,
    );

    await scheduler.syncApprovedLogs();

    expect(prisma.systemAuditLog.create).toHaveBeenCalledWith({
      data: {
        jobType: 'GOOGLE_SHEETS_SYNC',
        failedRowIds: ['log-1'],
        errorMessage: 'rate limited',
        retryCount: 2,
      },
    });
    const retryUpdate = prisma.syncRetryQueue.update.mock.calls[0][0];
    expect(retryUpdate.data.retryCount).toBe(2);
    expect(retryUpdate.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      now + 2 * 60_000,
    );
    expect(retryUpdate.data.nextAttemptAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 2 * 60_000,
    );
  });

  it('does not query the database when Google Sheets is disabled', async () => {
    const prisma = {
      syncRetryQueue: { findMany: jest.fn() },
      dailyLog: { findMany: jest.fn() },
      systemAuditLog: { create: jest.fn() },
    };
    const sheets = { isEnabled: false, appendDailyLogs: jest.fn() };
    const scheduler = new GoogleSheetsSyncScheduler(
      prisma as unknown as PrismaService,
      sheets as unknown as GoogleSheetsService,
    );

    await scheduler.syncApprovedLogs();

    expect(prisma.syncRetryQueue.findMany).not.toHaveBeenCalled();
    expect(prisma.dailyLog.findMany).not.toHaveBeenCalled();
  });
});
