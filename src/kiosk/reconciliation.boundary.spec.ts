/**
 * Independent boundary/unit test suite for Sprint 2 — Priority 2, ID 04
 * "Interpret Data": revenue variance formulas and ±30 % moving-average
 * anomaly detection.
 *
 * The assertions here are derived from the sprint specification, not from the
 * implementation, so they double as a guard rail for the pure algorithms and
 * for every service built on top of them:
 *
 *   Expected Revenue  = Meter Volume × Unit Price
 *   Variance          = Reported Cash − Expected Revenue
 *   Discrepancy Ratio = Variance ÷ Expected Revenue (guarded at 0)
 *   isAnomaly         = |Current Volume − Moving Avg| > 0.30 × Moving Avg
 *
 * Boundary rule from the spec (Priority 2, ID 04 task table):
 * "Test boundary conditions (exact ±29.9 %, ±30.0 %, ±30.1 % spikes/drops,
 * and zero-baseline edge cases)".
 *
 * Spec file: sprint_2_technical_requirements_implementation_specification.md
 */

import {
  DEFAULT_UNIT_PRICE_PER_LITER,
  UNIT_PRICE_ENV_VAR,
  calculateDiscrepancyRatio,
  calculateReconciliation,
  resolveUnitPrice,
  roundMoney,
  roundTo,
} from './reconciliation';
import {
  ANOMALY_THRESHOLD,
  BASELINE_WINDOW_ENV_VAR,
  DEFAULT_BASELINE_WINDOW,
  MAX_BASELINE_WINDOW,
  classifyVolumeAnomaly,
  computeMovingAverageBaseline,
  evaluateVolumeAnomaly,
  resolveBaselineWindow,
} from './volume-anomaly';

const UNIT_PRICE_ENV = 'WATER_UNIT_PRICE_PER_LITER';
const WINDOW_ENV = 'ANOMALY_BASELINE_WINDOW';

/** Seven normal days at 100 L → a moving average of exactly 100 L. */
const NORMAL_WEEK = [100, 100, 100, 100, 100, 100, 100] as const;

const originalUnitPriceEnv = process.env[UNIT_PRICE_ENV];
const originalWindowEnv = process.env[WINDOW_ENV];

