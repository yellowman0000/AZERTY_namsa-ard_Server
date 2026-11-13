import { NotFoundException } from '@nestjs/common';
import { GoogleSheetsSyncError } from '../google-sheets/google-sheets.errors';
import { GoogleSheetsSyncScheduler } from '../google-sheets/google-sheets-sync.scheduler';
import type { GoogleSheetsService } from '../google-sheets/google-sheets.service';
import type { PrismaService } from '../prisma.service';
import { ReceiptAcceptanceService } from './receipt-acceptance.service';

interface FakeLog {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  isSynced: boolean;
  isReadByManager: boolean;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  recordedAt: Date;
  createdAt: Date;
}

function setup({
  enabled = true,
  append,
}: {
  enabled?: boolean;
  append?: jest.Mock;
} = {}) {
  const logs: FakeLog[] = [
    {
      id: 'log-1',
      transactionId: 'TXN-1',
      kioskId: 'KIOSK-001',
      meterVolume: 500,
      isSynced: false,
      isReadByManager: false,
      acceptedAt: null,
      acceptedBy: null,
      recordedAt: new Date('2026-11-12T08:00:00Z'),
      createdAt: new Date('2026-11-12T08:00:01Z'),
    },
  ];
  const find = (id: string) => logs.find((log) => log.id === id);

  const prisma = {
    dailyLog: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const log = find(where.id);
        return log ? { ...log } : null;
      }),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; acceptedAt?: { not: null } } }) => {
          const log = find(where.id);
          if (!log || (where.acceptedAt && log.acceptedAt === null)) return null;
          return { ...log };
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string | { in: string[] }; acceptedAt?: null; isSynced?: boolean };
          data: Partial<FakeLog>;
        }) => {
          const ids = typeof where.id === 'string' ? [where.id] : where.id.in;
          const hits = logs.filter(
            (log) =>
              ids.includes(log.id) &&
              (where.acceptedAt !== null || log.acceptedAt === null) &&
              (where.isSynced === undefined || log.isSynced === where.isSynced),
          );
          hits.forEach((log) => Object.assign(log, data));
          return { count: hits.length };
        },
      ),
    },
  };
  const appendDailyLogs =
    append ??
    jest.fn(async (rows: FakeLog[]) => ({
      appendedRows: rows.length,
      updatedRange: "'DailyLogs'!A2:O2",
      syncedLogIds: rows.map((row) => row.id),
    }));
  const sheets = { isEnabled: enabled, appendDailyLogs };
  const scheduler = new GoogleSheetsSyncScheduler(
    prisma as unknown as PrismaService,
    sheets as unknown as GoogleSheetsService,
  );
  const service = new ReceiptAcceptanceService(
    prisma as unknown as PrismaService,
    scheduler,
  );
  return { logs, service, appendDailyLogs };
}

describe('ReceiptAcceptanceService', () => {
  it('accepts the receipt and writes it to Google Sheets right away', async () => {
    const { logs, service, appendDailyLogs } = setup();

    const result = await service.accept('log-1', 'MGR-7');

    expect(appendDailyLogs).toHaveBeenCalledTimes(1);
    expect(appendDailyLogs.mock.calls[0][0][0].id).toBe('log-1');
    expect(result).toMatchObject({
      logId: 'log-1',
      transactionId: 'TXN-1',
      acceptedBy: 'MGR-7',
      alreadyAccepted: false,
      sheet: { status: 'SYNCED', updatedRange: "'DailyLogs'!A2:O2" },
    });
    expect(result.acceptedAt).toBeInstanceOf(Date);
    expect(logs[0]).toMatchObject({ isSynced: true, isReadByManager: true });
  });

  it('is idempotent: a second Accept never adds a second row', async () => {
    const { service, appendDailyLogs } = setup();

    const first = await service.accept('log-1');
    const second = await service.accept('log-1', 'MGR-8');

    expect(appendDailyLogs).toHaveBeenCalledTimes(1);
    expect(second.alreadyAccepted).toBe(true);
    expect(second.acceptedAt).toEqual(first.acceptedAt);
    expect(second.acceptedBy).toBeNull();
    expect(second.sheet.status).toBe('ALREADY_SYNCED');
  });

  it('two simultaneous accepts write one row', async () => {
    const { service, appendDailyLogs } = setup();

    const results = await Promise.all([
      service.accept('log-1'),
      service.accept('log-1'),
    ]);

    expect(appendDailyLogs).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.sheet.status).sort()).toEqual([
      'ALREADY_SYNCED',
      'SYNCED',
    ]);
  });

  it('keeps the receipt accepted and leaves it for the retry job when Sheets fails', async () => {
    const append = jest.fn().mockRejectedValue(
      new GoogleSheetsSyncError('rate limited', {
        kind: 'RATE_LIMITED',
        retryable: true,
        rowIds: ['log-1'],
      }),
    );
    const { logs, service } = setup({ append });

    const result = await service.accept('log-1');

    expect(result.sheet.status).toBe('PENDING');
    expect(result.sheet.message).toContain('rate limited');
    expect(logs[0].acceptedAt).not.toBeNull();
    expect(logs[0].isSynced).toBe(false);
  });

  it('reports DISABLED when Google Sheets is not configured', async () => {
    const { logs, service, appendDailyLogs } = setup({ enabled: false });

    const result = await service.accept('log-1');

    expect(result.sheet.status).toBe('DISABLED');
    expect(appendDailyLogs).not.toHaveBeenCalled();
    expect(logs[0].acceptedAt).not.toBeNull();
  });

  it('returns 404 for an unknown log', async () => {
    const { service } = setup();

    await expect(service.accept('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
