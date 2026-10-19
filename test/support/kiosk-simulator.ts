import * as http from 'http';
import { createHash, randomUUID } from 'crypto';

// ───────────────────────────────────────────────────────────
//  Story 14-3 – Simulated kiosk client (reference implementation)
//
//  Stands in for the browser kiosk while Story 14-1 (offline cache UI)
//  is still being built. It follows the Sprint 1 data contract exactly,
//  so the end-to-end test exercises the same behaviour the real client
//  must have:
//
//   • 14-1  records submitted while offline go to `offline_tx_queue`
//           (FIFO, persisted in a localStorage-like store)
//   • 14-2  each cached record carries a v1 SHA-256 `checksum`;
//           HTTP 422 ⇒ record moves to `quarantine_queue`
//   • 14-3  `online` event ⇒ confirm with POST /api/kiosk/heartbeat ⇒
//           sequential dispatcher pushes each record to POST /api/kiosk/logs;
//           a record leaves the queue ONLY on server ACK (200/201, or 409
//           "already exists" = idempotent duplicate ACK)
//
//  When the real 14-1 queue is ready, pass it in through the
//  `OfflineQueueAdapter` option to run the same test against it.
// ───────────────────────────────────────────────────────────

export const QUEUE_KEY = 'offline_tx_queue';
export const QUARANTINE_KEY = 'quarantine_queue';

/** Record shape stored in `offline_tx_queue` (snake_case, as in the client). */
export interface CachedTransaction {
  transaction_id: string;
  kiosk_id: string;
  meter_volume: number;
  recorded_at: string;
  checksum: string;
  checksum_version: 'v1';
  cached_at: string;
  quarantine_reason?: string;
}

/** Subset of the Web Storage API (window.localStorage satisfies it). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory localStorage. Share one instance between simulators to mimic a page reload. */
export class MemoryStorage implements KeyValueStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** Contract the 14-1 offline queue must satisfy for the dispatcher. */
export interface OfflineQueueAdapter {
  enqueue(item: CachedTransaction): boolean;
  peekAll(): CachedTransaction[];
  remove(transactionId: string): boolean;
  size(): number;
}

/** FIFO queue persisted as a JSON array under one storage key. */
export class StorageBackedQueue implements OfflineQueueAdapter {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string = QUEUE_KEY,
  ) {}

  private read(): CachedTransaction[] {
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(this.key) ?? '[]');
      return Array.isArray(parsed) ? (parsed as CachedTransaction[]) : [];
    } catch {
      return [];
    }
  }

  private write(items: CachedTransaction[]): void {
    this.storage.setItem(this.key, JSON.stringify(items));
  }

  enqueue(item: CachedTransaction): boolean {
    const items = this.read();
    if (items.some((i) => i.transaction_id === item.transaction_id)) return false;
    items.push(item);
    this.write(items);
    return true;
  }

  peekAll(): CachedTransaction[] {
    return this.read();
  }

  remove(transactionId: string): boolean {
    const items = this.read();
    const rest = items.filter((i) => i.transaction_id !== transactionId);
    if (rest.length === items.length) return false;
    this.write(rest);
    return true;
  }

  size(): number {
    return this.read().length;
  }

  /** Test helper: overwrite raw storage (e.g. to tamper with a record). */
  replaceAll(items: CachedTransaction[]): void {
    this.write(items);
  }
}

