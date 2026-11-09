import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  BATCH_CHUNK_SIZE,
  ReconciliationService,
  endOfUtcDay,
  millisecondsUntilNextUtcBatch,
  startOfUtcDay,
  type BatchSourceLog,
} from './reconciliation.service';

// ───────────────────────────────────────────────────────────
//  Story ID 04 – Daily batch reconciliation engine unit tests.
//
//  PrismaService is mocked entirely: these tests never touch PostgreSQL.
//  The fake client honours the `where`/`orderBy` contract the service uses and
//  mutates an in-memory log table on `update`, which lets the idempotency and
//  "only changed rows" semantics be exercised for real.
// ───────────────────────────────────────────────────────────

interface WhereClause {
  kioskId?: string | { in: string[] };
  recordedAt?: { gte?: Date; lte?: Date };
}

interface FakePrisma {
  logs: BatchSourceLog[];
  dailyLog: {
    findMany: jest.Mock;
    update: jest.Mock;
  };
  findMany: jest.Mock;
  update: jest.Mock;
  $transaction?: jest.Mock;
}

const ORDER_BY = [
  { kioskId: 'asc' },
  { recordedAt: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

function compareLogs(a: BatchSourceLog, b: BatchSourceLog): number {
  if (a.kioskId !== b.kioskId) return a.kioskId < b.kioskId ? -1 : 1;
  const recordedDiff = a.recordedAt.getTime() - b.recordedAt.getTime();
  if (recordedDiff !== 0) return recordedDiff;
  const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function matchesWhere(log: BatchSourceLog, where: WhereClause = {}): boolean {
  if (typeof where.kioskId === 'string' && log.kioskId !== where.kioskId) {
    return false;
  }
  if (
    where.kioskId !== undefined &&
    typeof where.kioskId === 'object' &&
    !where.kioskId.in.includes(log.kioskId)
  ) {
    return false;
  }
  if (
    where.recordedAt?.gte !== undefined &&
    log.recordedAt.getTime() < where.recordedAt.gte.getTime()
  ) {
    return false;
  }
  if (
    where.recordedAt?.lte !== undefined &&
    log.recordedAt.getTime() > where.recordedAt.lte.getTime()
  ) {
    return false;
  }
  return true;
}

function createFakePrisma(
  seed: BatchSourceLog[] = [],
  options: { withTransaction?: boolean } = {},
): FakePrisma {
  const logs = seed.map((log) => ({ ...log }));

  const findMany = jest.fn(
    async ({ where }: { where?: WhereClause } = {}) =>
      logs
        .filter((log) => matchesWhere(log, where))
        .sort(compareLogs)
        .map((log) => ({ ...log })),
  );

  const update = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<BatchSourceLog>;
    }) => {
      const log = logs.find((entry) => entry.id === where.id);
      if (!log) throw new Error(`Unknown daily log: ${where.id}`);
      Object.assign(log, data);
      return { ...log };
    },
  );

  const fake: FakePrisma = {
    logs,
    dailyLog: { findMany, update },
    findMany,
    update,
  };

  if (options.withTransaction !== false) {
    fake.$transaction = jest.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );
  }

  return fake;
}

function createService(fake: FakePrisma): ReconciliationService {
  return new ReconciliationService(fake as unknown as PrismaService);
}

let rowCounter = 0;

interface LogOverrides {
  id?: string;
  transactionId?: string;
  kioskId: string;
  meterVolume: number;
  recordedAt: string | Date;
  reportedCash?: number;
  expectedRevenue?: number;
  variance?: number;
  isAnomaly?: boolean;
  createdAt?: Date;
}

/** Builds a stored DailyLog row; unset reconciliation columns are "stale" 0s. */
function makeLog(overrides: LogOverrides): BatchSourceLog {
  rowCounter += 1;
  const recordedAt =
    overrides.recordedAt instanceof Date
      ? overrides.recordedAt
      : new Date(overrides.recordedAt);

  return {
    id: overrides.id ?? `log-${rowCounter}`,
    transactionId: overrides.transactionId ?? `TXN-${rowCounter}`,
    kioskId: overrides.kioskId,
    meterVolume: overrides.meterVolume,
    reportedCash: overrides.reportedCash ?? overrides.meterVolume * 2,
    expectedRevenue: overrides.expectedRevenue ?? 0,
    variance: overrides.variance ?? 0,
    isAnomaly: overrides.isAnomaly ?? false,
    recordedAt,
    createdAt: overrides.createdAt ?? recordedAt,
  };
}

