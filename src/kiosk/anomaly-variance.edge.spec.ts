import { PrismaService } from '../prisma.service';
import {
  UNIT_PRICE_ENV_VAR,
  calculateReconciliation,
} from './reconciliation';
import {
  BASELINE_WINDOW_ENV_VAR,
  evaluateVolumeAnomaly,
} from './volume-anomaly';
import {
  ReconciliationService,
  type BatchRecordResult,
  type BatchSourceLog,
} from './reconciliation.service';

// ───────────────────────────────────────────────────────────
//  Story 04 – Interpret Data (Owner: Earn)
//  Unit and boundary tests for ±30 % moving-average anomaly detection
//  and the revenue variance formulas.
//
//  Complements `reconciliation.boundary.spec.ts` and
//  `reconciliation.service.spec.ts`, which check the ±30 % boundaries
//  against a single uniform 100 L baseline. This suite checks the same
//  rule where it is easier to get wrong:
//    - many baseline sizes, from 1 L to 12 345.67 L, in both directions
//    - uneven histories, drifting baselines and the 7-entry window edge
//    - partly-zero baselines and drops to 0 L
//    - one-cent boundaries of the variance formula
//    - ±29.9 % / ±30.0 % / ±30.1 % through the daily batch engine
//
//  Spec rule: isAnomaly = |Current Volume − Moving Avg| > 0.30 × Moving Avg
//
//  Pure Jest unit tests: no database, Prisma is an in-memory fake.
//
//  Tests marked `it.failing` describe behaviour the current code does not meet
//  yet (see the KNOWN GAP comment above each). They pass while the gap exists;
//  once the code is fixed they start failing, as a reminder to switch them to `it`.
// ───────────────────────────────────────────────────────────

/** Seven equal readings: a moving average of exactly `average`. */
const flatHistory = (average: number, length = 7) =>
  Array.from({ length }, () => average);

/** Rounds away binary noise so table values read as written (e.g. 130.1). */
const at = (average: number, percent: number) =>
  Number((average * (1 + percent / 100)).toFixed(6));

