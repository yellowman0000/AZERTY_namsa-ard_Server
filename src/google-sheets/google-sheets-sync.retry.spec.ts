import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import type { GoogleSheetsConfig } from './google-sheets.config';
import { DAILY_LOG_SHEET_HEADERS } from './daily-log-row.mapper';
import { GoogleSheetsService } from './google-sheets.service';
import { GoogleSheetsSyncScheduler } from './google-sheets-sync.scheduler';
import type { SheetsClient } from './sheets-client.types';

// ───────────────────────────────────────────────────────────
//  Story 03 – Sync Data to Sheets Automatically (Owner: Earn)
//  Simulate Google Sheets API 429 rate-limit and network drop scenarios
//  to verify the retry queue and audit logging.
// ───────────────────────────────────────────────────────────

const JOB_TYPE = 'GOOGLE_SHEETS_SYNC';
const ONE_MINUTE = 60_000;
const START = new Date('2026-11-11T08:00:00.000Z');

const enabledConfig: GoogleSheetsConfig = {
  enabled: true,
  spreadsheetId: 'sheet-123',
  sheetName: 'DailyLogs',
  timeZone: 'Asia/Bangkok',
  requestTimeoutMs: 15000,
  credentials: {
    client_email: 'sync@namsa-ard.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
  },
};

// ── Mocked Google Sheets API responses ─────────────────────

/** Error as thrown by the googleapis client for an HTTP status. */
const httpError = (status: number, message = `Request failed with status code ${status}`) =>
  Object.assign(new Error(message), { status, code: status });

/** Error as thrown by Node / gaxios for a dropped connection. */
const networkError = (code: string) =>
  Object.assign(new Error(`request to sheets.googleapis.com failed, reason: ${code}`), { code });

/** 200 OK body of `spreadsheets.values.append`. */
const appendOk = (rows: number) => ({
  data: { updates: { updatedRange: `'DailyLogs'!A2:O${1 + rows}`, updatedRows: rows } },
});

function createFakeSheetsApi() {
  return {
    spreadsheets: {
      get: jest.fn(),
      values: {
        // Header row already in place, so `append` is the only call that matters.
        get: jest.fn().mockResolvedValue({ data: { values: [[...DAILY_LOG_SHEET_HEADERS]] } }),
        update: jest.fn().mockResolvedValue({ data: {} }),
        append: jest.fn(
          async (params: { requestBody: { values: unknown[][] } }) =>
            appendOk(params.requestBody.values.length),
        ),
      },
    },
  };
}

// ── In-memory database ─────────────────────────────────────

interface FakeLog {
  id: string;
  transactionId: string;
  kioskId: string;
  operatorId: string;
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  checksum: string;
  isSynced: boolean;
  isReadByManager: boolean;
  recordedAt: Date;
  createdAt: Date;
}

interface FakeQueueItem {
  id: string;
  logIds: string[];
  retryCount: number;
  nextAttemptAt: Date;
  errorMessage: string | null;
  status: string;
  createdAt: Date;
}

interface FakeAuditLog {
  id: string;
  jobType: string;
  failedRowIds: string[];
  errorMessage: string;
  retryCount: number;
  createdAt: Date;
}

type IdFilter = { in?: string[]; notIn?: string[] };

const matchesId = (id: string, filter?: IdFilter) =>
  (!filter?.in || filter.in.includes(id)) && (!filter?.notIn || !filter.notIn.includes(id));

