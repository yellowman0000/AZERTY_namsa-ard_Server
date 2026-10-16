import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [KioskController],
  providers: [KioskService, PrismaService]
})
export class KioskModule {}
