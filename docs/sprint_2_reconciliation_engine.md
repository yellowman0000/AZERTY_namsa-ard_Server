# Sprint 2 — Data Interpretation Engine (Story ID 04)

**Scope:** `Priority 2 — ID 04: Interpret Data` (13 points)  
**Owner (spec):** Project  
**Backend:** NestJS + Prisma + PostgreSQL (Supabase)  
**Specification:** [`sprint_2_technical_requirements_implementation_specification.md`](../sprint_2_technical_requirements_implementation_specification.md) §Priority 2

This report documents the **daily batch reconciliation engine** (expected revenue vs.
reported cash + variance metrics) and the **moving-average baseline algorithm** that
flags daily volume anomalies beyond **±30 %**.

---

## 1. Deliverables at a glance

| Story task (spec) | Implementation | Tests |
| :--- | :--- | :--- |
| Build daily batch reconciliation engine — expected revenue vs. reported cash and variance metrics | `src/kiosk/reconciliation.ts` (formulas), `src/kiosk/reconciliation.service.ts` (`ReconciliationService.runBatch`), `POST /api/kiosk/reconciliation/run` | `reconciliation.boundary.spec.ts`, `reconciliation.service.spec.ts`, `test/reconciliation.e2e-spec.ts` |
| Moving-average baseline algorithm — flag daily volume anomalies beyond ±30 % | `src/kiosk/volume-anomaly.ts`, executed per record inside `runBatch` | ±29.9 % / ±30.0 % / ±30.1 % boundary cases, zero-baseline & insufficient-baseline cases |
| Persistence of the interpreted values + query endpoint (paired schema task) | `DailyLog.expectedRevenue`, `DailyLog.variance`, `DailyLog.isAnomaly` (existing schema columns) are (re)written by the batch; `GET /api/kiosk/reconciliation` serves them with derived ratios | `test/reconciliation.e2e-spec.ts` |

Request ingestion (`POST /api/kiosk/logs`) now also computes the revenue metrics
server-side with the same shared formulas, so the ACK receipt matches the Sprint 2
data contract (§3.1): `500 L × 2 KES/L = 1000 expected`, `950 cash → variance −50`.

---

## 2. Business rules / formulas

```
Expected Revenue      = Meter Volume × Unit Price
Variance              = Reported Cash − Expected Revenue
Discrepancy Ratio (%) = (Variance ÷ Expected Revenue) × 100
```

- **Unit price** is a server-side business constant (`WATER_UNIT_PRICE_PER_LITER`,
  default **2 KES/L** per the §3.1 contract). A kiosk client can no longer send its
  own `expectedRevenue`/`variance` to hide a shortfall — those DTO fields are accepted
  for backward compatibility but ignored.
- Money is rounded to **2 decimals**; the discrepancy ratio is stored/served as a
  fraction (e.g. `-0.05`) and as a percentage (`-5`).
- A zero-revenue record has no meaningful ratio, so the ratio is `0` (no division by
  zero) while the raw `variance` still exposes the discrepancy.
- `isCashShortfall` (`variance < 0`) is derived for the manager UI; it is *not* the
  anomaly flag.

### Worked example (spec §3.1)

| Field | Value |
| :--- | ---: |
| meterVolume | 500.0 L |
| reportedCash | 950.0 KES |
| unitPrice | 2.0 KES/L |
| **expectedRevenue** | **1000.0** |
| **variance** | **−50.0** |
| **discrepancyRatio** | **−0.05** (−5 %) |

---

## 3. Moving-average volume anomaly detection

```
movingAvg = mean(previous N daily volumes of the same kiosk)
isAnomaly = |currentVolume − movingAvg| > 0.30 × movingAvg
```

- **Baseline window:** previous **7** records by default (the spec allows 7 or 30).
  Set `ANOMALY_BASELINE_WINDOW=30` to use a longer baseline; `window` can also be
  overridden per batch call (1–365).
- **Strict inequality:** a deviation of exactly **±30.0 %** is *not* an anomaly;
  **±30.1 %** is. This is the boundary the Earn test suite pins.
- **Direction/reason:** `SPIKE` (above), `DROP` (below), `NONE`, or the non-anomalous
  reasons `WITHIN_THRESHOLD`, `INSUFFICIENT_BASELINE`, `ZERO_BASELINE`.