/** v1 canonical checksum – same algorithm as client `checksum.ts` / server `checksum-validator.ts`. */
export function computeV1Checksum(
  r: Pick<CachedTransaction, 'transaction_id' | 'kiosk_id' | 'meter_volume' | 'recorded_at'>,
): string {
  const canonical =
    `v1|kiosk:${r.kiosk_id.trim()}` +
    `|meter:${Number(r.meter_volume).toFixed(4)}` +
    `|recorded:${new Date(r.recorded_at).toISOString()}` +
    `|txn:${r.transaction_id.trim()}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/* ───────────── tiny HTTP client (one fresh connection per request) ───────────── */

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

class NetworkError extends Error {}

function postJson(
  url: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', (e) => reject(new NetworkError(e.message)));
      },
    );
    req.on('timeout', () => req.destroy(new NetworkError(`timeout after ${timeoutMs}ms`)));
    req.on('error', (e) => reject(new NetworkError(e.message)));
    req.end(data);
  });
}

/* ───────────── the simulator ───────────── */

export type ConnectionState = 'online' | 'offline' | 'verifying';

export interface SyncEvent {
  type:
    | 'queued'
    | 'sent-online'
    | 'browser-online'
    | 'browser-offline'
    | 'heartbeat-ok'
    | 'heartbeat-failed'
    | 'ack'
    | 'duplicate-ack'
    | 'quarantined'
    | 'retry'
    | 'queue-empty';
  transactionId?: string;
  detail?: string;
  at: number;
}

export interface KioskSimulatorOptions {
  baseUrl: string;
  kioskId: string;
  /** Shared storage = "same browser". Re-use it to simulate a page reload. */
  storage?: KeyValueStorage;
  /** Plug the real 14-1 queue in here. Defaults to a localStorage-backed FIFO. */
  queue?: OfflineQueueAdapter;
  /** Per-request timeout (client spec: 5 s). */
  requestTimeoutMs?: number;
  /** Delay between heartbeat confirmation attempts after `online`. */
  heartbeatRetryDelayMs?: number;
  /** Backoff between retries of the same record; the last value is reused. */
  retryDelaysMs?: number[];
  /** Optional console narration (used by the demo script). */
  log?: (message: string) => void;
}

export class KioskSimulator {
  readonly kioskId: string;
  readonly storage: KeyValueStorage;
  readonly queue: OfflineQueueAdapter;
  readonly quarantine: StorageBackedQueue;
  readonly events: SyncEvent[] = [];

  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatRetryDelayMs: number;
  private readonly retryDelaysMs: number[];
  private readonly log: (m: string) => void;

  /** Mirrors `navigator.onLine`. */
  private browserOnline = true;
  private state: ConnectionState = 'online';
  private session: AbortController | null = null;
  private syncLoop: Promise<void> | null = null;
  private lastRecordedAt = 0;
  private disposed = false;

  constructor(opts: KioskSimulatorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.kioskId = opts.kioskId;
    this.storage = opts.storage ?? new MemoryStorage();
    this.queue = opts.queue ?? new StorageBackedQueue(this.storage, QUEUE_KEY);
    this.quarantine = new StorageBackedQueue(this.storage, QUARANTINE_KEY);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.heartbeatRetryDelayMs = opts.heartbeatRetryDelayMs ?? 3000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [2000, 4000, 8000];
    this.log = opts.log ?? (() => undefined);
  }

  /* ───────────── observability ───────────── */

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** "Pending Queue Items" counter shown in the UI. */
  get pendingCount(): number {
    return this.queue.size();
  }

  get isSyncing(): boolean {
    return this.syncLoop !== null;
  }

  private emit(type: SyncEvent['type'], transactionId?: string, detail?: string): void {
    this.events.push({ type, transactionId, detail, at: Date.now() });
    const id = transactionId ? ` ${transactionId.slice(0, 8)}…` : '';
    this.log(`[kiosk ${this.kioskId}] ${type}${id}${detail ? ` – ${detail}` : ''}`);
  }

  /* ───────────── Story 01 – heartbeat ───────────── */

  async heartbeat(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await postJson(
        `${this.baseUrl}/api/kiosk/heartbeat`,
        { kioskId: this.kioskId, kiosk_id: this.kioskId, client_timestamp: new Date().toISOString() },
        this.requestTimeoutMs,
        signal,
      );
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /* ───────────── Story 14-1 – operator submits a reading ───────────── */

  /** Builds a record with a strictly increasing `recorded_at` and v1 checksum. */
  createRecord(meterVolume: number): CachedTransaction {
    const ts = Math.max(Date.now(), this.lastRecordedAt + 1);
    this.lastRecordedAt = ts;
    const base = {
      transaction_id: randomUUID(),
      kiosk_id: this.kioskId,
      meter_volume: meterVolume,
      recorded_at: new Date(ts).toISOString(),
    };
    return {
      ...base,
      checksum: computeV1Checksum(base),
      checksum_version: 'v1',
      cached_at: new Date().toISOString(),
    };
  }

  /**
   * Operator presses "Submit". Online ⇒ send directly; offline or network
   * failure ⇒ cache in `offline_tx_queue` so nothing is lost.
   */
  async submitReading(
    meterVolume: number,
  ): Promise<{ via: 'server' | 'queue' | 'rejected'; record: CachedTransaction }> {
    const record = this.createRecord(meterVolume);

    // Keep FIFO: if older records are still waiting, new ones must queue behind them.
    if (this.browserOnline && this.state === 'online' && this.queue.size() === 0) {
      try {
        const res = await this.send(record, this.session?.signal);
        if (res.status === 200 || res.status === 201) {
          this.emit('sent-online', record.transaction_id);
          return { via: 'server', record };
        }
        if (res.status < 500) {
          this.emit('quarantined', record.transaction_id, `HTTP ${res.status}`);
          return { via: 'rejected', record };
        }
      } catch {
        /* network failure → fall through to the offline queue */
      }
    }

    this.queue.enqueue(record);
    this.emit('queued', record.transaction_id, `pending=${this.queue.size()}`);
    if (this.browserOnline && !this.syncLoop) this.startReconnect();
    return { via: 'queue', record };
  }

  /* ───────────── Story 14-3 – network listener ───────────── */

  /** Equivalent of `window.dispatchEvent(new Event('offline'))`. */
  goOffline(): void {
    this.browserOnline = false;
    this.state = 'offline';
    this.session?.abort();
    this.session = null;
    this.emit('browser-offline');
  }

  /**
   * Equivalent of `window.dispatchEvent(new Event('online'))`.
   * Returns immediately – syncing happens in the background, like in the browser.
   */
  goOnline(): void {
    this.browserOnline = true;
    this.emit('browser-online');
    this.startReconnect();
  }

  /** Simulates a page load: if the browser is online and the queue has items, sync. */
  boot(): void {
    if (this.browserOnline && this.queue.size() > 0) this.startReconnect();
  }

  private startReconnect(): void {
    if (this.disposed || this.syncLoop) return;
    const session = new AbortController();
    this.session = session;
    this.syncLoop = this.reconnectAndFlush(session.signal).finally(() => {
      this.syncLoop = null;
      // `online` fired again, or new records arrived, while we were finishing up.
      if (this.browserOnline && this.queue.size() > 0) this.startReconnect();
    });
  }

  private async reconnectAndFlush(signal: AbortSignal): Promise<void> {
    // 1. `online` alone is not trusted – confirm with a heartbeat (captive portal, dead SIM data…)
    this.state = 'verifying';
    while (!signal.aborted) {
      if (await this.heartbeat(signal)) break;
      this.emit('heartbeat-failed');
      await this.sleep(this.heartbeatRetryDelayMs, signal);
    }
    if (signal.aborted) return;
    this.state = 'online';
    this.emit('heartbeat-ok');

    // 2. Sequential dispatcher – one record at a time, oldest first.
    let attempt = 0;
    while (!signal.aborted) {
      const head = this.queue.peekAll()[0];
      if (!head) {
        this.emit('queue-empty');
        return;
      }

      let outcome: 'ack' | 'duplicate' | 'quarantine' | 'retry';
      let detail = '';
      try {
        const res = await this.send(head, signal);
        if (res.status === 200 || res.status === 201) {
          outcome = 'ack';
        } else if (res.status === 409 && res.body.error !== 'STATE_CONFLICT') {
          outcome = 'duplicate'; // server already has it → safe ACK
        } else if (res.status >= 400 && res.status < 500) {
          outcome = 'quarantine';
          const errMsg =
            typeof res.body.error === 'string'
              ? res.body.error
              : typeof res.body.message === 'string'
                ? res.body.message
                : '';
          detail = `HTTP ${res.status}${errMsg ? ` ${errMsg}` : ''}`;
        } else {
          outcome = 'retry';
          detail = `HTTP ${res.status}`;
        }
      } catch (e) {
        outcome = 'retry';
        detail = (e as Error).message;
      }

      if (signal.aborted) return; // went offline mid-request – keep the record

      switch (outcome) {
        case 'ack':
          this.queue.remove(head.transaction_id);
          attempt = 0;
          this.emit('ack', head.transaction_id, `pending=${this.queue.size()}`);
          break;
        case 'duplicate':
          this.queue.remove(head.transaction_id);
          attempt = 0;
          this.emit('duplicate-ack', head.transaction_id, `pending=${this.queue.size()}`);
          break;
        case 'quarantine':
          this.quarantine.enqueue({ ...head, quarantine_reason: detail });
          this.queue.remove(head.transaction_id);
          attempt = 0;
          this.emit('quarantined', head.transaction_id, detail);
          break;
        case 'retry': {
          const delay =
            this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)];
          attempt++;
          this.emit('retry', head.transaction_id, `${detail}; next try in ${delay}ms`);
          await this.sleep(delay, signal);
          break;
        }
      }
    }
  }

  private send(record: CachedTransaction, signal?: AbortSignal): Promise<HttpResult> {
    // Same body shape as the real client (`api.ts`): camelCase for the DTO + snake_case.
    return postJson(
      `${this.baseUrl}/api/kiosk/logs`,
      {
        transactionId: record.transaction_id,
        kioskId: record.kiosk_id,
        meterVolume: record.meter_volume,
        recordedAt: record.recorded_at,
        checksum: record.checksum,
        transaction_id: record.transaction_id,
        kiosk_id: record.kiosk_id,
        meter_volume: record.meter_volume,
        recorded_at: record.recorded_at,
        checksum_version: record.checksum_version,
      },
      this.requestTimeoutMs,
      signal,
    );
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done);
    });
  }

  /* ───────────── test helpers ───────────── */

  /**
   * Resolves once the queue is empty and the dispatcher is idle.
   * Rejects after `timeoutMs` with a diagnostic message.
   */
  async waitUntilSynced(timeoutMs: number): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.queue.size() === 0 && !this.syncLoop) return Date.now() - start;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `Queue not synced within ${timeoutMs}ms: pending=${this.queue.size()}, ` +
        `state=${this.state}, last events=${JSON.stringify(this.events.slice(-5))}`,
    );
  }

  /** Stops background work (call in afterEach). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.session?.abort();
    await this.syncLoop;
  }
}
