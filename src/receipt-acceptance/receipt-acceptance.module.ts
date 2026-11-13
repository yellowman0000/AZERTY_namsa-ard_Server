import { Module } from '@nestjs/common';
import { GoogleSheetsSyncModule } from '../google-sheets/google-sheets-sync.module';
import { ReceiptAcceptanceController } from './receipt-acceptance.controller';
import { ReceiptAcceptanceService } from './receipt-acceptance.service';

@Module({
  imports: [GoogleSheetsSyncModule],
  controllers: [ReceiptAcceptanceController],
  providers: [ReceiptAcceptanceService],
})
export class ReceiptAcceptanceModule {}
