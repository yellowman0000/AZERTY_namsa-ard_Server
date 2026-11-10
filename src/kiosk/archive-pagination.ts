import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DEFAULT_LOG_PAGE_SIZE, MAX_LOG_PAGE_SIZE } from './dto/list-logs.dto';

/**
 * Story ID 08 – cursor-based pagination for the historical archive.
 *
 * The archive is read newest-first with a *total* order so that cursor
 * pagination can never skip or duplicate a row: `recorded_at DESC` with the
 * unique `id` as tie-break (`ARCHIVE_ORDER_BY`). That order is served by the
 * composite index `daily_logs_kiosk_id_recorded_at_idx`
 * (`kiosk_id, recorded_at DESC`) declared in `prisma/schema.prisma` as
 * `@@index([kioskId, recordedAt(sort: Desc)])` on `DailyLog`.
 *
 * Everything in this module is pure (no Prisma client, no I/O) so the paging
 * arithmetic and the range/limit validation can be unit-tested directly.
 */

export const ARCHIVE_DEFAULT_LIMIT = DEFAULT_LOG_PAGE_SIZE;
export const ARCHIVE_MAX_LIMIT = MAX_LOG_PAGE_SIZE;

/** Newest-first total order: `recordedAt DESC`, unique `id DESC` tie-break. */
export const ARCHIVE_ORDER_BY: Prisma.DailyLogOrderByWithRelationInput[] = [
  { recordedAt: 'desc' },
  { id: 'desc' },
];

/** The only column any archive row must expose to act as a cursor. */
export interface ArchiveCursorRow {
  id: string;
}

export interface ArchivePage<T extends ArchiveCursorRow> {
  data: T[];
  /**
   * Pass as `cursor` to fetch the next page; `null` when this is the last
   * page. Points at the last row of `data`, so the caller fetches the page
   * *after* it (Prisma must skip that row).
   */
  nextCursor: string | null;
  /** True when at least one older record exists beyond `data`. */
  hasMore: boolean;
  /** Effective page size used for this page. */
  limit: number;
}

/** Query fields the archive understands (subset of `ArchiveLogsQueryDto`). */
export interface ArchiveQuery {
  kioskId?: string;
  unseenOnly?: boolean;
  startDate?: string;
  endDate?: string;
}

/**
 * The row fields needed to decide whether a cursor row satisfies the filter.
 * `id` is included so the row can double as the cursor position.
 */
export interface ArchiveFilterRow {
  id: string;
  kioskId: string;
  isReadByManager: boolean;
  recordedAt: Date;
}

export interface ArchiveRange {
  start?: Date;
  end?: Date;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates `limit`, defaulting to {@link ARCHIVE_DEFAULT_LIMIT}.
 * Throws `400 Bad Request` for a non-integer or out-of-range value so a direct
 * service call cannot silently page with a nonsense size.
 */
export function normalizeArchiveLimit(limit?: number): number {
  if (limit === undefined) return ARCHIVE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ARCHIVE_MAX_LIMIT) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${ARCHIVE_MAX_LIMIT}`,
    );
  }
  return limit;
}

/**
 * Parses the optional ISO-8601 range. A date-only `endDate` includes that
 * whole day. Throws `400 Bad Request` on an unparsable value or when
 * `startDate` is after `endDate` (spec §3.2).
 */
export function parseArchiveRange(
  startDate?: string,
  endDate?: string,
): ArchiveRange {
  let start: Date | undefined;
  let end: Date | undefined;

  if (startDate !== undefined && startDate !== '') {
    start = new Date(startDate);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException(
        'startDate must be a valid ISO-8601 date string',
      );
    }
  }

  if (endDate !== undefined && endDate !== '') {
    end = new Date(endDate);
    if (Number.isNaN(end.getTime())) {
      throw new BadRequestException(
        'endDate must be a valid ISO-8601 date string',
      );
    }
    if (DATE_ONLY.test(endDate)) {
      end.setUTCHours(23, 59, 59, 999);
    }
  }

  if (start && end && start > end) {
    throw new BadRequestException('startDate must not be after endDate');
  }

  return { start, end };
}

/**
 * Mirrors {@link buildArchiveWhere} for a single row: does this row belong to
 * the filtered result set the caller is paging through?
 *
 * Prisma compiles `cursor: { id }, skip: 1` into a keyset predicate plus SQL
 * `OFFSET 1`, where the OFFSET is meant to drop the cursor row itself. That is
 * only true while the cursor row satisfies the active `where`: if the filter
 * excludes it (e.g. the previous page's last row was marked read while paging
 * with `unseenOnly=true`), the OFFSET would silently drop the first *matching*
 * row instead. So the caller must only skip when this returns `true`.
 */
export function matchesArchiveFilter(
  row: ArchiveFilterRow,
  query: ArchiveQuery,
): boolean {
  const kioskId = query.kioskId?.trim();
  if (kioskId && row.kioskId !== kioskId) return false;

  if (query.unseenOnly === true && row.isReadByManager !== false) return false;

  const { start, end } = parseArchiveRange(query.startDate, query.endDate);
  if (start && row.recordedAt.getTime() < start.getTime()) return false;
  if (end && row.recordedAt.getTime() > end.getTime()) return false;

  return true;
}

/**
 * Builds the Prisma `where` for an archive page: kiosk scope, unread filter
 * and the `recordedAt` range. Returns `undefined` when nothing is filtered,
 * so Prisma does not receive an empty object.
 */
export function buildArchiveWhere(
  query: ArchiveQuery,
): Prisma.DailyLogWhereInput | undefined {
  const { start, end } = parseArchiveRange(query.startDate, query.endDate);

  const where: Prisma.DailyLogWhereInput = {};

  const kioskId = query.kioskId?.trim();
  if (kioskId) where.kioskId = kioskId;

  if (query.unseenOnly === true) where.isReadByManager = false;

  if (start || end) {
    where.recordedAt = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {}),
    };
  }

  return Object.keys(where).length > 0 ? where : undefined;
}

/**
 * Turns the `limit + 1` probe page into the response body: trims the extra
 * row, reports whether more remain, and exposes the cursor for the next page.
 */
export function buildArchivePage<T extends ArchiveCursorRow>(
  rows: T[],
  limit: number,
): ArchivePage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  return {
    data,
    nextCursor: hasMore ? data[data.length - 1].id : null,
    hasMore,
    limit,
  };
}
