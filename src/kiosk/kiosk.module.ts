import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { ImgbbService } from './imgbb.service';
import { LogInspectionController } from './log-inspection.controller';
import { LogInspectionService } from './log-inspection.service';
import { ReportExportController } from './report-export.controller';
import { ReportExportService } from './report-export.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [
    KioskController,
    LogInspectionController,
    ReportExportController,
  ],
  providers: [
    KioskService,
    ImgbbService,
    LogInspectionService,
    ReportExportService,
    PrismaService,
  ],
  exports: [ReportExportService],
})
export class KioskModule {}
