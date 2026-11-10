# AZERTY_namsa-ard_Server

Kiosk backend for Namsa-ard — receives heartbeats and daily meter logs from kiosks.

**Stack:** NestJS · Prisma · PostgreSQL (Docker)

## Prerequisites

- [Bun](https://bun.sh) (or Node.js + npm)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — must be running

## Getting started

```bash
# 1. Install dependencies (also generates the Prisma client)
bun install

# 2. Create your local env file
cp .env.example .env

# 3. Start PostgreSQL
docker compose up -d

# 4. Create / sync database tables
bunx prisma db push

# 5. Regenerate Prisma Client after schema changes
bunx prisma generate

# 6. Run the server (watch mode)
bun run start:dev
```

Server runs on `http://localhost:3001` by default.

> If you get `Property 'kiosk' does not exist on type 'PrismaService'`, run `bunx prisma generate`.

## Environment variables

| Variable              | Default                               | Description                                   |
| --------------------- | ------------------------------------- | --------------------------------------------- |
| `PORT`                | `3001`                                | HTTP port                                     |
| `DATABASE_URL`        | —                                     | PostgreSQL connection string (see `.env.example`) |
| `CLIENT_ORIGIN`       | `http://localhost:3000`               | Allowed CORS origin(s), comma-separated       |
| `RECEIPT_SIGNING_KEY` | `namsa-ard-kiosk-receipt-secret-key`  | HMAC-SHA256 secret for signed receipts        |
| `WATER_UNIT_PRICE_PER_LITER` | `2`                             | KES per litre — `expectedRevenue = meterVolume × unitPrice` (Story ID 04) |
| `ANOMALY_BASELINE_WINDOW` | `7`                               | Previous daily records in the moving-average baseline (7 or 30) |
| `RECONCILIATION_BATCH_ENABLED` | `false`                      | Run the reconciliation batch in-process daily at 00:15 UTC |

## Scheduled Google Sheets synchronization

When Google Sheets credentials are configured, a NestJS cron job checks every
minute for daily logs that are not synced and have been marked as read by a
manager (`isReadByManager=true`). Successful appends mark those rows as synced.
HTTP 429 and transient server/network failures are saved in
`sync_retry_queue` and retried with exponential backoff (one minute initially,
capped at 24 hours). Each failed attempt is recorded in `system_audit_logs`;
permanent failures remain in the queue with status `FAILED` and are not retried
automatically. Logs are not sent when the Sheets integration is disabled.

Set the `GOOGLE_SHEETS_*` and service-account variables shown in `.env.example`
to enable the integration. Keep credentials in a secret manager or local
environment file; never commit service-account private keys.

## API

All routes are also available under the legacy `/kiosk/*` alias and direct root aliases.

| Method | Path                                                  | Description                                   |
| ------ | ----------------------------------------------------- | --------------------------------------------- |
| POST   | `/api/kiosk/heartbeat`                                | Kiosk heartbeat — body `{ "kioskId": "KIOSK-001" }` |
| GET    | `/api/kiosk/status/:id`                               | Get kiosk status (`ONLINE` / `OFFLINE`)       |
| POST   | `/api/kiosk/logs`<br>*(or `/daily-submission`)*       | Ingest daily log / meter volume & cash submission — returns server ACK with signed tamper-evident receipt |
| POST   | `/api/kiosk/logs/:transactionId/evidence`              | Upload one JPEG, PNG, or WebP evidence photo (max 5 MB) to imgBB; returns `proofImageUrl` |
| GET    | `/api/kiosk/logs?kioskId=&cursor=&limit=`             | Read-only log history, newest first — `{ "data": [...], "nextCursor": "<logId>" \| null }` (`limit` 1–100, default 20) |
| GET    | `/api/kiosk/logs/:id/inspect`                         | Read-only log details with live checksum verification (see below) |
| GET    | `/api/kiosk/reconciliation?kioskId=&isAnomaly=&startDate=&endDate=` | Interpreted daily logs: revenue metrics, variance ratios, and ±30 % volume-anomaly flags (see below) |
| POST   | `/api/kiosk/reconciliation/run`                       | Run the daily batch reconciliation engine — recomputes and persists expected revenue, variance and anomaly flags; returns a summary |

`GET /api/kiosk/logs/:id/inspect` recomputes the SHA-256 checksum from the
row's **current** database values and compares it with the checksum stored at
submission, so a row edited after submission is flagged:

| `verification.status` | Meaning |
| --------------------- | ------- |
| `VERIFIED`            | Stored row matches its submission checksum (badge: *Verified (Tamper-Evident)*) |
| `CHECKSUM_MISMATCH`   | Row changed since submission (badge: *Checksum Mismatch*) |
| `NO_CHECKSUM`         | Log was submitted without a checksum, so it can't be verified |

The response also carries `storedChecksum`, `recomputedChecksum`, the matched
`format` (`v1`, `legacy` or `receipt`) and `verifiedAt`.

`POST /api/kiosk/logs` (or `/daily-submission`) body:

```json
{
  "transactionId": "TX-0001",
  "kioskId": "KIOSK-001",
  "operatorId": "OP-001",
  "meterVolume": 12.5,
  "reportedCash": 250.0,
  "readingType": "DAILY_VOLUME",
  "recordedAt": "2026-10-18T09:00:00.000Z",
  "proofImageUrl": "https://i.ibb.co/abcd1234/meter.jpg",
  "checksum": "optional-sha256"
}
```

`readingType` accepts `DAILY_VOLUME` (may change independently each day) and
`CUMULATIVE_METER` (must remain monotonic). Omitted values default to
`CUMULATIVE_METER` for older clients.

Evidence photos are hosted by [imgBB](https://api.imgbb.com/). The upload route
validates the image (JPEG, PNG, or WebP, 5 MB max), forwards the bytes to imgBB
using `IMGBB_API_KEY`, and returns the public CDN URL as `proofImageUrl`; only
that URL is stored in the designed `DailyLog.proofImageUrl` column. Photos never
enter PostgreSQL, so no schema push is required. When `IMGBB_API_KEY` is empty
the upload route answers `503` and the operator client keeps the entry queued.

Receipt payload computed on the server:
- **Checksum:** `SHA-256(kioskId + operatorId + meterVolume + reportedCash + recordedAt)`
- **Signature:** `HMAC-SHA256(checksum, RECEIPT_SIGNING_KEY)`

Responses (Story 14-3 – server ACK confirmation). The kiosk marks a local record
**Synchronized** only on a 200/201 whose body has `"ack": true` for that `transactionId`:

| Status | When | Body |
| ------ | ---- | ---- |
| `201`  | New record stored | `{ "ack": true, "status": "SYNCHRONIZED", "duplicate": false, "logId", "transactionId", "receipt": { "receiptId", "checksum", "signature", … }, … }` |
| `200`  | Identical retry of a stored record (e.g. its first ACK was lost) | same ACK and receipt, `"duplicate": true` |
| `409`  | `transactionId` already stored with a different reading | `{ "ack": false, "error": "DUPLICATE_TRANSACTION" }` |
| `409`  | Reading conflicts with newer/older server state | `{ "ack": false, "error": "STATE_CONFLICT" }` |
| `422`  | Checksum mismatch | `{ "ack": false, "error": "CORRUPTED_PAYLOAD" }` |

## Daily Reconciliation & Volume Anomaly Detection (Story ID 04)

Every daily log is interpreted with these server-side business rules:

```
Expected Revenue      = Meter Volume × Unit Price     (default 2 KES/L)
Variance              = Reported Cash − Expected Revenue
Discrepancy Ratio (%) = (Variance ÷ Expected Revenue) × 100
movingAvg             = mean(previous 7 daily volumes of the same kiosk)
isAnomaly             = |currentVolume − movingAvg| > 0.30 × movingAvg
```

A deviation of **exactly ±30.0 %** is *not* flagged (strict `>`); **±30.1 %** is.
Records without history are never flagged (`INSUFFICIENT_BASELINE`); a zero baseline
uses the literal `|current| > 0` rule.

Ingestion (`POST /api/kiosk/logs`) computes `expectedRevenue`/`variance` immediately
from the shared unit price (client-supplied values are ignored) so the receipt matches
the Sprint 2 contract: `500 L, 950 cash → expected 1000, variance −50`. The volume
anomaly flag `isAnomaly` is classified by the **daily batch engine** and starts `false`
on a fresh submission until the next batch run.

### Run the batch

```bash
# Reconcile everything (daily cron equivalent)
curl -X POST http://localhost:3001/api/kiosk/reconciliation/run \
  -H 'Content-Type: application/json' -d '{}'

# Reconcile one kiosk for October, preview only (no writes)
curl -X POST http://localhost:3001/api/kiosk/reconciliation/run \
  -H 'Content-Type: application/json' \
  -d '{"kioskId":"KIOSK-001","startDate":"2026-10-01","endDate":"2026-10-31","dryRun":true}'

# Inspect interpreted records, flagged anomalies only
curl 'http://localhost:3001/api/kiosk/reconciliation?kioskId=KIOSK-001&isAnomaly=true'
```

The batch is deterministic and idempotent: only rows whose stored
`expectedRevenue`/`variance`/`isAnomaly` changed are written, and a second identical
run reports `updatedCount: 0`. Enable the built-in 00:15 UTC scheduler with
`RECONCILIATION_BATCH_ENABLED=true`, or call the endpoint from an external cron.

Full design, boundary table and verification evidence:
[`docs/sprint_2_reconciliation_engine.md`](./docs/sprint_2_reconciliation_engine.md).

## Scripts

| Command              | Description                  |
| -------------------- | ---------------------------- |
| `bun run start:dev`  | Run in watch mode            |
| `bun run start`      | Run once                     |
| `bun run build`      | Compile to `dist/`           |
| `bun run start:prod` | Run compiled build           |
| `bun run test`       | Unit tests                   |
| `bun run test:sync`  | Story 14-3 E2E sync verification under unstable network |
| `bun run test:reconciliation` | Story ID 04 reconciliation batch + anomaly API e2e suite |
| `bun run test:e2e`   | All end-to-end tests         |
| `bun run test:cov`   | Test coverage                |
| `bun run lint`       | Lint with oxlint             |
| `bunx prisma studio` | Browse the database in a GUI |

> 📊 **Full Test Results & Sprint 1 Verification Report:** See [`docs/test-results.md`](./docs/test-results.md) for test execution metrics, concurrency load tests, and the live browser demonstration verification guide.

## End-to-End Offline Sync Testing (Story 14-3)

The test suite in [`test/offline-sync.e2e-spec.ts`](test/offline-sync.e2e-spec.ts) verifies offline data accumulation and automatic synchronization under unstable network conditions as required by **Priority 5 — ID 14-3**.

### Architecture Under Test

A fault-injecting proxy ([`NetworkSimulator`](test/support/network-simulator.ts)) sits between the kiosk client ([`KioskSimulator`](test/support/kiosk-simulator.ts)) and the real NestJS API server backed by PostgreSQL:

```text
KioskSimulator (14-1 Queue + 14-2 Checksum)
       │ (HTTP)
       ▼
NetworkSimulator (Proxy: offline, blackhole, packet drop, 503, lost ACKs, jitter)
       │ (HTTP)
       ▼
NestJS Backend Server (`POST /api/kiosk/logs`, `POST /api/kiosk/heartbeat`)
       │ (Prisma)
       ▼
PostgreSQL Database (`kiosks`, `daily_logs`)
```

### How to Run the Tests

1. Ensure the PostgreSQL database container is running and schema is synced:
   ```bash
   docker compose up -d
   bunx prisma db push
   ```

2. Run the offline sync test suite:
   ```bash
   bun run test:sync
   ```

   Or run all E2E test suites:
   ```bash
   bun run test:e2e
   ```

### Scenarios Covered

1. **Sprint 1 Specification DoD Cycle**:
   - `Online` $\rightarrow$ Submit normal reading directly to server.
   - `Offline` $\rightarrow$ Submit 3 consecutive readings; confirmed queued in local `offline_tx_queue` with SHA-256 v1 checksums.
   - `Online` $\rightarrow$ Automatic sequential background sync fires; all 3 records persisted to DB and local queue cleared within 10 seconds.
   - Each ACKed record is moved to `synced_tx_log` with `sync_status: "SYNCHRONIZED"` and its server `logId`; the pending/synced UI counters update per ACK.
2. **Page Reload While Offline**: Records stored in client cache persist across simulated browser restarts and auto-sync immediately upon reconnection.
3. **False `online` Event / Captive Portal**: Verifies dispatcher does not flush until confirmed by a successful `POST /api/kiosk/heartbeat`.
4. **Lost Response / Server ACK Dropped**: Server commits the record, but ACK is lost due to connection severance; kiosk retries, server re-acknowledges with `200` (`"duplicate": true`), kiosk marks it Synchronized without duplicating DB rows.
5. **Flapping Network Connection**: Intermittent online/offline transitions mid-sync; records remain intact and complete sequential sync.
6. **Lossy, High-Latency Link**: Packet drop rates, random 503 errors, and latency jitter; retries succeed with backoff.
7. **Stalled Link (Blackhole)**: Requests hang without immediate error; kiosk request timeout triggers and recovers once link restores.
8. **Story 14-2 Corrupted Payload Isolation**: Tampered cached records are rejected by server (422) and isolated to `quarantine_queue` without blocking valid pending records.
9. **2xx Without ACK (Captive Portal)**: A gateway answers `200` with an HTML page; the kiosk does not mark the record Synchronized and retries until the real server ACK arrives.
10. **Reused `transactionId`**: A cached record reuses a stored `transactionId` with a different reading; the server answers `409 DUPLICATE_TRANSACTION` (`ack: false`) and the kiosk quarantines it instead of marking it Synchronized.
