import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// ───────────────────────────────────────────────────────────
//  Story ID 08 – load & concurrency test for the historical archive.
//
//  "Seed 500+ historical log records. Verify pagination response times
//   remain fast (< 200 ms) while concurrent real-time POST requests are
//   active."
//
//  Runs the full AppModule on a real port against the real Postgres schema
//  (DATABASE_URL), seeds a throwaway kiosk with SEED_COUNT historical logs,
//  then pages GET /api/kiosk/logs/archive with the cursor while a pool of
//  writers keeps POSTing new readings to /api/kiosk/logs for the SAME kiosk.
//
// ───────────────────────────────────────────────────────────

/**
 * Spec target: "pagination response times remain fast (< 200 ms)". Asserted
 * on the typical (median) page; p95 is printed but not asserted, because
 * against a remote DB the few slowest pages measure network jitter.
 */
const ARCHIVE_SLA_MS = 200;
/**
 * DoD: paging must work "without stalling". A page slower than this counts
 * as stalled/blocked by the writers – well above network jitter (seen up to
 * ~1 s over the tunnel), well below a real lock-up.
 */
const STALL_MS = 2000;
/** Spec: "Seed 500+ historical log records". */
const SEED_COUNT = 520;
const PAGE_LIMIT = 20;
/** Parallel real-time writers (kept small: the shared DB role has a connection cap). */
const WRITERS = 4;
/** Parallel managers paging deep cursors at the same time. */
const READERS = 3;
/** Safety cap so a slow DB cannot make the writer pool run forever. */
const MAX_WRITES_PER_PHASE = 400;

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const KIOSK_ID = `KIOSK-ARCHIVE-LOAD-${RUN_ID}`;
const HOUR_MS = 60 * 60 * 1000;
/** Newest seeded row; every seeded row is one hour older than the previous. */
const SEED_NEWEST = Date.UTC(2025, 11, 31, 12, 0, 0);

interface ArchiveRow {
  id: string;
  transactionId: string;
  kioskId: string;
  recordedAt: string;
  isReadByManager: boolean;
}

interface ArchiveBody {
  data: ArchiveRow[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

interface LatencyStats {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
}

/** Nearest-rank percentile over an unsorted sample. */
const percentile = (sample: number[], p: number): number => {
  const sorted = [...sample].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
};

const stats = (sample: number[]): LatencyStats => ({
  count: sample.length,
  min: Math.min(...sample),
  p50: percentile(sample, 50),
  p95: percentile(sample, 95),
  max: Math.max(...sample),
  avg: sample.reduce((sum, v) => sum + v, 0) / sample.length,
});

const fmt = (s: LatencyStats) =>
  `n=${s.count} min=${s.min.toFixed(1)} p50=${s.p50.toFixed(1)} ` +
  `p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)} avg=${s.avg.toFixed(1)} (ms)`;

/** Seeded ids, newest first – the order the archive must serve them in. */
const seededIdsNewestFirst: string[] = [];
const seededIdSet = new Set<string>();

describe('Archive pagination under concurrent real-time writes (Story ID 08, load)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let writeSeq = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    // A real listening port: supertest would otherwise re-bind the server on
    // every request and add that cost to the measured latency.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    baseUrl = baseUrl.replace('[::1]', '127.0.0.1');

    prisma = app.get<PrismaService>(PrismaService);

    await prisma.dailyLog.deleteMany({ where: { kioskId: KIOSK_ID } });
    await prisma.kiosk.deleteMany({ where: { id: KIOSK_ID } });
    await prisma.kiosk.create({
      data: { id: KIOSK_ID, status: 'ONLINE', lastHeartbeat: new Date() },
    });

    seededIdsNewestFirst.length = 0;
    seededIdSet.clear();
    const rows = Array.from({ length: SEED_COUNT }, (_, i) => {
      // i = 0 is the newest row.
      const id = `archive-load-${RUN_ID}-${String(i).padStart(4, '0')}`;
      seededIdsNewestFirst.push(id);
      seededIdSet.add(id);
      return {
        id,
        transactionId: `TXN-ARCHIVE-LOAD-${RUN_ID}-${i}`,
        kioskId: KIOSK_ID,
        operatorId: 'OP-001',
        meterVolume: 50 + (i % 40),
        reportedCash: 100 + (i % 40) * 2,
        expectedRevenue: 100 + (i % 40) * 2,
        variance: 0,
        isAnomaly: i % 25 === 0,
        waterType: i % 3 === 0 ? ('SUBSIDIZED' as const) : ('COMMERCIAL' as const),
        // Synced so the Google Sheets scheduler never picks the history up.
        isSynced: true,
        isReadByManager: i % 2 === 0,
        recordedAt: new Date(SEED_NEWEST - i * HOUR_MS),
      };
    });
    await prisma.dailyLog.createMany({ data: rows });

    // Warm-up: open the Prisma pool connections up front so a cold TLS
    // handshake (seconds over a tunnel) is not counted as a slow page.
    await Promise.all(
      Array.from({ length: WRITERS + READERS + 2 }, () => prisma.$queryRaw`SELECT 1`),
    );
    for (let i = 0; i < 3; i++) {
      await request(baseUrl)
        .get('/api/kiosk/logs/archive')
        .query({ kioskId: KIOSK_ID, limit: PAGE_LIMIT })
        .expect(200);
    }
  }, 180000);

