import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ARCHIVE_ORDER_BY, type ArchiveCursorRow } from './archive-pagination';
import { ArchiveLogsQueryDto } from './dto/archive-logs.dto';
import { LogInspectionService } from './log-inspection.service';

// ───────────────────────────────────────────────────────────
//  Story ID 08 – LogInspectionService.listArchive against a fake PrismaService.
//
//  The fake records every call, so the suite can pin the exact `findMany`
//  arguments (where/orderBy/take+1/skip/cursor/select) and the cursor guard,
//  while still exercising the real paging arithmetic end to end.
// ───────────────────────────────────────────────────────────

interface FakeArchiveRow extends ArchiveCursorRow {
  transactionId: string;
  kioskId: string;
  operatorId: string | null;
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  waterType: 'COMMERCIAL' | 'SUBSIDIZED';
  isReadByManager: boolean;
  recordedAt: Date;
  createdAt: Date;
}

interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  take: number;
  skip?: number;
  cursor?: { id: string };
  select?: Record<string, boolean>;
}

/** The projection the archive endpoint must return, field for field. */
const ARCHIVE_SELECT = {
  id: true,
  transactionId: true,
  kioskId: true,
  operatorId: true,
  meterVolume: true,
  reportedCash: true,
  expectedRevenue: true,
  variance: true,
  isAnomaly: true,
  waterType: true,
  isReadByManager: true,
  recordedAt: true,
  createdAt: true,
};

/** The projection `resolveArchiveCursor` reads to evaluate the active filter. */
const CURSOR_SELECT = {
  id: true,
  kioskId: true,
  isReadByManager: true,
  recordedAt: true,
};

/** In-memory stand-in for the two Prisma calls `listArchive` makes. */
function createFakePrisma() {
  const rows: FakeArchiveRow[] = [];

  const byNewest = (a: FakeArchiveRow, b: FakeArchiveRow) =>
    b.recordedAt.getTime() - a.recordedAt.getTime() ||
    b.id.localeCompare(a.id);

  /** Evaluates a `buildArchiveWhere` result, as Prisma would. */
  const matchesWhere = (row: FakeArchiveRow, where?: Record<string, unknown>) => {
    if (!where) return true;

    if (typeof where.kioskId === 'string' && row.kioskId !== where.kioskId) {
      return false;
    }
    if (
      typeof where.isReadByManager === 'boolean' &&
      row.isReadByManager !== where.isReadByManager
    ) {
      return false;
    }

    const range = where.recordedAt as { gte?: Date; lte?: Date } | undefined;
    if (range?.gte && row.recordedAt.getTime() < range.gte.getTime()) {
      return false;
    }
    if (range?.lte && row.recordedAt.getTime() > range.lte.getTime()) {
      return false;
    }
    return true;
  };

  return {
    rows,
    dailyLog: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        // Mirrors `resolveArchiveCursor`'s select — the filter fields are needed
        // to decide whether the cursor row must be skipped.
        return row
          ? {
              id: row.id,
              kioskId: row.kioskId,
              isReadByManager: row.isReadByManager,
              recordedAt: row.recordedAt,
            }
          : null;
      }),
      /**
       * Faithful model of Prisma's `findMany({ where, orderBy, cursor, skip,
       * take })`: apply `where` first, then position on the inclusive keyset
       * predicate for the (recordedAt DESC, id DESC) order, and only then
       * apply `skip`/`take`. The cursor row is looked up in the *unfiltered*
       * table, exactly as Prisma positions relative to the stored row.
       */
      findMany: jest.fn(async (args: FindManyArgs) => {
        const filtered = rows.filter((row) => matchesWhere(row, args.where));
        filtered.sort(byNewest);

        let candidates = filtered;
        if (args.cursor) {
          const cursorRow = rows.find((row) => row.id === args.cursor?.id);
          // Prisma 6 answers an unknown cursor with an empty page.
          if (!cursorRow) return [];
          candidates = filtered.filter(
            (row) =>
              row.recordedAt.getTime() < cursorRow.recordedAt.getTime() ||
              (row.recordedAt.getTime() === cursorRow.recordedAt.getTime() &&
                row.id <= cursorRow.id),
          );
        }

        const skip = args.skip ?? 0;
        return candidates.slice(skip, skip + args.take).map((row) => ({ ...row }));
      }),
    },
  };
}

