import { BadRequestException } from '@nestjs/common';
import { LogInspectionService } from './log-inspection.service';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';

describe('Unseen Logs Tracking (Story 08)', () => {
  let logInspectionService: LogInspectionService;
  let kioskService: KioskService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      dailyLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      kiosk: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    logInspectionService = new LogInspectionService(
      mockPrisma as PrismaService,
    );
    kioskService = new KioskService(mockPrisma as PrismaService);
  });

  describe('LogInspectionService.listLogs', () => {
    it('applies isReadByManager: false when unseenOnly=true', async () => {
      mockPrisma.dailyLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          transactionId: 'TXN-1',
          kioskId: 'KIOSK-001',
          meterVolume: 10,
          isReadByManager: false,
          recordedAt: new Date('2026-11-01T10:00:00Z'),
          createdAt: new Date('2026-11-01T10:00:00Z'),
        },
      ]);
      mockPrisma.dailyLog.count.mockResolvedValue(1);

      const result = await logInspectionService.listLogs({ unseenOnly: true });

      expect(mockPrisma.dailyLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isReadByManager: false,
          }),
        }),
      );
      expect(result.unseenCount).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('does not filter by isReadByManager when unseenOnly=false or omitted', async () => {
      await logInspectionService.listLogs({ unseenOnly: false });
      expect(mockPrisma.dailyLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
        }),
      );

      await logInspectionService.listLogs({});
      expect(mockPrisma.dailyLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
        }),
      );
    });

    it('filters by kioskId and unseenOnly combined', async () => {
      await logInspectionService.listLogs({
        kioskId: 'KIOSK-001',
        unseenOnly: true,
      });

      expect(mockPrisma.dailyLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            kioskId: 'KIOSK-001',
            isReadByManager: false,
          },
        }),
      );
      expect(mockPrisma.dailyLog.count).toHaveBeenCalledWith({
        where: {
          kioskId: 'KIOSK-001',
          isReadByManager: false,
        },
      });
    });

    it('filters by date range when startDate and endDate are provided', async () => {
      await logInspectionService.listLogs({
        startDate: '2026-11-01',
        endDate: '2026-11-05',
      });

      expect(mockPrisma.dailyLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            recordedAt: {
              gte: expect.any(Date),
              lte: expect.any(Date),
            },
          }),
        }),
      );
    });

    it('throws BadRequestException when startDate is after endDate', async () => {
      await expect(
        logInspectionService.listLogs({
          startDate: '2026-11-05',
          endDate: '2026-11-01',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when date strings are invalid', async () => {
      await expect(
        logInspectionService.listLogs({
          startDate: 'invalid-date',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        logInspectionService.listLogs({
          endDate: 'invalid-date',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('KioskService.markLogsAsSeen', () => {
    it('marks specific logs by IDs as seen', async () => {
      mockPrisma.dailyLog.updateMany.mockResolvedValue({ count: 2 });

      const res = await kioskService.markLogsAsSeen({
        logIds: ['log-1', 'log-2'],
      });

      expect(mockPrisma.dailyLog.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['log-1', 'log-2'] },
          isReadByManager: false,
        },
        data: {
          isReadByManager: true,
        },
      });
      expect(res).toEqual({
        success: true,
        count: 2,
        markedCount: 2,
        updated: 2,
      });
    });

    it('supports alias ids and single logId/id', async () => {
      mockPrisma.dailyLog.updateMany.mockResolvedValue({ count: 1 });

      await kioskService.markLogsAsSeen({ id: 'log-single' });
      expect(mockPrisma.dailyLog.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['log-single'] },
          isReadByManager: false,
        },
        data: {
          isReadByManager: true,
        },
      });

      await kioskService.markLogsAsSeen({ ids: ['log-a', 'log-b'] });
      expect(mockPrisma.dailyLog.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['log-a', 'log-b'] },
          isReadByManager: false,
        },
        data: {
          isReadByManager: true,
        },
      });
    });

    it('marks all unread logs for a specific kioskId', async () => {
      mockPrisma.dailyLog.updateMany.mockResolvedValue({ count: 5 });

      const res = await kioskService.markLogsAsSeen({
        kioskId: 'KIOSK-001',
      });

      expect(mockPrisma.dailyLog.updateMany).toHaveBeenCalledWith({
        where: {
          isReadByManager: false,
          kioskId: 'KIOSK-001',
        },
        data: {
          isReadByManager: true,
        },
      });
      expect(res.count).toBe(5);
    });

    it('marks logs up to a timestamp', async () => {
      mockPrisma.dailyLog.updateMany.mockResolvedValue({ count: 3 });
      const upTo = '2026-11-05T12:00:00.000Z';

      await kioskService.markLogsAsSeen({ upTo });

      expect(mockPrisma.dailyLog.updateMany).toHaveBeenCalledWith({
        where: {
          isReadByManager: false,
          recordedAt: { lte: new Date(upTo) },
        },
        data: {
          isReadByManager: true,
        },
      });
    });

    it('marks all unread logs when no filter is provided', async () => {
      mockPrisma.dailyLog.updateMany.mockResolvedValue({ count: 10 });

      const res = await kioskService.markLogsAsSeen({});

      expect(mockPrisma.dailyLog.updateMany).toHaveBeenCalledWith({
        where: {
          isReadByManager: false,
        },
        data: {
          isReadByManager: true,
        },
      });
      expect(res.count).toBe(10);
    });

    it('countUnseenLogs returns the count of unread logs', async () => {
      mockPrisma.dailyLog.count.mockResolvedValue(7);

      const count = await kioskService.countUnseenLogs('KIOSK-001');

      expect(mockPrisma.dailyLog.count).toHaveBeenCalledWith({
        where: {
          kioskId: 'KIOSK-001',
          isReadByManager: false,
        },
      });
      expect(count).toBe(7);
    });
  });
});
