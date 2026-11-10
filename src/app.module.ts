import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { KioskModule } from './kiosk/kiosk.module';
import { GoogleSheetsModule } from './google-sheets/google-sheets.module';
import { ScheduleModule } from '@nestjs/schedule';
import { GoogleSheetsSyncModule } from './google-sheets/google-sheets-sync.module';
import { PrismaModule } from './prisma.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    KioskModule,
    GoogleSheetsModule,
    GoogleSheetsSyncModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
