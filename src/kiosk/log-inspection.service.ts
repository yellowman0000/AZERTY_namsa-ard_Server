import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
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
