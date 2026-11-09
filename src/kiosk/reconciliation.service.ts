import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  ANOMALY_THRESHOLD,
  classifyVolumeAnomaly,
  computeMovingAverageBaseline,
  resolveBaselineWindow,
  type AnomalyDirection,
  type AnomalyReason,
  type VolumeBaseline,
} from './volume-anomaly';
import {
  calculateDiscrepancyRatio,
  calculateReconciliation,
  resolveUnitPrice,
  roundMoney,
  roundTo,
  toFiniteNumber,
} from './reconciliation';

// ───────────────────────────────────────────────────────────
//  Story ID 04 – Daily batch reconciliation engine
//
//  For every daily log in the requested window the batch recomputes, using the
//  shared pure algorithms:
//
//    Expected Revenue   = Meter Volume × Unit Price      (reconciliation.ts)
//    Variance           = Reported Cash − Expected Revenue
//    Discrepancy Ratio  = Variance ÷ Expected Revenue
//    Moving Average     = mean(previous N volumes of the same kiosk)
//    isAnomaly          = |Volume − Moving Average| > 0.30 × Moving Average
//
//  The stored `expectedRevenue` / `variance` / `isAnomaly` columns are then
//  brought up to date. Only rows whose stored values differ from the freshly
//  computed ones are written, so running the same batch twice is a no-op.
// ───────────────────────────────────────────────────────────

/** Environment switch for the optional in-process daily scheduler. */
export const BATCH_SCHEDULER_ENV_VAR = 'RECONCILIATION_BATCH_ENABLED';

/** Hour (UTC) at which the optional daily batch runs. */
export const BATCH_HOUR_UTC = 0;

/** Minute (UTC) at which the optional daily batch runs. */
export const BATCH_MINUTE_UTC = 15;

/** Maximum number of update statements sent in one transaction chunk. */
export const BATCH_CHUNK_SIZE = 100;

/** Date/time columns needed to compute both metrics and baselines. */
const BATCH_SELECT = {
  id: true,
  transactionId: true,
  kioskId: true,
  meterVolume: true,
  reportedCash: true,
  expectedRevenue: true,
  variance: true,
  isAnomaly: true,
  recordedAt: true,
  createdAt: true,
} as const;

/**
 * Deterministic chronological ordering shared by the target query and the
 * baseline-history query. Ties are broken by `createdAt` and finally `id` so
 * the "previous N records" baseline is stable even for equal timestamps.
 */
const BATCH_ORDER_BY = [
  { kioskId: 'asc' },
  { recordedAt: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] as const;

/** A DailyLog row as needed by the batch engine. */
export interface BatchSourceLog {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  recordedAt: Date;
  createdAt: Date;
}

/** Options accepted by {@link ReconciliationService.runBatch}. */
export interface ReconciliationBatchOptions {
  /** Restrict the batch to one kiosk. */
  kioskId?: string;
  /** Inclusive start of the target period (baseline history may be earlier). */
  startDate?: Date;
  /** Inclusive end of the target period. */
  endDate?: Date;
  /** Shorthand for a single whole UTC day; takes precedence over the range. */
  date?: Date;
  /** Baseline window override (default 7, capped at 365). */
  window?: number;
  /** Unit price override (defaults to the shared server-side price). */
  unitPrice?: number;
  /** When true nothing is persisted; the report shows what *would* change. */
  dryRun?: boolean;
}

/** Per-record outcome of one reconciliation run. */
export interface BatchRecordResult {
  id: string;
  transactionId: string;
  kioskId: string;
  /** ISO-8601 timestamp of the daily reading. */
  recordedAt: string;
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  discrepancyRatio: number;
  discrepancyPercentage: number;
  hasVariance: boolean;
  isCashShortfall: boolean;
  movingAverage: number;
  baselineSampleSize: number;
  baselineWindow: number;
  deviation: number;
  deviationRatio: number | null;
  threshold: number;
  isAnomaly: boolean;
  anomalyDirection: AnomalyDirection;
  anomalyReason: AnomalyReason;
  /** True when the stored row differed and was (or would be) updated. */
  changed: boolean;
}

export interface ReconciliationBatchTotals {
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  discrepancyRatio: number;
  discrepancyPercentage: number;
}

export interface ReconciliationBatchFilters {
  kioskId: string | null;
  /** ISO-8601 start boundary, or null when unbounded. */
  startDate: string | null;
  /** ISO-8601 end boundary, or null when unbounded. */
  endDate: string | null;
}

export interface BatchSummary {
  success: true;
  /** ISO-8601 timestamp of when the batch finished computing. */
  processedAt: string;
  dryRun: boolean;
  /** Effective unit price used for every record in this run (KES/litre). */
  unitPrice: number;
  baselineWindow: number;
  anomalyThreshold: number;
  filters: ReconciliationBatchFilters;
  processedCount: number;
  /** Rows actually written; always 0 for a dry run. */
  updatedCount: number;
  anomalyCount: number;
  varianceCount: number;
  shortfallCount: number;
  totals: ReconciliationBatchTotals;
  records: BatchRecordResult[];
  anomalies: BatchRecordResult[];
}

/** Midnight (00:00:00.000) UTC of the given instant. */
export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/** Last millisecond (23:59:59.999) UTC of the given instant. */
export function endOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

/**
 * Milliseconds until the next scheduled batch run (00:15 UTC). Exported so the
 * scheduler timing can be unit-tested without waiting for a real timer.
 */
export function millisecondsUntilNextUtcBatch(from: Date): number {
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      BATCH_HOUR_UTC,
      BATCH_MINUTE_UTC,
      0,
      0,
    ),
  );
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - from.getTime();
}

