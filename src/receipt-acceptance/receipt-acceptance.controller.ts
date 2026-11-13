import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AcceptReceiptDto } from './accept-receipt.dto';
import { ReceiptAcceptanceService } from './receipt-acceptance.service';

@Controller(['api/kiosk', 'kiosk', 'api', ''])
export class ReceiptAcceptanceController {
  constructor(private readonly acceptance: ReceiptAcceptanceService) {}

  // POST /api/kiosk/logs/:id/accept   body (optional): { managerId }
  // Manager accepts an operator receipt; the log is written to Google Sheets.
  @Post('logs/:id/accept')
  @HttpCode(HttpStatus.OK)
  async accept(@Param('id') id: string, @Body() dto?: AcceptReceiptDto) {
    return this.acceptance.accept(id, dto?.managerId);
  }
}