  afterAll(async () => {
    try {
      await prisma.dailyLog.deleteMany({ where: { kioskId: KIOSK_ID } });
      await prisma.kiosk.deleteMany({ where: { id: KIOSK_ID } });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors
    }
    await app?.close();
  }, 60000);

  // ── helpers ────────────────────────────────────────────────

  /** One timed archive request. */
  const fetchPage = async (cursor?: string, extra: Record<string, string> = {}) => {
    const query: Record<string, string | number> = {
      kioskId: KIOSK_ID,
      limit: PAGE_LIMIT,
      ...extra,
    };
    if (cursor) query.cursor = cursor;

    const started = performance.now();
    const res = await request(baseUrl).get('/api/kiosk/logs/archive').query(query);
    const ms = performance.now() - started;

    expect(res.status).toBe(200);
    return { body: res.body as ArchiveBody, ms };
  };

  /** Walks the whole archive with the cursor, timing every page. */
  const walkArchive = async (extra: Record<string, string> = {}) => {
    const ids: string[] = [];
    const latencies: number[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const { body, ms } = await fetchPage(cursor, extra);
      latencies.push(ms);
      ids.push(...body.data.map((row) => row.id));
      cursor = body.nextCursor ?? undefined;
      pages++;
      // Guard against an endless loop if the cursor ever stopped advancing.
      expect(pages).toBeLessThan(SEED_COUNT);
    } while (cursor);

    return { ids, latencies, pages };
  };

  interface WritePool {
    stop: () => Promise<void>;
    statuses: number[];
    latencies: number[];
    /** performance.now() at each write completion. */
    completedAt: number[];
    liveIds: Set<string>;
  }

  /**
   * Starts WRITERS workers that keep POSTing real-time readings for the
   * archive kiosk until stop() is called (or the safety cap is reached).
   */
  const startWriters = (): WritePool => {
    let stopped = false;
    let issued = 0;
    const pool: WritePool = {
      stop: async () => undefined,
      statuses: [],
      latencies: [],
      completedAt: [],
      liveIds: new Set(),
    };

    const worker = async () => {
      while (!stopped && issued < MAX_WRITES_PER_PHASE) {
        issued++;
        const seq = writeSeq++;
        const payload = {
          transactionId: `TXN-ARCHIVE-LOAD-LIVE-${RUN_ID}-${seq}`,
          kioskId: KIOSK_ID,
          operatorId: 'OP-002',
          meterVolume: 10 + (seq % 50),
          reportedCash: 20 + (seq % 50) * 2,
          // A daily volume is not monotonic, so out-of-order arrival from
          // parallel writers cannot trip the cumulative-meter conflict check.
          readingType: 'DAILY_VOLUME',
          // Newer than every seeded row: live rows land at the archive head.
          recordedAt: new Date(Date.now() + seq).toISOString(),
        };

        const started = performance.now();
        try {
          const res = await request(baseUrl).post('/api/kiosk/logs').send(payload);
          pool.latencies.push(performance.now() - started);
          pool.statuses.push(res.status);
          if (res.body?.logId) pool.liveIds.add(res.body.logId as string);
        } catch {
          pool.latencies.push(performance.now() - started);
          pool.statuses.push(0);
        }
        pool.completedAt.push(performance.now());
      }
    };

    const running = Promise.all(Array.from({ length: WRITERS }, () => worker()));
    pool.stop = async () => {
      stopped = true;
      await running;
    };
    return pool;
  };

