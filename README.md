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

| Variable        | Default                 | Description                                   |
| --------------- | ----------------------- | --------------------------------------------- |
| `PORT`          | `3001`                  | HTTP port                                     |
| `DATABASE_URL`  | —                       | PostgreSQL connection string (see `.env.example`) |
| `CLIENT_ORIGIN` | `http://localhost:3000` | Allowed CORS origin(s), comma-separated       |

## API

All routes are also available under the legacy `/kiosk/*` alias.

| Method | Path                     | Description                                   |
| ------ | ------------------------ | --------------------------------------------- |
| POST   | `/api/kiosk/heartbeat`   | Kiosk heartbeat — body `{ "kioskId": "KIOSK-001" }` |
| GET    | `/api/kiosk/status/:id`  | Get kiosk status (`ONLINE` / `OFFLINE`)       |
| POST   | `/api/kiosk/logs`        | Ingest daily meter log — answers with a server ACK (see below) |

`POST /api/kiosk/logs` body:

```json
{
  "transactionId": "TX-0001",
  "kioskId": "KIOSK-001",
  "meterVolume": 12.5,
  "recordedAt": "2026-10-18T09:00:00.000Z",
  "checksum": "optional-sha256"
}
```

Responses (Story 14-3 – server ACK confirmation). The kiosk marks a local record
**Synchronized** only on a 200/201 whose body has `"ack": true` for that `transactionId`:

| Status | When | Body |
| ------ | ---- | ---- |
| `201`  | New record stored | `{ "ack": true, "status": "SYNCHRONIZED", "duplicate": false, "logId", "transactionId", "createdAt", … }` |
| `200`  | Identical retry of a stored record (e.g. its first ACK was lost) | same ACK, `"duplicate": true` |
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

## End-to-End Offline Sync Testing (Story 14-3)

The test suite in [`test/offline-sync.e2e-spec.ts`](file:///home/project/Coding/AZERTY_namsa-ard/AZERTY_namsa-ard_Server/test/offline-sync.e2e-spec.ts) verifies offline data accumulation and automatic synchronization under unstable network conditions as required by **Priority 5 — ID 14-3**.

### Architecture Under Test

A fault-injecting proxy ([`NetworkSimulator`](file:///home/project/Coding/AZERTY_namsa-ard/AZERTY_namsa-ard_Server/test/support/network-simulator.ts)) sits between the kiosk client ([`KioskSimulator`](file:///home/project/Coding/AZERTY_namsa-ard/AZERTY_namsa-ard_Server/test/support/kiosk-simulator.ts)) and the real NestJS API server backed by PostgreSQL:

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
