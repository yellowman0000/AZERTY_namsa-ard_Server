/**
 * Story ID 04 – Moving-average baseline algorithm for daily volume anomalies.
 *
 * Business rule from the Sprint 2 specification (Priority 2):
 *
 *   movingAvg = mean(previous N daily volumes for the kiosk)
 *   isAnomaly = |currentVolume − movingAvg| > 0.30 × movingAvg
 *
 * A record is flagged when the day's litre volume is more than 30 % above
 * (SPIKE) or below (DROP) the kiosk's own moving average. The threshold is
 * applied strictly: a deviation of exactly 30.0 % is *not* an anomaly, while
 * 30.1 % is (see the Earn boundary suite).
 *
 * Baseline window defaults to the previous 7 records and can be raised to 30
 * (the spec allows "last 7 or 30 entries") via `ANOMALY_BASELINE_WINDOW`.
 *
 * Edge cases:
 *  - No history yet            → not an anomaly (`INSUFFICIENT_BASELINE`), so a
 *                                new kiosk is never flagged on its first reading.
 *  - History average is 0      → the relative test is undefined; the literal
 *                                rule `|current − 0| > 0` is used, i.e. any
 *                                non-zero volume after a dormant period flags.
 *  - Non-finite values         → ignored when building the baseline.
 *
 * This module is pure so it can be unit-tested and reused by the batch engine
 * and the reconciliation endpoint without a database.
 */

import { roundTo, toFiniteNumber } from './reconciliation';

/** Fraction of the moving average that counts as an anomaly (±30 %). */
export const ANOMALY_THRESHOLD = 0.3;

/** Default number of prior records used as the moving-average baseline. */
export const DEFAULT_BASELINE_WINDOW = 7;

/** Hard ceiling for a configurable baseline window. */
export const MAX_BASELINE_WINDOW = 365;

/** Environment variable used to change the default baseline window. */
export const BASELINE_WINDOW_ENV_VAR = 'ANOMALY_BASELINE_WINDOW';

/** Tolerance absorbing binary floating-point noise at the ±30 % boundary. */
const BOUNDARY_EPSILON = 1e-9;

export type AnomalyDirection = 'SPIKE' | 'DROP' | 'NONE';

export type AnomalyReason =
  | 'SPIKE'
  | 'DROP'
  | 'WITHIN_THRESHOLD'
  | 'INSUFFICIENT_BASELINE'
  | 'ZERO_BASELINE';

export interface VolumeBaseline {
  /** Window size that was requested/resolved. */
  window: number;
  /** Number of historical records actually used (0 … window). */
  sampleSize: number;
  /** Mean of `values`, rounded to 6 decimals; 0 when there is no history. */
  averageVolume: number;
  /** The windowed historical volumes, oldest → newest. */
  values: number[];
}

export interface VolumeAnomalyResult {
  isAnomaly: boolean;
  /** SPIKE / DROP when flagged, otherwise NONE. */
  direction: AnomalyDirection;
  reason: AnomalyReason;
  currentVolume: number;
  movingAverage: number;
  baselineSampleSize: number;
  baselineWindow: number;
  /** Threshold fraction used for the comparison (normally 0.30). */
  threshold: number;
  /** currentVolume − movingAverage, rounded to 6 decimals. */
  deviation: number;
  /** |deviation| / movingAverage, or null when the average is 0. */
  deviationRatio: number | null;
  /** movingAverage × (1 + threshold). */
  upperBound: number;
  /** movingAverage × (1 − threshold). */
  lowerBound: number;
}

/**
 * Resolves the baseline window: explicit value → env var → default (7).
 * Values below 1 and non-numeric values are ignored.
 */
export function resolveBaselineWindow(
  window?: number | string | null,
): number {
  const raw = window ?? process.env[BASELINE_WINDOW_ENV_VAR];

  if (raw !== undefined && raw !== null && raw !== '') {
    const parsed = toFiniteNumber(raw, Number.NaN);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(Math.floor(parsed), MAX_BASELINE_WINDOW);
    }
  }

  return DEFAULT_BASELINE_WINDOW;
}

/**
 * Builds the moving-average baseline from the kiosk's previous daily volumes.
 *
 * @param historicalVolumes Volumes recorded *before* the current day, in
 *                          chronological order. Only the last `window` are used.
 * @param window            Number of prior records to average (default 7).
 */