describe('Story 04 – anomaly & variance edge cases (Earn)', () => {
  const savedEnv = {
    window: process.env[BASELINE_WINDOW_ENV_VAR],
    price: process.env[UNIT_PRICE_ENV_VAR],
  };

  // Keep results independent of the developer's .env
  beforeEach(() => {
    delete process.env[BASELINE_WINDOW_ENV_VAR];
    delete process.env[UNIT_PRICE_ENV_VAR];
  });

  afterAll(() => {
    if (savedEnv.window === undefined) delete process.env[BASELINE_WINDOW_ENV_VAR];
    else process.env[BASELINE_WINDOW_ENV_VAR] = savedEnv.window;
    if (savedEnv.price === undefined) delete process.env[UNIT_PRICE_ENV_VAR];
    else process.env[UNIT_PRICE_ENV_VAR] = savedEnv.price;
  });

  // ─────────────────────────────────────────────────────────
  //  ±29.9 % / ±30.0 % / ±30.1 % across baseline sizes
  // ─────────────────────────────────────────────────────────
  describe('±30 % boundary holds for every baseline size', () => {
    const AVERAGES = [1, 7.5, 55.5, 100, 250, 999.99, 12345.67];

    const cases: [number, number, boolean, string][] = AVERAGES.flatMap(
      (average) => [
        [average, +29.9, false, 'NONE'],
        [average, +30.0, false, 'NONE'],
        [average, +30.1, true, 'SPIKE'],
        [average, -29.9, false, 'NONE'],
        [average, -30.0, false, 'NONE'],
        [average, -30.1, true, 'DROP'],
      ],
    );

    it.each(cases)(
      'moving average %p L with a %p %% change → isAnomaly %p (%s)',
      (average, percent, expected, direction) => {
        const result = evaluateVolumeAnomaly(
          at(average, percent),
          flatHistory(average),
        );

        expect(result.movingAverage).toBe(average);
        expect(result.isAnomaly).toBe(expected);
        expect(result.direction).toBe(direction);
      },
    );

    it('reports the ±30 % bounds of the moving average', () => {
      const result = evaluateVolumeAnomaly(100, flatHistory(250));

      expect(result.upperBound).toBe(325);
      expect(result.lowerBound).toBe(175);
      expect(result.threshold).toBe(0.3);
    });

    it('reports the deviation ratio used for the decision', () => {
      expect(evaluateVolumeAnomaly(130.1, flatHistory(100)).deviationRatio).toBeCloseTo(0.301, 6);
      expect(evaluateVolumeAnomaly(69.9, flatHistory(100)).deviationRatio).toBeCloseTo(0.301, 6);
      expect(evaluateVolumeAnomaly(129.9, flatHistory(100)).deviationRatio).toBeCloseTo(0.299, 6);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  The moving average itself
  // ─────────────────────────────────────────────────────────
  describe('boundary against a real (uneven) moving average', () => {
    // Mean of these seven readings is exactly 100 L.
    const UNEVEN = [80, 90, 100, 110, 120, 95, 105];

    it.each<[number, boolean]>([
      [129.9, false],
      [130, false],
      [130.1, true],
      [70.1, false],
      [70, false],
      [69.9, true],
    ])('uneven history averaging 100 L, current %p L → isAnomaly %p', (current, expected) => {
      const result = evaluateVolumeAnomaly(current, UNEVEN);

      expect(result.movingAverage).toBe(100);
      expect(result.isAnomaly).toBe(expected);
    });

    it('uses only the last 7 entries: an older outlier does not move the boundary', () => {
      // 8 entries; the oldest (1000 L) is outside the default window of 7.
      const history = [1000, ...flatHistory(100)];

      expect(evaluateVolumeAnomaly(130.1, history)).toMatchObject({
        movingAverage: 100,
        baselineSampleSize: 7,
        isAnomaly: true,
      });
    });

    it('the same outlier inside a window of 8 lifts the average and clears the flag', () => {
      const history = [1000, ...flatHistory(100)];

      // (1000 + 7 × 100) / 8 = 212.5 → 130.1 L is a −38.8 % DROP instead
      expect(evaluateVolumeAnomaly(130.1, history, { window: 8 })).toMatchObject({
        movingAverage: 212.5,
        baselineSampleSize: 8,
        isAnomaly: true,
        direction: 'DROP',
      });
      expect(evaluateVolumeAnomaly(200, history, { window: 8 }).isAnomaly).toBe(false);
    });

    it('a 30-entry window reaches the boundary the same way', () => {
      const history = [...flatHistory(40, 15), ...flatHistory(60, 15)]; // mean 50

      expect(evaluateVolumeAnomaly(65, history, { window: 30 })).toMatchObject({
        movingAverage: 50,
        isAnomaly: false,
      });
      expect(evaluateVolumeAnomaly(65.05, history, { window: 30 }).isAnomaly).toBe(true);
      expect(evaluateVolumeAnomaly(35, history, { window: 30 }).isAnomaly).toBe(false);
      expect(evaluateVolumeAnomaly(34.95, history, { window: 30 }).isAnomaly).toBe(true);
    });

    it('a short history (fewer than 7 entries) averages what exists', () => {
      expect(evaluateVolumeAnomaly(130.1, [100, 100, 100])).toMatchObject({
        movingAverage: 100,
        baselineSampleSize: 3,
        isAnomaly: true,
      });
    });

    it('a single prior reading is enough to flag', () => {
      expect(evaluateVolumeAnomaly(130.1, [100])).toMatchObject({
        reason: 'SPIKE',
        isAnomaly: true,
      });
    });

    // KNOWN GAP: the moving average is rounded to 6 decimals before the
    // comparison. For a non-terminating mean (e.g. 301 / 3 = 100.333…) an
    // exact +30.0 % reading lands ~4e-7 over the rounded bound and is flagged,
    // although the spec's strict ">" says exactly 30.0 % is not an anomaly.
    // Low practical impact: meter readings with 2 decimals cannot hit this band.
    it.failing('does not flag an exact +30.0 % reading against a non-terminating average', () => {
      const history = [100, 100, 101];
      const exactMean = 301 / 3;

      expect(evaluateVolumeAnomaly(exactMean * 1.3, history).isAnomaly).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  //  Zero and partly-zero baselines
  // ─────────────────────────────────────────────────────────
  describe('zero-baseline edge cases', () => {
    it.each<[number, boolean, string]>([
      [13, false, 'WITHIN_THRESHOLD'],
      [13.01, true, 'SPIKE'],
      [7, false, 'WITHIN_THRESHOLD'],
      [6.99, true, 'DROP'],
    ])(
      'a partly-zero history (avg 10 L) uses the normal ±30 %% rule: %p L → isAnomaly %p',
      (current, expected, reason) => {
        const history = [0, 0, 0, 0, 0, 0, 70]; // mean 10

        expect(evaluateVolumeAnomaly(current, history)).toMatchObject({
          movingAverage: 10,
          isAnomaly: expected,
          reason,
        });
      },
    );

    it('a drop to 0 L against a non-zero average is a 100 % DROP', () => {
      expect(evaluateVolumeAnomaly(0, flatHistory(100))).toMatchObject({
        isAnomaly: true,
        direction: 'DROP',
        deviation: -100,
        deviationRatio: 1,
      });
    });

    it('the smallest measurable volume (0.01 L) after an all-zero history flags', () => {
      expect(evaluateVolumeAnomaly(0.01, flatHistory(0))).toMatchObject({
        isAnomaly: true,
        direction: 'SPIKE',
        reason: 'ZERO_BASELINE',
        deviationRatio: null,
      });
    });

    it('an all-zero history of any window length behaves the same', () => {
      expect(evaluateVolumeAnomaly(0, flatHistory(0, 30), { window: 30 })).toMatchObject({
        isAnomaly: false,
        reason: 'ZERO_BASELINE',
      });
      expect(evaluateVolumeAnomaly(5, flatHistory(0, 30), { window: 30 }).isAnomaly).toBe(true);
    });

    it('zeros older than the window do not count: the baseline is the recent average', () => {
      const history = [...flatHistory(0, 5), ...flatHistory(100)];

      expect(evaluateVolumeAnomaly(100, history)).toMatchObject({
        movingAverage: 100,
        isAnomaly: false,
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  //  Revenue variance formula boundaries
  // ─────────────────────────────────────────────────────────
  describe('revenue variance: one-cent boundaries (2 KES / L)', () => {
    // 500 L × 2 KES = 1000 KES expected
    it.each<[string, number, number, boolean, boolean]>([
      ['exact cash', 1000, 0, false, false],
      ['one cent short', 999.99, -0.01, true, true],
      ['one cent over', 1000.01, 0.01, true, false],
    ])(
      '%s: cash %p → variance %p (hasVariance %p, shortfall %p)',
      (_label, reportedCash, variance, hasVariance, isCashShortfall) => {
        const result = calculateReconciliation({ meterVolume: 500, reportedCash });

        expect(result.expectedRevenue).toBe(1000);
        expect(result.variance).toBe(variance);
        expect(result.hasVariance).toBe(hasVariance);
        expect(result.isCashShortfall).toBe(isCashShortfall);
      },
    );

    it.each<[number, number]>([
      [0.005, 0.01],
      [1.005, 2.01],
      [33.335, 66.67],
      [123.454, 246.91],
    ])('expected revenue for %p L is rounded to the cent: %p KES', (meterVolume, expected) => {
      expect(calculateReconciliation({ meterVolume, reportedCash: 0 }).expectedRevenue).toBe(expected);
    });

    it('variance is reported cash minus expected revenue (sign convention)', () => {
      const short = calculateReconciliation({ meterVolume: 100, reportedCash: 150 });
      const over = calculateReconciliation({ meterVolume: 100, reportedCash: 250 });

      expect(short.variance).toBe(150 - 200);
      expect(over.variance).toBe(250 - 200);
      expect(Math.sign(short.discrepancyRatio)).toBe(-1);
      expect(Math.sign(over.discrepancyRatio)).toBe(1);
    });

    it.each<[number, number]>([
      [700, -30],
      [1300, 30],
      [0, -100],
      [2000, 100],
    ])('cash %p for 1000 KES expected → discrepancy %p %%', (reportedCash, percent) => {
      expect(
        calculateReconciliation({ meterVolume: 500, reportedCash }).discrepancyPercentage,
      ).toBe(percent);
    });

    it('cash handed in with 0 L dispensed is a surplus with a guarded 0 % ratio', () => {
      expect(calculateReconciliation({ meterVolume: 0, reportedCash: 50 })).toMatchObject({
        expectedRevenue: 0,
        variance: 50,
        discrepancyRatio: 0,
        isCashShortfall: false,
      });
    });

    it('a different unit price moves expected revenue and variance together', () => {
      expect(
        calculateReconciliation({ meterVolume: 500, reportedCash: 1000, unitPrice: 2.5 }),
      ).toMatchObject({ expectedRevenue: 1250, variance: -250, isCashShortfall: true });
    });
  });

  // ─────────────────────────────────────────────────────────
  //  Through the daily batch engine (runBatch)
  // ─────────────────────────────────────────────────────────
  describe('daily batch engine classifies every submission', () => {
    let counter = 0;

    const log = (kioskId: string, day: number, meterVolume: number, reportedCash = meterVolume * 2): BatchSourceLog => {
      counter += 1;
      const recordedAt = new Date(Date.UTC(2026, 10, day, 10));
      return {
        id: `${kioskId}-d${day}-${counter}`,
        transactionId: `TXN-${counter}`,
        kioskId,
        meterVolume,
        reportedCash,
        expectedRevenue: 0,
        variance: 0,
        isAnomaly: false,
        recordedAt,
        createdAt: recordedAt,
      };
    };

    /** In-memory stand-in for the `dailyLog.findMany` calls runBatch makes. */
    const fakePrisma = (rows: BatchSourceLog[]) => {
      const byOrder = (a: BatchSourceLog, b: BatchSourceLog) =>
        a.kioskId.localeCompare(b.kioskId) ||
        a.recordedAt.getTime() - b.recordedAt.getTime() ||
        a.id.localeCompare(b.id);
      return {
        dailyLog: {
          findMany: jest.fn(async ({ where }: { where?: { kioskId?: string } } = {}) =>
            rows
              .filter((r) => !where?.kioskId || r.kioskId === where.kioskId)
              .sort(byOrder)
              .map((r) => ({ ...r })),
          ),
          update: jest.fn(),
        },
      };
    };

    const run = async (rows: BatchSourceLog[], options = {}) => {
      const service = new ReconciliationService(fakePrisma(rows) as unknown as PrismaService);
      const summary = await service.runBatch({ dryRun: true, ...options });
      return new Map<string, BatchRecordResult>(summary.records.map((r) => [r.id, r]));
    };

    /** Seven days of 100 L, then `current` on day 8, for one kiosk. */
    const kioskWith = (kioskId: string, current: number) => {
      const rows = flatHistory(100).map((v, i) => log(kioskId, i + 1, v));
      const target = log(kioskId, 8, current);
      return { rows: [...rows, target], targetId: target.id };
    };

    it.each<[number, boolean, string]>([
      [129.9, false, 'NONE'],
      [130, false, 'NONE'],
      [130.1, true, 'SPIKE'],
      [70.1, false, 'NONE'],
      [70, false, 'NONE'],
      [69.9, true, 'DROP'],
    ])('day-8 volume %p L against a 100 L batch baseline → isAnomaly %p', async (current, expected, direction) => {
      const { rows, targetId } = kioskWith('KIOSK-EDGE', current);

      const record = (await run(rows)).get(targetId);

      expect(record).toMatchObject({
        movingAverage: 100,
        baselineSampleSize: 7,
        isAnomaly: expected,
        anomalyDirection: direction,
      });
    });

    it('outputs revenue, cash and variance for every submission, including the first day', async () => {
      const rows = [log('KIOSK-NEW', 1, 500, 950), log('KIOSK-NEW', 2, 520, 1040)];

      const records = await run(rows);

      expect([...records.values()]).toEqual([
        expect.objectContaining({
          meterVolume: 500,
          reportedCash: 950,
          expectedRevenue: 1000,
          variance: -50,
          isCashShortfall: true,
          anomalyReason: 'INSUFFICIENT_BASELINE',
          isAnomaly: false,
        }),
        expect.objectContaining({
          meterVolume: 520,
          reportedCash: 1040,
          expectedRevenue: 1040,
          variance: 0,
          isCashShortfall: false,
          movingAverage: 500,
          isAnomaly: false,
        }),
      ]);
    });

    it('an anomalous day enters later baselines, so the average really moves', async () => {
      const rows = [
        ...flatHistory(100).map((v, i) => log('KIOSK-MOVE', i + 1, v)),
        log('KIOSK-MOVE', 8, 200), // spike vs 100
        log('KIOSK-MOVE', 9, 140), // vs (6 × 100 + 200) / 7 ≈ 114.29 → +22.5 %
      ];

      const records = [...(await run(rows)).values()];
      const day8 = records[7];
      const day9 = records[8];

      expect(day8).toMatchObject({ isAnomaly: true, anomalyDirection: 'SPIKE' });
      expect(day9.movingAverage).toBeCloseTo(114.285714, 6);
      expect(day9.isAnomaly).toBe(false);
    });

    it('each kiosk is judged against its own baseline in the same run', async () => {
      const small = kioskWith('KIOSK-SMALL', 130.1); // 100 L baseline → spike
      const large = [
        ...flatHistory(1000).map((v, i) => log('KIOSK-LARGE', i + 1, v)),
        log('KIOSK-LARGE', 8, 1300), // exactly +30.0 % → not an anomaly
      ];

      const records = await run([...small.rows, ...large]);

      expect(records.get(small.targetId)?.isAnomaly).toBe(true);
      const largeDay8 = [...records.values()].find(
        (r) => r.kioskId === 'KIOSK-LARGE' && r.meterVolume === 1300,
      );
      expect(largeDay8).toMatchObject({ movingAverage: 1000, isAnomaly: false });
    });
  });
});
