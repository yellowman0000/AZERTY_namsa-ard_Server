/**
 * Story ID 04 – Daily batch reconciliation (expected revenue vs. reported cash).
 *
 * Business rules from the Sprint 2 specification (Priority 2):
 *
 *   Expected Revenue      = Meter Volume × Unit Price
 *   Variance              = Reported Cash − Expected Revenue
 *   Discrepancy Ratio (%)  = (Variance ÷ Expected Revenue) × 100
 *
 * The unit price is a server-side business constant: a kiosk client must never be
 * able to hide a cash shortfall by sending its own `expectedRevenue`/`variance`.
 * Override the price with the `WATER_UNIT_PRICE_PER_LITER` environment variable.
 *
 * This module is pure (no NestJS or Prisma imports) so the same formulas are used
 * by request ingestion, the daily batch engine, report export, and the tests.
 */

/** Environment variable used to override the default unit price. */
export const UNIT_PRICE_ENV_VAR = 'WATER_UNIT_PRICE_PER_LITER';

/**
 * Default price charged per litre of water, in KES.
 *
 * The Sprint 2 data contract (§3.1) maps `meterVolume: 500` to
 * `expectedRevenue: 1000`, i.e. 2 KES per litre.
 */
export const DEFAULT_UNIT_PRICE_PER_LITER = 2;

export interface ReconciliationInput {
  /** Litres dispensed for the day. */
  meterVolume: number;
  /** Cash handed in by the field operator (defaults to 0 when absent). */
  reportedCash?: number | null;
  /** Optional per-call price override; falls back to env/default. */
  unitPrice?: number | null;
}

export interface ReconciliationMetrics {
  meterVolume: number;
  reportedCash: number;
  unitPrice: number;
  /** Expected revenue = meterVolume × unitPrice, rounded to 2 decimals. */
  expectedRevenue: number;
  /** Variance = reportedCash − expectedRevenue, rounded to 2 decimals. */
  variance: number;
  /** Variance ÷ expectedRevenue as a fraction (e.g. -0.05 = −5%). */
  discrepancyRatio: number;
  /** The same ratio expressed as a percentage (e.g. -5). */
  discrepancyPercentage: number;
  /** True when reported cash differs from the expected revenue. */
  hasVariance: boolean;
  /** True when the operator reported less cash than expected (variance < 0). */
  isCashShortfall: boolean;
}

/**
 * Rounds to `decimals` places while absorbing binary floating-point noise
 * (e.g. `roundTo(1.005, 2)` → 1.01). Non-finite values collapse to 0.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Rounds a monetary amount to two decimal places (KES). */
export function roundMoney(value: number): number {
  return roundTo(value, 2);
}

/**
 * Coerces an unknown value to a finite number, falling back when it is absent,
 * empty, or not numeric. Used at the database boundary, where legacy rows may
 * hold nulls.
 */
export function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Resolves the price per litre: explicit override → env var → built-in default.
 * Invalid (non-numeric or non-positive) values are ignored instead of throwing,
 * so a bad environment setting can never stop the batch from running.
 */
export function resolveUnitPrice(
  unitPrice?: number | string | null,
): number {
  const candidates: unknown[] = [unitPrice, process.env[UNIT_PRICE_ENV_VAR]];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') {
      continue;
    }
    const parsed = toFiniteNumber(candidate, Number.NaN);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_UNIT_PRICE_PER_LITER;
}

/**
 * Variance ÷ expected revenue, guarded against division by zero.
 * A zero-revenue record has no meaningful ratio, so 0 is returned.
 */
export function calculateDiscrepancyRatio(
  variance: number,
  expectedRevenue: number,
): number {
  if (!Number.isFinite(expectedRevenue) || expectedRevenue <= 0) return 0;
  return roundTo(variance / expectedRevenue, 6);
}

/**
 * Calculates the reconciliation metrics for a single daily log.
 *
 * @example
 * calculateReconciliation({ meterVolume: 500, reportedCash: 950 });
 * // → expectedRevenue: 1000, variance: -50, discrepancyRatio: -0.05
 */
export function calculateReconciliation(
  input: ReconciliationInput,
): ReconciliationMetrics {
  const meterVolume = toFiniteNumber(input.meterVolume, 0);
  const reportedCash = toFiniteNumber(input.reportedCash, 0);
  const unitPrice = resolveUnitPrice(input.unitPrice);

  const expectedRevenue = roundMoney(meterVolume * unitPrice);
  const variance = roundMoney(reportedCash - expectedRevenue);
  const discrepancyRatio = calculateDiscrepancyRatio(
    variance,
    expectedRevenue,
  );

  return {
    meterVolume,
    reportedCash,
    unitPrice,
    expectedRevenue,
    variance,
    discrepancyRatio,
    discrepancyPercentage: roundTo(discrepancyRatio * 100, 2),
    hasVariance: variance !== 0,
    isCashShortfall: variance < 0,
  };
}
