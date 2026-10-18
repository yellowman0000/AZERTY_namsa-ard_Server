import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { KioskService } from './kiosk.service';
import { IngestLogDto } from './dto/ingest-log.dto';

@Controller(['api/kiosk', 'kiosk'])
export class KioskController {
  constructor(private readonly kioskService: KioskService) {}

  // ───────────────────────────────────────────────────────────
  //  Story 02 – Ingest daily-log / meter-volume
  //  POST /api/kiosk/logs
  // ───────────────────────────────────────────────────────────

  @Post('logs')
  async ingestLog(@Body() dto: IngestLogDto) {
    return this.kioskService.ingestLog(dto);
  }

  // ───────────────────────────────────────────────────────────
  //  Existing endpoints
  // ───────────────────────────────────────────────────────────


  // POST http://localhost:3001/api/kiosk/heartbeat
  // for Ball to send Heartbeat to Server
  @Post('heartbeat')
  async receiveHeartbeat(@Body('kioskId') kioskId: string) {
    return this.kioskService.handleHeartbeat(kioskId || 'KIOSK-001');
  }

  // GET http://localhost:3001/api/kiosk/status/KIOSK-001
  // for check kiosk status or Earn to send the test
  @Get('status/:id')
  async checkStatus(@Param('id') id: string) {
    return this.kioskService.getKioskStatus(id);
  }
}
