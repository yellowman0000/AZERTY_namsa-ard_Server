import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from './google-sheets.module';
import { GoogleSheetsSyncScheduler } from './google-sheets-sync.scheduler';

@Module({
  imports: [GoogleSheetsModule],
  providers: [GoogleSheetsSyncScheduler],
  exports: [GoogleSheetsSyncScheduler],
})
export class GoogleSheetsSyncModule {}
