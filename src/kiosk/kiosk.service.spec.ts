import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';
import { IngestLogDto } from './dto/ingest-log.dto';

describe('KioskService', () => {
  let service: KioskService;
  let prisma: {
    kiosk: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
    dailyLog: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      kiosk: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      dailyLog: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KioskService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<KioskService>(KioskService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── ingestLog ────────────────────────────────────────────

  describe('ingestLog', () => {
    const validDto: IngestLogDto = {
      transactionId: 'TXN-001',
      kioskId: 'KIOSK-001',
      meterVolume: 42.5,
      recordedAt: '2026-10-16T10:00:00.000Z',
      checksum: 'abc123',
    };

    it('should create a log and return success with server timestamp', async () => {
      const now = new Date();
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-1',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: now,
        checksum: 'abc123',
        isSynced: true,
      });

      const result = await service.ingestLog(validDto);

      expect(result).toEqual({
        success: true,
        logId: 'uuid-1',
        transactionId: 'TXN-001',
        kioskId: 'KIOSK-001',
        meterVolume: 42.5,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: now, // server-side timestamp
      });

      expect(prisma.dailyLog.create).toHaveBeenCalledWith({
        data: {
          transactionId: 'TXN-001',
          kioskId: 'KIOSK-001',
          meterVolume: 42.5,
          recordedAt: new Date('2026-10-16T10:00:00.000Z'),
          checksum: 'abc123',
        },
      });
    });

    it('should set checksum to null when not provided', async () => {
      const dtoNoChecksum: IngestLogDto = {
        transactionId: 'TXN-002',
        kioskId: 'KIOSK-001',
        meterVolume: 10,
        recordedAt: '2026-10-16T10:00:00.000Z',
      };

      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      prisma.dailyLog.create.mockResolvedValue({
        id: 'uuid-2',
        transactionId: 'TXN-002',
        kioskId: 'KIOSK-001',
        meterVolume: 10,
        recordedAt: new Date('2026-10-16T10:00:00.000Z'),
        createdAt: new Date(),
        checksum: null,
        isSynced: true,
      });

      await service.ingestLog(dtoNoChecksum);

      expect(prisma.dailyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ checksum: null }),
        }),
      );
    });

    it('should throw NotFoundException when kiosk does not exist', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(null);

      await expect(service.ingestLog(validDto)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.ingestLog(validDto)).rejects.toThrow(
        'Kiosk "KIOSK-001" not found',
      );

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException on duplicate transactionId', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue({ id: 'existing-uuid' });

      await expect(service.ingestLog(validDto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.ingestLog(validDto)).rejects.toThrow(
        'transactionId "TXN-001" already exists',
      );

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException (STATE_CONFLICT) when reading is higher than newer server state', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      // Newer record at 11:00 with meterVolume 30, but incoming is at 10:00 with meterVolume 42.5
      prisma.dailyLog.findFirst.mockImplementation(({ where }: { where: { recordedAt: { gte?: Date; lte?: Date } } }) => {
        if (where.recordedAt?.gte) {
          return Promise.resolve({
            transactionId: 'TXN-NEWER',
            meterVolume: 30.0,
            recordedAt: new Date('2026-10-16T11:00:00.000Z'),
          });
        }
        return Promise.resolve(null);
      });

      await expect(service.ingestLog(validDto)).rejects.toThrow(
        ConflictException,
      );

      try {
        await service.ingestLog(validDto);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.error).toBe('STATE_CONFLICT');
        expect(res.reason).toBe('HIGHER_THAN_NEWER_READING');
      }

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException (STATE_CONFLICT) when reading is lower than older server state', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
      prisma.dailyLog.findUnique.mockResolvedValue(null);
      // Older record at 09:00 with meterVolume 50, but incoming is at 10:00 with meterVolume 42.5
      prisma.dailyLog.findFirst.mockImplementation(({ where }: { where: { recordedAt: { gte?: Date; lte?: Date } } }) => {
        if (where.recordedAt?.lte) {
          return Promise.resolve({
            transactionId: 'TXN-OLDER',
            meterVolume: 50.0,
            recordedAt: new Date('2026-10-16T09:00:00.000Z'),
          });
        }
        return Promise.resolve(null);
      });

      try {
        await service.ingestLog(validDto);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.error).toBe('STATE_CONFLICT');
        expect(res.reason).toBe('LOWER_THAN_OLDER_READING');
      }

      expect(prisma.dailyLog.create).not.toHaveBeenCalled();
    });
  });

  // ─── handleHeartbeat ──────────────────────────────────────

  describe('handleHeartbeat', () => {
    it('should upsert the kiosk and return success', async () => {
      const now = new Date();
      prisma.kiosk.upsert.mockResolvedValue({
        id: 'KIOSK-001',
        status: 'ONLINE',
        lastHeartbeat: now,
      });

      const result = await service.handleHeartbeat('KIOSK-001');

      expect(result).toEqual({
        success: true,
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        timestamp: now,
      });
    });
  });
});
