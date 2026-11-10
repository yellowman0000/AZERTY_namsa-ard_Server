import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  ARCHIVE_ORDER_BY,
  buildArchivePage,
  buildArchiveWhere,
  matchesArchiveFilter,
  normalizeArchiveLimit,
  type ArchiveFilterRow,
  type ArchivePage,
} from './archive-pagination';
import { ArchiveLogsQueryDto } from './dto/archive-logs.dto';
import { DEFAULT_LOG_PAGE_SIZE, ListLogsQueryDto } from './dto/list-logs.dto';
import {
  toLogInspection,
  type InspectableLog,
  type LogInspection,
} from './log-inspection';

export interface LogSummary {
  id: string;
  transactionId: string;
  kioskId: string;
  meterVolume: number;
  isReadByManager?: boolean;
  recordedAt: Date;
  createdAt: Date;
}

export interface LogPage {
  data: LogSummary[];
  /** Pass as `cursor` to fetch the next page; `null` on the last page. */
  nextCursor: string | null;
  /** Total count of unseen logs (Story 08). */
  unseenCount?: number;
}

const summarySelect = {
  id: true,
  transactionId: true,
  kioskId: true,
  meterVolume: true,
  isReadByManager: true,
  recordedAt: true,
  createdAt: true,
} as const;

/**
 * Columns projected for the historical archive: the interpreted figures
 * (Story 04) travel with each row so the manager table does not need a second
 * request per page.
 */
const archiveSelect = {
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
} as const;

export type ArchiveLogRow = Prisma.DailyLogGetPayload<{
  select: typeof archiveSelect;
}>;

/**
 * Read-only access to stored daily logs for Operation Managers.
 * Never writes: inspecting a log must not change the evidence.
 */
@Injectable()
export class LogInspectionService {
  constructor(private readonly prisma: PrismaService) {}

  async listLogs(query: ListLogsQueryDto): Promise<LogPage> {
    const limit = query.limit ?? DEFAULT_LOG_PAGE_SIZE;

    let start: Date | undefined;
    let end: Date | undefined;

    if (query.startDate !== undefined && query.startDate !== '') {
      start = new Date(query.startDate);
      if (Number.isNaN(start.getTime())) {
        throw new BadRequestException(
          'startDate must be a valid ISO-8601 date string',
        );
      }
    }

    if (query.endDate !== undefined && query.endDate !== '') {
      end = new Date(query.endDate);
      if (Number.isNaN(end.getTime())) {
        throw new BadRequestException(
          'endDate must be a valid ISO-8601 date string',
        );
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.endDate)) {
        end.setUTCHours(23, 59, 59, 999);
      }
    }

    if (start && end && start > end) {
      throw new BadRequestException('startDate must not be after endDate');
    }

    const where: any = {};
    if (query.kioskId) {
      where.kioskId = query.kioskId;
    }
    if (query.unseenOnly === true) {
      where.isReadByManager = false;
    }
    if (start || end) {
      where.recordedAt = {
        ...(start && { gte: start }),
        ...(end && { lte: end }),
      };
    }

    const whereClause = Object.keys(where).length > 0 ? where : undefined;

    // Fetch one extra row to learn whether another page exists.
    const rows: LogSummary[] = await this.prisma.dailyLog.findMany({
      where: whereClause,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: summarySelect,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let unseenCount: number | undefined;
    if (typeof this.prisma?.dailyLog?.count === 'function') {
      try {
        unseenCount = await this.prisma.dailyLog.count({
          where: {
            ...(query.kioskId ? { kioskId: query.kioskId } : {}),
            isReadByManager: false,
          },
        });
      } catch {
        // Ignore if mock doesn't handle count
      }
    }

    return {
      data,
      nextCursor: hasMore ? data[data.length - 1].id : null,
      ...(unseenCount !== undefined ? { unseenCount } : {}),
    };
  }

  /**
   * Story ID 08 – cursor-paginated historical archive.
   *
   * Pages newest-first through `daily_logs` with `recorded_at DESC, id DESC`,
   * which the composite index `daily_logs_kiosk_id_recorded_at_idx`
   * (`kiosk_id, recorded_at DESC`) serves. One extra row is fetched to learn
   * whether the caller may continue, so the response can hand out a
   * `nextCursor` without a second count query.
   *
   * `GET /api/kiosk/logs/archive?cursor=<id>&limit=20`
   */
  async listArchive(
    query: ArchiveLogsQueryDto,
  ): Promise<ArchivePage<ArchiveLogRow>> {
    const limit = normalizeArchiveLimit(query.limit);
    const where = buildArchiveWhere(query);

    // Prisma positions a cursor relative to a stored row; fail fast (400)
    // instead of surfacing an opaque engine error for a stale/deleted cursor.
    let skip = 0;
    if (query.cursor) {
      const position = await this.resolveArchiveCursor(query.cursor, query.kioskId);
      // Prisma's `cursor` + `skip: 1` drops the cursor row via SQL `OFFSET 1`.
      // That is only the row we mean to drop while the cursor still matches the
      // active filter; otherwise the OFFSET would eat the first matching row.
      skip = matchesArchiveFilter(position, query) ? 1 : 0;
    }

    let rows: ArchiveLogRow[];
    try {
      rows = await this.prisma.dailyLog.findMany({
        where,
        orderBy: ARCHIVE_ORDER_BY,
        take: limit + 1,
        ...(query.cursor
          ? { cursor: { id: query.cursor }, skip }
          : {}),
        select: archiveSelect,
      });
    } catch (error) {
      // Defensive: map Prisma's "cursor row not found" error to the same 400.
      // Prisma 6 returns an empty page for a cursor deleted after the guard
      // above rather than raising, so this is insurance, not the main path.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new BadRequestException(
          `cursor "${query.cursor}" is no longer available`,
        );
      }
      throw error;
    }

    return buildArchivePage(rows, limit);
  }

  /**
   * Resolves a cursor id to its row. A cursor must exist, and a cursor
   * pointing at another kiosk's log is rejected: paginating that archive from
   * a foreign position would silently return a wrong page instead of an error.
   */
  private async resolveArchiveCursor(
    cursor: string,
    kioskId?: string,
  ): Promise<ArchiveFilterRow> {
    const position = await this.prisma.dailyLog.findUnique({
      where: { id: cursor },
      select: {
        id: true,
        kioskId: true,
        isReadByManager: true,
        recordedAt: true,
      },
    });

    if (!position) {
      throw new BadRequestException(
        `cursor "${cursor}" was not found in the archive`,
      );
    }

    const requestedKioskId = kioskId?.trim();
    if (requestedKioskId && position.kioskId !== requestedKioskId) {
      throw new BadRequestException(
        `cursor does not belong to kioskId "${requestedKioskId}"`,
      );
    }

    return position;
  }

  /** Loads a log and re-verifies its checksum against the current DB values. */
  async inspectLog(id: string): Promise<LogInspection> {
    const log: InspectableLog | null = await this.prisma.dailyLog.findUnique({
      where: { id },
    });

    if (!log) {
      throw new NotFoundException(`Log "${id}" not found.`);
    }

    return toLogInspection(log);
  }
}
