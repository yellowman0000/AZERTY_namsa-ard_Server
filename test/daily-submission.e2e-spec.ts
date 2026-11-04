import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { computeReceiptChecksum, verifyReceiptSignature } from '../src/kiosk/receipt';

describe('Daily Submission & Tamper-Evident Receipt E2E', () => {
  let app: INestApplication;
  const mockPrisma = {
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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.kiosk.findUnique.mockResolvedValue({ id: 'KIOSK-001' });
    mockPrisma.dailyLog.findUnique.mockResolvedValue(null);
    mockPrisma.dailyLog.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'mock-log-uuid-1',
        ...data,
        createdAt: new Date(),
      }),
    );
  });

  describe('POST /api/kiosk/logs with operatorId & reportedCash', () => {
    it('accepts operatorId and reportedCash, returning signed receipt with SHA-256 checksum', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OPERATOR-77',
        meterVolume: 150.75,
        reportedCash: 2450.0,
        recordedAt: '2026-11-04T10:00:00.000Z',
      };

      const expectedChecksum = computeReceiptChecksum({
        kioskId: payload.kioskId,
        operatorId: payload.operatorId,
        meterVolume: payload.meterVolume,
        reportedCash: payload.reportedCash,
        recordedAt: payload.recordedAt,
      });

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.ack).toBe(true);
      expect(res.body.status).toBe('SYNCHRONIZED');
      expect(res.body.operatorId).toBe('OPERATOR-77');
      expect(res.body.reportedCash).toBe(2450.0);
      expect(res.body.receipt).toBeDefined();

      const receipt = res.body.receipt;
      expect(receipt.kioskId).toBe('KIOSK-001');
      expect(receipt.operatorId).toBe('OPERATOR-77');
      expect(receipt.meterVolume).toBe(150.75);
      expect(receipt.reportedCash).toBe(2450.0);
      expect(receipt.recordedAt).toBe('2026-11-04T10:00:00.000Z');
      expect(receipt.checksum).toBe(expectedChecksum);
      expect(receipt.hash).toBe(expectedChecksum);
      expect(receipt.algorithm).toBe('SHA-256');
      expect(receipt.signature).toMatch(/^[0-9a-f]{64}$/);

      expect(verifyReceiptSignature(receipt.checksum, receipt.signature)).toBe(true);
    });

    it('rejects negative reportedCash with HTTP 400', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-ERR-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OPERATOR-77',
        meterVolume: 150.75,
        reportedCash: -100,
        recordedAt: '2026-11-04T10:00:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/logs')
        .send(payload)
        .expect(400);

      expect(res.body.message).toContain('reportedCash must be non-negative');
    });
  });

  describe('POST /api/kiosk/daily-submission (alias route)', () => {
    it('accepts daily submission via /api/kiosk/daily-submission and returns signed receipt', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-SUB-001',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-ALIAS-01',
        meterVolume: 88.0,
        reportedCash: 500,
        recordedAt: '2026-11-04T11:00:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/api/kiosk/daily-submission')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.receipt).toBeDefined();
      expect(res.body.receipt.operatorId).toBe('OP-ALIAS-01');
      expect(res.body.receipt.reportedCash).toBe(500);
      expect(verifyReceiptSignature(res.body.receipt.checksum, res.body.receipt.signature)).toBe(true);
    });
  });

  describe('POST /daily-submission (direct route)', () => {
    it('accepts daily submission via /daily-submission and returns signed receipt', async () => {
      const payload = {
        transactionId: 'TXN-DAILY-SUB-002',
        kioskId: 'KIOSK-001',
        operatorId: 'OP-DIRECT-01',
        meterVolume: 92.5,
        reportedCash: 1000,
        recordedAt: '2026-11-04T11:30:00.000Z',
      };

      const res = await request(app.getHttpServer())
        .post('/daily-submission')
        .send(payload)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.receipt).toBeDefined();
      expect(res.body.receipt.operatorId).toBe('OP-DIRECT-01');
      expect(res.body.receipt.reportedCash).toBe(1000);
      expect(verifyReceiptSignature(res.body.receipt.checksum, res.body.receipt.signature)).toBe(true);
    });
  });
});