/** Chronological log comparator (`kioskId`, `recordedAt`, `createdAt`, `id`). */
function compareLogs(a: BatchSourceLog, b: BatchSourceLog): number {
  if (a.kioskId !== b.kioskId) return a.kioskId < b.kioskId ? -1 : 1;
  const recordedDiff = a.recordedAt.getTime() - b.recordedAt.getTime();
  if (recordedDiff !== 0) return recordedDiff;
  const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Splits an array into chunks of at most `size` elements. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * True when the stored reconciliation columns no longer match the freshly
 * computed values. Stored money is compared after rounding to 2 decimals so
 * binary floating-point noise does not trigger pointless writes.
 */
function hasStoredValuesChanged(
  log: BatchSourceLog,
  expectedRevenue: number,
  variance: number,
  isAnomaly: boolean,
): boolean {
  return (
    roundMoney(toFiniteNumber(log.expectedRevenue, 0)) !== expectedRevenue ||
    roundMoney(toFiniteNumber(log.variance, 0)) !== variance ||
    Boolean(log.isAnomaly) !== isAnomaly
  );
}

/** Aggregates per-record metrics into the batch totals (money rounded to 2). */
export function aggregateBatchTotals(
  records: readonly BatchRecordResult[],
): ReconciliationBatchTotals {
  let meterVolume = 0;
  let reportedCash = 0;
  let expectedRevenue = 0;
  let variance = 0;

  for (const record of records) {
    meterVolume += record.meterVolume;
    reportedCash += record.reportedCash;
    expectedRevenue += record.expectedRevenue;
    variance += record.variance;
  }

  const roundedExpectedRevenue = roundMoney(expectedRevenue);
  const roundedVariance = roundMoney(variance);
  const discrepancyRatio = calculateDiscrepancyRatio(
    roundedVariance,
    roundedExpectedRevenue,
  );

  return {
    meterVolume: roundMoney(meterVolume),
    reportedCash: roundMoney(reportedCash),
    expectedRevenue: roundedExpectedRevenue,
    variance: roundedVariance,
    discrepancyRatio,
    discrepancyPercentage: roundTo(discrepancyRatio * 100, 2),
  };
}

@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private batchTimer?: NodeJS.Timeout;
  private batchSchedulerActive = false;

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────
  //  Batch engine
  // ─────────────────────────────────────────────────────────

  /**
   * Recomputes revenue metrics and moving-average volume anomalies for every
   * daily log in the requested range and persists the changed rows.
   *
   * Semantics:
   *  - `date` shorthand wins over `startDate`/`endDate` and means that whole
   *    UTC day (00:00:00.000Z … 23:59:59.999Z).
   *  - Baselines use the previous `window` logs of the *same* kiosk, strictly
   *    earlier in `(kioskId, recordedAt, createdAt, id)` order, so the current
   *    record is never part of its own baseline.
   *  - Only rows whose stored `expectedRevenue`/`variance`/`isAnomaly` differ
   *    from the computed values are written, in chunks of at most 100.
   *  - `dryRun` computes everything but leaves the database untouched.
   *
   * The run is deterministic and idempotent: an identical second run reports
   * `updatedCount: 0`.
   */
  async runBatch(
    options: ReconciliationBatchOptions = {},
  ): Promise<BatchSummary> {
    const window = resolveBaselineWindow(options.window);
    const unitPrice = resolveUnitPrice(options.unitPrice);
    const kioskId = options.kioskId?.trim() || undefined;
    const { start, end } = this.resolveDateRange(options);
    const dryRun = options.dryRun === true;

    const targets = await this.fetchTargetLogs({ kioskId, start, end });

    // No earlier history needs a second query when the target range is not
    // limited at the start: every log up to `end` is already a target.
    const history =
      start !== undefined && targets.length > 0
        ? await this.fetchBaselineHistory(
            [...new Set(targets.map((log) => log.kioskId))],
            end,
          )
        : [];

    const merged = new Map<string, BatchSourceLog>();
    for (const log of history) merged.set(log.id, log);
    for (const log of targets) merged.set(log.id, log);

    const byKiosk = new Map<string, BatchSourceLog[]>();
    for (const log of merged.values()) {
      const group = byKiosk.get(log.kioskId);
      if (group) group.push(log);
      else byKiosk.set(log.kioskId, [log]);
    }
    for (const group of byKiosk.values()) group.sort(compareLogs);

    const orderedTargets = [...targets].sort(compareLogs);
    const records: BatchRecordResult[] = orderedTargets.map((log) => {
      const timeline = byKiosk.get(log.kioskId) ?? [log];
      const position = timeline.findIndex((entry) => entry.id === log.id);
      const historySlice =
        position > 0
          ? timeline.slice(Math.max(0, position - window), position)
          : [];
      const baseline: VolumeBaseline = computeMovingAverageBaseline(
        historySlice.map((entry) => entry.meterVolume),
        window,
      );
      const reconciliation = calculateReconciliation({
        meterVolume: log.meterVolume,
        reportedCash: log.reportedCash,
        unitPrice,
      });
      const anomaly = classifyVolumeAnomaly(
        log.meterVolume,
        baseline,
        ANOMALY_THRESHOLD,
      );

      return {
        id: log.id,
        transactionId: log.transactionId,
        kioskId: log.kioskId,
        recordedAt: log.recordedAt.toISOString(),
        meterVolume: reconciliation.meterVolume,
        reportedCash: reconciliation.reportedCash,
        expectedRevenue: reconciliation.expectedRevenue,
        variance: reconciliation.variance,
        discrepancyRatio: reconciliation.discrepancyRatio,
        discrepancyPercentage: reconciliation.discrepancyPercentage,
        hasVariance: reconciliation.hasVariance,
        isCashShortfall: reconciliation.isCashShortfall,
        movingAverage: anomaly.movingAverage,
        baselineSampleSize: anomaly.baselineSampleSize,
        baselineWindow: anomaly.baselineWindow,
        deviation: anomaly.deviation,
        deviationRatio: anomaly.deviationRatio,
        threshold: anomaly.threshold,
        isAnomaly: anomaly.isAnomaly,
        anomalyDirection: anomaly.direction,
        anomalyReason: anomaly.reason,
        changed: hasStoredValuesChanged(
          log,
          reconciliation.expectedRevenue,
          reconciliation.variance,
          anomaly.isAnomaly,
        ),
      };
    });

    const changedRecords = records.filter((record) => record.changed);
    const updatedCount =
      dryRun || changedRecords.length === 0
        ? 0
        : await this.persistChangedRecords(changedRecords);

    const anomalies = records.filter((record) => record.isAnomaly);

    return {
      success: true,
      processedAt: new Date().toISOString(),
      dryRun,
      unitPrice,
      baselineWindow: window,
      anomalyThreshold: ANOMALY_THRESHOLD,
      filters: {
        kioskId: kioskId ?? null,
        startDate: start ? start.toISOString() : null,
        endDate: end ? end.toISOString() : null,
      },
      processedCount: records.length,
      updatedCount,
      anomalyCount: anomalies.length,
      varianceCount: records.filter((record) => record.hasVariance).length,
      shortfallCount: records.filter((record) => record.isCashShortfall).length,
      totals: aggregateBatchTotals(records),
      records,
      anomalies,
    };
  }

  /** Resolves `date` / `startDate` / `endDate` into an inclusive UTC range. */
  private resolveDateRange(options: ReconciliationBatchOptions): {
    start?: Date;
    end?: Date;
  } {
    if (options.date !== undefined) {
      const date = this.normalizeDate(options.date, 'date');
      return { start: startOfUtcDay(date), end: endOfUtcDay(date) };
    }

    const start =
      options.startDate !== undefined
        ? this.normalizeDate(options.startDate, 'startDate')
        : undefined;
    const end =
      options.endDate !== undefined
        ? this.normalizeDate(options.endDate, 'endDate')
        : undefined;

    if (start && end && start.getTime() > end.getTime()) {
      throw new BadRequestException('startDate must not be after endDate');
    }

    return { start, end };
  }

  private normalizeDate(value: Date, name: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BadRequestException(
        `${name} must be a valid ISO-8601 date string`,
      );
    }
    return value;
  }

  /** Logs inside the target filters, chronologically ordered. */
  private async fetchTargetLogs(filters: {
    kioskId?: string;
    start?: Date;
    end?: Date;
  }): Promise<BatchSourceLog[]> {
    const { kioskId, start, end } = filters;

    return this.prisma.dailyLog.findMany({
      where: {
        ...(kioskId ? { kioskId } : {}),
        ...(start || end
          ? {
              recordedAt: {
                ...(start ? { gte: start } : {}),
                ...(end ? { lte: end } : {}),
              },
            }
          : {}),
      },
      orderBy: [...BATCH_ORDER_BY],
      select: BATCH_SELECT,
    }) as unknown as Promise<BatchSourceLog[]>;
  }

  /** Complete earlier history (up to `end`) for the kiosks in the batch. */
  private async fetchBaselineHistory(
    kioskIds: string[],
    end?: Date,
  ): Promise<BatchSourceLog[]> {
    if (kioskIds.length === 0) return [];

    return this.prisma.dailyLog.findMany({
      where: {
        kioskId: { in: kioskIds },
        ...(end ? { recordedAt: { lte: end } } : {}),
      },
      orderBy: [...BATCH_ORDER_BY],
      select: BATCH_SELECT,
    }) as unknown as Promise<BatchSourceLog[]>;
  }

  /**
   * Writes the changed reconciliation columns in chunks of at most
   * {@link BATCH_CHUNK_SIZE}. A real PrismaClient is written transactionally;
   * lightweight/mock clients that do not expose `$transaction` fall back to
   * `Promise.all`.
   */
  private async persistChangedRecords(
    records: readonly BatchRecordResult[],
  ): Promise<number> {
    if (records.length === 0) return 0;

    const transactionRunner = (
      this.prisma as unknown as { $transaction?: unknown }
    ).$transaction;

    for (const batch of chunk(records, BATCH_CHUNK_SIZE)) {
      const operations = batch.map((record) =>
        this.prisma.dailyLog.update({
          where: { id: record.id },
          data: {
            expectedRevenue: record.expectedRevenue,
            variance: record.variance,
            isAnomaly: record.isAnomaly,
          },
        }),
      );

      if (typeof transactionRunner === 'function') {
        await (
          transactionRunner as (
            this: PrismaService,
            operations: unknown[],
          ) => Promise<unknown>
        ).call(this.prisma, operations);
      } else {
        await Promise.all(operations);
      }
    }

    return records.length;
  }

  // ─────────────────────────────────────────────────────────
  //  Optional in-process daily scheduler (disabled by default)
  // ─────────────────────────────────────────────────────────

  /**
   * Starts the daily batch only when `RECONCILIATION_BATCH_ENABLED === 'true'`
   * and the app is not running under test. Runs every day at 00:15 UTC for the
   * previous UTC day using a chained `setTimeout` (no cron dependency).
   */
  onModuleInit(): void {
    if (process.env[BATCH_SCHEDULER_ENV_VAR] !== 'true') return;
    if (process.env.NODE_ENV === 'test') return;

    this.batchSchedulerActive = true;
    this.scheduleNextBatch();
    this.logger.log(
      `Daily reconciliation batch scheduler enabled (next run ${String(BATCH_HOUR_UTC).padStart(2, '0')}:${String(BATCH_MINUTE_UTC).padStart(2, '0')} UTC).`,
    );
  }

  onModuleDestroy(): void {
    this.batchSchedulerActive = false;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
  }

  private scheduleNextBatch(): void {
    if (!this.batchSchedulerActive) return;

    const delay = millisecondsUntilNextUtcBatch(new Date());
    this.batchTimer = setTimeout(() => {
      this.runScheduledBatch();
    }, delay);
  }

  private runScheduledBatch(): void {
    this.runBatch({ date: this.previousUtcDay() })
      .then((summary) => {
        this.logBatchSummary(summary);
        this.scheduleNextBatch();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Scheduled reconciliation batch failed: ${message}`);
        this.scheduleNextBatch();
      });
  }

  /** Yesterday (UTC) as a plain day — the period a 00:15 run interprets. */
  private previousUtcDay(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
  }

  private logBatchSummary(summary: BatchSummary): void {
    this.logger.log(
      `Reconciliation batch processed=${summary.processedCount} ` +
        `updated=${summary.updatedCount} anomalies=${summary.anomalyCount} ` +
        `variances=${summary.varianceCount} shortfalls=${summary.shortfallCount} ` +
        `(range ${summary.filters.startDate ?? 'beginning'} … ${summary.filters.endDate ?? 'now'})`,
    );
  }
}