/** Minimal stand-in for the Prisma calls made by GoogleSheetsSyncScheduler. */
function createFakePrisma() {
  const dailyLogs: FakeLog[] = [];
  const retryQueue: FakeQueueItem[] = [];
  const auditLogs: FakeAuditLog[] = [];
  let queueSeq = 0;
  let auditSeq = 0;

  const queueMatches = (
    item: FakeQueueItem,
    where: { status?: string | { in: string[] }; nextAttemptAt?: { lte: Date } } = {},
  ) => {
    if (typeof where.status === 'string' && item.status !== where.status) return false;
    if (typeof where.status === 'object' && !where.status.in.includes(item.status)) return false;
    if (where.nextAttemptAt && item.nextAttemptAt.getTime() > where.nextAttemptAt.lte.getTime()) {
      return false;
    }
    return true;
  };

  const prisma = {
    dailyLog: {
      findMany: jest.fn(
        async ({
          where = {},
          take,
        }: {
          where?: { id?: IdFilter; isSynced?: boolean; isReadByManager?: boolean };
          take?: number;
        }) =>
          dailyLogs
            .filter(
              (log) =>
                matchesId(log.id, where.id) &&
                (where.isSynced === undefined || log.isSynced === where.isSynced) &&
                (where.isReadByManager === undefined || log.isReadByManager === where.isReadByManager),
            )
            .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
            .slice(0, take ?? Infinity)
            .map((log) => ({ ...log })),
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: IdFilter; isSynced?: boolean }; data: Partial<FakeLog> }) => {
          const hits = dailyLogs.filter(
            (log) =>
              matchesId(log.id, where.id) &&
              (where.isSynced === undefined || log.isSynced === where.isSynced),
          );
          hits.forEach((log) => Object.assign(log, data));
          return { count: hits.length };
        },
      ),
    },
    syncRetryQueue: {
      findMany: jest.fn(
        async ({
          where,
          take,
          select,
        }: {
          where?: Parameters<typeof queueMatches>[1];
          take?: number;
          select?: { logIds: true };
        }) =>
          retryQueue
            .filter((item) => queueMatches(item, where))
            .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
            .slice(0, take ?? Infinity)
            .map((item) => (select ? { logIds: [...item.logIds] } : { ...item, logIds: [...item.logIds] })),
      ),
      create: jest.fn(async ({ data }: { data: { logIds: string[] } }) => {
        const item: FakeQueueItem = {
          id: `retry-${++queueSeq}`,
          logIds: [...data.logIds],
          retryCount: 0,
          nextAttemptAt: new Date(),
          errorMessage: null,
          status: 'PENDING',
          createdAt: new Date(),
        };
        retryQueue.push(item);
        return { ...item };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeQueueItem> }) => {
        const item = retryQueue.find((q) => q.id === where.id);
        if (!item) throw new Error(`Unknown retry queue item ${where.id}`);
        Object.assign(item, data);
        return { ...item };
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const index = retryQueue.findIndex((q) => q.id === where.id);
        if (index < 0) throw new Error(`Unknown retry queue item ${where.id}`);
        return retryQueue.splice(index, 1)[0];
      }),
    },
    systemAuditLog: {
      create: jest.fn(async ({ data }: { data: Omit<FakeAuditLog, 'id' | 'createdAt'> }) => {
        const entry: FakeAuditLog = {
          id: `audit-${++auditSeq}`,
          createdAt: new Date(),
          ...data,
          failedRowIds: [...data.failedRowIds],
        };
        auditLogs.push(entry);
        return { ...entry };
      }),
    },
  };

  return { prisma, dailyLogs, retryQueue, auditLogs };
}

let logSeq = 0;

/** A DailyLog row approved by a manager and not yet in the spreadsheet. */
function approvedLog(overrides: Partial<FakeLog> = {}): FakeLog {
  logSeq += 1;
  const recordedAt = new Date(START.getTime() - (100 - logSeq) * ONE_MINUTE);
  return {
    id: `log-${logSeq}`,
    transactionId: `TXN-${logSeq}`,
    kioskId: 'KIOSK-001',
    operatorId: 'OP-104',
    meterVolume: 500,
    reportedCash: 950,
    expectedRevenue: 1000,
    variance: -50,
    isAnomaly: false,
    checksum: 'abc123',
    isSynced: false,
    isReadByManager: true,
    recordedAt,
    createdAt: recordedAt,
    ...overrides,
  };
}

