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
| POST   | `/api/kiosk/logs`        | Ingest daily meter log (duplicate `transactionId` → 409) |

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

## Scripts

| Command              | Description                  |
| -------------------- | ---------------------------- |
| `bun run start:dev`  | Run in watch mode            |
| `bun run start`      | Run once                     |
| `bun run build`      | Compile to `dist/`           |
| `bun run start:prod` | Run compiled build           |
| `bun run test`       | Unit tests                   |
| `bun run test:e2e`   | End-to-end tests             |
| `bun run test:cov`   | Test coverage                |
| `bun run lint`       | Lint with oxlint             |
| `bunx prisma studio` | Browse the database in a GUI |