- **The record is never part of its own baseline.** Baselines use records strictly
  earlier in `(kioskId, recordedAt, createdAt, id)` order, so same-timestamp rows are
  still handled deterministically.
- Baseline uses the **complete earlier history** even when the batch is limited to a
  date range, so a period-limited run still classifies correctly.

### Boundary behaviour (baseline average = 100 L)

| Volume | Deviation | Δ / avg | Flagged? | Direction |
| ---: | ---: | ---: | :---: | :--- |
| 129.9 | +29.9 | +29.9 % | ❌ | `NONE` |
| **130.0** | **+30.0** | **+30.0 %** | ❌ (strict `>`) | `NONE` |
| **130.1** | **+30.1** | **+30.1 %** | ✅ | `SPIKE` |
| 70.1 | −29.9 | 29.9 % | ❌ | `NONE` |
| **70.0** | **−30.0** | **30.0 %** | ❌ (strict `>`) | `NONE` |
| **69.9** | **−30.1** | **30.1 %** | ✅ | `DROP` |

### Edge cases

| Situation | Behaviour |
| :--- | :--- |
| Kiosk has no earlier records | `INSUFFICIENT_BASELINE`, **not** flagged (a new kiosk is never flagged on day 1) |
| Earlier records exist but average is 0 (dormant kiosk) | Literal rule `\|current − 0\| > 0`: `0` → not flagged, non-zero → `ZERO_BASELINE` anomaly; `deviationRatio` is `null` |
| Non-finite volumes in history (`NaN`, `±Infinity`) | Filtered out **before** averaging so they cannot skew the baseline or suppress a boundary anomaly |
| Fewer history records than the window | Uses all available samples (`sampleSize < window`) |

---

## 4. Daily batch reconciliation engine

`ReconciliationService.runBatch(options)` in
[`src/kiosk/reconciliation.service.ts`](../src/kiosk/reconciliation.service.ts):

1. Resolve `unitPrice` (call → env → default 2) and baseline `window` (call → env → 7).
2. Select **target** logs (`kioskId`, `startDate`/`endDate` or `date`) ordered
   `(kioskId, recordedAt, createdAt, id)` ascending.
3. Fetch the complete earlier history for the involved kiosks (up to `endDate`).
4. For every target log compute the reconciliation metrics and classify its volume
   against the previous `window` records of the same kiosk.
5. Compare with the stored `expectedRevenue` / `variance` / `isAnomaly` and persist
   **only changed rows** (transaction chunks of ≤ 100 updates).
6. Return a summary with counts, totals, per-record results and the anomaly list.

Properties:

- **Idempotent** — a second identical run reports `updatedCount: 0`.
- **Dry-run** — `dryRun: true` computes and reports everything but writes nothing
  (`updatedCount: 0`; `records[].changed` shows what *would* change).
- **Empty database** — `processedCount: 0`, zeroed totals, no exception.
- **Scheduled daily run** — set `RECONCILIATION_BATCH_ENABLED=true` to run the
  previous UTC day every day at **00:15 UTC** (in-process `setTimeout` chain, no extra
  dependency; disabled under `NODE_ENV=test`). The scheduler logs a summary line per run.
- **No double counting** — `isAnomaly` is classified with the moving average only;
  revenue variance is reported separately via `variance` / `hasVariance` /
  `isCashShortfall`, matching the Manager dashboard UI rule
  (*highlight `isAnomaly === true` OR `variance < 0`*).

---

## 5. API reference

### 5.1 Run the batch — `POST /api/kiosk/reconciliation/run`

All fields optional; an empty body reconciles the whole database.

```json
{
  "kioskId": "KIOSK-001",
  "startDate": "2026-10-01",
  "endDate": "2026-10-31",
  "window": 7,
  "unitPrice": 2,
  "dryRun": false
}
```

`date` is a shorthand for one whole UTC day and wins over `startDate`/`endDate`.
`startDate > endDate` → `400 { "message": "startDate must not be after endDate" }`;
`window` must be 1–365.

Response (`201 Created`, abbreviated):

