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

# 5. Run the server (watch mode)
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

## API

All routes are also available under the legacy `/kiosk/*` alias and direct root aliases.

| Method | Path                                                  | Description                                   |
| ------ | ----------------------------------------------------- | --------------------------------------------- |
| POST   | `/api/kiosk/heartbeat`                                | Kiosk heartbeat — body `{ "kioskId": "KIOSK-001" }` |
| GET    | `/api/kiosk/status/:id`                               | Get kiosk status (`ONLINE` / `OFFLINE`)       |
| POST   | `/api/kiosk/logs`<br>*(or `/daily-submission`)*       | Ingest daily log / meter volume & cash submission — returns server ACK with signed tamper-evident receipt |
| POST   | `/api/kiosk/logs/:transactionId/evidence`              | Upload one JPEG, PNG, or WebP evidence photo (max 5 MB); returns `proofImageUrl` |
| GET    | `/api/kiosk/logs/:transactionId/evidence/:fileName`   | Retrieve an uploaded evidence photo through the server |
| GET    | `/api/kiosk/logs?kioskId=&cursor=&limit=`             | Read-only log history, newest first — `{ "data": [...], "nextCursor": "<logId>" \| null }` (`limit` 1–100, default 20) |
| GET    | `/api/kiosk/logs/:id/inspect`                         | Read-only log details with live checksum verification (see below) |

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
  "proofImageUrl": "/api/kiosk/logs/TX-0001/evidence/<sha256>.jpg",
  "checksum": "optional-sha256"
}
```

`readingType` accepts `DAILY_VOLUME` (may change independently each day) and
`CUMULATIVE_METER` (must remain monotonic). Omitted values default to
`CUMULATIVE_METER` for older clients. Evidence uploads are stored as bytes in
the PostgreSQL `evidence_photos` table, using the same `DATABASE_URL` as the
rest of the server. After pulling this change, sync the database schema with
`bunx prisma db push` before starting the server. Images are limited to 5 MB
and served through the API using the stable URL stored in `proofImageUrl`.

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

## Scripts

| Command              | Description                  |
| -------------------- | ---------------------------- |
| `bun run start:dev`  | Run in watch mode            |
| `bun run start`      | Run once                     |
| `bun run build`      | Compile to `dist/`           |
| `bun run start:prod` | Run compiled build           |
| `bun run test`       | Unit tests                   |
| `bun run test:sync`  | Story 14-3 E2E sync verification under unstable network |
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