/** Seven consecutive daily 100 L logs for a kiosk (a clean 100 L baseline). */
function baselineHistory(
  kioskId: string,
  volumes: number[] = [100, 100, 100, 100, 100, 100, 100],
): BatchSourceLog[] {
  return volumes.map((meterVolume, index) =>
    makeLog({
      kioskId,
      meterVolume,
      recordedAt: `2026-11-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    }),
  );
}

describe('ReconciliationService (Story 04, unit)', () => {
  afterEach(() => {
    delete process.env.RECONCILIATION_BATCH_ENABLED;
  });

  // ─── Revenue metrics + persistence ───────────────────────

  describe('runBatch – metrics and persistence', () => {
    it('computes server-side revenue, discrepancy and moving-average anomaly for the spec example', async () => {
      const fake = createFakePrisma([
        ...baselineHistory('KIOSK-001'),
        makeLog({
          id: 'target-1',
          transactionId: 'TXN-TARGET-1',
          kioskId: 'KIOSK-001',
          meterVolume: 200,
          reportedCash: 300,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T12:00:00.000Z'),
      });

      expect(summary.success).toBe(true);
      expect(summary.dryRun).toBe(false);
      expect(summary.unitPrice).toBe(2);
      expect(summary.baselineWindow).toBe(7);
      expect(summary.anomalyThreshold).toBe(0.3);
      expect(summary.processedCount).toBe(1);
      expect(summary.updatedCount).toBe(1);
      expect(summary.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(summary.filters).toEqual({
        kioskId: null,
        startDate: '2026-11-08T00:00:00.000Z',
        endDate: '2026-11-08T23:59:59.999Z',
      });

      const record = summary.records[0];
      expect(record).toMatchObject({
        id: 'target-1',
        transactionId: 'TXN-TARGET-1',
        kioskId: 'KIOSK-001',
        recordedAt: '2026-11-08T10:00:00.000Z',
        meterVolume: 200,
        reportedCash: 300,
        expectedRevenue: 400,
        variance: -100,
        discrepancyRatio: -0.25,
        discrepancyPercentage: -25,
        hasVariance: true,
        isCashShortfall: true,
        movingAverage: 100,
        baselineSampleSize: 7,
        baselineWindow: 7,
        deviation: 100,
        deviationRatio: 1,
        threshold: 0.3,
        isAnomaly: true,
        anomalyDirection: 'SPIKE',
        anomalyReason: 'SPIKE',
        changed: true,
      });
      expect(summary.anomalies).toEqual([record]);
      expect(summary.anomalyCount).toBe(1);
      expect(summary.varianceCount).toBe(1);
      expect(summary.shortfallCount).toBe(1);

      // The target query uses the deterministic chronological ordering.
      expect(fake.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: ORDER_BY }),
      );

      expect(fake.update).toHaveBeenCalledTimes(1);
      expect(fake.update).toHaveBeenCalledWith({
        where: { id: 'target-1' },
        data: {
          expectedRevenue: 400,
          variance: -100,
          isAnomaly: true,
        },
      });
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });

    it('persists only rows whose stored reconciliation values changed', async () => {
      const fake = createFakePrisma([
        ...baselineHistory('KIOSK-001'),
        // Stale row: stored values are wrong and must be corrected.
        makeLog({
          id: 'stale-row',
          kioskId: 'KIOSK-001',
          meterVolume: 100,
          reportedCash: 200,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
        // Already correct row: expected 260, variance 0, 30 % above the
        // 100 L baseline (exactly at the boundary, so not an anomaly).
        makeLog({
          id: 'correct-row',
          kioskId: 'KIOSK-001',
          meterVolume: 130,
          reportedCash: 260,
          expectedRevenue: 260,
          variance: 0,
          isAnomaly: false,
          recordedAt: '2026-11-08T11:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
      });

      expect(summary.processedCount).toBe(2);
      expect(summary.updatedCount).toBe(1);
      expect(summary.records.map((record) => record.changed)).toEqual([
        true,
        false,
      ]);
      expect(fake.update).toHaveBeenCalledTimes(1);
      expect(fake.update).toHaveBeenCalledWith({
        where: { id: 'stale-row' },
        data: { expectedRevenue: 200, variance: 0, isAnomaly: false },
      });
    });

    it('is idempotent: an identical second run updates nothing', async () => {
      const fake = createFakePrisma([
        ...baselineHistory('KIOSK-001'),
        makeLog({
          kioskId: 'KIOSK-001',
          meterVolume: 200,
          reportedCash: 300,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);
      const options = { date: new Date('2026-11-08T00:00:00.000Z') };

      const first = await service.runBatch(options);
      const second = await service.runBatch(options);

      expect(first.updatedCount).toBe(1);
      expect(second.updatedCount).toBe(0);
      expect(second.records[0].changed).toBe(false);
      // No writes at all on the second run (history rows were never targets).
      expect(fake.update).toHaveBeenCalledTimes(1);
      expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });

    it('writes in transaction chunks of at most 100 updates', async () => {
      const targets = Array.from({ length: 150 }, (_value, index) =>
        makeLog({
          id: `bulk-${String(index).padStart(3, '0')}`,
          kioskId: 'KIOSK-BULK',
          meterVolume: 100,
          recordedAt: '2026-11-08T10:00:00.000Z',
          createdAt: new Date(
            Date.parse('2026-11-08T10:00:00.000Z') + index,
          ),
        }),
      );
      const fake = createFakePrisma(targets);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
      });

      expect(summary.processedCount).toBe(150);
      expect(summary.updatedCount).toBe(150);
      expect(fake.update).toHaveBeenCalledTimes(150);
      expect(fake.$transaction).toHaveBeenCalledTimes(2);
      expect((fake.$transaction!.mock.calls[0][0] as unknown[]).length).toBe(
        BATCH_CHUNK_SIZE,
      );
      expect((fake.$transaction!.mock.calls[1][0] as unknown[]).length).toBe(50);
    });

    it('falls back to Promise.all when the Prisma client has no $transaction', async () => {
      const fake = createFakePrisma(
        [
          makeLog({
            kioskId: 'KIOSK-001',
            meterVolume: 200,
            reportedCash: 300,
            recordedAt: '2026-11-08T10:00:00.000Z',
          }),
        ],
        { withTransaction: false },
      );
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
      });

      expect(summary.updatedCount).toBe(1);
      expect(fake.update).toHaveBeenCalledTimes(1);
      expect(fake.$transaction).toBeUndefined();
    });
  });

  // ─── Filters and dry run ─────────────────────────────────

  describe('runBatch – filters and dry run', () => {
    it('does not write anything on a dry run but reports what would change', async () => {
      const fake = createFakePrisma([
        makeLog({
          id: 'dry-target',
          kioskId: 'KIOSK-001',
          meterVolume: 200,
          reportedCash: 300,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
        dryRun: true,
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.updatedCount).toBe(0);
      expect(summary.records[0].changed).toBe(true);
      expect(summary.records[0].expectedRevenue).toBe(400);
      expect(fake.update).not.toHaveBeenCalled();
      expect(fake.$transaction).not.toHaveBeenCalled();
      // The stored row is untouched.
      expect(fake.logs[0].expectedRevenue).toBe(0);
    });

    it('applies kioskId and explicit startDate/endDate filters', async () => {
      const fake = createFakePrisma([
        makeLog({
          id: 'a-1',
          kioskId: 'KIOSK-A',
          meterVolume: 100,
          recordedAt: '2026-11-01T10:00:00.000Z',
        }),
        makeLog({
          id: 'a-2',
          kioskId: 'KIOSK-A',
          meterVolume: 100,
          recordedAt: '2026-11-02T10:00:00.000Z',
        }),
        makeLog({
          id: 'a-3',
          kioskId: 'KIOSK-A',
          meterVolume: 100,
          recordedAt: '2026-11-03T10:00:00.000Z',
        }),
        makeLog({
          id: 'a-4',
          kioskId: 'KIOSK-A',
          meterVolume: 100,
          recordedAt: '2026-11-04T10:00:00.000Z',
        }),
        makeLog({
          id: 'b-2',
          kioskId: 'KIOSK-B',
          meterVolume: 50,
          recordedAt: '2026-11-02T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        kioskId: 'KIOSK-A',
        startDate: new Date('2026-11-02T00:00:00.000Z'),
        endDate: new Date('2026-11-03T23:59:59.999Z'),
      });

      expect(summary.processedCount).toBe(2);
      expect(summary.records.map((record) => record.id)).toEqual([
        'a-2',
        'a-3',
      ]);
      expect(summary.filters).toEqual({
        kioskId: 'KIOSK-A',
        startDate: '2026-11-02T00:00:00.000Z',
        endDate: '2026-11-03T23:59:59.999Z',
      });
    });

    it('treats `date` as the whole UTC day (00:00:00.000Z … 23:59:59.999Z)', async () => {
      const fake = createFakePrisma([
        makeLog({
          id: 'early',
          kioskId: 'KIOSK-001',
          meterVolume: 100,
          recordedAt: '2026-11-08T00:00:00.000Z',
        }),
        makeLog({
          id: 'late',
          kioskId: 'KIOSK-001',
          meterVolume: 100,
          recordedAt: '2026-11-08T23:59:59.999Z',
        }),
        makeLog({
          id: 'next-day',
          kioskId: 'KIOSK-001',
          meterVolume: 100,
          recordedAt: '2026-11-09T00:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T12:00:00.000Z'),
        dryRun: true,
      });

      expect(summary.processedCount).toBe(2);
      expect(summary.records.map((record) => record.id)).toEqual([
        'early',
        'late',
      ]);
      expect(summary.filters).toEqual({
        kioskId: null,
        startDate: '2026-11-08T00:00:00.000Z',
        endDate: '2026-11-08T23:59:59.999Z',
      });
      expect(startOfUtcDay(new Date('2026-11-08T12:00:00.000Z'))).toEqual(
        new Date('2026-11-08T00:00:00.000Z'),
      );
      expect(endOfUtcDay(new Date('2026-11-08T12:00:00.000Z'))).toEqual(
        new Date('2026-11-08T23:59:59.999Z'),
      );
    });

    it('rejects a startDate after the endDate', async () => {
      const service = createService(createFakePrisma([]));

      await expect(
        service.runBatch({
          startDate: new Date('2026-11-10T00:00:00.000Z'),
          endDate: new Date('2026-11-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.runBatch({
          startDate: new Date('2026-11-10T00:00:00.000Z'),
          endDate: new Date('2026-11-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow('startDate must not be after endDate');
    });

    it('returns a zeroed summary (without throwing) when no logs match', async () => {
      const fake = createFakePrisma([]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
      });

      expect(summary.processedCount).toBe(0);
      expect(summary.updatedCount).toBe(0);
      expect(summary.anomalyCount).toBe(0);
      expect(summary.varianceCount).toBe(0);
      expect(summary.shortfallCount).toBe(0);
      expect(summary.records).toEqual([]);
      expect(summary.anomalies).toEqual([]);
      expect(summary.totals).toEqual({
        meterVolume: 0,
        reportedCash: 0,
        expectedRevenue: 0,
        variance: 0,
        discrepancyRatio: 0,
        discrepancyPercentage: 0,
      });
      expect(fake.update).not.toHaveBeenCalled();
      // Baselines are not fetched when there is nothing to reconcile.
      expect(fake.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Baselines ───────────────────────────────────────────

  describe('runBatch – moving-average baselines', () => {
    it('uses the previous window logs of the same kiosk, in chronological order', async () => {
      const fake = createFakePrisma([
        ...baselineHistory('KIOSK-A', [90, 95, 100, 105, 110]),
        makeLog({
          id: 'a-target',
          kioskId: 'KIOSK-A',
          meterVolume: 100,
          recordedAt: '2026-11-06T10:00:00.000Z',
        }),
        ...baselineHistory('KIOSK-B', [8, 9, 10, 11, 12]),
        makeLog({
          id: 'b-target',
          kioskId: 'KIOSK-B',
          meterVolume: 10,
          recordedAt: '2026-11-06T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-06T00:00:00.000Z'),
        window: 3,
        dryRun: true,
      });

      expect(summary.baselineWindow).toBe(3);
      expect(summary.processedCount).toBe(2);

      const aTarget = summary.records.find((record) => record.id === 'a-target');
      const bTarget = summary.records.find((record) => record.id === 'b-target');

      // KIOSK-A last three volumes: 100, 105, 110 → 105.
      expect(aTarget).toMatchObject({
        movingAverage: 105,
        baselineSampleSize: 3,
        baselineWindow: 3,
        isAnomaly: false,
        anomalyReason: 'WITHIN_THRESHOLD',
      });
      // KIOSK-B last three volumes: 10, 11, 12 → 11 (per-kiosk baseline).
      expect(bTarget).toMatchObject({
        movingAverage: 11,
        baselineSampleSize: 3,
        baselineWindow: 3,
        isAnomaly: false,
        anomalyReason: 'WITHIN_THRESHOLD',
      });
    });

    it('does not flag exactly ±30.0 % but flags ±30.1 % (strict > threshold)', async () => {
      const fake = createFakePrisma([
        ...baselineHistory('KIOSK-SPIKE-EDGE'),
        makeLog({
          id: 'spike-edge',
          kioskId: 'KIOSK-SPIKE-EDGE',
          meterVolume: 130,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
        ...baselineHistory('KIOSK-SPIKE-OVER'),
        makeLog({
          id: 'spike-over',
          kioskId: 'KIOSK-SPIKE-OVER',
          meterVolume: 130.1,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
        ...baselineHistory('KIOSK-DROP-EDGE'),
        makeLog({
          id: 'drop-edge',
          kioskId: 'KIOSK-DROP-EDGE',
          meterVolume: 70,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
        ...baselineHistory('KIOSK-DROP-OVER'),
        makeLog({
          id: 'drop-over',
          kioskId: 'KIOSK-DROP-OVER',
          meterVolume: 69.9,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
        dryRun: true,
      });

      const byId = new Map(summary.records.map((record) => [record.id, record]));

      expect(byId.get('spike-edge')).toMatchObject({
        movingAverage: 100,
        isAnomaly: false,
        anomalyDirection: 'NONE',
        anomalyReason: 'WITHIN_THRESHOLD',
      });
      expect(byId.get('drop-edge')).toMatchObject({
        movingAverage: 100,
        isAnomaly: false,
        anomalyDirection: 'NONE',
        anomalyReason: 'WITHIN_THRESHOLD',
      });
      expect(byId.get('spike-over')).toMatchObject({
        deviation: 30.1,
        isAnomaly: true,
        anomalyDirection: 'SPIKE',
        anomalyReason: 'SPIKE',
      });
      expect(byId.get('drop-over')).toMatchObject({
        deviation: -30.1,
        isAnomaly: true,
        anomalyDirection: 'DROP',
        anomalyReason: 'DROP',
      });

      expect(summary.anomalyCount).toBe(2);
      expect(summary.anomalies.map((record) => record.id).sort()).toEqual([
        'drop-over',
        'spike-over',
      ]);
    });

    it('flags any non-zero volume when every previous volume was zero', async () => {
      const fake = createFakePrisma([
        ...baselineHistory('KIOSK-DORMANT', [0, 0, 0, 0, 0, 0, 0]),
        makeLog({
          id: 'dormant-spike',
          kioskId: 'KIOSK-DORMANT',
          meterVolume: 50,
          reportedCash: 100,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
        ...baselineHistory('KIOSK-STILL', [0, 0, 0, 0, 0, 0, 0]),
        makeLog({
          id: 'still-zero',
          kioskId: 'KIOSK-STILL',
          meterVolume: 0,
          reportedCash: 0,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
        dryRun: true,
      });

      const byId = new Map(summary.records.map((record) => [record.id, record]));

      expect(byId.get('dormant-spike')).toMatchObject({
        movingAverage: 0,
        baselineSampleSize: 7,
        deviationRatio: null,
        isAnomaly: true,
        anomalyDirection: 'SPIKE',
        anomalyReason: 'ZERO_BASELINE',
      });
      expect(byId.get('still-zero')).toMatchObject({
        movingAverage: 0,
        isAnomaly: false,
        anomalyDirection: 'NONE',
        anomalyReason: 'ZERO_BASELINE',
      });
      expect(summary.anomalyCount).toBe(1);
    });

    it('reports a zeroed baseline when the kiosk has no earlier history', async () => {
      const fake = createFakePrisma([
        makeLog({
          id: 'first-ever',
          kioskId: 'KIOSK-NEW',
          meterVolume: 10,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
        dryRun: true,
      });

      expect(summary.records[0]).toMatchObject({
        movingAverage: 0,
        baselineSampleSize: 0,
        deviation: 0,
        deviationRatio: null,
        isAnomaly: false,
        anomalyDirection: 'NONE',
        anomalyReason: 'INSUFFICIENT_BASELINE',
      });
    });
  });

  // ─── Totals ──────────────────────────────────────────────

  describe('runBatch – totals', () => {
    it('aggregates volume, cash, revenue and variance with a guarded discrepancy ratio', async () => {
      const fake = createFakePrisma([
        makeLog({
          id: 'spec-log',
          kioskId: 'KIOSK-001',
          meterVolume: 500,
          reportedCash: 950,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
        makeLog({
          id: 'balanced-log',
          kioskId: 'KIOSK-002',
          meterVolume: 100,
          reportedCash: 200,
          recordedAt: '2026-11-08T10:00:00.000Z',
        }),
      ]);
      const service = createService(fake);

      const summary = await service.runBatch({
        date: new Date('2026-11-08T00:00:00.000Z'),
        dryRun: true,
      });

      expect(summary.totals).toEqual({
        meterVolume: 600,
        reportedCash: 1150,
        expectedRevenue: 1200,
        variance: -50,
        // -50 / 1200 = -0.041666… → -0.041667
        discrepancyRatio: -0.041667,
        discrepancyPercentage: -4.17,
      });
      expect(summary.varianceCount).toBe(1);
      expect(summary.shortfallCount).toBe(1);
      expect(summary.anomalyCount).toBe(0);
    });
  });

  // ─── Scheduler ───────────────────────────────────────────

  describe('optional daily scheduler', () => {
    it('computes the delay to the next 00:15 UTC run', () => {
      expect(
        millisecondsUntilNextUtcBatch(new Date('2026-11-09T12:00:00.000Z')),
      ).toBe(12 * 60 * 60 * 1000 + 15 * 60 * 1000);
      expect(
        millisecondsUntilNextUtcBatch(new Date('2026-11-09T00:10:00.000Z')),
      ).toBe(5 * 60 * 1000);
      // Exactly at the run time → schedule tomorrow (never a 0 ms loop).
      expect(
        millisecondsUntilNextUtcBatch(new Date('2026-11-09T00:15:00.000Z')),
      ).toBe(24 * 60 * 60 * 1000);
    });

    it('stays disabled by default and never schedules under NODE_ENV=test', () => {
      expect(process.env.NODE_ENV).toBe('test');
      const service = createService(createFakePrisma([]));

      service.onModuleInit();
      expect(
        (
          service as unknown as {
            batchTimer?: NodeJS.Timeout;
          }
        ).batchTimer,
      ).toBeUndefined();

      process.env.RECONCILIATION_BATCH_ENABLED = 'true';
      service.onModuleInit();
      expect(
        (
          service as unknown as {
            batchTimer?: NodeJS.Timeout;
          }
        ).batchTimer,
      ).toBeUndefined();

      service.onModuleDestroy();
    });
  });
});
