/**
 * API-level end-to-end suite for Sprint 2 — Priority 2, ID 04 "Interpret Data".
 *
 * Covers the daily reconciliation batch engine and the enriched reconciliation
 * query endpoint through HTTP (supertest + a real Nest application booted from
 * AppModule) against an in-memory fake PrismaService — no database is touched.
 *
 * Contract under test (from the sprint spec, §Priority 2 ID 04 / §3.1):
 *   POST /api/kiosk/reconciliation/run
 *     → 201 BatchSummary { success, unitPrice 2, baselineWindow 7,
 *       anomalyThreshold 0.3, processedCount, updatedCount, anomalyCount,
 *       totals, records[], anomalies[] } and persists recomputed
 *       expectedRevenue / variance / isAnomaly rows.
 *   GET  /api/kiosk/reconciliation
 *     → { count, unitPrice, anomalyThreshold, records[] } with server-computed
 *       discrepancyRatio / discrepancyPercentage / hasVariance / isCashShortfall.
 *
 * Suites are independent of the unit specs: they only assert observable API
 * behaviour and persisted row state, never internal implementation details.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// ───────────────────────────────────────────────────────────────────────────
//  In-memory fake PrismaService (same pattern as report-export.e2e-spec.ts)
// ───────────────────────────────────────────────────────────────────────────

interface FakeLog {
  id: string;
  transactionId: string;
  kioskId: string;
  operatorId: string | null;
  waterType: 'COMMERCIAL' | 'SUBSIDIZED';
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  checksum: string | null;
  isSynced: boolean;
  isReadByManager: boolean;
  recordedAt: Date;
  createdAt: Date;
}

type DateRangeFilter = { gte?: Date; lte?: Date };

/** Minimal structured logger for the fake's query shapes. */
interface FakeWhere {
  kioskId?: string | { in?: string[] };
  isAnomaly?: boolean;
  recordedAt?: DateRangeFilter;
}

type FakeOrderBy = Record<string, 'asc' | 'desc'>;

function createFakePrisma() {
  const kiosks = new Map<string, { id: string; status: string }>();
  const logs: FakeLog[] = [];

  const matchesWhere = (log: FakeLog, where?: FakeWhere): boolean => {
    if (!where) return true;

    const kioskFilter = where.kioskId;
    if (typeof kioskFilter === 'string') {
      if (log.kioskId !== kioskFilter) return false;
    } else if (kioskFilter && Array.isArray(kioskFilter.in)) {
      if (!kioskFilter.in.includes(log.kioskId)) return false;
    }

    if (where.isAnomaly !== undefined && log.isAnomaly !== where.isAnomaly) {
      return false;
    }

    const range = where.recordedAt;
    if (range) {
      if (range.gte && log.recordedAt.getTime() < range.gte.getTime()) {
        return false;
      }
      if (range.lte && log.recordedAt.getTime() > range.lte.getTime()) {
        return false;
      }
    }

    return true;
  };

  const compareValues = (left: unknown, right: unknown): number => {
    if (left instanceof Date && right instanceof Date) {
      return left.getTime() - right.getTime();
    }
    if (left === right) return 0;
    return (left as string) < (right as string) ? -1 : 1;
  };

  const sortLogs = (rows: FakeLog[], orderBy?: unknown): FakeLog[] => {
    const clauses: FakeOrderBy[] = Array.isArray(orderBy)
      ? (orderBy as FakeOrderBy[])
      : orderBy
        ? [orderBy as FakeOrderBy]
        : [];

    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const key = Object.keys(clause)[0];
        const direction = clause[key];
        const diff = compareValues(
          (a as unknown as Record<string, unknown>)[key],
          (b as unknown as Record<string, unknown>)[key],
        );
        if (diff !== 0) return direction === 'desc' ? -diff : diff;
      }
      return 0;
    });
  };

  const dailyLog = {
    findMany: jest.fn(
      async (args: { where?: FakeWhere; orderBy?: unknown } = {}) => {
        const rows = logs.filter((log) => matchesWhere(log, args.where));
        return sortLogs(rows, args.orderBy).map((log) => ({ ...log }));
      },
    ),
    findUnique: jest.fn(
      async (args: { where?: { id?: string; transactionId?: string } } = {}) => {
        const { id, transactionId } = args.where ?? {};
        const row = logs.find(
          (log) => log.id === id || log.transactionId === transactionId,
        );
        return row ? { ...row } : null;
      },
    ),
    create: jest.fn(async (args: { data: FakeLog }) => {
      const row = { ...args.data };
      logs.push(row);
      return { ...row };
    }),
    update: jest.fn(
      async (args: { where: { id: string }; data: Partial<FakeLog> }) => {
        const row = logs.find((log) => log.id === args.where.id);
        if (!row) {
          throw new Error(`Fake dailyLog.update: log ${args.where.id} not found`);
        }
        Object.assign(row, args.data);
        return { ...row };
      },
    ),
    updateMany: jest.fn(async () => ({ count: 0 })),
    count: jest.fn(
      async (args: { where?: FakeWhere } = {}) =>
        logs.filter((log) => matchesWhere(log, args.where)).length,
    ),
    upsert: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({})),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  };

  const kiosk = {
    findUnique: jest.fn(
      async (args: { where: { id: string } }) =>
        kiosks.get(args.where.id) ?? null,
    ),
    updateMany: jest.fn(async () => ({ count: 0 })),
    upsert: jest.fn(async () => ({})),
  };

  return {
    kiosks,
    logs,
    kiosk,
    dailyLog,
    $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };
}

