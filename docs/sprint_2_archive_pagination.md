# Sprint 2 — Historical Archive Cursor Pagination (Story ID 08)

**Scope:** `Priority 3 — ID 08: Retrieve Data from Database` (20 points) — **Project-owned sub-task only**  
**Owner (spec):** Project  
**Backend:** NestJS + Prisma + PostgreSQL (Docker locally, Supabase in deployment)  
**Specification:** [`sprint_2_technical_requirements_implementation_specification.md`](../sprint_2_technical_requirements_implementation_specification.md) §Priority 3 (row 1) + §3.2

This document covers the part of Story ID 08 that the spec assigns to **Project**:

> "Add database composite indexes on timestamps and implement cursor-based pagination
> API for historical archives" — `@@index([kioskId, recordedAt(sort: Desc)])` in Prisma
> and `GET /api/kiosk/logs/archive?cursor=<id>&limit=20` using Prisma cursor pagination.

The other four ID 08 sub-tasks (Wuth's unseen-records tracking, Pun's client fetcher,
Sor's dashboard UI, Earn's 500-record load test) are **adjacent work and are not claimed
here** — see [§7](#7-scope-boundary--adjacent-work-not-in-this-slice).

---

## 1. Deliverables at a glance

| Story task (spec) | Implementation | Evidence |
| :--- | :--- | :--- |
| Composite timestamp index for archive pagination | `DailyLog` directive `@@index([kioskId, recordedAt(sort: Desc)])` in [`prisma/schema.prisma`](../prisma/schema.prisma) | A fresh `prisma db push` on an empty database created `daily_logs_kiosk_id_recorded_at_idx ON public.daily_logs USING btree (kiosk_id, recorded_at DESC)` |
| Cursor-based pagination API for historical archives | [`src/kiosk/archive-pagination.ts`](../src/kiosk/archive-pagination.ts) (pure paging helpers, `matchesArchiveFilter`), `LogInspectionService.listArchive` / `resolveArchiveCursor` in [`src/kiosk/log-inspection.service.ts`](../src/kiosk/log-inspection.service.ts), route in [`src/kiosk/log-inspection.controller.ts`](../src/kiosk/log-inspection.controller.ts) | Lead smoke run [`../../.work/lead/archive-pagination-smoke.mjs`](../../.work/lead/archive-pagination-smoke.mjs): **27 / 27 checks PASS** against the local `kiosk_verify` database (25 seeded logs, 3-page walk, limit=1 chain, default limit 20, unseenOnly, date range, 7 error cases, legacy `/kiosk` alias) |
| Query contract (shared with Story 06 date filter) | `ArchiveLogsQueryDto extends ListLogsQueryDto`, `ARCHIVE_ORDER_BY = [recordedAt desc, id desc]`, `{ data, nextCursor, hasMore, limit }` | Smoke checks cover the page 1 body, the 3-page walk, the limit=1 chain, default limit 20, unseenOnly, date range and the exact `startDate must not be after endDate` message from spec §3.2 |

Unit and API test specs for this slice (`src/kiosk/archive-pagination.spec.ts`,
`src/kiosk/log-inspection.archive.spec.ts`, `test/archive-pagination.e2e-spec.ts`) are owned
by the `api-tests` workstream and were present in the working tree when this document was
written; their declared inventory and execution status are recorded in
[§8](#8-verification).

> **Scope note:** this slice is backend-only. No client code, no dashboard UI, and no
> load-test harness are part of it.

---

## 2. Composite timestamp index

Declared on the `DailyLog` model:

```prisma
model DailyLog {
  // …
  kioskId    String   @map("kiosk_id")
  recordedAt DateTime @map("recorded_at")

  // Story 08: Composite Index For Pagination pull to old data and prevent to block Real-time.
  @@index([kioskId, recordedAt(sort: Desc)])
  @@index([isSynced, isReadByManager, recordedAt])
  @@map("daily_logs")
}
```

On a fresh, empty database a `prisma db push` materialised the named index:

```
daily_logs_kiosk_id_recorded_at_idx ON public.daily_logs USING btree (kiosk_id, recorded_at DESC)
```

(The other `@@index([isSynced, isReadByManager, recordedAt])` line predates this slice and
serves the sync/read filters; it is not the archive index.)

### Why `recorded_at DESC` matters

The archive read is `WHERE kiosk_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT $2 + 1`.
The index key order `(kiosk_id, recorded_at DESC)` mirrors that access pattern:

- `kiosk_id` is the equality prefix, so the scan is confined to one kiosk's rows.
- `recorded_at DESC` is the ordering key, so the index itself delivers the rows
  newest-first — the planner walks the index and stops after `limit + 1` entries.
  Without a matching ordered path, the same query would have to read **every** row of
  that kiosk and sort it before applying the limit, which is exactly the "stalling
  real-time listeners" behaviour the story calls out for large archives.
- An index whose second key is unordered relative to the read (or a naive
  `(kiosk_id, recorded_at)` used for a different sort) cannot serve the ordered prefix,
  so the scan degrades to a full-kiosk read + top-N sort as history grows.

`recorded_at` alone is not unique: several logs of the same kiosk can share a timestamp.
The deterministic tie-break is the unique `id` (see [§5](#5-why-the-total-order-is-recorded_at-desc-id-desc)),
which the ordered index resolves inside each equal-timestamp group.

**Planner caveat.** The planner only chooses the index when the table is large enough
for the scan to be cheaper than a sequential scan. On a 10-row table, the default
planner picks a Seq Scan (or a bitmap scan on the companion
`(is_synced, is_read_by_manager, recorded_at)` index) even though the archive index
exists. The `db-index` verification therefore pins `SET LOCAL enable_seqscan = off` to
prove the index is usable and plans against a real mid-history cursor row; on the
10 000-row local fixture the index is chosen with no planner overrides. The
`EXPLAIN` evidence is in [§8.2](#82-evidence-status).

---

## 3. Endpoint contract — `GET /api/kiosk/logs/archive`

Declared in [`src/kiosk/log-inspection.controller.ts`](../src/kiosk/log-inspection.controller.ts)
(`@Get('logs/archive')`). The controller is mounted at `['api/kiosk', 'kiosk', 'api', '']`,
so the legacy `/kiosk/logs/archive` alias works; the smoke run asserts it.

### 3.1 Query parameters

| Parameter | Type / format | Required | Default | Behaviour |
| :--- | :--- | :---: | :--- | :--- |
| `kioskId` | string (non-empty) | no | — | Scopes the page to one kiosk. When combined with `cursor`, the cursor row must belong to this kiosk, otherwise `400`. A whitespace-only value (`?kioskId=%20%20`) passes `@IsNotEmpty` and is trimmed to `''`, so it silently means "no kiosk filter" (low impact — same rows as omitting the parameter). |
| `cursor` | log `id` (uuid string) | no | — | The `nextCursor` returned by the previous page. Prisma runs `cursor: { id }` with a **conditional `skip`** (`1` when the resolved cursor row still matches the active filter, `0` otherwise), resuming strictly **after** that row. |
| `limit` | integer **1–100** | no | **20** (`DEFAULT_LOG_PAGE_SIZE`) | Page size. Values outside 1–100 are rejected with `400`. |
| `unseenOnly` | boolean (`true`/`false`/`1`/`0`) | no | `false` | `true` adds `where.isReadByManager = false`. Consumes the tracking column owned by Wuth's sub-task. |
| `startDate` | ISO-8601 date or date-time | no | — | Lower bound, inclusive: `recordedAt >= startDate`. |
| `endDate` | ISO-8601 date or date-time | no | — | Upper bound, inclusive: `recordedAt <= endDate`. A **date-only** value is widened to `23:59:59.999 UTC` of that day. |

`ArchiveLogsQueryDto extends ListLogsQueryDto` on purpose: both read-only history
endpoints share one validated query contract, while the archive route stays
independently evolvable.

### 3.2 `200 OK` response

```json
{
  "data": [
    {
      "id": "uuid-newest",
      "transactionId": "TXN-ARCH-…",
      "kioskId": "KIOSK-001",
      "operatorId": "OP-001",
      "meterVolume": 124,
      "reportedCash": 224,
      "expectedRevenue": 248,
      "variance": -24,
      "isAnomaly": true,
      "waterType": "COMMERCIAL",
      "isReadByManager": false,
      "recordedAt": "2026-10-31T12:00:00.000Z",
      "createdAt": "2026-10-31T12:00:01.120Z"
    }
  ],
  "nextCursor": "uuid-oldest-of-this-page",
  "hasMore": true,
  "limit": 20
}
```

| Field | Meaning |
| :--- | :--- |
| `data` | The page, ordered `recorded_at DESC, id DESC`. At most `limit` rows. Archived rows carry the Story 04 reconciliation fields (`expectedRevenue`, `variance`, `isAnomaly`) so a manager table needs no second request. |
| `nextCursor` | `id` of the last row in `data`; pass it back as `cursor`. **`null` on the last page.** |
| `hasMore` | `true` when at least one older record exists beyond `data`. Computed from a `limit + 1` probe row, so no separate `COUNT` query is issued. |
| `limit` | The effective page size (the default 20 is echoed when the client omitted `limit`). |

### 3.3 `400 Bad Request` cases

| Trigger | Exact message | Raised by |
| :--- | :--- | :--- |
| `startDate` after `endDate` | `startDate must not be after endDate` | `parseArchiveRange` (spec §3.2 wording) |
| Unparsable `startDate` | `startDate must be a valid ISO-8601 date string` | `parseArchiveRange` |
| Unparsable `endDate` | `endDate must be a valid ISO-8601 date string` | `parseArchiveRange` |
| `limit` not an integer | `limit must be an integer` | `ListLogsQueryDto` (`@IsInt`) |
| `limit` < 1 | `limit must be at least 1` | `ListLogsQueryDto` (`@Min(1)`) |
| `limit` > 100 | `limit must not exceed 100` | `ListLogsQueryDto` (`@Max(100)`) |
| `limit` invalid on a direct service call | `limit must be an integer between 1 and 100` | `normalizeArchiveLimit` (bypasses the HTTP pipe) |
| `unseenOnly` not a boolean | `unseenOnly must be a boolean` | `ListLogsQueryDto` (`@IsBoolean`) |
| `cursor` id does not exist | `cursor "<id>" was not found in the archive` | `resolveArchiveCursor` |
| `cursor` belongs to another kiosk | `cursor does not belong to kioskId "<kioskId>"` | `resolveArchiveCursor` |
| `cursor` row deleted between guard and read (Prisma `P2025`) | `cursor "<id>" is no longer available` | `listArchive` catch block — **defensive only**: Prisma 6.19 does not raise `P2025` for a missing `findMany` cursor; its keyset subqueries evaluate to `NULL` and the query returns an empty page, so a client gets a silent empty final page rather than a `400` |

The live smoke run asserts the exact spec message for the `startDate > endDate` case and
`400` for the other six error probes (`invalid startDate`, `limit=101`, `limit=0`,
`unknown cursor`, `foreign-kiosk cursor`, `unseenOnly=maybe`).

---

## 4. Pagination walk-through (two consecutive requests)

Seed used by the smoke script: kiosk `KIOSK-001` with **25** logs, newest first, one
minute apart starting at `2026-10-31T12:00:00.000Z` (i.e. `id₁` is the newest,
`id₂₅` the oldest), plus one log belonging to a different kiosk.

**Request 1 — first page (no cursor)**

```http
GET /api/kiosk/logs/archive?kioskId=KIOSK-001&limit=10
```

```json
{
  "data": [ /* id₁ … id₁₀, newest → oldest */ ],
  "nextCursor": "id₁₀",
  "hasMore": true,
  "limit": 10
}
```

**Request 2 — next page (cursor from request 1)**

```http
GET /api/kiosk/logs/archive?kioskId=KIOSK-001&limit=10&cursor=id₁₀
```

```json
{
  "data": [ /* id₁₁ … id₂₀ */ ],
  "nextCursor": "id₂₀",
  "hasMore": true,
  "limit": 10
}
```

**Then:** a third request with `cursor=id₂₀` returns `id₂₁ … id₂₅`, `hasMore: false` and
`nextCursor: null`. The smoke run walks exactly this chain — **3 pages for 25 rows** —
and asserts that the concatenation equals the seeded order with no duplicates and no
gaps; a second walk with `limit=1` returns all 25 rows in order across 25 single-row pages.
Because `hasMore` comes from the extra probe row, the client knows in advance whether to
keep the "load more" control enabled.

---

## 5. Why the total order is `recorded_at DESC, id DESC`

```ts
export const ARCHIVE_ORDER_BY: Prisma.DailyLogOrderByWithRelationInput[] = [
  { recordedAt: 'desc' },
  { id: 'desc' },   // unique tie-break
];
```

- `recorded_at` is **not unique** — two logs of one kiosk can share a timestamp and the
  database is free to return them in any order. Ordering by `recorded_at` alone is
  therefore not a *total* order.
- `id` is the primary key and therefore unique, so `(recorded_at DESC, id DESC)` gives
  **every row a deterministic position**. The cursor (`id` of the last row) can be
  resolved unambiguously, and the page query skips it (conditional `skip`, see the bug
  subsection below).
- This is what makes the paging safe: the exact same row can never appear twice and no
  row between two pages can be skipped, even when timestamps collide — the property the
  smoke walk assertions (`no duplicates across pages`, `complete set, exact total order`)
  pin down. The filtered-walk case is covered explicitly by the fix in §5.
- The user-visible order is unchanged for distinct timestamps, which is the normal case:
  `id DESC` only breaks ties.

### Bug found by verification and fixed (F1)

The independent verifier's round-1 probe found a real defect in the first version of
`listArchive`:

- **Defect.** Prisma compiled `cursor: { id }` with a hard `skip: 1` into a keyset predicate
  plus SQL `OFFSET 1`. When the active filter excluded the cursor row itself — the realistic
  case is a manager paging `unseenOnly=true` and marking the previous page's last row seen
  between requests — the `OFFSET` dropped the first *matching* row instead of the cursor row,
  and the response reported `hasMore: false` / `nextCursor: null`. The paging client silently
  lost one record and stopped.
- **Root cause.** The cursor row was resolved with `findUnique` and only its existence and
  kiosk ownership were checked; the `where` clause was not re-applied to the cursor row, so
  `skip: 1` was unconditional.
- **Red evidence (before the fix).** `node ../.work/verify/attack3b-minrepro.mjs` reproduced the
  loss on the delivered routes: step 3 returned `[m3, m4, m5]` where the expected page was
  `[m2, m3, m4, m5]`; the range variant lost the same first row. Full analysis in
  `.work/verify/verification-report.md` §3, with the captured SQL in
  `.work/verify/logs-attack3c.txt`.
- **Fix.** A new pure helper `matchesArchiveFilter(row, query)` in
  [`src/kiosk/archive-pagination.ts`](../src/kiosk/archive-pagination.ts) mirrors
  `buildArchiveWhere` for one row. `LogInspectionService.listArchive` now resolves the cursor
  row through `resolveArchiveCursor` (its `select` includes `kioskId` and `recordedAt`) and
  passes `skip: matchesArchiveFilter(cursorRow, query) ? 1 : 0` instead of a hard `skip: 1`.
  The unfiltered path keeps `skip: 1`.
- **Green evidence (after the fix).** The same minrepro now returns `[m2, m3, m4, m5]` and
  every variant stays correct. The verifier's round-2 verdict is **F1 RESOLVED, not merely
  narrowed** (`.work/verify/verification-report.md` §12): 25/25 fix-attack probes against an
  independent raw-SQL strict-keyset oracle; SQL-level proof that only filter-excluded cursors
  emit `OFFSET 0` while the unfiltered path stays byte-identical to pre-fix with `OFFSET 1`;
  16/17 mutations killed; an independent in-memory revert to hard `skip: 1` reproduced 3
  failures / 19 passed / 22 total, matching api-tests' own red log. Red→green artifacts:
  `.work/api-tests-f1/old-behaviour-red.log` and `.work/api-tests-f1/fixed-behaviour-green.log`.
  Post-fix counts: **68/68 unit tests** (2/2 suites), **22/22 e2e** (1/1 suite, 19 round-1 +
  3 F1 regressions), `bun run lint` 0 warnings / 0 errors, and the lead smoke **27/27 PASS**
  on both the local Postgres and the real external database.
- **Non-blocking residuals (documented, not claimed as resolved).** (R2-1) `GET /api/kiosk/logs`
  is a pre-existing Story-05 route outside this Project slice; it still uses a hard `skip: 1`
  and can still lose a row when its cursor row is marked read between pages. (R2-2) A residual
  one-round-trip TOCTOU remains in the conditional skip; the recommended future remediation is
  an explicit strict keyset from the resolved `(recordedAt, id)` with `skip: 0` always.
  (R2-3/R2-4) test-quality gaps were closed by the api-tests follow-up (faithful Prisma fake +
  whitespace-`kioskId` cursor test, mutation-checked).

---

## 6. Relationship to the existing `GET /api/kiosk/logs` route

Both routes live in the same controller, are `GET`-only, and share the inherited
`ListLogsQueryDto`, but they are separate contracts:

| | `GET /api/kiosk/logs` | `GET /api/kiosk/logs/archive` |
| :--- | :--- | :--- |
| Story | 05 / 08 dashboard list | 08 historical archive |
| Ordering | `recorded_at DESC, id DESC` | `recorded_at DESC, id DESC` |
| Response | `{ data, nextCursor, unseenCount? }` | `{ data, nextCursor, hasMore, limit }` |
| Row projection | Summary columns | Summary **plus** Story 04 reconciliation fields |
| Effective limit | `limit` (1–100, default 20) | same default, echoed as `limit` |

- The archive is its own literal path (`logs/archive`); it does not collide with
  `logs/:id/inspect`, which has a different segment count, nor with `logs`.
- `/logs` keeps `unseenCount` (the dashboard badge count) and is unchanged by this slice.
  The archive response advertises `hasMore` + `limit` instead, because the infinite-scroll
  caller needs to know whether another page exists before requesting it.
- The archive uses the shared pure helpers `normalizeArchiveLimit`, `parseArchiveRange`,
  `buildArchiveWhere` and `buildArchivePage`, so the range/limit/error semantics are
  identical to `/logs` and unit-testable without Prisma.

---

## 7. Scope boundary — adjacent work NOT in this slice

| Spec owner | ID 08 sub-task | Status here |
| :--- | :--- | :--- |
| **Project (this doc)** | Composite timestamp index + cursor-paginated `GET /api/kiosk/logs/archive` | **Delivered / documented here.** |
| Wuth | Unseen-records tracking per Operation Manager (`isReadByManager`, mark-seen) | **Adjacent — not claimed.** The archive route only *consumes* `isReadByManager` via `unseenOnly`; the tracking state and its mark-seen endpoint are Wuth's sub-task (pre-existing on `main`). |
| Pun | Non-blocking infinite-scroll / pagination client fetcher | **Adjacent — not claimed.** Client work; not in this backend slice. |
| Sor | Unread badge + historical log table on the Kiosk Dashboard | **Adjacent — not claimed.** UI work; not in this backend slice. |
| Earn | Load & concurrency test with 500+ records while real-time listeners run | **Adjacent — not claimed.** This slice's evidence is a 25-record functional smoke, not a 500-record load test. |

---

## 8. Verification

### 8.1 Reproduce the index and the endpoint locally

```bash
cd AZERTY_namsa-ard_Server

# 1. local PostgreSQL
docker compose up -d

# 2. apply the schema (creates daily_logs_kiosk_id_recorded_at_idx)
bunx prisma db push

# 3. compile and run the lead's live smoke (uses the connection URL already in your env)
bun run build
node ../.work/lead/archive-pagination-smoke.mjs

# 4. read-only index + query-plan check (SELECT / EXPLAIN only, never writes)
node scripts/verify-archive-index.mjs --label=local-kiosk_verify-10k-rows
# optional: a large local fixture, so the planner has real volume to choose the index
KIOSKS=20 LOGS_PER_KIOSK=500 node ../.work/db-index/seed-local.cjs
node scripts/verify-archive-index.mjs --label=local-kiosk_verify-pg16-10k-rows
```

The smoke script seeds a throwaway kiosk with 25 logs plus a foreign kiosk, boots the
compiled Nest app on `PORT` 3999, walks the archive, and deletes everything it created.
`scripts/verify-archive-index.mjs` (owned by the `db-index` workstream) re-checks the index
definition, compares it with the Prisma directive, and confirms the keyset query plans
onto the index; it only issues `SELECT`/`EXPLAIN`. It writes `prisma/sql/2026_id08_archive_indexes.sql`
as the idempotent DDL artifact, and `../.work/db-index/prove-idempotence.cjs` proves the
`CREATE INDEX IF NOT EXISTS` statements are a strict no-op on a second pass.

### 8.2 Evidence status

| Evidence | Status |
| :--- | :--- |
| Fresh-database index DDL: `daily_logs_kiosk_id_recorded_at_idx ON public.daily_logs USING btree (kiosk_id, recorded_at DESC)` | **Verified** (`prisma db push` on an empty database) |
| Live smoke, `.work/lead/archive-pagination-smoke.mjs` | **Verified: 27 / 27 checks PASS** against the local `kiosk_verify` database — 25 logs seeded, 3 pages walked, limit=1 chain, default limit 20, unseenOnly, date range, 7 error cases including the exact `startDate must not be after endDate` message, legacy `/kiosk` alias |
| `scripts/verify-archive-index.mjs` (`db-index` workstream) — index columns/order, schema-drift check, `EXPLAIN` plan onto the index | **Verified: 19/19 checks PASS** on both targets (exit 0): `PASS index daily_logs_kiosk_id_recorded_at_idx exists — CREATE INDEX daily_logs_kiosk_id_recorded_at_idx ON public.daily_logs USING btree (kiosk_id, recorded_at DESC)`; `PASS key columns are exactly [kiosk_id, recorded_at] in order — got ["kiosk_id","recorded_at"]`; `PASS recorded_at key column is DESC — indoption DESC bit=true`; `PASS kiosk_id key column is ASC (equality prefix, order irrelevant)`; `PASS DailyLog declares @@index([kioskId,recordedAt(sort:Desc)]) — declared`; `PASS archive query ... uses daily_logs_kiosk_id_recorded_at_idx @ median history row — index named in plan`; `PASS keyset cursor query ... uses daily_logs_kiosk_id_recorded_at_idx @ median history row — index named in plan`; same at the oldest history row; `RESULT: PASS — 19/19 checks passed`. Targets: local `kiosk_verify` (10 000 rows, 20 kiosks × 500) and the shared external DB (10 rows). Output: `.work/db-index/verification-output.txt` |
| Idempotent DDL artifact, `prisma/sql/2026_id08_archive_indexes.sql` + `../.work/db-index/prove-idempotence.cjs` | **Verified: `IDEMPOTENCE: PASS — CREATE INDEX IF NOT EXISTS was a strict no-op on both passes`** (local only) |
| Lead's index-usage probe, `.work/lead/external-db-index-evidence.txt` (800 seeded rows, separate tunnel host) | **Verified: 7 PASS lines** — `PASS composite index exists in the live database`, `PASS cursor probe row found`, `PASS first-page plan uses the composite index`, `PASS cursor-page plan uses the composite index`, `PASS first-page plan is not a Seq Scan over daily_logs`, `PASS first-page server-side execution under 200 ms — 0.501 ms`, `PASS cursor-page server-side execution under 200 ms — 0.41 ms`. This is a plan/latency probe, **not** a load or concurrency test |
| Verifier's round-1 probes, `.work/verify/` — route aliases, tie ordering, insert/delete between page fetches, filter/cursor interaction | **F1 found and fixed.** Round 1: when the cursor row was excluded by the current filter, a hard `skip: 1` lost the first row after the cursor (`expected [m2,m3,m4,m5]`, `observed [m3,m4,m5]`; `.work/verify/logs-attack3b.txt`, `.work/verify/logs-attack3c.txt`). Route aliases and tie walks were OK (4/4 alias routes, 1-row tie chains at `limit=1`) |
| Verifier's round-2 verdict, `.work/verify/verification-report.md` §12 | **F1 RESOLVED, not merely narrowed.** 25/25 fix-attack probes against an independent raw-SQL strict-keyset oracle; SQL-level proof that only filter-excluded cursors emit `OFFSET 0` while the unfiltered path stays byte-identical to pre-fix with `OFFSET 1`; 16/17 mutations killed; independent in-memory revert to hard `skip:1` reproduced 3 failures / 19 passed / 22 total. Red→green artifacts: `.work/api-tests-f1/old-behaviour-red.log`, `.work/api-tests-f1/fixed-behaviour-green.log` |
| Verifier's non-blocking residuals (R2-1, R2-2) | **Documented, not claimed as resolved.** R2-1: `GET /api/kiosk/logs` is a pre-existing Story-05 route outside this Project slice and still uses a hard `skip:1`; it can still lose a row when its cursor row is marked read between pages. R2-2: a residual one-round-trip TOCTOU remains in the conditional skip; recommended future remediation is an explicit strict keyset from the resolved `(recordedAt, id)` with `skip: 0` always |
| F2 — `P2025` cursor mapping | **Defensive only.** Prisma 6 returns an empty page for a cursor deleted after the guard; the `P2025` catch is insurance, not a reachable path |
| F3 — `?kioskId=%20%20` | **Trims to "no kiosk filter"** (low impact: no auth in this app, and the result is indistinguishable from an omitted `kioskId`) |
| `src/kiosk/archive-pagination.spec.ts` + `src/kiosk/log-inspection.archive.spec.ts` (`api-tests`) | **Verified: 68/68 unit tests pass** (2/2 suites) — `bun run test -- src/kiosk/archive-pagination.spec.ts src/kiosk/log-inspection.archive.spec.ts` |
| `test/archive-pagination.e2e-spec.ts` (`api-tests`) | **Verified: 22/22 e2e tests pass** (1/1 suite) — 19 round-1 cases + 3 F1 regressions |
| `bun run lint` | **Verified: 0 warnings, 0 errors** (78 files) |
| Full unit suite | **Verified: 494 passed** (438 pre-existing + the Project slice); one pre-existing unrelated failure remains in `src/kiosk/payload-edge-cases.spec.ts` ("strips unknown fields… isSynced", Story 14-2), unchanged from the pre-work baseline |

No load test, no client fetcher and no dashboard rendering were run for this slice.

---

## 9. Definition-of-Done mapping (Project slice of Story ID 08)

- [x] Prisma composite index `@@index([kioskId, recordedAt(sort: Desc)])` declared; a fresh
      `db push` materialises `daily_logs_kiosk_id_recorded_at_idx` with `recorded_at DESC`.
- [x] `GET /api/kiosk/logs/archive` (and the legacy `/kiosk/logs/archive` alias) returns
      newest-first pages of `{ data, nextCursor, hasMore, limit }`.
- [x] Cursor paging is deterministic for **unfiltered and filtered** walks: `recorded_at DESC,
      id DESC` total order; the multi-page and `limit=1` walks return every row exactly once, in
      order, with no gaps. A cursor whose own row no longer satisfies the active filter is
      handled explicitly (F1, fixed in §5).
- [x] `kioskId`, `unseenOnly`, `startDate`/`endDate` filters apply to the archive;
      `startDate > endDate` returns the exact §3.2 `400` message.
- [x] Live smoke evidence recorded (27/27 on both local and the real external DB) and the
      index DDL verified on a fresh database.
- [x] F1 regression covered by 3 e2e tests and 22/22 e2e; unit 68/68; lint 0/0.
- [ ] Load/concurrency evidence while real-time listeners are active — **Earn's adjacent
      sub-task, not part of this slice.**
