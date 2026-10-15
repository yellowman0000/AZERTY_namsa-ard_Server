import { Controller, Get } from '@nestjs/common';
import { KioskService } from './kiosk.service';

@Controller('kiosk')
export class KioskController {
  constructor(private readonly kioskService: KioskService) {}

  @Get('status')
  getStatus() {
    return { state: this.kioskService.getConnectionState() };
  }
}