const seedRow = (
  id: string,
  overrides: Partial<FakeArchiveRow> = {},
): FakeArchiveRow => ({
  id,
  transactionId: `TXN-${id}`,
  kioskId: 'KIOSK-001',
  operatorId: 'OP-1',
  meterVolume: 100,
  reportedCash: 100,
  expectedRevenue: 100,
  variance: 0,
  isAnomaly: false,
  waterType: 'COMMERCIAL',
  isReadByManager: false,
  recordedAt: new Date('2026-11-01T00:00:00.000Z'),
  createdAt: new Date('2026-11-01T00:00:01.000Z'),
  ...overrides,
});

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12, 0, 0));

const query = (overrides: Partial<ArchiveLogsQueryDto> = {}) =>
  overrides as ArchiveLogsQueryDto;

/** Returns the rejected error so the caller can assert its exact message. */
const capture = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
};

describe('LogInspectionService.listArchive (Story ID 08)', () => {
  const build = () => {
    const prisma = createFakePrisma();
    const service = new LogInspectionService(
      prisma as unknown as PrismaService,
    );
    return { prisma, service };
  };

  /** The args of the most recent `findMany` call. */
  const lastFindManyArgs = (
    prisma: ReturnType<typeof createFakePrisma>,
  ): FindManyArgs => {
    const call = prisma.dailyLog.findMany.mock.calls.at(-1);
    if (!call) throw new Error('findMany was not called');
    return call[0];
  };

  it('queries with the total archive order and a limit+1 probe', async () => {
    const { prisma, service } = build();
    prisma.rows.push(seedRow('log-1'));

    const page = await service.listArchive(
      query({ kioskId: 'KIOSK-001', limit: 20 }),
    );

    expect(prisma.dailyLog.findUnique).not.toHaveBeenCalled();
    expect(prisma.dailyLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith({
      where: { kioskId: 'KIOSK-001' },
      orderBy: ARCHIVE_ORDER_BY,
      take: 21,
      select: ARCHIVE_SELECT,
    });
    expect(page).toMatchObject({ limit: 20, hasMore: false, nextCursor: null });
    expect(page.data.map((row) => row.id)).toEqual(['log-1']);

    // Without a cursor, neither `cursor` nor `skip` may reach Prisma.
    const args = lastFindManyArgs(prisma);
    expect(args).not.toHaveProperty('cursor');
    expect(args).not.toHaveProperty('skip');
  });

  it('defaults to ARCHIVE_DEFAULT_LIMIT when no limit is given', async () => {
    const { prisma, service } = build();

    const page = await service.listArchive(query());

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 21, orderBy: ARCHIVE_ORDER_BY }),
    );
    expect(page.limit).toBe(20);
  });

  it('returns limit rows plus hasMore when the probe row arrives', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-newest', { recordedAt: at(3) }),
      seedRow('log-middle', { recordedAt: at(2) }),
      seedRow('log-oldest', { recordedAt: at(1) }),
    );

    const page = await service.listArchive(query({ limit: 2 }));

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3 }),
    );
    expect(page.data.map((row) => row.id)).toEqual([
      'log-newest',
      'log-middle',
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('log-middle');
    expect(page.limit).toBe(2);
  });

  it('hasMore=false and nextCursor=null when the page exactly fills the limit', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-a', { recordedAt: at(2) }),
      seedRow('log-b', { recordedAt: at(1) }),
    );

    const page = await service.listArchive(query({ limit: 2 }));

    expect(page.data.map((row) => row.id)).toEqual(['log-a', 'log-b']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('validates a known cursor and skips it in the page query', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-4', { recordedAt: at(4) }),
      seedRow('log-3', { recordedAt: at(3) }),
      seedRow('log-2', { recordedAt: at(2) }),
    );

    const page = await service.listArchive(
      query({ kioskId: 'KIOSK-001', cursor: 'log-3', limit: 1 }),
    );

    expect(prisma.dailyLog.findUnique).toHaveBeenCalledWith({
      where: { id: 'log-3' },
      select: CURSOR_SELECT,
    });
    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith({
      where: { kioskId: 'KIOSK-001' },
      orderBy: ARCHIVE_ORDER_BY,
      take: 2,
      cursor: { id: 'log-3' },
      skip: 1,
      select: ARCHIVE_SELECT,
    });
    expect(page.data.map((row) => row.id)).toEqual(['log-2']);
    expect(page.data.map((row) => row.id)).not.toContain('log-3');
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a cursor from another kiosk without querying the page', async () => {
    const { prisma, service } = build();
    prisma.rows.push(seedRow('log-foreign', { kioskId: 'KIOSK-002' }));

    const error = await capture(() =>
      service.listArchive(query({ kioskId: 'KIOSK-001', cursor: 'log-foreign' })),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'cursor does not belong to kioskId "KIOSK-001"',
    );
    expect(prisma.dailyLog.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown cursor with the exact message', async () => {
    const { prisma, service } = build();

    const error = await capture(() =>
      service.listArchive(query({ kioskId: 'KIOSK-001', cursor: 'gone' })),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'cursor "gone" was not found in the archive',
    );
    expect(prisma.dailyLog.findMany).not.toHaveBeenCalled();
  });

  it('accepts any kiosk cursor when the query is not kiosk-scoped', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-x', { kioskId: 'KIOSK-777', recordedAt: at(2) }),
      seedRow('log-y', { kioskId: 'KIOSK-777', recordedAt: at(1) }),
    );

    const page = await service.listArchive(query({ cursor: 'log-x' }));

    expect(prisma.dailyLog.findUnique).toHaveBeenCalledWith({
      where: { id: 'log-x' },
      select: CURSOR_SELECT,
    });
    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'log-x' }, skip: 1 }),
    );
    expect(page.data.map((row) => row.id)).toEqual(['log-y']);
  });

  // ───────────────────────────────────────────────────────────
  //  F1 regression: the skip must be CONDITIONAL.
  //
  //  Prisma compiles `cursor + skip: 1` to a keyset predicate plus SQL
  //  `OFFSET 1`. When the active filter excludes the cursor row (e.g. it was
  //  marked read while paging with `unseenOnly=true`), that OFFSET drops the
  //  first *matching* row instead — silent data loss. `skip` must only be 1
  //  while `matchesArchiveFilter(cursorRow, query)` is true.
  // ───────────────────────────────────────────────────────────

  it('skips the cursor row when it still satisfies kiosk+range+unseenOnly', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-4', { recordedAt: at(4), isReadByManager: false }),
      seedRow('log-3', { recordedAt: at(3), isReadByManager: false }),
      seedRow('log-2', { recordedAt: at(2), isReadByManager: false }),
    );

    const page = await service.listArchive(
      query({
        kioskId: 'KIOSK-001',
        cursor: 'log-3',
        unseenOnly: true,
        startDate: '2026-11-01',
        endDate: '2026-11-30',
        limit: 1,
      }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'log-3' },
        skip: 1,
      }),
    );
    // The cursor row matched the filter, so it is not re-served.
    expect(page.data.map((row) => row.id)).toEqual(['log-2']);
    expect(page.nextCursor).toBeNull();
  });

  it('does not skip a cursor row marked read while paging unseenOnly', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      // The realistic F1 case: the previous page's last row has just been
      // marked read, so it no longer matches `unseenOnly=true`.
      seedRow('log-3', { recordedAt: at(3), isReadByManager: true }),
      seedRow('log-2', { recordedAt: at(2), isReadByManager: false }),
      seedRow('log-1', { recordedAt: at(1), isReadByManager: false }),
    );

    const page = await service.listArchive(
      query({ kioskId: 'KIOSK-001', cursor: 'log-3', unseenOnly: true }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'log-3' },
        skip: 0,
      }),
    );
    // F1 would have dropped `log-2` here; the page must start at the row
    // immediately after the excluded cursor and never re-serve `log-3`.
    expect(page.data.map((row) => row.id)).toEqual(['log-2', 'log-1']);
    expect(page.data.map((row) => row.id)).not.toContain('log-3');
  });

  it('does not skip a cursor row outside the requested date range', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-9', { recordedAt: at(9) }),
      seedRow('log-5', { recordedAt: at(5) }),
      seedRow('log-1', { recordedAt: at(1) }),
    );

    const page = await service.listArchive(
      query({
        kioskId: 'KIOSK-001',
        cursor: 'log-9',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
      }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'log-9' },
        skip: 0,
      }),
    );
    // `log-9` is outside the window, so the OFFSET must not eat `log-5`, the
    // first (newest) in-range row.
    expect(page.data.map((row) => row.id)).toEqual(['log-5', 'log-1']);
    expect(page.data.map((row) => row.id)).not.toContain('log-9');
  });

  it('does not skip a read cursor row when unseenOnly is not requested', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-3', { recordedAt: at(3), isReadByManager: true }),
    );

    await service.listArchive(
      query({ kioskId: 'KIOSK-001', cursor: 'log-3' }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'log-3' }, skip: 1 }),
    );
  });

  it('trims the limit+1 probe under a filtered cursor that is not skipped', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      // `log-5` is the cursor but has been marked read, so it is excluded by
      // `unseenOnly` and must not be skipped again.
      seedRow('log-5', { recordedAt: at(5), isReadByManager: true }),
      seedRow('log-4', { recordedAt: at(4) }),
      seedRow('log-3', { recordedAt: at(3) }),
      seedRow('log-2', { recordedAt: at(2) }),
      seedRow('log-1', { recordedAt: at(1) }),
    );

    const page = await service.listArchive(
      query({
        kioskId: 'KIOSK-001',
        cursor: 'log-5',
        unseenOnly: true,
        limit: 2,
      }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'log-5' }, skip: 0, take: 3 }),
    );
    // Probe row `log-2` is trimmed; the filter excluded the cursor row.
    expect(page.data.map((row) => row.id)).toEqual(['log-4', 'log-3']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('log-3');
    expect(page.limit).toBe(2);
  });

  it('trims the limit+1 probe under a filtered cursor that is skipped', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-5', { recordedAt: at(5) }),
      seedRow('log-4', { recordedAt: at(4) }),
      seedRow('log-3', { recordedAt: at(3) }),
      seedRow('log-2', { recordedAt: at(2) }),
      seedRow('log-1', { recordedAt: at(1) }),
    );

    const page = await service.listArchive(
      query({
        kioskId: 'KIOSK-001',
        cursor: 'log-4',
        unseenOnly: true,
        limit: 2,
      }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'log-4' }, skip: 1, take: 3 }),
    );
    // `log-4` matched the filter and was skipped; the probe row `log-1` is
    // trimmed, so the page is the two rows right after the cursor.
    expect(page.data.map((row) => row.id)).toEqual(['log-3', 'log-2']);
    expect(page.data.map((row) => row.id)).not.toContain('log-4');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('log-2');
  });

  it('resolves a cursor when kioskId is whitespace-padded', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      seedRow('log-4', { recordedAt: at(4) }),
      seedRow('log-3', { recordedAt: at(3) }),
      seedRow('log-2', { recordedAt: at(2) }),
    );

    // Dropping the `.trim()` in `resolveArchiveCursor` (or in
    // `buildArchiveWhere`) would answer 400 here instead of the next page.
    const page = await service.listArchive(
      query({ kioskId: '  KIOSK-001  ', cursor: 'log-3', limit: 1 }),
    );

    expect(prisma.dailyLog.findUnique).toHaveBeenCalledWith({
      where: { id: 'log-3' },
      select: CURSOR_SELECT,
    });
    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith({
      where: { kioskId: 'KIOSK-001' },
      orderBy: ARCHIVE_ORDER_BY,
      take: 2,
      cursor: { id: 'log-3' },
      skip: 1,
      select: ARCHIVE_SELECT,
    });
    expect(page.data.map((row) => row.id)).toEqual(['log-2']);
    expect(page.hasMore).toBe(false);
  });

  it('maps a Prisma P2025 to a 400', async () => {
    const { prisma, service } = build();
    prisma.rows.push(seedRow('log-1'));
    prisma.dailyLog.findMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: '6.4.0',
      }),
    );

    const error = await capture(() =>
      service.listArchive(query({ cursor: 'log-1' })),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'cursor "log-1" is no longer available',
    );
  });

  it('rethrows unexpected Prisma failures', async () => {
    const { prisma, service } = build();
    prisma.dailyLog.findMany.mockRejectedValueOnce(
      new Error('connection lost'),
    );

    await expect(service.listArchive(query())).rejects.toThrow(
      'connection lost',
    );
  });

  it.each<[string, number]>([
    ['zero', 0],
    ['above the maximum', 101],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
  ])('rejects limit=%s before touching the database', async (_label, limit) => {
    const { prisma, service } = build();

    const error = await capture(() => service.listArchive(query({ limit })));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(prisma.dailyLog.findMany).not.toHaveBeenCalled();
    expect(prisma.dailyLog.findUnique).not.toHaveBeenCalled();
  });

  it('forwards kiosk, unread and range filters into the where clause', async () => {
    const { prisma, service } = build();

    await service.listArchive(
      query({
        kioskId: '  KIOSK-001  ',
        unseenOnly: true,
        startDate: '2026-11-01',
        endDate: '2026-11-30',
      }),
    );

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kioskId: 'KIOSK-001',
          isReadByManager: false,
          recordedAt: {
            gte: new Date('2026-11-01T00:00:00.000Z'),
            lte: new Date('2026-11-30T23:59:59.999Z'),
          },
        },
      }),
    );
  });

  it('passes an undefined where when nothing is filtered', async () => {
    const { prisma, service } = build();

    await service.listArchive(query());

    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });
});