// ───────────────────────────────────────────────────────────────────────────
//  Seeding helpers
// ───────────────────────────────────────────────────────────────────────────

let seedSequence = 0;

function addDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function seedLog(
  prisma: ReturnType<typeof createFakePrisma>,
  options: {
    kioskId: string;
    day: string;
    hour?: number;
    meterVolume: number;
    reportedCash: number;
    /** Stored (pre-batch) values; defaults deliberately stale to force writes. */
    expectedRevenue?: number;
    variance?: number;
    isAnomaly?: boolean;
  },
): FakeLog {
  seedSequence += 1;
  const hour = options.hour ?? 10;
  const recordedAt = new Date(
    `${options.day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
  );
  const log: FakeLog = {
    id: `log-${seedSequence}`,
    transactionId: `TXN-${options.kioskId}-${options.day.replace(/-/g, '')}-${hour}`,
    kioskId: options.kioskId,
    operatorId: 'OP-001',
    waterType: 'COMMERCIAL',
    meterVolume: options.meterVolume,
    reportedCash: options.reportedCash,
    expectedRevenue: options.expectedRevenue ?? 0,
    variance: options.variance ?? 0,
    isAnomaly: options.isAnomaly ?? false,
    checksum: null,
    isSynced: true,
    isReadByManager: false,
    recordedAt,
    createdAt: recordedAt,
  };
  prisma.logs.push(log);
  return log;
}

/**
 * Seven normal days of `volumes[i]` L starting at `startDay`.
 *
 * By default the stored revenue columns are already correct (clean seed) so
 * anomaly/boundary tests get a stable 100 L baseline. Pass `stale: true` to
 * seed zeroed stored columns, forcing the batch to rewrite every row.
 */
function seedHistory(
  prisma: ReturnType<typeof createFakePrisma>,
  kioskId: string,
  options: {
    startDay?: string;
    volumes?: number[];
    cash?: number;
    stale?: boolean;
  } = {},
): FakeLog[] {
  const startDay = options.startDay ?? '2026-09-01';
  const volumes = options.volumes ?? [100, 100, 100, 100, 100, 100, 100];
  return volumes.map((meterVolume, index) =>
    seedLog(prisma, {
      kioskId,
      day: addDays(startDay, index),
      meterVolume,
      reportedCash: options.cash ?? meterVolume * 2,
      expectedRevenue: options.stale ? 0 : meterVolume * 2,
      variance: 0,
      isAnomaly: false,
    }),
  );
}

// ───────────────────────────────────────────────────────────────────────────
//  Test suite
// ───────────────────────────────────────────────────────────────────────────

describe('Reconciliation API — Story ID 04 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createFakePrisma>;

  const originalUnitPriceEnv = process.env.WATER_UNIT_PRICE_PER_LITER;

  beforeAll(() => {
    // The default unit price (2 KES/L) is part of the contract under test.
    delete process.env.WATER_UNIT_PRICE_PER_LITER;
  });

  afterAll(() => {
    if (originalUnitPriceEnv === undefined) {
      delete process.env.WATER_UNIT_PRICE_PER_LITER;
    } else {
      process.env.WATER_UNIT_PRICE_PER_LITER = originalUnitPriceEnv;
    }
  });

  beforeEach(async () => {
    seedSequence = 0;
    prisma = createFakePrisma();
    prisma.kiosks.set('KIOSK-001', { id: 'KIOSK-001', status: 'ONLINE' });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Batch run recomputes and persists revenue + anomaly metrics
  // ─────────────────────────────────────────────────────────────────────────
  describe('POST /api/kiosk/reconciliation/run — batch computation and persistence', () => {
    it('recomputes revenue, variance, totals and anomalies and persists changed rows', async () => {
      // 7 stale history days at 100 L (cash 190 → −10 variance each), then a
      // 140 L spike day (cash 300 → +20 variance, +40 % volume → SPIKE).
      const history = seedHistory(prisma, 'KIOSK-001', {
        cash: 190,
        stale: true,
      });
      const target = seedLog(prisma, {
        kioskId: 'KIOSK-001',
        day: '2026-09-08',
        meterVolume: 140,
        reportedCash: 300,
      });

      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-001' })
        .expect(201);

      const summary = res.body;

      expect(summary.success).toBe(true);
      expect(summary.dryRun).toBe(false);
      expect(summary.unitPrice).toBe(2);
      expect(summary.baselineWindow).toBe(7);
      expect(summary.anomalyThreshold).toBe(0.3);
      expect(summary.filters).toEqual({
        kioskId: 'KIOSK-001',
        startDate: null,
        endDate: null,
      });
      expect(summary.processedCount).toBe(8);
      expect(summary.updatedCount).toBe(8);
      expect(summary.anomalyCount).toBe(1);
      expect(summary.varianceCount).toBe(8);
      expect(summary.shortfallCount).toBe(7);
      expect(summary.records).toHaveLength(8);
      expect(summary.anomalies).toHaveLength(1);

      // Totals: 840 L, 1630 cash, expected 1680, variance −50, ratio −50/1680.
      expect(summary.totals).toEqual({
        meterVolume: 840,
        reportedCash: 1630,
        expectedRevenue: 1680,
        variance: -50,
        discrepancyRatio: -0.029762,
        discrepancyPercentage: -2.98,
      });

      const records = summary.records as any[];
      const targetRecord = records.find((record) => record.id === target.id);
      expect(targetRecord).toMatchObject({
        meterVolume: 140,
        reportedCash: 300,
        expectedRevenue: 280,
        variance: 20,
        discrepancyRatio: 0.071429,
        discrepancyPercentage: 7.14,
        hasVariance: true,
        isCashShortfall: false,
        movingAverage: 100,
        baselineSampleSize: 7,
        baselineWindow: 7,
        deviation: 40,
        deviationRatio: 0.4,
        threshold: 0.3,
        isAnomaly: true,
        anomalyDirection: 'SPIKE',
        anomalyReason: 'SPIKE',
        changed: true,
      });
      expect(targetRecord.recordedAt).toBe(
        new Date('2026-09-08T10:00:00.000Z').toISOString(),
      );
      expect((summary.anomalies as any[]).map((record) => record.id)).toEqual([
        target.id,
      ]);

      // The first reading of a kiosk has no baseline and is never flagged.
      const firstRecord = records.find((record) => record.id === history[0].id);
      expect(firstRecord).toMatchObject({
        movingAverage: 0,
        baselineSampleSize: 0,
        isAnomaly: false,
        anomalyDirection: 'NONE',
        anomalyReason: 'INSUFFICIENT_BASELINE',
      });

      // Persisted rows now carry the server-computed values.
      expect(prisma.logs.find((log) => log.id === target.id)).toMatchObject({
        expectedRevenue: 280,
        variance: 20,
        isAnomaly: true,
      });
      expect(
        prisma.logs.find((log) => log.id === history[0].id),
      ).toMatchObject({
        expectedRevenue: 200,
        variance: -10,
        isAnomaly: false,
      });
    });

    it('honours an explicit unitPrice override end to end', async () => {
      const history = seedHistory(prisma, 'KIOSK-001');

      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-001', unitPrice: 2.5 })
        .expect(201);

      expect(res.body.unitPrice).toBe(2.5);
      expect(res.body.totals.expectedRevenue).toBe(7 * 100 * 2.5);
      expect(prisma.logs.find((log) => log.id === history[7 - 1].id)).toMatchObject(
        {
          expectedRevenue: 250,
          variance: -50,
        },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. ±30 % moving-average boundary through the API
  // ─────────────────────────────────────────────────────────────────────────
  describe('±30 % moving-average boundaries via the batch API', () => {
    interface BoundaryCase {
      kioskId: string;
      volume: number;
      expectedAnomaly: boolean;
      expectedDirection: 'SPIKE' | 'DROP' | 'NONE';
      expectedReason: 'SPIKE' | 'DROP' | 'WITHIN_THRESHOLD';
      expectedDeviation: number;
      expectedDeviationRatio: number;
    }

    const boundaryCases: BoundaryCase[] = [
      {
        kioskId: 'KIOSK-B1300',
        volume: 130.0,
        expectedAnomaly: false,
        expectedDirection: 'NONE',
        expectedReason: 'WITHIN_THRESHOLD',
        expectedDeviation: 30,
        expectedDeviationRatio: 0.3,
      },
      {
        kioskId: 'KIOSK-B1301',
        volume: 130.1,
        expectedAnomaly: true,
        expectedDirection: 'SPIKE',
        expectedReason: 'SPIKE',
        expectedDeviation: 30.1,
        expectedDeviationRatio: 0.301,
      },
      {
        kioskId: 'KIOSK-B700',
        volume: 70.0,
        expectedAnomaly: false,
        expectedDirection: 'NONE',
        expectedReason: 'WITHIN_THRESHOLD',
        expectedDeviation: -30,
        expectedDeviationRatio: 0.3,
      },
      {
        kioskId: 'KIOSK-B699',
        volume: 69.9,
        expectedAnomaly: true,
        expectedDirection: 'DROP',
        expectedReason: 'DROP',
        expectedDeviation: -30.1,
        expectedDeviationRatio: 0.301,
      },
    ];

    for (const testCase of boundaryCases) {
      it(`${testCase.kioskId}: ${testCase.volume} L against a 100 L baseline → anomaly=${String(testCase.expectedAnomaly)} (${testCase.expectedDirection})`, async () => {
        seedHistory(prisma, testCase.kioskId);
        const target = seedLog(prisma, {
          kioskId: testCase.kioskId,
          day: '2026-09-08',
          meterVolume: testCase.volume,
          reportedCash: testCase.volume * 2,
        });

        const res = await http()
          .post('/api/kiosk/reconciliation/run')
          .send({ kioskId: testCase.kioskId })
          .expect(201);

        expect(res.body.anomalyCount).toBe(testCase.expectedAnomaly ? 1 : 0);

        const records = res.body.records as any[];
        const record = records.find((entry) => entry.id === target.id);
        expect(record).toMatchObject({
          movingAverage: 100,
          baselineSampleSize: 7,
          baselineWindow: 7,
          threshold: 0.3,
          deviation: testCase.expectedDeviation,
          deviationRatio: testCase.expectedDeviationRatio,
          isAnomaly: testCase.expectedAnomaly,
          anomalyDirection: testCase.expectedDirection,
          anomalyReason: testCase.expectedReason,
        });
        expect((res.body.anomalies as any[]).map((entry) => entry.id)).toEqual(
          testCase.expectedAnomaly ? [target.id] : [],
        );
        expect(prisma.logs.find((log) => log.id === target.id)).toMatchObject({
          isAnomaly: testCase.expectedAnomaly,
        });
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. dryRun never writes
  // ─────────────────────────────────────────────────────────────────────────
  describe('dryRun', () => {
    it('returns computed results but leaves stored rows untouched', async () => {
      const history = seedHistory(prisma, 'KIOSK-001', { stale: true });
      const target = seedLog(prisma, {
        kioskId: 'KIOSK-001',
        day: '2026-09-08',
        meterVolume: 140,
        reportedCash: 300,
      });
      const storedBefore = prisma.logs.map((log) => ({
        id: log.id,
        expectedRevenue: log.expectedRevenue,
        variance: log.variance,
        isAnomaly: log.isAnomaly,
      }));

      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-001', dryRun: true })
        .expect(201);

      expect(res.body.dryRun).toBe(true);
      expect(res.body.updatedCount).toBe(0);
      expect(res.body.processedCount).toBe(8);
      expect(res.body.anomalyCount).toBe(1);

      // The report still contains what *would* change...
      const records = res.body.records as any[];
      expect(records.find((record) => record.id === target.id)).toMatchObject({
        expectedRevenue: 280,
        variance: 20,
        isAnomaly: true,
        changed: true,
      });
      expect(records.find((record) => record.id === history[0].id)).toMatchObject(
        { expectedRevenue: 200, changed: true },
      );

      // ...but nothing is written.
      expect(prisma.dailyLog.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(
        prisma.logs.map((log) => ({
          id: log.id,
          expectedRevenue: log.expectedRevenue,
          variance: log.variance,
          isAnomaly: log.isAnomaly,
        })),
      ).toEqual(storedBefore);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Request validation
  // ─────────────────────────────────────────────────────────────────────────
  describe('POST /api/kiosk/reconciliation/run — validation', () => {
    it('rejects startDate > endDate with 400 and the spec message', async () => {
      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ startDate: '2026-11-01', endDate: '2026-10-01' })
        .expect(400);

      expect(res.body.message).toContain(
        'startDate must not be after endDate',
      );
    });

    it('rejects an out-of-range window with 400', async () => {
      const tooSmall = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ window: 0 })
        .expect(400);
      expect(tooSmall.body.message).toContain('window must be at least 1');

      const tooLarge = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ window: 999 })
        .expect(400);
      expect(tooLarge.body.message).toContain('window must not exceed 365');
    });

    it('rejects invalid date strings with 400', async () => {
      await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ startDate: 'not-a-date' })
        .expect(400);

      await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ date: '2026-13-45' })
        .expect(400);
    });

    it('date shorthand processes only that single whole UTC day', async () => {
      const before = seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-10-30',
        meterVolume: 100,
        reportedCash: 200,
      });
      const morning = seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-10-31',
        hour: 10,
        meterVolume: 100,
        reportedCash: 200,
      });
      const evening = seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-10-31',
        hour: 14,
        meterVolume: 120,
        reportedCash: 240,
      });
      seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-11-01',
        meterVolume: 100,
        reportedCash: 200,
      });

      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-DATE', date: '2026-10-31' })
        .expect(201);

      expect(res.body.processedCount).toBe(2);
      expect(res.body.filters.startDate).toBe('2026-10-31T00:00:00.000Z');
      expect(res.body.filters.endDate).toBe('2026-10-31T23:59:59.999Z');
      const ids = (res.body.records as any[]).map((record) => record.id);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([morning.id, evening.id]));
      expect(ids).not.toContain(before.id);
    });

    it('a date-only endDate includes the whole UTC day', async () => {
      seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-10-30',
        meterVolume: 100,
        reportedCash: 200,
      });
      seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-10-31',
        hour: 10,
        meterVolume: 100,
        reportedCash: 200,
      });
      seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-10-31',
        hour: 14,
        meterVolume: 100,
        reportedCash: 200,
      });
      seedLog(prisma, {
        kioskId: 'KIOSK-DATE',
        day: '2026-11-01',
        meterVolume: 100,
        reportedCash: 200,
      });

      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({
          kioskId: 'KIOSK-DATE',
          startDate: '2026-10-30',
          endDate: '2026-10-31',
        })
        .expect(201);

      expect(res.body.processedCount).toBe(3);
      expect(res.body.filters.endDate).toBe('2026-10-31T23:59:59.999Z');
      expect(
        (res.body.records as any[]).map((record) => record.recordedAt),
      ).toContain('2026-10-31T14:00:00.000Z');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Enriched GET /api/kiosk/reconciliation
  // ─────────────────────────────────────────────────────────────────────────
  describe('GET /api/kiosk/reconciliation', () => {
    it('returns only flagged records with server-computed metrics and response metadata', async () => {
      seedHistory(prisma, 'KIOSK-001');
      const target = seedLog(prisma, {
        kioskId: 'KIOSK-001',
        day: '2026-09-08',
        meterVolume: 140,
        reportedCash: 300,
      });

      // The daily batch is authoritative for isAnomaly.
      await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-001' })
        .expect(201);

      const all = await http()
        .get('/api/kiosk/reconciliation')
        .query({ kioskId: 'KIOSK-001' })
        .expect(200);

      // Existing (count, records) shape preserved + new metadata.
      expect(all.body.count).toBe(8);
      expect(all.body.unitPrice).toBe(2);
      expect(all.body.anomalyThreshold).toBe(0.3);
      expect(Array.isArray(all.body.records)).toBe(true);
      expect(all.body.records).toHaveLength(8);

      const flagged = await http()
        .get('/api/kiosk/reconciliation')
        .query({ kioskId: 'KIOSK-001', isAnomaly: 'true' })
        .expect(200);

      expect(flagged.body.count).toBe(1);
      expect(flagged.body.records).toHaveLength(1);
      const record = (flagged.body.records as any[])[0];
      expect(record.id).toBe(target.id);
      expect(record.isAnomaly).toBe(true);
      expect(record).toMatchObject({
        meterVolume: 140,
        reportedCash: 300,
        expectedRevenue: 280,
        variance: 20,
        // Recomputed from stored meterVolume/reportedCash: 20 / 280.
        discrepancyRatio: 0.071429,
        discrepancyPercentage: 7.14,
        hasVariance: true,
        isCashShortfall: false,
      });
    });

    it('computes the discrepancy metrics server-side instead of trusting stored values', async () => {
      // Stored values are deliberately wrong; the API must recompute from
      // meterVolume (100 L × 2 = 200) and reportedCash (200) → no variance.
      seedLog(prisma, {
        kioskId: 'KIOSK-005',
        day: '2026-09-01',
        meterVolume: 100,
        reportedCash: 200,
        expectedRevenue: 999,
        variance: -999,
        isAnomaly: false,
      });

      const res = await http()
        .get('/api/kiosk/reconciliation')
        .query({ kioskId: 'KIOSK-005' })
        .expect(200);

      expect(res.body.count).toBe(1);
      const record = (res.body.records as any[])[0];
      expect(record.expectedRevenue).toBe(999); // stored field is preserved
      expect(record).toMatchObject({
        discrepancyRatio: 0,
        discrepancyPercentage: 0,
        hasVariance: false,
        isCashShortfall: false,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Idempotency
  // ─────────────────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('reports updatedCount 0 when the same batch is run twice', async () => {
      seedHistory(prisma, 'KIOSK-003', { stale: true });

      const first = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-003' })
        .expect(201);
      expect(first.body.updatedCount).toBe(7);

      const second = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({ kioskId: 'KIOSK-003' })
        .expect(201);
      expect(second.body.updatedCount).toBe(0);
      expect(second.body.processedCount).toBe(7);
      expect(second.body.success).toBe(true);
      expect(
        (second.body.records as any[]).every((record) => !record.changed),
      ).toBe(true);
      expect(second.body.totals).toEqual(first.body.totals);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Empty database
  // ─────────────────────────────────────────────────────────────────────────
  describe('empty database', () => {
    it('returns an empty, zeroed summary instead of throwing', async () => {
      const res = await http()
        .post('/api/kiosk/reconciliation/run')
        .send({})
        .expect(201);

      expect(res.body).toMatchObject({
        success: true,
        dryRun: false,
        unitPrice: 2,
        baselineWindow: 7,
        anomalyThreshold: 0.3,
        processedCount: 0,
        updatedCount: 0,
        anomalyCount: 0,
        varianceCount: 0,
        shortfallCount: 0,
        records: [],
        anomalies: [],
      });
      expect(res.body.filters).toEqual({
        kioskId: null,
        startDate: null,
        endDate: null,
      });
      expect(res.body.totals).toEqual({
        meterVolume: 0,
        reportedCash: 0,
        expectedRevenue: 0,
        variance: 0,
        discrepancyRatio: 0,
        discrepancyPercentage: 0,
      });
      expect(prisma.dailyLog.update).not.toHaveBeenCalled();

      const getRes = await http()
        .get('/api/kiosk/reconciliation')
        .expect(200);
      expect(getRes.body.count).toBe(0);
      expect(getRes.body.records).toEqual([]);
      expect(getRes.body.unitPrice).toBe(2);
      expect(getRes.body.anomalyThreshold).toBe(0.3);
    });
  });
});
