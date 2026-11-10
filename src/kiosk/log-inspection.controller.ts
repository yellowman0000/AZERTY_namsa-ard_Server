import { Controller, Get, Param, Query } from '@nestjs/common';
import { ArchiveLogsQueryDto } from './dto/archive-logs.dto';
import { ListLogsQueryDto } from './dto/list-logs.dto';
import { LogInspectionService } from './log-inspection.service';

// ───────────────────────────────────────────────────────────
//  Story 05 – Read-only historical log inspection for Operation Managers.
//  Story 08 – Cursor-paginated historical archive.
//  GET only: these routes never change a stored log.
// ───────────────────────────────────────────────────────────

@Controller(['api/kiosk', 'kiosk', 'api', ''])
export class LogInspectionController {
  constructor(private readonly logInspectionService: LogInspectionService) {}

  // GET /api/kiosk/logs?kioskId=KIOSK-001&cursor=<logId>&limit=20
  @Get('logs')
  async listLogs(@Query() query: ListLogsQueryDto) {
    return this.logInspectionService.listLogs(query);
  }

  // GET /api/kiosk/logs/archive?kioskId=KIOSK-001&cursor=<logId>&limit=20
  // Historical archive, newest-first cursor pagination (Story 08).
  @Get('logs/archive')
  async listArchive(@Query() query: ArchiveLogsQueryDto) {
    return this.logInspectionService.listArchive(query);
  }

  // GET /api/kiosk/logs/:id/inspect
  // Returns the log with a live checksum verification result.
  @Get('logs/:id/inspect')
  async inspectLog(@Param('id') id: string) {
    return this.logInspectionService.inspectLog(id);
  }
}
