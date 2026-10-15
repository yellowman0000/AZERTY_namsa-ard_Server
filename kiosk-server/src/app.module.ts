import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { KioskModule } from './kiosk/kiosk.module';

@Module({
  imports: [KioskModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