```json
{
  "success": true,
  "processedAt": "2026-11-01T00:15:03.120Z",
  "dryRun": false,
  "unitPrice": 2,
  "baselineWindow": 7,
  "anomalyThreshold": 0.3,
  "filters": { "kioskId": "KIOSK-001", "startDate": null, "endDate": null },
  "processedCount": 8,
  "updatedCount": 8,
  "anomalyCount": 1,
  "varianceCount": 2,
  "shortfallCount": 1,
  "totals": {
    "meterVolume": 930.1,
    "reportedCash": 1860.2,
    "expectedRevenue": 1860.2,
    "variance": 0,
    "discrepancyRatio": 0,
    "discrepancyPercentage": 0
  },
  "records": [
    {
      "id": "uuid-9876",
      "transactionId": "TXN-20261031-001",
      "kioskId": "KIOSK-001",
      "recordedAt": "2026-10-31T10:00:00.000Z",
      "meterVolume": 130.1,
      "reportedCash": 260.2,
      "expectedRevenue": 260.2,
      "variance": 0,
      "discrepancyRatio": 0,
      "discrepancyPercentage": 0,
      "hasVariance": false,
      "isCashShortfall": false,
      "movingAverage": 100,
      "baselineSampleSize": 7,
      "baselineWindow": 7,
      "deviation": 30.1,
      "deviationRatio": 0.301,
      "threshold": 0.3,
      "isAnomaly": true,
      "anomalyDirection": "SPIKE",
      "anomalyReason": "SPIKE",
      "changed": true
    }
  ],
  "anomalies": [ ]
}
```

### 5.2 Query interpreted records — `GET /api/kiosk/reconciliation`

Optional query params: `kioskId`, `isAnomaly=true|false`, `startDate`, `endDate`
(a date-only `endDate` includes the whole UTC day). The existing
`{ count, records }` shape is preserved; response-level `unitPrice`/`anomalyThreshold`
and per-record `discrepancyRatio`, `discrepancyPercentage`, `hasVariance`,
`isCashShortfall` were added.

---

## 6. Configuration

| Env var | Default | Meaning |
| :--- | ---: | :--- |
| `WATER_UNIT_PRICE_PER_LITER` | `2` | KES per litre used for expected revenue |
| `ANOMALY_BASELINE_WINDOW` | `7` | Number of prior records in the moving average (7 or 30) |
| `RECONCILIATION_BATCH_ENABLED` | `false` | Run the batch daily at 00:15 UTC in-process |

---

## 7. Verification

Commands run from `AZERTY_namsa-ard_Server/`:

```bash
# unit + boundary + service suites
node --experimental-vm-modules ./node_modules/jest/bin/jest.js

# reconciliation API e2e (in-memory fake Prisma, no cloud DB writes)
node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  --config ./test/jest-e2e.json test/reconciliation.e2e-spec.ts

# quality gates
./node_modules/.bin/oxlint --type-aware src/ test/
./node_modules/.bin/nest build
```

| Suite | Result |
| :--- | :--- |
| Unit + boundary + service suites | **19 suites / 349 tests passed** (includes 52 independent boundary tests and 18 batch-service tests) |
| Reconciliation API e2e (`test/reconciliation.e2e-spec.ts`) | **16 / 16 tests passed** |
| Lint (`oxlint --type-aware`) | **0 warnings, 0 errors** (68 files) |
| TypeScript / Nest build | **clean** |
| Live-database smoke run (real Prisma + PostgreSQL, temporary kiosks, cleaned up) | **16 / 16 checks passed** — revenue formula persisted, ±30.0 % vs ±30.1 % spike/drop on real rows, insufficient baseline, stale-value correction, idempotency, dry-run, date-range target keeps the 7-record baseline |

Boundary tests pin the exact ±29.9 % / ±30.0 % / ±30.1 % behaviour, zero-baseline and
insufficient-baseline cases, revenue formulas, rounding and unit-price resolution. The
e2e suite exercises the batch endpoint and enriched `GET /reconciliation` through the
real Nest controller + validation pipeline against an in-memory Prisma fake.

---

## 8. Definition-of-Done mapping (Story ID 04)

- [x] Daily batch processing outputs expected revenue, reported cash, variance and
      discrepancy ratio for every submission.
- [x] Volume drops/spikes beyond ±30 % of the kiosk's moving average are automatically
      classified as anomalies and persisted in `DailyLog.isAnomaly`.
- [x] Query endpoint serves the interpreted records (with derived variance metrics and
      anomaly flags) for the Manager dashboard UI.
- [x] Unit, boundary and API-integration tests green; lint and build clean.