describe('Sprint 2 — ID 04 revenue variance & ±30 % anomaly boundaries', () => {
  beforeEach(() => {
    // Keep the suite deterministic regardless of the developer's shell.
    delete process.env[UNIT_PRICE_ENV];
    delete process.env[WINDOW_ENV];
  });

  afterAll(() => {
    if (originalUnitPriceEnv === undefined) {
      delete process.env[UNIT_PRICE_ENV];
    } else {
      process.env[UNIT_PRICE_ENV] = originalUnitPriceEnv;
    }
    if (originalWindowEnv === undefined) {
      delete process.env[WINDOW_ENV];
    } else {
      process.env[WINDOW_ENV] = originalWindowEnv;
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. Revenue / variance formula (spec Priority 2, ID 04)
  // ───────────────────────────────────────────────────────────────────────
  describe('calculateReconciliation — revenue and variance formula', () => {
    it('maps the spec example 500 L / 950 KES to expectedRevenue 1000, variance −50 and −5 %', () => {
      const result = calculateReconciliation({
        meterVolume: 500,
        reportedCash: 950,
      });

      expect(result).toMatchObject({
        meterVolume: 500,
        reportedCash: 950,
        unitPrice: DEFAULT_UNIT_PRICE_PER_LITER,
        expectedRevenue: 1000,
        variance: -50,
        discrepancyRatio: -0.05,
        discrepancyPercentage: -5,
        hasVariance: true,
        isCashShortfall: true,
      });
    });

    it('uses the default unit price of 2 KES per litre', () => {
      const result = calculateReconciliation({
        meterVolume: 500,
        reportedCash: 1000,
      });

      expect(result.unitPrice).toBe(2);
      expect(result.expectedRevenue).toBe(500 * 2);
    });

    it('flags a cash surplus (positive variance) without a shortfall', () => {
      const result = calculateReconciliation({
        meterVolume: 500,
        reportedCash: 1050,
      });

      expect(result.expectedRevenue).toBe(1000);
      expect(result.variance).toBe(50);
      expect(result.discrepancyRatio).toBe(0.05);
      expect(result.discrepancyPercentage).toBe(5);
      expect(result.hasVariance).toBe(true);
      expect(result.isCashShortfall).toBe(false);
    });

    it('treats exact cash as no variance and no shortfall', () => {
      const result = calculateReconciliation({
        meterVolume: 500,
        reportedCash: 1000,
      });

      expect(result.variance).toBe(0);
      expect(result.discrepancyRatio).toBe(0);
      expect(result.discrepancyPercentage).toBe(0);
      expect(result.hasVariance).toBe(false);
      expect(result.isCashShortfall).toBe(false);
    });

    it('lets an explicit unit price override change expected revenue and variance', () => {
      const result = calculateReconciliation({
        meterVolume: 500,
        reportedCash: 1000,
        unitPrice: 2.5,
      });

      expect(result.unitPrice).toBe(2.5);
      expect(result.expectedRevenue).toBe(1250);
      expect(result.variance).toBe(-250);
      expect(result.discrepancyRatio).toBe(-0.2);
      expect(result.discrepancyPercentage).toBe(-20);
      expect(result.isCashShortfall).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Rounding to two decimals
  // ───────────────────────────────────────────────────────────────────────
  describe('calculateReconciliation — 2-decimal rounding', () => {
    it('rounds expectedRevenue and variance to two decimal places', () => {
      const result = calculateReconciliation({
        meterVolume: 123.456,
        reportedCash: 250,
      });

      expect(result.expectedRevenue).toBe(246.91);
      expect(result.variance).toBe(3.09);
    });

    it('rounds discrepancyPercentage to two decimals', () => {
      const result = calculateReconciliation({
        meterVolume: 300,
        reportedCash: 250,
      });

      expect(result.expectedRevenue).toBe(600);
      expect(result.variance).toBe(-350);
      expect(result.discrepancyRatio).toBe(-0.583333);
      expect(result.discrepancyPercentage).toBe(-58.33);
    });

    it('roundMoney rounds to 2dp and collapses non-finite values to 0', () => {
      expect(roundMoney(1234.5678)).toBe(1234.57);
      expect(roundMoney(1.005)).toBe(1.01);
      expect(roundMoney(Number.NaN)).toBe(0);
      expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(0);
      expect(roundMoney(Number.NEGATIVE_INFINITY)).toBe(0);
    });

    it('roundTo rounds to the requested precision', () => {
      expect(roundTo(1.23456, 3)).toBe(1.235);
      expect(roundTo(1.23456, 0)).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Legacy / invalid numeric inputs (null legacy rows, NaN, Infinity)
  // ───────────────────────────────────────────────────────────────────────
  describe('calculateReconciliation — legacy and non-finite inputs', () => {
    it('treats null legacy reported cash as 0 instead of NaN', () => {
      const result = calculateReconciliation({
        meterVolume: 100,
        reportedCash: null,
      });

      expect(result.reportedCash).toBe(0);
      expect(result.expectedRevenue).toBe(200);
      expect(result.variance).toBe(-200);
      expect(result.isCashShortfall).toBe(true);
      expect(Number.isNaN(result.variance)).toBe(false);
    });

    it('coerces a non-finite meter volume to 0 and guards the ratio', () => {
      const result = calculateReconciliation({
        meterVolume: Number.NaN,
        reportedCash: 50,
      });

      expect(result.meterVolume).toBe(0);
      expect(result.expectedRevenue).toBe(0);
      expect(result.variance).toBe(50);
      expect(result.discrepancyRatio).toBe(0);
      expect(result.discrepancyPercentage).toBe(0);
      expect(result.hasVariance).toBe(true);
      expect(result.isCashShortfall).toBe(false);
    });

    it('coerces null/undefined legacy inputs to 0', () => {
      const result = calculateReconciliation({
        meterVolume: null as unknown as number,
        reportedCash: undefined,
      });

      expect(result.meterVolume).toBe(0);
      expect(result.reportedCash).toBe(0);
      expect(result.expectedRevenue).toBe(0);
      expect(result.variance).toBe(0);
      expect(result.hasVariance).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Discrepancy ratio divide-by-zero guards
  // ───────────────────────────────────────────────────────────────────────
  describe('calculateDiscrepancyRatio — divide-by-zero guards', () => {
    it('returns 0 when expected revenue is 0 (no divide-by-zero)', () => {
      expect(calculateDiscrepancyRatio(50, 0)).toBe(0);
      expect(calculateDiscrepancyRatio(0, 0)).toBe(0);
      expect(calculateDiscrepancyRatio(-50, 0)).toBe(0);
    });

    it('returns 0 for an exact zero variance', () => {
      expect(calculateDiscrepancyRatio(0, 1000)).toBe(0);
    });

    it('never returns NaN for non-finite inputs', () => {
      expect(calculateDiscrepancyRatio(Number.NaN, 1000)).toBe(0);
      expect(calculateDiscrepancyRatio(50, Number.NaN)).toBe(0);
      expect(calculateDiscrepancyRatio(50, Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('returns the variance as a fraction of expected revenue, rounded to 6dp', () => {
      expect(calculateDiscrepancyRatio(-50, 1000)).toBe(-0.05);
      expect(calculateDiscrepancyRatio(1, 3)).toBe(0.333333);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. Unit price resolution: explicit → env → default
  // ───────────────────────────────────────────────────────────────────────
  describe('resolveUnitPrice — explicit override, env, default', () => {
    it('exposes the documented env var name and default price', () => {
      expect(UNIT_PRICE_ENV_VAR).toBe(UNIT_PRICE_ENV);
      expect(DEFAULT_UNIT_PRICE_PER_LITER).toBe(2);
    });

    it('falls back to the built-in default when nothing is configured', () => {
      expect(resolveUnitPrice()).toBe(2);
      expect(resolveUnitPrice(null)).toBe(2);
      expect(resolveUnitPrice(undefined)).toBe(2);
    });

    it('prefers a valid explicit override', () => {
      expect(resolveUnitPrice(2.5)).toBe(2.5);
      expect(resolveUnitPrice('3.5')).toBe(3.5);
    });

    it('ignores explicit non-positive or non-numeric overrides', () => {
      expect(resolveUnitPrice(0)).toBe(2);
      expect(resolveUnitPrice(-1)).toBe(2);
      expect(resolveUnitPrice(Number.NaN)).toBe(2);
      expect(resolveUnitPrice('not-a-price')).toBe(2);
    });

    it('uses WATER_UNIT_PRICE_PER_LITER when no explicit override is supplied', () => {
      process.env[UNIT_PRICE_ENV] = '3.5';

      expect(resolveUnitPrice()).toBe(3.5);
      expect(resolveUnitPrice(null)).toBe(3.5);
      expect(
        calculateReconciliation({ meterVolume: 500, reportedCash: 0 })
          .expectedRevenue,
      ).toBe(1750);
    });

    it('lets an explicit override win over the environment variable', () => {
      process.env[UNIT_PRICE_ENV] = '10';

      expect(resolveUnitPrice(2)).toBe(2);
      expect(resolveUnitPrice()).toBe(10);
    });

    it('falls back to the default when the env value is invalid or non-positive', () => {
      for (const invalid of ['', '   ', 'abc', '0', '-3', 'NaN']) {
        process.env[UNIT_PRICE_ENV] = invalid;
        expect(resolveUnitPrice()).toBe(2);
      }
    });

    it('accepts a numeric env value with surrounding whitespace', () => {
      process.env[UNIT_PRICE_ENV] = ' 4 ';
      expect(resolveUnitPrice()).toBe(4);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. Moving-average baseline: window 7 / 30, short history, ordering
  // ───────────────────────────────────────────────────────────────────────
  describe('computeMovingAverageBaseline — window behaviour', () => {
    it('exposes the documented default window of 7', () => {
      expect(DEFAULT_BASELINE_WINDOW).toBe(7);
      expect(ANOMALY_THRESHOLD).toBe(0.3);
      expect(MAX_BASELINE_WINDOW).toBe(365);
    });

    it('uses only the last 7 entries by default', () => {
      const baseline = computeMovingAverageBaseline([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);

      expect(baseline.window).toBe(7);
      expect(baseline.sampleSize).toBe(7);
      expect(baseline.values).toEqual([4, 5, 6, 7, 8, 9, 10]);
      expect(baseline.averageVolume).toBe(7);
    });

    it('uses every entry when the history is shorter than the window', () => {
      const baseline = computeMovingAverageBaseline([100, 200]);

      expect(baseline.window).toBe(7);
      expect(baseline.sampleSize).toBe(2);
      expect(baseline.values).toEqual([100, 200]);
      expect(baseline.averageVolume).toBe(150);
    });

    it('supports the spec alternative of a 30-entry window', () => {
      const history = Array.from({ length: 40 }, (_, index) => index + 1);
      const baseline = computeMovingAverageBaseline(history, 30);

      expect(baseline.window).toBe(30);
      expect(baseline.sampleSize).toBe(30);
      expect(baseline.values).toEqual(history.slice(-30));
      expect(baseline.values[0]).toBe(11);
      expect(baseline.values[29]).toBe(40);
      expect(baseline.averageVolume).toBe(25.5);
    });

    it('preserves chronological (oldest → newest) order and averages them', () => {
      const baseline = computeMovingAverageBaseline([200, 200, 100, 100]);

      expect(baseline.values).toEqual([200, 200, 100, 100]);
      expect(baseline.averageVolume).toBe(150);
    });

    it('returns a zeroed baseline for empty history', () => {
      const baseline = computeMovingAverageBaseline([]);

      expect(baseline).toEqual({
        window: 7,
        sampleSize: 0,
        averageVolume: 0,
        values: [],
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. Non-finite history values must be ignored when building the baseline
  // ───────────────────────────────────────────────────────────────────────
  describe('computeMovingAverageBaseline — non-finite values', () => {
    it('ignores non-finite volumes instead of averaging them in', () => {
      const baseline = computeMovingAverageBaseline([
        100,
        Number.NaN,
        100,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        100,
      ]);

      expect(baseline.sampleSize).toBe(3);
      expect(baseline.values).toEqual([100, 100, 100]);
      expect(baseline.averageVolume).toBe(100);
    });

    it('ignores non-finite volumes for anomaly classification too', () => {
      const result = evaluateVolumeAnomaly(69.9, [
        100,
        100,
        100,
        Number.NaN,
        100,
        100,
        100,
      ]);

      expect(result.movingAverage).toBe(100);
      expect(result.baselineSampleSize).toBe(6);
      expect(result.isAnomaly).toBe(true);
      expect(result.direction).toBe('DROP');
      expect(result.deviation).toBe(-30.1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8. ±30 % boundary cases (the core of this suite)
  // ───────────────────────────────────────────────────────────────────────
  describe('classifyVolumeAnomaly — exact ±29.9 % / ±30.0 % / ±30.1 % boundaries', () => {
    const baseline = computeMovingAverageBaseline(NORMAL_WEEK);

    it('builds a baseline fixture of exactly 100 L over seven samples', () => {
      expect(baseline.averageVolume).toBe(100);
      expect(baseline.sampleSize).toBe(7);
      expect(baseline.window).toBe(7);
      expect(baseline.values).toEqual([...NORMAL_WEEK]);
    });

    it('does NOT flag a +29.9 % spike', () => {
      const result = classifyVolumeAnomaly(129.9, baseline);

      expect(result.isAnomaly).toBe(false);
      expect(result.direction).toBe('NONE');
      expect(result.reason).toBe('WITHIN_THRESHOLD');
      expect(result.deviation).toBe(29.9);
      expect(result.deviationRatio).toBe(0.299);
      expect(result.upperBound).toBe(130);
      expect(result.lowerBound).toBe(70);
      expect(result.baselineSampleSize).toBe(7);
      expect(result.baselineWindow).toBe(7);
      expect(result.threshold).toBe(ANOMALY_THRESHOLD);
      expect(result.movingAverage).toBe(100);
    });

    it('does NOT flag an exact +30.0 % spike (strict > inequality)', () => {
      const result = classifyVolumeAnomaly(130, baseline);

      expect(result.isAnomaly).toBe(false);
      expect(result.direction).toBe('NONE');
      expect(result.reason).toBe('WITHIN_THRESHOLD');
      expect(result.deviation).toBe(30);
      expect(result.deviationRatio).toBe(0.3);
      expect(result.upperBound).toBe(130);
      expect(result.baselineSampleSize).toBe(7);
    });

    it('DOES flag a +30.1 % spike', () => {
      const result = classifyVolumeAnomaly(130.1, baseline);

      expect(result.isAnomaly).toBe(true);
      expect(result.direction).toBe('SPIKE');
      expect(result.reason).toBe('SPIKE');
      expect(result.deviation).toBe(30.1);
      expect(result.deviationRatio).toBe(0.301);
      expect(result.upperBound).toBe(130);
      expect(result.lowerBound).toBe(70);
      expect(result.baselineSampleSize).toBe(7);
      expect(result.baselineWindow).toBe(7);
    });

    it('does NOT flag a −29.9 % drop', () => {
      const result = classifyVolumeAnomaly(70.1, baseline);

      expect(result.isAnomaly).toBe(false);
      expect(result.direction).toBe('NONE');
      expect(result.reason).toBe('WITHIN_THRESHOLD');
      expect(result.deviation).toBe(-29.9);
      expect(result.deviationRatio).toBe(0.299);
      expect(result.upperBound).toBe(130);
      expect(result.lowerBound).toBe(70);
    });

    it('does NOT flag an exact −30.0 % drop (strict > inequality)', () => {
      const result = classifyVolumeAnomaly(70, baseline);

      expect(result.isAnomaly).toBe(false);
      expect(result.direction).toBe('NONE');
      expect(result.reason).toBe('WITHIN_THRESHOLD');
      expect(result.deviation).toBe(-30);
      expect(result.deviationRatio).toBe(0.3);
      expect(result.lowerBound).toBe(70);
    });

    it('DOES flag a −30.1 % drop', () => {
      const result = classifyVolumeAnomaly(69.9, baseline);

      expect(result.isAnomaly).toBe(true);
      expect(result.direction).toBe('DROP');
      expect(result.reason).toBe('DROP');
      expect(result.deviation).toBe(-30.1);
      expect(result.deviationRatio).toBe(0.301);
      expect(result.lowerBound).toBe(70);
      expect(result.baselineSampleSize).toBe(7);
    });

    it('applies a custom ±10 % threshold at its boundary', () => {
      const atSpikeBoundary = classifyVolumeAnomaly(110, baseline, 0.1);
      expect(atSpikeBoundary.threshold).toBe(0.1);
      expect(atSpikeBoundary.isAnomaly).toBe(false);
      expect(atSpikeBoundary.reason).toBe('WITHIN_THRESHOLD');
      expect(atSpikeBoundary.upperBound).toBe(110);

      const spike = classifyVolumeAnomaly(110.1, baseline, 0.1);
      expect(spike.isAnomaly).toBe(true);
      expect(spike.direction).toBe('SPIKE');
      expect(spike.deviationRatio).toBe(0.101);

      const atDropBoundary = classifyVolumeAnomaly(90, baseline, 0.1);
      expect(atDropBoundary.isAnomaly).toBe(false);
      expect(atDropBoundary.lowerBound).toBe(90);

      expect(classifyVolumeAnomaly(89.9, baseline, 0.1).direction).toBe('DROP');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 9. Zero-baseline and insufficient-baseline edge cases
  // ───────────────────────────────────────────────────────────────────────
  describe('zero-baseline and insufficient-baseline edge cases', () => {
    const dormantBaseline = computeMovingAverageBaseline([0, 0, 0, 0, 0, 0, 0]);

    it('does NOT flag 0 L against an all-zero baseline', () => {
      const result = classifyVolumeAnomaly(0, dormantBaseline);

      expect(result.movingAverage).toBe(0);
      expect(result.baselineSampleSize).toBe(7);
      expect(result.isAnomaly).toBe(false);
      expect(result.direction).toBe('NONE');
      expect(result.reason).toBe('ZERO_BASELINE');
      expect(result.deviation).toBe(0);
      expect(result.deviationRatio).toBeNull();
      expect(result.upperBound).toBe(0);
      expect(result.lowerBound).toBe(0);
    });

    it('flags any non-zero volume after a dormant period (literal |current − 0| > 0 rule)', () => {
      const result = classifyVolumeAnomaly(50, dormantBaseline);

      expect(result.movingAverage).toBe(0);
      expect(result.isAnomaly).toBe(true);
      expect(result.direction).toBe('SPIKE');
      expect(result.reason).toBe('ZERO_BASELINE');
      expect(result.deviation).toBe(50);
      expect(result.deviationRatio).toBeNull();
    });

    it('returns INSUFFICIENT_BASELINE and no anomaly for a kiosk with no history', () => {
      const result = evaluateVolumeAnomaly(500, []);

      expect(result.isAnomaly).toBe(false);
      expect(result.direction).toBe('NONE');
      expect(result.reason).toBe('INSUFFICIENT_BASELINE');
      expect(result.baselineSampleSize).toBe(0);
      expect(result.movingAverage).toBe(0);
      expect(result.deviation).toBe(0);
      expect(result.deviationRatio).toBeNull();
      expect(result.upperBound).toBe(0);
      expect(result.lowerBound).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 10. evaluateVolumeAnomaly wrapper (history → classification)
  // ───────────────────────────────────────────────────────────────────────
  describe('evaluateVolumeAnomaly — end-to-end wrapper', () => {
    it('classifies a spike from chronological history', () => {
      const result = evaluateVolumeAnomaly(130.1, NORMAL_WEEK);

      expect(result.isAnomaly).toBe(true);
      expect(result.direction).toBe('SPIKE');
      expect(result.movingAverage).toBe(100);
      expect(result.baselineSampleSize).toBe(7);
      expect(result.baselineWindow).toBe(7);
    });

    it('classifies a drop from chronological history', () => {
      const result = evaluateVolumeAnomaly(69.9, NORMAL_WEEK);

      expect(result.isAnomaly).toBe(true);
      expect(result.direction).toBe('DROP');
      expect(result.reason).toBe('DROP');
      expect(result.movingAverage).toBe(100);
    });

    it('honours the window and threshold options', () => {
      const history = [50, 100, 100, 100, 100, 100, 100];

      // Running with a 3-entry window makes the baseline exactly 100 L.
      const boundary = evaluateVolumeAnomaly(110, history, {
        window: 3,
        threshold: 0.1,
      });
      expect(boundary.movingAverage).toBe(100);
      expect(boundary.baselineSampleSize).toBe(3);
      expect(boundary.baselineWindow).toBe(3);
      expect(boundary.isAnomaly).toBe(false);

      const spike = evaluateVolumeAnomaly(110.1, history, {
        window: 3,
        threshold: 0.1,
      });
      expect(spike.isAnomaly).toBe(true);
      expect(spike.direction).toBe('SPIKE');

      // Default threshold over the same window: 110 L is only +10 %, no flag.
      expect(
        evaluateVolumeAnomaly(110, history, { window: 3 }).isAnomaly,
      ).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 11. resolveBaselineWindow validation and env override
  // ───────────────────────────────────────────────────────────────────────
  describe('resolveBaselineWindow — validation and env override', () => {
    it('defaults to 7', () => {
      expect(resolveBaselineWindow()).toBe(7);
      expect(resolveBaselineWindow(undefined)).toBe(7);
      expect(resolveBaselineWindow(null)).toBe(7);
    });

    it('accepts explicit positive integers and floors fractional values', () => {
      expect(resolveBaselineWindow(1)).toBe(1);
      expect(resolveBaselineWindow(7)).toBe(7);
      expect(resolveBaselineWindow(30)).toBe(30);
      expect(resolveBaselineWindow(30.9)).toBe(30);
      expect(resolveBaselineWindow('30')).toBe(30);
    });

    it('falls back to 7 for 0, negative and non-numeric windows', () => {
      for (const invalid of [0, -3, Number.NaN, 'abc', '']) {
        expect(resolveBaselineWindow(invalid)).toBe(7);
      }
    });

    it('clamps windows above 365', () => {
      expect(resolveBaselineWindow(999)).toBe(365);
      expect(resolveBaselineWindow('999')).toBe(365);
      expect(resolveBaselineWindow(MAX_BASELINE_WINDOW)).toBe(365);
    });

    it('uses ANOMALY_BASELINE_WINDOW when no explicit window is supplied', () => {
      expect(BASELINE_WINDOW_ENV_VAR).toBe(WINDOW_ENV);
      process.env[WINDOW_ENV] = '30';

      expect(resolveBaselineWindow()).toBe(30);
      expect(resolveBaselineWindow(null)).toBe(30);
      expect(
        computeMovingAverageBaseline(NORMAL_WEEK, undefined).window,
      ).toBe(30);
    });

    it('ignores an invalid ANOMALY_BASELINE_WINDOW', () => {
      process.env[WINDOW_ENV] = '0';
      expect(resolveBaselineWindow()).toBe(7);

      process.env[WINDOW_ENV] = 'invalid';
      expect(resolveBaselineWindow()).toBe(7);

      process.env[WINDOW_ENV] = '999';
      expect(resolveBaselineWindow()).toBe(365);
    });
  });
});
