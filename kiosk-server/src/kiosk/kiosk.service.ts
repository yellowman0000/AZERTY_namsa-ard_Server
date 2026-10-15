import { Injectable, Logger } from '@nestjs/common';

export type ConnectionState = 'connected' | 'dropped';

@Injectable()
export class KioskService {
  private readonly logger = new Logger(KioskService.name);

  private readonly timeoutMs = 5000;
  private readonly retryDelaysMs = [2000, 4000, 8000];

  private connectionState: ConnectionState = 'connected';

  getConnectionState(): ConnectionState {
    return this.connectionState;
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