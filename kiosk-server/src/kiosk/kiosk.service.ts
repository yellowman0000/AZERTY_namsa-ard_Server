import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export type ConnectionState = 'connected' | 'dropped';

@Injectable()
export class KioskService {
  private readonly logger = new Logger(KioskService.name);

  private readonly timeoutMs = 5000;
  private readonly retryDelaysMs = [2000, 4000, 8000];

  private connectionState: ConnectionState = 'connected';

  constructor(private prisma: PrismaService) {}

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

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

  /**
   * HTTP request with a 5s timeout. On failure, retries after 2s, 4s, 8s.
   * If every retry fails, the connection is marked as dropped and the
   * last error is thrown.
   */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        const res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // Don't retry client errors (4xx); they won't fix themselves.
        if (res.status >= 500) {
          throw new Error(`Server responded with HTTP ${res.status}`);
        }

        this.connectionState = 'connected';
        return res;
      } catch (err) {
        lastError = err;

        if (attempt < this.retryDelaysMs.length) {
          const delay = this.retryDelaysMs[attempt];
          this.logger.warn(
            `Request to ${url} failed (attempt ${attempt + 1}): ${
              (err as Error).message
            }. Retrying in ${delay / 1000}s`,
          );
          await this.sleep(delay);
        }
      }
    }

    this.connectionState = 'dropped';
    this.logger.error(`Connection dropped after retries: ${url}`);
    throw lastError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}