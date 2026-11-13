import { Controller, Get, Query } from '@nestjs/common';
import { StakeholderAnalyticsQueryDto } from './dto/stakeholder-analytics.dto';
import { StakeholderAnalyticsService } from './stakeholder-analytics.service';

// ───────────────────────────────────────────────────────────
//  Story 09 – Stakeholder Analytics Aggregation
//  GET /api/kiosk/analytics/stakeholder?month=2026-10
// ───────────────────────────────────────────────────────────

@Controller(['api/kiosk', 'kiosk', 'api', ''])
export class StakeholderAnalyticsController {
  constructor(
    private readonly stakeholderAnalyticsService: StakeholderAnalyticsService,
  ) {}

  @Get(['analytics/stakeholder', 'api/kiosk/analytics/stakeholder'])
  async getStakeholderAnalytics(@Query() query: StakeholderAnalyticsQueryDto) {
    return this.stakeholderAnalyticsService.getStakeholderAnalytics(query);
  }
}
