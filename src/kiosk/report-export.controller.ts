import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ExportReportQueryDto } from './dto/export-report.dto';
import { ReportExportService } from './report-export.service';

// ───────────────────────────────────────────────────────────
//  Story 07 – Generate E-Reports (CSV / PDF) for Operation Managers
//  GET /api/kiosk/reports/export?format=csv|pdf&startDate=...&endDate=...
// ───────────────────────────────────────────────────────────

@Controller(['api/kiosk', 'kiosk', 'api', ''])
export class ReportExportController {
  constructor(private readonly reportExportService: ReportExportService) {}

  @Get(['reports/export', 'report/export'])
  async exportReport(
    @Query() query: ExportReportQueryDto,
    @Res() res: Response,
  ) {
    const { buffer, contentType, filename } =
      await this.reportExportService.generateReport(query);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }
}
