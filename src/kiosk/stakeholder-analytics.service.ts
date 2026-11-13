import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StakeholderAnalyticsQueryDto } from './dto/stakeholder-analytics.dto';
import {
  calculateStakeholderAnalytics,
  resolveMonthDateRange,
  resolveTargetMonth,
  StakeholderAnalyticsResponse,
} from './stakeholder-analytics';

@Injectable()
export class StakeholderAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStakeholderAnalytics(
    query: StakeholderAnalyticsQueryDto = {},
  ): Promise<StakeholderAnalyticsResponse> {
    const month = resolveTargetMonth(query.month);
    const { startDate, endDate } = resolveMonthDateRange(month);

    const where: any = {
      recordedAt: {
        gte: startDate,
        lte: endDate,
      },
    };

    if (query.kioskId && query.kioskId.trim()) {
      where.kioskId = query.kioskId.trim();
    }

    const logs =
      typeof this.prisma?.dailyLog?.findMany === 'function'
        ? await this.prisma.dailyLog.findMany({
            where,
            orderBy: { recordedAt: 'asc' },
          })
        : [];

    return calculateStakeholderAnalytics(logs, month);
  }
}
