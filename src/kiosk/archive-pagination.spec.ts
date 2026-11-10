import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ARCHIVE_DEFAULT_LIMIT,
  ARCHIVE_MAX_LIMIT,
  ARCHIVE_ORDER_BY,
  buildArchivePage,
  buildArchiveWhere,
  matchesArchiveFilter,
  normalizeArchiveLimit,
  parseArchiveRange,
  type ArchiveFilterRow,
  type ArchiveQuery,
} from './archive-pagination';

// ───────────────────────────────────────────────────────────
//  Story ID 08 – pure paging helpers (archive-pagination.ts).
//
//  Every helper is side-effect free, so the limit/range validation and the
//  page arithmetic are asserted directly, without Prisma or HTTP.
// ───────────────────────────────────────────────────────────

/** Runs `fn` and returns the `BadRequestException` it must throw. */
const badRequest = (fn: () => unknown): BadRequestException => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return error as BadRequestException;
  }
  throw new Error('expected a BadRequestException to be thrown');
};

const row = (id: string) => ({ id });

describe('archive pagination constants', () => {
  it('defaults to 20 and caps at 100', () => {
    expect(ARCHIVE_DEFAULT_LIMIT).toBe(20);
    expect(ARCHIVE_MAX_LIMIT).toBe(100);
  });

  it('orders newest-first with a unique id tie-break', () => {
    expect(ARCHIVE_ORDER_BY).toEqual([{ recordedAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('normalizeArchiveLimit', () => {
  it('defaults to 20 when the limit is omitted', () => {
    expect(normalizeArchiveLimit()).toBe(20);
    expect(normalizeArchiveLimit(undefined)).toBe(20);
  });

  it.each<[string, number]>([
    ['the minimum', 1],
    ['the default', 20],
    ['a middle value', 57],
    ['the maximum', 100],
  ])('accepts %s', (_label, limit) => {
    expect(normalizeArchiveLimit(limit)).toBe(limit);
  });

  it.each<[string, number]>([
    ['zero', 0],
    ['a negative value', -1],
    ['one above the maximum', 101],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
  ])('rejects %s with 400', (_label, limit) => {
    expect(badRequest(() => normalizeArchiveLimit(limit)).message).toBe(
      `limit must be an integer between 1 and ${ARCHIVE_MAX_LIMIT}`,
    );
  });
});

describe('parseArchiveRange', () => {
  it('parses ISO datetimes for both bounds', () => {
    const { start, end } = parseArchiveRange(
      '2026-11-01T00:00:00.000Z',
      '2026-11-05T12:30:00.000Z',
    );

    expect(start?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(end?.toISOString()).toBe('2026-11-05T12:30:00.000Z');
  });

  it('extends a date-only endDate to the last millisecond of that UTC day', () => {
    const { end } = parseArchiveRange(undefined, '2026-11-04');

    expect(end?.toISOString()).toBe('2026-11-04T23:59:59.999Z');
  });

  it('keeps a date-only startDate at 00:00:00.000 UTC', () => {
    const { start } = parseArchiveRange('2026-11-04', undefined);

    expect(start?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('ignores empty strings on both bounds', () => {
    expect(parseArchiveRange('', '')).toEqual({
      start: undefined,
      end: undefined,
    });
  });

  it('leaves omitted bounds undefined', () => {
    expect(parseArchiveRange()).toEqual({ start: undefined, end: undefined });
  });

  it('rejects a garbage startDate with the exact message', () => {
    expect(badRequest(() => parseArchiveRange('not-a-date')).message).toBe(
      'startDate must be a valid ISO-8601 date string',
    );
  });

  it('rejects a garbage endDate with the exact message', () => {
    expect(
      badRequest(() => parseArchiveRange(undefined, 'not-a-date')).message,
    ).toBe('endDate must be a valid ISO-8601 date string');
  });

  it('rejects startDate after endDate with the exact message', () => {
    expect(
      badRequest(() => parseArchiveRange('2026-11-10', '2026-11-01')).message,
    ).toBe('startDate must not be after endDate');
  });

  it('accepts a range whose bounds are equal', () => {
    const { start, end } = parseArchiveRange('2026-11-04', '2026-11-04');

    expect(start?.getTime()).toBeLessThanOrEqual(end?.getTime() as number);
  });

  it('rejects startDate after a date-only endDate expanded to end-of-day', () => {
    expect(
      badRequest(() => parseArchiveRange('2026-11-05T00:00:00.000Z', '2026-11-04'))
        .message,
    ).toBe('startDate must not be after endDate');
  });
});

describe('buildArchiveWhere', () => {
  it('returns undefined when nothing is filtered', () => {
    expect(buildArchiveWhere({})).toBeUndefined();
  });

  it('scopes to one kiosk and trims surrounding whitespace', () => {
    expect(buildArchiveWhere({ kioskId: '  KIOSK-001  ' })).toEqual({
      kioskId: 'KIOSK-001',
    });
  });

  it('treats a blank kioskId as no filter', () => {
    expect(buildArchiveWhere({ kioskId: '   ' })).toBeUndefined();
  });

  it('adds the unread filter only when unseenOnly is true', () => {
    expect(buildArchiveWhere({ unseenOnly: true })).toEqual({
      isReadByManager: false,
    });
    expect(buildArchiveWhere({ unseenOnly: false })).toBeUndefined();
  });

  it('builds an inclusive start/end recordedAt range', () => {
    expect(
      buildArchiveWhere({
        startDate: '2026-11-01T00:00:00.000Z',
        endDate: '2026-11-04',
      }),
    ).toEqual({
      recordedAt: {
        gte: new Date('2026-11-01T00:00:00.000Z'),
        lte: new Date('2026-11-04T23:59:59.999Z'),
      },
    });
  });

  it('supports a start-only range', () => {
    expect(buildArchiveWhere({ startDate: '2026-11-01' })).toEqual({
      recordedAt: { gte: new Date('2026-11-01T00:00:00.000Z') },
    });
  });

  it('supports an end-only date-only range', () => {
    expect(buildArchiveWhere({ endDate: '2026-11-30' })).toEqual({
      recordedAt: { lte: new Date('2026-11-30T23:59:59.999Z') },
    });
  });

  it('combines kiosk, unread and range filters', () => {
    expect(
      buildArchiveWhere({
        kioskId: ' KIOSK-001 ',
        unseenOnly: true,
        startDate: '2026-11-01',
        endDate: '2026-11-30',
      }),
    ).toEqual({
      kioskId: 'KIOSK-001',
      isReadByManager: false,
      recordedAt: {
        gte: new Date('2026-11-01T00:00:00.000Z'),
        lte: new Date('2026-11-30T23:59:59.999Z'),
      },
    });
  });

  it('propagates the date validation error', () => {
    expect(badRequest(() => buildArchiveWhere({ startDate: 'nope' })).message).toBe(
      'startDate must be a valid ISO-8601 date string',
    );
  });
});

describe('buildArchivePage', () => {
  it('trims the probe row and points nextCursor at the last returned row', () => {
    const page = buildArchivePage([row('a'), row('b'), row('c')], 2);

    expect(page).toEqual({
      data: [row('a'), row('b')],
      nextCursor: 'b',
      hasMore: true,
      limit: 2,
    });
  });

  it('reports hasMore=false and nextCursor=null on an exact fit', () => {
    const page = buildArchivePage([row('a'), row('b')], 2);

    expect(page).toEqual({
      data: [row('a'), row('b')],
      nextCursor: null,
      hasMore: false,
      limit: 2,
    });
  });

  it('handles an empty result set', () => {
    expect(buildArchivePage([], 20)).toEqual({
      data: [],
      nextCursor: null,
      hasMore: false,
      limit: 20,
    });
  });

  it('keeps every row when fewer than limit were returned', () => {
    const page = buildArchivePage([row('a')], 20);

    expect(page.data).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles the limit boundary of 1', () => {
    const page = buildArchivePage([row('newest'), row('older')], 1);

    expect(page.data).toEqual([row('newest')]);
    expect(page.nextCursor).toBe('newest');
    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(1);
  });

  it('preserves the extra fields of the returned rows', () => {
    const page = buildArchivePage(
      [
        { id: 'a', kioskId: 'K-1' },
        { id: 'b', kioskId: 'K-1' },
      ],
      1,
    );

    expect(page.data).toEqual([{ id: 'a', kioskId: 'K-1' }]);
  });
});

// ───────────────────────────────────────────────────────────
//  F1 regression: `matchesArchiveFilter` decides whether the cursor row must
//  be skipped (`skip: 1`) or kept (`skip: 0`). It must agree with
//  `buildArchiveWhere` for every row/filter combination, or pagination drifts
//  from the query it is paging through.
// ───────────────────────────────────────────────────────────

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12, 0, 0));

const filterRow = (
  overrides: Partial<ArchiveFilterRow> = {},
): ArchiveFilterRow => ({
  id: 'log-1',
  kioskId: 'KIOSK-001',
  isReadByManager: false,
  recordedAt: new Date('2026-11-10T12:00:00.000Z'),
  ...overrides,
});

describe('matchesArchiveFilter', () => {
  it('matches everything when no filter is active', () => {
    expect(matchesArchiveFilter(filterRow(), {})).toBe(true);
    expect(matchesArchiveFilter(filterRow({ kioskId: 'K-9' }), {})).toBe(true);
  });

  it('requires the row kioskId to equal the trimmed query kioskId', () => {
    expect(
      matchesArchiveFilter(filterRow(), { kioskId: '  KIOSK-001  ' }),
    ).toBe(true);
    expect(matchesArchiveFilter(filterRow(), { kioskId: 'KIOSK-002' })).toBe(
      false,
    );
  });

  it('requires an unread row when unseenOnly is true', () => {
    expect(matchesArchiveFilter(filterRow(), { unseenOnly: true })).toBe(true);

    const read = filterRow({ isReadByManager: true });
    expect(matchesArchiveFilter(read, { unseenOnly: true })).toBe(false);
    expect(matchesArchiveFilter(read, { unseenOnly: false })).toBe(true);
    expect(matchesArchiveFilter(read, {})).toBe(true);
  });

  it('applies an inclusive startDate/endDate range', () => {
    const inside = filterRow({
      recordedAt: new Date('2026-11-10T12:00:00.000Z'),
    });
    expect(
      matchesArchiveFilter(inside, {
        startDate: '2026-11-01T00:00:00.000Z',
        endDate: '2026-11-30T23:59:59.999Z',
      }),
    ).toBe(true);

    const before = filterRow({
      recordedAt: new Date('2026-10-31T23:59:59.999Z'),
    });
    expect(
      matchesArchiveFilter(before, { startDate: '2026-11-01T00:00:00.000Z' }),
    ).toBe(false);

    const after = filterRow({
      recordedAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(
      matchesArchiveFilter(after, { endDate: '2026-11-30T23:59:59.999Z' }),
    ).toBe(false);
  });

  it('includes the whole day for a date-only endDate', () => {
    const lastMillisecond = filterRow({
      recordedAt: new Date('2026-11-04T23:59:59.999Z'),
    });
    expect(matchesArchiveFilter(lastMillisecond, { endDate: '2026-11-04' })).toBe(
      true,
    );

    const nextDay = filterRow({
      recordedAt: new Date('2026-11-05T00:00:00.000Z'),
    });
    expect(matchesArchiveFilter(nextDay, { endDate: '2026-11-04' })).toBe(false);
  });

  it('fails when any single dimension excludes the row', () => {
    const query: ArchiveQuery = {
      kioskId: 'KIOSK-001',
      unseenOnly: true,
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    };

    expect(matchesArchiveFilter(filterRow(), query)).toBe(true);
    expect(
      matchesArchiveFilter(filterRow({ kioskId: 'KIOSK-002' }), query),
    ).toBe(false);
    expect(
      matchesArchiveFilter(filterRow({ isReadByManager: true }), query),
    ).toBe(false);
    expect(
      matchesArchiveFilter(
        filterRow({ recordedAt: new Date('2026-10-01T00:00:00.000Z') }),
        query,
      ),
    ).toBe(false);
    expect(
      matchesArchiveFilter(
        filterRow({ recordedAt: new Date('2026-12-01T00:00:00.000Z') }),
        query,
      ),
    ).toBe(false);
  });

  it('propagates date validation errors', () => {
    expect(
      badRequest(() => matchesArchiveFilter(filterRow(), { startDate: 'nope' }))
        .message,
    ).toBe('startDate must be a valid ISO-8601 date string');
  });

  it('agrees with buildArchiveWhere across every filter combination', () => {
    const rows: ArchiveFilterRow[] = [
      filterRow({ id: 'r-k1-unread-in', recordedAt: at(10) }),
      filterRow({ id: 'r-k1-read-in', isReadByManager: true }),
      filterRow({ id: 'r-k2-unread-in', kioskId: 'KIOSK-002' }),
      filterRow({
        id: 'r-k1-unread-before',
        recordedAt: new Date('2026-10-31T23:59:59.999Z'),
      }),
      filterRow({
        id: 'r-k1-unread-after',
        recordedAt: new Date('2026-12-01T00:00:00.000Z'),
      }),
      filterRow({
        id: 'r-k1-read-before',
        isReadByManager: true,
        recordedAt: new Date('2026-10-31T23:59:59.999Z'),
      }),
    ];

    const queries: ArchiveQuery[] = [
      {},
      { kioskId: 'KIOSK-001' },
      { kioskId: '  KIOSK-001  ' },
      { kioskId: 'KIOSK-002' },
      { unseenOnly: true },
      { unseenOnly: false },
      { startDate: '2026-11-01' },
      { endDate: '2026-11-30' },
      { startDate: '2026-11-01', endDate: '2026-11-30' },
      { startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-30' },
      {
        kioskId: 'KIOSK-001',
        unseenOnly: true,
        startDate: '2026-11-01',
        endDate: '2026-11-30',
      },
      {
        kioskId: 'KIOSK-001',
        unseenOnly: false,
        startDate: '2026-11-01',
        endDate: '2026-11-30',
      },
    ];

    const mismatches = rows.flatMap((row) =>
      queries
        .filter((query) => {
          const viaWhere = satisfiesWhere(buildArchiveWhere(query), row);
          return matchesArchiveFilter(row, query) !== viaWhere;
        })
        .map((query) => ({ row: row.id, query })),
    );

    expect(mismatches).toEqual([]);
  });
});

/** Evaluates a `buildArchiveWhere` result against one row, as Prisma would. */
function satisfiesWhere(
  where: Prisma.DailyLogWhereInput | undefined,
  row: ArchiveFilterRow,
): boolean {
  if (!where) return true;

  if (where.kioskId !== undefined && row.kioskId !== where.kioskId) return false;

  if (
    where.isReadByManager !== undefined &&
    row.isReadByManager !== where.isReadByManager
  ) {
    return false;
  }

  const range = where.recordedAt as { gte?: Date; lte?: Date } | undefined;
  if (range?.gte && row.recordedAt.getTime() < range.gte.getTime()) return false;
  if (range?.lte && row.recordedAt.getTime() > range.lte.getTime()) return false;

  return true;
}

