import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { ImgbbService } from './imgbb.service';
import { LogInspectionController } from './log-inspection.controller';
import { LogInspectionService } from './log-inspection.service';
import { ReportExportController } from './report-export.controller';
import { ReportExportService } from './report-export.service';
import { ReconciliationService } from './reconciliation.service';
import { StakeholderAnalyticsController } from './stakeholder-analytics.controller';
import { StakeholderAnalyticsService } from './stakeholder-analytics.service';

@Module({
  controllers: [
    KioskController,
    LogInspectionController,
    ReportExportController,
    StakeholderAnalyticsController,
  ],
  providers: [
    KioskService,
    ImgbbService,
    LogInspectionService,
    ReportExportService,
    ReconciliationService,
    StakeholderAnalyticsService,
  ],
  exports: [
    ReportExportService,
    ReconciliationService,
    StakeholderAnalyticsService,
  ],
})
export class KioskModule {}