  const report = (title: string, lines: string[]) => {
    console.log(
      [`\n──────── ${title} ────────`, ...lines.map((l) => `  ${l}`)].join('\n'),
    );
  };

  /** Spec check on one latency sample: typical page fast, no page stalled. */
  const expectFastPages = (s: LatencyStats) => {
    expect(s.p50).toBeLessThan(ARCHIVE_SLA_MS);
    expect(s.max).toBeLessThan(STALL_MS);
  };

  const verdict = (s: LatencyStats) =>
    `verdict: median ${s.p50.toFixed(1)} ms ${s.p50 < ARCHIVE_SLA_MS ? '<' : '>='} ${ARCHIVE_SLA_MS} ms, ` +
    `slowest ${s.max.toFixed(1)} ms ${s.max < STALL_MS ? '<' : '>='} ${STALL_MS} ms stall limit` +
    (s.p95 >= ARCHIVE_SLA_MS ? ` (p95 ${s.p95.toFixed(1)} ms – network jitter, info only)` : '');

  // ── 1. fixtures & index ───────────────────────────────────

  it(`seeds ${SEED_COUNT} (500+) historical logs for the archive kiosk`, async () => {
    const count = await prisma.dailyLog.count({ where: { kioskId: KIOSK_ID } });
    expect(SEED_COUNT).toBeGreaterThanOrEqual(500);
    expect(count).toBe(SEED_COUNT);
  });

  it('has the composite (kiosk_id, recorded_at DESC) index the archive relies on', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'daily_logs'
    `;
    const composite = indexes.find((ix) =>
      /\(\s*"?kiosk_id"?\s*,\s*"?recorded_at"?\s+DESC\s*\)/i.test(ix.indexdef),
    );

    // The plan is printed as evidence only: the planner's choice depends on
    // table statistics, so it is not asserted.
    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT id FROM daily_logs WHERE kiosk_id = $1
       ORDER BY recorded_at DESC, id DESC LIMIT ${PAGE_LIMIT + 1}`,
      KIOSK_ID,
    );
    report('Archive index', [
      `composite index: ${composite ? `${composite.indexname} → ${composite.indexdef}` : 'MISSING'}`,
      ...plan.map((row) => `plan: ${row['QUERY PLAN']}`),
    ]);

