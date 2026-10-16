import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class KioskService {
  constructor(private prisma: PrismaService) {}

  // Receive Heartbeat from client and update status to ONLINE
  async handleHeartbeat(kioskId: string) {
    const now = new Date();

    const kiosk = await this.prisma.kiosk.upsert({
      where: { id: kioskId },
      update: {
        status: 'ONLINE',
        lastHeartbeat: now,
      },
      create: {
        id: kioskId,
        status: 'ONLINE',
        lastHeartbeat: now,
      },
    });

    return {
      success: true,
      kioskId: kiosk.id,
      status: kiosk.status,
      timestamp: kiosk.lastHeartbeat,
    };
  }

  // Check Kiosk status (If disconnected 30 sec, update status to OFFLINE)
  async getKioskStatus(kioskId: string) {
    const kiosk = await this.prisma.kiosk.findUnique({
      where: { id: kioskId },
    });

    if (!kiosk || !kiosk.lastHeartbeat) {
      return { kioskId, status: 'OFFLINE', lastHeartbeat: null };
    }

    const diffSeconds = (Date.now() - kiosk.lastHeartbeat.getTime()) / 1000;
    const currentStatus = diffSeconds > 30 ? 'OFFLINE' : 'ONLINE';

    // If disconnected 30 sec, update status to OFFLINE
    if (currentStatus === 'OFFLINE' && kiosk.status !== 'OFFLINE') {
      await this.prisma.kiosk.update({
        where: { id: kioskId },
        data: { status: 'OFFLINE' },
      });
    }

    return {
      kioskId: kiosk.id,
      status: currentStatus,
      lastHeartbeat: kiosk.lastHeartbeat,
      secondsSinceLastPing: Math.round(diffSeconds),
    };
  }
}