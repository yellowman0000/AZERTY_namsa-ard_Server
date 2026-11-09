import { BadRequestException } from '@nestjs/common';
import {
  calculateReportSummary,
  generateCsvReport,
  generatePdfReport,
  getReportFilename,
  ReportExportService,
} from './report-export.service';
import { PrismaService } from '../prisma.service';

describe('Report Export Service (Story 07, Unit)', () => {
  let service: ReportExportService;
  let mockPrisma: any;

  const mockLogs = [
    {
      id: 'log-1',
      transactionId: 'TXN-001',
      kioskId: 'KIOSK-001',
      operatorId: 'OP-104',
      waterType: 'COMMERCIAL',
      meterVolume: 500,
      reportedCash: 950,
      expectedRevenue: 1000,
      variance: -50,
      isAnomaly: false,
      recordedAt: new Date('2026-10-31T10:00:00.000Z'),
    },
    {
      id: 'log-2',
      transactionId: 'TXN-002',
      kioskId: 'KIOSK-001',
      operatorId: 'OP-105',
      waterType: 'SUBSIDIZED',
      meterVolume: 300,
      reportedCash: 300,
      expectedRevenue: 300,
      variance: 0,
      isAnomaly: false,
      recordedAt: new Date('2026-10-31T11:00:00.000Z'),
    },
  ];

  beforeEach(() => {
    mockPrisma = {
      dailyLog: {
        findMany: jest.fn().mockResolvedValue(mockLogs),
      },
    };
    service = new ReportExportService(mockPrisma as PrismaService);
  });

  describe('calculateReportSummary', () => {
    it('aggregates volume, revenue, variance, and discrepancy ratio accurately', () => {
      const summary = calculateReportSummary(mockLogs);

      expect(summary.totalRecords).toBe(2);
      expect(summary.totalVolume).toBe(800);
      expect(summary.totalRevenue).toBe(1250);
      expect(summary.totalExpectedRevenue).toBe(1300);
      expect(summary.totalVariance).toBe(-50);
      // (-50 / 1300) * 100 = -3.846% -> -3.85%
      expect(summary.discrepancyRatio).toBe(-3.85);
      expect(summary.discrepancyRatioPercent).toBe('-3.85%');
    });

    it('handles zero expected revenue gracefully without division by zero', () => {
      const summary = calculateReportSummary([
        {
          meterVolume: 0,
          reportedCash: 0,
          expectedRevenue: 0,
          variance: 0,
        },
      ]);

      expect(summary.totalExpectedRevenue).toBe(0);
      expect(summary.discrepancyRatio).toBe(0);
      expect(summary.discrepancyRatioPercent).toBe('0.00%');
    });

    it('falls back to the shared unit price (150 L × 2 = 300) when expectedRevenue is omitted', () => {
      const summary = calculateReportSummary([
        {
          meterVolume: 150,
          reportedCash: 150,
          expectedRevenue: null,
          variance: null,
        },
      ]);

      expect(summary.totalExpectedRevenue).toBe(300);
      expect(summary.totalVariance).toBe(-150);
      expect(summary.discrepancyRatio).toBe(-50);
      expect(summary.discrepancyRatioPercent).toBe('-50.00%');
    });
  });

  describe('getReportFilename', () => {
    it('generates kiosk-report-2026-10.csv when startDate and endDate are in 2026-10', () => {
      const filename = getReportFilename('csv', '2026-10-01', '2026-10-31');
      expect(filename).toBe('kiosk-report-2026-10.csv');
    });

    it('generates kiosk-report-2026-10.pdf when format is pdf', () => {
      const filename = getReportFilename('pdf', '2026-10-01', '2026-10-31');
      expect(filename).toBe('kiosk-report-2026-10.pdf');
    });

    it('generates date-range filename across different months', () => {
      const filename = getReportFilename('csv', '2026-10-01', '2026-11-15');
      expect(filename).toBe('kiosk-report-2026-10-to-2026-11.csv');
    });

    it('generates current year-month filename when dates are omitted', () => {
      const filename = getReportFilename('csv');
      expect(filename).toMatch(/^kiosk-report-\d{4}-\d{2}\.csv$/);
    });
  });

  describe('generateCsvReport', () => {
    it('produces valid CSV text containing summary metrics and transaction details', () => {
      const summary = calculateReportSummary(mockLogs);
      const buffer = generateCsvReport(
        summary,
        mockLogs,
        '2026-10-01 to 2026-10-31',
      );
      const csv = buffer.toString('utf-8');

      expect(csv).toContain('AZERTY Water Kiosk - Operational Metrics Report');
      expect(csv).toContain('Total Volume Dispensed (L),800.00');
      expect(csv).toContain('Total Revenue Collected,1250.00');
      expect(csv).toContain('Total Expected Revenue,1300.00');
      expect(csv).toContain('Total Variance,-50.00');
      expect(csv).toContain('Discrepancy Ratio (%),-3.85%');
      expect(csv).toContain('TXN-001');
      expect(csv).toContain('TXN-002');
    });
  });

  describe('generatePdfReport', () => {
    it('generates valid PDF buffer starting with %PDF-', async () => {
      const summary = calculateReportSummary(mockLogs);
      const buffer = await generatePdfReport(
        summary,
        mockLogs,
        '2026-10-01 to 2026-10-31',
        'KIOSK-001',
      );

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(500);
      expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('handles empty log list without crashing', async () => {
      const summary = calculateReportSummary([]);
      const buffer = await generatePdfReport(summary, [], 'All Time');

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });
  });

  describe('ReportExportService.generateReport', () => {
    it('exports CSV report with appropriate MIME and headers', async () => {
      const result = await service.generateReport({
        format: 'csv',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      });

      expect(result.contentType).toBe('text/csv; charset=utf-8');
      expect(result.filename).toBe('kiosk-report-2026-10.csv');
      expect(result.summary.totalVolume).toBe(800);
      expect(result.buffer.toString('utf-8')).toContain(
        'Total Volume Dispensed (L),800.00',
      );
    });

    it('exports PDF report with application/pdf MIME', async () => {
      const result = await service.generateReport({
        format: 'pdf',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      });

      expect(result.contentType).toBe('application/pdf');
      expect(result.filename).toBe('kiosk-report-2026-10.pdf');
      expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('rejects unsupported format with 400 Bad Request', async () => {
      await expect(
        service.generateReport({
          format: 'invalid' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects startDate > endDate with 400 Bad Request', async () => {
      await expect(
        service.generateReport({
          startDate: '2026-10-31',
          endDate: '2026-10-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid date string with 400 Bad Request', async () => {
      await expect(
        service.generateReport({
          startDate: 'not-a-date',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.generateReport({
          endDate: 'not-a-date',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
