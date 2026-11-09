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

const byNewest = (a: FakeLog, b: FakeLog) =>
  b.recordedAt.getTime() - a.recordedAt.getTime() || b.id.localeCompare(a.id);

function createFakePrisma() {
  const kiosks = new Map<string, { id: string; status: string }>();
  const logs: FakeLog[] = [];

  const pick = (log: FakeLog, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(
          Object.keys(select).map((k) => [k, log[k as keyof FakeLog]]),
        )
      : { ...log };

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
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; transactionId?: string };
        }) => {
          const log = logs.find((l) =>
            where.id !== undefined
              ? l.id === where.id
              : l.transactionId === where.transactionId,
          );
          return log ? { ...log } : null;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
          take,
          skip = 0,
          cursor,
          select,
        }: {
          where?: {
            kioskId?: string;
            isReadByManager?: boolean;
            recordedAt?: { gte?: Date; lte?: Date };
          };
          take: number;
          skip?: number;
          cursor?: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const sorted = logs
            .filter((l) => {
              if (where?.kioskId && l.kioskId !== where.kioskId) return false;
              if (
                where?.isReadByManager !== undefined &&
                l.isReadByManager !== where.isReadByManager
              ) {
                return false;
              }
              if (
                where?.recordedAt?.gte &&
                l.recordedAt < where.recordedAt.gte
              ) {
                return false;
              }
              return !(where?.recordedAt?.lte &&
                l.recordedAt > where.recordedAt.lte);

            })
            .sort(byNewest);

          const start = cursor
            ? sorted.findIndex((l) => l.id === cursor.id)
            : 0;
          if (start < 0) return [];
          return sorted
            .slice(start + skip, start + skip + take)
            .map((l) => pick(l, select));
        },
      ),
      count: jest.fn(
        async ({
          where,
        }: {
          where?: { kioskId?: string; isReadByManager?: boolean };
        }) => {
          return logs.filter((l) => {
            if (where?.kioskId && l.kioskId !== where.kioskId) return false;
            return !(where?.isReadByManager !== undefined &&
              l.isReadByManager !== where.isReadByManager);

          }).length;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where?: {
            id?: { in?: string[] };
            kioskId?: string;
            isReadByManager?: boolean;
            recordedAt?: { lte?: Date };
          };
          data: { isReadByManager?: boolean };
        }) => {
          let count = 0;
          for (const l of logs) {
            if (where?.id?.in && !where.id.in.includes(l.id)) continue;
            if (where?.kioskId && l.kioskId !== where.kioskId) continue;
            if (
              where?.isReadByManager !== undefined &&
              l.isReadByManager !== where.isReadByManager
            ) {
              continue;
            }
            if (where?.recordedAt?.lte && l.recordedAt > where.recordedAt.lte) {
              continue;
            }
            if (data.isReadByManager !== undefined) {
              l.isReadByManager = data.isReadByManager;
            }
            count++;
          }
          return { count };
        },
      ),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
}

const KIOSK_ID = 'KIOSK-UNSEEN-001';

describe('Unseen-records tracking state per Operation Manager (Story 08, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: ReturnType<typeof createFakePrisma>;

  beforeEach(async () => {
    prisma = createFakePrisma();
    prisma.kiosks.set(KIOSK_ID, { id: KIOSK_ID, status: 'ONLINE' });

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

  const seedLogs = () => {
    for (let i = 0; i < 6; i++) {
      prisma.logs.push({
        id: `log-${i}`,
        transactionId: `TXN-${i}`,
        kioskId: KIOSK_ID,
        meterVolume: 50 + i * 10,
        reportedCash: (50 + i * 10),
        expectedRevenue: (50 + i * 10),
        variance: 0,
        isAnomaly: false,
        checksum: null,
        isSynced: true,
        // Even indices are seen (read), odd indices are unseen (unread)
        isReadByManager: i % 2 === 0,
        recordedAt: new Date(Date.UTC(2026, 10, 1, i)),
        createdAt: new Date(Date.UTC(2026, 10, 1, i)),
      });
    }
  };

  describe('GET /api/kiosk/logs?unseenOnly=true', () => {
    it('returns only unread records when unseenOnly=true', async () => {
      seedLogs();

      const res = await http()
        .get('/api/kiosk/logs')
        .query({ unseenOnly: 'true' })
        .expect(200);

      expect(res.body.data).toHaveLength(3);
      expect(res.body.data.map((l: FakeLog) => l.id)).toEqual([
        'log-5',
        'log-3',
        'log-1',
      ]);
      expect(res.body.unseenCount).toBe(3);
    });

    it('returns all records when unseenOnly=false', async () => {
      seedLogs();

      const res = await http()
        .get('/api/kiosk/logs')
        .query({ unseenOnly: 'false' })
        .expect(200);

      expect(res.body.data).toHaveLength(6);
      expect(res.body.unseenCount).toBe(3);
    });

    it('rejects invalid unseenOnly query with 400 Bad Request', async () => {
      await http()
        .get('/api/kiosk/logs')
        .query({ unseenOnly: 'notabool' })
        .expect(400);
    });

    it('validates date range and rejects startDate > endDate with 400', async () => {
      await http()
        .get('/api/kiosk/logs')
        .query({
          startDate: '2026-11-10',
          endDate: '2026-11-01',
        })
        .expect(400);
    });
  });

  describe('PATCH /api/kiosk/logs/mark-seen', () => {
    it('marks specific logs as seen by logIds', async () => {
      seedLogs();

      const patchRes = await http()
        .patch('/api/kiosk/logs/mark-seen')
        .send({ logIds: ['log-1', 'log-3'] })
        .expect(200);

      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.count).toBe(2);

      // Now query unseenOnly=true again, only log-5 should remain
      const getRes = await http()
        .get('/api/kiosk/logs')
        .query({ unseenOnly: 'true' })
        .expect(200);

      expect(getRes.body.data).toHaveLength(1);
      expect(getRes.body.data[0].id).toBe('log-5');
      expect(getRes.body.unseenCount).toBe(1);
    });

    it('marks all unread logs for a kiosk when kioskId provided', async () => {
      seedLogs();

      const patchRes = await http()
        .patch('/api/kiosk/logs/mark-seen')
        .send({ kioskId: KIOSK_ID })
        .expect(200);

      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.count).toBe(3);

      const getRes = await http()
        .get('/api/kiosk/logs')
        .query({ unseenOnly: 'true' })
        .expect(200);

      expect(getRes.body.data).toHaveLength(0);
      expect(getRes.body.unseenCount).toBe(0);
    });

    it('marks all unread logs as seen when called with empty body', async () => {
      seedLogs();

      const patchRes = await http()
        .patch('/api/kiosk/logs/mark-seen')
        .send({})
        .expect(200);

      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.count).toBe(3);

      const getRes = await http()
        .get('/api/kiosk/logs')
        .query({ unseenOnly: 'true' })
        .expect(200);

      expect(getRes.body.data).toHaveLength(0);
      expect(getRes.body.unseenCount).toBe(0);
    });
  });
});