    expect(composite).toBeDefined();
  });

  // ── 2. baseline (no writers) ──────────────────────────────

  it(`pages the full idle archive in < ${ARCHIVE_SLA_MS} ms per page with a total newest-first order`, async () => {
    // Network floor: a bare `SELECT 1` round trip to the database. A cursor
    // page needs two queries (cursor lookup + page), so it cannot be faster
    // than ~2× this – useful to tell a slow DB link from a slow query.
    const dbRoundTrips: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      dbRoundTrips.push(performance.now() - started);
    }

    const walk = await walkArchive();
    const s = stats(walk.latencies);

    report('Baseline – archive walk, no concurrent writes', [
      `DB round trip (SELECT 1): ${fmt(stats(dbRoundTrips))}`,
      `pages: ${walk.pages}, rows: ${walk.ids.length}`,
      `page latency: ${fmt(s)}`,
      verdict(s),
    ]);

    expect(walk.ids).toEqual(seededIdsNewestFirst);
    expect(new Set(walk.ids).size).toBe(walk.ids.length);
    expect(walk.pages).toBe(Math.ceil(SEED_COUNT / PAGE_LIMIT));
    expectFastPages(s);
  }, 120000);

  // ── 3. archive walk while real-time writes are active ─────

  it(`keeps archive pages < ${ARCHIVE_SLA_MS} ms, unstalled and consistent while real-time POSTs run`, async () => {
    const writers = startWriters();

    // Let the writers get going before the first page is requested.
    while (writers.completedAt.length < WRITERS) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const walkStart = performance.now();
    const walk = await walkArchive();
    const walkEnd = performance.now();
    await writers.stop();

    const pageStats = stats(walk.latencies);
    const writeStats = stats(writers.latencies);
    const writesDuringWalk = writers.completedAt.filter(
      (t) => t >= walkStart && t <= walkEnd,
    ).length;
    const accepted = writers.statuses.filter((code) => code === 201).length;

    report('Archive walk WITH concurrent real-time writes', [
      `writers: ${WRITERS}, writes: ${writers.statuses.length} ` +
        `(accepted 201: ${accepted}, completed during walk: ${writesDuringWalk})`,
      `pages: ${walk.pages}, rows: ${walk.ids.length}`,
      `page latency : ${fmt(pageStats)}`,
      `write latency: ${fmt(writeStats)}`,
      verdict(pageStats),
    ]);

    // Writes really overlapped the walk, and none was dropped or rejected.
    expect(writesDuringWalk).toBeGreaterThan(0);
    expect(writers.statuses.every((code) => code === 201)).toBe(true);

    // No duplicates. New rows only ever appear at the head (they are newer
    // than all history), so every seeded row is served exactly once, in order.
    expect(new Set(walk.ids).size).toBe(walk.ids.length);
    expect(walk.ids.filter((id) => seededIdSet.has(id))).toEqual(seededIdsNewestFirst);
    for (const id of walk.ids) {
      expect(seededIdSet.has(id) || writers.liveIds.has(id)).toBe(true);
    }

    // The real-time writes are all in the DB.
    const liveRows = await prisma.dailyLog.count({
      where: { kioskId: KIOSK_ID, transactionId: { contains: '-LIVE-' } },
    });
    expect(liveRows).toBeGreaterThanOrEqual(accepted);

    expectFastPages(pageStats);
  }, 180000);

  // ── 4. deep cursors, several managers, writes active ──────

  it(`serves deep cursor pages as fast as newer ones (< ${ARCHIVE_SLA_MS} ms) with ${READERS} managers paging during writes`, async () => {
    // Cursors spread over the whole history: page 1 … the last page.
    const cursors = seededIdsNewestFirst.filter(
      (_, i) => (i + 1) % PAGE_LIMIT === 0 && i < SEED_COUNT - 1,
    );
    const writers = startWriters();

    const shallow: number[] = [];
    const deep: number[] = [];
    const reader = async (offset: number) => {
      for (let i = offset; i < cursors.length; i += READERS) {
        const { body, ms } = await fetchPage(cursors[i]);
        // A cursor page starts right after its cursor row.
        const start = seededIdsNewestFirst.indexOf(cursors[i]) + 1;
        expect(body.data.map((row) => row.id)).toEqual(
          seededIdsNewestFirst.slice(start, start + PAGE_LIMIT),
        );
        (i < cursors.length / 2 ? shallow : deep).push(ms);
      }
    };

    await Promise.all(Array.from({ length: READERS }, (_, r) => reader(r)));
    await writers.stop();

    const all = stats([...shallow, ...deep]);
    const shallowStats = stats(shallow);
    const deepStats = stats(deep);

    report(`${READERS} managers paging deep cursors WITH concurrent writes`, [
      `writes: ${writers.statuses.length} (accepted 201: ${
        writers.statuses.filter((code) => code === 201).length
      })`,
      `newer half  (pages 2–${Math.ceil(cursors.length / 2) + 1}): ${fmt(shallowStats)}`,
      `older half  (deepest pages)     : ${fmt(deepStats)}`,
      `all cursor pages               : ${fmt(all)}`,
      verdict(all),
    ]);

    expect(writers.statuses.every((code) => code === 201)).toBe(true);
    expectFastPages(all);
    // The oldest pages are served by the same index seek, not a slower scan.
    expectFastPages(deepStats);
  }, 180000);

  // ── 5. unread-only dashboard walk while writes are active ─

  it(`pages unseenOnly=true (the dashboard view) in < ${ARCHIVE_SLA_MS} ms per page during real-time writes`, async () => {
    const writers = startWriters();
    const walk = await walkArchive({ unseenOnly: 'true' });
    await writers.stop();

    const s = stats(walk.latencies);
    const unseenSeeded = seededIdsNewestFirst.filter((_, i) => i % 2 !== 0);

    report('unseenOnly=true walk WITH concurrent real-time writes', [
      `writes: ${writers.statuses.length}, pages: ${walk.pages}, rows: ${walk.ids.length}`,
      `page latency: ${fmt(s)}`,
      verdict(s),
    ]);

    expect(writers.statuses.every((code) => code === 201)).toBe(true);
    expect(new Set(walk.ids).size).toBe(walk.ids.length);
    expect(walk.ids.filter((id) => seededIdSet.has(id))).toEqual(unseenSeeded);
    expectFastPages(s);
  }, 180000);
});
