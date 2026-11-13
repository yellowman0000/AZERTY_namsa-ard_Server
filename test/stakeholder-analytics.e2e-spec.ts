import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

interface FakeLog {
  id: string;
  transactionId: string;
  kioskId: string;
  operatorId: string | null;
  waterType: 'COMMERCIAL' | 'SUBSIDIZED';
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  checksum: string | null;
  isSynced: boolean;
  isReadByManager: boolean;
  recordedAt: Date;
  createdAt: Date;
}

function createFakePrisma() {
  const kiosks = new Map<string, { id: string; status: string }>();
  const logs: FakeLog[] = [];

  return {
    kiosks,
    logs,
    kiosk: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          kiosks.get(where.id) ?? null,
      ),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    dailyLog: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where?: {
            kioskId?: string;
            recordedAt?: { gte?: Date; lte?: Date };
          };
        }) => {
          return logs
            .filter((l) => {
              if (where?.kioskId && l.kioskId !== where.kioskId) return false;
              if (
                where?.recordedAt?.gte &&
                l.recordedAt < where.recordedAt.gte
              ) {
                return false;
              }
              return !(where?.recordedAt?.lte &&
                l.recordedAt > where.recordedAt.lte);

            })
            .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
        },
      ),
      findUnique: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

describe('Stakeholder Analytics Endpoint (Story 09, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createFakePrisma>;

  beforeEach(async () => {
    prisma = createFakePrisma();
    prisma.kiosks.set('KIOSK-001', { id: 'KIOSK-001', status: 'ONLINE' });
    prisma.kiosks.set('KIOSK-002', { id: 'KIOSK-002', status: 'ONLINE' });

    // Seed October logs matching specification Section 3.4 example:
    // totalGrossRevenue: 45000.0
    // outstandingUncollectedCash: 1250.0 (sum of shortfalls)
    // waterLossPercentage: 2.78% (1250 / 45000 * 100)
    // subsidizedVolumeLiters: 8500.0
    // commercialSalesVolumeLiters: 22500.0
    prisma.logs.push(
      // Subsidized log with negative variance
      {
        id: 'log-oct-1',
        transactionId: 'TXN-20261005-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-101',
        waterType: 'SUBSIDIZED',
        meterVolume: 8500,
        reportedCash: 16000,
        expectedRevenue: 17000,
        variance: -1000,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: true,
        recordedAt: new Date('2026-10-05T08:00:00.000Z'),
        createdAt: new Date('2026-10-05T08:00:00.000Z'),
      },
      // Commercial log with negative variance
      {
        id: 'log-oct-2',
        transactionId: 'TXN-20261015-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-102',
        waterType: 'COMMERCIAL',
        meterVolume: 20000,
        reportedCash: 24750,
        expectedRevenue: 25000,
        variance: -250,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: true,
        recordedAt: new Date('2026-10-15T10:00:00.000Z'),
        createdAt: new Date('2026-10-15T10:00:00.000Z'),
      },
      // Commercial log on KIOSK-002 with 0 variance
      {
        id: 'log-oct-3',
        transactionId: 'TXN-20261031-001',
        kioskId: 'KIOSK-002',
        operatorId: 'OP-103',
        waterType: 'COMMERCIAL',
        meterVolume: 2500,
        reportedCash: 3000,
        expectedRevenue: 3000,
        variance: 0,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: true,
        recordedAt: new Date('2026-10-31T23:59:59.000Z'),
        createdAt: new Date('2026-10-31T23:59:59.000Z'),
      },
      // Edge logs outside October (should be excluded when querying 2026-10)
      {
        id: 'log-sep-edge',
        transactionId: 'TXN-20260930-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-100',
        waterType: 'COMMERCIAL',
        meterVolume: 5000,
        reportedCash: 10000,
        expectedRevenue: 10000,
        variance: 0,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: true,
        recordedAt: new Date('2026-09-30T23:59:59.999Z'),
        createdAt: new Date('2026-09-30T23:59:59.999Z'),
      },
      {
        id: 'log-nov-edge',
        transactionId: 'TXN-20261101-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-104',
        waterType: 'SUBSIDIZED',
        meterVolume: 3000,
        reportedCash: 6000,
        expectedRevenue: 6000,
        variance: 0,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: true,
        recordedAt: new Date('2026-11-01T00:00:00.000Z'),
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      },
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/kiosk/analytics/stakeholder?month=2026-10 matches specification format and values', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/kiosk/analytics/stakeholder')
      .query({ month: '2026-10' })
      .expect(200);

    expect(res.body).toEqual({
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

  it('GET /kiosk/analytics/stakeholder?month=2026-10 works with alternative route prefix', async () => {
    const res = await request(app.getHttpServer())
      .get('/kiosk/analytics/stakeholder')
      .query({ month: '2026-10' })
      .expect(200);

    expect(res.body.month).toBe('2026-10');
    expect(res.body.summaryCards.totalGrossRevenue).toBe(45000.0);
  });

  it('GET /api/kiosk/analytics/stakeholder defaults to current UTC month when month is omitted', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/kiosk/analytics/stakeholder')
      .expect(200);

    const now = new Date();
    const expectedMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    expect(res.body.month).toBe(expectedMonth);
    expect(res.body.summaryCards).toBeDefined();
    expect(res.body.socialAssistanceChart).toBeDefined();
  });

  it('filters by kioskId when kioskId is provided', async () => {
    // Only KIOSK-002 logs (log-oct-3: meterVolume 2500 COMMERCIAL, revenue 3000, variance 0)
    const res = await request(app.getHttpServer())
      .get('/api/kiosk/analytics/stakeholder')
      .query({ month: '2026-10', kioskId: 'KIOSK-002' })
      .expect(200);

    expect(res.body).toEqual({
      month: '2026-10',
      summaryCards: {
        totalGrossRevenue: 3000.0,
        outstandingUncollectedCash: 0,
        waterLossPercentage: 0,
      },
      socialAssistanceChart: {
        subsidizedVolumeLiters: 0,
        commercialSalesVolumeLiters: 2500.0,
      },
    });
  });

  it('returns 400 Bad Request when month format is invalid', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/kiosk/analytics/stakeholder')
      .query({ month: 'invalid-month' })
      .expect(400);

    expect(res.body.message).toEqual(
      expect.arrayContaining([
        expect.stringContaining('month must be in YYYY-MM format'),
      ]),
    );
  });

  it('returns 400 Bad Request when month is 2026-13', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/kiosk/analytics/stakeholder')
      .query({ month: '2026-13' })
      .expect(400);

    expect(res.body.message).toEqual(
      expect.arrayContaining([
        expect.stringContaining('month must be in YYYY-MM format'),
      ]),
    );
  });
});
