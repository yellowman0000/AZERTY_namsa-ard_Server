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

describe('Report Export Service (Story 07, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createFakePrisma>;

  beforeEach(async () => {
    prisma = createFakePrisma();
    prisma.kiosks.set('KIOSK-001', { id: 'KIOSK-001', status: 'ONLINE' });
    prisma.kiosks.set('KIOSK-002', { id: 'KIOSK-002', status: 'ONLINE' });

    // Seed October logs
    prisma.logs.push(
      {
        id: 'log-oct-1',
        transactionId: 'TXN-20261031-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-104',
        waterType: 'COMMERCIAL',
        meterVolume: 500,
        reportedCash: 950,
        expectedRevenue: 1000,
        variance: -50,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: false,
        recordedAt: new Date('2026-10-31T10:00:00.000Z'),
        createdAt: new Date('2026-10-31T10:00:00.000Z'),
      },
      {
        id: 'log-oct-2',
        transactionId: 'TXN-20261031-002',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-105',
        waterType: 'COMMERCIAL',
        meterVolume: 300,
        reportedCash: 300,
        expectedRevenue: 300,
        variance: 0,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        isReadByManager: false,
        recordedAt: new Date('2026-10-31T12:00:00.000Z'),
        createdAt: new Date('2026-10-31T12:00:00.000Z'),
      },
    );

    // Seed November log
    prisma.logs.push({
      id: 'log-nov-1',
      transactionId: 'TXN-20261101-001',
      kioskId: 'KIOSK-002',
      operatorId: 'OP-106',
      waterType: 'SUBSIDIZED',
      meterVolume: 200,
      reportedCash: 200,
      expectedRevenue: 200,
      variance: 0,
      isAnomaly: false,
      checksum: null,
      isSynced: true,
      isReadByManager: false,
      recordedAt: new Date('2026-11-01T08:00:00.000Z'),
      createdAt: new Date('2026-11-01T08:00:00.000Z'),
    });

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

  const http = () => request(app.getHttpServer());

  describe('GET /api/kiosk/reports/export', () => {
    it('exports CSV report for a filtered date period with accurate totals', async () => {
      const res = await http()
        .get('/api/kiosk/reports/export')
        .query({
          format: 'csv',
          startDate: '2026-10-01',
          endDate: '2026-10-31',
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kiosk-report-2026-10.csv"',
      );

      const csv = res.text;
      expect(csv).toContain('AZERTY Water Kiosk - Operational Metrics Report');
      expect(csv).toContain('Total Volume Dispensed (L),800.00');
      expect(csv).toContain('Total Revenue Collected,1250.00');
      expect(csv).toContain('Total Expected Revenue,1300.00');
      expect(csv).toContain('Total Variance,-50.00');
      expect(csv).toContain('Discrepancy Ratio (%),-3.85%');
      expect(csv).toContain('Total Records,2');
      expect(csv).toContain('TXN-20261031-001');
      expect(csv).toContain('TXN-20261031-002');
      // Should not contain November record
      expect(csv).not.toContain('TXN-20261101-001');
    });

    it('exports PDF report for a filtered date period with application/pdf MIME', async () => {
      const res = await http()
        .get('/api/kiosk/reports/export')
        .query({
          format: 'pdf',
          startDate: '2026-10-01',
          endDate: '2026-10-31',
        })
        .expect(200);

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kiosk-report-2026-10.pdf"',
      );

      // Verify that response body is a valid PDF
      const pdfBuffer = Buffer.from(res.body);
      expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdfBuffer.length).toBeGreaterThan(500);
    });

    it('defaults to CSV when format query parameter is omitted', async () => {
      const res = await http()
        .get('/api/kiosk/reports/export')
        .query({
          startDate: '2026-10-01',
          endDate: '2026-10-31',
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kiosk-report-2026-10.csv"',
      );
    });

    it('filters by kioskId when specified', async () => {
      const res = await http()
        .get('/api/kiosk/reports/export')
        .query({
          format: 'csv',
          kioskId: 'KIOSK-002',
        })
        .expect(200);

      const csv = res.text;
      expect(csv).toContain('Total Volume Dispensed (L),200.00');
      expect(csv).toContain('TXN-20261101-001');
      expect(csv).not.toContain('TXN-20261031-001');
    });

    it('rejects startDate > endDate with 400 Bad Request', async () => {
      const res = await http()
        .get('/api/kiosk/reports/export')
        .query({
          startDate: '2026-11-01',
          endDate: '2026-10-01',
        })
        .expect(400);

      expect(res.body.message).toContain('startDate must not be after endDate');
    });

    it('rejects invalid format with 400 Bad Request', async () => {
      const res = await http()
        .get('/api/kiosk/reports/export')
        .query({
          format: 'json',
        })
        .expect(400);

      expect(res.body.message).toContain('format must be "csv" or "pdf"');
    });

    it('rejects invalid date strings with 400 Bad Request', async () => {
      await http()
        .get('/api/kiosk/reports/export')
        .query({
          startDate: 'invalid-date',
        })
        .expect(400);

      await http()
        .get('/api/kiosk/reports/export')
        .query({
          endDate: 'invalid-date',
        })
        .expect(400);
    });

    it('answers under alternate route paths (/reports/export, /api/reports/export)', async () => {
      await http().get('/reports/export').expect(200);
      await http().get('/api/reports/export').expect(200);
    });
  });
});