export function computeMovingAverageBaseline(
  historicalVolumes: readonly number[],
  window?: number | string | null,
): VolumeBaseline {
  const resolvedWindow = resolveBaselineWindow(window);

  // Drop non-finite values FIRST: coercing them to 0 would silently skew the
  // average (and could suppress a genuine DROP/SPIKE exactly at the boundary).
  const cleaned = (Array.isArray(historicalVolumes) ? historicalVolumes : [])
    .filter(
      (volume): volume is number =>
        typeof volume === 'number' && Number.isFinite(volume),
    );

  const values = cleaned.slice(-resolvedWindow);
  const averageVolume =
    values.length === 0
      ? 0
      : roundTo(
          values.reduce((total, volume) => total + volume, 0) / values.length,
          6,
        );

  return {
    window: resolvedWindow,
    sampleSize: values.length,
    averageVolume,
    values: [...values],
  };
}

/**
 * Classifies a day's volume against a pre-computed moving-average baseline.
 *
 * Uses the specification's strict inequality: a deviation of exactly
 * `threshold × movingAvg` is NOT flagged.
 */
export function classifyVolumeAnomaly(
  currentVolume: number,
  baseline: VolumeBaseline,
  threshold: number = ANOMALY_THRESHOLD,
): VolumeAnomalyResult {
  const current = toFiniteNumber(currentVolume, 0);
  const average = toFiniteNumber(baseline.averageVolume, 0);
  const safeThreshold =
    Number.isFinite(threshold) && threshold > 0
      ? threshold
      : ANOMALY_THRESHOLD;

  const base = {
    currentVolume: current,
    movingAverage: average,
    baselineSampleSize: baseline.sampleSize,
    baselineWindow: baseline.window,
    threshold: safeThreshold,
  };

  const hasHistory =
    baseline.sampleSize > 0 && Array.isArray(baseline.values);

  // First records of a kiosk: there is no meaningful baseline yet.
  if (!hasHistory) {
    return {
      ...base,
      isAnomaly: false,
      direction: 'NONE',
      reason: 'INSUFFICIENT_BASELINE',
      deviation: 0,
      deviationRatio: null,
      upperBound: 0,
      lowerBound: 0,
    };
  }

  // Dormant kiosk: every historical volume was 0, so no relative ratio exists.
  // Fall back to the literal rule |current − 0| > 0.30 × 0.
  if (average === 0) {
    const isAnomaly = Math.abs(current) > BOUNDARY_EPSILON;
    return {
      ...base,
      isAnomaly,
      direction: isAnomaly ? (current > 0 ? 'SPIKE' : 'DROP') : 'NONE',
      reason: 'ZERO_BASELINE',
      deviation: roundTo(current, 6),
      deviationRatio: null,
      upperBound: 0,
      lowerBound: 0,
    };
  }

  const deviation = current - average;
  const absoluteDeviation = Math.abs(deviation);
  const allowedDeviation = safeThreshold * average;
  const isAnomaly =
    absoluteDeviation > allowedDeviation + BOUNDARY_EPSILON;

  const flaggedDirection: AnomalyDirection = !isAnomaly
    ? 'NONE'
    : deviation > 0
      ? 'SPIKE'
      : 'DROP';

  return {
    ...base,
    isAnomaly,
    direction: flaggedDirection,
    reason:
      flaggedDirection === 'NONE' ? 'WITHIN_THRESHOLD' : flaggedDirection,
    deviation: roundTo(deviation, 6),
    deviationRatio: roundTo(absoluteDeviation / average, 6),
    upperBound: roundTo(average * (1 + safeThreshold), 6),
    lowerBound: roundTo(average * (1 - safeThreshold), 6),
  };
}

/**
 * Convenience wrapper: builds the baseline from raw history and classifies.
 */
export function evaluateVolumeAnomaly(
  currentVolume: number,
  historicalVolumes: readonly number[],
  options: { window?: number | string | null; threshold?: number } = {},
): VolumeAnomalyResult {
  const baseline = computeMovingAverageBaseline(
    historicalVolumes,
    options.window,
  );
  return classifyVolumeAnomaly(
    currentVolume,
    baseline,
    options.threshold ?? ANOMALY_THRESHOLD,
  );
}