describe('Story 03 – Google Sheets sync: simulated 429 / 503 / network drop (Earn)', () => {
  let db: ReturnType<typeof createFakePrisma>;
  let api: ReturnType<typeof createFakeSheetsApi>;
  let scheduler: GoogleSheetsSyncScheduler;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    // Keep test output readable; the pipeline logs every failure.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    db = createFakePrisma();
    api = createFakeSheetsApi();
    const sheets = new GoogleSheetsService(
      enabledConfig,
      () => api as unknown as SheetsClient,
    );
    scheduler = new GoogleSheetsSyncScheduler(db.prisma as unknown as PrismaService, sheets);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** One cron tick of `@Cron(EVERY_MINUTE)`. */
  const runCycle = () => scheduler.syncApprovedLogs();

  /** Moves the clock forward by `ms` (e.g. to make a retry due). */
  const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);

  /** Cycle 1 queues the approved logs, cycle 2 sends them to Google Sheets. */
  const queueThenSend = async () => {
    await runCycle();
    await runCycle();
  };

  const appendCalls = () => api.spreadsheets.values.append.mock.calls.length;
  const lastAppendedTxnIds = () => {
    const calls = api.spreadsheets.values.append.mock.calls;
    const rows = calls[calls.length - 1][0].requestBody.values as unknown[][];
    return rows.map((row) => row.find((cell) => typeof cell === 'string' && cell.startsWith('TXN-')));
  };

  // ─────────────────────────────────────────────────────────
  //  200 OK
  // ─────────────────────────────────────────────────────────
  describe('200 OK', () => {
    it('appends approved logs, marks them synced, clears the queue and writes no audit entry', async () => {
      db.dailyLogs.push(approvedLog(), approvedLog());

      await queueThenSend();

      expect(appendCalls()).toBe(1);
      expect(lastAppendedTxnIds()).toEqual(['TXN-' + (logSeq - 1), 'TXN-' + logSeq]);
      expect(db.dailyLogs.every((log) => log.isSynced)).toBe(true);
      expect(db.retryQueue).toHaveLength(0);
      expect(db.auditLogs).toHaveLength(0);
    });

    it('never sends a log that a manager has not approved yet', async () => {
      db.dailyLogs.push(approvedLog({ isReadByManager: false }));

      await queueThenSend();

      expect(appendCalls()).toBe(0);
      expect(db.retryQueue).toHaveLength(0);
      expect(db.dailyLogs[0].isSynced).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  429 / 503 / network drop → retry queue + audit log
  // ─────────────────────────────────────────────────────────
  describe('retryable failures queue the rows and write system_audit_logs', () => {
    it.each<[string, () => Error]>([
      ['429 Too Many Requests', () => httpError(429, 'Quota exceeded for quota metric "Write requests"')],
      ['503 Service Unavailable', () => httpError(503, 'The service is currently unavailable.')],
      ['network timeout (ETIMEDOUT)', () => networkError('ETIMEDOUT')],
      ['connection reset (ECONNRESET)', () => networkError('ECONNRESET')],
    ])('%s', async (_label, failure) => {
      const logs = [approvedLog(), approvedLog()];
      db.dailyLogs.push(...logs);
      api.spreadsheets.values.append.mockRejectedValueOnce(failure());

      await queueThenSend();

      // Rows were not written and stay unsynced
      expect(appendCalls()).toBe(1);
      expect(db.dailyLogs.every((log) => !log.isSynced)).toBe(true);

      // Queued for automatic retry with a 1-minute first backoff
      expect(db.retryQueue).toHaveLength(1);
      expect(db.retryQueue[0]).toMatchObject({
        logIds: logs.map((l) => l.id),
        status: 'PENDING',
        retryCount: 1,
      });
      expect(db.retryQueue[0].nextAttemptAt.getTime()).toBe(Date.now() + ONE_MINUTE);
      expect(db.retryQueue[0].errorMessage).toBeTruthy();

      // One audit entry with the failed rows and the error trace
      expect(db.auditLogs).toHaveLength(1);
      expect(db.auditLogs[0]).toMatchObject({
        jobType: JOB_TYPE,
        failedRowIds: logs.map((l) => l.id),
        retryCount: 1,
      });
      expect(db.auditLogs[0].errorMessage).toBeTruthy();
    });

    it('keeps the API error detail in the audit entry', async () => {
      db.dailyLogs.push(approvedLog());
      api.spreadsheets.values.append.mockRejectedValueOnce(
        httpError(429, 'Quota exceeded for quota metric "Write requests"'),
      );

      await queueThenSend();

      expect(db.auditLogs[0].errorMessage).toContain('Quota exceeded');
    });
  });

  // ─────────────────────────────────────────────────────────
  //  Automatic retry
  // ─────────────────────────────────────────────────────────
  describe('automatic retry from the queue', () => {
    it.each<[string, () => Error]>([
      ['429', () => httpError(429)],
      ['503', () => httpError(503)],
      ['network drop', () => networkError('ETIMEDOUT')],
    ])('after a %s, the next due cycle retries and syncs the rows', async (_label, failure) => {
      const log = approvedLog();
      db.dailyLogs.push(log);
      api.spreadsheets.values.append.mockRejectedValueOnce(failure());
      await queueThenSend();

      advance(ONE_MINUTE);
      await runCycle();

      expect(appendCalls()).toBe(2);
      expect(db.dailyLogs[0].isSynced).toBe(true);
      expect(db.retryQueue).toHaveLength(0);
      // Only the failed attempt is audited, not the successful retry
      expect(db.auditLogs).toHaveLength(1);
    });

    it('does not retry before the backoff has elapsed', async () => {
      db.dailyLogs.push(approvedLog());
      api.spreadsheets.values.append.mockRejectedValueOnce(httpError(429));
      await queueThenSend();

      advance(ONE_MINUTE - 1_000);
      await runCycle();

      expect(appendCalls()).toBe(1);
      expect(db.auditLogs).toHaveLength(1);
      expect(db.retryQueue[0].retryCount).toBe(1);
    });

    it('backs off exponentially (1, 2, 4 min) and audits every failed attempt', async () => {
      db.dailyLogs.push(approvedLog());
      api.spreadsheets.values.append
        .mockRejectedValueOnce(httpError(429))
        .mockRejectedValueOnce(httpError(503))
        .mockRejectedValueOnce(networkError('ECONNRESET'));

      await queueThenSend();
      expect(db.retryQueue[0].nextAttemptAt.getTime() - Date.now()).toBe(1 * ONE_MINUTE);

      advance(1 * ONE_MINUTE);
      await runCycle();
      expect(db.retryQueue[0].nextAttemptAt.getTime() - Date.now()).toBe(2 * ONE_MINUTE);

      advance(2 * ONE_MINUTE);
      await runCycle();
      expect(db.retryQueue[0].nextAttemptAt.getTime() - Date.now()).toBe(4 * ONE_MINUTE);

      expect(db.auditLogs.map((a) => a.retryCount)).toEqual([1, 2, 3]);
      expect(db.retryQueue[0]).toMatchObject({ status: 'PENDING', retryCount: 3 });

      // Fourth attempt succeeds
      advance(4 * ONE_MINUTE);
      await runCycle();
      expect(db.dailyLogs[0].isSynced).toBe(true);
      expect(db.retryQueue).toHaveLength(0);
      expect(db.auditLogs).toHaveLength(3);
    });

    it('caps the backoff at 24 hours', async () => {
      db.dailyLogs.push(approvedLog());
      api.spreadsheets.values.append.mockRejectedValue(httpError(429));
      await queueThenSend();

      for (let attempt = 1; attempt < 12; attempt++) {
        jest.setSystemTime(db.retryQueue[0].nextAttemptAt);
        await runCycle();
      }

      expect(db.retryQueue[0].retryCount).toBe(12);
      expect(db.retryQueue[0].nextAttemptAt.getTime() - Date.now()).toBe(24 * 60 * ONE_MINUTE);
    });

    it('does not queue rows that are already waiting for a retry a second time', async () => {
      db.dailyLogs.push(approvedLog());
      api.spreadsheets.values.append.mockRejectedValueOnce(httpError(429));
      await queueThenSend();

      // More cycles before the retry is due
      await runCycle();
      await runCycle();

      expect(db.retryQueue).toHaveLength(1);
      expect(appendCalls()).toBe(1);
    });

    it('a rate-limited batch does not hold back logs approved later', async () => {
      const first = approvedLog();
      db.dailyLogs.push(first);
      api.spreadsheets.values.append.mockRejectedValueOnce(httpError(429));
      await queueThenSend();

      const later = approvedLog();
      db.dailyLogs.push(later);
      await queueThenSend();

      expect(db.dailyLogs.find((l) => l.id === later.id)?.isSynced).toBe(true);
      expect(db.dailyLogs.find((l) => l.id === first.id)?.isSynced).toBe(false);
      expect(db.retryQueue.map((q) => q.logIds)).toEqual([[first.id]]);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  Contrast: non-retryable errors
  // ─────────────────────────────────────────────────────────
  describe('non-retryable errors are audited but not retried', () => {
    it.each<[string, number]>([
      ['403 Forbidden (sheet not shared)', 403],
      ['400 Bad Request', 400],
    ])('%s marks the queue item FAILED', async (_label, status) => {
      const log = approvedLog();
      db.dailyLogs.push(log);
      api.spreadsheets.values.append.mockRejectedValueOnce(httpError(status));
      await queueThenSend();

      expect(db.auditLogs).toHaveLength(1);
      expect(db.auditLogs[0]).toMatchObject({ jobType: JOB_TYPE, failedRowIds: [log.id] });
      expect(db.retryQueue[0]).toMatchObject({ status: 'FAILED', retryCount: 1 });

      // Even long after, the failed batch is not sent again
      advance(24 * 60 * ONE_MINUTE);
      await runCycle();
      expect(appendCalls()).toBe(1);
      expect(db.dailyLogs[0].isSynced).toBe(false);
    });
  });
});
