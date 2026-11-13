import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';
import { StakeholderAnalyticsController } from './stakeholder-analytics.controller';
import { StakeholderAnalyticsService } from './stakeholder-analytics.service';
import {
  calculateStakeholderAnalytics,
  resolveMonthDateRange,
  resolveTargetMonth,
} from './stakeholder-analytics';

describe('Stakeholder Analytics (Story 09, Unit)', () => {
  describe('resolveTargetMonth', () => {
    it('returns the trimmed supplied month', () => {
      expect(resolveTargetMonth(' 2026-10 ')).toBe('2026-10');
    });

    it('defaults to current UTC month when omitted or empty', () => {
      const now = new Date();
      const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(resolveTargetMonth()).toBe(expected);
      expect(resolveTargetMonth('')).toBe(expected);
      expect(resolveTargetMonth('   ')).toBe(expected);
    });
  });

  describe('resolveMonthDateRange', () => {
    it('resolves 31-day month range correctly (October 2026)', () => {
      const { startDate, endDate } = resolveMonthDateRange('2026-10');
      expect(startDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2026-10-31T23:59:59.999Z');
    });

    it('resolves 30-day month range correctly (November 2026)', () => {
      const { startDate, endDate } = resolveMonthDateRange('2026-11');
      expect(startDate.toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2026-11-30T23:59:59.999Z');
    });

    it('handles leap year February (February 2024)', () => {
      const { startDate, endDate } = resolveMonthDateRange('2024-02');
      expect(startDate.toISOString()).toBe('2024-02-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2024-02-29T23:59:59.999Z');
    });

    it('handles non-leap year February (February 2026)', () => {
      const { startDate, endDate } = resolveMonthDateRange('2026-02');
      expect(startDate.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2026-02-28T23:59:59.999Z');
    });

    it('throws BadRequestException for invalid month strings', () => {
      expect(() => resolveMonthDateRange('invalid')).toThrow(BadRequestException);
      expect(() => resolveMonthDateRange('2026-13')).toThrow(BadRequestException);
      expect(() => resolveMonthDateRange('2026-00')).toThrow(BadRequestException);
      expect(() => resolveMonthDateRange('2026/10')).toThrow(BadRequestException);
      expect(() => resolveMonthDateRange('2026-1')).toThrow(BadRequestException);
    });
  });

  describe('calculateStakeholderAnalytics', () => {
    it('reproduces the specification example exactly (Story 09 §3.4)', () => {
      // Mock logs matching spec totals:
      // totalGrossRevenue: 45000.0
      // outstandingUncollectedCash: 1250.0 (negative variance sum)
      // waterLossPercentage: 2.78% (1250 / 45000 * 100)
      // subsidizedVolumeLiters: 8500.0
      // commercialSalesVolumeLiters: 22500.0
      const logs = [
        {
          meterVolume: 8500,
          reportedCash: 16000,
          expectedRevenue: 17000,
          variance: -1000,
          waterType: 'SUBSIDIZED',
        },
        {
          meterVolume: 20000,
          reportedCash: 24750,
          expectedRevenue: 25000,
          variance: -250,
          waterType: 'COMMERCIAL',
        },
        {
          meterVolume: 2500,
          reportedCash: 3000,
          expectedRevenue: 3000,
          variance: 0,
          waterType: 'COMMERCIAL',
        },
      ];

      const result = calculateStakeholderAnalytics(logs, '2026-10');

      expect(result).toEqual({
        month: '2026-10',
        summaryCards: {
          totalGrossRevenue: 45000.0,
          outstandingUncollectedCash: 1250.0,
          waterLossPercentage: 2.78,
        },
        socialAssistanceChart: {
          subsidizedVolumeLiters: 8500.0,
          commercialSalesVolumeLiters: 22500.0,
        },
      });
    });

    it('handles empty log array with zeroes', () => {
      const result = calculateStakeholderAnalytics([], '2026-10');

      expect(result).toEqual({
        month: '2026-10',
        summaryCards: {
          totalGrossRevenue: 0,
          outstandingUncollectedCash: 0,
          waterLossPercentage: 0,
        },
        socialAssistanceChart: {
          subsidizedVolumeLiters: 0,
          commercialSalesVolumeLiters: 0,
        },
      });
    });

    it('does not allow positive variances to cancel out uncollected cash', () => {
      // Log 1: 500 cash shortfall (variance -500)
      // Log 2: 500 surplus (variance +500)
      // uncollectedCash must still be 500!
      const logs = [
        {
          meterVolume: 1000,
          reportedCash: 1500,
          expectedRevenue: 2000,
          variance: -500,
          waterType: 'COMMERCIAL',
        },
        {
          meterVolume: 1000,
          reportedCash: 2500,
          expectedRevenue: 2000,
          variance: 500,
          waterType: 'COMMERCIAL',
        },
      ];

      const result = calculateStakeholderAnalytics(logs, '2026-10');

      expect(result.summaryCards.totalGrossRevenue).toBe(4000);
      expect(result.summaryCards.outstandingUncollectedCash).toBe(500);
      expect(result.summaryCards.waterLossPercentage).toBe(12.5); // 500 / 4000 * 100 = 12.5
      expect(result.socialAssistanceChart.commercialSalesVolumeLiters).toBe(2000);
      expect(result.socialAssistanceChart.subsidizedVolumeLiters).toBe(0);
    });

    it('falls back to meterVolume * unitPrice when expectedRevenue is omitted', () => {
      const logs = [
        {
          meterVolume: 200,
          reportedCash: 350,
          waterType: 'COMMERCIAL',
        },
      ];

      // At default unit price = 2 KES/L: expected = 400, variance = 350 - 400 = -50
      const result = calculateStakeholderAnalytics(logs, '2026-10');

      expect(result.summaryCards.totalGrossRevenue).toBe(400);
      expect(result.summaryCards.outstandingUncollectedCash).toBe(50);
      expect(result.summaryCards.waterLossPercentage).toBe(12.5);
    });

    it('defaults unknown or undefined waterType to COMMERCIAL', () => {
      const logs = [
        {
          meterVolume: 100,
          reportedCash: 200,
          expectedRevenue: 200,
          variance: 0,
        },
      ];

      const result = calculateStakeholderAnalytics(logs, '2026-10');

      expect(result.socialAssistanceChart.commercialSalesVolumeLiters).toBe(100);
      expect(result.socialAssistanceChart.subsidizedVolumeLiters).toBe(0);
    });
  });

  describe('StakeholderAnalyticsService', () => {
    let service: StakeholderAnalyticsService;
    let prismaMock: {
      dailyLog: {
        findMany: jest.Mock;
      };
    };

    beforeEach(async () => {
      prismaMock = {
        dailyLog: {
          findMany: jest.fn(),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StakeholderAnalyticsService,
          { provide: PrismaService, useValue: prismaMock },
        ],
      }).compile();

      service = module.get<StakeholderAnalyticsService>(
        StakeholderAnalyticsService,
      );
    });

    it('queries Prisma with date bounds and aggregates records', async () => {
      prismaMock.dailyLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          meterVolume: 100,
          reportedCash: 190,
          expectedRevenue: 200,
          variance: -10,
          waterType: 'SUBSIDIZED',
        },
      ]);

      const result = await service.getStakeholderAnalytics({
        month: '2026-10',
      });

      expect(prismaMock.dailyLog.findMany).toHaveBeenCalledWith({
        where: {
          recordedAt: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lte: new Date('2026-10-31T23:59:59.999Z'),
          },
        },
        orderBy: { recordedAt: 'asc' },
      });

      expect(result.month).toBe('2026-10');
      expect(result.summaryCards.totalGrossRevenue).toBe(200);
      expect(result.summaryCards.outstandingUncollectedCash).toBe(10);
      expect(result.summaryCards.waterLossPercentage).toBe(5);
      expect(result.socialAssistanceChart.subsidizedVolumeLiters).toBe(100);
      expect(result.socialAssistanceChart.commercialSalesVolumeLiters).toBe(0);
    });

    it('applies kioskId filter when provided', async () => {
      prismaMock.dailyLog.findMany.mockResolvedValue([]);

      await service.getStakeholderAnalytics({
        month: '2026-10',
        kioskId: 'KIOSK-001',
      });

      expect(prismaMock.dailyLog.findMany).toHaveBeenCalledWith({
        where: {
          recordedAt: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lte: new Date('2026-10-31T23:59:59.999Z'),
          },
          kioskId: 'KIOSK-001',
        },
        orderBy: { recordedAt: 'asc' },
      });
    });

    it('throws BadRequestException when invalid month is provided', async () => {
      await expect(
        service.getStakeholderAnalytics({ month: '2026-15' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('StakeholderAnalyticsController', () => {
    let controller: StakeholderAnalyticsController;
    let serviceMock: {
      getStakeholderAnalytics: jest.Mock;
    };

    beforeEach(async () => {
      serviceMock = {
        getStakeholderAnalytics: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [StakeholderAnalyticsController],
        providers: [
          { provide: StakeholderAnalyticsService, useValue: serviceMock },
        ],
      }).compile();

      controller = module.get<StakeholderAnalyticsController>(
        StakeholderAnalyticsController,
      );
    });

    it('delegates to StakeholderAnalyticsService', async () => {
      const mockResult = {
        month: '2026-10',
        summaryCards: {
          totalGrossRevenue: 45000,
          outstandingUncollectedCash: 1250,
          waterLossPercentage: 2.78,
        },
        socialAssistanceChart: {
          subsidizedVolumeLiters: 8500,
          commercialSalesVolumeLiters: 22500,
        },
      };

      serviceMock.getStakeholderAnalytics.mockResolvedValue(mockResult);

      const query = { month: '2026-10' };
      const res = await controller.getStakeholderAnalytics(query);

      expect(res).toBe(mockResult);
      expect(serviceMock.getStakeholderAnalytics).toHaveBeenCalledWith(query);
    });
  });
});
