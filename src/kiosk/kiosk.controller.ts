import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { KioskService } from './kiosk.service';
import { IngestLogDto } from './dto/ingest-log.dto';

@Controller(['api/kiosk', 'kiosk', 'api'])
export class KioskController {
  constructor(private readonly kioskService: KioskService) {}

  // ───────────────────────────────────────────────────────────
  //  Story 02 – Ingest daily-log / meter-volume
  //  POST /api/kiosk/logs
  //
  //  Story 14-3 – answers with a server ACK (see `sync-ack.ts`):
  //  201 for a new record, 200 when re-acknowledging a stored one.
  // ───────────────────────────────────────────────────────────

  @Post('logs')
  async ingestLog(
    @Body() dto: IngestLogDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ack = await this.kioskService.ingestLog(dto);
    if (ack.duplicate) res.status(HttpStatus.OK);
    return ack;
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
