import { Test, TestingModule } from '@nestjs/testing';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';

// Story 01 – Unit tests for heartbeat ping and disconnection timeout.
// Only Date is faked so we can move the clock without waiting 30 real seconds.
describe('KioskService – heartbeat & disconnection timeout (Story 01)', () => {
  const T0 = new Date('2026-10-16T10:00:00.000Z');

  let service: KioskService;
  let prisma: {
    kiosk: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
  };

  const advanceSeconds = (seconds: number) =>
    jest.setSystemTime(new Date(Date.now() + seconds * 1000));

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(T0);

    prisma = {
      kiosk: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [KioskService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<KioskService>(KioskService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── handleHeartbeat ──────────────────────────────────────

  describe('handleHeartbeat', () => {
    it('should mark the kiosk ONLINE and record the current time as lastHeartbeat', async () => {
      prisma.kiosk.upsert.mockImplementation(({ create }) =>
        Promise.resolve({ ...create }),
      );

      const result = await service.handleHeartbeat('KIOSK-001');

      expect(prisma.kiosk.upsert).toHaveBeenCalledWith({
        where: { id: 'KIOSK-001' },
        update: { status: 'ONLINE', lastHeartbeat: T0 },
        create: { id: 'KIOSK-001', status: 'ONLINE', lastHeartbeat: T0 },
      });
      expect(result).toEqual({
        success: true,
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        timestamp: T0,
      });
    });

    it('should refresh lastHeartbeat on every consecutive ping', async () => {
      prisma.kiosk.upsert.mockImplementation(({ update }) =>
        Promise.resolve({ id: 'KIOSK-001', ...update }),
      );

      await service.handleHeartbeat('KIOSK-001');
      advanceSeconds(10);
      const second = await service.handleHeartbeat('KIOSK-001');

      expect(prisma.kiosk.upsert).toHaveBeenCalledTimes(2);
      expect(second.timestamp).toEqual(new Date(T0.getTime() + 10_000));
    });
  });

  // ─── getKioskStatus ───────────────────────────────────────

  describe('getKioskStatus', () => {
    const kioskPingedAt = (lastHeartbeat: Date, status = 'ONLINE') => ({
      id: 'KIOSK-001',
      status,
      lastHeartbeat,
    });

    it('should report OFFLINE for a kiosk that has never been registered', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(null);

      const result = await service.getKioskStatus('KIOSK-404');

      expect(result).toEqual({
        kioskId: 'KIOSK-404',
        status: 'OFFLINE',
        lastHeartbeat: null,
      });
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should report OFFLINE for a kiosk that has never sent a heartbeat', async () => {
      prisma.kiosk.findUnique.mockResolvedValue({
        id: 'KIOSK-001',
        status: 'OFFLINE',
        lastHeartbeat: null,
      });

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('OFFLINE');
      expect(result.lastHeartbeat).toBeNull();
    });

    it('should report ONLINE right after a heartbeat', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result).toEqual({
        kioskId: 'KIOSK-001',
        status: 'ONLINE',
        lastHeartbeat: T0,
        secondsSinceLastPing: 0,
      });
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should stay ONLINE at 10s (one missed 10s interval is not a disconnect)', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));
      advanceSeconds(10);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('ONLINE');
      expect(result.secondsSinceLastPing).toBe(10);
    });

    it('should stay ONLINE at exactly 30s (boundary)', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));
      advanceSeconds(30);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('ONLINE');
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should switch to OFFLINE and persist it once no ping for more than 30s', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0));
      advanceSeconds(31);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('OFFLINE');
      expect(result.secondsSinceLastPing).toBe(31);
      expect(prisma.kiosk.update).toHaveBeenCalledWith({
        where: { id: 'KIOSK-001' },
        data: { status: 'OFFLINE' },
      });
    });

    it('should not write to the DB again when the kiosk is already stored as OFFLINE', async () => {
      prisma.kiosk.findUnique.mockResolvedValue(kioskPingedAt(T0, 'OFFLINE'));
      advanceSeconds(120);

      const result = await service.getKioskStatus('KIOSK-001');

      expect(result.status).toBe('OFFLINE');
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should propagate DB errors instead of silently reporting a status', async () => {
      prisma.kiosk.findUnique.mockRejectedValue(new Error('DB down'));

      await expect(service.getKioskStatus('KIOSK-001')).rejects.toThrow(
        'DB down',
      );
    });
  });

  // ─── listKioskStatuses (manager dashboard fleet snapshot) ─

  describe('listKioskStatuses', () => {
    it('should report every registered kiosk with its effective status and age', async () => {
      prisma.kiosk.findMany.mockResolvedValue([
        { id: 'KIOSK-001', status: 'ONLINE', lastHeartbeat: T0 },
        {
          id: 'KIOSK-002',
          status: 'ONLINE',
          lastHeartbeat: new Date(T0.getTime() - 60_000),
        },
        { id: 'KIOSK-003', status: 'OFFLINE', lastHeartbeat: null },
      ]);
      advanceSeconds(4);

      const result = await service.listKioskStatuses();

      expect(prisma.kiosk.findMany).toHaveBeenCalledWith({
        select: { id: true, status: true, lastHeartbeat: true },
        orderBy: { id: 'asc' },
      });
      expect(result).toEqual([
        {
          kioskId: 'KIOSK-001',
          status: 'ONLINE',
          lastHeartbeat: T0,
          secondsSinceLastPing: 4,
        },
        {
          kioskId: 'KIOSK-002',
          status: 'OFFLINE',
          lastHeartbeat: new Date(T0.getTime() - 60_000),
          secondsSinceLastPing: 64,
        },
        {
          kioskId: 'KIOSK-003',
          status: 'OFFLINE',
          lastHeartbeat: null,
          secondsSinceLastPing: null,
        },
      ]);
      // Listing is a read: persisting OFFLINE stays the sweeper's job.
      expect(prisma.kiosk.update).not.toHaveBeenCalled();
    });

    it('should stay ONLINE at exactly 30s and flip OFFLINE at 31s', async () => {
      prisma.kiosk.findMany.mockResolvedValue([
        { id: 'KIOSK-001', status: 'ONLINE', lastHeartbeat: T0 },
      ]);

      advanceSeconds(30);
      await expect(service.listKioskStatuses()).resolves.toMatchObject([
        { kioskId: 'KIOSK-001', status: 'ONLINE', secondsSinceLastPing: 30 },
      ]);

      advanceSeconds(1);
      await expect(service.listKioskStatuses()).resolves.toMatchObject([
        { kioskId: 'KIOSK-001', status: 'OFFLINE', secondsSinceLastPing: 31 },
      ]);
    });

    it('should clamp a future heartbeat (clock skew) to 0s instead of a negative age', async () => {
      prisma.kiosk.findMany.mockResolvedValue([
        {
          id: 'KIOSK-001',
          status: 'ONLINE',
          lastHeartbeat: new Date(T0.getTime() + 5_000),
        },
      ]);

      const [kiosk] = await service.listKioskStatuses();

      expect(kiosk.status).toBe('ONLINE');
      expect(kiosk.secondsSinceLastPing).toBe(0);
    });

    it('should return an empty list when no kiosk is registered', async () => {
      prisma.kiosk.findMany.mockResolvedValue([]);

      await expect(service.listKioskStatuses()).resolves.toEqual([]);
    });

    it('should return an empty list when the Prisma delegate is unavailable', async () => {
      (prisma.kiosk as { findMany?: jest.Mock }).findMany = undefined;

      await expect(service.listKioskStatuses()).resolves.toEqual([]);
    });

    it('should propagate DB errors', async () => {
      prisma.kiosk.findMany.mockRejectedValue(new Error('DB down'));

      await expect(service.listKioskStatuses()).rejects.toThrow('DB down');
    });
  });
});
