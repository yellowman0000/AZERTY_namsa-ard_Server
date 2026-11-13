import { BadRequestException } from '@nestjs/common';
import { roundTo, resolveUnitPrice } from './reconciliation';
import { INVALID_MONTH_MESSAGE } from './dto/stakeholder-analytics.dto';

export interface StakeholderSummaryCards {
  totalGrossRevenue: number;
  outstandingUncollectedCash: number;
  waterLossPercentage: number;
}

export interface SocialAssistanceChart {
  subsidizedVolumeLiters: number;
  commercialSalesVolumeLiters: number;
}

export interface StakeholderAnalyticsResponse {
  month: string;
  summaryCards: StakeholderSummaryCards;
  socialAssistanceChart: SocialAssistanceChart;
}

/**
 * Resolves the target month: provided value (trimmed) or current UTC month (YYYY-MM).
 */
export function resolveTargetMonth(month?: string): string {
  if (month && month.trim()) {
    return month.trim();
  }
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

/**
 * Resolves the start and end Date for a given YYYY-MM month string.
 * Start: YYYY-MM-01T00:00:00.000Z
 * End:   last day of month at 23:59:59.999Z
 */
export function resolveMonthDateRange(month: string): {
  startDate: Date;
  endDate: Date;
} {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    throw new BadRequestException(INVALID_MONTH_MESSAGE);
  }
  const year = Number(match[1]);
  const monthNum = Number(match[2]);

  const startDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));

  return { startDate, endDate };
}

/**
 * Pure aggregation function for stakeholder analytics (Story 09).
 * - totalGrossRevenue: sum of expectedRevenue (fallback: meterVolume * unitPrice)
 * - outstandingUncollectedCash: negative variance sum (cash shortfall, positive value)
 * - waterLossPercentage: (uncollectedCash / grossRevenue) * 100, rounded to 2 decimals
 * - subsidizedVolumeLiters: sum of meterVolume where waterType is SUBSIDIZED
 * - commercialSalesVolumeLiters: sum of meterVolume where waterType is COMMERCIAL (or other)
 */
export function calculateStakeholderAnalytics(
  logs: any[],
  month: string,
  unitPrice?: number,
): StakeholderAnalyticsResponse {
  const price = resolveUnitPrice(unitPrice);
  let totalGrossRevenue = 0;
  let outstandingUncollectedCash = 0;
  let subsidizedVolumeLiters = 0;
  let commercialSalesVolumeLiters = 0;

  for (const log of logs) {
    const volume = Number(log.meterVolume) || 0;
    const reportedCash = Number(log.reportedCash) || 0;
    const expected =
      log.expectedRevenue !== null && log.expectedRevenue !== undefined
        ? Number(log.expectedRevenue)
        : volume * price;
    const variance =
      log.variance !== null && log.variance !== undefined
        ? Number(log.variance)
        : reportedCash - expected;

    totalGrossRevenue += expected;

    // uncollectedCash is the negative variance sum (cash shortfall)
    if (variance < 0) {
      outstandingUncollectedCash += Math.abs(variance);
    }

    const waterType = String(log.waterType || 'COMMERCIAL').toUpperCase();
    if (waterType === 'SUBSIDIZED') {
      subsidizedVolumeLiters += volume;
    } else {
      commercialSalesVolumeLiters += volume;
    }
  }

  totalGrossRevenue = roundTo(totalGrossRevenue, 2);
  outstandingUncollectedCash = roundTo(outstandingUncollectedCash, 2);
  const waterLossPercentage =
    totalGrossRevenue > 0
      ? roundTo((outstandingUncollectedCash / totalGrossRevenue) * 100, 2)
      : 0;

  return {
    month,
    summaryCards: {
      totalGrossRevenue,
      outstandingUncollectedCash,
      waterLossPercentage,
    },
    socialAssistanceChart: {
      subsidizedVolumeLiters: roundTo(subsidizedVolumeLiters, 2),
      commercialSalesVolumeLiters: roundTo(commercialSalesVolumeLiters, 2),
    },
  };
}
