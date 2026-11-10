import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// ───────────────────────────────────────────────────────────
//  Story ID 08 – archive cursor pagination against the real Postgres schema.
//
//  Runs the full AppModule over HTTP (supertest) with the real PrismaService,
//  seeds a uniquely named throwaway kiosk plus 25+ logs, then walks the
//  archive to prove a total newest-first order with no skips or duplicates.
//  Everything created here is removed in afterAll.
// ───────────────────────────────────────────────────────────

interface ArchiveRow {
  id: string;
  transactionId: string;
  kioskId: string;
  operatorId: string | null;
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  waterType: string;
  isReadByManager: boolean;
  recordedAt: string;
  createdAt: string;
}

interface ArchiveBody {
  data: ArchiveRow[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const KIOSK_ID = `KIOSK-ARCHIVE-E2E-${RUN_ID}`;
const OTHER_KIOSK_ID = `KIOSK-ARCHIVE-E2E-OTHER-${RUN_ID}`;
const FOREIGN_LOG_ID = `archive-e2e-foreign-${RUN_ID}`;
/** F1 regression fixtures: one throwaway kiosk per scenario. */
const F1_KIOSK_PREFIX = `KIOSK-ARCHIVE-F1-${RUN_ID}`;
const TOTAL_LOGS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026-01-01T12:00:00.000Z; log `i` is recorded on day `i + 1`. */
const BASE_TIME = Date.UTC(2026, 0, 1, 12, 0, 0);

interface SeededLog {
  id: string;
  transactionId: string;
  recordedAt: Date;
  isReadByManager: boolean;
}

const seeded: SeededLog[] = [];

const at = (day: number) => new Date(BASE_TIME + day * DAY_MS);

const newestFirst = (rows: SeededLog[]) =>
  [...rows]
    .sort(
      (a, b) =>
        b.recordedAt.getTime() - a.recordedAt.getTime() ||
        b.id.localeCompare(a.id),
    )
    .map((row) => row.id);

const expectedOrder = () => newestFirst(seeded);

describe('Archive cursor pagination (Story ID 08, e2e, real Postgres)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);

    // Defensive cleanup, then the throwaway fixtures.
    await prisma.dailyLog.deleteMany({
      where: {
        kioskId: {
          in: [KIOSK_ID, OTHER_KIOSK_ID],
        },
      },
    });
    await prisma.dailyLog.deleteMany({
      where: { kioskId: { startsWith: F1_KIOSK_PREFIX } },
    });
    await prisma.kiosk.deleteMany({
      where: { id: { in: [KIOSK_ID, OTHER_KIOSK_ID] } },
    });
    await prisma.kiosk.deleteMany({
      where: { id: { startsWith: F1_KIOSK_PREFIX } },
    });

    await prisma.kiosk.createMany({
      data: [
        { id: KIOSK_ID, status: 'ONLINE', lastHeartbeat: new Date() },
        { id: OTHER_KIOSK_ID, status: 'ONLINE', lastHeartbeat: new Date() },
      ],
    });

    seeded.length = 0;
    for (let i = 0; i < TOTAL_LOGS; i++) {
      seeded.push({
        id: `archive-e2e-${RUN_ID}-${String(i).padStart(2, '0')}`,
        transactionId: `TXN-ARCHIVE-E2E-${RUN_ID}-${i}`,
        recordedAt: at(i),
        isReadByManager: i % 2 === 0,
      });
    }

    await prisma.dailyLog.createMany({
      data: seeded.map((row, i) => ({
        id: row.id,
        transactionId: row.transactionId,
        kioskId: KIOSK_ID,
        operatorId: `OP-${i % 5}`,
        meterVolume: 100 + i,
        reportedCash: 100 + i,
        expectedRevenue: 100 + i,
        variance: 0,
        isAnomaly: i % 7 === 0,
        waterType: i % 4 === 0 ? ('SUBSIDIZED' as const) : ('COMMERCIAL' as const),
        // Synced so the Google Sheets scheduler never picks these rows up.
        isSynced: true,
        isReadByManager: row.isReadByManager,
        recordedAt: row.recordedAt,
      })),
    });

    // A foreign-kiosk row used to prove the cursor cross-kiosk guard.
    await prisma.dailyLog.create({
      data: {
        id: FOREIGN_LOG_ID,
        transactionId: `TXN-ARCHIVE-E2E-FOREIGN-${RUN_ID}`,
        kioskId: OTHER_KIOSK_ID,
        meterVolume: 1,
        reportedCash: 1,
        expectedRevenue: 1,
        variance: 0,
        isSynced: true,
        isReadByManager: false,
        recordedAt: at(0),
      },
    });
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.dailyLog.deleteMany({
        where: { kioskId: { in: [KIOSK_ID, OTHER_KIOSK_ID] } },
      });
      await prisma.dailyLog.deleteMany({
        where: { kioskId: { startsWith: F1_KIOSK_PREFIX } },
      });
      await prisma.kiosk.deleteMany({
        where: { id: { in: [KIOSK_ID, OTHER_KIOSK_ID] } },
      });
      await prisma.kiosk.deleteMany({
        where: { id: { startsWith: F1_KIOSK_PREFIX } },
      });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors
    }
    await app.close();
  }, 60000);

  const getArchive = (query: Record<string, string | number>) =>
    request(app.getHttpServer()).get('/api/kiosk/logs/archive').query(query);

  const markSeen = (logIds: string[]) =>
    request(app.getHttpServer())
      .patch('/api/kiosk/logs/mark-seen')
      .send({ logIds });

  /**
   * Seeds a fresh kiosk whose logs are all unread, one per day starting at
   * `BASE_TIME`. Returns the kiosk id and the ids newest-first.
   */
  const seedF1Kiosk = async (name: string, count: number) => {
    const kioskId = `${F1_KIOSK_PREFIX}-${name}`;

    await prisma.dailyLog.deleteMany({ where: { kioskId } });
    await prisma.kiosk.deleteMany({ where: { id: kioskId } });
    await prisma.kiosk.create({
      data: { id: kioskId, status: 'ONLINE', lastHeartbeat: new Date() },
    });

    // rows[0] is the oldest; the API serves them in reverse.
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `archive-f1-${RUN_ID}-${name}-${String(i).padStart(2, '0')}`,
      transactionId: `TXN-ARCHIVE-F1-${RUN_ID}-${name}-${i}`,
      kioskId,
      operatorId: 'OP-F1',
      meterVolume: 10 + i,
      reportedCash: 10 + i,
      expectedRevenue: 10 + i,
      variance: 0,
      isAnomaly: false,
      waterType: 'COMMERCIAL' as const,
      isSynced: true,
      isReadByManager: false,
      recordedAt: at(i),
    }));

    await prisma.dailyLog.createMany({ data: rows });

    return { kioskId, ids: rows.map((row) => row.id).reverse() };
  };

  it('serves the newest page with the default limit 20 and a next cursor', async () => {
    const res = await getArchive({ kioskId: KIOSK_ID }).expect(200);
    const body = res.body as ArchiveBody;

    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe(body.data[19].id);
    expect(body.data.map((row) => row.id)).toEqual(expectedOrder().slice(0, 20));

    for (let i = 1; i < body.data.length; i++) {
      expect(Date.parse(body.data[i - 1].recordedAt)).toBeGreaterThanOrEqual(
        Date.parse(body.data[i].recordedAt),
      );
    }
  });

  it('projects exactly the documented archive columns', async () => {
    const res = await getArchive({ kioskId: KIOSK_ID, limit: 1 }).expect(200);
    const body = res.body as ArchiveBody;

    expect(Object.keys(body.data[0]).sort()).toEqual(
      [
        'id',
        'transactionId',
        'kioskId',
        'operatorId',
        'meterVolume',
        'reportedCash',
        'expectedRevenue',
        'variance',
        'isAnomaly',
        'waterType',
        'isReadByManager',
        'recordedAt',
        'createdAt',
      ].sort(),
    );
  });

  it('walks the whole archive without duplicates and ends with nextCursor null', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let last: ArchiveBody | undefined;
    let pages = 0;

    do {
      const res = await getArchive({
        kioskId: KIOSK_ID,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      }).expect(200);

      last = res.body as ArchiveBody;
      expect(last.data.length).toBeGreaterThan(0);
      expect(last.data.length).toBeLessThanOrEqual(10);
      seen.push(...last.data.map((row) => row.id));
      cursor = last.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(TOTAL_LOGS);
    expect(new Set(seen).size).toBe(TOTAL_LOGS);
    expect(seen).toEqual(expectedOrder());
    expect(last?.nextCursor).toBeNull();
    expect(last?.hasMore).toBe(false);
  });

  it('returns the remaining older rows on the final page', async () => {
    const first = (
      await getArchive({ kioskId: KIOSK_ID, limit: 20 }).expect(200)
    ).body as ArchiveBody;

    const second = (
      await getArchive({
        kioskId: KIOSK_ID,
        limit: 20,
        cursor: first.nextCursor as string,
      }).expect(200)
    ).body as ArchiveBody;

    expect(second.data).toHaveLength(TOTAL_LOGS - 20);
    expect(second.data.map((row) => row.id)).toEqual(
      expectedOrder().slice(20),
    );
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.limit).toBe(20);
  });

  it('reports hasMore=false when the limit exactly fits the rows', async () => {
    const body = (
      await getArchive({ kioskId: KIOSK_ID, limit: TOTAL_LOGS }).expect(200)
    ).body as ArchiveBody;

    expect(body.data).toHaveLength(TOTAL_LOGS);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('resumes strictly after the cursor row', async () => {
    const order = expectedOrder();
    const body = (
      await getArchive({ kioskId: KIOSK_ID, cursor: order[4], limit: 5 }).expect(
        200,
      )
    ).body as ArchiveBody;

    expect(body.data.map((row) => row.id)).toEqual(order.slice(5, 10));
    expect(body.data.map((row) => row.id)).not.toContain(order[4]);
  });

  it('filters unseenOnly to rows the manager has not read', async () => {
    const expected = newestFirst(seeded.filter((row) => !row.isReadByManager));

    const body = (
      await getArchive({ kioskId: KIOSK_ID, unseenOnly: 'true', limit: 100 }).expect(
        200,
      )
    ).body as ArchiveBody;

    expect(body.data.map((row) => row.id)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    expect(body.data.every((row) => row.isReadByManager === false)).toBe(true);
  });

  it('returns every row when unseenOnly=false', async () => {
    const body = (
      await getArchive({ kioskId: KIOSK_ID, unseenOnly: 'false', limit: 100 })
        .expect(200)
    ).body as ArchiveBody;

    expect(body.data).toHaveLength(TOTAL_LOGS);
  });

  it('filters by startDate and an inclusive date-only endDate', async () => {
    const body = (
      await getArchive({
        kioskId: KIOSK_ID,
        limit: 100,
        startDate: '2026-01-06T00:00:00.000Z',
        endDate: '2026-01-10',
      }).expect(200)
    ).body as ArchiveBody;

    const expected = newestFirst(
      seeded.filter(
        (row) =>
          row.recordedAt >= new Date('2026-01-06T00:00:00.000Z') &&
          row.recordedAt <= new Date('2026-01-10T23:59:59.999Z'),
      ),
    );

    expect(body.data.map((row) => row.id)).toEqual(expected);
    expect(body.data).toHaveLength(5);
  });

  it('includes the last millisecond of a date-only endDate', async () => {
    // Only the day-1 log falls on 2026-01-01 at 12:00Z.
    const body = (
      await getArchive({
        kioskId: KIOSK_ID,
        limit: 100,
        startDate: '2026-01-01',
        endDate: '2026-01-01',
      }).expect(200)
    ).body as ArchiveBody;

    expect(body.data.map((row) => row.id)).toEqual([seeded[0].id]);
  });

  it('rejects startDate after endDate with the exact message', async () => {
    const res = await getArchive({
      startDate: '2026-02-10',
      endDate: '2026-02-01',
    }).expect(400);

    expect(res.body.message).toBe('startDate must not be after endDate');
  });

  it('rejects a garbage startDate with the exact message', async () => {
    const res = await getArchive({ startDate: 'not-a-date' }).expect(400);

    expect(res.body.message).toBe(
      'startDate must be a valid ISO-8601 date string',
    );
  });

  it.each(['0', '101', '2.5', 'abc'])(
    'rejects limit=%s with 400',
    async (limit) => {
      await getArchive({ kioskId: KIOSK_ID, limit }).expect(400);
    },
  );

  it('rejects an unknown cursor with 400', async () => {
    const cursor = `missing-cursor-${RUN_ID}`;
    const res = await getArchive({ kioskId: KIOSK_ID, cursor }).expect(400);

    expect(res.body.message).toBe(
      `cursor "${cursor}" was not found in the archive`,
    );
  });

  it("rejects another kiosk's cursor with 400", async () => {
    const res = await getArchive({
      kioskId: KIOSK_ID,
      cursor: FOREIGN_LOG_ID,
    }).expect(400);

    expect(res.body.message).toBe(
      `cursor does not belong to kioskId "${KIOSK_ID}"`,
    );
  });

  it('does not include another kiosk in a kiosk-scoped archive', async () => {
    const body = (
      await getArchive({ kioskId: KIOSK_ID, limit: 100 }).expect(200)
    ).body as ArchiveBody;

    expect(body.data.every((row) => row.kioskId === KIOSK_ID)).toBe(true);
    expect(body.data.map((row) => row.id)).not.toContain(FOREIGN_LOG_ID);
  });

  // ───────────────────────────────────────────────────────────
  //  F1 regression (real Prisma): the cursor row may stop matching the active
  //  filter between pages. A hard `skip: 1` compiles to SQL `OFFSET 1` and
  //  silently drops the first *matching* row. These tests fail against that
  //  old behaviour and pass only with the conditional skip.
  // ───────────────────────────────────────────────────────────

  it('keeps every unread row when the page-1 cursor is marked read', async () => {
    const { kioskId, ids } = await seedF1Kiosk('unseen', 6);
    const limit = 2;

    const page1 = (
      await getArchive({ kioskId, unseenOnly: 'true', limit }).expect(200)
    ).body as ArchiveBody;

    expect(page1.data.map((row) => row.id)).toEqual(ids.slice(0, limit));
    const cursor = page1.nextCursor as string;
    expect(cursor).toBe(ids[1]);

    // The realistic F1 trigger: mark the previous page's last row as seen.
    const marked = await markSeen([cursor]).expect(200);
    expect(marked.body.count).toBe(1);

    // Page 2 must start at the row immediately after the (now excluded) cursor.
    const page2 = (
      await getArchive({ kioskId, unseenOnly: 'true', limit, cursor }).expect(200)
    ).body as ArchiveBody;

    expect(page2.data.map((row) => row.id)).toEqual(ids.slice(limit, 2 * limit));
    expect(page2.data.map((row) => row.id)).toContain(ids[limit]);

    // Continue the same walk, marking each page's cursor read as a client would.
    const seen: string[] = page1.data.map((row) => row.id);
    seen.push(...page2.data.map((row) => row.id));
    let next = page2.nextCursor;
    let guard = 0;

    while (next && guard++ < 10) {
      const page = (
        await getArchive({
          kioskId,
          unseenOnly: 'true',
          limit,
          cursor: next,
        }).expect(200)
      ).body as ArchiveBody;

      seen.push(...page.data.map((row) => row.id));
      next = page.nextCursor;

      if (next) {
        await markSeen([next]).expect(200);
      }
    }

    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('keeps every in-range row when the cursor row is outside the date range', async () => {
    const { kioskId, ids } = await seedF1Kiosk('range', 10);
    // ids[0] is 2026-01-10; the requested window is 2026-01-01..2026-01-05.
    const outsideCursor = ids[0];
    const expectedInRange = ids.slice(5);

    const body = (
      await getArchive({
        kioskId,
        limit: 100,
        startDate: '2026-01-01',
        endDate: '2026-01-05',
        cursor: outsideCursor,
      }).expect(200)
    ).body as ArchiveBody;

    expect(body.data.map((row) => row.id)).toEqual(expectedInRange);
    // The first in-range row must not be eaten by the OFFSET.
    expect(body.data.map((row) => row.id)).toContain(ids[5]);
    expect(body.data).toHaveLength(5);
    expect(new Set(body.data.map((row) => row.id)).size).toBe(5);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('walks every page at limit=2 while marking each page cursor read', async () => {
    const { kioskId, ids } = await seedF1Kiosk('walk', 7);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = (
        await getArchive({
          kioskId,
          unseenOnly: 'true',
          limit: 2,
          ...(cursor ? { cursor } : {}),
        }).expect(200)
      ).body as ArchiveBody;

      seen.push(...page.data.map((row) => row.id));
      cursor = page.nextCursor;

      if (cursor) {
        const marked = await markSeen([cursor]).expect(200);
        expect(marked.body.count).toBe(1);
      }
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });
});
